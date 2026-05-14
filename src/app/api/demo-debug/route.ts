import fs from "node:fs";
import { NextResponse } from "next/server";

import { DEMO_DB_BASE64 } from "@/lib/demo-db-data";
import { DEMO_DB_RUNTIME, DEMO_DB_URL, IS_DEMO, bootstrapDemoDb } from "@/lib/demo";

// Temporary diagnostics endpoint. Returns the values that gate the demo-mode
// code path so we can verify what Vercel actually sees at request time.
//
// Safe to expose publicly: only reveals demo-mode metadata, not real data.
// Delete once the deploy is healthy.
export async function GET() {
  const env = {
    NEXT_PUBLIC_DEMO_MODE: process.env.NEXT_PUBLIC_DEMO_MODE ?? null,
    DATABASE_URL: process.env.DATABASE_URL ?? null,
    NODE_ENV: process.env.NODE_ENV ?? null,
    VERCEL: process.env.VERCEL ?? null,
    VERCEL_ENV: process.env.VERCEL_ENV ?? null,
  };

  const before = {
    runtimeExists: fs.existsSync(DEMO_DB_RUNTIME),
    runtimeSize: fs.existsSync(DEMO_DB_RUNTIME)
      ? fs.statSync(DEMO_DB_RUNTIME).size
      : 0,
  };

  let bootstrapError: string | null = null;
  try {
    bootstrapDemoDb();
  } catch (err) {
    bootstrapError = err instanceof Error ? err.message : String(err);
  }

  const after = {
    runtimeExists: fs.existsSync(DEMO_DB_RUNTIME),
    runtimeSize: fs.existsSync(DEMO_DB_RUNTIME)
      ? fs.statSync(DEMO_DB_RUNTIME).size
      : 0,
  };

  return NextResponse.json({
    IS_DEMO,
    DEMO_DB_URL,
    DEMO_DB_RUNTIME,
    DEMO_DB_BASE64_length: DEMO_DB_BASE64.length,
    env,
    before,
    after,
    bootstrapError,
  });
}
