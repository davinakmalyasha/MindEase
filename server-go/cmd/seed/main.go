// Command seed creates the demo data the README documents and the Playwright
// journeys use. Ported from server/scripts/seed.ts: the same accounts, slot
// window, mood history and risk alerts.
package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"time"

	"golang.org/x/crypto/argon2"
	"uuid"

	"github.com/davinakmalyasha/MindEase/server-go/internal/db"
)

var specialties = []string{
	"Clinical Psychologist", "Family Counselor", "Trauma Therapist", "Addiction Specialist",
	"Child Psychologist", "Couples Counselor", "Anxiety Specialist", "Depression Specialist",
}

var bios = []string{
	"Compassionate, evidence-based therapy tailored to your unique journey toward healing and growth.",
	"I help individuals navigate life transitions, anxiety, and relationships with warmth and practical tools.",
	"Trauma-informed care in a safe, judgment-free space. EMDR and CBT certified.",
	"Supporting recovery with empathy and structure. Harm-reduction and CBT approaches.",
	"Play-based and talk therapy for children and teens, plus parent guidance sessions.",
	"Helping couples rebuild trust, communicate better, and reconnect emotionally.",
	"Specializing in anxiety disorders using exposure therapy and mindfulness techniques.",
	"Depression-focused care combining cognitive restructuring with lifestyle medicine.",
}

var firstNames = []string{"Sarah", "James", "Aisha", "Michael", "Emily", "David", "Laura", "Andi", "Budi", "Siti", "Rina", "Dewa"}
var lastNames = []string{"Mitchell", "Carter", "Rahman", "Santoso", "Walker", "Wijaya", "Permata", "Hidayat", "Putri", "Nugroho", "Sari", "Kusuma"}

var moodNotes = []string{"Feeling productive today.", "A bit anxious about work.", "Enjoyed time with family.", ""}
var moodFactors = []string{"sleep", "exercise", "social", "work", "stress"}

// seedLocation is explicit rather than time.Local: the seed's calendar days
// must line up with the API's booking window whatever TZ the host runs with.
var seedLocation = loadLocation("Asia/Jakarta")

