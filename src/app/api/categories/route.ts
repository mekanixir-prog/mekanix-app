import { NextResponse } from "next/server";

export async function GET() {
  const cats = [
    { slug: "engine", name: "Engine & Drivetrain", icon: "Cog", basePrice: 120, order: 0 },
    { slug: "electrical", name: "Electrical & Wiring", icon: "Zap", basePrice: 90, order: 1 },
    { slug: "hydraulic", name: "Hydraulics", icon: "Droplets", basePrice: 160, order: 2 },
    { slug: "brakes", name: "Brakes & Suspension", icon: "Disc3", basePrice: 110, order: 3 },
    { slug: "diagnostic", name: "Computer Diagnostics", icon: "ScanLine", basePrice: 75, order: 4 },
    { slug: "tire", name: "Tires & Wheels", icon: "CircleDot", basePrice: 80, order: 5 },
    { slug: "ac", name: "HVAC & Cooling", icon: "Wind", basePrice: 95, order: 6 },
    { slug: "battery", name: "Battery & Alternator", icon: "BatteryCharging", basePrice: 70, order: 7 },
    { slug: "transmission", name: "Transmission", icon: "Settings2", basePrice: 180, order: 8 },
    { slug: "preventive", name: "Preventive Maintenance", icon: "ShieldCheck", basePrice: 85, order: 9 },
    { slug: "roadside", name: "Emergency Roadside", icon: "Siren", basePrice: 95, order: 10 },
    { slug: "heavy-diesel", name: "Heavy Diesel Systems", icon: "Fuel", basePrice: 220, order: 11 },
  ];
  return NextResponse.json(cats);
}
