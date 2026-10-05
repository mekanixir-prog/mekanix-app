// MEKANIX — Server initialization
// This module initializes runtime providers (ETA, SMS, Redis, etc.)
// Import this once in the server entry point or API middleware.

import { initEtaProvider } from "./eta-provider";
import { initSmsProvider } from "./sms-provider";

let initialized = false;

export function initServer(): void {
  if (initialized) return;
  initialized = true;

  // Initialize ETA provider from env (Neshan/Google/OSRM/default)
  initEtaProvider();

  // Initialize SMS provider from env (Kavenegar/MeliPayamak/Farapayamak/console)
  initSmsProvider();

  // Redis is lazy-loaded in src/lib/redis.ts — no init needed here
  console.log("🚀 MEKANIX server initialized");
}

// Auto-initialize on first import (for API routes)
initServer();
