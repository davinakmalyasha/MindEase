package server

// Background jobs and the internal worker trigger. Ports:
//
//   - server/src/routes/internal.routes.ts — POST /api/internal/jobs/:name,
//     shared-secret auth (`X-Jobs-Secret`, constant-time compare, 404 when the
//     secret is unset), name validation and the awaited job call.
//   - server/src/jobs/registry.ts — job names and their cron cadences.
//   - server/src/jobs/scheduler.ts — the Asia/Jakarta schedule loop.
//   - server/src/jobs/checkins.ts — mood-logging nudge, mood-decline nudge,
//     post-session check-in and waitlist hygiene.
//   - server/src/jobs/reminders.ts — appointment reminders (24h window) and the
//     weekly wellness report (Monday WIB week boundary, per-patient claim).
//   - server/src/lib/cache.ts — the single-runner gate, Redis first and a
//     `JobLock` row (conditional INSERT / UPDATE on expiry) when Redis is
//     absent. The row is released by expiry, never deleted, like the Node one.
//
// Delivery is in-app only. The Node jobs emailed, sent WhatsApp and web push;
// this service has none of those clients, so every delivery below is a
// `Notification` row plus the realtime `notification:new` ping (through the
// shared `notifCreate` helper). A user who disabled the in-app channel for a
// category receives nothing where Node would still have emailed if that
// category's email channel was on.

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-sql-driver/mysql"
)

const (
	// jobsCandidateCap bounds the candidate reads per block per run, exactly
	// like CANDIDATE_CAP in checkins.ts: a platform-wide gap is worked through
	// over several days rather than in one unbounded fetch.
	jobsCandidateCap = 2000
	jobsDay          = 24 * time.Hour
	// jobsReminderWindowHours mirrors REMINDER_WINDOW_HOURS.
	jobsReminderWindowHours = 24
	jobsTrendThreshold      = 0.3
	jobsStreakCap           = 400
)

/* ------------------------------------------------------------------ *
 * Registry (jobs/registry.ts)
 * ------------------------------------------------------------------ */

var jobsNames = []string{"reminders", "checkins", "weekly-reports"}

// jobsSchedules keeps the cadences beside the names, like SCHEDULES. The
// `due` predicate is evaluated against `now` in Asia/Jakarta by StartJobs.
var jobsSchedules = []struct {
	name string
	cron string
	due  func(wib time.Time) bool
}{
	{"reminders", "*/10 * * * *", func(wib time.Time) bool { return wib.Minute()%10 == 0 }},
	{"checkins", "0 9 * * *", func(wib time.Time) bool { return wib.Hour() == 9 && wib.Minute() == 0 }},
	{"weekly-reports", "0 7 * * *", func(wib time.Time) bool { return wib.Hour() == 7 && wib.Minute() == 0 }},
}

func jobsIsName(name string) bool {
	for _, n := range jobsNames {
		if n == name {
			return true
		}
	}
	return false
}

func (s *Server) jobsRunByName(ctx context.Context, name string) error {
	switch name {
	case "reminders":
		return s.jobsRunReminders(ctx)
	case "checkins":
		return s.jobsRunCheckins(ctx)
	case "weekly-reports":
		return s.jobsRunWeeklyReports(ctx)
	}
	return nil
}

/* ------------------------------------------------------------------ *
 * Internal worker trigger (routes/internal.routes.ts)
 * ------------------------------------------------------------------ */

// registerInternal is the port of server/src/routes/internal.routes.ts. The
// path is exempt from CSRF and the general limiter in server.go, exactly like
// app.ts; it authenticates with a shared secret, not a session.
func (s *Server) registerInternal(api chi.Router) {
	api.Post("/internal/jobs/{name}", s.handleInternalJobTrigger)
}

// jobsSecretMatches: `timingSafeEqual` throws when the lengths differ, so the
// length check comes first - and comparing lengths is not the secret being
// compared. Hashes are not used, matching the Node comparison.
func jobsSecretMatches(given, secret string) bool {
	a := []byte(given)
	b := []byte(secret)
	if len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare(a, b) == 1
}

// jobsPublicError mirrors `publicMessageFor(error) ?? {"Job failed", 500}`:
// a typed AppError keeps its status and message, anything else is a generic
// 500. The Node plain-`Error` message classifier is not ported because the
// only errors these jobs propagate are infrastructure failures, which Node's
// own per-job catches swallow before the trigger ever sees them.
func jobsPublicError(err error) (int, string) {
	var appErr *AppError
	if errors.As(err, &appErr) {
		return appErr.Status, appErr.Message
	}
	return http.StatusInternalServerError, "Job failed"
}

func (s *Server) handleInternalJobTrigger(w http.ResponseWriter, r *http.Request) {
	secret := s.Cfg.JobsSecret
	if secret == "" {
		// Unconfigured means the endpoint does not exist. A trigger that runs
		// background work should be absent rather than open by default.
		s.Fail(w, http.StatusNotFound, "Not found")
		return
	}
	if !jobsSecretMatches(r.Header.Get("X-Jobs-Secret"), secret) {
		s.Fail(w, http.StatusUnauthorized, "Unauthorized")
		return
	}

	name := chi.URLParam(r, "name")
	if !jobsIsName(name) {
		s.Fail(w, http.StatusNotFound, "Unknown job")
		return
	}

	if err := s.jobsDispatch(r.Context(), name); err != nil {
		s.Log.Error("Job trigger failed", "job", name, "err", err)
		status, message := jobsPublicError(err)
		s.Fail(w, status, message)
		return
	}
	s.JSON(w, http.StatusOK, map[string]any{
		"status": "success",
		"data":   map[string]any{"job": name},
	})
}

