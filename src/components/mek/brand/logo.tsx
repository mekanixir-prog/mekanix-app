"use client";
import { cn } from "@/lib/utils";
import { useTheme } from "@/components/mek/theme-provider";

export function Logo({
  className,
  withWordmark = true,
  size = 44,
  forceInvert = false,
}: {
  className?: string;
  withWordmark?: boolean;
  size?: number;
  forceInvert?: boolean;
}) {
  const { resolvedTheme } = useTheme();
  const isDark = forceInvert || resolvedTheme === "dark" || resolvedTheme === undefined;
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <img
        src="/logo.webp"
        alt="MEKANIX"
        className="shrink-0 select-none object-contain"
        style={{
          height: size,
          width: "auto",
          // Focus on the M mark (top portion of the logo)
          objectPosition: "center 20%",
          // In dark mode: invert black to white so logo is visible on dark bg
          // Keep it simple — just invert, no hue-rotate which distorts colors
          filter: isDark ? "invert(1) hue-rotate(180deg) brightness(1.1)" : "none",
        }}
        onError={(e) => {
          (e.target as HTMLImageElement).src = "/logo.png";
          (e.target as HTMLImageElement).onerror = null;
        }}
      />
      {withWordmark && <span className="sr-only">MEKANIX Field Repair Ops</span>}
    </div>
  );
}

export function LogoMark({ size = 44, className, forceInvert = false }: { size?: number; className?: string; forceInvert?: boolean }) {
  return <Logo withWordmark={false} size={size} className={className} forceInvert={forceInvert} />;
}
