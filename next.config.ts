import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Pin the tracing root to this project so Next doesn't walk up to a stray
  // package-lock.json in $HOME.
  outputFileTracingRoot: path.join(__dirname),
  // Ship the seeded demo database alongside every serverless function. Without
  // this, Vercel's file-tracing won't detect prisma/demo.db (it's read at
  // runtime via fs.copyFileSync from src/lib/demo.ts, not via a static import)
  // and bootstrapDemoDb() would throw on first request. Cheap to include — the
  // seeded SQLite file is tens of KB.
  outputFileTracingIncludes: {
    "/**/*": ["./prisma/demo.db"],
  },
};

export default nextConfig;
