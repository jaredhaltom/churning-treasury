"use client";

import * as React from "react";
import { Info, X } from "lucide-react";

const DISMISS_KEY = "churning:demo-banner-dismissed";

/**
 * Sticky strip shown only when NEXT_PUBLIC_DEMO_MODE=true. Tells visitors
 * the data is fake and their edits will reset. Dismissal is per-browser
 * (localStorage), not per-session, so a repeat visitor doesn't keep seeing
 * it after they've already read it once.
 */
export function DemoBanner() {
  const [dismissed, setDismissed] = React.useState(true);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    setDismissed(window.localStorage.getItem(DISMISS_KEY) === "1");
  }, []);

  function dismiss() {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(DISMISS_KEY, "1");
    }
    setDismissed(true);
  }

  if (dismissed) return null;

  return (
    <div className="sticky top-0 z-40 border-b border-border/60 bg-secondary/80 backdrop-blur supports-[backdrop-filter]:bg-secondary/60">
      <div className="mx-auto flex w-full max-w-7xl items-start gap-2 px-6 py-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <p className="flex-1 leading-snug">
          <span className="font-medium text-foreground">Demo mode.</span>{" "}
          All data is seeded and fabricated. You can click around freely —
          edits persist in the shared playground and reset daily (or on each
          deploy). Plaid bank linking is disabled.
        </p>
        <button
          type="button"
          onClick={dismiss}
          className="shrink-0 rounded-md p-1 hover:bg-secondary"
          aria-label="Dismiss demo banner"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
