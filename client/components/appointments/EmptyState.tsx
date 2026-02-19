"use client";

import { Calendar, Plus } from "lucide-react";
import Link from "next/link";
import { motion } from "framer-motion";

export default function EmptyState() {
    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center justify-center py-20 px-4 text-center"
        >
            <div className="w-24 h-24 bg-indigo-50 rounded-full flex items-center justify-center mb-6">
                <Calendar className="w-12 h-12 text-indigo-300" />
            </div>
            <h3 className="text-2xl font-bold text-gray-900 mb-2">No Appointments Yet</h3>
            <p className="text-gray-500 max-w-sm mb-8">
                It seems you haven't booked any consultations yet. Start your wellness journey today.
            </p>
            <Link
                href="/appointments"
                className="flex items-center gap-2 bg-indigo-600 text-white px-8 py-4 rounded-2xl font-bold hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-100 active:scale-95"
            >
                <Plus className="w-5 h-5" />
                Book Now
            </Link>
        </motion.div>
    );
}
