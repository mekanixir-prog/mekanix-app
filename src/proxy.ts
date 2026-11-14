import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Next.js Proxy is an early request filter, not the authorization boundary.
// Route handlers continue to enforce authentication and resource ownership.
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

function buildContentSecurityPolicy(nonce: string, isProduction: boolean): string {
  const allowPreviewEmbedding =
    isProduction && process.env.MEKANIX_ALLOW_PREVIEW_EMBEDDING === "true";
  const frameAncestors = isProduction
    ? `frame-ancestors 'self'${allowPreviewEmbedding ? " https://*.space-z.ai" : ""}`
    : "frame-ancestors 'self' https://*.space-z.ai http://localhost:* http://127.0.0.1:*";

  // External origins are explicitly allowlisted from actual client-side use:
  // OSM map tiles, seeded/approved profile avatars, and Nominatim search.
  // ETA providers are server-side and do not belong in the browser CSP.
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    isProduction
      ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`
      : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "font-src 'self' data:",
    isProduction
      ? "img-src 'self' data: blob: https://a.tile.openstreetmap.org https://b.tile.openstreetmap.org https://c.tile.openstreetmap.org https://i.pravatar.cc"
      : "img-src 'self' data: blob: http: https://a.tile.openstreetmap.org https://b.tile.openstreetmap.org https://c.tile.openstreetmap.org https://i.pravatar.cc",
    isProduction
      ? "connect-src 'self' wss: https://nominatim.openstreetmap.org"
      : "connect-src 'self' ws: wss: http: https://nominatim.openstreetmap.org",
    "worker-src 'self' blob:",
    frameAncestors,
  ].join("; ");
}

function applySecurityHeaders(
  response: NextResponse,
  contentSecurityPolicy: string,
  isProduction: boolean,
): NextResponse {
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(self)");
  if (isProduction) {
    response.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  }
  response.headers.set("Content-Security-Policy", contentSecurityPolicy);
  return response;
}

export function proxy(req: NextRequest) {
  const isProduction = process.env.NODE_ENV === "production";
  const isApiRequest = req.nextUrl.pathname.startsWith("/api/");

  // Nonce-based CSP is applied to rendered document requests. The CSP request
  // header is forwarded so Next.js can attach the nonce to framework scripts
  // and inline styles during SSR. API responses do not render executable HTML.
  const nonce = isApiRequest ? null : btoa(crypto.randomUUID());
  const contentSecurityPolicy = nonce
    ? buildContentSecurityPolicy(nonce, isProduction)
    : "default-src 'none'; frame-ancestors 'none'";

  const method = req.method.toUpperCase();
  const isUnsafeMethod = !["GET", "HEAD", "OPTIONS"].includes(method);
  if (
    isUnsafeMethod &&
    hasBrowserSessionCookie(req) &&
    !isSameOriginMutation(req)
  ) {
    return applySecurityHeaders(
      NextResponse.json(
        { error: "درخواست از مبدأ نامعتبر است" },
        { status: 403 },
      ),
      contentSecurityPolicy,
      isProduction,
    );
  }

  let response: NextResponse;
  if (nonce) {
    const requestHeaders = new Headers(req.headers);
    requestHeaders.set("x-nonce", nonce);
    requestHeaders.set("Content-Security-Policy", contentSecurityPolicy);
    response = NextResponse.next({ request: { headers: requestHeaders } });
  } else {
    response = NextResponse.next();
  }

  return applySecurityHeaders(response, contentSecurityPolicy, isProduction);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
