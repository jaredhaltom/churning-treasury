import fs from "node:fs";
import path from "node:path";

/**
 * Single source of truth for "is this instance a public demo deploy?".
 * Exposed via NEXT_PUBLIC_ so both server and client bundles can read it
 * without leaking other env vars.
 */
export const IS_DEMO = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

/**
 * Path to the read-only seeded SQLite database that ships in the build
 * artifact. Resolved relative to the project root at runtime so it works
 * inside Vercel's serverless function bundle.
 */
export const DEMO_DB_SOURCE = path.resolve(process.cwd(), "prisma/demo.db");

/**
 * Path to the runtime, writable copy of the demo DB. On Vercel only `/tmp`
 * is writable; on local dev this still works because /tmp exists on macOS
 * and Linux. The container-local nature of /tmp is exactly what gives us
 * per-cold-start isolation between visitors.
 */
export const DEMO_DB_RUNTIME = "/tmp/demo.db";

/**
 * Connection string that Prisma should use when IS_DEMO is true. We always
 * point at the writable runtime copy, never the read-only seed file.
 */
export const DEMO_DB_URL = `file:${DEMO_DB_RUNTIME}`;

let bootstrapped = false;

/**
 * Idempotently copy the seeded template DB into /tmp so Prisma can read AND
 * write to it. Safe to call on every Prisma client instantiation: the
 * existence check short-circuits after the first call per container.
 *
 * Throws (loudly) if the source file is missing — that means the build
 * pipeline didn't run `scripts/seed-demo.ts` and we'd otherwise serve an
 * empty database silently.
 */
export function bootstrapDemoDb(): void {
  if (bootstrapped) return;
  if (!IS_DEMO) return;

  if (!fs.existsSync(DEMO_DB_SOURCE)) {
    throw new Error(
      `[demo] Expected seeded database at ${DEMO_DB_SOURCE}. ` +
        `Did the build step run \`npm run build:demo\`?`,
    );
  }

  if (!fs.existsSync(DEMO_DB_RUNTIME)) {
    fs.copyFileSync(DEMO_DB_SOURCE, DEMO_DB_RUNTIME);
  }

  bootstrapped = true;
}
