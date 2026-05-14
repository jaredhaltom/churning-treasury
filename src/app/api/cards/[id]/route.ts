import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

const PatchSchema = z
  .object({
    nickname: z.string().max(64).nullable().optional(),
    currentSpend: z.number().nonnegative().max(10_000_000).optional(),
    spendTarget: z.number().nonnegative().max(10_000_000).optional(),
    openDate: z.string().datetime().optional(),
    closed: z.boolean().optional(),
    cooldownDays: z.number().int().nonnegative().max(365).optional(),
    signupBonus: z.number().int().nonnegative().max(10_000_000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

export async function PATCH(
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

  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const existing = await prisma.card.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Card not found" }, { status: 404 });
  }

  const data = parsed.data;

  // Plaid owns currentSpend once a card is linked. The user can still edit
  // nickname, spendTarget, cooldownDays, signupBonus, closed status, etc.
  if (data.currentSpend !== undefined && existing.plaidItemId) {
    return NextResponse.json(
      {
        error:
          "currentSpend is Plaid-managed for this card. Unlink Plaid or use the Inbox to reconcile transactions.",
      },
      { status: 409 },
    );
  }

  const updated = await prisma.card.update({
    where: { id },
    data: {
      ...(data.nickname !== undefined && { nickname: data.nickname }),
      ...(data.currentSpend !== undefined && { currentSpend: data.currentSpend }),
      ...(data.spendTarget !== undefined && { spendTarget: data.spendTarget }),
      ...(data.openDate !== undefined && { openDate: new Date(data.openDate) }),
      ...(data.closed !== undefined && { closed: data.closed }),
      ...(data.cooldownDays !== undefined && { cooldownDays: data.cooldownDays }),
      ...(data.signupBonus !== undefined && { signupBonus: data.signupBonus }),
    },
  });

  return NextResponse.json({ card: updated });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const existing = await prisma.card.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Card not found" }, { status: 404 });
  }
  await prisma.card.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
