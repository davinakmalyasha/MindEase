"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import {
    Facebook,
    Instagram,
    Twitter,
    Linkedin,
    ArrowRight,
    Heart,
    Mail,
    Phone,
    MapPin
} from "lucide-react";

export default function Footer() {
    return (
        <footer className="w-full bg-gray-900 pt-24 pb-12 relative overflow-hidden">
            {/* Background Texture/Gradient */}
            <div className="absolute top-0 left-0 w-full h-full opacity-5 pointer-events-none">
                <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-indigo-500 rounded-full blur-[150px] -translate-y-1/2 translate-x-1/2"></div>
                <div className="absolute bottom-0 left-0 w-[500px] h-[500px] bg-purple-500 rounded-full blur-[150px] translate-y-1/2 -translate-x-1/2"></div>
            </div>

            <div className="max-w-7xl mx-auto px-4 md:px-8 relative z-10">
                {/* CTA Section Integrated into Footer */}
                <div className="bg-gradient-to-br from-indigo-600 to-indigo-800 rounded-[3rem] p-8 md:p-16 mb-24 flex flex-col md:flex-row items-center justify-between shadow-2xl shadow-indigo-900/40 relative overflow-hidden group">
                    <div className="absolute top-0 left-0 w-full h-full opacity-10 group-hover:opacity-20 transition-opacity duration-700">
                        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="w-full h-full">
                            <path d="M0 100 L100 0 L100 100 Z" fill="white" />
                        </svg>
                    </div>

                    <div className="text-center md:text-left mb-8 md:mb-0 relative z-10">
                        <span className="inline-flex items-center gap-2 bg-indigo-500/30 text-indigo-100 px-4 py-1.5 rounded-full text-xs font-bold uppercase tracking-widest mb-4 backdrop-blur-sm">
                            <Heart className="w-3 h-3 text-rose-300" /> Start Your Journey
                        </span>
                        <h2 className="text-3xl md:text-5xl font-black text-white font-outfit leading-tight mb-4">
                            Ready to improve your <br className="hidden md:block" /> mental well-being?
                        </h2>
                        <p className="text-indigo-100/70 font-medium max-w-md">
                            Join over 50,000+ users who are taking charge of their happiness today.
                        </p>
                    </div>

                    <div className="flex flex-col sm:flex-row gap-4 relative z-10">
                        <Link href="/appointments" className="px-10 py-5 bg-white text-indigo-600 rounded-[1.5rem] font-bold shadow-xl shadow-black/10 hover:shadow-2xl hover:bg-indigo-50 transition-all flex items-center justify-center gap-2 group/btn active:scale-95">
                            Consult Now <ArrowRight className="w-5 h-5 group-hover/btn:translate-x-1 transition-transform" />
                        </Link>
                        <button className="px-10 py-5 bg-indigo-500/20 text-white border border-indigo-400/30 rounded-[1.5rem] font-bold hover:bg-indigo-500/30 transition-all backdrop-blur-md active:scale-95">
                            View Specials
                        </button>
                    </div>
                </div>

                {/* Main Footer Content */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-12 mb-20">
                    <div className="space-y-6">
                        <Link href="/" className="flex items-center gap-2">
                            <div className="w-10 h-10 bg-indigo-500 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-500/30">
                                <Heart className="w-6 h-6 text-white" />
                            </div>
                            <span className="text-2xl font-black text-white font-outfit tracking-tighter">Mind<span className="text-indigo-400">Ease</span></span>
                        </Link>
                        <p className="text-gray-400 font-medium leading-relaxed">
                            Empowering individuals through professional psychological support and modern mental wellness tools.
                        </p>
                        <div className="flex gap-4">
                            {[Facebook, Instagram, Twitter, Linkedin].map((Icon, i) => (
                                <Link key={i} href="#" className="w-10 h-10 rounded-xl bg-gray-800 flex items-center justify-center text-gray-400 hover:bg-indigo-600 hover:text-white transition-all transform hover:-translate-y-1">
                                    <Icon className="w-5 h-5" />
                                </Link>
                            ))}
                        </div>
                    </div>

                    <div>
                        <h4 className="text-white font-bold mb-8 uppercase tracking-widest text-xs">Resources</h4>
                        <ul className="space-y-4">
                            {["Find Doctor", "Services", "Health Articles", "Mental Checkup", "Success Stories"].map((item) => (
                                <li key={item}>
                                    <Link href="#" className="text-gray-400 hover:text-indigo-400 transition-colors font-medium flex items-center gap-2 group">
                                        <div className="w-1 h-1 bg-gray-700 rounded-full group-hover:bg-indigo-400 transition-all"></div>
                                        {item}
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    </div>

                    <div>
                        <h4 className="text-white font-bold mb-8 uppercase tracking-widest text-xs">Company</h4>
                        <ul className="space-y-4">
                            {["About Us", "Contact", "Careers", "Privacy Policy", "Terms of Service"].map((item) => (
                                <li key={item}>
                                    <Link href="#" className="text-gray-400 hover:text-indigo-400 transition-colors font-medium flex items-center gap-2 group">
                                        <div className="w-1 h-1 bg-gray-700 rounded-full group-hover:bg-indigo-400 transition-all"></div>
                                        {item}
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    </div>

                    <div>
                        <h4 className="text-white font-bold mb-8 uppercase tracking-widest text-xs">Contact Us</h4>
                        <ul className="space-y-6">
                            {[
                                { icon: Mail, text: "support@mindease.id" },
                                { icon: Phone, text: "+62 812 3456 7890" },
                                { icon: MapPin, text: "Sudirman City, Jakarta CBD Area" }
                            ].map((item, i) => (
                                <li key={i} className="flex items-start gap-4">
                                    <div className="w-10 h-10 rounded-xl bg-gray-800 flex items-center justify-center shrink-0">
                                        <item.icon className="w-5 h-5 text-indigo-400" />
                                    </div>
                                    <span className="text-gray-400 font-medium pt-1 text-sm">{item.text}</span>
                                </li>
                            ))}
                        </ul>
                    </div>
                </div>

                <div className="pt-8 border-t border-gray-800 flex flex-col md:flex-row justify-between items-center gap-6">
                    <p className="text-gray-500 text-sm font-medium">
                        &copy; {new Date().getFullYear()} MindEase Platform. All rights reserved.
                    </p>
                    <div className="flex gap-8 text-xs font-bold text-gray-600 uppercase tracking-widest">
                        <Link href="#" className="hover:text-indigo-400 transition-colors">Privacy</Link>
                        <Link href="#" className="hover:text-indigo-400 transition-colors">Terms</Link>
                        <Link href="#" className="hover:text-indigo-400 transition-colors">Cookies</Link>
                    </div>
                </div>
            </div>
        </footer>
    );
}
