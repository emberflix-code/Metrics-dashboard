/** @type {import('next').NextConfig} */
const nextConfig = {
  // Disable Next.js's built-in X-Frame-Options: SAMEORIGIN so GHL can iframe this app.
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          // Remove X-Frame-Options entirely so any domain can embed this app
          { key: 'X-Frame-Options', value: '' },
          // Allow any origin to iframe this app (open for testing)
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors *",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
