import { NextResponse } from "next/server";
import { getUsdToIrrRate } from "@/lib/exchange-rate";

// Public USD → IRR rate endpoint. The same trusted snapshot is used by
// gateway initiation so displayed and charged conversion rates stay aligned.
export async function GET() {
  const snapshot = await getUsdToIrrRate();
  return NextResponse.json(snapshot);
}