/* ------------------------------------------------------------------ *
 * Scheduler (jobs/scheduler.ts)
 * ------------------------------------------------------------------ */

// StartJobs runs the scheduled jobs in-process, guarded by the JobLock claim
// so replicas never double-run. A ticker loop replaces node-cron; every tick
// is checked against the WIB wall clock of the same schedule table the trigger
// reads, so the two cannot disagree about when a job is due.
func (s *Server) StartJobs(ctx context.Context) {
	if s.Cfg.IsTest {
		// startJobs returns early under NODE_ENV=test.
		return
	}
	wib := jobsWIB()
	s.Log.Info("Background jobs scheduled (Asia/Jakarta)", "jobs", []string{
		"reminders */10 * * * *",
		"checkins 0 9 * * *",
		"weekly-reports 0 7 * * *",
	})

	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	lastFired := make(map[string]string, len(jobsSchedules))

	for {
		select {
		case <-ctx.Done():
			return
		case ticked := <-ticker.C:
			wibNow := ticked.In(wib)
			minuteKey := wibNow.Format("2006-01-02 15:04")
			for _, schedule := range jobsSchedules {
				name := schedule.name
				if !schedule.due(wibNow) || lastFired[name] == minuteKey {
					continue
				}
				lastFired[name] = minuteKey
				// Node fires `void run(name)`: a slow job must not hold the
				// schedule, and every job is idempotent by claim anyway.
				go func() {
					if err := s.jobsDispatch(ctx, name); err != nil {
						s.Log.Error("scheduled job failed", "job", name, "err", err)
					}
				}()
			}
		}
	}
}

/* ------------------------------------------------------------------ *
 * Single-runner gate (lib/cache.ts)
 * ------------------------------------------------------------------ */

type jobsLock struct {
	key       string
	redisHeld bool
}

func jobsIsDuplicateKey(err error) bool {
	var mysqlErr *mysql.MySQLError
	return errors.As(err, &mysqlErr) && mysqlErr.Number == 1062
}

// jobsAcquireLock: Redis first (`SET NX EX`), a `JobLock` row otherwise -
// the same fail-closed order as cache.ts. On the row path, acquisition is an
// INSERT or an UPDATE guarded by `expiresAt <= now`, both atomic in the
// database, so exactly one concurrent runner wins.
func (s *Server) jobsAcquireLock(ctx context.Context, key string, ttl time.Duration) (*jobsLock, bool) {
	if s.Redis != nil {
		ok, err := s.Redis.SetNX(ctx, "lock:"+key, "1", ttl).Result()
		if err != nil {
			// A Redis *error* fails closed: a missed report is far cheaper
			// than every replica running the blast.
			s.Log.Error("job lock: redis unavailable; skipping run", "key", key, "err", err)
			return nil, false
		}
		return &jobsLock{key: key, redisHeld: true}, ok
	}

	now := jobsNowMS()
	expiresAt := now.Add(ttl)
	_, err := s.DB.ExecContext(ctx,
		"INSERT INTO `JobLock` (`key`, expiresAt, createdAt) VALUES (?,?,?)",
		key, expiresAt, now)
	if err == nil {
		return &jobsLock{key: key}, true
	}
	if !jobsIsDuplicateKey(err) {
		s.Log.Error("Unable to determine lock ownership — skipping run", "err", err, "key", key)
		return nil, false
	}

	taken, err := s.DB.ExecContext(ctx,
		"UPDATE `JobLock` SET expiresAt = ? WHERE `key` = ? AND expiresAt <= ?",
		expiresAt, key, now)
	if err != nil {
		s.Log.Error("Unable to determine lock ownership — skipping run", "err", err, "key", key)
		return nil, false
	}
	affected, err := taken.RowsAffected()
	if err != nil {
		s.Log.Error("Unable to determine lock ownership — skipping run", "err", err, "key", key)
		return nil, false
	}
	return &jobsLock{key: key}, affected == 1
}

// jobsReleaseLock releases the Redis lease when one was taken. The `JobLock`
// row is deliberately *not* deleted - release is by expiry - so a crashed
// runner wedges the job for at most the TTL, like cache.ts documents.
func (s *Server) jobsReleaseLock(lock *jobsLock) {
	if lock == nil || !lock.redisHeld || s.Redis == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := s.Redis.Del(ctx, "lock:"+lock.key).Err(); err != nil {
		s.Log.Warn("job lock release failed", "key", lock.key, "err", err)
	}
}

// jobsLockKey maps a job to its Node lock key. Node's checkins job scans under
// `care-checkins`; reminders had no lock of its own (its deliveries were
// external), but the scheduler and the trigger guard every run here.
func jobsLockKey(name string) string {
	if name == "checkins" {
		return "care-checkins"
	}
	return name
}

// jobsLockTTL: 3600s for the two jobs Node locked for that long, and the
// cache.ts default of 600s for the 10-minute reminder cadence.
func jobsLockTTL(name string) time.Duration {
	switch name {
	case "checkins", "weekly-reports":
		return time.Hour
	default:
		return 10 * time.Minute
	}
}

