"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { useLocale, useTranslations } from "next-intl";
import { Doctor } from "@/lib/types/doctor";
import ReviewCard from "@/components/doctors/ReviewCard";
import Spinner from "@/components/ui/Spinner";
import api, { getErrorMessage } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { formatIDR } from "@/lib/format";
import { useAuth } from "@/context/AuthContext";
import {
    Star,
    BadgeCheck,
    Briefcase,
    Users,
    Calendar,
    Clock,
    ArrowLeft,
    ShieldCheck,
    DollarSign,
    HeartPulse,
    MessageSquareReply,
    CheckCircle2,
    Bell,
    Package,
    Trash2,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { cn } from "@/lib/utils";

interface DoctorProfileProps {
    doctor: Doctor & { userId?: number; consultationSlots?: any[] };
    reviews: any[];
    canReply?: boolean;
}

function ReviewReplyForm({ reviewId, onDone }: { reviewId: number; onDone: () => void }) {
    const t = useTranslations("features.reviewReply");
    const [reply, setReply] = useState("");
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
    const { toast } = useToast();

    const submit = async () => {
        if (!reply.trim()) return;
        setSaving(true);
        setMessage(null);
        try {
            await api.post(`/reviews/${reviewId}/reply`, { reply: reply.trim() });
            toast("Reply published", "success");
            onDone();
        } catch (err: any) {
            setMessage({ type: "error", text: getErrorMessage(err, "Failed to publish reply") });
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="mt-4 p-4 bg-gray-50 border border-gray-100 rounded-2xl">
            <p className="text-xs font-bold text-gray-500 mb-2 flex items-center gap-1.5">
                <MessageSquareReply className="w-3.5 h-3.5" /> {t("replyToReview")}
            </p>
            <textarea
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                rows={2}
                placeholder={t("placeholder")}
                className="w-full px-3 py-2.5 bg-white border border-gray-100 rounded-xl text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500/20 resize-none"
            />
            {message && (
                <p className={cn("text-xs font-bold mt-2", message.type === "success" ? "text-emerald-600" : "text-rose-500")}>
                    {message.type === "success" ? <CheckCircle2 className="w-3.5 h-3.5 inline mr-1" /> : null}
                    {message.text}
                </p>
            )}
            <button
                onClick={submit}
                disabled={!reply.trim() || saving}
                className="mt-2 px-4 py-2 rounded-xl bg-indigo-600 text-white text-xs font-bold hover:bg-indigo-700 transition-all disabled:opacity-50 flex items-center gap-1.5"
            >
                {saving ? <Spinner size="sm" className="text-white" /> : <MessageSquareReply className="w-3.5 h-3.5" />}
                {t("publish")}
            </button>
        </div>
    );
}

export default function DoctorProfile({ doctor, reviews, canReply }: DoctorProfileProps) {
    const tr = useTranslations("features.reviewReply");
    const { toast } = useToast();
    const { user } = useAuth();
    const confirm = useConfirm();
    const locale = useLocale();
    const [waitlistState, setWaitlistState] = useState<"idle" | "checking" | "on" | "off">("idle");
    const [waitlistBusy, setWaitlistBusy] = useState(false);
    const [showAllReviews, setShowAllReviews] = useState(false);
    const [replyingTo, setReplyingTo] = useState<number | null>(null);
    const [reviewsState, setReviewsState] = useState(reviews);
    const visibleReviews = showAllReviews ? reviewsState : reviewsState.slice(0, 4);

    const refreshReviews = async () => {
        try {
            const res = await api.get(`/reviews/doctor/${doctor.id}`);
            const data = res.data?.data || [];
            setReviewsState(
                data.map((r: any) => ({
                    id: r.id,
                    name: r.user?.name || "Patient",
                    avatar: r.user?.avatar,
                    rating: r.rating,
                    date: new Date(r.createdAt).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" }),
                    comment: r.comment,
                    reply: r.reply,
                    repliedAt: r.repliedAt,
                }))
            );
        } catch {
            window.location.reload();
        }
    };

    const reportReview = async (reviewId: number) => {
        const reason = prompt("Describe why this review should be reviewed by our team (min. 5 characters):");
        if (!reason || reason.trim().length < 5) return;
        try {
            await api.post(`/reviews/${reviewId}/report`, { reason: reason.trim() });
            toast("Review reported — our team will review it", "success");
        } catch (err: any) {
            toast(getErrorMessage(err, "Failed to report review"), "error");
        }
    };

    // Waitlist: only for patients, only when this doctor has no open slots
    useEffect(() => {
        if (user?.role !== "patient") return;
        const hasOpenSlots = (doctor.consultationSlots || []).some((s: any) => !s.isBooked && new Date(s.date) >= new Date());
        if (hasOpenSlots) return;
        api.get(`/doctors/${doctor.id}/waitlist/status`)
            .then((res) => setWaitlistState(res.data?.data?.onWaitlist ? "on" : "off"))
            .catch(() => setWaitlistState("off"));
    }, [user, doctor.id, doctor.consultationSlots]);

    const toggleWaitlist = async () => {
        if (!user) {
            toast("Please sign in to join the waitlist", "error");
            return;
        }
        setWaitlistBusy(true);
        try {
            if (waitlistState === "on") {
                await api.delete(`/doctors/${doctor.id}/waitlist`);
                setWaitlistState("off");
                toast("Removed from waitlist", "success");
            } else {
                await api.post(`/doctors/${doctor.id}/waitlist`);
                setWaitlistState("on");
                toast("You'll be notified when a slot opens", "success");
            }
        } catch (err: any) {
            toast(getErrorMessage(err, "Waitlist update failed"), "error");
        } finally {
            setWaitlistBusy(false);
        }
    };

    // Packages
    const [packages, setPackages] = useState<any[]>([]);
    const [packageForm, setPackageForm] = useState({ name: "", description: "", sessionCount: "4", totalPrice: "" });
    const [packageBusy, setPackageBusy] = useState(false);

    useEffect(() => {
        api.get(`/doctors/${doctor.id}/packages`)
            .then((res) => setPackages(res.data?.data || []))
            .catch(() => {});
    }, [doctor.id]);

    const createPackage = async () => {
        setPackageBusy(true);
        try {
            await api.post("/doctors/packages", {
                name: packageForm.name,
                description: packageForm.description,
                sessionCount: Number(packageForm.sessionCount),
                totalPrice: Number(packageForm.totalPrice),
            });
            toast("Package created", "success");
            setPackageForm({ name: "", description: "", sessionCount: "4", totalPrice: "" });
            api.get(`/doctors/${doctor.id}/packages`).then((res) => setPackages(res.data?.data || []));
        } catch (err: any) {
            toast(getErrorMessage(err, "Failed to create package"), "error");
        } finally {
            setPackageBusy(false);
        }
    };

    const deletePackage = async (pkgId: number) => {
        try {
            await api.delete(`/doctors/packages/${pkgId}`);
            toast("Package removed", "success");
            setPackages((prev) => prev.filter((p) => p.id !== pkgId));
        } catch (err: any) {
            toast(getErrorMessage(err, "Failed to remove package"), "error");
        }
    };

    /**
     * Opens a checkout for a package and follows the provider redirect.
     *
     * This used to call `POST /api/packages/:id/purchase` — a path that was
     * never mounted, and whose only real implementation refused every
     * self-service purchase anyway. The growth feature the README advertised
     * could not be completed by any user.
     */
    const purchasePackage = async (pkg: any) => {
        if (!user) {
            toast("Please sign in to purchase a package", "error");
            return;
        }
        const ok = await confirm({
            title: "Purchase this package?",
            message: `${pkg.name} — ${pkg.sessionCount} session${pkg.sessionCount === 1 ? "" : "s"} with ${doctor.name} for ${formatIDR(pkg.totalPrice, locale)}.`,
            confirmLabel: "Continue to payment",
            danger: false,
        });
        if (!ok) return;

        setPackageBusy(true);
        try {
            const res = await api.post(`/payments/packages/${pkg.id}/checkout`);
            const checkoutUrl = res.data?.data?.checkoutUrl;
            if (!checkoutUrl) {
                toast("Checkout is unavailable right now.", "error");
                return;
            }
            // With the simulator configured, settlement is immediate, so the
            // checkout URL is a local redirect. Following it lands the patient
            // back on their profile with the entitlement already granted.
            window.location.href = checkoutUrl;
        } catch (err: any) {
            toast(getErrorMessage(err, "Failed to start checkout"), "error");
        } finally {
            setPackageBusy(false);
        }
    };

    /**
     * Removed: a hardcoded list of six clinical focus areas rendered on every
     * profile as though it described that specific clinician. It was a
     * site-wide constant, so it told a patient that every psychologist in the
     * directory specialises in trauma, depression and relationships — a claim
     * about a real person's clinical scope that nothing in the data supported.
     * A clinician's stated focus has to come from their own profile.
     */

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5 }}
            className="pt-24 md:pt-32 px-4 md:px-8 max-w-7xl mx-auto"
        >
            <Link
                href="/appointments"
                className="inline-flex items-center gap-2 text-gray-500 hover:text-indigo-600 font-bold transition-all mb-8 group"
            >
                <div className="p-2 bg-gray-50 rounded-xl group-hover:bg-indigo-50 transition-colors">
                    <ArrowLeft className="w-4 h-4" />
                </div>
                Back to Selection
            </Link>

            <div className="flex flex-col lg:flex-row gap-12 items-start">
                {/* Left Column: Info */}
                <div className="flex-1 w-full">
                    {/* Hero Section */}
                    <section className="flex flex-col md:flex-row gap-8 items-center md:items-start text-center md:text-left mb-12">
                        <motion.div
                            initial={{ scale: 0.8, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            transition={{ delay: 0.2 }}
                            className="relative w-40 h-40 rounded-full overflow-hidden border-4 border-indigo-50 shadow-2xl shadow-indigo-100 flex-shrink-0"
                        >
                            {doctor.avatar ? (
                                <Image
                                    src={doctor.avatar}
                                    alt={doctor.name}
                                    fill
                                    className="object-cover"
                                />
                            ) : (
                                <div className="w-full h-full flex items-center justify-center bg-indigo-50 font-black text-indigo-500 text-5xl">
                                    {(doctor.name || "D").charAt(0).toUpperCase()}
                                </div>
                            )}
                        </motion.div>
                        <div className="pt-2">
                            <motion.div
                                initial={{ y: 20, opacity: 0 }}
                                animate={{ y: 0, opacity: 1 }}
                                transition={{ delay: 0.3 }}
                                className="flex flex-wrap justify-center md:justify-start items-center gap-3 mb-3"
                            >
                                <span className="px-4 py-1.5 bg-indigo-50 text-indigo-700 rounded-full text-xs font-bold uppercase tracking-widest border border-indigo-100/50">
                                    {doctor.specialty}
                                </span>
                                {doctor.isVerified && (
                                    <span className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-50 text-emerald-700 rounded-full text-xs font-bold border border-emerald-100">
                                        <BadgeCheck className="w-3.5 h-3.5" />
                                        Verified
                                    </span>
                                )}
                                <span className={cn(
                                    "px-4 py-1.5 rounded-full text-xs font-bold border",
                                    doctor.isAvailable
                                        ? "bg-emerald-50 text-emerald-700 border-emerald-100"
                                        : "bg-gray-50 text-gray-400 border-gray-100"
                                )}>
                                    {doctor.isAvailable ? "Available" : "Fully Booked"}
                                </span>
                            </motion.div>
                            <motion.h1
                                initial={{ y: 20, opacity: 0 }}
                                animate={{ y: 0, opacity: 1 }}
                                transition={{ delay: 0.4 }}
                                className="text-3xl md:text-5xl font-extrabold text-gray-900 mb-3 leading-tight"
                            >
                                {doctor.name}
                            </motion.h1>
                            <motion.div
                                initial={{ y: 20, opacity: 0 }}
                                animate={{ y: 0, opacity: 1 }}
                                transition={{ delay: 0.5 }}
                                className="flex justify-center md:justify-start items-center gap-2 text-gray-500 font-medium"
                            >
                                <div className="flex items-center gap-1 bg-amber-50 px-2 py-0.5 rounded-lg border border-amber-100">
                                    <Star className="w-4 h-4 text-amber-500 fill-amber-500" />
                                    <span className="text-amber-700 font-bold">{doctor.rating}</span>
                                </div>
                                <span className="text-gray-300">•</span>
                                <span className="text-sm">({doctor.reviewCount} Reviews)</span>
                            </motion.div>
                        </div>
                    </section>

                    {/* Quick Info Grid */}
                    <section className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-12">
                        {[
                            { icon: Briefcase, label: "Experience", value: `${doctor.experience} Years`, color: "text-indigo-500" },
                            { icon: Users, label: "Patients", value: `${doctor.reviewCount} Reviews`, color: "text-purple-500" },
                            { icon: Star, label: "Avg Rating", value: `${doctor.rating} / 5.0`, color: "text-amber-500" }
                        ].map((stat, i) => (
                            <motion.div
                                key={i}
                                initial={{ y: 20, opacity: 0 }}
                                animate={{ y: 0, opacity: 1 }}
                                transition={{ delay: 0.6 + (i * 0.1) }}
                                className="p-6 bg-gray-50 rounded-3xl border border-gray-100/50"
                            >
                                <div className="w-10 h-10 bg-white rounded-xl flex items-center justify-center mb-4 shadow-sm">
                                    <stat.icon className={cn("w-5 h-5", stat.color)} />
                                </div>
                                <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">{stat.label}</p>
                                <p className="text-xl font-bold text-gray-900">{stat.value}</p>
                            </motion.div>
                        ))}
                    </section>

                    {/* About Section */}
                    <motion.section
                        initial={{ y: 20, opacity: 0 }}
                        whileInView={{ y: 0, opacity: 1 }}
                        viewport={{ once: true }}
                        className="mb-12"
                    >
                        <h2 className="text-2xl font-bold text-gray-900 mb-6 flex items-center gap-3">
                            <ShieldCheck className="w-7 h-7 text-indigo-500" />
                            About Doctor
                        </h2>
                        <p className="text-gray-600 leading-relaxed text-lg whitespace-pre-line bg-gray-50/50 p-8 rounded-[2.5rem] border border-gray-100">
                            {doctor.bio}
                        </p>
                    </motion.section>

                    {/* Treatment Section */}
                    <motion.section
                        initial={{ y: 20, opacity: 0 }}
                        whileInView={{ y: 0, opacity: 1 }}
                        viewport={{ once: true }}
                        className="mb-12"
                    >
                        <h2 className="text-2xl font-bold text-gray-900 mb-6 flex items-center gap-3">
                            <HeartPulse className="w-7 h-7 text-rose-500" />
                            Clinical Background
                        </h2>
                        {/* Renders only what the clinician actually entered. A
                            previous version listed six fixed focus areas on
                            every profile, which asserted a clinical scope for
                            every psychologist in the directory regardless of
                            their stated specialisation. */}
                        <div className="space-y-4">
                            <div className="flex flex-wrap items-baseline gap-3">
                                <span className="text-xs font-bold text-gray-400 uppercase tracking-widest">
                                    Speciality
                                </span>
                                <span className="text-lg font-extrabold text-gray-900">
                                    {doctor.specialty}
                                </span>
                            </div>
                            {doctor.languages && (
                                <div className="flex flex-wrap items-baseline gap-3">
                                    <span className="text-xs font-bold text-gray-400 uppercase tracking-widest">
                                        Languages
                                    </span>
                                    <span className="text-sm font-semibold text-gray-700">
                                        {doctor.languages}
                                    </span>
                                </div>
                            )}
                            {doctor.education && (
                                <div>
                                    <span className="text-xs font-bold text-gray-400 uppercase tracking-widest">
                                        Education &amp; training
                                    </span>
                                    <p className="mt-1.5 text-sm leading-relaxed text-gray-700">
                                        {doctor.education}
                                    </p>
                                </div>
                            )}
                        </div>
                    </motion.section>

                    {/* Packages Section */}
                    <section className="mb-12">
                        <h2 className="text-2xl font-bold text-gray-900 mb-6 flex items-center gap-3">
                            <Package className="w-7 h-7 text-indigo-500" /> Therapy Packages
                        </h2>
                        {canReply && (
                            <div className="mb-6 p-5 bg-gray-50 rounded-3xl border border-gray-100 space-y-3">
                                <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">Create a package</p>
                                <div className="grid md:grid-cols-4 gap-3">
                                    <input
                                        value={packageForm.name}
                                        onChange={(e) => setPackageForm({ ...packageForm, name: e.target.value })}
                                        placeholder="Name (e.g. 4-session anxiety plan)"
                                        className="px-4 py-2.5 bg-white border border-gray-100 rounded-xl text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500/20 md:col-span-2"
                                    />
                                    <input
                                        value={packageForm.totalPrice}
                                        onChange={(e) => setPackageForm({ ...packageForm, totalPrice: e.target.value })}
                                        placeholder="Total price (Rp)"
                                        type="number"
                                        className="px-4 py-2.5 bg-white border border-gray-100 rounded-xl text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                                    />
                                    <input
                                        value={packageForm.sessionCount}
                                        onChange={(e) => setPackageForm({ ...packageForm, sessionCount: e.target.value })}
                                        placeholder="Sessions"
                                        type="number"
                                        min={2}
                                        max={20}
                                        className="px-4 py-2.5 bg-white border border-gray-100 rounded-xl text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                                    />
                                </div>
                                <input
                                    value={packageForm.description}
                                    onChange={(e) => setPackageForm({ ...packageForm, description: e.target.value })}
                                    placeholder="Description (optional)"
                                    className="w-full px-4 py-2.5 bg-white border border-gray-100 rounded-xl text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                                />
                                <button
                                    onClick={createPackage}
                                    disabled={!packageForm.name || !packageForm.totalPrice || packageBusy}
                                    className="px-5 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-bold hover:bg-indigo-700 transition-all disabled:opacity-50"
                                >
                                    {packageBusy ? "Saving..." : "Create Package"}
                                </button>
                            </div>
                        )}
                        {packages.length === 0 ? (
                            <div className="bg-gray-50 rounded-3xl py-10 text-center">
                                <Package className="w-8 h-8 text-gray-300 mx-auto mb-3" />
                                <p className="text-gray-500 font-medium">No packages yet.</p>
                            </div>
                        ) : (
                            <div className="grid md:grid-cols-2 gap-4">
                                {packages.map((pkg) => (
                                    <div key={pkg.id} className="p-6 bg-white border border-gray-100 rounded-3xl flex flex-col">
                                        <div className="flex items-start justify-between gap-3 mb-3">
                                            <h3 className="font-bold text-gray-900">{pkg.name}</h3>
                                            {canReply && (
                                                <button
                                                    onClick={() => deletePackage(pkg.id)}
                                                    className="text-rose-400 hover:text-rose-600 transition-colors"
                                                    title="Remove package"
                                                >
                                                    <Trash2 className="w-4 h-4" />
                                                </button>
                                            )}
                                        </div>
                                        {pkg.description && <p className="text-sm text-gray-500 leading-relaxed flex-1">{pkg.description}</p>}
                                        <div className="mt-4 flex items-center justify-between">
                                            <div>
                                                <p className="text-xs text-gray-400 font-bold uppercase tracking-widest">{pkg.sessionCount} sessions</p>
                                                <p className="text-xl font-black text-gray-900">Rp {pkg.totalPrice.toLocaleString("id-ID")}</p>
                                            </div>
                                            {!canReply && (
                                                <button
                                                    onClick={() => purchasePackage(pkg)}
                                                    disabled={packageBusy}
                                                    className="px-4 py-2 rounded-xl bg-indigo-600 text-white text-xs font-bold hover:bg-indigo-700 transition-all disabled:opacity-50"
                                                >
                                                    Purchase Package
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </section>

                    {/* Reviews Section */}
                    <section className="mb-20">
                        <div className="flex items-center justify-between mb-8">
                            <h2 className="text-2xl font-bold text-gray-900 flex items-center gap-3">
                                <Star className="w-7 h-7 text-amber-500" />
                                Latest Reviews
                            </h2>
                            {reviews.length > 4 && (
                                <button
                                    onClick={() => setShowAllReviews((prev) => !prev)}
                                    className="text-indigo-600 font-bold text-sm hover:underline"
                                >
                                    {showAllReviews ? "Show fewer reviews" : `See all ${reviews.length} reviews`}
                                </button>
                            )}
                        </div>
                        {visibleReviews.length > 0 ? (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {visibleReviews.map((review) => (
                                    <div key={review.id}>
                                        <ReviewCard review={review} doctorName={doctor.name} />
                                        {canReply && (
                                            <div className="flex items-center gap-3">
                                                <button
                                                    onClick={() => setReplyingTo(replyingTo === review.id ? null : review.id)}
                                                    className="mt-2 ml-4 text-xs font-bold text-indigo-600 hover:underline"
                                                >
                                                    {replyingTo === review.id ? tr("cancel") : review.reply ? tr("editReply") : tr("reply")}
                                                </button>
                                                <button
                                                    onClick={() => reportReview(review.id)}
                                                    className="mt-2 text-xs font-bold text-amber-600 hover:underline"
                                                >
                                                    Report
                                                </button>
                                            </div>
                                        )}
                                        {canReply && replyingTo === review.id && (
                                            <ReviewReplyForm
                                                reviewId={review.id}
                                                onDone={() => {
                                                    setReplyingTo(null);
                                                    refreshReviews();
                                                }}
                                            />
                                        )}
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="bg-gray-50 rounded-3xl py-12 text-center">
                                <Star className="w-8 h-8 text-gray-300 mx-auto mb-3" />
                                <p className="text-gray-500 font-medium">No reviews yet. Be the first to rate this doctor!</p>
                            </div>
                        )}
                    </section>
                </div>

                {/* Right Column: Booking Card (Desktop Sticky) */}
                <motion.div
                    initial={{ x: 20, opacity: 0 }}
                    animate={{ x: 0, opacity: 1 }}
                    transition={{ delay: 0.8 }}
                    className="w-full lg:w-[400px] lg:sticky lg:top-32 mb-12"
                >
                    <div className="bg-white rounded-[2.5rem] border border-gray-100 p-8 shadow-2xl shadow-gray-200/50">
                        <div className="flex items-center justify-between mb-8 pb-8 border-b border-gray-50">
                            <div>
                                <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Session Price</p>
                                <p className="text-3xl font-black text-gray-900 flex items-baseline gap-1">
                                    Rp {doctor.price.toLocaleString("id-ID")}
                                    <span className="text-sm font-medium text-gray-400">/hr</span>
                                </p>
                            </div>
                            <div className="p-4 bg-indigo-50 rounded-2xl">
                                <DollarSign className="w-6 h-6 text-indigo-600" />
                            </div>
                        </div>

                        <div className="space-y-4 mb-8">
                            <div className="flex items-center gap-4 p-4 bg-gray-50 rounded-2xl">
                                <Calendar className="w-5 h-5 text-indigo-500" />
                                <span className="text-sm font-bold text-gray-700">{doctor.availability || "Mon - Fri, 09:00 - 17:00"}</span>
                            </div>
                            <p className="text-xs text-center text-gray-400 font-medium">
                                *Schedule availability may change at any time.
                            </p>
                        </div>

                        <Link
                            href={`/appointments?doctor=${doctor.id}`}
                            className="w-full h-16 flex items-center justify-center gap-3 bg-gray-900 text-white rounded-2xl font-bold text-lg hover:bg-indigo-600 transition-all shadow-xl shadow-gray-200 active:scale-95 text-center"
                        >
                            <Clock className="w-5 h-5" />
                            Book Consultation
                        </Link>

                        {user?.role === "patient" && waitlistState !== "idle" && waitlistState !== "checking" && (
                            <button
                                onClick={toggleWaitlist}
                                disabled={waitlistBusy}
                                className={cn(
                                    "w-full mt-3 h-12 flex items-center justify-center gap-2 rounded-2xl font-bold text-sm border-2 transition-all disabled:opacity-50",
                                    waitlistState === "on"
                                        ? "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100"
                                        : "text-gray-600 border-gray-200 hover:border-emerald-300 hover:text-emerald-600"
                                )}
                            >
                                {waitlistBusy ? <Spinner size="sm" /> : waitlistState === "on" ? <CheckCircle2 className="w-4 h-4" /> : <Bell className="w-4 h-4" />}
                                {waitlistState === "on" ? "On waitlist — we'll notify you" : "Notify me when slots open"}
                            </button>
                        )}
                    </div>
                </motion.div>
            </div>

            {/* Mobile Sticky CTA */}
            <motion.div
                initial={{ y: 100 }}
                animate={{ y: 0 }}
                transition={{ delay: 1 }}
                className="fixed bottom-0 left-0 w-full p-4 bg-white/80 backdrop-blur-md border-t border-gray-100 lg:hidden z-50"
            >
                <Link
                    href={`/appointments?doctor=${doctor.id}`}
                    className="w-full h-14 flex items-center justify-center bg-gray-900 text-white rounded-2xl font-bold shadow-lg active:scale-95 transition-all"
                >
                    Book Now • Rp {doctor.price.toLocaleString("id-ID")}
                </Link>
            </motion.div>
        </motion.div>
    );
}
