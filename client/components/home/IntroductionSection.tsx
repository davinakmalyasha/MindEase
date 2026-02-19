"use client";

import Image from "next/image";
import { motion } from "framer-motion";

export default function IntroductionSection() {
    return (
        <section className="w-full md:w-[80%] flex flex-col justify-center items-center py-24 mx-auto overflow-hidden">
            <motion.h1
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.8, ease: "easeOut" }}
                className="text-4xl md:text-[70px] font-bold mb-16 text-center leading-tight tracking-tight"
            >
                What&#39;s MindEase?
            </motion.h1>

            <div className="flex flex-col md:flex-row justify-between items-center gap-16 w-full">
                <motion.div
                    initial={{ opacity: 0, x: -50 }}
                    whileInView={{ opacity: 1, x: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.8, delay: 0.2 }}
                    className="relative w-full md:w-1/2 aspect-square rounded-3xl overflow-hidden shadow-2xl"
                >
                    <Image
                        src="/ImgOrIcon/kananHero.png"
                        alt="MindEase Introduction"
                        fill
                        className="object-cover hover:scale-105 transition-transform duration-700"
                    />
                </motion.div>

                <motion.h4
                    initial={{ opacity: 0, x: 50 }}
                    whileInView={{ opacity: 1, x: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.8, delay: 0.4 }}
                    className="w-full md:w-[45%] text-xl md:text-2xl font-medium leading-relaxed text-gray-600 font-sans"
                >
                    A bridge for those seeking to consult their mental health with qualified psychologists and experts.
                    <br /><br />
                    We connect you to professional support for a better understanding of your mental well-being, fostering a safer space for your journey.
                </motion.h4>
            </div>
        </section>
    );
}
