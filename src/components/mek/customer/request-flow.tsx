"use client";
import { useEffect, useRef, useState } from "react";
import { isVehicleInSupportedScope } from "@/lib/vehicle-scope";
import { motion, AnimatePresence } from "framer-motion";
import {
  ChevronRight, ChevronLeft, Loader2, MapPin, Camera, Upload, Search, Star,
  BadgeCheck, Clock, Zap, ShieldCheck, Navigation as NavIcon, ArrowLeft,
} from "lucide-react";
import type { DemoUser } from "@/lib/use-active-user";
import { useApp } from "@/lib/store";
import { api, type Vehicle, type PublicTechnician } from "@/lib/api";
import { MACHINE_TYPES, SERVICE_CATEGORIES, URGENCY, typesForMode } from "@/lib/constants";
import { MekIcon, iconForMachineType, iconForCategory } from "@/components/mek/shared/icons";
import { VehicleCard } from "@/components/mek/shared/vehicle-card";
import { TechnicianCard } from "@/components/mek/shared/technician-card";
import { StarRating, EmptyState, SectionHeader } from "@/components/mek/shared/primitives";
import { UrgencyBadge } from "@/components/mek/shared/status-badge";
import { VoiceRecorder } from "@/components/mek/shared/voice-recorder";
import { fmtDuration, toPersianDigits } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { toast } from "sonner";
import { X } from "lucide-react";
import { useT } from "@/lib/use-t";

// ─── Step 1: Select Machine ───
export function RequestType({ customer }: { customer: DemoUser }) {
  const { go, params, machineMode } = useApp();
  const { t, isFa, type: typeLabel } = useT();
  const [vehicles, setVehicles] = useState<Vehicle[] | null>(null);
  const [selectedType, setSelectedType] = useState<string | null>(params.type ?? null);

  const allowedTypes = typesForMode(machineMode);

  useEffect(() => {
    if (customer.customer)
      api.listVehicles(customer.customer.id)
        .then((v) => setVehicles(v.filter((x) => allowedTypes.includes(x.type) && isVehicleInSupportedScope(x.type, x.make))))
        .catch(() => setVehicles([]));
  }, [customer, machineMode]);

  const saved = vehicles ?? [];
  const hasSaved = saved.length > 0;

  const proceed = (vehicle?: Vehicle, type?: string) => {
    go("describe", { vehicleId: vehicle?.id, type: type ?? vehicle?.type ?? selectedType ?? (machineMode === "heavy" ? "TRUCK" : "CAR") });
  };

  const visibleMachineTypes = MACHINE_TYPES.filter((m) => allowedTypes.includes(m.slug));

  return (
    <div className="space-y-5" dir={isFa ? "rtl" : "ltr"}>
      <StepHeader
        step={1}
        total={3}
        title={t("req.selectMachine")}
        subtitle={t("req.selectMachineSub")}
        onBack={() => go("home")}
      />

      {hasSaved && (
        <section>
          <SectionHeader title={t("req.savedFleet")} subtitle={t("req.savedFleetSub")} />
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {saved.map((v) => (
              <VehicleCard key={v.id} vehicle={v} selected={params.vehicleId === v.id} onSelect={() => proceed(v)} />
            ))}
          </div>
        </section>
      )}

      <section>
        <SectionHeader
          title={hasSaved ? t("req.pickType") : t("req.whatNeeds")}
          subtitle={t("req.whatNeedsSub")}
        />
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {visibleMachineTypes.map((m) => (
            <motion.button
              key={m.slug}
              whileHover={{ y: -2 }}
              onClick={() => { setSelectedType(m.slug); proceed(undefined, m.slug); }}
              className={`group relative overflow-hidden rounded-xl border bg-card p-4 text-center mk-card-hover ${selectedType === m.slug ? "border-amber mk-amber-glow" : "border-border hover:border-amber/40"}`}
            >
              <div className={`mx-auto grid size-12 place-items-center rounded-xl border ${selectedType === m.slug ? "border-amber/40 bg-amber/10" : "border-border bg-background"}`}>
                <MekIcon name={m.icon} className={`size-6 ${selectedType === m.slug ? "text-amber" : "text-muted-foreground"}`} />
              </div>
              <p className="mt-2 font-display text-sm font-semibold">{typeLabel(m.slug)}</p>
            </motion.button>
          ))}
        </div>
      </section>
    </div>
  );
}

