"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";

export default function Footer() {
    return (
        <section className="relative w-full py-24 overflow-hidden bg-white">
            {/* Decorative Blobs - Left Side */}
            <motion.div
                initial={{ opacity: 0, x: -100 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 1, type: "spring" }}
                className="absolute left-0 top-0 bottom-0 w-48 flex flex-col justify-center gap-4 -translate-x-1/3 pointer-events-none"
            >
                <div className="w-24 h-48 rounded-full bg-gradient-to-b from-indigo-400 via-purple-500 to-indigo-600"></div>
                <div className="w-32 h-40 rounded-full bg-gradient-to-br from-teal-200 to-emerald-300 -translate-y-4 translate-x-12"></div>
            </motion.div>

            {/* Decorative Blobs - Right Side */}
            <motion.div
                initial={{ opacity: 0, x: 100 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 1, type: "spring" }}
                className="absolute right-0 top-0 bottom-0 w-48 flex flex-col justify-center gap-4 translate-x-1/3 pointer-events-none"
            >
                <div className="w-32 h-40 rounded-full bg-gradient-to-br from-pink-200 via-pink-300 to-rose-300 translate-y-4"></div>
                <div className="w-24 h-48 rounded-full bg-gradient-to-b from-indigo-400 via-purple-500 to-indigo-600 translate-x-8"></div>
            </motion.div>

            {/* Center Content */}
            <motion.div
                initial={{ opacity: 0, y: 40 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.8 }}
                className="relative z-10 flex flex-col items-center justify-center text-center px-8"
            >
                <motion.p
                    initial={{ opacity: 0 }}
                    whileInView={{ opacity: 1 }}
                    transition={{ delay: 0.3 }}
                    className="text-indigo-600 text-sm mb-4 font-bold tracking-widest uppercase"
                >
                    Are you ready?
                </motion.p>
                <h2 className="text-4xl md:text-5xl font-bold text-gray-900 mb-6 max-w-2xl leading-tight">
                    To improving your mental well-being
                </h2>
                <p className="text-gray-500 text-lg max-w-xl mb-10 leading-relaxed">
                    Join Thousands of our User who already using Mind Ease to Improve their mental well-being
                </p>
                <div className="flex flex-wrap gap-4 justify-center">
                    <button className="bg-indigo-600 text-white px-10 py-4 rounded-full font-bold shadow-lg hover:bg-indigo-700 transition-all hover:scale-105 active:scale-95 shadow-indigo-200">
                        Consult Now
                    </button>
                    <button className="bg-white text-gray-900 px-10 py-4 rounded-full font-bold border-2 border-gray-100 hover:bg-gray-50 transition-all hover:scale-105 active:scale-95">
                        Lets Talk
                    </button>
                </div>
            </motion.div>
        </section>
    );
}
