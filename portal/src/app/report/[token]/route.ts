import { NextRequest } from 'next/server';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

// Public on purpose: /report is outside the middleware matcher. The token in
// the path is the report's own access token (shared_reports.token) and grants
// nothing beyond this one page — no session, no dashboard access.
const HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'private, no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  // Keep the token out of the Referer header when the viewer follows a link out.
  'Referrer-Policy': 'no-referrer',
};

const NOT_FOUND = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Report not available</title>
<style>body{margin:0;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f5f7f6;color:#17201c;display:grid;place-items:center;min-height:100vh;padding-inline:16px}
@media (prefers-color-scheme:dark){body{background:#101513;color:#e4ebe7}}main{max-width:44ch;text-align:center}h1{font-size:20px;margin:0 0 6px}p{margin:0;opacity:.75}</style></head>
<body><main><h1>This report isn't available</h1><p>The link may have been mistyped or turned off. Ask your Gym Members Now contact for a new link.</p></main></body></html>`;

// Reports are stored as page fragments (the same source published as a
// claude.ai artifact: <title>, <style>, markup, <script>), so wrap them in a
// full document here. The <title> moves into <head>.
function wrap(fragment: string, fallbackTitle: string) {
  const m = fragment.match(/<title>([\s\S]*?)<\/title>/i);
  const title = m ? m[1] : fallbackTitle.replace(/[<&]/g, '');
  const body = m ? fragment.replace(m[0], '') : fragment;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex,nofollow"><title>${title}</title>
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style></head><body>${body}</body></html>`;
}

export async function GET(_req: NextRequest, { params }: { params: { token: string } }) {
  const token = params.token || '';
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(token)) return new Response(NOT_FOUND, { status: 404, headers: HEADERS });

  const [row] = await query<{ title: string; html: string }>(
    `SELECT title, html FROM shared_reports WHERE token = $1 AND revoked_at IS NULL LIMIT 1`,
    [token]
  );
  if (!row) return new Response(NOT_FOUND, { status: 404, headers: HEADERS });

  return new Response(wrap(row.html, row.title), { status: 200, headers: HEADERS });
}
