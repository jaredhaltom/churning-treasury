"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { usePlaidLink } from "react-plaid-link";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FlaskConical, Link as LinkIcon, Loader2, RefreshCw, Wrench } from "lucide-react";
import { CARD_SPECS, CARD_TYPE, type CardType } from "@/lib/constants";

type PlaidSessionEnv = "sandbox" | "production" | "development";

export interface PlaidCardOption {
  id: string;
  label: string;
  plaidAccountId: string | null;
}

interface PlaidAccount {
  accountId: string;
  name: string;
  officialName: string | null;
  mask: string | null;
  subtype: string | null;
  type: string | null;
}

interface ExchangeResult {
  plaidItemId: string;
  institutionName: string | null;
  accounts: PlaidAccount[];
}

export interface PlaidLinkButtonProps {
  cards: PlaidCardOption[];
  /** When true, renders a secondary "Try sandbox" button that targets PLAID_SANDBOX_SECRET. */
  sandboxAvailable?: boolean;
}

/**
 * Per-account mapping decision. Kept as a discriminated union so we don't have
 * to smuggle sentinel strings through the UI state.
 */
type Choice =
  | { kind: "ignore" }
  | { kind: "existing"; cardId: string }
  | { kind: "new"; cardType: CardType; openDate: string; nickname: string };

const NEW_CARD_SENTINEL = "__new__";
const todayISO = () => new Date().toISOString().slice(0, 10);

function defaultNickname(a: PlaidAccount) {
  return a.mask ? `${a.name} ••${a.mask}` : a.name;
}

/**
 * When Plaid redirects back from an OAuth institution (Amex, Chase, etc.), it
 * appends `?oauth_state_id=...` to our redirect_uri. We need to:
 *   1. Detect that on page load.
 *   2. Re-initialize Plaid Link with the SAME link_token we used to start the
 *      flow (stored in localStorage) + the incoming URL.
 *   3. Auto-open Plaid Link so the user sees the "completing..." step instead
 *      of a blank page.
 */
const STORED_TOKEN_KEY = "churning:plaid_link_token";
const STORED_ENV_KEY = "churning:plaid_link_env";

function getOAuthReturnState(): {
  linkToken: string;
  env: PlaidSessionEnv;
  href: string;
} | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  if (!params.has("oauth_state_id")) return null;
  const stored = window.localStorage.getItem(STORED_TOKEN_KEY);
  if (!stored) return null;
  const storedEnv = window.localStorage.getItem(STORED_ENV_KEY);
  const env: PlaidSessionEnv =
    storedEnv === "sandbox" || storedEnv === "development"
      ? storedEnv
      : "production";
  return { linkToken: stored, env, href: window.location.href };
}

/**
 * "Connect bank" (new institution) + "Map accounts" (existing) + "Sync now".
 * The mapping modal supports binding a Plaid account to an existing Card
 * OR creating a brand-new Card inline — you no longer need to pre-create
 * cards in the Cards Manager before connecting Plaid.
 */
