export const DEMO_AUTH_COOKIE = "demo_auth";

/** Deterministic session token derived from DEMO_PASSWORD. Edge-safe (Web Crypto). */
export async function demoAuthToken(password: string): Promise<string> {
  const data = new TextEncoder().encode(`churning-demo:${password}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