// jobsDispatch is what each run goes through: claim the single-runner lock,
// then hand to the job. A locked-out run is a silent success, exactly like
// acquireLock returning false in Node - the claims inside the jobs are the
// correctness guarantee; this is the scan gate.
func (s *Server) jobsDispatch(ctx context.Context, name string) error {
	lock, ok := s.jobsAcquireLock(ctx, jobsLockKey(name), jobsLockTTL(name))
	if !ok {
		return nil
	}
	defer s.jobsReleaseLock(lock)
	if err := s.jobsRunByName(ctx, name); err != nil {
		s.observeJob(name, false)
		return err
	}
	s.observeJob(name, true)
	return nil
}

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

// jobsWIB is the product timezone. Node relied on the process TZ
// (Dockerfile: ENV TZ=Asia/Jakarta); the explicit zone keeps the job's week
// boundary and send hours in the calendar its recipients live in.
func jobsWIB() *time.Location {
	if loc, err := time.LoadLocation("Asia/Jakarta"); err == nil {
		return loc
	}
	// WIB is UTC+7 with no daylight saving, so the fixed offset is exact.
	return time.FixedZone("Asia/Jakarta", 7*3600)
}

// jobsNowMS is the timestamp claims write. MySQL DATETIME(3) rounds
// sub-millisecond precision on store, so a claim value compared back by
// equality must be exact milliseconds - JavaScript Dates were ms-precision.
func jobsNowMS() time.Time {
	return time.Now().UTC().Truncate(time.Millisecond)
}

// jobsStartOfWeekWIB is Monday 00:00 WIB, the report's week boundary.
func jobsStartOfWeekWIB(now time.Time) time.Time {
	loc := jobsWIB()
	wib := now.In(loc)
	sinceMonday := (int(wib.Weekday()) + 6) % 7
	return time.Date(wib.Year(), wib.Month(), wib.Day()-sinceMonday, 0, 0, 0, 0, loc).UTC()
}

// jobsSessionStart composes the session's start instant the way the Node
// server did: the calendar day of `appointmentDate` with the `startTime`
// hours, in the server's Asia/Jakarta zone.
func jobsSessionStart(appointmentDate time.Time, startTime *string, loc *time.Location) time.Time {
	h, m := apptHM(startTime)
	t := appointmentDate.In(loc)
	return time.Date(t.Year(), t.Month(), t.Day(), h, m, 0, 0, loc)
}

// jobsFormatDate is `toLocaleDateString("en-GB", { weekday: "short", day:
// "numeric", month: "short", year: "numeric" })`, e.g. "Mon, 5 Jan 2026".
func jobsFormatDate(t time.Time) string {
	return t.Format("Mon, 2 Jan 2006")
}

// jobsFormatNumber renders a JS number in a template literal shape.
func jobsFormatNumber(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64)
}

// jobsReleaseClaim hands a claim back after a failed delivery: best-effort,
// on a context detached from a request that may already be gone.
func (s *Server) jobsReleaseClaim(ctx context.Context, query string, args ...any) {
	releaseCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if _, err := s.DB.ExecContext(releaseCtx, query, args...); err != nil {
		s.Log.Error("job claim release failed", "err", err)
	}
}

/* ------------------------------------------------------------------ *
 * Reminders (jobs/reminders.ts)
 * ------------------------------------------------------------------ */

func (s *Server) jobsRunReminders(ctx context.Context) error {
	due, sent, err := s.jobsRemindersTick(ctx)
	if err != nil {
		s.Log.Error("Reminder job failed", "err", err)
		return err
	}
	s.Log.Info("Reminder job complete", "due", due, "remindersSent", sent)
	return nil
}

func (s *Server) jobsRemindersTick(ctx context.Context) (int, int, error) {
	now := jobsNowMS()
	wib := jobsWIB()
	wibNow := now.In(wib)
	// appointmentDate is the local midnight of the session day - using
	// startOfToday (instead of `now`) so same-day sessions are included;
	// sendReminder re-checks the exact 0-24h window per appointment.
	startOfToday := time.Date(wibNow.Year(), wibNow.Month(), wibNow.Day(), 0, 0, 0, 0, wib)
	horizon := now.Add(jobsReminderWindowHours * time.Hour)

	rows, err := s.DB.QueryContext(ctx,
		"SELECT id FROM `Appointment` WHERE status = 'confirmed' AND reminderSentAt IS NULL "+
			"AND appointmentDate >= ? AND appointmentDate <= ?",
		startOfToday, horizon)
	if err != nil {
		return 0, 0, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, 0, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, 0, err
	}
	rows.Close()

	sent := 0
	for _, id := range ids {
		delivered, err := s.jobsSendReminder(ctx, id, now, wib)
		if err != nil {
			return len(ids), sent, err
		}
		if delivered {
			sent++
		}
	}
	return len(ids), sent, nil
}

