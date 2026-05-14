import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getMrRateSettings, setMrRateSettings } from "@/lib/settings";

const BodySchema = z
  .object({
    saleRate: z.number().positive().max(1).optional(),
    redemptionRate: z.number().positive().max(1).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

export async function GET() {
  const settings = await getMrRateSettings();
  return NextResponse.json(settings);
}

export async function PATCH(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const settings = await setMrRateSettings(parsed.data);
  return NextResponse.json(settings);
}

export const dynamic = "force-dynamic";
