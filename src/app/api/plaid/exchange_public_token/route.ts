import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  isPlaidConfigured,
  isPlaidSandboxConfigured,
  plaidClientFor,
  primaryPlaidEnv,
} from "@/lib/plaid";
import { IS_DEMO } from "@/lib/demo";

const BodySchema = z.object({
  public_token: z.string().min(1),
  // Echo back the env the Link session was created in. Required for sandbox
  // because sandbox public_tokens must be exchanged against the sandbox host.
  env: z.enum(["sandbox", "production", "development"]).optional(),
  institution: z
    .object({
      institution_id: z.string().optional().nullable(),
      name: z.string().optional().nullable(),
    })
    .optional()
    .nullable(),
});

/**
 * POST /api/plaid/exchange_public_token
 *
 * Called once by the browser after Plaid Link succeeds. Exchanges the
 * one-time public_token for a long-lived access_token, persists the
 * PlaidItem, fetches the list of accounts on the item, and returns them so
 * the UI can prompt the user to map each Plaid account to an existing Card.
 *
 * The returned access_token's prefix (`access-sandbox-*` vs
 * `access-production-*`) is what future calls use to pick the right client
 * at sync time, so we don't need a separate env column on PlaidItem.
 */
export async function POST(req: NextRequest) {
  if (IS_DEMO) {
    return NextResponse.json(
      { error: "Plaid integration disabled in demo mode" },
      { status: 503 },
    );
  }

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

  const targetEnv = parsed.data.env ?? primaryPlaidEnv();
  if (targetEnv === "sandbox") {
    if (!isPlaidSandboxConfigured()) {
      return NextResponse.json(
        { error: "Sandbox not configured" },
        { status: 503 },
      );
    }
  } else if (!isPlaidConfigured()) {
    return NextResponse.json(
      { error: "Plaid not configured" },
      { status: 503 },
    );
  }

  try {
    const client = plaidClientFor(targetEnv);
    const exchange = await client.itemPublicTokenExchange({
      public_token: parsed.data.public_token,
    });
    const { access_token, item_id } = exchange.data;

    const accountsResp = await client.accountsGet({ access_token });
    const accounts = accountsResp.data.accounts;

    const institutionName =
      parsed.data.institution?.name ?? accountsResp.data.item.institution_id ?? null;
    const institutionId =
      parsed.data.institution?.institution_id ?? accountsResp.data.item.institution_id ?? null;

    const item = await prisma.plaidItem.create({
      data: {
        accessToken: access_token,
        itemId: item_id,
        institutionId,
        institutionName,
      },
    });

    return NextResponse.json({
      plaidItemId: item.id,
      institutionName,
      institutionId,
      env: targetEnv,
      accounts: accounts.map((a) => ({
        accountId: a.account_id,
        name: a.name,
        officialName: a.official_name,
        mask: a.mask,
        subtype: a.subtype,
        type: a.type,
      })),
    });
  } catch (err) {
    const axiosLike = err as {
      response?: { data?: Record<string, unknown>; status?: number };
      message?: string;
    };
    const plaidData = axiosLike?.response?.data;
    const status = axiosLike?.response?.status ?? 500;
    const fallback = axiosLike?.message ?? "Unknown Plaid error";
    console.error(`[exchange_public_token env=${targetEnv}] Plaid error:`, plaidData ?? fallback);
    return NextResponse.json(
      {
        error:
          (plaidData?.error_message as string) ??
          (plaidData?.display_message as string) ??
          fallback,
        error_code: plaidData?.error_code ?? null,
        request_id: plaidData?.request_id ?? null,
      },
      { status },
    );
  }
}
