import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  PLAID_CLIENT_USER_ID,
  isPlaidConfigured,
  isPlaidSandboxConfigured,
  plaidClientFor,
  plaidCountryCodes,
  plaidProducts,
  plaidRedirectUri,
  primaryPlaidEnv,
} from "@/lib/plaid";
import { IS_DEMO } from "@/lib/demo";

const BodySchema = z
  .object({
    // Optional explicit target env for this Link session. Defaults to PLAID_ENV.
    env: z.enum(["sandbox", "production", "development"]).optional(),
  })
  .optional();

/**
 * POST /api/plaid/create_link_token
 *
 * Mints a short-lived link_token the browser's Plaid Link flow uses to open
 * the bank-selection modal. No auth: this app is single-user / local.
 *
 * Optional body: `{ "env": "sandbox" | "production" }`. Sandbox is useful
 * during the post-approval waiting window when OAuth institution registration
 * is still propagating — it lets you exercise the Link UI against fake banks.
 */
export async function POST(req: NextRequest) {
  if (IS_DEMO) {
    return NextResponse.json(
      { error: "Plaid integration disabled in demo mode" },
      { status: 503 },
    );
  }

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    // no body — that's fine, defaults apply
  }
  const parsed = BodySchema.safeParse(body ?? undefined);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const targetEnv = parsed.data?.env ?? primaryPlaidEnv();

  if (targetEnv === "sandbox") {
    if (!isPlaidSandboxConfigured()) {
      return NextResponse.json(
        {
          error:
            "Sandbox requested but PLAID_SANDBOX_SECRET (or PLAID_SECRET with PLAID_ENV=sandbox) is not set.",
        },
        { status: 503 },
      );
    }
  } else if (!isPlaidConfigured()) {
    return NextResponse.json(
      { error: "Plaid not configured. Set PLAID_CLIENT_ID / PLAID_SECRET in .env" },
      { status: 503 },
    );
  }

  try {
    const redirectUri = plaidRedirectUri(targetEnv);
    const client = plaidClientFor(targetEnv);
    const resp = await client.linkTokenCreate({
      user: { client_user_id: PLAID_CLIENT_USER_ID },
      client_name: "Churning Treasury",
      products: plaidProducts(),
      country_codes: plaidCountryCodes(),
      language: "en",
      // OAuth institutions (Amex, Chase, etc.) REQUIRE redirect_uri in
      // production. The URI must be registered in Plaid Dashboard → API →
      // Allowed redirect URIs, and must match exactly (scheme + host + path).
      // Sandbox: omit — plaidRedirectUri() returns null.
      ...(redirectUri ? { redirect_uri: redirectUri } : {}),
    });
    return NextResponse.json({
      link_token: resp.data.link_token,
      redirect_uri: redirectUri,
      env: targetEnv,
    });
  } catch (err) {
    // Plaid SDK wraps its API error in err.response.data; surface it verbatim
    // so the UI / server log tells us what Plaid is actually rejecting
    // (error_code, error_message, display_message, request_id).
    const axiosLike = err as {
      response?: { data?: Record<string, unknown>; status?: number };
      message?: string;
    };
    const plaidData = axiosLike?.response?.data;
    const status = axiosLike?.response?.status ?? 500;
    const fallback = axiosLike?.message ?? "Unknown Plaid error";
    console.error(`[create_link_token env=${targetEnv}] Plaid error:`, plaidData ?? fallback);
    return NextResponse.json(
      {
        error:
          (plaidData?.error_message as string) ??
          (plaidData?.display_message as string) ??
          fallback,
        error_code: plaidData?.error_code ?? null,
        error_type: plaidData?.error_type ?? null,
        request_id: plaidData?.request_id ?? null,
        plaid: plaidData ?? null,
        env: targetEnv,
      },
      { status },
    );
  }
}
