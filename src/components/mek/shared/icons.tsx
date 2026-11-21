"use client";
// Resolves string icon names (from DB/constants) to Lucide components.
import {
  Car, Truck, Bus, Disc3, CircleDot, Wind, BatteryCharging, Settings2, ShieldCheck, Siren, Fuel,
  Cog, Zap, Droplets, ScanLine, Factory, Wrench, type LucideIcon,
} from "lucide-react";

export const ICONS: Record<string, LucideIcon> = {
  Car, Truck, Bus, Disc3, CircleDot, Wind, BatteryCharging, Settings2, ShieldCheck, Siren, Fuel,
  Cog, Zap, Droplets, ScanLine, Factory, Wrench,
  Excavator: Factory, Loader: Truck, Bulldozer: Cog, Grader: Settings2, Tractor: Factory,
};

export function MekIcon({ name, className }: { name: string; className?: string }) {
  const Icon = ICONS[name] ?? Wrench;
  return <Icon className={className} />;
}

export function iconForMachineType(type: string): string {
  const map: Record<string, string> = {
    CAR: "Car", TRUCK: "Truck", BUS: "Bus", EXCAVATOR: "Excavator", LOADER: "Loader",
    BULLDOZER: "Bulldozer", GRADER: "Grader", AGRI: "Tractor", INDUSTRIAL: "Factory", OTHER: "Wrench",
  };
  return map[type] ?? "Wrench";
}

export function iconForCategory(slug: string): string {
  const map: Record<string, string> = {
    engine: "Cog", electrical: "Zap", hydraulic: "Droplets", brakes: "Disc3",
    diagnostic: "ScanLine", tire: "CircleDot", ac: "Wind", battery: "BatteryCharging",
    transmission: "Settings2", preventive: "ShieldCheck", roadside: "Siren", "heavy-diesel": "Fuel",
  };
  return map[slug] ?? "Wrench";
}
