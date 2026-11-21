// Lite Response — compresses API responses for weak internet (per ARCHITECTURE.md §16).
// When ?lite=true is passed, returns minimal fields.

export function liteResponse<T>(data: T, lite: boolean): T | any {
  if (!lite) return data;

  // For arrays, map to lite format
  if (Array.isArray(data)) {
    return data.map(liteMapper);
  }

  // For objects, apply lite mapper
  return liteMapper(data);
}

function liteMapper(item: any): any {
  if (!item || typeof item !== "object") return item;

  // Common lite fields
  const lite: any = {};

  // Always include id
  if (item.id) lite.id = item.id;

  // Status (for jobs, bookings, etc.)
  if (item.status) lite.status = item.status;

  // Name (for users, technicians)
  if (item.name) lite.name = item.name;

  // Code (for jobs, bookings, invoices)
  if (item.code) lite.code = item.code;

  // Price/total (for invoices, bookings)
  if (item.total !== undefined) lite.total = item.total;
  if (item.amount !== undefined) lite.amt = item.amount;

  // Timestamps (shortened)
  if (item.createdAt) lite.ts = new Date(item.createdAt).getTime();

  // Technician name (for jobs)
  if (item.technician?.user?.name) lite.tech = item.technician.user.name;

  // Vehicle info (for jobs)
  if (item.vehicle) {
    lite.v = `${item.vehicle.make} ${item.vehicle.model}`;
  }

  return lite;
}

// Check if request wants lite response
export function wantsLite(req: Request): boolean {
  const url = new URL(req.url);
  return url.searchParams.get("lite") === "true";
}
