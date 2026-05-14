import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  CountryCode,
  Products,
} from "plaid";

/**
 * Central Plaid client(s).
 *
 * We support running two environments side-by-side (production + sandbox) so
 * the user can keep production credentials set while testing the Link flow
 * against fake institutions. This matters specifically while OAuth
 * institutions (Amex/Chase/etc.) are still propagating registration after a
 * freshly granted production account — up to 24h window where production
 * links fail with INSTITUTION_REGISTRATION_REQUIRED.
 *
 * Environment selection:
 *   - `plaidClient`         — the "primary" client, driven by PLAID_ENV.
 *   - `plaidSandboxClient`  — always sandbox; requires PLAID_SANDBOX_SECRET.
 *   - `plaidClientFor(env)` — explicit dispatch by string.
 *   - `plaidClientForToken` — dispatch by inspecting an access_token's env
 *                             prefix (`access-sandbox-*` vs
 *                             `access-production-*`). This is what the
 *                             sync job uses so each PlaidItem is routed to
 *                             the host that issued its token.
 */

export type PlaidEnvName = "sandbox" | "development" | "production";

const primaryEnv: PlaidEnvName = (() => {
  const raw = (process.env.PLAID_ENV ?? "sandbox").toLowerCase();
  if (raw === "production" || raw === "development" || raw === "sandbox") {
    return raw;
  }
  return "sandbox";
})();

function basePathFor(env: PlaidEnvName): string {
  return env in PlaidEnvironments
    ? PlaidEnvironments[env as keyof typeof PlaidEnvironments]
    : PlaidEnvironments.sandbox;
}

function buildClient(env: PlaidEnvName, secret: string): PlaidApi {
  const configuration = new Configuration({
    basePath: basePathFor(env),
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID ?? "",
        "PLAID-SECRET": secret,
        "Plaid-Version": "2020-09-14",
      },
    },
  });
  return new PlaidApi(configuration);
}

const primarySecret = process.env.PLAID_SECRET ?? "";
const sandboxSecret = process.env.PLAID_SANDBOX_SECRET ?? "";

export const plaidClient = buildClient(primaryEnv, primarySecret);

// Sandbox client exists only if the user provided a sandbox secret. When the
// primary env already IS sandbox, the primary client already covers it — but
// we still expose an explicit sandbox client so callers that want "always
// sandbox regardless of PLAID_ENV" don't have to care.
const effectiveSandboxSecret =
  sandboxSecret || (primaryEnv === "sandbox" ? primarySecret : "");
export const plaidSandboxClient: PlaidApi | null = effectiveSandboxSecret
  ? buildClient("sandbox", effectiveSandboxSecret)
  : null;

/** True iff the primary (PLAID_ENV) client has credentials. */
export function isPlaidConfigured(): boolean {
  return Boolean(process.env.PLAID_CLIENT_ID && primarySecret);
}

/** True iff the sandbox client is usable (distinct from primary when PLAID_ENV != sandbox). */
export function isPlaidSandboxConfigured(): boolean {
  return Boolean(process.env.PLAID_CLIENT_ID && effectiveSandboxSecret);
}

/** The environment that the primary client targets. */
export function primaryPlaidEnv(): PlaidEnvName {
  return primaryEnv;
}

/**
 * Pick the client for an explicit environment. Throws if that env wasn't
 * configured — caller should `isPlaidSandboxConfigured()` etc. first.
 */
export function plaidClientFor(env: PlaidEnvName): PlaidApi {
  if (env === primaryEnv) return plaidClient;
  if (env === "sandbox") {
    if (!plaidSandboxClient) {
      throw new Error(
        "Sandbox client requested but PLAID_SANDBOX_SECRET is not set.",
      );
    }
    return plaidSandboxClient;
  }
  // development requested but not configured — fall back to sandbox-style
  // behavior (caller should guard).
  throw new Error(`No Plaid client configured for env=${env}`);
}

/**
 * Inspect a stored access_token and return the client that can talk to it.
 * Plaid tokens are formatted `access-{env}-{uuid}`, which is a stable public
 * convention. Unknown formats fall back to the primary client.
 */
export function plaidClientForToken(accessToken: string): PlaidApi {
  if (accessToken.startsWith("access-sandbox-") && plaidSandboxClient) {
    return plaidSandboxClient;
  }
  if (accessToken.startsWith("access-production-") && primaryEnv === "production") {
    return plaidClient;
  }
  if (accessToken.startsWith("access-development-") && primaryEnv === "development") {
    return plaidClient;
  }
  // Default: primary client. If this is wrong, Plaid will return
  // INVALID_ACCESS_TOKEN which is easy to diagnose in logs.
  return plaidClient;
}

export function plaidProducts(): Products[] {
  const raw = process.env.PLAID_PRODUCTS ?? "transactions";
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => p as Products);
}

export function plaidCountryCodes(): CountryCode[] {
  const raw = process.env.PLAID_COUNTRY_CODES ?? "US";
  return raw
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean)
    .map((c) => c as CountryCode);
}

/**
 * Single-user local app => one stable Plaid `client_user_id`. If this ever
 * becomes multi-tenant, swap for an actual user id.
 */
export const PLAID_CLIENT_USER_ID = "churning-local-user";

/**
 * Redirect URI used for OAuth institutions (Amex, Chase, Capital One, Wells
 * Fargo, etc). Must match EXACTLY a URI registered in the Plaid Dashboard:
 *   API → Allowed redirect URIs.
 *
 * Plaid only accepts a `redirect_uri` in production/development, not sandbox.
 * Returning `null` from here causes linkTokenCreate to omit the field, which
 * is what sandbox expects.
 *
 * Pass the target env so sandbox link sessions omit redirect_uri even when
 * `PLAID_REDIRECT_URI` is set (it's only meaningful for the prod client).
 */
export function plaidRedirectUri(env: PlaidEnvName = primaryEnv): string | null {
  if (env === "sandbox") return null;
  const explicit = process.env.PLAID_REDIRECT_URI?.trim();
  if (explicit) return explicit;
  // Reasonable default for local dev. Still must be registered in dashboard.
  return "http://localhost:3000/";
}
