"use client";

import { Star } from "lucide-react";
import { motion } from "framer-motion";
import Image from "next/image";

interface Review {
    id: number;
    name: string;
    avatar: string;
    rating: number;
    date: string;
    comment: string;
}

export default function ReviewCard({ review }: { review: Review }) {
    return (
        <motion.div
            initial={{ opacity: 0, y: 10 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="p-6 bg-white rounded-3xl border border-gray-100 shadow-sm hover:shadow-md transition-shadow"
        >
            <div className="flex justify-between items-start mb-4">
                <div className="flex gap-3 items-center">
                    <div className="relative w-10 h-10 rounded-full overflow-hidden bg-gray-100">
                        <Image
                            src={review.avatar}
                            alt={review.name}
                            fill
                            className="object-cover"
                        />
                    </div>
                    <div>
                        <h4 className="font-bold text-gray-900 text-sm">{review.name}</h4>
                        <p className="text-gray-400 text-[10px] font-medium uppercase tracking-wider">{review.date}</p>
                    </div>
                </div>
                <div className="flex items-center gap-1 bg-amber-50 px-2 py-1 rounded-lg">
                    <Star className="w-3 h-3 text-amber-500 fill-amber-500" />
                    <span className="text-xs font-bold text-amber-700">{review.rating}</span>
                </div>
            </div>
            <p className="text-gray-600 text-sm leading-relaxed italic">
                "{review.comment}"
            </p>
        </motion.div>
    );
}
