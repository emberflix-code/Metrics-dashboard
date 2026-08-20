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

// Recent commit history baked in at build time for the admin "Deploy
// History" panel (Agency Overview page) — a lightweight changelog, not live
// Railway build/deploy logs (those aren't reachable from inside the running
// app; would need a separate Railway API token + server route). This is
// just `git log`, so it only ever reflects what's actually in this build —
// there's no way for it to show a deploy that failed or is still building.
// Field separator \x1f / record separator \x1e (ASCII unit/record
// separators) rather than a delimiter that could appear in a commit
// message, avoiding a JSON.parse round-trip inside next.config.mjs.
function resolveDeployLog(count = 15) {
  try {
    const raw = execSync(`git log -${count} --format=%h\x1f%s\x1f%cI\x1e`).toString();
    return raw
      .split('\x1e')
      .map(rec => rec.trim())
      .filter(Boolean)
      .map(rec => {
        const [sha, subject, date] = rec.split('\x1f');
        return { sha, subject, date };
      });
  } catch {
    return [];
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Disable Next.js's built-in X-Frame-Options: SAMEORIGIN so GHL can iframe this app.
  poweredByHeader: false,
  env: {
    NEXT_PUBLIC_BUILD_SHA: resolveBuildSha(),
    NEXT_PUBLIC_BUILD_TIME: resolveBuildTime(),
    NEXT_PUBLIC_DEPLOY_LOG: JSON.stringify(resolveDeployLog()),
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
