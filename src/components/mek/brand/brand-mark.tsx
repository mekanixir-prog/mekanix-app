"use client";
import { motion } from "framer-motion";

// MEKANIX brand mark — animated SVG.
// The "M" is drawn as two angled pillars (mechanical precision), with an
// amber diamond "locking" into the center as the kinetic focal point.
// No frame, no glow — the motion IS the brand statement.

export function BrandMark({
  size = 200,
  loop = true,
}: {
  size?: number;
  loop?: boolean;
}) {
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg viewBox="0 0 200 200" width={size} height={size} fill="none" className="block">
        {/* Left pillar of the M */}
        <motion.path
          d="M 52 38 L 100 86 L 100 162"
          stroke="currentColor"
          strokeWidth="14"
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={{ pathLength: 0, opacity: 0 }}
          animate={{ pathLength: 1, opacity: 1 }}
          transition={{ duration: 0.9, ease: [0.4, 0, 0.2, 1] }}
        />
        {/* Right pillar of the M */}
        <motion.path
          d="M 148 38 L 100 86 L 100 162"
          stroke="currentColor"
          strokeWidth="14"
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={{ pathLength: 0, opacity: 0 }}
          animate={{ pathLength: 1, opacity: 1 }}
          transition={{ duration: 0.9, delay: 0.15, ease: [0.4, 0, 0.2, 1] }}
        />
        {/* Central amber diamond — the kinetic focal point */}
        <motion.g
          initial={{ scale: 0, rotate: -90, opacity: 0 }}
          animate={{ scale: 1, rotate: 45, opacity: 1 }}
          transition={{ delay: 1.0, type: "spring", stiffness: 220, damping: 14 }}
          style={{ transformOrigin: "100px 86px" }}
        >
          {loop ? (
            <motion.rect
              x="88"
              y="74"
              width="24"
              height="24"
              rx="3"
              fill="var(--amber)"
              animate={{ rotate: [45, 405] }}
              transition={{ duration: 6, repeat: Infinity, ease: "linear" }}
              style={{ transformOrigin: "100px 86px" }}
            />
          ) : (
            <rect x="88" y="74" width="24" height="24" rx="3" fill="var(--amber)" transform="rotate(45 100 86)" />
          )}
        </motion.g>

        {/* Corner registration marks (technical / engineering feel) */}
        <motion.g
          stroke="var(--amber)"
          strokeWidth="1.5"
          strokeLinecap="round"
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.5 }}
          transition={{ delay: 1.4, duration: 0.6 }}
        >
          <path d="M 24 24 L 24 38 M 24 24 L 38 24" />
          <path d="M 176 24 L 176 38 M 176 24 L 162 24" />
          <path d="M 24 176 L 24 162 M 24 176 L 38 176" />
          <path d="M 176 176 L 176 162 M 176 176 L 162 176" />
        </motion.g>
      </svg>
    </div>
  );
}
