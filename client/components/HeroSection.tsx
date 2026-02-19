"use client";

import { motion, Variants } from "framer-motion";
import Link from "next/link";
import NextImage from "next/image";
import { ArrowUpRight, PlayCircle } from "lucide-react";

export default function HeroSection() {
    const containerVariants: Variants = {
        hidden: { opacity: 0 },
        visible: {
            opacity: 1,
            transition: {
                staggerChildren: 0.2,
                delayChildren: 0.3,
            },
        },
    };

    const itemVariants: Variants = {
        hidden: { opacity: 0, y: 30 },
        visible: { opacity: 1, y: 0, transition: { duration: 0.8, ease: "easeOut" } },
    };

    const imageVariants: Variants = {
        hidden: { opacity: 0, scale: 0.9, x: 50 },
        visible: { opacity: 1, scale: 1, x: 0, transition: { duration: 1, ease: "easeOut" } },
    };

    return (
        <section className="relative w-full min-h-screen overflow-hidden bg-white flex items-center justify-center pt-20 pb-10">
            <div className="absolute top-0 left-0 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] rounded-full bg-gradient-to-br from-indigo-100 to-purple-100 blur-3xl opacity-60 pointer-events-none" />
            <div className="absolute bottom-0 right-0 translate-x-1/3 translate-y-1/3 w-[600px] h-[600px] rounded-full bg-gradient-to-tl from-teal-50 to-emerald-50 blur-3xl opacity-50 pointer-events-none" />

            <div className="w-[90%] mx-auto flex flex-col lg:flex-row items-center justify-between gap-16 lg:gap-24 relative z-10">

                <motion.div
                    className="flex-1 w-full max-w-xl text-center lg:text-left"
                    variants={containerVariants}
                    initial="hidden"
                    animate="visible"
                >
                    <motion.div variants={itemVariants} className="mb-4 inline-flex items-center gap-2 px-4 py-2 rounded-full bg-indigo-50 border border-indigo-100 mx-auto lg:mx-0">
                        <span className="relative flex h-2 w-2">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-500"></span>
                        </span>
                        <span className="text-xs font-semibold text-indigo-600 tracking-wide uppercase">AI-Powered Mental Health</span>
                    </motion.div>

                    <motion.h1
                        variants={itemVariants}
                        className="text-4xl md:text-5xl lg:text-7xl font-extrabold text-gray-900 leading-[1.1] mb-6 tracking-tight"
                    >
                        Find Your <br className="hidden lg:block" />
                        <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-500">
                            Inner Balance
                        </span>
                    </motion.h1>

                    <motion.p
                        variants={itemVariants}
                        className="text-lg md:text-xl text-gray-600 mb-8 max-w-lg mx-auto lg:mx-0 leading-relaxed"
                    >
                        Connect with certified professionals and track your mental well-being with our AI-driven insights. Your journey to clarity starts here.
                    </motion.p>

                    <motion.div variants={itemVariants} className="flex flex-col sm:flex-row items-center justify-center lg:justify-start gap-4">
                        <Link href="/explore">
                            <button className="group relative inline-flex items-center justify-center gap-2 px-8 py-4 text-base font-semibold text-white transition-all duration-300 bg-gray-900 rounded-full hover:bg-gray-800 hover:shadow-lg hover:shadow-indigo-500/20 active:scale-95">
                                Start Exploring
                                <ArrowUpRight className="w-5 h-5 transition-transform group-hover:translate-x-1 group-hover:-translate-y-1" />
                            </button>
                        </Link>

                        <Link href="/video">
                            <button className="inline-flex items-center justify-center gap-2 px-8 py-4 text-base font-semibold text-gray-700 transition-all duration-300 bg-white border border-gray-200 rounded-full hover:bg-gray-50 hover:text-gray-900 hover:border-gray-300 active:scale-95">
                                <PlayCircle className="w-5 h-5 text-gray-400" />
                                Watch Demo
                            </button>
                        </Link>
                    </motion.div>

                    <motion.div variants={itemVariants} className="mt-12 pt-8 border-t border-gray-100 flex items-center justify-center lg:justify-start gap-8 opacity-80">
                        <div className="text-center lg:text-left">
                            <p className="text-2xl font-bold text-gray-900">15k+</p>
                            <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">Users</p>
                        </div>
                        <div className="w-px h-10 bg-gray-200"></div>
                        <div className="text-center lg:text-left">
                            <p className="text-2xl font-bold text-gray-900">4.9/5</p>
                            <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">Rating</p>
                        </div>
                        <div className="w-px h-10 bg-gray-200"></div>
                        <div className="text-center lg:text-left">
                            <p className="text-2xl font-bold text-gray-900">24/7</p>
                            <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">Support</p>
                        </div>
                    </motion.div>

                </motion.div>

                <motion.div
                    className="flex-1 w-full relative max-w-lg flex items-center justify-center py-8"
                    variants={imageVariants}
                    initial="hidden"
                    animate="visible"
                >
                    <div className="relative z-10 w-full max-h-[65vh] aspect-[3/4] rounded-3xl overflow-hidden shadow-2xl shadow-indigo-500/20 border-4 border-white">
                        <img
                            src="ImgOrIcon/tengahHero.png"
                            alt="Mental Health Consultation"
                            className="w-full h-full object-cover transform hover:scale-105 transition-transform duration-700"
                        />
                        <div className="absolute inset-0 bg-gradient-to-t from-black/30 to-transparent pointer-events-none"></div>
                    </div>

                    <motion.div
                        className="absolute top-4 left-4 p-4 bg-white/90 backdrop-blur-md border border-white/50 rounded-2xl shadow-xl max-w-[180px] z-20 hidden md:block"
                        animate={{ y: [0, -10, 0] }}
                        transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
                    >
                        <div className="flex items-center gap-3 mb-2">
                            <div className="w-10 h-10 rounded-full bg-indigo-100 overflow-hidden relative">
                                <NextImage
                                    src="https://api.dicebear.com/7.x/avataaars/svg?seed=Felix"
                                    alt="Doctor"
                                    fill
                                    unoptimized
                                    className="object-contain"
                                />
                            </div>
                            <div>
                                <p className="text-sm font-bold text-gray-900">Dr. Sarah</p>
                                <p className="text-xs text-green-600 font-medium">Online Now</p>
                            </div>
                        </div>
                        <div className="flex gap-1">
                            {[1, 2, 3, 4, 5].map(i => (
                                <svg key={i} className="w-3 h-3 text-amber-400 fill-current" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"></path></svg>
                            ))}
                        </div>
                    </motion.div>

                    <motion.div
                        className="absolute bottom-12 right-4 p-3 bg-white/90 backdrop-blur-md border border-white/50 rounded-2xl shadow-xl z-20 hidden md:flex items-center gap-3"
                        animate={{ y: [0, 15, 0] }}
                        transition={{ duration: 5, repeat: Infinity, ease: "easeInOut", delay: 1 }}
                    >
                        <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center text-green-600">
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                        </div>
                        <div>
                            <p className="text-xs text-gray-500 font-medium uppercase">Session</p>
                            <p className="text-sm font-bold text-gray-900">Completed</p>
                        </div>
                    </motion.div>

                </motion.div>

            </div>
        </section>
    );
}
