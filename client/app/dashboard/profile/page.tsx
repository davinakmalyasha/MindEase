"use client";

import { useState, useEffect, useRef } from "react";
import api from "@/lib/api";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
    Camera,
    ChevronLeft,
    User,
    Phone,
    Mail,
    Stethoscope,
    DollarSign,
    FileText,
    Save,
    X,
    Loader2,
    CheckCircle2,
    AlertCircle
} from "lucide-react";
import { cn } from "@/lib/utils";

interface UserData {
    id: number;
    name: string;
    email: string;
    phone_number: string;
    role: "user" | "doctor" | "admin";
    avatar: string;
    bio?: string;
    specialization?: string;
    consultation_fee?: number;
}

export default function ProfilePage() {
    const router = useRouter();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [user, setUser] = useState<UserData | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

    // Form states
    const [name, setName] = useState("");
    const [phone, setPhone] = useState("");
    const [bio, setBio] = useState("");
    const [specialization, setSpecialization] = useState("");
    const [fee, setFee] = useState<string | number>("");
    const [file, setFile] = useState<File | null>(null);
    const [preview, setPreview] = useState("");

    useEffect(() => {
        const fetchProfile = async () => {
            try {
                const res = await api.get("/users/profile");
                const data = res.data;
                setUser(data);

                setName(data.name || "");
                setPhone(data.phone_number || "");
                setPreview(data.avatar);

                if (data.role === "doctor") {
                    setBio(data.bio || "");
                    setSpecialization(data.specialization || "");
                    setFee(data.consultation_fee || "");
                }
            } catch (err) {
                console.error(err);
                setMessage({ type: 'error', text: "Gagal mengambil data profil" });
            } finally {
                setIsLoading(false);
            }
        };

        fetchProfile();
    }, []);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const selectedFile = e.target.files?.[0];
        if (selectedFile) {
            setFile(selectedFile);
            setPreview(URL.createObjectURL(selectedFile));
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!user) return;

        setIsSaving(true);
        setMessage(null);

        const formData = new FormData();
        formData.append("name", name);
        formData.append("phone_number", phone);
        if (file) formData.append("avatar", file);

        if (user.role === "doctor") {
            formData.append("bio", bio);
            formData.append("specialization", specialization);
            formData.append("consultation_fee", String(fee));
        }

        try {
            const res = await api.put("/users/profile", formData, {
                headers: {
                    "Content-Type": "multipart/form-data",
                },
            });

            setMessage({ type: 'success', text: "Profil berhasil diperbarui!" });

            // Update local storage
            const localUserStr = localStorage.getItem("user");
            if (localUserStr) {
                const updatedUser = {
                    ...JSON.parse(localUserStr),
                    ...res.data.user,
                };
                localStorage.setItem("user", JSON.stringify(updatedUser));
            }

            // Reload to sync state across app
            setTimeout(() => {
                window.location.reload();
            }, 1500);
        } catch (err: any) {
            console.error(err);
            setMessage({
                type: 'error',
                text: "Gagal update: " + (err.response?.data?.message || "Terjadi kesalahan")
            });
        } finally {
            setIsSaving(false);
        }
    };

    if (isLoading) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-gray-50">
                <Loader2 className="w-10 h-10 text-indigo-600 animate-spin" />
            </div>
        );
    }

    return (
        <main className="min-h-screen bg-gray-50/50 pb-20 pt-10 px-4 md:px-8">
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="max-w-2xl mx-auto"
            >
                {/* Header */}
                <header className="flex items-center justify-between mb-8">
                    <button
                        onClick={() => router.back()}
                        className="p-2 hover:bg-white rounded-xl transition-all border border-transparent hover:border-gray-100 hover:shadow-sm group"
                    >
                        <ChevronLeft className="w-6 h-6 text-gray-400 group-hover:text-indigo-600 transition-colors" />
                    </button>
                    <h1 className="text-2xl font-bold text-gray-900">Edit Profile</h1>
                    <div className="w-10" /> {/* Spacer */}
                </header>

                <div className="bg-white rounded-[2.5rem] shadow-2xl shadow-indigo-500/5 border border-gray-100 p-8 md:p-12">
                    <form onSubmit={handleSubmit} className="space-y-10">

                        {/* Avatar Section */}
                        <div className="flex flex-col items-center gap-6">
                            <div className="relative group">
                                <div className="w-32 h-32 rounded-full overflow-hidden border-4 border-white shadow-xl ring-2 ring-indigo-50">
                                    <img
                                        src={preview && preview !== "default.jpg" ? preview : "https://api.dicebear.com/7.x/avataaars/svg?seed=placeholder"}
                                        alt="Profile Preview"
                                        className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110"
                                    />
                                </div>
                                <button
                                    type="button"
                                    onClick={() => fileInputRef.current?.click()}
                                    className="absolute bottom-0 right-0 p-2.5 bg-indigo-600 text-white rounded-full shadow-lg hover:bg-indigo-700 transition-all scale-90 hover:scale-100 active:scale-95 group-hover:animate-pulse"
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

                        {/* Notifications */}
                        <AnimatePresence>
                            {message && (
                                <motion.div
                                    initial={{ opacity: 0, height: 0 }}
                                    animate={{ opacity: 1, height: 'auto' }}
                                    exit={{ opacity: 0, height: 0 }}
                                    className={cn(
                                        "p-4 rounded-2xl flex items-center gap-3",
                                        message.type === 'success' ? "bg-emerald-50 text-emerald-700 border border-emerald-100" : "bg-rose-50 text-rose-700 border border-rose-100"
                                    )}
                                >
                                    {message.type === 'success' ? <CheckCircle2 className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
                                    <p className="text-sm font-bold">{message.text}</p>
                                </motion.div>
                            )}
                        </AnimatePresence>

                        {/* General Info Section */}
                        <div className="space-y-6">
                            <div className="flex items-center gap-3 mb-2">
                                <div className="p-2 bg-indigo-50 rounded-lg">
                                    <User className="w-4 h-4 text-indigo-600" />
                                </div>
                                <h3 className="font-bold text-gray-900">General Information</h3>
                            </div>

                            <div className="grid grid-cols-1 gap-6">
                                {/* Name Input */}
                                <div className="space-y-2">
                                    <label className="text-xs font-bold text-gray-400 uppercase tracking-widest ml-1">Full Name</label>
                                    <input
                                        type="text"
                                        value={name}
                                        onChange={(e) => setName(e.target.value)}
                                        required
                                        placeholder="John Doe"
                                        className="w-full px-6 py-4 bg-gray-50 border border-gray-100 rounded-2xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all font-medium text-gray-900 placeholder:text-gray-300"
                                    />
                                </div>

                                {/* Email Display (Read-Only) */}
                                <div className="space-y-2 opacity-60">
                                    <label className="text-xs font-bold text-gray-400 uppercase tracking-widest ml-1 flex items-center gap-2">
                                        Email Address <span className="text-[10px] bg-gray-100 px-2 py-0.5 rounded-full">Read Only</span>
                                    </label>
                                    <div className="w-full px-6 py-4 bg-gray-100 border border-gray-200 rounded-2xl flex items-center gap-3 cursor-not-allowed">
                                        <Mail className="w-5 h-5 text-gray-400" />
                                        <span className="font-medium text-gray-500">{user?.email}</span>
                                    </div>
                                </div>

                                {/* WhatsApp Input */}
                                <div className="space-y-2">
                                    <label className="text-xs font-bold text-gray-400 uppercase tracking-widest ml-1">WhatsApp Number</label>
                                    <div className="relative">
                                        <Phone className="absolute left-6 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                                        <input
                                            type="tel"
                                            value={phone}
                                            onChange={(e) => setPhone(e.target.value)}
                                            required
                                            placeholder="08123456789"
                                            className="w-full pl-14 pr-6 py-4 bg-gray-50 border border-gray-100 rounded-2xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all font-medium text-gray-900 placeholder:text-gray-300"
                                        />
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Doctor Specific Section */}
                        {user?.role === "doctor" && (
                            <motion.div
                                initial={{ opacity: 0, x: -20 }}
                                animate={{ opacity: 1, x: 0 }}
                                transition={{ delay: 0.2 }}
                                className="space-y-6 pt-6 border-t border-gray-50"
                            >
                                <div className="flex items-center gap-3 mb-2">
                                    <div className="p-2 bg-purple-50 rounded-lg">
                                        <Stethoscope className="w-4 h-4 text-purple-600" />
                                    </div>
                                    <h3 className="font-bold text-gray-900">Doctor Profile Details</h3>
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                    <div className="space-y-2">
                                        <label className="text-xs font-bold text-gray-400 uppercase tracking-widest ml-1">Specialization</label>
                                        <input
                                            type="text"
                                            value={specialization}
                                            onChange={(e) => setSpecialization(e.target.value)}
                                            placeholder="e.g. Clinical Psychologist"
                                            className="w-full px-6 py-4 bg-gray-50 border border-gray-100 rounded-2xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all font-medium text-gray-900"
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-xs font-bold text-gray-400 uppercase tracking-widest ml-1">Consultation Fee</label>
                                        <div className="relative">
                                            <span className="absolute left-6 top-1/2 -translate-y-1/2 font-bold text-gray-400">Rp</span>
                                            <input
                                                type="number"
                                                value={fee}
                                                onChange={(e) => setFee(e.target.value)}
                                                placeholder="150000"
                                                className="w-full pl-14 pr-6 py-4 bg-gray-50 border border-gray-100 rounded-2xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all font-medium text-gray-900"
                                            />
                                        </div>
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <label className="text-xs font-bold text-gray-400 uppercase tracking-widest ml-1 flex items-center gap-2">
                                        Professional Bio <FileText className="w-3 h-3" />
                                    </label>
                                    <textarea
                                        value={bio}
                                        onChange={(e) => setBio(e.target.value)}
                                        rows={4}
                                        placeholder="Write a brief professional biography..."
                                        className="w-full px-6 py-4 bg-gray-50 border border-gray-100 rounded-2xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all font-medium text-gray-900 resize-none"
                                    />
                                </div>
                            </motion.div>
                        )}

                        {/* Action Buttons */}
                        <div className="flex flex-col md:flex-row items-center gap-4 pt-4">
                            <button
                                type="submit"
                                disabled={isSaving}
                                className="w-full md:flex-1 h-14 bg-indigo-600 text-white rounded-2xl font-bold flex items-center justify-center gap-2 hover:bg-indigo-700 transition-all active:scale-95 shadow-xl shadow-indigo-200 disabled:opacity-70 disabled:cursor-not-allowed"
                            >
                                {isSaving ? (
                                    <>
                                        <Loader2 className="w-5 h-5 animate-spin" />
                                        Saving Changes...
                                    </>
                                ) : (
                                    <>
                                        <Save className="w-5 h-5" />
                                        Save Profile Changes
                                    </>
                                )}
                            </button>
                            <button
                                type="button"
                                onClick={() => router.back()}
                                className="w-full md:w-auto px-10 h-14 bg-gray-100 text-gray-500 rounded-2xl font-bold hover:bg-gray-200 transition-all active:scale-95"
                            >
                                Cancel
                            </button>
                        </div>
                    </form>
                </div>
            </motion.div>
        </main>
    );
}