// jobsSendReminder claims one appointment and creates the in-app reminder for
// each participant. The Node version emailed/WhatsApp'd; phone numbers and
// emails are not fetched because there is no channel to use them on.
func (s *Server) jobsSendReminder(ctx context.Context, appointmentID string, now time.Time, wib *time.Location) (bool, error) {
	var (
		status           string
		appointmentDate  time.Time
		startTime        sql.NullString
		consultationType string
		patientID        string
		patientName      sql.NullString
		doctorUserID     string
		doctorName       sql.NullString
	)
	err := s.DB.QueryRowContext(ctx,
		"SELECT ap.status, ap.appointmentDate, ap.startTime, ap.consultationType, "+
			"u.id, u.name, d.userId, du.name "+
			"FROM `Appointment` ap "+
			"JOIN `User` u ON u.id = ap.userId "+
			"JOIN `Doctor` d ON d.id = ap.doctorId "+
			"JOIN `User` du ON du.id = d.userId "+
			"WHERE ap.id = ?", appointmentID).
		Scan(&status, &appointmentDate, &startTime, &consultationType,
			&patientID, &patientName, &doctorUserID, &doctorName)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if status != "confirmed" {
		return false, nil
	}

	// Eligibility is checked BEFORE the claim: a session whose calendar date
	// fell inside the horizon but whose actual start did not must not burn
	// `reminderSentAt`.
	var startTimePtr *string
	if startTime.Valid {
		startTimePtr = &startTime.String
	}
	start := jobsSessionStart(appointmentDate, startTimePtr, wib)
	hoursUntil := start.Sub(now).Hours()
	if hoursUntil <= 0 || hoursUntil > jobsReminderWindowHours {
		return false, nil
	}

	claim, err := s.DB.ExecContext(ctx,
		"UPDATE `Appointment` SET reminderSentAt = ?, updatedAt = ? WHERE id = ? AND reminderSentAt IS NULL",
		now, now, appointmentID)
	if err != nil {
		return false, err
	}
	affected, err := claim.RowsAffected()
	if err != nil {
		return false, err
	}
	if affected != 1 {
		// Another runner won the claim; one reminder, not two.
		return false, nil
	}

	timeLabel := ""
	if startTime.Valid {
		timeLabel = startTime.String
	}
	dateLabel := jobsFormatDate(start)
	patientLabel := "a patient"
	if patientName.Valid && patientName.String != "" {
		patientLabel = patientName.String
	}
	doctorLabel := "your doctor"
	if doctorName.Valid && doctorName.String != "" {
		doctorLabel = doctorName.String
	}

	_, patientErr := s.notifCreate(ctx, patientID, "Session reminder",
		fmt.Sprintf("Reminder: your %s session with %s is on %s at %s.",
			consultationType, doctorLabel, dateLabel, timeLabel),
		"appointment", false)
	_, doctorErr := s.notifCreate(ctx, doctorUserID, "Session reminder",
		fmt.Sprintf("Reminder: you have a %s session with %s on %s at %s.",
			consultationType, patientLabel, dateLabel, timeLabel),
		"appointment", false)

	// If EVERY delivery failed, hand the claim back so the next run retries
	// instead of silently consuming it.
	if patientErr != nil && doctorErr != nil {
		s.jobsReleaseClaim(ctx,
			"UPDATE `Appointment` SET reminderSentAt = NULL, updatedAt = ? WHERE id = ?",
			jobsNowMS(), appointmentID)
		return false, nil
	}
	if patientErr != nil {
		s.Log.Warn("reminder notification failed", "appointmentId", appointmentID, "userId", patientID, "err", patientErr)
	}
	if doctorErr != nil {
		s.Log.Warn("reminder notification failed", "appointmentId", appointmentID, "userId", doctorUserID, "err", doctorErr)
	}
	return true, nil
}

/* ------------------------------------------------------------------ *
 * Care check-ins (jobs/checkins.ts)
 * ------------------------------------------------------------------ */

type jobsCheckinSummary struct {
	moodNudges      int
	declineNudges   int
	sessionCheckins int
}

func (s *Server) jobsRunCheckins(ctx context.Context) error {
	summary, err := s.jobsCareCheckins(ctx)
	if err != nil {
		s.Log.Error("Care check-in job failed", "err", err)
		return err
	}
	// One line per run, with what actually went out. A silent zero is the
	// shape a broken job takes.
	s.Log.Info("Care check-ins complete",
		"moodNudges", summary.moodNudges,
		"declineNudges", summary.declineNudges,
		"sessionCheckins", summary.sessionCheckins)
	return nil
}

func (s *Server) jobsCareCheckins(ctx context.Context) (jobsCheckinSummary, error) {
	now := jobsNowMS()
	wib := jobsWIB()
	var summary jobsCheckinSummary

	if err := s.jobsMoodNudges(ctx, now, &summary); err != nil {
		return summary, err
	}
	if err := s.jobsDeclineNudges(ctx, now, &summary); err != nil {
		return summary, err
	}
	if err := s.jobsSessionCheckins(ctx, now, wib, &summary); err != nil {
		return summary, err
	}

	// Waitlist hygiene: re-queue stale notifications, expire old entries. A
	// failure here is logged, not fatal, like the inner try/catch in Node.
	requeued, expiredWaiting, err := s.jobsWaitlistMaintenance(ctx, now)
	if err != nil {
		s.Log.Error("Waitlist maintenance failed", "err", err)
	} else if requeued > 0 || expiredWaiting > 0 {
		s.Log.Info("Waitlist maintenance completed", "requeued", requeued, "expiredWaiting", expiredWaiting)
	}
	return summary, nil
}