// ─── Step 2: Describe Problem ───
export function DescribeProblem({ customer }: { customer: DemoUser }) {
  const { go, params, machineMode, auth, exitToSplash } = useApp();
  const { t, isFa, cat, type: typeLabel, money } = useT();
  const lang = isFa ? "fa" : "en";
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [vehiclesLoaded, setVehiclesLoaded] = useState(false);
  const [vehicleId, setVehicleId] = useState<string | undefined>(params.vehicleId);
  const [type, setType] = useState<string>(params.type ?? (machineMode === "heavy" ? "TRUCK" : "CAR"));
  const [category, setCategory] = useState<string>("");
  const [urgency, setUrgency] = useState<string>(params.urgency ?? "NORMAL");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [address, setAddress] = useState("تهران، میدان آزادی");
  const [media, setMedia] = useState<string[]>([]);
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [guestBlock, setGuestBlock] = useState(false);

  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  // Deterministic default coordinates keep an identical form fingerprint stable across reloads.
  const requestCoordinatesRef = useRef({ lat: 35.6892, lng: 51.3890 });
  const requestIdempotencyRef = useRef<{ signature: string; key: string } | null>(null);

  const allowedTypes = typesForMode(machineMode);

  useEffect(() => {
    setVehiclesLoaded(false);
    if (customer.customer) {
      api.listVehicles(customer.customer.id)
        .then((v) => {
          const eligible = v.filter((x) => allowedTypes.includes(x.type) && isVehicleInSupportedScope(x.type, x.make));
          setVehicles(eligible);
          setVehicleId((current) =>
            current && eligible.some((vehicle) => vehicle.id === current)
              ? current
              : eligible.length === 1 ? eligible[0].id : undefined
          );
        })
        .catch(() => setVehicles([]))
        .finally(() => setVehiclesLoaded(true));
    } else {
      setVehicles([]);
      setVehiclesLoaded(true);
    }
  }, [customer, machineMode]);

  const readFileAsDataURL = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });

  const onFilesSelected = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    try {
      const urls = await Promise.all(Array.from(files).slice(0, 6).map(readFileAsDataURL));
      setMedia((m) => [...m, ...urls].slice(0, 12));
      toast.success(t("req.field.photoAttached"));
    } catch {
      toast.error(t("req.attachFailed"));
    }
  };

  const submit = async () => {
    if (auth.isGuest) { setGuestBlock(true); return; }
    if (!category) { toast.error(t("req.error.category")); return; }
    if (!title.trim()) { toast.error(t("req.error.title")); return; }
    if (!customer.customer?.id) {
      // Should not happen because OTP verify + session route auto-create Customer,
      // but if it does, fail gracefully with a clear message instead of a TypeError.
      toast.error(t("req.error.noCustomer"));
      return;
    }
    if (!vehiclesLoaded) {
      toast.error(isFa ? "در حال دریافت فهرست وسایل..." : "Loading your registered vehicles...");
      return;
    }
    const registeredVehicleId = vehicleId ?? (vehicles.length === 1 ? vehicles[0].id : undefined);
    if (!registeredVehicleId) {
      toast.error(isFa
        ? "برای ثبت درخواست، ابتدا وسیله خود را ثبت و سپس آن را انتخاب کنید."
        : "Register and select a vehicle before submitting a service request.");
      return;
    }
    setSubmitting(true);
    try {
      // Keep coordinates and Idempotency-Key stable across retries of the same payload.
      const payload = {
        customerId: customer.customer.id,
        vehicleId: registeredVehicleId,
        category,
        urgency,
        title: title.trim(),
        description: description.trim(),
        mediaUrls: media,
        address,
        lat: requestCoordinatesRef.current.lat,
        lng: requestCoordinatesRef.current.lng,
      };
      const signature = JSON.stringify(payload);
      const storageKey = `mekanix-service-request:${customer.customer.id}`;
      let activeKey = requestIdempotencyRef.current?.signature === signature
        ? requestIdempotencyRef.current.key
        : "";
      if (!activeKey) {
        try {
          const saved = sessionStorage.getItem(storageKey);
          const parsed = saved ? JSON.parse(saved) : null;
          activeKey = parsed?.signature === signature && typeof parsed?.key === "string"
            ? parsed.key
            : globalThis.crypto.randomUUID();
          sessionStorage.setItem(storageKey, JSON.stringify({ signature, key: activeKey }));
        } catch {
          activeKey = globalThis.crypto.randomUUID();
        }
        requestIdempotencyRef.current = { signature, key: activeKey };
      }
      const sr = await api.createRequest(payload, activeKey);
      try {
        const saved = sessionStorage.getItem(storageKey);
        if (saved && JSON.parse(saved)?.key === activeKey) sessionStorage.removeItem(storageKey);
      } catch {}
      requestIdempotencyRef.current = null;
      toast.success(t("req.created").replace("{code}", sr.code));
      go("matching", { requestId: sr.id });
    } catch (e: any) {
      toast.error(e.message ?? t("req.createFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  const selectedVehicle = vehicles.find((v) => v.id === vehicleId);

  return (
    <div className="space-y-5" dir={isFa ? "rtl" : "ltr"}>
      <StepHeader
        step={2}
        total={3}
        title={t("req.describe")}
        subtitle={t("req.describeSub")}
        onBack={() => go("request-type")}
      />

      <div className="grid gap-5 lg:grid-cols-[1.5fr_1fr]">
        <div className="space-y-5">
          {/* Machine */}
          <div className="rounded-xl border border-border bg-card p-4">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">{t("req.field.machine")}</Label>
            {vehiclesLoaded && vehicles.length === 0 && (
              <div className="mt-3 rounded-lg border border-amber/30 bg-amber/5 p-3" role="status">
                <p className="text-sm text-foreground">
                  {isFa
                    ? "هنوز وسیله واجد شرایطی ثبت نکرده‌اید. ابتدا ماشین یا دستگاه خود را ثبت کنید تا بتوانید درخواست خدمت بفرستید."
                    : "No eligible registered vehicle found. Add your vehicle or machine before requesting service."}
                </p>
                <Button type="button" size="sm" className="mt-3 bg-amber text-black hover:bg-amber/90" onClick={() => go("vehicles")}>
                  {isFa ? "ثبت وسیله" : "Register vehicle"}
                </Button>
              </div>
            )}
            {selectedVehicle ? (
              <div className="mt-2 flex items-center gap-3 rounded-lg border border-amber/30 bg-amber/5 p-3">
                <div className="grid size-10 place-items-center rounded-lg border border-border bg-background">
                  <MekIcon name={iconForMachineType(selectedVehicle.type)} className="size-5 text-amber" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{selectedVehicle.make} {selectedVehicle.model}</p>
                  <p className="text-[11px] text-muted-foreground">{typeLabel(selectedVehicle.type)} · {selectedVehicle.year}</p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => { setVehicleId(undefined); }}>{t("req.field.change")}</Button>
              </div>
            ) : (
              <div className="mt-2 flex items-center gap-3 rounded-lg border border-border p-3">
                <div className="grid size-10 place-items-center rounded-lg border border-border bg-background">
                  <MekIcon name={iconForMachineType(type)} className="size-5 text-amber" />
                </div>
                <span className="text-sm font-medium">{typeLabel(type)}</span>
              </div>
            )}
            {vehicles.length > 0 && !selectedVehicle && (
              <Select onValueChange={setVehicleId} value={vehicleId ?? ""}>
                <SelectTrigger className="mt-2"><SelectValue placeholder={t("req.field.linkSaved")} /></SelectTrigger>
                <SelectContent>
                  {vehicles.map((v) => <SelectItem key={v.id} value={v.id}>{v.make} {v.model} · {typeLabel(v.type)}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
          </div>

          {/* Category */}
          <div className="rounded-xl border border-border bg-card p-4">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">{t("req.field.category")}</Label>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {SERVICE_CATEGORIES.map((c) => (
                <button
                  key={c.slug}
                  onClick={() => setCategory(c.slug)}
                  className={`flex items-center gap-2 rounded-lg border p-2.5 text-left transition-colors ${category === c.slug ? "border-amber bg-amber/10" : "border-border hover:bg-accent"}`}
                >
                  <MekIcon name={c.icon} className={`size-4 shrink-0 ${category === c.slug ? "text-amber" : "text-muted-foreground"}`} />
                  <span className="text-[11px] font-medium leading-tight">{cat(c.slug)}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Title + description */}
          <div className="rounded-xl border border-border bg-card p-4">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">{t("req.field.summary")}</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("req.field.summaryPlaceholder")} className="mt-2" maxLength={120} />
            <Label className="mt-4 text-xs uppercase tracking-wide text-muted-foreground">{t("req.field.symptoms")}</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("req.field.symptomsPlaceholder")}
              rows={4}
              className="mt-2"
              maxLength={1000}
            />
            <p className="mt-1 text-right text-[10px] text-muted-foreground">
              {t("req.charsMax").replace("{n}", isFa ? toPersianDigits(description.length) : String(description.length)).replace("{max}", isFa ? toPersianDigits(1000) : "1000")}
            </p>
          </div>

          {/* Media */}
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">{t("req.field.attach")}</Label>
              <div className="flex gap-1">
                {/* Camera capture — direct to camera on mobile */}
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={() => cameraInputRef.current?.click()}
                >
                  <Camera className="mr-1 size-3.5" /> {t("req.field.addPhoto")}
                </Button>
                <input
                  ref={cameraInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    onFilesSelected(e.target.files);
                    e.target.value = "";
                  }}
                />
                {/* Gallery upload */}
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={() => galleryInputRef.current?.click()}
                >
                  <Upload className="size-3.5" />
                </Button>
                <input
                  ref={galleryInputRef}
                  type="file"
                  accept="image/*,video/*"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    onFilesSelected(e.target.files);
                    e.target.value = "";
                  }}
                />
                {/* Voice recorder */}
                <VoiceRecorder
                  lang={lang}
                  onRecorded={(blob) => {
                    setVoiceNote(URL.createObjectURL(blob));
                    toast.success(t("req.voiceRecorded"));
                  }}
                />
              </div>
            </div>

            {(media.length > 0 || voiceNote) && (
              <div className="mt-3 flex flex-wrap gap-2">
                {voiceNote && (
                  <div className="relative flex items-center gap-2 rounded-lg border border-amber/30 bg-amber/5 p-2">
                    <audio src={voiceNote} controls className="h-8 w-40" />
                    <button
                      onClick={() => setVoiceNote(null)}
                      className="absolute -right-1 -top-1 grid size-4 place-items-center rounded-full bg-destructive text-white"
                      aria-label={t("req.removeVoice")}
                    >
                      <X className="size-2.5" />
                    </button>
                  </div>
                )}
                {media.map((url, i) => (
                  <div key={i} className="relative">
                    <img src={url} alt="" className="size-16 rounded-lg border border-border object-cover" />
                    <button
                      onClick={() => setMedia((m) => m.filter((_, idx) => idx !== i))}
                      className="absolute -right-1 -top-1 grid size-4 place-items-center rounded-full bg-destructive text-white"
                      aria-label={t("req.removePhoto")}
                    >
                      <X className="size-2.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right column: urgency + location + submit */}
        <div className="space-y-5">
          <div className="rounded-xl border border-border bg-card p-4">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">{t("req.field.urgency")}</Label>
            <div className="mt-3 space-y-2">
              {URGENCY.map((u) => (
                <button
                  key={u.slug}
                  onClick={() => setUrgency(u.slug)}
                  className={`flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors ${urgency === u.slug ? "border-amber bg-amber/5" : "border-border hover:bg-accent"}`}
                >
                  <UrgencyBadge urgency={u.slug} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{t(`urgency.${u.slug}`)}</p>
                    <p className="text-[11px] text-muted-foreground">{t(`urgency.${u.slug}.desc`)}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card p-4">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">{t("req.field.location")}</Label>
            <div className="mt-2 flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
              <MapPin className="size-4 text-amber" />
              <Input value={address} onChange={(e) => setAddress(e.target.value)} className="border-0 px-0 focus-visible:ring-0" />
            </div>
            <div className="mt-3 h-24 overflow-hidden rounded-lg border border-border bg-[oklch(0.16_0.008_260)]">
              <div className="size-full mk-grid-bg opacity-40" />
            </div>
          </div>

          <div className="sticky bottom-3">
            <Button onClick={submit} disabled={submitting} className="w-full bg-amber text-black hover:bg-amber/90">
              {submitting ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Search className="mr-2 size-4" />}
              {submitting ? t("req.finding") : t("req.findTechnicians")}
            </Button>
          </div>
        </div>
      </div>

      {/* Guest sign-in prompt */}
      <Dialog open={guestBlock} onOpenChange={setGuestBlock}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 font-display">
              <ShieldCheck className="size-4 text-amber" /> {t("req.guest.title")}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t("req.guest.body")}
          </p>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="ghost" onClick={() => setGuestBlock(false)}>{t("req.guest.later")}</Button>
            <Button className="bg-amber text-black hover:bg-amber/90" onClick={() => { exitToSplash(); }}>{t("req.guest.signInNow")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Step 3: Matching ───
export function Matching({ customer }: { customer: DemoUser }) {
  const { go, params } = useApp();
  const { t, isFa, money } = useT();
  const lang = isFa ? "fa" : "en";
  const [techs, setTechs] = useState<PublicTechnician[] | null>(null);
  const [phase, setPhase] = useState<"searching" | "results">("searching");
  const [selected, setSelected] = useState<string | null>(null);
  const [showOtherRegions, setShowOtherRegions] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const loadMatches = async () => {
      try {
        const requests = await api.listRequests();
        const currentRequest = requests.find((item) => item.id === params.requestId);
        const requestLocation = currentRequest &&
          Number.isFinite(currentRequest.lat) &&
          Number.isFinite(currentRequest.lng)
          ? { lat: currentRequest.lat, lng: currentRequest.lng }
          : undefined;
        const tList = await api.listTechnicians(requestLocation);
        if (cancelled) return;
        timer = setTimeout(() => {
          if (!cancelled) {
            setTechs(tList);
            setPhase("results");
          }
        }, 1900);
      } catch {
        if (!cancelled) {
          setTechs([]);
          setPhase("results");
        }
      }
    };

    void loadMatches();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [params.requestId]);

  const allRanked = (techs ?? []).map((tk) => {
    const distanceKnown = tk.distanceKm != null;
    const km = tk.distanceKm ?? 99;
    const eta = distanceKnown ? Math.max(5, Math.round((km / 35) * 60) + tk.responseMins) : undefined;
    // Score: weighted combination of rating, distance, verified, completed jobs.
    const rating = Number(tk.rating ?? 0);
    const hourlyRate = Number(tk.hourlyRate ?? 0);
    const proximityScore = rating * 20 - (distanceKnown ? km * 0.4 : 40) + (tk.verified ? 5 : 0) + tk.completedJobs * 0.02;
    // Value score: rating/cost ratio — higher rating + lower total cost = better value.
    const inspectionFee = tk.inspectionFee != null ? Number(tk.inspectionFee) : hourlyRate * 0.5;
    const inspectionFeeHeavy = tk.inspectionFeeHeavy != null ? Number(tk.inspectionFeeHeavy) : hourlyRate * 1.5;
    const travelFee = (tk.travelFeeBase != null ? Number(tk.travelFeeBase) : 0) + (distanceKnown ? km * 0.5 : 0);
    const totalCost = inspectionFee + travelFee;
    const valueScore = (rating * 30) / Math.max(1, totalCost / 10) + tk.completedJobs * 0.05 + (tk.verified ? 8 : 0);
    return { tech: tk, km, eta, score: proximityScore, valueScore, inspectionFee, inspectionFeeHeavy, travelFee };
  });

  // Nearest & fastest: top 3 by proximity score (closest + fastest).
  const nearest = [...allRanked].sort((a, b) => b.score - a.score).slice(0, 3);
  // Other regions: sorted by value score — those not in top-3 nearest.
  const nearestIds = new Set(nearest.map((r) => r.tech.id));
  const otherRegions = allRanked
    .filter((r) => !nearestIds.has(r.tech.id))
    .sort((a, b) => b.valueScore - a.valueScore)
    .slice(0, 5);

  const onSelect = (techId: string) => {
    setSelected(techId);
    go("technician-profile", { requestId: params.requestId, technicianId: techId });
  };

  return (
    <div className="space-y-5" dir={isFa ? "rtl" : "ltr"}>
      <StepHeader
        step={3}
        total={3}
        title={t("req.matching")}
        subtitle={t("req.matchingSub")}
        onBack={() => go("describe")}
      />

      <AnimatePresence mode="wait">
        {phase === "searching" ? (
          <motion.div key="searching" exit={{ opacity: 0 }} className="grid place-items-center py-16">
            <div className="relative">
              <motion.div
                animate={{ scale: [1, 1.8, 1], opacity: [0.6, 0, 0.6] }}
                transition={{ duration: 2, repeat: Infinity }}
                className="absolute inset-0 rounded-full bg-amber"
              />
              <div className="relative grid size-20 place-items-center rounded-full border-2 border-amber/30 bg-amber/10">
                <Search className="size-8 text-amber" />
              </div>
            </div>
            <p className="mt-6 font-display text-lg font-semibold">{t("req.searching")}</p>
            <p className="text-sm text-muted-foreground">{t("req.searchingSub")}</p>
            <div className="mt-4 flex flex-wrap justify-center gap-6 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1"><NavIcon className="size-3 text-amber" /> {t("req.search.distance")}</span>
              <span className="inline-flex items-center gap-1"><Star className="size-3 text-amber" /> {t("req.search.rating")}</span>
              <span className="inline-flex items-center gap-1"><BadgeCheck className="size-3 text-amber" /> {t("req.search.certs")}</span>
              <span className="inline-flex items-center gap-1"><Clock className="size-3 text-amber" /> {t("req.search.eta")}</span>
            </div>
          </motion.div>
        ) : (
          <motion.div key="results" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-5">
            {allRanked.length === 0 ? (
              <EmptyState
                icon={Search}
                title={t("req.noMatch")}
                description={t("req.noMatchDesc")}
                action={<Button onClick={() => go("describe")} variant="outline">{t("req.backToDetails")}</Button>}
              />
            ) : (
              <>
                {/* Primary: Nearest & fastest */}
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <div className="grid size-7 place-items-center rounded-md border border-amber/30 bg-amber/10">
                      <Clock className="size-3.5 text-amber" />
                    </div>
                    <div>
                      <h3 className="font-display text-sm font-semibold">{t("req.search.nearest")}</h3>
                      <p className="text-[11px] text-muted-foreground">{t("req.search.nearestDesc")}</p>
                    </div>
                  </div>
                  <div className="grid gap-3 lg:grid-cols-2">
                    {nearest.map((r, i) => (
                      <TechnicianCard
                        key={r.tech.id}
                        tech={r.tech}
                        distanceKm={r.distanceKnown ? r.km : undefined}
                        etaMins={r.eta}
                        rank={i + 1}
                        inspectionFee={r.inspectionFee}
                        travelFee={r.travelFee}
                        selected={selected === r.tech.id}
                        onSelect={() => onSelect(r.tech.id)}
                      />
                    ))}
                  </div>
                </div>

                {/* Secondary: Other regions (best value) */}
                {otherRegions.length > 0 && (
                  <div>
                    <button
                      onClick={() => setShowOtherRegions((v) => !v)}
                      className="flex w-full items-center gap-2 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-amber/40"
                    >
                      <div className="grid size-7 place-items-center rounded-md border border-violet-400/30 bg-violet-400/10">
                        <Star className="size-3.5 text-violet-300" />
                      </div>
                      <div className="flex-1">
                        <h3 className="font-display text-sm font-semibold">{t("req.search.otherRegions")}</h3>
                        <p className="text-[11px] text-muted-foreground">{t("req.search.otherRegionsDesc")}</p>
                      </div>
                      <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                        {isFa ? (otherRegions.length).toString().replace(/\d/g, d => "۰۱۲۳۴۵۶۷۸۹"[+d]) : otherRegions.length}
                      </span>
                      <ChevronRight className={`size-4 text-muted-foreground transition-transform ${showOtherRegions ? "rotate-90" : ""}`} />
                    </button>

                    {showOtherRegions && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        className="mt-3"
                      >
                        <div className="mb-3 rounded-lg border border-violet-400/20 bg-violet-400/5 p-2.5 text-[11px] text-muted-foreground">
                          <p className="flex items-center gap-1.5 font-medium text-violet-300">
                            <BadgeCheck className="size-3" /> {t("req.search.costComparison")}
                          </p>
                        </div>
                        <div className="grid gap-3 lg:grid-cols-2">
                          {otherRegions.map((r, i) => (
                            <TechnicianCard
                              key={r.tech.id}
                              tech={r.tech}
                              distanceKm={r.km}
                              etaMins={r.eta}
                              rank={undefined}
                              inspectionFee={r.inspectionFee}
                              travelFee={r.travelFee}
                              selected={selected === r.tech.id}
                              onSelect={() => onSelect(r.tech.id)}
                            />
                          ))}
                        </div>
                      </motion.div>
                    )}
                  </div>
                )}
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Technician Profile ───
export function TechnicianProfileView({ customer }: { customer: DemoUser }) {
  const { go, params, back } = useApp();
  const { t, isFa, money, cat } = useT();
  const lang = isFa ? "fa" : "en";
  const [tech, setTech] = useState<PublicTechnician | null>(null);
  const [requesting, setRequesting] = useState(false);

  useEffect(() => {
    if (params.technicianId) api.getTechnician(params.technicianId).then(setTech);
  }, [params.technicianId]);

  const request = async () => {
    setRequesting(true);
    try {
      // assign the technician to the request + create a job in REQUESTED state
      const requests = await api.listRequests();
      const sr = requests.find((item) => item.id === params.requestId);
      if (!sr) throw new Error(t("req.techProfile.requestNotFound"));
      const job = await api.assignServiceRequest(sr.id, String(params.technicianId ?? ""));
      if (!job?.id) throw new Error(t("req.techProfile.assignFailed"));
      toast.success(t("req.techProfile.notified").replace("{name}", tech?.user.name ?? ""));
      go("track", { jobId: job.id });
    } catch (e: any) {
      toast.error(e.message ?? t("req.techProfile.assignFailed"));
    } finally {
      setRequesting(false);
    }
  };

  if (!tech) return <div className="h-64 rounded-xl bg-muted/60 mk-shimmer" />;

  return (
    <div className="space-y-5" dir={isFa ? "rtl" : "ltr"}>
      <button onClick={back} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> {t("req.backToResults")}
      </button>

      {/* Header */}
      <div className="relative overflow-hidden rounded-xl border border-border bg-card p-5">
        <div className="absolute -right-16 -top-16 size-48 rounded-full bg-amber/10 blur-3xl" />
        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="relative shrink-0">
            <div className="grid size-20 place-items-center overflow-hidden rounded-2xl border border-border bg-muted">
              {tech.user.avatar ? <img src={tech.user.avatar} alt={tech.user.name} className="size-full object-cover" /> : <span className="font-display text-2xl">{tech.user.name[0]}</span>}
            </div>
            {tech.verified && <div className="absolute -bottom-1 -right-1 grid size-7 place-items-center rounded-full border-2 border-card bg-amber text-black"><BadgeCheck className="size-4" /></div>}
          </div>
          <div className="flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-display text-xl font-semibold">{tech.user.name}</h1>
              <span className="rounded-full bg-amber/15 px-2 py-0.5 text-[10px] font-semibold uppercase text-amber">{tech.level}</span>
            </div>
            <div className="mt-1 flex items-center gap-2 text-sm">
              <StarRating value={Number(tech.rating)} />
              <span className="font-semibold">{isFa ? toPersianDigits(Number(tech.rating).toFixed(2)) : Number(tech.rating).toFixed(2)}</span>
              <span className="text-muted-foreground">· {isFa ? toPersianDigits(tech.reviewCount) : tech.reviewCount} {t("common.reviews")} · {isFa ? toPersianDigits(tech.completedJobs) : tech.completedJobs} {t("common.jobs")}</span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{tech.bio}</p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <div className="font-display text-2xl font-bold text-amber">{money(Number(tech.hourlyRate))}<span className="text-xs text-muted-foreground">/{t("common.hr")}</span></div>
            <div className="text-[11px] text-muted-foreground">{fmtDuration(tech.responseMins, lang)} · {t("req.techProfile.estArrival")}</div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-4">
          {/* Specialties */}
          <div className="rounded-xl border border-border bg-card p-4">
            <h3 className="font-display text-sm font-semibold">{t("req.techProfile.specialties")}</h3>
            <div className="mt-3 flex flex-wrap gap-2">
              {tech.specialties.map((s) => (
                <span key={s.id} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1 text-xs">
                  <MekIcon name={iconForCategory(s.category)} className="size-3.5 text-amber" />
                  {cat(s.category)}
                </span>
              ))}
            </div>
          </div>

          {/* Certifications */}
          <div className="rounded-xl border border-border bg-card p-4">
            <h3 className="font-display text-sm font-semibold">{t("req.techProfile.certifications")}</h3>
            <div className="mt-3 space-y-2">
              {tech.certifications.map((c) => (
                <div key={c.id} className="flex items-center gap-3 rounded-lg border border-border bg-background p-2.5">
                  <div className={`grid size-9 place-items-center rounded-lg border ${c.verified ? "border-emerald-glow/30 bg-emerald-glow/10" : "border-border bg-muted"}`}>
                    <ShieldCheck className={`size-4 ${c.verified ? "text-emerald-glow" : "text-muted-foreground"}`} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{c.name}</p>
                    <p className="text-[11px] text-muted-foreground">{c.issuer} · {c.year}</p>
                  </div>
                  {c.verified ? <span className="rounded bg-emerald-glow/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-glow">{t("common.verified")}</span> : <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{t("common.pending")}</span>}
                </div>
              ))}
            </div>
          </div>

          {/* Reviews */}
          <div className="rounded-xl border border-border bg-card p-4">
            <h3 className="font-display text-sm font-semibold">{t("req.techProfile.recentReviews")}</h3>
            <div className="mt-3 space-y-3">
              {(tech as any).reviews?.slice(0, 3).map((r: any) => (
                <div key={r.id} className="rounded-lg border border-border bg-background p-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="grid size-7 place-items-center overflow-hidden rounded-full border border-border bg-muted">
                        {r.fromUser?.avatar ? <img src={r.fromUser.avatar} alt="" className="size-full object-cover" /> : <span className="text-[10px]">{r.fromUser?.name?.[0]}</span>}
                      </div>
                      <span className="text-xs font-medium">{r.fromUser?.name}</span>
                    </div>
                    <StarRating value={r.rating} size={11} />
                  </div>
                  {r.comment && <p className="mt-1.5 text-sm text-muted-foreground">"{r.comment}"</p>}
                </div>
              )) ?? <p className="text-sm text-muted-foreground">{t("req.techProfile.noReviews")}</p>}
            </div>
          </div>
        </div>

        {/* Right: booking card */}
        <div className="space-y-4">
          <div className="sticky top-20 rounded-xl border border-border bg-card p-4">
            <h3 className="font-display text-sm font-semibold">{t("req.techProfile.request")}</h3>
            <div className="mt-3 space-y-2 text-sm">
              <Row label={t("req.techProfile.hourlyRate")} value={`${money(Number(tech.hourlyRate))}/${t("common.hr")}`} />
              <Row label={t("req.techProfile.travelFee")} value={money(Number(tech.travelFeeBase))} />
              <Row label={t("req.techProfile.estArrival")} value={fmtDuration(tech.responseMins, lang)} />
              <Row label={t("req.techProfile.experience")} value={`${isFa ? toPersianDigits(tech.experienceYears) : tech.experienceYears} ${t("common.yrs")}`} />
              <Row label={t("req.techProfile.level")} value={tech.level} />
              <Row label={t("fees.totalEstimate")} value={money(Number(tech.hourlyRate) * 0.5 + Number(tech.travelFeeBase))} />
            </div>
            <div className="mt-3 rounded-lg border border-amber/30 bg-amber/5 p-3 text-[11px] text-muted-foreground">
              <ShieldCheck className="mr-1 inline size-3.5 text-amber" />
              {t("req.techProfile.guarantee")}
            </div>
            <Button onClick={request} disabled={requesting} className="mt-3 w-full bg-amber text-black hover:bg-amber/90">
              {requesting ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Zap className="mr-2 size-4" />}
              {t("req.techProfile.requestNow")}
            </Button>
            <p className="mt-2 text-center text-[10px] text-muted-foreground">{t("req.techProfile.noCharge")}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-border/60 py-1.5 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

// ─── Shared step header ───
function StepHeader({ step, total, title, subtitle, onBack }: { step: number; total: number; title: string; subtitle?: string; onBack: () => void }) {
  const { t, isFa } = useT();
  const stepLabel = isFa
    ? `${t("req.step")} ${String(step).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)])} ${t("req.stepOf")} ${String(total).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)])}`
    : `${t("req.step")} ${step} ${t("req.stepOf")} ${total}`;
  return (
    <div className="flex items-center gap-3">
      <Button variant="ghost" size="icon" className="size-8" onClick={onBack}>
        <ChevronLeft className="size-4 rtl:hidden" />
        <ChevronRight className="size-4 hidden rtl:block" />
      </Button>
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-widest text-amber">{stepLabel}</span>
          <div className="h-px flex-1 bg-border" />
        </div>
        <h1 className="mt-1 font-display text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
      </div>
    </div>
  );
}
