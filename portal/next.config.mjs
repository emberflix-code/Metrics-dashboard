import { execSync } from 'child_process';

// Deployed-version indicator shown in the dashboard/admin/overview headers
// (see DashboardClient.tsx, admin/page.tsx, admin/overview/page.tsx).
// Railway auto-injects RAILWAY_GIT_COMMIT_SHA at build time for
// GitHub-connected deploys — no manual version bump needed, and it's always
// exactly what's actually running. Falls back to reading git directly for
// local dev, where that var isn't set.
function resolveBuildSha() {
  if (process.env.RAILWAY_GIT_COMMIT_SHA) return process.env.RAILWAY_GIT_COMMIT_SHA.slice(0, 7);
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'dev';
  }
}

// Commit date/time of whatever's actually deployed — Railway doesn't inject
// a commit-timestamp env var (only the SHA), and the SHA alone doesn't tell
// you how stale a running instance might be. The repo is fully checked out
// during Railway's build step regardless of which SHA env var is present, so
// `git log` against HEAD is reliable there too, not just for local dev.
function resolveBuildTime() {
  try {
    return execSync('git log -1 --format=%cI').toString().trim();
  } catch {
    return '';
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Disable Next.js's built-in X-Frame-Options: SAMEORIGIN so GHL can iframe this app.
  poweredByHeader: false,
  env: {
    NEXT_PUBLIC_BUILD_SHA: resolveBuildSha(),
    NEXT_PUBLIC_BUILD_TIME: resolveBuildTime(),
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          // Remove X-Frame-Options so GHL can embed this app
          { key: 'X-Frame-Options', value: '' },
          // Open to all for diagnosis — will restrict once working domain is confirmed
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
