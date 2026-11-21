// MEKANIX — Central domain constants & enums (UI-side mirror of Prisma enums)
// Kept in sync with prisma/schema.prisma

export const MACHINE_TYPES = [
  { slug: "CAR", label: "Passenger Car", icon: "Car", group: "vehicle", mode: "passenger" },
  { slug: "TRUCK", label: "Truck", icon: "Truck", group: "vehicle", mode: "heavy" },
  { slug: "BUS", label: "Bus", icon: "Bus", group: "vehicle", mode: "heavy" },
  { slug: "EXCAVATOR", label: "Excavator", icon: "Excavator", group: "heavy", mode: "heavy" },
  { slug: "LOADER", label: "Loader", icon: "Loader", group: "heavy", mode: "heavy" },
  { slug: "BULLDOZER", label: "Bulldozer", icon: "Bulldozer", group: "heavy", mode: "heavy" },
  { slug: "GRADER", label: "Grader", icon: "Grader", group: "heavy", mode: "heavy" },
  { slug: "AGRI", label: "Agricultural", icon: "Tractor", group: "agri", mode: "heavy" },
  { slug: "INDUSTRIAL", label: "Industrial", icon: "Factory", group: "industrial", mode: "heavy" },
  { slug: "OTHER", label: "Other", icon: "Wrench", group: "other", mode: "heavy" },
] as const;

export type MachineTypeSlug = (typeof MACHINE_TYPES)[number]["slug"];
export type MachineMode = "passenger" | "heavy";

export const MACHINE_MODES = [
  {
    slug: "passenger" as MachineMode,
    label: "Passenger Vehicles",
    labelFa: "خودروی سواری",
    desc: "Cars, SUVs, light vehicles",
    icon: "Car",
    tone: "amber",
    types: ["CAR"],
  },
  {
    slug: "heavy" as MachineMode,
    label: "Heavy Machinery",
    labelFa: "ماشین‌آلات سنگین",
    desc: "Trucks, buses, excavators, loaders, tractors, industrial",
    icon: "Truck",
    tone: "emerald",
    types: ["TRUCK", "BUS", "EXCAVATOR", "LOADER", "BULLDOZER", "GRADER", "AGRI", "INDUSTRIAL"],
  },
] as const;

export function typesForMode(mode: MachineMode): string[] {
  return [...(MACHINE_MODES.find((m) => m.slug === mode)?.types ?? [])];
}

export const JOB_STATUS_FLOW: {
  key: string;
  label: string;
  tone: "neutral" | "amber" | "blue" | "emerald" | "violet" | "rose";
  step: number;
  hint: string;
}[] = [
  { key: "REQUESTED", label: "Requested", tone: "neutral", step: 0, hint: "Customer submitted the request" },
  { key: "ACCEPTED", label: "Accepted", tone: "amber", step: 1, hint: "Technician accepted the job" },
  { key: "EN_ROUTE", label: "En Route", tone: "amber", step: 2, hint: "Technician travelling to site" },
  { key: "ARRIVED", label: "Arrived", tone: "blue", step: 3, hint: "Technician on location" },
  { key: "DIAGNOSING", label: "Diagnosing", tone: "violet", step: 4, hint: "Inspecting the machine" },
  { key: "REPAIRING", label: "Repairing", tone: "violet", step: 5, hint: "Repair in progress" },
  { key: "WAITING_APPROVAL", label: "Awaiting Approval", tone: "amber", step: 6, hint: "Estimate ready for approval" },
  { key: "COMPLETED", label: "Completed", tone: "emerald", step: 7, hint: "Job finished & documented" },
  { key: "CANCELLED", label: "Cancelled", tone: "rose", step: -1, hint: "Job cancelled" },
  { key: "REJECTED", label: "Rejected", tone: "rose", step: -1, hint: "Mechanic declined — finding another" },
];

export const STATUS_TONE_CLASS: Record<string, string> = {
  neutral: "bg-muted text-muted-foreground border-border",
  amber: "bg-amber/15 text-amber border-amber/30",
  blue: "bg-sky-500/15 text-sky-400 border-sky-500/30",
  emerald: "bg-emerald-glow/15 text-emerald-glow border-emerald-glow/30",
  violet: "bg-violet-500/15 text-violet-400 border-violet-500/30",
  rose: "bg-destructive/15 text-destructive border-destructive/30",
};

export const URGENCY = [
  { slug: "NORMAL", label: "Scheduled", tone: "neutral", desc: "Not time critical" },
  { slug: "URGENT", label: "Urgent", tone: "amber", desc: "Need it today" },
  { slug: "EMERGENCY", label: "Emergency", tone: "rose", desc: "Roadside / breakdown" },
] as const;

