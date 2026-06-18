/** @type {import('next').NextConfig} */
const nextConfig = {
  // Disable Next.js's built-in X-Frame-Options: SAMEORIGIN so GHL can iframe this app.
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          // Remove X-Frame-Options so GHL can embed this app
          { key: 'X-Frame-Options', value: '' },
          // Restrict embedding to GHL domains only
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'self' https://*.gohighlevel.com https://*.leadconnectorhq.com https://*.msgsndr.com",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
