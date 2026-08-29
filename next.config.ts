import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  eslint: { ignoreDuringBuilds: true },
  serverExternalPackages: ["@cursor/sdk"],
  distDir: process.env.NEXT_DIST_DIR || ".next",
  webpack: (config, { isServer }) => {
    if (isServer) {
      const previous = config.externals;
      config.externals = [
        ...(Array.isArray(previous) ? previous : previous ? [previous] : []),
        ({ request }: { request?: string }, callback: (error?: Error | null, result?: string) => void) => {
          if (request === "node:sqlite") return callback(null, "commonjs node:sqlite");
          callback();
        },
      ];
    }
    return config;
  },
};

export default nextConfig;
