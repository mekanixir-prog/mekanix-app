import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    ok: true,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || "development",
    services: {
      database: "starting",
      redis: "not-configured",
      sms: "dev-mode (console)",
      eta: "default (40km/h estimate)",
    },
    warnings: ["D1 integration in progress"],
  });
}
