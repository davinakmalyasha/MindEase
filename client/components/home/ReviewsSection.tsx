"use client";

import TestimonialCard from "@/components/TestimonialCard";
import { TESTIMONIALS } from "@/lib/data";
import { motion } from "framer-motion";

export default function ReviewsSection() {
    return (
        <section className="py-32 w-full bg-slate-50 relative overflow-hidden">
            {/* Background Decorative Elements */}
            <div className="absolute top-0 left-0 w-full h-full pointer-events-none opacity-40">
                <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-indigo-100 rounded-full blur-[120px]"></div>
                <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-100 rounded-full blur-[120px]"></div>
            </div>

            <div className="max-w-7xl mx-auto px-4 md:px-8 relative z-10">
                <div className="text-center mb-20 space-y-4">
                    <motion.span
                        initial={{ opacity: 0, y: 10 }}
                        whileInView={{ opacity: 1, y: 0 }}
                        viewport={{ once: true }}
                        className="text-indigo-600 font-black tracking-[0.3em] uppercase text-xs"
                    >
                        Success Stories
                    </motion.span>
                    <motion.h2
                        initial={{ opacity: 0, y: 20 }}
                        whileInView={{ opacity: 1, y: 0 }}
                        viewport={{ once: true }}
                        transition={{ delay: 0.1 }}
                        className="text-4xl md:text-6xl font-black text-gray-900 font-outfit"
                    >
                        Our Customers <span className="text-indigo-600">Said</span>
                    </motion.h2>
                    <motion.p
                        initial={{ opacity: 0 }}
                        whileInView={{ opacity: 1 }}
                        viewport={{ once: true }}
                        transition={{ delay: 0.2 }}
                        className="text-gray-500 font-medium max-w-2xl mx-auto leading-relaxed"
                    >
                        Join thousands of individuals who have transformed their lives through professional support and community care.
                    </motion.p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                    {TESTIMONIALS.map((testimonial, idx) => (
                        <motion.div
                            key={testimonial.id}
                            initial={{ opacity: 0, y: 30 }}
                            whileInView={{ opacity: 1, y: 0 }}
                            viewport={{ once: true }}
                            transition={{ delay: idx * 0.1, duration: 0.5 }}
                            className="group"
                        >
                            <div className="h-full bg-white p-8 rounded-[2.5rem] border border-gray-100 shadow-xl shadow-indigo-500/5 hover:shadow-2xl hover:shadow-indigo-500/10 transition-all duration-500 hover:-translate-y-2 relative overflow-hidden">
                                {/* Floating Icon/Badge for premium feel */}
                                <div className="absolute -right-4 -top-4 w-24 h-24 bg-indigo-50 rounded-full opacity-30 group-hover:scale-150 transition-transform duration-700"></div>

                                <TestimonialCard
                                    quote={testimonial.quote}
                                    name={testimonial.name}
                                    role={testimonial.role}
                                    rating={testimonial.rating}
                                    avatarUrl={testimonial.avatarUrl}
                                />
                            </div>
                        </motion.div>
                    ))}
                </div>
            </div>
        </section>
    );
}
