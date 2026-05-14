import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Pin the tracing root to this project so Next doesn't walk up to a stray
  // package-lock.json in $HOME.
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
