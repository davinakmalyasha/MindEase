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
} from "lucide-react";
import { cn } from "@/lib/utils";
import DashboardLayout from "@/components/layout/DashboardLayout";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/components/ui/Toast";

export default function ProfilePage() {
    const { user, setUser, logout } = useAuth();
    const { toast } = useToast();
    const fileInputRef = useRef<HTMLInputElement>(null);

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

                if (data.role === "doctor") {
                    setBio(doctorProfile?.bio || "");
                    setSpecialization(doctorProfile?.specialty || "");
                    setFee(doctorProfile?.price || "");
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

    const handleChangePassword = async () => {
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
        if (!confirm("This will permanently delete your account and all your data. Continue?")) return;
        if (!confirm("Are you absolutely sure? This cannot be undone.")) return;
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

                    <div className="border-t border-gray-50 mt-8 pt-8">
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
