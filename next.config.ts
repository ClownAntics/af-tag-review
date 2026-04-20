import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "images.clownantics.com",
        pathname: "/**",
      },
    ],
  },
};

export default nextConfig;
