import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import { encrypt } from '@/lib/crypto';
import bcrypt from 'bcryptjs';

const VALID_LEADS_SOURCES = new Set(['meta', 'sheet', 'ghl']);
const VALID_DATA_SOURCES = new Set(['live', 'cached']);
const VALID_RETAINER_MODES = new Set(['flat', 'monthly']);
const MONTH_RE = /^\d{4}-\d{2}$/;

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json();

  const [client] = await query('SELECT id FROM clients WHERE id = $1', [params.id]);
  if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 });

  if (body.campaign_filter !== undefined) {
    await query('UPDATE clients SET campaign_filter = $1 WHERE id = $2', [body.campaign_filter.trim(), params.id]);
  }

  if (body.ad_account_ids !== undefined) {
    if (!Array.isArray(body.ad_account_ids)) {
      return NextResponse.json({ error: 'ad_account_ids must be an array' }, { status: 400 });
    }
    await query('UPDATE clients SET ad_account_ids = $1 WHERE id = $2', [body.ad_account_ids, params.id]);
  }

  if (body.show_account !== undefined) {
    await query('UPDATE clients SET show_account = $1 WHERE id = $2', [!!body.show_account, params.id]);
  }

  if (body.sheet_id !== undefined) {
    await query('UPDATE clients SET sheet_id = $1 WHERE id = $2', [String(body.sheet_id).trim(), params.id]);
  }

  if (body.sheet_tab !== undefined) {
    await query('UPDATE clients SET sheet_tab = $1 WHERE id = $2', [String(body.sheet_tab).trim(), params.id]);
  }

  if (body.google_sheet_tab !== undefined) {
    await query('UPDATE clients SET google_sheet_tab = $1 WHERE id = $2', [String(body.google_sheet_tab).trim(), params.id]);
  }

  if (body.use_sheet_for_leads !== undefined) {
    await query('UPDATE clients SET use_sheet_for_leads = $1 WHERE id = $2', [!!body.use_sheet_for_leads, params.id]);
  }

  // GHL bookings + leads-source picker.
  if (body.ghl_token !== undefined) {
    const t = String(body.ghl_token).trim();
    // Empty string = "keep existing"; only update when a new token is provided.
    if (t.length > 0) {
      await query('UPDATE clients SET ghl_token_enc = $1 WHERE id = $2', [encrypt(t), params.id]);
    }
  }

  if (body.ghl_token_clear === true) {
    // Explicit clear: separate from "keep existing" empty-string semantics above.
    await query(`UPDATE clients SET ghl_token_enc = '' WHERE id = $1`, [params.id]);
  }

  if (body.ghl_location_id !== undefined) {
    await query('UPDATE clients SET ghl_location_id = $1 WHERE id = $2', [String(body.ghl_location_id).trim(), params.id]);
  }

  if (body.leads_source !== undefined) {
    const v = String(body.leads_source).trim();
    if (!VALID_LEADS_SOURCES.has(v)) {
      return NextResponse.json({ error: 'leads_source must be one of: meta, sheet, ghl' }, { status: 400 });
    }
    // Backward-compat for one release: also flip the boolean so any reader
    // that hasn't been migrated still sees the right value.
    await query('UPDATE clients SET leads_source = $1, use_sheet_for_leads = $2 WHERE id = $3', [v, v === 'sheet', params.id]);
  }

  if (body.show_bookings !== undefined) {
    await query('UPDATE clients SET show_bookings = $1 WHERE id = $2', [!!body.show_bookings, params.id]);
  }

  if (body.show_book_rate !== undefined) {
    await query('UPDATE clients SET show_book_rate = $1 WHERE id = $2', [!!body.show_book_rate, params.id]);
  }

  if (body.cpa_sheet_id !== undefined) {
    await query('UPDATE clients SET cpa_sheet_id = $1 WHERE id = $2', [String(body.cpa_sheet_id).trim(), params.id]);
  }

  if (body.cpa_sheet_tab !== undefined) {
    await query('UPDATE clients SET cpa_sheet_tab = $1 WHERE id = $2', [String(body.cpa_sheet_tab).trim(), params.id]);
  }

  if (body.show_cpa !== undefined) {
    await query('UPDATE clients SET show_cpa = $1 WHERE id = $2', [!!body.show_cpa, params.id]);
  }

  if (body.retainer_mode !== undefined) {
    const v = String(body.retainer_mode).trim();
    if (!VALID_RETAINER_MODES.has(v)) {
      return NextResponse.json({ error: 'retainer_mode must be one of: flat, monthly' }, { status: 400 });
    }
    await query('UPDATE clients SET retainer_mode = $1 WHERE id = $2', [v, params.id]);
  }

  if (body.retainer_flat_amount !== undefined) {
    const n = Number(body.retainer_flat_amount);
    if (!Number.isFinite(n) || n < 0) {
      return NextResponse.json({ error: 'retainer_flat_amount must be a non-negative number' }, { status: 400 });
    }
    await query('UPDATE clients SET retainer_flat_amount = $1 WHERE id = $2', [n, params.id]);
  }

  // Monthly retainer rows: [{ month: "2026-07", amount: 3000 }, ...]. Upserts
  // every entry given; does not delete rows omitted from the array, so the
  // admin form can send just the month(s) it changed rather than the full
  // history each time.
  if (body.retainers !== undefined) {
    if (!Array.isArray(body.retainers)) {
      return NextResponse.json({ error: 'retainers must be an array' }, { status: 400 });
    }
    for (const r of body.retainers) {
      const month = String(r?.month ?? '').trim();
      const amount = Number(r?.amount);
      if (!MONTH_RE.test(month) || !Number.isFinite(amount) || amount < 0) {
        return NextResponse.json({ error: `Invalid retainer entry: ${JSON.stringify(r)}` }, { status: 400 });
      }
      await query(
        `INSERT INTO client_retainers (client_id, month, amount)
         VALUES ($1, to_date($2, 'YYYY-MM'), $3)
         ON CONFLICT (client_id, month) DO UPDATE SET amount = EXCLUDED.amount`,
        [params.id, month, amount]
      );
    }
  }

  if (body.ltv_value !== undefined) {
    const n = Number(body.ltv_value);
    if (!Number.isFinite(n) || n < 0) {
      return NextResponse.json({ error: 'ltv_value must be a non-negative number' }, { status: 400 });
    }
    await query('UPDATE clients SET ltv_value = $1 WHERE id = $2', [n, params.id]);
  }

  if (body.show_ltv !== undefined) {
    await query('UPDATE clients SET show_ltv = $1 WHERE id = $2', [!!body.show_ltv, params.id]);
  }

  if (body.data_source !== undefined) {
    const v = String(body.data_source).trim();
    if (!VALID_DATA_SOURCES.has(v)) {
      return NextResponse.json({ error: 'data_source must be one of: live, cached' }, { status: 400 });
    }
    await query('UPDATE clients SET data_source = $1 WHERE id = $2', [v, params.id]);
  }

  if (body.password !== undefined) {
    const pw = String(body.password);
    if (pw.length < 6) {
      return NextResponse.json({ error: 'Password must be at least 6 characters.' }, { status: 400 });
    }
    const hash = await bcrypt.hash(pw, 12);
    await query(
      `UPDATE users SET password_hash = $1
       WHERE id IN (SELECT user_id FROM client_users WHERE client_id = $2)`,
      [hash, params.id]
    );
  }

  return NextResponse.json({ ok: true });
}
