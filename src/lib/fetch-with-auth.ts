// MEKANIX — Authenticated fetch helper for components that use raw fetch()
// This ensures JWT token is attached to all requests.

export function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (typeof window !== "undefined") {
    const token = localStorage.getItem("mekanix-token");
    if (token) headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

export async function authFetch(url: string, init?: RequestInit): Promise<Response> {
  const headers = {
    ...getAuthHeaders(),
    ...(init?.headers as Record<string, string> ?? {}),
  };
  const res = await fetch(url, { ...init, headers });
  
  if (res.status === 401 && typeof window !== "undefined") {
    localStorage.removeItem("mekanix-token");
  }
  
  return res;
}