export function PlaidLinkButton({ cards, sandboxAvailable = false }: PlaidLinkButtonProps) {
  const router = useRouter();
  const [linkToken, setLinkToken] = React.useState<string | null>(null);
  // Tracks which Plaid environment the in-flight Link session belongs to.
  // Seeded from localStorage on OAuth return so the exchange hits the right host.
  const [sessionEnv, setSessionEnv] = React.useState<PlaidSessionEnv>("production");
  const [receivedRedirectUri, setReceivedRedirectUri] = React.useState<
    string | undefined
  >(undefined);
  const [loadingToken, setLoadingToken] = React.useState<
    "none" | "prod" | "sandbox" | "remap"
  >("none");
  const [syncing, setSyncing] = React.useState(false);
  const [mapping, setMapping] = React.useState<ExchangeResult | null>(null);
  const [choices, setChoices] = React.useState<Record<string, Choice>>({});
  const [mappingError, setMappingError] = React.useState<string | null>(null);
  const [mappingSaving, setMappingSaving] = React.useState(false);
  const [toast, setToast] = React.useState<string | null>(null);

  // Resume a Plaid Link OAuth flow if we just got redirected back. Sandbox
  // links never trigger an OAuth redirect, so this path is production-only in
  // practice — but we still restore env defensively.
  React.useEffect(() => {
    const state = getOAuthReturnState();
    if (state) {
      setLinkToken(state.linkToken);
      setSessionEnv(state.env);
      setReceivedRedirectUri(state.href);
    }
  }, []);

  const clearStoredToken = React.useCallback(() => {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(STORED_TOKEN_KEY);
      window.localStorage.removeItem(STORED_ENV_KEY);
    }
    // Strip oauth_state_id from URL if present so refreshes don't re-trigger.
    if (typeof window !== "undefined" && window.location.search.includes("oauth_state_id")) {
      const url = new URL(window.location.href);
      url.searchParams.delete("oauth_state_id");
      window.history.replaceState({}, "", url.toString());
    }
    setReceivedRedirectUri(undefined);
  }, []);

  const onPlaidSuccess = React.useCallback(
    async (
      public_token: string,
      metadata: { institution?: { name: string; institution_id: string } | null },
    ) => {
      clearStoredToken();
      try {
        const res = await fetch("/api/plaid/exchange_public_token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            public_token,
            env: sessionEnv,
            institution: metadata.institution ?? null,
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? "Exchange failed");
        }
        const data = (await res.json()) as ExchangeResult;
        setMapping(data);
        // Pre-select "create new card" for every credit-card account to nudge
        // the Plaid-first flow. User can switch back to ignore / existing.
        const seeded: Record<string, Choice> = {};
        for (const a of data.accounts) {
          const isCreditCard =
            (a.subtype ?? "").toLowerCase() === "credit card" ||
            (a.type ?? "").toLowerCase() === "credit";
          seeded[a.accountId] = isCreditCard
            ? {
                kind: "new",
                cardType: CARD_TYPE.OTHER,
                openDate: todayISO(),
                nickname: defaultNickname(a),
              }
            : { kind: "ignore" };
        }
        setChoices(seeded);
        setLinkToken(null);
      } catch (e) {
        setToast(e instanceof Error ? e.message : "Exchange failed");
      }
    },
    [clearStoredToken, sessionEnv],
  );

  const { open, ready } = usePlaidLink({
    token: linkToken,
    // When present, react-plaid-link completes the OAuth handoff instead of
    // starting a fresh flow. Only set after a redirect back from the bank.
    receivedRedirectUri,
    onSuccess: (public_token, metadata) =>
      onPlaidSuccess(
        public_token,
        metadata as { institution?: { name: string; institution_id: string } | null },
      ),
    onExit: () => {
      clearStoredToken();
      setLinkToken(null);
    },
  });

  React.useEffect(() => {
    if (linkToken && ready) open();
  }, [linkToken, ready, open]);

  async function startLink(env: PlaidSessionEnv = "production") {
    setLoadingToken(env === "sandbox" ? "sandbox" : "prod");
    setToast(null);
    try {
      const res = await fetch("/api/plaid/create_link_token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ env }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to create link token");
      }
      const data = await res.json();
      // Persist the token + env so we can resume the flow after an OAuth
      // redirect (Amex/Chase/etc. bounce the browser through their own consent
      // page which reloads our app). Sandbox doesn't redirect, but storing env
      // keeps the exchange code path uniform.
      if (typeof window !== "undefined") {
        window.localStorage.setItem(STORED_TOKEN_KEY, data.link_token);
        window.localStorage.setItem(STORED_ENV_KEY, env);
      }
      setSessionEnv(env);
      setReceivedRedirectUri(undefined);
      setLinkToken(data.link_token);
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Link token failed");
    } finally {
      setLoadingToken("none");
    }
  }

  async function openRemap() {
    setToast(null);
    setLoadingToken("remap");
    try {
      const res = await fetch("/api/plaid/items");
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to load items");
      }
      const data = (await res.json()) as {
        items: Array<{
          id: string;
          institutionName: string | null;
          accounts: Array<PlaidAccount & { linkedCardId: string | null }>;
        }>;
      };
      const target = data.items.find((it) =>
        it.accounts.some((a) => !a.linkedCardId),
      );
      if (!target) {
        setToast("All Plaid accounts are already mapped.");
        return;
      }
      const unlinked = target.accounts.filter((a) => !a.linkedCardId);
      setMapping({
        plaidItemId: target.id,
        institutionName: target.institutionName,
        accounts: unlinked.map(({ linkedCardId: _ignore, ...rest }) => rest),
      });
      const seeded: Record<string, Choice> = {};
      for (const a of unlinked) {
        const isCreditCard =
          (a.subtype ?? "").toLowerCase() === "credit card" ||
          (a.type ?? "").toLowerCase() === "credit";
        seeded[a.accountId] = isCreditCard
          ? {
              kind: "new",
              cardType: CARD_TYPE.OTHER,
              openDate: todayISO(),
              nickname: defaultNickname(a),
            }
          : { kind: "ignore" };
      }
      setChoices(seeded);
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Remap failed");
    } finally {
      setLoadingToken("none");
    }
  }

  async function syncNow() {
    setSyncing(true);
    setToast(null);
    try {
      const res = await fetch("/api/plaid/sync_transactions", { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Sync failed");
      }
      const data = await res.json();
      setToast(
        `Synced ${data.added} new, ${data.modified} updated${
          data.removed ? `, ${data.removed} removed` : ""
        }.`,
      );
      router.refresh();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  function setChoice(accountId: string, next: Choice) {
    setChoices((prev) => ({ ...prev, [accountId]: next }));
  }

  const hasActionableChoice = Object.values(choices).some(
    (c) => c.kind === "existing" || c.kind === "new",
  );

  async function saveMapping() {
    if (!mapping) return;
    setMappingError(null);
    setMappingSaving(true);
    try {
      const entries = Object.entries(choices).filter(
        ([, c]) => c.kind !== "ignore",
      );
      let created = 0;
      for (const [plaidAccountId, c] of entries) {
        let payload: Record<string, unknown>;
        if (c.kind === "existing") {
          payload = {
            plaidItemId: mapping.plaidItemId,
            plaidAccountId,
            cardId: c.cardId,
          };
        } else if (c.kind === "new") {
          payload = {
            plaidItemId: mapping.plaidItemId,
            plaidAccountId,
            newCard: {
              type: c.cardType,
              nickname: c.nickname || undefined,
              openDate: c.openDate,
            },
          };
        } else {
          continue;
        }
        const res = await fetch("/api/plaid/link_card", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? "Mapping failed");
        }
        const data = await res.json().catch(() => ({}));
        if (data?.created) created += 1;
      }
      setMapping(null);
      setChoices({});
      const linked = entries.length;
      setToast(
        linked === 0
          ? "No accounts mapped (you can do this later)."
          : `Mapped ${linked} account${linked === 1 ? "" : "s"}` +
              (created > 0 ? ` (${created} new card${created === 1 ? "" : "s"})` : "") +
              ". Running first sync...",
      );
      if (linked > 0) {
        await fetch("/api/plaid/sync_transactions", { method: "POST" }).catch(
          () => null,
        );
      }
      router.refresh();
    } catch (e) {
      setMappingError(e instanceof Error ? e.message : "Mapping failed");
    } finally {
      setMappingSaving(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => startLink("production")}
          disabled={loadingToken !== "none"}
        >
          {loadingToken === "prod" ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Preparing...
            </>
          ) : (
            <>
              <LinkIcon className="h-3.5 w-3.5" /> Connect bank
            </>
          )}
        </Button>
        {sandboxAvailable && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => startLink("sandbox")}
            disabled={loadingToken !== "none"}
            title="Open Plaid Link against the sandbox (fake banks). Use while production OAuth registration propagates. Sandbox creds: user_good / pass_good."
          >
            {loadingToken === "sandbox" ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Preparing...
              </>
            ) : (
              <>
                <FlaskConical className="h-3.5 w-3.5" /> Try sandbox
              </>
            )}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={openRemap}
          disabled={loadingToken !== "none"}
          title="Re-open the account mapping modal for an already-connected bank"
        >
          <Wrench className="h-3.5 w-3.5" /> Map accounts
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={syncNow}
          disabled={syncing}
        >
          {syncing ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Syncing...
            </>
          ) : (
            <>
              <RefreshCw className="h-3.5 w-3.5" /> Sync now
            </>
          )}
        </Button>
      </div>
      {toast && <p className="text-xs text-muted-foreground">{toast}</p>}

      {mapping && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm">
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border border-border bg-card p-5 shadow-lg">
            <h3 className="text-base font-semibold">
              Map {mapping.institutionName ?? "your bank"} accounts
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              For each credit card Plaid detected, either create a new tracked
              card or link it to an existing one. Plaid will then drive MSR
              automatically.
            </p>
            <div className="mt-4 space-y-4">
              {mapping.accounts.map((a) => {
                const choice = choices[a.accountId] ?? { kind: "ignore" as const };
                const selectValue =
                  choice.kind === "ignore"
                    ? ""
                    : choice.kind === "new"
                    ? NEW_CARD_SENTINEL
                    : choice.cardId;
                return (
                  <div
                    key={a.accountId}
                    className="space-y-2 rounded-md border border-border/60 bg-secondary/30 p-3"
                  >
                    <div className="flex items-center justify-between">
                      <Label className="text-xs">
                        {a.name}
                        {a.mask ? ` ••${a.mask}` : ""}
                      </Label>
                      <span className="text-[10px] text-muted-foreground">
                        {a.subtype ?? a.type ?? ""}
                      </span>
                    </div>
                    <Select
                      value={selectValue}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === "") {
                          setChoice(a.accountId, { kind: "ignore" });
                        } else if (v === NEW_CARD_SENTINEL) {
                          setChoice(a.accountId, {
                            kind: "new",
                            cardType: CARD_TYPE.OTHER,
                            openDate: todayISO(),
                            nickname: defaultNickname(a),
                          });
                        } else {
                          setChoice(a.accountId, { kind: "existing", cardId: v });
                        }
                      }}
                    >
                      <option value="">— ignore —</option>
                      <option value={NEW_CARD_SENTINEL}>
                        + Create new card from this account
                      </option>
                      {cards.length > 0 && (
                        <optgroup label="Link to existing card">
                          {cards.map((c) => (
                            <option
                              key={c.id}
                              value={c.id}
                              disabled={Boolean(c.plaidAccountId)}
                            >
                              {c.label}
                              {c.plaidAccountId ? " (already linked)" : ""}
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </Select>

                    {choice.kind === "new" && (
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                        <div className="space-y-1">
                          <Label className="text-[10px]">Card type</Label>
                          <Select
                            value={choice.cardType}
                            onChange={(e) =>
                              setChoice(a.accountId, {
                                ...choice,
                                cardType: e.target.value as CardType,
                              })
                            }
                          >
                            <option value={CARD_TYPE.ABP}>
                              Amex Business Platinum
                            </option>
                            <option value={CARD_TYPE.ABG}>
                              Amex Business Gold
                            </option>
                            <option value={CARD_TYPE.VENMO}>
                              Venmo Credit Card
                            </option>
                            <option value={CARD_TYPE.OTHER}>Other</option>
                          </Select>
                        </div>
                        <div className="space-y-1">
                          <Label className="text-[10px]">Open date</Label>
                          <Input
                            type="date"
                            value={choice.openDate}
                            onChange={(e) =>
                              setChoice(a.accountId, {
                                ...choice,
                                openDate: e.target.value,
                              })
                            }
                            className="h-9 text-xs"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-[10px]">Nickname</Label>
                          <Input
                            value={choice.nickname}
                            onChange={(e) =>
                              setChoice(a.accountId, {
                                ...choice,
                                nickname: e.target.value,
                              })
                            }
                            className="h-9 text-xs"
                          />
                        </div>
                        {choice.cardType !== CARD_TYPE.OTHER && (
                          <p className="col-span-full text-[10px] text-muted-foreground">
                            Spend target auto-set to{" "}
                            {new Intl.NumberFormat("en-US", {
                              style: "currency",
                              currency: "USD",
                              maximumFractionDigits: 0,
                            }).format(CARD_SPECS[choice.cardType].spendTarget)}
                            , cooldown {CARD_SPECS[choice.cardType].cooldownDays}{" "}
                            days. Edit in the Cards Manager after creation.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {mappingError && (
              <p className="mt-3 text-xs text-destructive">{mappingError}</p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setMapping(null)}
                disabled={mappingSaving}
              >
                Skip for now
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={saveMapping}
                disabled={mappingSaving || !hasActionableChoice}
              >
                {mappingSaving ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving...
                  </>
                ) : (
                  "Save mapping"
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
