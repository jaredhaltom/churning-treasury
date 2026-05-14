import { createHash } from "node:crypto";

export const DEMO_AUTH_COOKIE = "demo_auth";

/** Deterministic session token derived from DEMO_PASSWORD. Never store the raw password in the cookie. */
export function demoAuthToken(password: string): string {
  return createHash("sha256").update(`churning-demo:${password}`).digest("hex");
}
