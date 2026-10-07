"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Star, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import api from "@/lib/api";
import { cn } from "@/lib/utils";
import Dialog from "@/components/ui/Dialog";

interface ReviewModalProps {
    open: boolean;
    doctorId: number;
    doctorName: string;
    appointmentId: number;
    onClose: () => void;
    onSuccess: () => void;
}

const RATING_LABELS = ["", "Poor", "Fair", "Good", "Very Good", "Excellent"];

/**
 * Post-session review form.
 *
 * Rebuilt on the shared `Dialog`, which supplies `role="dialog"`,
 * `aria-modal`, Escape-to-close, a focus trap, focus restoration and a scroll
 * lock. This form previously hand-rolled its overlay and had none of those, so
 * it could not be completed with a keyboard: there was no way to reach the
 * submit button, and no way to leave.
 *
 * The star rating is now a native radio group rather than five buttons that
 * only respond to `onMouseEnter`/`onClick`. A keyboard or screen-reader user
 * could not previously rate a session at all, and the buttons carried no
 * accessible name even once focused.
 */
export default function ReviewModal({ open, doctorId, doctorName, appointmentId, onClose, onSuccess }: ReviewModalProps) {
    const [rating, setRating] = useState(0);
    const [hoverRating, setHoverRating] = useState(0);
    const [comment, setComment] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

    const handleSubmit = async () => {
        if (rating === 0) {
            setMessage({ type: "error", text: "Please select a rating." });
            return;
        }
        if (!comment.trim()) {
            setMessage({ type: "error", text: "Please write a comment." });
            return;
        }

        setIsSubmitting(true);
        setMessage(null);

        try {
            await api.post("/reviews", {
                doctorId,
                appointmentId,
                rating,
                comment: comment.trim(),
            });
            setMessage({ type: "success", text: "Review submitted successfully!" });
            setTimeout(() => {
                onSuccess();
                onClose();
            }, 1200);
        } catch (error: unknown) {
            const errMsg = (error as any)?.response?.data?.message || "Failed to submit review.";
            setMessage({ type: "error", text: errMsg });
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title="Rate Your Experience"
            description={
                <>
                    How was your session with{" "}
                    <span className="text-indigo-600 font-bold">{doctorName}</span>?
                </>
            }
        >
            <div className="mb-6 flex justify-center">
                <div className="w-16 h-16 bg-amber-50 rounded-2xl flex items-center justify-center">
                    <Star className="w-8 h-8 text-amber-500" aria-hidden="true" />
                </div>
            </div>

            {/* Star rating. Native radios give keyboard arrow navigation, a
                single tab stop and an announced value for free; the label
                carries the accessible name and the visible star is decorative. */}
            <fieldset
                className="mb-2"
                onMouseLeave={() => setHoverRating(0)}
            >
                <legend className="sr-only">Your rating</legend>
                <div className="flex gap-2 justify-center">
                    {[1, 2, 3, 4, 5].map((star) => (
                        <label
                            key={star}
                            className="cursor-pointer p-1 rounded-full hover:bg-amber-50 transition-colors"
                            onMouseEnter={() => setHoverRating(star)}
                        >
                            <input
                                type="radio"
                                name="rating"
                                value={star}
                                checked={rating === star}
                                onChange={() => setRating(star)}
                                className="sr-only"
                            />
                            <Star
                                aria-hidden="true"
                                className={cn(
                                    "w-10 h-10 transition-colors",
                                    (hoverRating || rating) >= star
                                        ? "text-amber-400 fill-amber-400"
                                        : "text-gray-200"
                                )}
                            />
                            <span className="sr-only">
                                {star} {RATING_LABELS[star]}
                            </span>
                        </label>
                    ))}
                </div>
            </fieldset>

            {/* Announced on change so the rating is not purely visual. */}
            <div aria-live="polite" className="text-center mb-6 min-h-5">
                <AnimatePresence mode="wait">
                    {(hoverRating || rating) > 0 && (
                        <motion.span
                            key={hoverRating || rating}
                            initial={{ opacity: 0, y: -5 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0 }}
                            className="inline-block text-sm font-bold text-amber-600 uppercase tracking-widest"
                        >
                            {RATING_LABELS[hoverRating || rating]}
                        </motion.span>
                    )}
                </AnimatePresence>
            </div>

            <div className="mb-4 space-y-2">
                <label htmlFor="review-comment" className="text-xs font-bold text-gray-400 uppercase tracking-widest ml-1">
                    Your Feedback
                </label>
                <textarea
                    id="review-comment"
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    rows={4}
                    placeholder="Share your experience with the doctor..."
                    className="w-full px-6 py-4 bg-gray-50 border border-gray-100 rounded-2xl focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 transition-all font-medium text-gray-900 resize-none placeholder:text-gray-300"
                />
            </div>

            {/* Errors are assertive: a blocked submission must interrupt. */}
            <div aria-live="assertive">
                <AnimatePresence>
                    {message && (
                        <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: "auto" }}
                            exit={{ opacity: 0, height: 0 }}
                            className={cn(
                                "p-4 rounded-xl flex items-center gap-2 mb-4",
                                message.type === "success" ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"
                            )}
                        >
                            {message.type === "success" ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
                            <p className="text-xs font-bold">{message.text}</p>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>

            <button
                type="button"
                onClick={handleSubmit}
                disabled={isSubmitting}
                className="w-full py-4 bg-amber-500 text-white rounded-2xl font-bold flex items-center justify-center gap-2 hover:bg-amber-600 transition-all active:scale-95 shadow-xl shadow-amber-200 disabled:opacity-70"
            >
                {isSubmitting ? <Loader2 className="w-5 h-5 animate-spin" /> : <Star className="w-5 h-5" />}
                Submit Review
            </button>
        </Dialog>
    );
}
