import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Prisma pulls in Node-only bindings; keep it out of the bundler's dependency graph.
  serverExternalPackages: ["@prisma/client", "prisma"],
};

export default nextConfig;
