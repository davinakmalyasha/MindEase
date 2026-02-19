"use client";

import { useEffect, useState } from "react";
import { motion, useSpring, useMotionValue } from "framer-motion";

export default function InteractiveBlobs() {
    const mouseX = useMotionValue(0);
    const mouseY = useMotionValue(0);

    const springConfig = { damping: 50, stiffness: 50 };
    const x = useSpring(mouseX, springConfig);
    const y = useSpring(mouseY, springConfig);

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            // Calculate position relative to center for parallax feel
            const { innerWidth, innerHeight } = window;
            const centerX = innerWidth / 2;
            const centerY = innerHeight / 2;

            mouseX.set((e.clientX - centerX) / 25);
            mouseY.set((e.clientY - centerY) / 25);
        };

        window.addEventListener("mousemove", handleMouseMove);
        return () => window.removeEventListener("mousemove", handleMouseMove);
    }, [mouseX, mouseY]);

    return (
        <div className="fixed inset-0 pointer-events-none overflow-hidden z-0 opacity-40">
            <motion.div
                style={{ x, y }}
                className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] rounded-full bg-gradient-to-br from-indigo-200/40 to-purple-200/40 blur-[100px]"
            />
            <motion.div
                style={{ x: useSpring(mouseX, { damping: 40 }), y: useSpring(mouseY, { damping: 40 }) }}
                className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] rounded-full bg-gradient-to-tr from-teal-100/30 to-emerald-100/30 blur-[120px]"
                animate={{
                    x: [0, 20, 0],
                    y: [0, -30, 0],
                }}
                transition={{
                    duration: 10,
                    repeat: Infinity,
                    ease: "easeInOut"
                }}
            />
        </div>
    );
}
