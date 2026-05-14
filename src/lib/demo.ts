/**
 * Single source of truth for "is this instance the public demo deploy?".
 *
 * Exposed via NEXT_PUBLIC_ so both server and client bundles can read it.
 * The value is inlined at build time by next.config.ts so server and client
 * agree (no hydration mismatch) regardless of dashboard env config.
 *
 * In demo mode:
 *   - Plaid API routes return 503 (we never want to hit the real Plaid API
 *     from an unauthenticated demo).
 *   - The PlaidLinkButton is replaced with a "disabled in demo" notice.
 *   - The DemoBanner is rendered.
 *   - The Prisma datasource points at a shared serverless Postgres so writes
 *     persist across Vercel lambdas — see scripts/build-demo-schema.ts.
 */
export const IS_DEMO = process.env.NEXT_PUBLIC_DEMO_MODE === "true";