// jobsMoodNudges: patients who used to log but haven't in 3 days, at most once
// per 3 days per user. The claim is written before the send and handed back if
// the send fails, so a failure is a delay rather than a disappearance.
func (s *Server) jobsMoodNudges(ctx context.Context, now time.Time, summary *jobsCheckinSummary) error {
	type jobsMoodCandidate struct {
		id   string
		last sql.NullTime
	}

	rows, err := s.DB.QueryContext(ctx,
		"SELECT id, lastMoodNudgeAt FROM `User` "+
			"WHERE role = 'patient' AND isBanned = false "+
			"AND (lastMoodNudgeAt IS NULL OR lastMoodNudgeAt < ?) "+
			"ORDER BY id ASC LIMIT ?",
		now.Add(-3*jobsDay), jobsCandidateCap)
	if err != nil {
		return err
	}
	candidates := make([]jobsMoodCandidate, 0)
	for rows.Next() {
		var c jobsMoodCandidate
		if err := rows.Scan(&c.id, &c.last); err != nil {
			rows.Close()
			return err
		}
		candidates = append(candidates, c)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	for _, c := range candidates {
		var lastCreated time.Time
		err := s.DB.QueryRowContext(ctx,
			"SELECT createdAt FROM `MoodEntry` WHERE userId = ? ORDER BY createdAt DESC LIMIT 1",
			c.id).Scan(&lastCreated)
		if err == sql.ErrNoRows {
			continue // never logged - no nudge
		}
		if err != nil {
			return err
		}
		if now.Sub(lastCreated) < 3*jobsDay {
			continue
		}

		claim, err := s.DB.ExecContext(ctx,
			"UPDATE `User` SET lastMoodNudgeAt = ?, updatedAt = ? WHERE id = ? AND lastMoodNudgeAt <=> ?",
			now, now, c.id, c.last)
		if err != nil {
			return err
		}
		affected, err := claim.RowsAffected()
		if err != nil {
			return err
		}
		if affected != 1 {
			continue
		}

		if _, err := s.notifCreate(ctx, c.id, "We miss your daily check-in",
			"You haven't logged your mood in a few days. A 10-second log helps you spot patterns — and it only takes a tap.",
			"system", false); err != nil {
			s.jobsReleaseClaim(ctx,
				"UPDATE `User` SET lastMoodNudgeAt = ?, updatedAt = ? WHERE id = ? AND lastMoodNudgeAt = ?",
				c.last, jobsNowMS(), c.id, now)
			s.Log.Error("Care check-in notification failed; claim released for retry", "err", err, "userId", c.id)
			continue
		}
		summary.moodNudges++
	}
	return nil
}

// jobsDeclineNudges: 3-day average <= 2.5 with a declining trend, at most once
// per week per user. Six entries, not three - the rule needs two windows to
// compare. The clinician escalation is raised after (and independently of) the
// patient nudge.
func (s *Server) jobsDeclineNudges(ctx context.Context, now time.Time, summary *jobsCheckinSummary) error {
	type jobsDeclineCandidate struct {
		id   string
		last sql.NullTime
	}

	rows, err := s.DB.QueryContext(ctx,
		"SELECT id, lastDeclineNudgeAt FROM `User` "+
			"WHERE role = 'patient' AND isBanned = false "+
			"AND (lastDeclineNudgeAt IS NULL OR lastDeclineNudgeAt < ?) "+
			"ORDER BY id ASC LIMIT ?",
		now.Add(-7*jobsDay), jobsCandidateCap)
	if err != nil {
		return err
	}
	candidates := make([]jobsDeclineCandidate, 0)
	for rows.Next() {
		var c jobsDeclineCandidate
		if err := rows.Scan(&c.id, &c.last); err != nil {
			rows.Close()
			return err
		}
		candidates = append(candidates, c)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	for _, c := range candidates {
		entries, err := s.DB.QueryContext(ctx,
			"SELECT id, mood FROM `MoodEntry` WHERE userId = ? ORDER BY createdAt DESC LIMIT 6",
			c.id)
		if err != nil {
			return err
		}
		var recent []struct {
			id   string
			mood int
		}
		for entries.Next() {
			var e struct {
				id   string
				mood int
			}
			if err := entries.Scan(&e.id, &e.mood); err != nil {
				entries.Close()
				return err
			}
			recent = append(recent, e)
		}
		if err := entries.Err(); err != nil {
			entries.Close()
			return err
		}
		entries.Close()
		if len(recent) < 6 {
			continue
		}

		jobsAvg := func(list []int) float64 {
			total := 0
			for _, m := range list {
				total += m
			}
			return float64(total) / float64(len(list))
		}
		lastMoods := []int{recent[0].mood, recent[1].mood, recent[2].mood}
		prevMoods := []int{recent[3].mood, recent[4].mood, recent[5].mood}
		lastAvg := jobsAvg(lastMoods)
		prevAvg := jobsAvg(prevMoods)
		if lastAvg > 2.5 || lastAvg >= prevAvg-jobsTrendThreshold {
			continue
		}

		claim, err := s.DB.ExecContext(ctx,
			"UPDATE `User` SET lastDeclineNudgeAt = ?, updatedAt = ? WHERE id = ? AND lastDeclineNudgeAt <=> ?",
			now, now, c.id, c.last)
		if err != nil {
			return err
		}
		affected, err := claim.RowsAffected()
		if err != nil {
			return err
		}
		if affected != 1 {
			continue
		}

		if _, err := s.notifCreate(ctx, c.id, "We noticed things feel heavier lately",
			"Your recent mood logs are lower than usual. It's okay to ask for support — booking a session with your psychologist can help. You're not alone.",
			"system", false); err != nil {
			s.jobsReleaseClaim(ctx,
				"UPDATE `User` SET lastDeclineNudgeAt = ?, updatedAt = ? WHERE id = ? AND lastDeclineNudgeAt = ?",
				c.last, jobsNowMS(), c.id, now)
			s.Log.Error("Care check-in notification failed; claim released for retry", "err", err, "userId", c.id)
		} else {
			summary.declineNudges++
		}

		// The clinician hears about it too. `sourceId` is the most recent log,
		// so a clinician reading the queue item can go straight to the
		// evidence. A failure here must not roll the patient nudge back.
		s.jobsMoodDeclineAlert(ctx, c.id, lastAvg, prevAvg, recent[0].id)
	}
	return nil
}

// jobsSessionCheckins: 24h after the session START, once per appointment -
// appointmentDate alone is midnight and would fire early.
func (s *Server) jobsSessionCheckins(ctx context.Context, now time.Time, wib *time.Location, summary *jobsCheckinSummary) error {
	type jobsCompletedAppointment struct {
		id              string
		userID          string
		appointmentDate time.Time
		startTime       sql.NullString
	}

	rows, err := s.DB.QueryContext(ctx,
		"SELECT id, userId, appointmentDate, startTime FROM `Appointment` "+
			"WHERE status = 'completed' AND checkinSentAt IS NULL "+
			"AND appointmentDate <= ? ORDER BY id ASC LIMIT ?",
		now.Add(-jobsDay), jobsCandidateCap)
	if err != nil {
		return err
	}
	completed := make([]jobsCompletedAppointment, 0)
	for rows.Next() {
		var app jobsCompletedAppointment
		if err := rows.Scan(&app.id, &app.userID, &app.appointmentDate, &app.startTime); err != nil {
			rows.Close()
			return err
		}
		completed = append(completed, app)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	for _, app := range completed {
		var startTimePtr *string
		if app.startTime.Valid {
			startTimePtr = &app.startTime.String
		}
		startedAt := jobsSessionStart(app.appointmentDate, startTimePtr, wib)
		if now.Sub(startedAt) < jobsDay {
			continue
		}

		claim, err := s.DB.ExecContext(ctx,
			"UPDATE `Appointment` SET checkinSentAt = ?, updatedAt = ? WHERE id = ? AND checkinSentAt IS NULL",
			now, now, app.id)
		if err != nil {
			return err
		}
		affected, err := claim.RowsAffected()
		if err != nil {
			return err
		}
		if affected != 1 {
			continue
		}

		if _, err := s.notifCreate(ctx, app.userID, "How did your session go?",
			"We'd love your feedback. Leaving a review helps your psychologist grow and helps others choose with confidence.",
			"appointment", false); err != nil {
			s.jobsReleaseClaim(ctx,
				"UPDATE `Appointment` SET checkinSentAt = NULL, updatedAt = ? WHERE id = ? AND checkinSentAt = ?",
				jobsNowMS(), app.id, now)
			s.Log.Error("Care check-in notification failed; claim released for retry", "err", err, "userId", app.userID)
			continue
		}
		summary.sessionCheckins++
	}
	return nil
}

// jobsWaitlistMaintenance ports WaitlistService.runWaitlistMaintenance: a
// notified patient who never booked is re-queued after 48h (older rows fall
// back to createdAt), and waiting entries older than 90 days are dropped.
func (s *Server) jobsWaitlistMaintenance(ctx context.Context, now time.Time) (int, int, error) {
	staleNotifiedAt := now.Add(-48 * time.Hour)
	waitingStaleBefore := now.Add(-90 * jobsDay)

	requeuedResult, err := s.DB.ExecContext(ctx,
		"UPDATE `WaitlistEntry` SET status = 'waiting', notifiedAt = NULL "+
			"WHERE status = 'notified' AND (notifiedAt < ? OR (notifiedAt IS NULL AND createdAt < ?))",
		staleNotifiedAt, staleNotifiedAt)
	if err != nil {
		return 0, 0, err
	}
	requeued, err := requeuedResult.RowsAffected()
	if err != nil {
		return 0, 0, err
	}

	removedResult, err := s.DB.ExecContext(ctx,
		"DELETE FROM `WaitlistEntry` WHERE status = 'waiting' AND createdAt < ?",
		waitingStaleBefore)
	if err != nil {
		return 0, 0, err
	}
	expiredWaiting, err := removedResult.RowsAffected()
	if err != nil {
		return 0, 0, err
	}
	return int(requeued), int(expiredWaiting), nil
}

// jobsMoodDeclineAlert is raiseRiskAlert for the `mood` source, in-app only.
// The shared clinicalRaiseRiskAlert would also attempt an email through its
// notification helper, so this ports the same escalation - a durable
// RiskAlert, the clinician page, the realtime ping, the admin fallback, the
// audit entry and the notifiedDoctorUserId stamp - with no outbound channel.
func (s *Server) jobsMoodDeclineAlert(ctx context.Context, userID string, lastAvg, prevAvg float64, sourceID string) {
	now := jobsNowMS()
	reason := fmt.Sprintf(
		"Mood logs have declined: the last three entries average %s/5 against %s/5 for the three before them.",
		aiToFixed1(lastAvg), aiToFixed1(prevAvg))

	var doctorUserID string
	appointmentErr := s.DB.QueryRowContext(ctx,
		"SELECT d.userId FROM `Appointment` ap "+
			"JOIN `Doctor` d ON d.id = ap.doctorId "+
			"WHERE ap.userId = ? AND ap.status IN ('confirmed','completed') "+
			"ORDER BY ap.appointmentDate DESC LIMIT 1",
		userID).Scan(&doctorUserID)
	hasAppointment := appointmentErr == nil
	if appointmentErr != nil && appointmentErr != sql.ErrNoRows {
		s.Log.Error("mood-decline alert appointment lookup failed", "err", appointmentErr, "userId", userID)
	}

	var assignedDoctorUserID any
	if hasAppointment {
		assignedDoctorUserID = doctorUserID
	}

	alertID := newID()
	if _, err := s.DB.ExecContext(ctx,
		"INSERT INTO `RiskAlert` (id, userId, level, reason, sourceType, sourceId, assignedDoctorUserId, createdAt) VALUES (?,?,?,?,?,?,?,?)",
		alertID, userID, "elevated", reason, "mood", sourceID, assignedDoctorUserID, now); err != nil {
		s.Log.Error("Mood-decline risk alert could not be raised", "err", err, "userId", userID)
		alertID = ""
	}

	var alertIDValue *string
	if alertID != "" {
		alertIDValue = &alertID
	}

	if !hasAppointment {
		adminsNotified := s.notifyRiskAdmins(ctx, userID, "A patient", "elevated", false)
		s.audit(ctx, "risk.raised", &userID, ptr("RiskAlert"), alertIDValue, map[string]any{
			"level": "elevated", "sourceType": "mood", "clinicianNotified": false,
			"adminsNotified": adminsNotified, "recorded": alertID != "",
		})
		s.Log.Warn("risk disclosure with no assigned clinician", "userId", userID, "level", "elevated")
		return
	}

	const patientName = "A patient"
	const level = "elevated"
	clinicianMessage := fmt.Sprintf(
		"%s's recent mood logs have declined (last three average %s/5 against %s/5 for the three before them). Please reach out to them today.",
		patientName, aiToFixed1(lastAvg), aiToFixed1(prevAvg))

	clinicianReached := false
	if delivered, err := s.notifCreate(ctx, doctorUserID, "Risk disclosure from a patient", clinicianMessage, "system", false); err != nil {
		s.Log.Error("risk escalation in-app channel failed", "err", err, "userId", userID)
	} else {
		clinicianReached = delivered
	}

	s.wellnessPublishEvent(ctx, doctorUserID, "risk:alert", map[string]any{
		"patientName": patientName,
		"level":       level,
		"alertId":     alertIDValue,
	})

	adminsNotified := s.notifyRiskAdmins(ctx, userID, patientName, level, true)

	s.audit(ctx, "risk.raised", &userID, ptr("RiskAlert"), alertIDValue, map[string]any{
		"level": level, "sourceType": "mood", "doctorUserId": doctorUserID,
		"adminsNotified": adminsNotified,
	})

	if clinicianReached && alertID != "" {
		if _, err := s.DB.ExecContext(ctx,
			"UPDATE `RiskAlert` SET notifiedDoctorUserId = ? WHERE id = ?", doctorUserID, alertID); err != nil {
			s.Log.Warn("failed to stamp notifiedDoctorUserId", "err", err)
		}
	}
}

/* ------------------------------------------------------------------ *
 * Weekly reports (jobs/reminders.ts, runWeeklyReports)
 * ------------------------------------------------------------------ */

// jobsRunWeeklyReports runs daily, not on Mondays, and each patient is claimed
// for the week before their report is built: `lastWeeklyReportAt` is both the
// claim and the catch-up record, so a missed Monday fires the next morning and
// a crashed run resumes with the remainder instead of re-mailing everyone.
func (s *Server) jobsRunWeeklyReports(ctx context.Context) error {
	sent, failed, weekStart, err := s.jobsWeeklyReportsTick(ctx)
	if err != nil {
		s.Log.Error("Weekly report job failed", "err", err)
		return err
	}
	if sent > 0 || failed > 0 {
		s.Log.Info("Weekly reports run complete",
			"sent", sent, "failed", failed,
			"weekStart", weekStart.UTC().Format("2006-01-02T15:04:05.000Z"))
	}
	return nil
}

func (s *Server) jobsWeeklyReportsTick(ctx context.Context) (int, int, time.Time, error) {
	weekStart := jobsStartOfWeekWIB(time.Now())

	type jobsReportUser struct {
		id   string
		name sql.NullString
		last sql.NullTime
	}

	rows, err := s.DB.QueryContext(ctx,
		"SELECT id, name, lastWeeklyReportAt FROM `User` "+
			"WHERE weeklyReportEnabled = true AND role = 'patient' AND isBanned = false "+
			"AND (lastWeeklyReportAt IS NULL OR lastWeeklyReportAt < ?) "+
			"ORDER BY id ASC",
		weekStart)
	if err != nil {
		return 0, 0, weekStart, err
	}
	users := make([]jobsReportUser, 0)
	for rows.Next() {
		var u jobsReportUser
		if err := rows.Scan(&u.id, &u.name, &u.last); err != nil {
			rows.Close()
			return 0, 0, weekStart, err
		}
		users = append(users, u)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, 0, weekStart, err
	}
	rows.Close()

	sent := 0
	failed := 0
	for _, u := range users {
		claimedAt := jobsNowMS()
		claim, err := s.DB.ExecContext(ctx,
			"UPDATE `User` SET lastWeeklyReportAt = ?, updatedAt = ? WHERE id = ? AND lastWeeklyReportAt <=> ?",
			claimedAt, claimedAt, u.id, u.last)
		if err != nil {
			return sent, failed, weekStart, err
		}
		affected, err := claim.RowsAffected()
		if err != nil {
			return sent, failed, weekStart, err
		}
		if affected != 1 {
			continue
		}

		if err := s.jobsSendWeeklyReport(ctx, u.id, u.name.String); err != nil {
			failed++
			// Hand the week back so the loss is a delay rather than a
			// disappearance.
			s.jobsReleaseClaim(ctx,
				"UPDATE `User` SET lastWeeklyReportAt = ?, updatedAt = ? WHERE id = ? AND lastWeeklyReportAt = ?",
				u.last, jobsNowMS(), u.id, claimedAt)
			s.Log.Error("Weekly report failed; claim released for retry", "err", err, "userId", u.id)
			continue
		}
		sent++
	}
	return sent, failed, weekStart, nil
}

// jobsSendWeeklyReport builds the week's summary and delivers it in-app. The
// Node report was an email with the 30-day average, streak, trend and journal
// count plus an AI reflection; there is no mailer or model call here, so the
// same numbers become the notification body.
func (s *Server) jobsSendWeeklyReport(ctx context.Context, userID, name string) error {
	average, streak, trend, journalCount, err := s.jobsWeeklyStats(ctx, userID)
	if err != nil {
		return err
	}
	if name == "" {
		name = "there"
	}
	message := fmt.Sprintf(
		"Hi %s, here's your wellness summary for this week — 30-day average mood: %s/5 · Log streak: %d days · Trend: %s · Journal entries this week: %d. Keep logging your mood daily — small steps make a difference.",
		name, jobsFormatNumber(average), streak, trend, journalCount)
	_, err = s.notifCreate(ctx, userID, "Your MindEase weekly wellness report", message, "system", false)
	return err
}

// jobsWeeklyStats ports the read side of WellnessService.getMoodStats (and the
// latest-7 count from getJournalEntries) for the report body.
func (s *Server) jobsWeeklyStats(ctx context.Context, userID string) (float64, int, string, int, error) {
	tz := s.wellnessUserTimezone(ctx, userID)
	today := wellnessTodayKey(tz)
	from := wellnessStartOfZonedDay(wellnessShiftDayKey(today, -(30-1), tz), tz)

	rows, err := s.DB.QueryContext(ctx,
		"SELECT mood, createdAt FROM `MoodEntry` WHERE userId = ? AND createdAt >= ? ORDER BY createdAt ASC",
		userID, from)
	if err != nil {
		return 0, 0, "", 0, err
	}
	type jobsMoodRow struct {
		mood      int
		createdAt time.Time
	}
	entries := make([]jobsMoodRow, 0)
	for rows.Next() {
		var e jobsMoodRow
		if err := rows.Scan(&e.mood, &e.createdAt); err != nil {
			rows.Close()
			return 0, 0, "", 0, err
		}
		entries = append(entries, e)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, 0, "", 0, err
	}
	rows.Close()

	var journalCount int
	if err := s.DB.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM (SELECT id FROM `JournalEntry` WHERE userId = ? ORDER BY createdAt DESC LIMIT 7) AS recent",
		userID).Scan(&journalCount); err != nil {
		return 0, 0, "", 0, err
	}

	if len(entries) == 0 {
		return 0, 0, "stable", journalCount, nil
	}

	total := 0
	for _, e := range entries {
		total += e.mood
	}
	average := math.Round(float64(total)/float64(len(entries))*10) / 10

	// Streak of consecutive logged days in the user's own zone; today is given
	// a grace period via yesterday.
	loggedDays := make(map[string]bool, len(entries))
	for _, e := range entries {
		loggedDays[wellnessDayKey(e.createdAt, tz)] = true
	}
	streak := 0
	cursor := wellnessShiftDayKey(today, -1, tz)
	if loggedDays[today] {
		cursor = today
	}
	for loggedDays[cursor] && streak < jobsStreakCap {
		streak++
		cursor = wellnessShiftDayKey(cursor, -1, tz)
	}

	trend := "stable"
	if len(entries) >= 4 {
		mid := len(entries) / 2
		olderSum := 0
		for _, e := range entries[:mid] {
			olderSum += e.mood
		}
		recentSum := 0
		for _, e := range entries[mid:] {
			recentSum += e.mood
		}
		olderAvg := float64(olderSum) / float64(len(entries[:mid]))
		recentAvg := float64(recentSum) / float64(len(entries[mid:]))
		if recentAvg > olderAvg+jobsTrendThreshold {
			trend = "improving"
		} else if recentAvg < olderAvg-jobsTrendThreshold {
			trend = "declining"
		}
	}
	return average, streak, trend, journalCount, nil
}
