import type { NextConfig } from "next";
import path from "node:path";

// Public demo deploy on Vercel: hardcoding `NEXT_PUBLIC_DEMO_MODE=true` via
// `env` is the simplest way to guarantee the demo gate is on. Next.js inlines
// it via DefinePlugin at build time so both the server runtime and the client
// bundle see the same value -- no dashboard env-var config required, no
// SSR/CSR hydration mismatch.
//
// Local dev keeps whatever the developer's shell exports; the fallback below
// only fires if the variable is unset.
//
// DATABASE_URL is intentionally NOT inlined here -- on Vercel the demo build
// reads Postgres credentials (POSTGRES_PRISMA_URL / POSTGRES_URL_NON_POOLING)
// directly from process.env at runtime through the generated prisma client.
const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Pin the tracing root to this project so Next doesn't walk up to a stray
  // package-lock.json in $HOME.
  outputFileTracingRoot: path.join(__dirname),
  env: {
    NEXT_PUBLIC_DEMO_MODE: process.env.NEXT_PUBLIC_DEMO_MODE ?? "false",
  },
};

export default nextConfig;
