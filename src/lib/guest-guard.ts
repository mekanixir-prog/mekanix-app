import { NextResponse } from "next/server";
import type { Session } from "./auth";

// Block guests from write operations (POST/PATCH/DELETE)
export function blockGuestWrite(session: Session, method: string): NextResponse | null {
  if (session.isGuest && ["POST", "PATCH", "DELETE", "PUT"].includes(method)) {
    return NextResponse.json(
      { error: "برای این عملیات باید وارد حساب کاربری شوید" },
      { status: 403 }
    );
  }
  return null;
}
