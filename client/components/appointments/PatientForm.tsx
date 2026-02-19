"use client";

import { motion } from "framer-motion";
import { User, MessageSquare, Video, Mic, MessageCircle } from "lucide-react";
import { cn } from "@/lib/utils";

interface PatientFormProps {
    patientInfo: {
        name: string;
        notes: string;
        type: "video" | "voice" | "chat";
    };
    onChange: (info: any) => void;
}

export default function PatientForm({ patientInfo, onChange }: PatientFormProps) {
    const consultationTypes = [
        { id: "video", label: "Video Call", icon: Video, color: "text-indigo-600", bg: "bg-indigo-50" },
        { id: "voice", label: "Voice Call", icon: Mic, color: "text-purple-600", bg: "bg-purple-50" },
        { id: "chat", label: "Live Chat", icon: MessageCircle, color: "text-teal-600", bg: "bg-teal-50" },
    ];

    return (
        <div className="space-y-8">
            {/* Consultation Type */}
            <div className="space-y-4">
                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest ml-1">
                    Consultation Type
                </label>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {consultationTypes.map((type) => {
                        const Icon = type.icon;
                        const isSelected = patientInfo.type === type.id;

                        return (
                            <motion.button
                                key={type.id}
                                whileHover={{ y: -2 }}
                                whileTap={{ scale: 0.98 }}
                                onClick={() => onChange({ ...patientInfo, type: type.id })}
                                className={cn(
                                    "p-4 rounded-[1.5rem] border-2 flex flex-col items-center gap-2 transition-all",
                                    isSelected
                                        ? "bg-indigo-600 border-indigo-600 text-white shadow-xl shadow-indigo-100"
                                        : "bg-white border-gray-50 text-gray-600 hover:border-indigo-100 hover:bg-gray-50"
                                )}
                            >
                                <Icon className={cn("w-6 h-6", isSelected ? "text-white" : type.color)} />
                                <span className="font-bold text-sm tracking-wide">{type.label}</span>
                            </motion.button>
                        );
                    })}
                </div>
            </div>

            {/* Patient Name */}
            <div className="space-y-2">
                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest ml-1 flex items-center gap-2">
                    <User className="w-3.5 h-3.5" /> Patient Full Name
                </label>
                <input
                    type="text"
                    value={patientInfo.name}
                    onChange={(e) => onChange({ ...patientInfo, name: e.target.value })}
                    required
                    placeholder="Enter full name..."
                    className="w-full px-6 py-4 bg-gray-50 border border-gray-100 rounded-2xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-50 font-medium text-gray-900 placeholder:text-gray-300 transition-all"
                />
            </div>

            {/* Notes */}
            <div className="space-y-2">
                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest ml-1 flex items-center gap-2">
                    <MessageSquare className="w-3.5 h-3.5" /> Additional Notes (Optional)
                </label>
                <textarea
                    rows={4}
                    value={patientInfo.notes}
                    onChange={(e) => onChange({ ...patientInfo, notes: e.target.value })}
                    placeholder="Briefly describe your situation or any questions..."
                    className="w-full px-6 py-4 bg-gray-50 border border-gray-100 rounded-2xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-50 font-medium text-gray-900 placeholder:text-gray-300 transition-all resize-none"
                />
            </div>
        </div>
    );
}