func main() {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		fmt.Fprintln(os.Stderr, "DATABASE_URL is required")
		os.Exit(1)
	}
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	ctx := context.Background()

	pool, err := db.Open(databaseURL)
	if err != nil {
		fatal(logger, "open database", err)
	}
	defer pool.Close()
	if err := pool.PingContext(ctx); err != nil {
		fatal(logger, "database unreachable", err)
	}

	// Admin and patient are upserts: an existing account is left untouched,
	// matching the `update: {}` in the Node seed.
	adminID, _, err := upsertUser(ctx, pool, "admin@mindease.app", "Admin@123", "System Admin", "admin", nil, nil)
	if err != nil {
		fatal(logger, "seed admin", err)
	}
	logger.Info("admin ready", "email", "admin@mindease.app", "id", adminID)

	patientID, _, err := upsertUser(ctx, pool, "patient@mindease.app", "Patient@123", "Demo Patient", "patient", strPtr("+6281234567890"), nil)
	if err != nil {
		fatal(logger, "seed patient", err)
	}
	logger.Info("patient ready", "email", "patient@mindease.app", "id", patientID)

	for i := 0; i < 8; i++ {
		email := fmt.Sprintf("dr%d@mindease.app", i+1)
		name := fmt.Sprintf("Dr. %s %s", firstNames[i], lastNames[i])
		phone := fmt.Sprintf("+62811%d", int64(10000000)+int64(i)*1111111)
		avatar := "https://api.dicebear.com/9.x/avataaars/svg?seed=" + firstNames[i]

		userID, created, err := upsertUser(ctx, pool, email, "Doctor@123", name, "doctor", &phone, &avatar)
		if err != nil {
			fatal(logger, "seed doctor user", err)
		}
		if !created {
			continue
		}

		doctorID := newID()
		availability := "Available"
		if i%3 == 0 {
			availability = "Busy"
		}
		now := time.Now().UTC()
		// `rating` and `totalReviews` stay at their defaults deliberately: demo
		// data must not invent a rating for a clinician who has no reviews.
		if _, err := pool.ExecContext(ctx,
			"INSERT INTO `Doctor` (id, userId, specialty, bio, experience, price, availability, verificationStatus, "+
				"licenseNumber, licenseIssuer, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
			doctorID, userID, specialties[i], bios[i], 3+(i%12), 150000+i*75000,
			availability, "approved", fmt.Sprintf("STR-DEMO-%d", 100000+i), "Demo Psychology Board", now, now,
		); err != nil {
			fatal(logger, "seed doctor profile", err)
		}

		// Open slots for the next seven days: three consecutive hours starting
		// at 08:00 + (i mod 6), the window the booking journey selects from.
		startHour := 8 + (i % 6)
		today := time.Now().In(seedLocation)
		for day := 1; day <= 7; day++ {
			date := time.Date(today.Year(), today.Month(), today.Day()+day, 0, 0, 0, 0, seedLocation)
			for hour := startHour; hour < startHour+3; hour++ {
				if _, err := pool.ExecContext(ctx,
					"INSERT INTO `ConsultationSlot` (id, doctorId, date, startTime, endTime, isBooked) VALUES (?,?,?,?,?,?)",
					newID(), doctorID, date, fmt.Sprintf("%02d:00", hour), fmt.Sprintf("%02d:00", hour+1), false,
				); err != nil {
					fatal(logger, "seed slot", err)
				}
			}
		}
		logger.Info("doctor ready", "name", name, "specialty", specialties[i])
	}

	if err := seedMoods(ctx, pool, logger, patientID); err != nil {
		fatal(logger, "seed mood history", err)
	}
	if err := seedRiskAlerts(ctx, pool, logger, patientID); err != nil {
		fatal(logger, "seed risk alerts", err)
	}

	fmt.Println("\nSeed complete.")
	fmt.Println("Accounts:")
	fmt.Println("  admin@mindease.app / Admin@123")
	fmt.Println("  patient@mindease.app / Patient@123")
	fmt.Println("  dr1@mindease.app ... dr8@mindease.app / Doctor@123")
}

func seedMoods(ctx context.Context, pool *sql.DB, logger *slog.Logger, patientID string) error {
	var count int
	if err := pool.QueryRowContext(ctx, "SELECT COUNT(*) FROM `MoodEntry` WHERE userId = ?", patientID).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return nil
	}

	loc := seedLocation
	var timezone sql.NullString
	if err := pool.QueryRowContext(ctx, "SELECT timezone FROM `User` WHERE id = ?", patientID).Scan(&timezone); err == nil {
		if timezone.Valid && timezone.String != "" {
			loc = loadLocation(timezone.String)
		}
	}

	for i := 13; i >= 0; i-- {
		now := time.Now().In(loc)
		date := time.Date(now.Year(), now.Month(), now.Day()-i, 18+(i%3), 0, 0, 0, loc)
		factors, _ := json.Marshal([]string{moodFactors[i%len(moodFactors)]})
		if _, err := pool.ExecContext(ctx,
			"INSERT INTO `MoodEntry` (id, userId, mood, notes, moodDate, factors, createdAt) VALUES (?,?,?,?,?,?,?)",
			newID(), patientID, 2+((i*7)%4), moodNotes[i%len(moodNotes)],
			date.Format("2006-01-02"), string(factors), date,
		); err != nil {
			return err
		}
	}
	logger.Info("seeded 14 days of mood history", "email", "patient@mindease.app")
	return nil
}

