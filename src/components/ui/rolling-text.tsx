"use client";

import { useRef, useState } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";

gsap.registerPlugin(useGSAP);

const LINE_HEIGHT = 0.8;
const FONT_FAMILY = "Helvetica Neue, Arial Narrow, system-ui, sans-serif";

interface RollingTextProps {
  text?: string;
  textColor?: string;
  minCycles?: number;
  cycleVariance?: number;
  duration?: number;
  durationVariance?: number;
  /** Trigger animation on hover */
  hoverToRoll?: boolean;
}

const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

type Reel = { copies: number; to: number; duration: number };
type ReelConfig = {
  minCycles: number;
  cycleVariance: number;
  duration: number;
  durationVariance: number;
};

const buildReel = (charIndex: number, config: ReelConfig): Reel => {
  const rand = mulberry32(charIndex * 1013 + 7);
  const cycles = config.minCycles + Math.floor(rand() * config.cycleVariance);
  return {
    copies: cycles + 1,
    to: cycles,
    duration: config.duration + rand() * config.durationVariance,
  };
};

const RollingText = ({
  text = "MEKANIX",
  textColor,
  minCycles = 3,
  cycleVariance = 3,
  duration = 2.4,
  durationVariance = 1.2,
  hoverToRoll = true,
}: RollingTextProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hasAnimated, setHasAnimated] = useState(false);

  const playAnimation = () => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const reels = gsap.utils.toArray<HTMLElement>("[data-reel]", containerRef.current);

    if (reduced) {
      reels.forEach((reel) => {
        reel.style.setProperty("--k", reel.dataset.to ?? "0");
      });
      return;
    }

    reels.forEach((reel) => {
      const to = Number(reel.dataset.to);
      const scroll = { k: 0 };
      reel.style.setProperty("--k", "0");

      gsap.to(scroll, {
        k: to,
        duration: Number(reel.dataset.duration),
        ease: "expo.out",
        onUpdate: () => reel.style.setProperty("--k", String(scroll.k)),
      });
    });
  };

  // Initial animation on mount
  useGSAP(
    () => {
      playAnimation();
      setHasAnimated(true);
    },
    {
      scope: containerRef,
      dependencies: [minCycles, cycleVariance, duration, durationVariance],
    },
  );

  const handleMouseEnter = () => {
    if (!hoverToRoll) return;
    playAnimation();
  };

  return (
    <div
      ref={containerRef}
      onMouseEnter={handleMouseEnter}
      className="relative grid place-items-center cursor-default"
    >
      <h3
        aria-label={text}
        style={{ ...(textColor ? { color: textColor } : {}), fontFamily: FONT_FAMILY }}
        className={`relative z-10 m-0 text-9xl max-[1025px]:text-6xl max-md:text-5xl font-light! leading-[0.8]! tracking-[0.02em] whitespace-nowrap select-none ${textColor ? "" : "text-foreground"}`}
      >
        {text.split("").map((char, charIndex) => {
          if (char === " ") {
            return (
              <span key={charIndex} className="inline-block" aria-hidden>
                &nbsp;
              </span>
            );
          }

          const reel = buildReel(charIndex, { minCycles, cycleVariance, duration, durationVariance });

          return (
            <span
              key={charIndex}
              className="relative inline-block align-top"
              aria-hidden
            >
              <span className="block invisible">{char}</span>

              <span className="absolute inset-0 overflow-hidden">
                <span
                  data-reel=""
                  data-to={reel.to}
                  data-duration={reel.duration}
                  className="block will-change-transform [transform:translate3d(0,calc(-1em*0.8*var(--k,0)),0)]"
                >
                  {Array.from({ length: reel.copies }, (_, copy) => (
                    <span key={copy} className="block w-full h-[0.8em] text-center">
                      {char}
                    </span>
                  ))}
                </span>
              </span>
            </span>
          );
        })}
      </h3>
    </div>
  );
};

export default RollingText;
