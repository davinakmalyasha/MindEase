"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Star, X, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import api from "@/lib/api";
import { cn } from "@/lib/utils";

interface ReviewModalProps {
    doctorId: number;
    doctorName: string;
    appointmentId: number;
    onClose: () => void;
    onSuccess: () => void;
}

export default function ReviewModal({ doctorId, doctorName, appointmentId, onClose, onSuccess }: ReviewModalProps) {
    const [rating, setRating] = useState(0);
    const [hoverRating, setHoverRating] = useState(0);
    const [comment, setComment] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

    const ratingLabels = ["", "Poor", "Fair", "Good", "Very Good", "Excellent"];

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
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
            onClick={onClose}
        >
            <motion.div
                initial={{ scale: 0.9, opacity: 0, y: 20 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.9, opacity: 0, y: 20 }}
                transition={{ type: "spring", damping: 25, stiffness: 300 }}
                onClick={(e) => e.stopPropagation()}
                className="bg-white rounded-[2.5rem] p-8 md:p-10 w-full max-w-lg shadow-2xl shadow-black/20 relative"
            >
                {/* Close */}
                <button
                    onClick={onClose}
                    className="absolute top-6 right-6 w-10 h-10 rounded-xl bg-gray-50 flex items-center justify-center hover:bg-gray-100 transition-colors"
                >
                    <X className="w-5 h-5 text-gray-400" />
                </button>

                {/* Header */}
                <div className="text-center mb-8">
                    <div className="w-16 h-16 bg-amber-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
                        <Star className="w-8 h-8 text-amber-500" />
                    </div>
                    <h2 className="text-2xl font-black text-gray-900 font-outfit">Rate Your Experience</h2>
                    <p className="text-gray-500 font-medium mt-1">How was your session with <span className="text-indigo-600 font-bold">{doctorName}</span>?</p>
                </div>

                {/* Star Rating */}
                <div className="flex flex-col items-center mb-8">
                    <div className="flex gap-2 mb-3">
                        {[1, 2, 3, 4, 5].map((star) => (
                            <button
                                key={star}
                                type="button"
                                onMouseEnter={() => setHoverRating(star)}
                                onMouseLeave={() => setHoverRating(0)}
                                onClick={() => setRating(star)}
                                className="transition-transform hover:scale-125 active:scale-95"
                            >
                                <Star
                                    className={cn(
                                        "w-10 h-10 transition-colors",
                                        (hoverRating || rating) >= star
                                            ? "text-amber-400 fill-amber-400"
                                            : "text-gray-200"
                                    )}
                                />
                            </button>
                        ))}
                    </div>
                    <AnimatePresence mode="wait">
                        {(hoverRating || rating) > 0 && (
                            <motion.span
                                key={hoverRating || rating}
                                initial={{ opacity: 0, y: -5 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0 }}
                                className="text-sm font-bold text-amber-600 uppercase tracking-widest"
                            >
                                {ratingLabels[hoverRating || rating]}
                            </motion.span>
                        )}
                    </AnimatePresence>
                </div>

                {/* Comment */}
                <div className="mb-6 space-y-2">
                    <label className="text-xs font-bold text-gray-400 uppercase tracking-widest ml-1">Your Feedback</label>
                    <textarea
                        value={comment}
                        onChange={(e) => setComment(e.target.value)}
                        rows={4}
                        placeholder="Share your experience with the doctor..."
                        className="w-full px-6 py-4 bg-gray-50 border border-gray-100 rounded-2xl focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 transition-all font-medium text-gray-900 resize-none placeholder:text-gray-300"
                    />
                </div>

                {/* Message */}
                <AnimatePresence>
                    {message && (
                        <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: "auto" }}
                            exit={{ opacity: 0, height: 0 }}
                            className={cn(
                                "p-4 rounded-xl flex items-center gap-2 mb-6",
                                message.type === "success" ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"
                            )}
                        >
                            {message.type === "success" ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
                            <p className="text-xs font-bold">{message.text}</p>
                        </motion.div>
                    )}
                </AnimatePresence>

                {/* Submit */}
                <button
                    onClick={handleSubmit}
                    disabled={isSubmitting}
                    className="w-full py-4 bg-amber-500 text-white rounded-2xl font-bold flex items-center justify-center gap-2 hover:bg-amber-600 transition-all active:scale-95 shadow-xl shadow-amber-200 disabled:opacity-70"
                >
                    {isSubmitting ? <Loader2 className="w-5 h-5 animate-spin" /> : <Star className="w-5 h-5" />}
                    Submit Review
                </button>
            </motion.div>
        </motion.div>
    );
}
