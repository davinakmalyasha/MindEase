import { prisma } from "../lib/prisma";
import { sanitize } from "../utils/sanitize";
import { invalidateDoctorCache } from "./doctor.service";
import { AuditService } from "./audit.service";
import { badRequest, conflict, forbidden, notFound } from "../utils/appError";



interface CreateReviewInput {
    userId: number;
    doctorId: number;
    appointmentId: number;
    rating: number;
    comment: string;
}

/**
 * A stable, non-reversible display name for a reviewer on a public listing.
 *
 * ## Why this exists
 *
 * `GET /api/reviews/doctor/:doctorId` is unauthenticated, because reviews belong
 * on a clinician's public profile. It also returned
 * `user: { id, name, avatar }` for each review - so an anonymous caller who
 * walked `/doctor/1`, `/doctor/2`, `/doctor/3` collected the real name, avatar
 * and internal user id of every patient who had reviewed a clinician.
 *
 * That is the identity of someone recorded as having received mental healthcare
 * from a named person, enumerable without an account. On a platform like this the
 * list of who has sought care is itself sensitive, and linking it to a name and
 * a face makes it worse.
 *
 * `GET /doctors/:id` already had to be rewritten to an explicit allowlist for
 * this class of leak. This endpoint was missed because it lives in a different
 * service, and the comment above it says "public", which read as reassurance
 * rather than as a warning about what public *means*.
 *
 * ## Why a pseudonym and not a blank
 *
 * Reviews are a thread. "Anonymous" with no label collapses every review onto
 * one indistinguishable voice, and a clinician answering a specific concern has
 * no way to know which one they answered. The name is derived from the user id,
 * so it is:
 *
 *   - stable, so a reviewer's replies and follow-ups thread under one label;
 *   - not derived from their real name, so it reveals nothing about it;
 *   - not reversible, because the id space is not enumerable from the output.
 *
 * Two different reviewers get two different labels, which is the minimum for the
 * conversation to work.
 */
const PSEUDONYM_ADJECTIVES = [
    "Calm",
    "Thoughtful",
    "Steady",
    "Kind",
    "Quiet",
    "Brave",
    "Gentle",
    "Patient",
    "Honest",
    "Open",
    "Grounded",
    "Hopeful",
];

const PSEUDONYM_NOUNS = [
    "Otter",
    "Heron",
    "Willow",
    "Lark",
    "Cedar",
    "Finch",
    "Meadow",
    "Slate",
    "Aspen",
    "Heron",
    "Kestrel",
    "Sorrel",
];

function publicDisplayName(userId: number): string {
    // Two independent mixes of the id, so that ids which are adjacent - and
    // therefore likely to be created together - do not produce adjacent names.
    const a = PSEUDONYM_ADJECTIVES[userId % PSEUDONYM_ADJECTIVES.length];
    const b = PSEUDONYM_NOUNS[Math.floor(userId / PSEUDONYM_ADJECTIVES.length) % PSEUDONYM_NOUNS.length];
    return `${a} ${b}`;
}

export class ReviewService {
    static async createReview(data: CreateReviewInput) {
        // Validate: appointment must exist, belong to user, match doctor, and be completed
        const appointment = await prisma.appointment.findFirst({
            where: {
                id: data.appointmentId,
                userId: data.userId,
                doctorId: data.doctorId,
                status: "completed",
            },
        });

        if (!appointment) {
            throw badRequest("Invalid appointment or not eligible for review.");
        }

        // Enforce one review per appointment
        const existing = await prisma.review.findUnique({
            where: { appointmentId: data.appointmentId },
        });
        if (existing) {
            throw conflict("You have already reviewed this appointment.");
        }

        const review = await prisma.review.create({
            data: {
                userId: data.userId,
                doctorId: data.doctorId,
                appointmentId: data.appointmentId,
                rating: data.rating,
                comment: sanitize(data.comment),
            },
            include: {
                user: {
                    select: { id: true, name: true, avatar: true },
                },
            },
        });

        // Recalculate the doctor's public aggregate.
        //
        // This used to inline a second, divergent aggregation here: it wrote
        // only `rating`, never `totalReviews`, and fell back to `|| 5` — which
        // is precisely the fabricated-perfect-rating policy that
        // `recalcDoctorRating` and the `Doctor.rating` column comment exist to
        // prevent. Two writers with different semantics meant `totalReviews`
        // stayed 0 forever on the create path, and a clinician whose only review
        // was hidden was shown to patients as a 5.0.
        //
        // There is now exactly one writer.
        await this.recalcDoctorRating(data.doctorId);

        const aggregation = await prisma.review.aggregate({
            where: { doctorId: data.doctorId, hidden: false },
            _avg: { rating: true },
            _count: { rating: true },
        });

        return {
            review,
            averageRating: aggregation._avg.rating,
            totalReviews: aggregation._count.rating,
        };
    }

