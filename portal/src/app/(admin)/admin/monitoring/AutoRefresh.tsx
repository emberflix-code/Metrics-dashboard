'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Re-runs the server component on an interval so the Live badges (and sync
// health) update without a manual reload — router.refresh() re-fetches this
// page's server-side data without a full page reload/scroll-reset, unlike
// location.reload(). Paused while the tab is hidden for the same reason
// DashboardClient.tsx's heartbeat pauses: no point re-querying for a page
// nobody's looking at.
export default function AutoRefresh({ intervalMs }: { intervalMs: number }) {
  const router = useRouter();

  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, intervalMs);
    return () => clearInterval(interval);
  }, [router, intervalMs]);

  return null;
}
