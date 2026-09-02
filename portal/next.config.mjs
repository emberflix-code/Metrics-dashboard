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

// Human-friendly version (e.g. "v1.2.1"), separate from the raw SHA above.
//
// IMPORTANT: Railway's build environment has NO .git directory at all (every
// `execSync('git ...')` call in this file throws "not a git repository" when
// it runs there — confirmed via `railway logs`, 2026-08-22). RAILWAY_GIT_
// COMMIT_SHA works because Railway injects it directly as a build-time env
// var, not by reading .git — there is no equivalent Railway-native var for
// "the nearest git tag", so `git describe` can NEVER succeed on Railway,
// tags or no tags. The old comment here claiming "the repo is fully checked
// out during Railway's build step" was wrong (or stopped being true).
//
// Fix: prefer an explicit RAILWAY_VERSION_TAG override (set manually per
// release — `railway variables --set RAILWAY_VERSION_TAG=v1.2.1
// --service Metrics-dashboard --environment production` before/with the
// deploy that should carry it) over ever trying git on Railway. Local dev
// still uses live `git describe --tags --always` (this repo DOES have a
// working .git locally), so no separate value needs to be maintained there.
function resolveVersion() {
  if (process.env.RAILWAY_VERSION_TAG) return process.env.RAILWAY_VERSION_TAG;
  if (process.env.RAILWAY_GIT_COMMIT_SHA) {
    // Running on Railway but no override var set for this release — git
    // describe would just throw here, so don't bother attempting it.
    return process.env.RAILWAY_GIT_COMMIT_SHA.slice(0, 7);
  }
  try {
    return execSync('git describe --tags --always').toString().trim();
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
  // Required for src/instrumentation.ts's register() to actually run on
  // Next.js 14 (it only became a stable, flag-free feature in Next 15) --
  // without this, next-server.js's prepareImpl() silently skips loading the
  // instrumentation hook entirely: no error, no log, register() just never
  // fires. Confirmed live 2026-09-02: the daily sync scheduler's boot log
  // never appeared in Railway's deploy logs until this flag was added.
  experimental: {
    instrumentationHook: true,
  },
  env: {
    NEXT_PUBLIC_BUILD_SHA: resolveBuildSha(),
    NEXT_PUBLIC_VERSION: resolveVersion(),
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
