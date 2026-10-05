import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-helpers";
import { revokeSession } from "@/lib/auth";

// POST /api/auth/logout
//
// Logs the caller out by:
//   1. Marking their Session DB row as `revokedAt = now` so any subsequent
//      `verifySession(token)` call returns null — the JWT is no longer
//      honoured even though it hasn't expired yet. This is the fix for
//      "logout doesn't work (JWT stays valid until expiry)".
//   2. Clearing the `mekanix-token` HttpOnly cookie so the browser stops
//      sending the token on subsequent requests.
//
// Auth model: we accept either `Authorization: Bearer <token>` or the
// `mekanix-token` cookie (matching `getSessionFromRequest`). The token is
// extracted the same way so we can hash it and find the Session DB row.

export async function POST(req: Request) {
  // 1. Authenticate the request (also applies default API rate limit).
  //    `requireAuth` from `@/lib/api-helpers` returns either the Session
  //    or a NextResponse(401/429) — we pass 401/429 straight through.
  const session = await requireAuth(req);
  if (session instanceof NextResponse) return session;

  // 2. Extract the raw JWT so we can hash it and find the Session row.
  //    We intentionally re-read the headers here (rather than threading
  //    the token through `requireAuth`) because `requireAuth` returns
  //    only the decoded Session payload — never the raw token, which
  //    would be a needless secret-exposure risk.
  const auth = req.headers.get("authorization");
  const cookie = req.headers.get("cookie");
  let token: string | null = null;
  if (auth?.startsWith("Bearer ")) {
    token = auth.slice(7);
  } else if (cookie) {
    const match = cookie.match(/mekanix-token=([^;]+)/);
    if (match) token = match[1];
  }

  // 3. Revoke the Session DB row (idempotent — see revokeSession).
  if (token) {
    await revokeSession(token);
  }

  // 4. Clear the HttpOnly cookie so the browser drops the token too.
  const response = NextResponse.json({ ok: true });
  response.cookies.delete("mekanix-token");
  return response;
}