func seedRiskAlerts(ctx context.Context, pool *sql.DB, logger *slog.Logger, patientID string) error {
	var count int
	if err := pool.QueryRowContext(ctx, "SELECT COUNT(*) FROM `RiskAlert`").Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	var doctorUserID string
	err := pool.QueryRowContext(ctx, "SELECT id FROM `User` WHERE email = ?", "dr1@mindease.app").Scan(&doctorUserID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}

	daysAgo := func(n int) time.Time { return time.Now().UTC().Add(-time.Duration(n) * 24 * time.Hour) }
	type alert struct {
		level          string
		reason         string
		sourceType     string
		acknowledgedAt *time.Time
		resolvedAt     *time.Time
		note           *string
		createdAt      time.Time
	}
	ackThree := daysAgo(3)
	ackSix := daysAgo(6)
	resFive := daysAgo(5)
	note := "Called and spoke with them for 25 minutes. Agreed a safety plan and a check-in on Thursday. Crisis line numbers given as well."
	alerts := []alert{
		{
			level: "urgent", sourceType: "sos", createdAt: daysAgo(0),
			reason: "Patient pressed the SOS button and wrote: I don't want to be here anymore. No clinician had responded at the time it was sent.",
		},
		{
			level: "elevated", sourceType: "phq9", createdAt: daysAgo(4), acknowledgedAt: &ackThree,
			reason: "Answered yes to PHQ-9 item 9 (thoughts of being better off dead or of hurting themselves) on the intake screening.",
		},
		{
			level: "elevated", sourceType: "message", createdAt: daysAgo(1),
			reason: "Message contained crisis phrasing: \"I have been thinking about disappearing and nobody would notice.\"",
		},
		{
			level: "urgent", sourceType: "mood", createdAt: daysAgo(7),
			acknowledgedAt: &ackSix, resolvedAt: &resFive, note: &note,
			reason: "Six consecutive days of low mood entries triggered the decline rule.",
		},
	}
	for _, a := range alerts {
		var acknowledgedBy, resolvedBy, resolutionNote any
		if a.acknowledgedAt != nil {
			acknowledgedBy = doctorUserID
		}
		if a.resolvedAt != nil {
			resolvedBy = doctorUserID
		}
		if a.note != nil {
			resolutionNote = *a.note
		}
		if _, err := pool.ExecContext(ctx,
			"INSERT INTO `RiskAlert` (id, userId, level, reason, sourceType, acknowledgedAt, acknowledgedById, "+
				"resolvedAt, resolvedById, resolutionNote, notifiedDoctorUserId, assignedDoctorUserId, createdAt) "+
				"VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
			newID(), patientID, a.level, a.reason, a.sourceType, a.acknowledgedAt, acknowledgedBy,
			a.resolvedAt, resolvedBy, resolutionNote, doctorUserID, doctorUserID, a.createdAt,
		); err != nil {
			return err
		}
	}
	logger.Info("seeded 4 risk alerts for dr1@mindease.app (3 open, 1 resolved)")
	return nil
}

func upsertUser(ctx context.Context, pool *sql.DB, email, password, name, role string, phone, avatar *string) (string, bool, error) {
	var existingID string
	err := pool.QueryRowContext(ctx, "SELECT id FROM `User` WHERE email = ?", email).Scan(&existingID)
	if err == nil {
		return existingID, false, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", false, err
	}
	hashed, err := hashPassword(password)
	if err != nil {
		return "", false, err
	}
	id := newID()
	now := time.Now().UTC()
	if _, err := pool.ExecContext(ctx,
		"INSERT INTO `User` (id, email, password, name, role, phone_number, provider, avatar, createdAt, updatedAt) "+
			"VALUES (?,?,?,?,?,?,?,?,?,?)",
		id, email, hashed, name, role, phone, "local", avatar, now, now,
	); err != nil {
		return "", false, err
	}
	return id, true, nil
}

func hashPassword(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(password), salt, 3, 64*1024, 4, 32)
	return fmt.Sprintf("$argon2id$v=19$m=65536,t=3,p=4$%s$%s",
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key)), nil
}

func newID() string { return uuid.NewV7().String() }

func loadLocation(name string) *time.Location {
	loc, err := time.LoadLocation(name)
	if err != nil {
		return time.UTC
	}
	return loc
}

func strPtr(v string) *string { return &v }

func fatal(logger *slog.Logger, message string, err error) {
	logger.Error(message, "err", err)
	os.Exit(1)
}
