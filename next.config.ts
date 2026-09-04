import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // yahoo-finance2 is CommonJS-ish and must not be bundled into the server build.
  serverExternalPackages: ["yahoo-finance2", "postgres"],
};

export default nextConfig;
