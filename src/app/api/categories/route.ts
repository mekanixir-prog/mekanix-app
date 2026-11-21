import { NextResponse } from "next/server";

export async function GET() {
  const cats = [
    { slug: "engine", name: "Engine & Drivetrain", icon: "Cog", order: 0 },
    { slug: "electrical", name: "Electrical & Wiring", icon: "Zap", order: 1 },
    { slug: "hydraulic", name: "Hydraulics", icon: "Droplets", order: 2 },
    { slug: "brakes", name: "Brakes & Suspension", icon: "Disc3", order: 3 },
    { slug: "diagnostic", name: "Computer Diagnostics", icon: "ScanLine", order: 4 },
    { slug: "tire", name: "Tires & Wheels", icon: "CircleDot", order: 5 },
    { slug: "ac", name: "HVAC & Cooling", icon: "Wind", order: 6 },
    { slug: "battery", name: "Battery & Alternator", icon: "BatteryCharging", order: 7 },
    { slug: "transmission", name: "Transmission", icon: "Settings2", order: 8 },
    { slug: "preventive", name: "Preventive Maintenance", icon: "ShieldCheck", order: 9 },
    { slug: "roadside", name: "Emergency Roadside", icon: "Siren", order: 10 },
    { slug: "heavy-diesel", name: "Heavy Diesel Systems", icon: "Fuel", order: 11 },
  ];
  // No price is sourced here: these categories are descriptive metadata only.
  // Keep the legacy response field explicitly null until a verified IRR rate card is bound.
  return NextResponse.json(cats.map((category) => ({
    ...category,
    basePrice: null,
    financialUnitStatus: "UNVERIFIED" as const,
  })));
}
