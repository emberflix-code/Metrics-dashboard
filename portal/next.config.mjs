/** @type {import('next').NextConfig} */
const nextConfig = {
  // Disable Next.js's built-in X-Frame-Options: SAMEORIGIN so GHL can iframe this app.
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          // Remove Next.js's default X-Frame-Options: SAMEORIGIN
          { key: 'X-Frame-Options', value: '' },
          // Allow GoHighLevel to embed this app in an iframe
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
