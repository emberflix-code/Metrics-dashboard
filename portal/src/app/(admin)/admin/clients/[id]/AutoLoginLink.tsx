'use client';

import { useState } from 'react';

interface Props {
  clientId: string;
  initialToken: string | null;
}

export default function AutoLoginLink({ clientId, initialToken }: Props) {
  const [token, setToken] = useState<string | null>(initialToken);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const url = token
    ? `${window.location.origin}/auto-login?token=${token}`
    : null;

  async function generate() {
    setLoading(true);
    const res = await fetch(`/api/admin/clients/${clientId}/token`, { method: 'POST' });
    const data = await res.json();
    setToken(data.token ?? null);
    setLoading(false);
  }

  async function copy() {
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="space-y-3">
      {url ? (
        <>
          <div className="flex items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2">
            <span className="text-xs font-mono text-slate-300 truncate flex-1">{url}</span>
            <button
              onClick={copy}
              className="text-xs text-blue-400 hover:text-blue-300 whitespace-nowrap font-semibold"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <p className="text-xs text-slate-500">
            Paste this URL as the iframe src in GHL. The client lands directly on their dashboard — no login needed.
          </p>
          <button
            onClick={generate}
            disabled={loading}
            className="text-xs text-slate-400 hover:text-white underline"
          >
            {loading ? 'Regenerating...' : 'Regenerate (invalidates old link)'}
          </button>
        </>
      ) : (
        <>
          <p className="text-sm text-slate-400">No auto-login link yet.</p>
          <button
            onClick={generate}
            disabled={loading}
            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
          >
            {loading ? 'Generating...' : 'Generate Auto-Login Link'}
          </button>
        </>
      )}
    </div>
  );
}
