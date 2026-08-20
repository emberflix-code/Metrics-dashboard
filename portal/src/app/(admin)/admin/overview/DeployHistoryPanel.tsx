'use client';

import { useState } from 'react';

interface DeployLogEntry {
  sha: string;
  subject: string;
  date: string;
}

// Parsed once at module load from the build-time-baked env var (see
// next.config.mjs's resolveDeployLog) — this is a static changelog of
// what's actually in the running build, not a live feed. A malformed/empty
// value (e.g. local dev without git, or a build where `git log` failed)
// degrades to an empty list rather than throwing.
function parseDeployLog(): DeployLogEntry[] {
  try {
    const raw = process.env.NEXT_PUBLIC_DEPLOY_LOG;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export default function DeployHistoryPanel() {
  const [open, setOpen] = useState(false);
  const entries = parseDeployLog();

  if (entries.length === 0) return null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="text-[11px] text-slate-500 hover:text-slate-300 underline decoration-dotted underline-offset-2 transition-colors"
      >
        {open ? 'Hide deploy history' : 'Deploy history'}
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-2 w-[420px] max-h-96 overflow-y-auto bg-slate-900 border border-slate-700 rounded-lg shadow-xl z-50 py-2">
          <div className="px-3 pb-2 mb-1 border-b border-slate-800">
            <p className="text-[11px] text-slate-500">
              Last {entries.length} commits in this build &mdash; not live Railway build/deploy status, just what shipped.
            </p>
          </div>
          <ul className="divide-y divide-slate-800/60">
            {entries.map(e => (
              <li key={e.sha} className="px-3 py-2 flex items-start gap-2.5">
                <span className="font-mono text-[10.5px] text-slate-500 shrink-0 mt-0.5">{e.sha}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-slate-200 truncate" title={e.subject}>{e.subject}</p>
                  <p className="text-[10.5px] text-slate-500 mt-0.5">
                    {e.date ? new Date(e.date).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : ''}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
