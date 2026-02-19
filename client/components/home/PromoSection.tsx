"use client";

import Link from "next/link";
import Image from "next/image";
import { ArrowUpRight } from "lucide-react";
import { motion } from "framer-motion";

const PROMO_ITEMS = [
    {
        title: "Telepathy Platforms",
        image: "https://images.unsplash.com/photo-1573497019940-1c28c88b4f3e?auto=format&fit=crop&q=80&w=800",
    },
    {
        title: "Mental Health Support",
        image: "https://images.unsplash.com/photo-1527137342181-19aab11a8ee1?auto=format&fit=crop&q=80&w=800",
    },
    {
        title: "Meditation & Yoga",
        image: "https://images.unsplash.com/photo-1506126613408-eca67ad4844b?auto=format&fit=crop&q=80&w=800",
    },
    {
        title: "Counseling Sessions",
        image: "https://images.unsplash.com/photo-1522202176988-66273c2fd55f?auto=format&fit=crop&q=80&w=800",
    },
];

export default function PromoSection() {
    return (
        <section className="w-full flex flex-col py-10">
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6 }}
                className="flex justify-between items-center mb-8 pr-[5%]"
            >
                <h1 className="text-2xl md:text-[28px] font-bold max-w-[600px] leading-snug">
                    Here&#39;s what you can do with our Mental health care services
                </h1>
                <Link
                    href="/doctors"
                    className="flex gap-2 justify-center items-center bg-gradient-to-r from-[#4837F2] to-[#8643FF] text-white rounded-[10px] px-7 py-2 hover:opacity-90 transition-opacity"
                >
                    Explore
                    <ArrowUpRight className="w-6 h-6" />
                </Link>
            </motion.div>

            <div className="w-full flex flex-wrap justify-between gap-y-5">
                {PROMO_ITEMS.map((item, index) => (
                    <motion.div
                        key={item.title}
                        initial={{ opacity: 0, scale: 0.95 }}
                        whileInView={{ opacity: 1, scale: 1 }}
                        viewport={{ once: true }}
                        transition={{ duration: 0.5, delay: index * 0.1 }}
                        whileHover={{ scale: 1.02 }}
                        className="relative w-full md:w-[49%] h-[140px] md:h-[120px] rounded-2xl overflow-hidden group cursor-pointer shadow-sm hover:shadow-md transition-shadow"
                    >
                        <Image
                            src={item.image}
                            alt={item.title}
                            fill
                            className="object-cover transition-transform duration-500 group-hover:scale-110"
                        />
                        <div className="absolute right-0 h-full w-[45%] bg-white/40 backdrop-blur-md flex justify-center items-center border-l border-white/20">
                            <h4 className="font-bold text-base md:text-lg text-gray-900 text-center px-2">
                                {item.title}
                            </h4>
                        </div>
                    </motion.div>
                ))}
            </div>
        </section>
    );
}