export const TECH_LEVELS = [
  { slug: "BRONZE", label: "Bronze", color: "#b87333" },
  { slug: "SILVER", label: "Silver", color: "#c0c0c0" },
  { slug: "GOLD", label: "Gold", color: "#F5A524" },
  { slug: "PLATINUM", label: "Platinum", color: "#7dd3fc" },
] as const;

export const SERVICE_CATEGORIES = [
  { slug: "engine", label: "Engine & Drivetrain", icon: "Cog", base: 120 },
  { slug: "electrical", label: "Electrical & Wiring", icon: "Zap", base: 90 },
  { slug: "hydraulic", label: "Hydraulics", icon: "Droplets", base: 160 },
  { slug: "brakes", label: "Brakes & Suspension", icon: "Disc3", base: 110 },
  { slug: "diagnostic", label: "Computer Diagnostics", icon: "ScanLine", base: 75 },
  { slug: "tire", label: "Tires & Wheels", icon: "CircleDot", base: 80 },
  { slug: "ac", label: "HVAC & Cooling", icon: "Wind", base: 95 },
  { slug: "battery", label: "Battery & Alternator", icon: "BatteryCharging", base: 70 },
  { slug: "transmission", label: "Transmission", icon: "Settings2", base: 180 },
  { slug: "preventive", label: "Preventive Maintenance", icon: "ShieldCheck", base: 85 },
  { slug: "roadside", label: "Emergency Roadside", icon: "Siren", base: 95 },
  { slug: "heavy-diesel", label: "Heavy Diesel Systems", icon: "Fuel", base: 220 },
] as const;

export const NOTIFICATION_TYPES: Record<
  string,
  { label: string; category: string; icon: string }
> = {
  request_accepted: { label: "Technician Accepted", category: "job", icon: "CircleCheck" },
  request_rejected: { label: "Mechanic Declined", category: "alert", icon: "XCircle" },
  technician_arriving: { label: "Technician Arriving", category: "job", icon: "MapPin" },
  estimate_ready: { label: "Estimate Ready", category: "job", icon: "FileText" },
  payment_required: { label: "Payment Required", category: "payment", icon: "CreditCard" },
  job_completed: { label: "Job Completed", category: "job", icon: "CheckCircle2" },
  new_message: { label: "New Message", category: "message", icon: "MessageSquare" },
  maintenance_reminder: { label: "Maintenance Reminder", category: "maintenance", icon: "CalendarClock" },
  new_request: { label: "New Service Request", category: "job", icon: "Wrench" },
  review_request: { label: "Rate Your Service", category: "system", icon: "Star" },
  vip_activated: { label: "VIP Activated", category: "system", icon: "Crown" },
  new_support_ticket: { label: "New Support Ticket", category: "system", icon: "Headset" },
  support_update: { label: "Support Update", category: "system", icon: "Headset" },
  invoice_issued: { label: "Invoice Issued", category: "payment", icon: "Receipt" },
  payment_received: { label: "Payment Received", category: "payment", icon: "CreditCard" },
  payout_processed: { label: "Payout Processed", category: "payment", icon: "Banknote" },
  application_approved: { label: "Application Approved", category: "system", icon: "CheckCircle2" },
  application_rejected: { label: "Application Rejected", category: "system", icon: "XCircle" },
  warranty_claim: { label: "Warranty Claim", category: "system", icon: "ShieldCheck" },
};

export const CURRENCIES: Record<string, { symbol: string; label: string }> = {
  USD: { symbol: "$", label: "US Dollar" },
  EUR: { symbol: "€", label: "Euro" },
  IRR: { symbol: "﷼", label: "Iranian Rial" },
};

export const COUNTRIES = [
  { code: "US", label: "United States", dial: "+1" },
  { code: "DE", label: "Germany", dial: "+49" },
  { code: "AE", label: "UAE", dial: "+971" },
  { code: "IR", label: "Iran", dial: "+98" },
  { code: "SA", label: "Saudi Arabia", dial: "+966" },
];

export const PAYMENT_METHODS = [
  { slug: "card", label: "Credit / Debit Card", icon: "CreditCard" },
  { slug: "wallet", label: "MEKANIX Wallet", icon: "Wallet" },
  { slug: "bank", label: "Bank Transfer", icon: "Landmark" },
  { slug: "cash", label: "Cash on Site", icon: "Banknote" },
] as const;
