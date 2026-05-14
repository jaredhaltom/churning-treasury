import { NextRequest, NextResponse } from "next/server";

import { IS_DEMO } from "@/lib/demo";
import { seedDemo } from "../../../../scripts/seed-demo";

// This endpoint is intentionally not exposed in the UI. It exists for two
// callers:
//   1) The Vercel Cron job defined in vercel.json, which hits it once a day
//      to wipe + reseed the shared demo Postgres database back to the
//      reference state. Vercel signs cron requests with an Authorization
//      header containing process.env.CRON_SECRET, which we verify.
//   2) A human operator running
//        curl -X POST https://churning-treasury.vercel.app/api/reset-demo \
//          -H "Authorization: Bearer <CRON_SECRET>"
//      when the playground has drifted too far and you want to reset on
//      demand without redeploying.
//
// In non-demo environments this route returns 503 so no one can wipe a
// real database by accident.
export const maxDuration = 60;

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return false;
  }
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

async function runReset() {
  const lines: string[] = [];
  const log = (msg: string) => {
    lines.push(msg);
    console.log(msg);
  };
  const result = await seedDemo(log);
  return { result, log: lines };
}

export async function POST(req: NextRequest) {
  if (!IS_DEMO) {
    return NextResponse.json(
      { error: "Reset only available in demo mode." },
      { status: 503 },
    );
  }
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { result, log } = await runReset();
    return NextResponse.json({ ok: true, ...result, log });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[reset-demo] Failed:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Vercel Cron triggers GET (not POST) by default, but lets us also use GET
// here. Both are gated by the same Bearer-token check.
export async function GET(req: NextRequest) {
  return POST(req);
}