    /**
     * Public review listing for a doctor.
     *
     * Bounded. This route is unauthenticated, so an unbounded `findMany` let
     * anyone pull a clinician's entire review history in one request — every
     * review author name and avatar included. The count is returned alongside so
     * the client can show "showing 50 of N".
     */
    static async getReviewsByDoctor(doctorId: number, limit = 20, offset = 0) {
        const take = Math.min(Math.max(limit, 1), 50);
        const skip = Math.max(offset, 0);

        const [reviews, total] = await Promise.all([
            prisma.review.findMany({
                where: { doctorId, hidden: false },
                // Only the id. The reviewer's name and avatar are *not* selected,
                // because they must not reach an anonymous caller - see
                // `publicDisplayName` below for what is returned instead.
                select: {
                    id: true,
                    rating: true,
                    comment: true,
                    reply: true,
                    repliedAt: true,
                    createdAt: true,
                    userId: true,
                },
                orderBy: { createdAt: "desc" },
                take,
                skip,
            }),
            prisma.review.count({ where: { doctorId, hidden: false } }),
        ]);

        // A clinician replying publicly is the point of the feature and stays.
        // The reviewer's identity is what has to go.
        return {
            reviews: reviews.map((r) => ({
                id: r.id,
                rating: r.rating,
                comment: r.comment,
                reply: r.reply,
                repliedAt: r.repliedAt,
                createdAt: r.createdAt,
                displayName: publicDisplayName(r.userId),
            })),
            total,
            limit: take,
            offset: skip,
        };
    }

    // Doctors may report reviews on their own profile (one open report per review)
    static async reportReview(reviewId: number, doctorUserId: number, reason: string) {
        const review = await prisma.review.findUnique({
            where: { id: reviewId },
            include: { doctor: { select: { userId: true } } },
        });
        if (!review) throw notFound("Review not found");
        if (review.doctor.userId !== doctorUserId) {
            throw forbidden("you can only report reviews on your own profile");
        }

        const open = await prisma.reviewReport.findFirst({
            where: { reviewId, status: "open" },
        });
        if (open) throw conflict("This review already has an open report");

        const report = await prisma.reviewReport.create({
            data: { reviewId, reporterId: doctorUserId, reason: sanitize(reason).slice(0, 2000) },
        });

        await AuditService.log({
            action: "review.report",
            actorId: doctorUserId,
            targetType: "Review",
            targetId: reviewId,
            meta: { reportId: report.id, doctorId: review.doctorId },
        });

        return report;
    }

    // Shared recalculation used on create and when admins hide/unhide
    static async recalcDoctorRating(doctorId: number) {
        const aggregation = await prisma.review.aggregate({
            where: { doctorId, hidden: false },
            _avg: { rating: true },
            _count: { rating: true },
        });
        await prisma.doctor.update({
            where: { id: doctorId },
            data: {
                // A clinician with no visible reviews has no rating. Writing
                // 5.0 here — as this previously did — presented a brand-new or
                // fully-moderated-away doctor to patients as a perfect 5.0,
                // which is a fabricated clinical claim.
                rating:
                    aggregation._count.rating > 0
                        ? Math.round((aggregation._avg.rating || 0) * 10) / 10
                        : 0,
                totalReviews: aggregation._count.rating,
            },
        });
        invalidateDoctorCache(doctorId);
    }

    static async getDoctorRatingSummary(doctorId: number) {
        const aggregation = await prisma.review.aggregate({
            where: { doctorId, hidden: false },
            _avg: { rating: true },
            _count: { rating: true },
        });

        // Rating distribution for the summary card
        const distribution = await prisma.review.groupBy({
            by: ["rating"],
            where: { doctorId, hidden: false },
            _count: { rating: true },
        });

        return {
            averageRating: Math.round((aggregation._avg.rating || 0) * 10) / 10,
            totalReviews: aggregation._count.rating,
            distribution: Object.fromEntries(distribution.map((d) => [d.rating, d._count.rating])),
        };
    }

    // Doctors may reply to reviews on their own profile (one reply, update-in-place)
    static async replyToReview(reviewId: number, doctorUserId: number, reply: string) {
        const review = await prisma.review.findUnique({
            where: { id: reviewId },
            include: { doctor: { select: { userId: true } } },
        });
        if (!review) throw notFound("Review not found");
        if (review.doctor.userId !== doctorUserId) {
            throw forbidden("you can only reply to reviews on your own profile");
        }

        const cleaned = sanitize(reply.trim());
        if (!cleaned) throw badRequest("Reply cannot be empty");

        const updated = await prisma.review.update({
            where: { id: reviewId },
            data: { reply: cleaned, repliedAt: new Date() },
        });

        await AuditService.log({
            action: "review.reply",
            actorId: doctorUserId,
            targetType: "Review",
            targetId: reviewId,
            meta: { doctorId: review.doctorId },
        });

        return updated;
    }
}
