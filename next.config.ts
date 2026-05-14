import type { NextConfig } from "next";
import path from "node:path";

// Public demo deploy on Vercel: hardcoding `NEXT_PUBLIC_DEMO_MODE=true` and
// `DATABASE_URL=file:/tmp/demo.db` via `env` is the simplest way to guarantee
// the demo gate is on. Next.js inlines these via DefinePlugin at build time so
// both the server runtime and the client bundle see the same value -- no
// dashboard env-var config required, no SSR/CSR hydration mismatch.
//
// Local dev keeps whatever the developer's shell exports; the fallbacks below
// only fire if the variable is unset.
const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Pin the tracing root to this project so Next doesn't walk up to a stray
  // package-lock.json in $HOME.
  outputFileTracingRoot: path.join(__dirname),
  env: {
    NEXT_PUBLIC_DEMO_MODE: process.env.NEXT_PUBLIC_DEMO_MODE ?? "false",
    DATABASE_URL: process.env.DATABASE_URL ?? "file:./prisma/dev.db",
  },
};

export default nextConfig;
