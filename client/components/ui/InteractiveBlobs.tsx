"use client";

import { useEffect, useState } from "react";
import { motion, useSpring, useMotionValue, useReducedMotion } from "framer-motion";

/**
 * Decorative parallax background.
 *
 * This is the app's one *perpetual* animation — the lower blob drifts on a
 * endless 10-second loop — which makes it the most likely trigger for motion
 * sensitivity even though the global `prefers-reduced-motion` rule hides it
 * visually. `useReducedMotion` is used here on top of that rule because the CSS
 * override can only flatten the rendered frame; it cannot stop the JavaScript
 * loop, which would keep running (and re-triggering style writes) for every
 * visitor regardless. Stopping it at the source also removes the parallax
 * mouse listener's work entirely.
 */
export default function InteractiveBlobs() {
    const reduceMotion = useReducedMotion();
    const mouseX = useMotionValue(0);
    const mouseY = useMotionValue(0);

    const springConfig = { damping: 50, stiffness: 50 };
    const x = useSpring(mouseX, springConfig);
    const y = useSpring(mouseY, springConfig);

    useEffect(() => {
        if (reduceMotion) return;
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
    }, [mouseX, mouseY, reduceMotion]);

    return (
        // Purely decorative: no semantics, no interaction, nothing to announce.
        <div aria-hidden="true" className="fixed inset-0 pointer-events-none overflow-hidden z-0 opacity-40">
            <motion.div
                style={{ x, y }}
                className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] rounded-full bg-gradient-to-br from-indigo-200/40 to-purple-200/40 blur-[100px]"
            />
            <motion.div
                style={{ x: useSpring(mouseX, { damping: 40 }), y: useSpring(mouseY, { damping: 40 }) }}
                className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] rounded-full bg-gradient-to-tr from-teal-100/30 to-emerald-100/30 blur-[120px]"
                animate={
                    reduceMotion
                        ? undefined
                        : {
                              x: [0, 20, 0],
                              y: [0, -30, 0],
                          }
                }
                transition={
                    reduceMotion
                        ? undefined
                        : {
                              duration: 10,
                              repeat: Infinity,
                              ease: "easeInOut",
                          }
                }
            />
        </div>
    );
}
