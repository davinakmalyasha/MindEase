"use client";

import TestimonialCard from "@/components/TestimonialCard";
import { TESTIMONIALS } from "@/lib/data";
import { motion } from "framer-motion";

const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
        opacity: 1,
        transition: {
            staggerChildren: 0.2
        }
    }
};

const itemVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.6 } }
};

export default function ReviewsSection() {
    return (
        <section className="py-24 w-full overflow-hidden">
            <div className="w-full">
                <motion.h2
                    initial={{ opacity: 0, y: -20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    className="text-3xl md:text-5xl font-bold italic text-center text-gray-900 mb-16 font-serif"
                >
                    Our Customers Said
                </motion.h2>

                <motion.div
                    variants={containerVariants}
                    initial="hidden"
                    whileInView="visible"
                    viewport={{ once: true }}
                    className="space-y-8"
                >
                    {/* Row 1 - 2 cards */}
                    <motion.div className="flex flex-wrap justify-center gap-8">
                        {TESTIMONIALS.slice(0, 2).map((testimonial) => (
                            <motion.div key={testimonial.id} variants={itemVariants}>
                                <TestimonialCard
                                    quote={testimonial.quote}
                                    name={testimonial.name}
                                    role={testimonial.role}
                                    rating={testimonial.rating}
                                    avatarUrl={testimonial.avatarUrl}
                                />
                            </motion.div>
                        ))}
                    </motion.div>

                    {/* Row 2 - 3 cards */}
                    <motion.div className="flex flex-wrap justify-center gap-8">
                        {TESTIMONIALS.slice(2, 5).map((testimonial) => (
                            <motion.div key={testimonial.id} variants={itemVariants}>
                                <TestimonialCard
                                    quote={testimonial.quote}
                                    name={testimonial.name}
                                    role={testimonial.role}
                                    rating={testimonial.rating}
                                    avatarUrl={testimonial.avatarUrl}
                                />
                            </motion.div>
                        ))}
                    </motion.div>

                    {/* Row 3 - 2 cards */}
                    <motion.div className="flex flex-wrap justify-center gap-8">
                        {TESTIMONIALS.slice(5, 7).map((testimonial) => (
                            <motion.div key={testimonial.id} variants={itemVariants}>
                                <TestimonialCard
                                    quote={testimonial.quote}
                                    name={testimonial.name}
                                    role={testimonial.role}
                                    rating={testimonial.rating}
                                    avatarUrl={testimonial.avatarUrl}
                                />
                            </motion.div>
                        ))}
                    </motion.div>
                </motion.div>
            </div>
        </section>
    );
}
