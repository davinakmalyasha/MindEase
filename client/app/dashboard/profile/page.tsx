"use client";

import { useState, useEffect, useRef } from "react";
import api, { getErrorMessage } from "@/lib/api";
import { motion, AnimatePresence } from "framer-motion";
import {
    Camera,
    User,
    Phone,
    Mail,
    Stethoscope,
    DollarSign,
    FileText,
    Save,
    Loader2,
    CheckCircle2,
    AlertCircle,
    KeyRound,
    Trash2,
    Download,
    Gift,
    Copy,
    BadgeCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import DashboardLayout from "@/components/layout/DashboardLayout";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";

export default function ProfilePage() {
    const { user, setUser, logout } = useAuth();
    const { toast } = useToast();
    const confirm = useConfirm();
    const fileInputRef = useRef<HTMLInputElement>(null);

    const sessionCreditCount = (n: number) => `${n} free session credit${n === 1 ? "" : "s"}`;

    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

    const [name, setName] = useState("");
    const [phone, setPhone] = useState("");
    const [bio, setBio] = useState("");
    const [specialization, setSpecialization] = useState("");
    const [fee, setFee] = useState<string | number>("");
    const [file, setFile] = useState<File | null>(null);
    const [preview, setPreview] = useState("");
    const [weeklyReport, setWeeklyReport] = useState(false);
    const [notifPrefs, setNotifPrefs] = useState<{ appointment: { inApp: boolean; email: boolean }; message: { inApp: boolean; email: boolean }; system: { inApp: boolean; email: boolean } }>({
        appointment: { inApp: true, email: false },
        message: { inApp: true, email: false },
        system: { inApp: true, email: true },
    });
    const [notifPrefsLoading, setNotifPrefsLoading] = useState(false);
    const [referralCode, setReferralCode] = useState("");
    const [sessionCredits, setSessionCredits] = useState(0);
    const [doctorProfile, setDoctorProfile] = useState<any>(null);
    const [licenseNumber, setLicenseNumber] = useState("");
    const [licenseIssuer, setLicenseIssuer] = useState("");
    const [experienceYears, setExperienceYears] = useState<string | number>("");

    // Security form
    const [currentPassword, setCurrentPassword] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [securityLoading, setSecurityLoading] = useState(false);

    useEffect(() => {
        const fetchProfile = async () => {
            try {
                const res = await api.get("/users/profile");
                const data = res.data?.data || res.data;
                const doctorProfile = data.doctorProfile;

                setName(data.name || "");
                setPhone(data.phone_number || "");
                setPreview(data.avatar || "");
                setWeeklyReport(!!data.weeklyReportEnabled);
                setReferralCode(data.referralCode || "");
                setSessionCredits(data.sessionCredits || 0);

                try {
                    const prefsRes = await api.get("/notifications/preferences");
                    const prefs = prefsRes.data?.data;
                    if (prefs) {
                        setNotifPrefs({
                            appointment: { inApp: !!prefs.appointment?.inApp, email: !!prefs.appointment?.email },
                            message: { inApp: !!prefs.message?.inApp, email: !!prefs.message?.email },
                            system: { inApp: !!prefs.system?.inApp, email: !!prefs.system?.email },
                        });
                    }
                } catch { /* non-critical */ }

                if (data.role === "doctor") {
                    setBio(doctorProfile?.bio || "");
                    setSpecialization(doctorProfile?.specialty || "");
                    setFee(doctorProfile?.price || "");
                    setDoctorProfile(doctorProfile || null);
                    setLicenseNumber(doctorProfile?.licenseNumber || "");
                    setLicenseIssuer(doctorProfile?.licenseIssuer || "");
                    setExperienceYears(doctorProfile?.experience ?? "");
                }
            } catch (err) {
                toast(getErrorMessage(err, "Failed to load profile"), "error");
            } finally {
                setIsLoading(false);
            }
        };
        fetchProfile();
    }, [toast]);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const selectedFile = e.target.files?.[0];
        if (selectedFile) {
            setFile(selectedFile);
            setPreview(URL.createObjectURL(selectedFile));
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSaving(true);
        setMessage(null);

        const formData = new FormData();
        formData.append("name", name);
        formData.append("phone_number", phone);
        if (file) formData.append("avatar", file);

        if (user?.role === "doctor") {
            formData.append("bio", bio);
            formData.append("specialization", specialization);
            formData.append("consultation_fee", String(fee));
            formData.append("license_number", licenseNumber);
            formData.append("license_issuer", licenseIssuer);
            formData.append("experience_years", String(experienceYears || 0));
        }

        if (user?.role === "patient") {
            formData.append("weekly_report_enabled", String(weeklyReport));
        }

        try {
            const res = await api.put("/users/profile", formData, {
                headers: { "Content-Type": "multipart/form-data" },
            });
            const updated = res.data?.data?.user || res.data?.user;
            setMessage({ type: "success", text: "Profile updated successfully!" });
            toast("Profile updated", "success");

            if (updated) {
                setUser(updated);
                localStorage.setItem("user", JSON.stringify(updated));
            }
            setFile(null);
        } catch (err: any) {
            setMessage({ type: "error", text: getErrorMessage(err, "Failed to update profile") });
        } finally {
            setIsSaving(false);
        }
    };

    const toggleNotifPref = async (key: keyof typeof notifPrefs, channel: "inApp" | "email") => {
        const next = { ...notifPrefs, [key]: { ...notifPrefs[key], [channel]: !notifPrefs[key][channel] } };
        setNotifPrefsLoading(true);
        try {
            await api.put("/notifications/preferences", next);
            setNotifPrefs(next);
            toast("Notification preferences updated", "success");
        } catch (err) {
            toast(getErrorMessage(err, "Failed to update preferences"), "error");
        } finally {
            setNotifPrefsLoading(false);
        }
    };

    const handleChangePassword = async () => {
        // Match the server's complexity rules before hitting the API
        const checks: { ok: boolean; msg: string }[] = [
            { ok: newPassword.length >= 8, msg: "at least 8 characters" },
            { ok: /[A-Z]/.test(newPassword), msg: "an uppercase letter" },
            { ok: /[0-9]/.test(newPassword), msg: "a number" },
            { ok: /[^A-Za-z0-9]/.test(newPassword), msg: "a special character" },
        ];
        const failed = checks.filter((c) => !c.ok).map((c) => c.msg);
        if (failed.length > 0) {
            toast(`New password needs ${failed.join(", ")}`, "error");
            return;
        }
        setSecurityLoading(true);
        try {
            await api.post("/account/change-password", {
                currentPassword,
                newPassword,
            });
            toast("Password changed successfully", "success");
            setCurrentPassword("");
            setNewPassword("");
        } catch (err) {
            toast(getErrorMessage(err, "Failed to change password"), "error");
        } finally {
            setSecurityLoading(false);
        }
    };

    const handleDeleteAccount = async () => {
        const ok1 = await confirm({
            title: "Delete your account?",
            message: "This permanently deletes your account and all your data. Your past appointments are anonymized.",
            confirmLabel: "Continue",
            danger: true,
        });
        if (!ok1) return;
        const ok2 = await confirm({
            title: "Are you absolutely sure?",
            message: "This cannot be undone.",
            confirmLabel: "Delete forever",
            danger: true,
        });
        if (!ok2) return;
        try {
            await api.delete("/account/me");
            toast("Account deleted. We're sorry to see you go.", "success");
            await logout();
            window.location.href = "/";
        } catch (err) {
            toast(getErrorMessage(err, "Failed to delete account"), "error");
        }
    };

    if (isLoading) {
        return (
            <DashboardLayout>
                <div className="h-64 bg-white border border-gray-100 rounded-[2.5rem] animate-pulse" />
            </DashboardLayout>
        );
    }

    const inputClass = "w-full px-6 py-4 bg-gray-50 border border-gray-100 rounded-2xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all font-medium text-gray-900 placeholder:text-gray-300";

    return (
        <DashboardLayout>
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="max-w-2xl mx-auto"
            >
                <header className="mb-8">
                    <h1 className="text-3xl font-extrabold text-gray-900 font-outfit">Edit <span className="text-indigo-600">Profile</span></h1>
                    <p className="text-gray-500 mt-1">Keep your information up to date</p>
                </header>

                <div className="bg-white rounded-[2.5rem] shadow-2xl shadow-indigo-500/5 border border-gray-100 p-8 md:p-12">
                    <form onSubmit={handleSubmit} className="space-y-10">
                        {/* Avatar */}
                        <div className="flex flex-col items-center gap-6">
                            <div className="relative group">
                                <div className="w-32 h-32 rounded-full overflow-hidden border-4 border-white shadow-xl ring-2 ring-indigo-50">
                                    <img
                                        src={preview || `https://api.dicebear.com/9.x/avataaars/svg?seed=${user?.name || "user"}`}
                                        alt="Profile Preview"
                                        className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110"
                                    />
                                </div>
                                <button
                                    type="button"
                                    onClick={() => fileInputRef.current?.click()}
                                    className="absolute bottom-0 right-0 p-2.5 bg-indigo-600 text-white rounded-full shadow-lg hover:bg-indigo-700 transition-all scale-90 hover:scale-100 active:scale-95"
                                >
                                    <Camera className="w-5 h-5" />
                                </button>
                                <input
                                    type="file"
                                    ref={fileInputRef}
                                    onChange={handleFileChange}
                                    accept="image/*"
                                    className="hidden"
                                />
                            </div>
                            <div className="text-center">
                                <h2 className="text-xl font-bold text-gray-900">{user?.name}</h2>
                                <p className="text-sm font-medium text-gray-400 uppercase tracking-widest mt-1">{user?.role}</p>
                            </div>
                        </div>

                        <AnimatePresence>
                            {message && (
                                <motion.div
                                    initial={{ opacity: 0, height: 0 }}
                                    animate={{ opacity: 1, height: "auto" }}
                                    exit={{ opacity: 0, height: 0 }}
                                    className={cn(
                                        "p-4 rounded-2xl flex items-center gap-3",
                                        message.type === "success" ? "bg-emerald-50 text-emerald-700 border border-emerald-100" : "bg-rose-50 text-rose-700 border border-rose-100"
                                    )}
                                >
                                    {message.type === "success" ? <CheckCircle2 className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
                                    <p className="text-sm font-bold">{message.text}</p>
                                </motion.div>
                            )}
                        </AnimatePresence>

                        {/* General Info */}
                        <div className="space-y-6">
                            <div className="flex items-center gap-3 mb-2">
                                <div className="p-2 bg-indigo-50 rounded-lg">
                                    <User className="w-4 h-4 text-indigo-600" />
                                </div>
                                <h3 className="font-bold text-gray-900">General Information</h3>
                            </div>

                            <div className="grid grid-cols-1 gap-6">
                                <div className="space-y-2">
                                    <label className="text-xs font-bold text-gray-400 uppercase tracking-widest ml-1">Full Name</label>
                                    <input type="text" value={name} onChange={(e) => setName(e.target.value)} required placeholder="John Doe" className={inputClass} />
                                </div>

                                <div className="space-y-2 opacity-60">
                                    <label className="text-xs font-bold text-gray-400 uppercase tracking-widest ml-1 flex items-center gap-2">
                                        Email Address <span className="text-[10px] bg-gray-100 px-2 py-0.5 rounded-full">Read Only</span>
                                    </label>
                                    <div className="w-full px-6 py-4 bg-gray-100 border border-gray-200 rounded-2xl flex items-center gap-3 cursor-not-allowed">
                                        <Mail className="w-5 h-5 text-gray-400" />
                                        <span className="font-medium text-gray-500">{user?.email}</span>
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <label className="text-xs font-bold text-gray-400 uppercase tracking-widest ml-1">WhatsApp Number</label>
                                    <div className="relative">
                                        <Phone className="absolute left-6 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                                        <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} required placeholder="+6281234567890" className={cn(inputClass, "pl-14")} />
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Doctor Specific */}
                        {user?.role === "doctor" && (
                            <motion.div initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} className="space-y-6 pt-6 border-t border-gray-50">
                                <div className="flex items-center gap-3 mb-2">
                                    <div className="p-2 bg-purple-50 rounded-lg">
                                        <Stethoscope className="w-4 h-4 text-purple-600" />
                                    </div>
                                    <h3 className="font-bold text-gray-900">Doctor Profile Details</h3>
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                    <div className="space-y-2">
                                        <label className="text-xs font-bold text-gray-400 uppercase tracking-widest ml-1">Specialization</label>
                                        <input type="text" value={specialization} onChange={(e) => setSpecialization(e.target.value)} placeholder="e.g. Clinical Psychologist" className={inputClass} />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-xs font-bold text-gray-400 uppercase tracking-widest ml-1">Consultation Fee</label>
                                        <div className="relative">
                                            <span className="absolute left-6 top-1/2 -translate-y-1/2 font-bold text-gray-400">Rp</span>
                                            <input type="number" value={fee} onChange={(e) => setFee(e.target.value)} placeholder="150000" className={cn(inputClass, "pl-14")} />
                                        </div>
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <label className="text-xs font-bold text-gray-400 uppercase tracking-widest ml-1 flex items-center gap-2">
                                        Professional Bio <FileText className="w-3 h-3" />
                                    </label>
                                    <textarea value={bio} onChange={(e) => setBio(e.target.value)} rows={4} placeholder="Write a brief professional biography..." className={cn(inputClass, "resize-none")} />
                                </div>

                                {/* Verification application */}
                                <div className="rounded-2xl border border-gray-100 bg-gray-50/50 p-5 space-y-4">
                                    <div className="flex items-center justify-between gap-4">
                                        <p className="text-sm font-bold text-gray-900 flex items-center gap-2">
                                            <BadgeCheck className={cn("w-4 h-4", doctorProfile?.verificationStatus === "approved" ? "text-emerald-500" : "text-gray-400")} />
                                            Verification
                                        </p>
                                        <span className={cn(
                                            "px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wider",
                                            doctorProfile?.verificationStatus === "approved" ? "bg-emerald-100 text-emerald-700"
                                                : doctorProfile?.verificationStatus === "rejected" ? "bg-rose-100 text-rose-600"
                                                : "bg-amber-100 text-amber-700"
                                        )}>
                                            {doctorProfile?.verificationStatus || "pending"}
                                        </span>
                                    </div>
                                    {doctorProfile?.verificationStatus !== "approved" && (
                                        <p className="text-xs text-gray-500">
                                            {doctorProfile?.verificationStatus === "rejected"
                                                ? "Your application was rejected — update your credentials below and save to resubmit."
                                                : "Submit your license details below and save. An admin will review your profile before it appears in the directory."}
                                        </p>
                                    )}
                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                        <div className="space-y-1.5">
                                            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">License Number</label>
                                            <input type="text" value={licenseNumber} onChange={(e) => setLicenseNumber(e.target.value)} placeholder="e.g. PSI-123456" className={inputClass} />
                                        </div>
                                        <div className="space-y-1.5">
                                            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">License Issuer</label>
                                            <input type="text" value={licenseIssuer} onChange={(e) => setLicenseIssuer(e.target.value)} placeholder="e.g. HIMPSI" className={inputClass} />
                                        </div>
                                        <div className="space-y-1.5">
                                            <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Years of Experience</label>
                                            <input type="number" min={0} value={experienceYears} onChange={(e) => setExperienceYears(e.target.value)} placeholder="8" className={inputClass} />
                                        </div>
                                    </div>
                                </div>
                            </motion.div>
                        )}

                        <button
                            type="submit"
                            disabled={isSaving}
                            className="w-full h-14 bg-indigo-600 text-white rounded-2xl font-bold flex items-center justify-center gap-2 hover:bg-indigo-700 transition-all active:scale-95 shadow-xl shadow-indigo-200 disabled:opacity-70"
                        >
                            {isSaving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
                            Save Profile Changes
                        </button>
                    </form>
                </div>

                {/* Wellness Preferences */}
                {user?.role === "patient" && (
                    <div className="bg-white rounded-[2.5rem] shadow-xl shadow-indigo-500/5 border border-gray-100 p-8 md:p-12 mt-8">
                        <div className="flex items-center gap-3 mb-6">
                            <div className="p-2 bg-emerald-50 rounded-lg">
                                <Mail className="w-4 h-4 text-emerald-600" />
                            </div>
                            <h3 className="font-bold text-gray-900">Wellness Preferences</h3>
                        </div>
                        <label className="flex items-start justify-between gap-4 cursor-pointer">
                            <div>
                                <p className="font-bold text-gray-900">Weekly wellness report</p>
                                <p className="text-sm text-gray-500 mt-1">
                                    Get a Monday email with your mood summary and an AI reflection of your journal.
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={() => setWeeklyReport((v) => !v)}
                                className={cn(
                                    "relative w-14 h-8 rounded-full transition-colors shrink-0",
                                    weeklyReport ? "bg-emerald-500" : "bg-gray-200"
                                )}
                                aria-pressed={weeklyReport}
                            >
                                <span
                                    className={cn(
                                        "absolute top-1 w-6 h-6 bg-white rounded-full shadow transition-all",
                                        weeklyReport ? "left-7" : "left-1"
                                    )}
                                />
                            </button>
                        </label>
                    </div>
                )}

                {/* Notification preferences — available to every role */}
                <div className="bg-white rounded-[2.5rem] shadow-xl shadow-indigo-500/5 border border-gray-100 p-8 md:p-12 mt-8">
                    <p className="font-bold text-gray-900">Notification preferences</p>
                    <p className="text-sm text-gray-500 mt-1 mb-6">Choose which notifications you receive in-app and by email.</p>
                    {([
                        { key: "appointment" as const, label: "Appointments", desc: "Bookings, confirmations, cancellations and reminders" },
                        { key: "message" as const, label: "Messages", desc: "New messages from your doctor or patient" },
                        { key: "system" as const, label: "System", desc: "Broadcasts and account notices" },
                    ]).map((item) => (
                        <div key={item.key} className="rounded-2xl border border-gray-100 p-4">
                            <div className="flex items-center justify-between gap-4">
                                <div>
                                    <p className="text-sm font-bold text-gray-900">{item.label}</p>
                                    <p className="text-xs text-gray-500">{item.desc}</p>
                                </div>
                            </div>
                            <div className="flex items-center gap-6 mt-3">
                                {(["inApp", "email"] as const).map((channel) => (
                                    <label key={channel} className="flex items-center gap-2 cursor-pointer">
                                        <button
                                            type="button"
                                            disabled={notifPrefsLoading}
                                            onClick={() => toggleNotifPref(item.key, channel)}
                                            className={cn(
                                                "relative w-11 h-6 rounded-full transition-colors shrink-0 disabled:opacity-50",
                                                notifPrefs[item.key][channel] ? "bg-indigo-500" : "bg-gray-200"
                                            )}
                                            aria-pressed={notifPrefs[item.key][channel]}
                                        >
                                            <span
                                                className={cn(
                                                    "absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all",
                                                    notifPrefs[item.key][channel] ? "left-[22px]" : "left-0.5"
                                                )}
                                            />
                                        </button>
                                        <span className="text-xs font-bold text-gray-600 capitalize">{channel === "inApp" ? "In-app" : "Email"}</span>
                                    </label>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>

                {/* Referral */}
                <div className="bg-white rounded-[2.5rem] shadow-xl shadow-indigo-500/5 border border-gray-100 p-8 md:p-12 mt-8">
                    <div className="flex items-center gap-3 mb-4">
                        <div className="p-2 bg-violet-50 rounded-lg">
                            <Gift className="w-4 h-4 text-violet-600" />
                        </div>
                        <h3 className="font-bold text-gray-900">Invite friends</h3>
                    </div>
                    <p className="text-sm text-gray-500 mb-4">
                        Share your link — when a friend registers and completes their first session, you earn{" "}
                        <span className="font-bold text-gray-700">one free session credit</span>. Credits are applied
                        automatically to your future bookings.
                    </p>
                    {sessionCredits > 0 && (
                        <div className="mb-4 inline-flex items-center gap-2 px-4 py-2.5 bg-emerald-50 border border-emerald-100 rounded-xl">
                            <Gift className="w-4 h-4 text-emerald-600" />
                            <span className="text-sm font-black text-emerald-700">
                                {sessionCreditCount(sessionCredits)} available — will cover your next booking
                            </span>
                        </div>
                    )}
                    {referralCode ? (
                        <div className="flex flex-wrap items-center gap-3">
                            <code className="px-4 py-2.5 bg-violet-50 border border-violet-100 rounded-xl font-black text-violet-700 text-sm">
                                {referralCode}
                            </code>
                            <button
                                onClick={async () => {
                                    const url = `${window.location.origin}/register?ref=${referralCode}`;
                                    await navigator.clipboard.writeText(url);
                                    toast("Referral link copied!", "success");
                                }}
                                className="px-4 py-2.5 rounded-xl bg-violet-600 text-white text-sm font-bold hover:bg-violet-700 transition-all flex items-center gap-2"
                            >
                                <Copy className="w-4 h-4" /> Copy invite link
                            </button>
                        </div>
                    ) : null}
                </div>

                {/* Security */}
                <div className="bg-white rounded-[2.5rem] shadow-xl shadow-indigo-500/5 border border-gray-100 p-8 md:p-12 mt-8">
                    <div className="flex items-center gap-3 mb-6">
                        <div className="p-2 bg-rose-50 rounded-lg">
                            <KeyRound className="w-4 h-4 text-rose-500" />
                        </div>
                        <h3 className="font-bold text-gray-900">Security</h3>
                    </div>

                    <div className="space-y-4 max-w-md">
                        <div className="space-y-2">
                            <label className="text-xs font-bold text-gray-400 uppercase tracking-widest ml-1">Current Password</label>
                            <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} className={inputClass} />
                        </div>
                        <div className="space-y-2">
                            <label className="text-xs font-bold text-gray-400 uppercase tracking-widest ml-1">New Password</label>
                            <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className={inputClass} />
                            <p className="text-[10px] text-gray-400 ml-1">8+ chars, uppercase, number & special character</p>
                        </div>
                        <button
                            onClick={handleChangePassword}
                            disabled={!currentPassword || !newPassword || securityLoading}
                            className="w-full h-12 bg-rose-500 text-white rounded-2xl font-bold flex items-center justify-center gap-2 hover:bg-rose-600 transition-all disabled:opacity-50 shadow-lg shadow-rose-200"
                        >
                            {securityLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
                            Change Password
                        </button>
                    </div>

                    <div className="border-t border-gray-50 mt-8 pt-8 space-y-4">
                        <a
                            href={`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"}/account/export`}
                            onClick={(e) => {
                                e.preventDefault();
                                api.get("/account/export", { responseType: "blob" })
                                    .then((res) => {
                                        const url = URL.createObjectURL(new Blob([res.data]));
                                        const a = document.createElement("a");
                                        a.href = url;
                                        a.download = "mindease-data.json";
                                        a.click();
                                        URL.revokeObjectURL(url);
                                    })
                                    .catch((err) => toast(getErrorMessage(err, "Failed to export data"), "error"));
                            }}
                            className="flex items-center gap-2 text-indigo-600 font-bold text-sm hover:text-indigo-800 transition-colors"
                        >
                            <Download className="w-4 h-4" /> Download my data (GDPR export)
                        </a>
                        <button
                            onClick={handleDeleteAccount}
                            className="flex items-center gap-2 text-rose-500 font-bold text-sm hover:text-rose-700 transition-colors"
                        >
                            <Trash2 className="w-4 h-4" /> Delete my account permanently
                        </button>
                    </div>
                </div>
            </motion.div>
        </DashboardLayout>
    );
}
