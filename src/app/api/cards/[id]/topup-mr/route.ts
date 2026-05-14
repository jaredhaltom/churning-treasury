import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { topUpMrInventory } from "@/lib/inventory-ops";

/**
 * POST /api/cards/:id/topup-mr
 *
 * Record a one-shot batch of MR points earned outside MS — typically the
 * 1x/4x category multipliers Amex gives on regular spend, which we don't
 * try to reconstruct from Plaid categories. The user reads the running MR
 * balance off the Amex app and tops up the delta here.
 */
const BodySchema = z.object({
  quantity: z.number().int().positive().max(10_000_000),
  notes: z.string().max(500).optional().nullable(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
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

  try {
    const result = await prisma.$transaction(async (tx) =>
      topUpMrInventory(tx, id, parsed.data.quantity, parsed.data.notes ?? null),
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Top-up failed" },
      { status: 400 },
    );
  }
}
