import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// MEKANIX — Next.js 16 Proxy (formerly `middleware.ts`)
//
// Next.js 16 renamed the `middleware.ts` convention to `proxy.ts`.
// The exported handler must be named `proxy` (or use a default export).
// See: node_modules/next/dist/build/templates/middleware.js
//   const handlerUserland = (isProxy ? mod.proxy : mod.middleware) || mod.default;
//
// Everything else (config.matcher, request shape, NextResponse API) is
// unchanged from the previous middleware convention.

const SESSION_COOKIE_NAMES = new Set(["mekanix-token", "mekanix_admin_session"]);

function hasBrowserSessionCookie(req: Request): boolean {
  const cookie = req.headers.get("cookie");
  if (!cookie) return false;
  return cookie.split(";").some((part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return false;
    return SESSION_COOKIE_NAMES.has(part.slice(0, separator).trim());
  });
}

function isSameOriginMutation(req: Request): boolean {
  let requestOrigin: string;
  try {
    requestOrigin = new URL(req.url).origin;
  } catch {
    return false;
  }

  const origin = req.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).origin !== requestOrigin) return false;
    } catch {
      return false;
    }
  } else if (req.headers.get("sec-fetch-site") !== "same-origin") {
    return false;
  }

  const fetchSite = req.headers.get("sec-fetch-site");
  return !fetchSite || fetchSite === "same-origin";
}

export function proxy(req: NextRequest) {
  // Central CSRF defense for every browser-cookie-authenticated API mutation.
  // Bearer-only native/API clients are not affected because browsers do not
  // attach Authorization headers cross-site automatically.
  const method = req.method.toUpperCase();
  const isUnsafeMethod = !["GET", "HEAD", "OPTIONS"].includes(method);
  if (
    isUnsafeMethod &&
    hasBrowserSessionCookie(req) &&
    !isSameOriginMutation(req)
  ) {
    return NextResponse.json(
      { error: "درخواست از مبدأ نامعتبر است" },
      { status: 403 },
    );
  }

  const res = NextResponse.next();

  // Security headers — permissive for preview panel iframe
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(self)");

  if (process.env.NODE_ENV === "production") {
    res.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  }
  // Restrict production embedding to our own origin and the known preview
  // gateway. A wildcard frame-ancestors policy allows arbitrary sites to
  // frame authenticated pages and creates a clickjacking surface.
  const isProduction = process.env.NODE_ENV === "production";
  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    isProduction
      ? "script-src 'self' 'unsafe-inline' https://cdn.socket.io"
      : "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.socket.io",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    isProduction
      ? "img-src 'self' data: blob: https:"
      : "img-src 'self' data: blob: https: http:",
    isProduction
      ? "connect-src 'self' wss: https:"
      : "connect-src 'self' ws: wss: https: http:",
    "worker-src 'self' blob:",
    isProduction
      ? "frame-ancestors 'self' https://*.space-z.ai"
      : "frame-ancestors 'self' https://*.space-z.ai http://localhost:* http://127.0.0.1:*",
  ].join("; ");
  res.headers.set("Content-Security-Policy", csp);

  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
