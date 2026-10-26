// MEKANIX — Database seed script
// Run with: bun run prisma/seed.ts
// Or auto-seeds on first dev server start via src/lib/auto-seed.ts
import { PrismaClient } from "@prisma/client";

// Use the global seed db if set (by auto-seed), otherwise create our own.
function getDb(): PrismaClient {
  return (globalThis as any).__seedDb ?? new PrismaClient();
}

let db = getDb();

const now = Date.now();
const day = 86400000;
const iso = (offsetMs: number) => new Date(now + offsetMs);

async function main() {
  console.log("🌱 Seeding MEKANIX database...");

  // Wipe (order matters for FK)
  await db.notification.deleteMany();
  await db.payment.deleteMany();
  await db.invoice.deleteMany();
  await db.warranty.deleteMany();
  await db.review.deleteMany();
  await db.message.deleteMany();
  await db.trackingEvent.deleteMany();
  await db.part.deleteMany();
  await db.diagnosis.deleteMany();
  await db.job.deleteMany();
  await db.serviceRequest.deleteMany();
  await db.serviceArea.deleteMany();
  await db.certification.deleteMany();
  await db.technicianSpecialty.deleteMany();
  await db.technician.deleteMany();
  await db.vehicle.deleteMany();
  await db.customer.deleteMany();
  await db.serviceCategory.deleteMany();
  await db.user.deleteMany();

  // ── Admin ──
  const adminUser = await db.user.create({
    data: {
      email: "ops@mekanix.io",
      name: "MEKANIX Operations",
      role: "ADMIN",
      phone: "+1-415-000-0000",
      avatar: "https://i.pravatar.cc/150?img=68",
    },
  });

  // ── Customers ──
  const customers = [
    { name: "Daniel Reyes", email: "daniel.reyes@fleetco.com", phone: "+1-415-224-1180", company: "Reyes Logistics Co.", avatar: "https://i.pravatar.cc/150?img=12", country: "US" },
    { name: "Amara Okafor", email: "amara@buildright.io", phone: "+1-512-990-2210", company: "BuildRight Construction", avatar: "https://i.pravatar.cc/150?img=45", country: "US" },
    { name: "Lukas Brandt", email: "lukas.brandt@deutsche-logistik.de", phone: "+49-151-2290-884", company: "Brandt Transport GmbH", avatar: "https://i.pravatar.cc/150?img=33", country: "DE" },
    { name: "Sara Lindqvist", email: "sara@nordicfarms.se", phone: "+46-70-553-1200", company: "Nordic Farms AB", avatar: "https://i.pravatar.cc/150?img=20", country: "DE" },
    { name: "Mateo Herrera", email: "mateo@urbantransit.mx", phone: "+52-55-2290-1180", company: "Urban Transit Authority", avatar: "https://i.pravatar.cc/150?img=51", country: "AE" },
  ];

  const customerRecs: any[] = [];
  for (const c of customers) {
    const u = await db.user.create({
      data: {
        email: c.email,
        name: c.name,
        phone: c.phone,
        role: "CUSTOMER",
        avatar: c.avatar,
        country: c.country,
      },
    });
    const cust = await db.customer.create({
      data: { userId: u.id, company: c.company, taxId: `TIN-${Math.floor(Math.random() * 900000 + 100000)}` },
    });
    customerRecs.push({ user: u, customer: cust, company: c.company });
  }

  // ── Technicians ──
  const techs = [
    { name: "Marcus Cole", email: "marcus.cole@mekanix.io", specialties: [["engine", "Diesel Engines"], ["heavy-diesel", "Heavy Duty"], ["diagnostic", "OBD Diagnostics"]], certs: [["ASE Master Technician", "ASE", 2019, true], ["Cummins ISX Specialist", "Cummins", 2021, true]], lat: 37.7749, lng: -122.4194, rate: 78, exp: 14, completed: 412, rating: 4.9, level: "PLATINUM", available: true, bio: "Master diesel technician specialized in heavy-duty trucks and construction equipment. 14 years on the road." },
    { name: "Priya Nair", email: "priya.nair@mekanix.io", specialties: [["electrical", "Auto Electrical"], ["diagnostic", "Computer Diagnostics"], ["battery", "EV & Hybrid"]], certs: [["ASE Electrical/Electronic Systems", "ASE", 2020, true], ["Tesla Service Certified", "Tesla", 2022, true]], lat: 37.7812, lng: -122.4140, rate: 72, exp: 9, completed: 287, rating: 4.8, level: "GOLD", available: true, bio: "EV/Hybrid & diagnostics specialist. Former dealership lead tech." },
    { name: "Hassan Al-Farsi", email: "hassan.alfarsi@mekanix.io", specialties: [["hydraulic", "Hydraulics"], ["heavy-diesel", "Excavators"], ["engine", "Diesel Pumps"]], certs: [["Caterpillar Certified Technician", "Caterpillar", 2018, true], ["Hydraulic Systems Specialist", "NFPA", 2020, false]], lat: 37.7649, lng: -122.4294, rate: 84, exp: 16, completed: 506, rating: 4.95, level: "PLATINUM", available: true, bio: "Heavy machinery hydraulics expert. CAT & Komatsu certified." },
    { name: "Elena Volkova", email: "elena.volkova@mekanix.io", specialties: [["brakes", "Brake Systems"], ["tire", "Tires & Alignment"], ["ac", "HVAC"]], certs: [["ASE Brakes", "ASE", 2021, true]], lat: 37.8044, lng: -122.4394, rate: 58, exp: 6, completed: 168, rating: 4.7, level: "SILVER", available: true, bio: "Light vehicle specialist. Fast, thorough, customer favorite." },
    { name: "Tobias Klein", email: "tobias.klein@mekanix.io", specialties: [["transmission", "Transmissions"], ["engine", "Gearboxes"], ["heavy-diesel", "Bus Fleets"]], certs: [["ZF Transmission Specialist", "ZF", 2019, true], ["Allison Certified", "Allison", 2020, true]], lat: 37.7937, lng: -122.4089, rate: 90, exp: 19, completed: 631, rating: 4.92, level: "PLATINUM", available: false, bio: "Transmission guru. 19 years servicing bus & truck fleets." },
    { name: "Naomi Adeyemi", email: "naomi.adeyemi@mekanix.io", specialties: [["electrical", "Wiring"], ["diagnostic", "Diagnostics"], ["battery", "Alternators"]], certs: [["ASE Electrical", "ASE", 2022, false]], lat: 37.7597, lng: -122.4108, rate: 52, exp: 4, completed: 96, rating: 4.6, level: "BRONZE", available: true, bio: "Rising talent. Electrical & diagnostics focus." },
    { name: "Yuki Tanaka", email: "yuki.tanaka@mekanix.io", specialties: [["agri", "Tractors"], ["hydraulic", "PTO Systems"], ["engine", "Compact Diesels"]], certs: [["John Deere Certified Tech", "John Deere", 2020, true]], lat: 37.7719, lng: -122.4639, rate: 68, exp: 11, completed: 318, rating: 4.85, level: "GOLD", available: true, bio: "Agricultural machinery specialist. JD & Kubota certified." },
    { name: "Omar Saleh", email: "omar.saleh@mekanix.io", specialties: [["roadside", "Emergency Roadside"], ["battery", "Jumpstarts"], ["tire", "Tire Changes"]], certs: [["Towing & Recovery Operator", "TOW", 2021, true]], lat: 37.7886, lng: -122.4018, rate: 60, exp: 8, completed: 254, rating: 4.75, level: "SILVER", available: true, bio: "Rapid response roadside expert. 8 yrs, 254 rescues." },
  ];

  const techRecs: any[] = [];
  for (let i = 0; i < techs.length; i++) {
    const t = techs[i];
    const u = await db.user.create({
      data: { email: t.email, name: t.name, role: "TECHNICIAN", phone: `+1-415-200-${1000 + i}`, avatar: `https://i.pravatar.cc/150?img=${60 + i}`, country: "US" },
    });
    const tech = await db.technician.create({
      data: {
        userId: u.id,
        bio: t.bio,
        experienceYears: t.exp,
        completedJobs: t.completed,
        rating: t.rating,
        reviewCount: Math.floor(t.completed * 0.4),
        hourlyRate: t.rate,
        travelFeeBase: 3 + i * 0.5, // USD, ~180k-450k IRR — Sanjaq-like
        inspectionFee: 7 + (i % 3) * 2, // USD passenger, ~420k-660k IRR
        inspectionFeeHeavy: 20 + (i % 4) * 5, // USD heavy, ~1.2M-1.8M IRR
        status: t.available ? "ONLINE" : "OFFLINE",
        availableNow: t.available,
        verified: true,
        level: t.level as any,
        lat: t.lat,
        lng: t.lng,
        heading: Math.random() * 360,
        responseMins: 8 + Math.floor(Math.random() * 12),
      },
    });
    // create wallet for each technician
    await db.wallet.create({
      data: {
        technicianId: tech.id,
        balance: 50 + i * 25, // seed some withdrawable balance
        pendingBalance: 20 + i * 10, // seed some held balance
        totalEarned: 200 + i * 80,
        totalCommission: 20 + i * 8,
        totalWithdrawn: 100 + i * 30,
      },
    });
    for (const [cat, label] of t.specialties) {
      await db.technicianSpecialty.create({ data: { technicianId: tech.id, category: cat, label } });
    }
    for (const cert of t.certs) {
      const [name, issuer, year, verified] = cert as [string, string, number, boolean];
      await db.certification.create({ data: { technicianId: tech.id, name, issuer, year, verified } });
    }
    await db.serviceArea.create({
      data: { technicianId: tech.id, name: ["San Francisco – Downtown", "SoMa District", "Mission Bay", "Bayview", "Financial District", "Sunset", "Richmond", "Marina"][i % 8], lat: t.lat, lng: t.lng, radiusKm: 18 + (i % 4) * 6 },
    });
    techRecs.push({ user: u, tech, ...t });
  }

  // ── VIP Plans ──
  const vipPlans = [
    { slug: "silver", name: "Silver", priceIrr: 9, durationDays: 30, discountPct: 10, priorityBoost: 1, warrantyMonths: 6, dedicatedSupport: false, freeInspectionsPerMonth: 0, order: 1 },
    { slug: "gold", name: "Gold", priceIrr: 19, durationDays: 30, discountPct: 20, priorityBoost: 3, warrantyMonths: 12, dedicatedSupport: true, freeInspectionsPerMonth: 2, order: 2 },
    { slug: "platinum", name: "Platinum", priceIrr: 39, durationDays: 90, discountPct: 30, priorityBoost: 5, warrantyMonths: 24, dedicatedSupport: true, freeInspectionsPerMonth: 5, order: 3 },
  ];
  for (const p of vipPlans) {
    await db.vipPlan.create({ data: p });
  }

  // ── Service Categories ──
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
  for (const c of cats) {
    await db.serviceCategory.create({ data: c });
  }

  // ── Vehicles ──
  const vehiclesData = [
    { customerIdx: 0, type: "TRUCK", make: "Volvo", model: "VNL 760", year: 2021, plate: "LGC-4471", engineHours: 6840, lat: 37.7749, lng: -122.4194, location: "I-280 N, Mile 42" },
    { customerIdx: 0, type: "TRUCK", make: "Freightliner", model: "Cascadia", year: 2019, plate: "LGC-9930", engineHours: 9120, lat: 37.7599, lng: -122.4148, location: "Oakland Yard" },
    { customerIdx: 1, type: "EXCAVATOR", make: "Caterpillar", model: "320 GC", year: 2022, plate: "BLD-220", engineHours: 2210, lat: 37.7649, lng: -122.4294, location: "Mission Bay Site A" },
    { customerIdx: 1, type: "LOADER", make: "Komatsu", model: "WA270-8", year: 2020, plate: "BLD-118", engineHours: 3140, lat: 37.7691, lng: -122.4010, location: "SoMa Excavation" },
    { customerIdx: 2, type: "BUS", make: "Mercedes-Benz", model: "O 530 Citaro", year: 2018, plate: "M-BRN-2290", engineHours: 18400, lat: 52.52, lng: 13.405, location: "Brandt Depot, Berlin" },
    { customerIdx: 3, type: "AGRI", make: "John Deere", model: "6155M Tractor", year: 2021, plate: "NF-1180", engineHours: 1480, lat: 37.7812, lng: -122.4140, location: "North Field" },
    { customerIdx: 3, type: "BULLDOZER", make: "Liebherr", model: "PR 736 Litronic", year: 2020, plate: "NF-2240", engineHours: 1980, lat: 37.7790, lng: -122.4180, location: "South Field" },
    { customerIdx: 4, type: "CAR", make: "Tesla", model: "Model 3 Long Range", year: 2022, plate: "MX-2200", lat: 37.7886, lng: -122.4018, location: "Home Garage" },
    { customerIdx: 4, type: "CAR", make: "Toyota", model: "Hilux 2.8", year: 2020, plate: "MX-9912", lat: 37.7700, lng: -122.4300, location: "Office Lot" },
    { customerIdx: 4, type: "GRADER", make: "Volvo", model: "G946B", year: 2019, plate: "CIV-880", engineHours: 4120, lat: 37.7620, lng: -122.4350, location: "Highway 101 Section 7" },
  ];

  const vehicleRecs: any[] = [];
  for (const v of vehiclesData) {
    const cust = customerRecs[v.customerIdx].customer;
    const rec = await db.vehicle.create({
      data: {
        customerId: cust.id,
        type: v.type as any,
        make: v.make,
        model: v.model,
        year: v.year,
        plate: v.plate,
        engineHours: v.engineHours ?? null,
        lat: v.lat,
        lng: v.lng,
        location: v.location,
        notes: "",
      },
    });
    vehicleRecs.push(rec);
  }

  // ── Service Requests + Jobs (a realistic spread across statuses) ──
  const scenarios = [
    { vIdx: 0, cat: "engine", urgency: "EMERGENCY", title: "Loud knocking under load at 1600 RPM", desc: "Volvo VNL started making a heavy metallic knock while climbing grades. Loss of power, slight coolant smell. Needs immediate diagnosis — truck is on the shoulder of I-280.", status: "REPAIRING", techIdx: 0, eta: 18 },
    { vIdx: 2, cat: "hydraulic", urgency: "URGENT", title: "Excavator boom drifts down under load", desc: "CAT 320 GC boom slowly drops when holding a load. Suspect main control valve or cylinder seals. Production stopped on site.", status: "DIAGNOSING", techIdx: 2, eta: 22 },
    { vIdx: 4, cat: "electrical", urgency: "NORMAL", title: "Citaro dashboard warning cluster flickering", desc: "Intermittent electrical fault — dash cluster flickers and ABS lamp triggers at random. Already checked battery terminals.", status: "EN_ROUTE", techIdx: 1, eta: 9 },
    { vIdx: 5, cat: "agri", urgency: "NORMAL", title: "Tractor PTO not engaging in 540 mode", desc: "John Deere 6155M — PTO engages in 1000 RPM mode but not 540. Hydraulic clutch suspect.", status: "ARRIVED", techIdx: 6, eta: 0 },
    { vIdx: 7, cat: "battery", urgency: "URGENT", title: "Model 3 won't wake — 12V low voltage warning", desc: "Tesla Model 3 throwing low voltage warning, won't enter drive. Need mobile 12V diagnostic + replacement.", status: "WAITING_APPROVAL", techIdx: 1, eta: 0 },
    { vIdx: 1, cat: "brakes", urgency: "NORMAL", title: "Air dryer purge cycling too often", desc: "Freightliner Cascadia air system cycling every 45s. Suspect air dryer cartridge or governor.", status: "COMPLETED", techIdx: 4, eta: 0 },
    { vIdx: 9, cat: "roadside", urgency: "EMERGENCY", title: "Grader front tire blowout on highway shoulder", desc: "Volvo G946B suffered a front tire failure on Highway 101 section 7. Need immediate roadside tire service.", status: "ACCEPTED", techIdx: 7, eta: 14 },
    { vIdx: 8, cat: "ac", urgency: "NORMAL", title: "Hilux AC blowing warm after 10 minutes", desc: "AC works cold for ~10 min then goes warm. Likely expansion valve or low refrigerant.", status: "COMPLETED", techIdx: 3, eta: 0 },
  ];

  let srCounter = 2030;
  let jobCounter = 4010;
  const createdJobs: any[] = [];

  for (let i = 0; i < scenarios.length; i++) {
    const s = scenarios[i];
    const v = vehicleRecs[s.vIdx];
    const cust = customerRecs[vehiclesData[s.vIdx].customerIdx];
    const tech = techRecs[s.techIdx];

    const srCode = `SR-${srCounter++}`;
    const createdAgo = (i + 1) * day * 0.4 + Math.random() * day * 0.2;
    const sr = await db.serviceRequest.create({
      data: {
        code: srCode,
        customerId: cust.customer.id,
        vehicleId: v.id,
        category: s.cat,
        urgency: s.urgency as any,
        title: s.title,
        description: s.desc,
        mediaUrls: JSON.stringify([]),
        address: v.location ?? "On-site",
        lat: v.lat ?? 37.77,
        lng: v.lng ?? -122.42,
        status: s.status === "REQUESTED" ? "OPEN" : "ASSIGNED",
        matchedTechId: tech.tech.id,
        createdAt: iso(-createdAgo),
        updatedAt: iso(-createdAgo + day * 0.1),
      },
    });

    const jobCode = `JOB-${jobCounter++}`;
    const startedAgo = createdAgo - day * 0.1;
    const job = await db.job.create({
      data: {
        code: jobCode,
        requestId: sr.id,
        technicianId: tech.tech.id,
        status: s.status as any,
        etaMins: s.eta,
        customerApproved: ["WAITING_APPROVAL", "REPAIRING", "COMPLETED"].includes(s.status),
        diagnosis: ["DIAGNOSING", "REPAIRING", "WAITING_APPROVAL", "COMPLETED"].includes(s.status) ? "Confirmed: main bearing wear on cylinder 4; turbo boost leak at intercooler clamp. Recommend in-frame bearing replacement + reseal." : null,
        technicianNotes: s.status === "COMPLETED" ? "Replaced bearings, retorqued rods, reseated turbo clamp. Road-tested 25mi. Pressure normal." : null,
        replacedParts: ["REPAIRING", "COMPLETED"].includes(s.status) ? JSON.stringify([{ name: "Main Bearing Set (STD)", sku: "MB-4471", qty: 1, unitPrice: 340 }, { name: "Turbo Intercooler Clamp", sku: "TC-220", qty: 2, unitPrice: 28 }]) : null,
        startedAt: ["EN_ROUTE", "ARRIVED", "DIAGNOSING", "REPAIRING", "WAITING_APPROVAL", "COMPLETED"].includes(s.status) ? iso(-startedAgo) : null,
        arrivedAt: ["ARRIVED", "DIAGNOSING", "REPAIRING", "WAITING_APPROVAL", "COMPLETED"].includes(s.status) ? iso(-startedAgo + day * 0.05) : null,
        completedAt: s.status === "COMPLETED" ? iso(-day * (i === 5 ? 3 : 1)) : null,
        createdAt: iso(-createdAgo),
        updatedAt: iso(-createdAgo + day * 0.3),
      },
    });
    createdJobs.push({ job, sr, s, tech, cust, v });

    // Tracking events (simulate a route)
    if (["ACCEPTED", "EN_ROUTE", "ARRIVED", "DIAGNOSING", "REPAIRING", "WAITING_APPROVAL", "COMPLETED"].includes(s.status)) {
      const fromLat = tech.lat ?? 37.77;
      const fromLng = tech.lng ?? -122.42;
      const toLat = v.lat ?? 37.77;
      const toLng = v.lng ?? -122.42;
      const steps = 6;
      for (let k = 0; k <= steps; k++) {
        const f = k / steps;
        await db.trackingEvent.create({
          data: {
            jobId: job.id,
            lat: fromLat + (toLat - fromLat) * f,
            lng: fromLng + (toLng - fromLng) * f,
            heading: Math.random() * 360,
            ts: iso(-startedAgo + (k * (startedAgo - (s.status === "ARRIVED" ? startedAgo * 0.5 : 0))) / steps),
          },
        });
      }
    }

    // Messages
    await db.message.create({
      data: { jobId: job.id, fromUserId: cust.user.id, kind: "text", body: "Hi, can you confirm you're coming today?", createdAt: iso(-createdAgo + 3600_000) },
    });
    await db.message.create({
      data: { jobId: job.id, fromUserId: tech.user.id, kind: "text", body: "Confirmed — on my way. ETA in app.", createdAt: iso(-createdAgo + 5400_000) },
    });
    if (["DIAGNOSING", "REPAIRING", "WAITING_APPROVAL", "COMPLETED"].includes(s.status)) {
      await db.message.create({
        data: { jobId: job.id, fromUserId: tech.user.id, kind: "system", body: "Diagnosis complete: bearing wear + boost leak. Estimate ready.", createdAt: iso(-createdAgo + 7200_000) },
      });
    }

    // Invoice + payment for WAITING_APPROVAL & COMPLETED
    if (["WAITING_APPROVAL", "COMPLETED"].includes(s.status)) {
      const laborHours = s.status === "COMPLETED" ? 4.5 : 2;
      const laborRate = Number(tech.tech.hourlyRate);
      const laborTotal = laborHours * laborRate;
      const partsTotal = s.status === "COMPLETED" ? 396 : 396;
      const travelFee = Number(tech.tech.travelFeeBase);
      const subtotal = laborTotal + partsTotal + travelFee;
      const taxTotal = subtotal * 0.09;
      const total = subtotal + taxTotal;
      const inv = await db.invoice.create({
        data: {
          code: `INV-${3000 + i}`,
          jobId: job.id,
          laborHours,
          laborRate,
          laborTotal,
          partsTotal,
          travelFee,
          subtotal,
          taxRate: 0.09,
          taxTotal,
          discount: 0,
          total,
          currency: "IRR",
          notes: "Parts covered by 6-month warranty.",
          status: s.status === "COMPLETED" ? "PAID" : "SENT",
          createdAt: iso(-day),
        },
      });
      if (s.status === "COMPLETED") {
        await db.payment.create({
          data: {
            code: `PAY-${5000 + i}`,
            invoiceId: inv.id,
            userId: cust.user.id,
            amount: total,
            currency: "IRR",
            method: "card",
            status: "SUCCEEDED",
            createdAt: iso(-day * 0.5),
          },
        });
        await db.warranty.create({ data: { jobId: job.id, months: 6, kmLimit: 50000, terms: "Parts & labor covered. Excludes misuse.", active: true } });
        await db.review.create({
          data: {
            jobId: job.id,
            technicianId: tech.tech.id,
            fromUserId: cust.user.id,
            rating: 5,
            comment: "Fast, professional, and explained everything. Truck is back on the road.",
            tags: JSON.stringify(["punctual", "knowledgeable", "clean-work"]),
            createdAt: iso(-day * 0.4),
          },
        });
      }
    }
  }

  // ── Notifications for admin + customer 0 + technician 0 ──
  const notifTargets = [
    { userId: adminUser.id, type: "new_request", title: "New emergency request", body: "SR-2030 — Volvo VNL breakdown on I-280", category: "job", link: "admin/jobs" },
    { userId: customerRecs[0].user.id, type: "request_accepted", title: "Marcus accepted your request", body: "Technician en route — ETA 18 min", category: "job", link: "customer/track" },
    { userId: customerRecs[0].user.id, type: "technician_arriving", title: "Technician arriving soon", body: "Marcus is 4 minutes away", category: "job", link: "customer/track" },
    { userId: customerRecs[0].user.id, type: "maintenance_reminder", title: "Maintenance due", body: "Your Volvo VNL 760 is due for an oil change in 1,200 km", category: "maintenance", link: "customer/vehicles" },
    { userId: techRecs[0].user.id, type: "new_request", title: "New job match", body: "Emergency engine diagnosis nearby — $78/hr", category: "job", link: "technician/requests" },
    { userId: customerRecs[0].user.id, type: "estimate_ready", title: "Estimate ready for approval", body: "Review and approve your repair estimate", category: "job", link: "customer/invoice" },
    { userId: customerRecs[0].user.id, type: "new_message", title: "New message from Marcus", body: "Diagnosis complete — estimate ready", category: "message", link: "customer/chat" },
  ];
  for (let i = 0; i < notifTargets.length; i++) {
    const n = notifTargets[i];
    await db.notification.create({
      data: { ...n, read: i % 3 === 0, createdAt: iso(-(i + 1) * 1800_000) },
    });
  }

  // extra completed historical jobs for service history richness
  for (let i = 0; i < 6; i++) {
    const cust = customerRecs[i % customerRecs.length];
    const tech = techRecs[i % techRecs.length];
    const v = vehicleRecs[i % vehicleRecs.length];
    const ago = (i + 2) * day * 6;
    const sr = await db.serviceRequest.create({
      data: {
        code: `SR-${1980 + i}`,
        customerId: cust.customer.id,
        vehicleId: v.id,
        category: ["engine", "brakes", "diagnostic", "ac", "tire", "preventive"][i],
        urgency: "NORMAL",
        title: ["Oil & filter service", "Brake pad replacement", "Full OBD scan", "AC recharge", "Tire rotation", "Scheduled service"][i],
        description: "Routine scheduled maintenance performed on-site.",
        mediaUrls: "[]",
        address: v.location ?? "On-site",
        lat: v.lat ?? 37.77,
        lng: v.lng ?? -122.42,
        status: "ASSIGNED",
        matchedTechId: tech.tech.id,
        createdAt: iso(-ago),
        updatedAt: iso(-ago + day),
      },
    });
    const job = await db.job.create({
      data: {
        code: `JOB-${3900 + i}`,
        requestId: sr.id,
        technicianId: tech.tech.id,
        status: "COMPLETED",
        etaMins: 0,
        customerApproved: true,
        diagnosis: "Routine inspection completed. No major faults.",
        technicianNotes: "Serviced per spec. All systems nominal.",
        replacedParts: JSON.stringify([{ name: "Oil Filter", sku: "OF-001", qty: 1, unitPrice: 22 }, { name: "Synthetic Oil 15W40", sku: "OIL-5", qty: 5, unitPrice: 14 }]),
        startedAt: iso(-ago + day * 0.2),
        arrivedAt: iso(-ago + day * 0.25),
        completedAt: iso(-ago + day * 0.5),
        createdAt: iso(-ago),
        updatedAt: iso(-ago + day * 0.5),
      },
    });
    const laborTotal = 1.5 * Number(tech.tech.hourlyRate);
    const partsTotal = 92;
    const travelFee = Number(tech.tech.travelFeeBase);
    const subtotal = laborTotal + partsTotal + travelFee;
    const taxTotal = subtotal * 0.09;
    const total = subtotal + taxTotal;
    const inv = await db.invoice.create({
      data: {
        code: `INV-${2900 + i}`,
        jobId: job.id,
        laborHours: 1.5,
        laborRate: tech.tech.hourlyRate,
        laborTotal,
        partsTotal,
        travelFee,
        subtotal,
        taxRate: 0.09,
        taxTotal,
        discount: 0,
        total,
        currency: "IRR",
        status: "PAID",
        createdAt: iso(-ago + day * 0.5),
      },
    });
    await db.payment.create({
      data: { code: `PAY-${4900 + i}`, invoiceId: inv.id, userId: cust.user.id, amount: total, currency: "IRR", method: "card", status: "SUCCEEDED", createdAt: iso(-ago + day * 0.45) },
    });
    await db.warranty.create({ data: { jobId: job.id, months: 6, active: true } });
    await db.review.create({
      data: { jobId: job.id, technicianId: tech.tech.id, fromUserId: cust.user.id, rating: 4 + (i % 2), comment: ["Solid work as always.", "Quick and clean.", "Great communication.", "Back up and running.", "Good value.", "Will book again."][i], createdAt: iso(-ago + day * 0.4) },
    });
  }

  // ── Mechanic Applications (for admin review queue) ──
  await db.mechanicApplication.deleteMany();
  const apps = [
    { fullName: "Reza Karimi", phone: "+989121118011", email: "reza.karimi@gmail.com", city: "Tehran", exp: 7, specs: ["engine", "heavy-diesel", "diagnostic"], bio: "Heavy truck specialist, 7 yrs at a Volvo dealership.", vehicle: true },
    { fullName: "Carlos Mendez", phone: "+14155550222", email: "carlos.mendez@outlook.com", city: "Oakland", exp: 5, specs: ["electrical", "diagnostic", "battery"], bio: "EV & hybrid certified, mobile since 2021.", vehicle: true },
    { fullName: "Fatima Zahra", phone: "+989354449900", email: null, city: "Isfahan", exp: 3, specs: ["brakes", "tire", "ac"], bio: "Light vehicle mechanic, looking to go mobile.", vehicle: false },
    { fullName: "Ivan Petrov", phone: "+491511220099", email: "ivan.petrov@mail.de", city: "Munich", exp: 12, specs: ["hydraulic", "heavy-diesel", "engine"], bio: "Construction equipment specialist, CAT & Liebherr.", vehicle: true },
  ];
  for (let i = 0; i < apps.length; i++) {
    const a = apps[i];
    await db.mechanicApplication.create({
      data: {
        code: `APP-${2000 + i}`,
        fullName: a.fullName,
        phone: a.phone,
        email: a.email,
        city: a.city,
        experienceYears: a.exp,
        specialties: JSON.stringify(a.specs),
        bio: a.bio,
        vehicleOwned: a.vehicle,
        status: i < 3 ? "PENDING" : "APPROVED",
        createdAt: iso(-(i + 1) * day * 0.5),
      },
    });
  }

  console.log("✅ Seed complete.");
  console.log(`   Users: ${await db.user.count()}`);
  console.log(`   Technicians: ${await db.technician.count()}`);
  console.log(`   Vehicles: ${await db.vehicle.count()}`);
  console.log(`   Jobs: ${await db.job.count()}`);
  console.log(`   Invoices: ${await db.invoice.count()}`);
}

// Export the seed function so it can be called from auto-seed.ts
// (which runs automatically on first dev server start).
export async function seedDatabase(dbClient: any): Promise<void> {
  // Re-use the same logic but with a passed-in db client
  const originalDb = (globalThis as any).__seedDb;
  (globalThis as any).__seedDb = dbClient;
  try {
    await main();
  } finally {
    (globalThis as any).__seedDb = originalDb;
  }
}

// If this file is run directly (not imported), execute main().
if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => db.$disconnect());
}
