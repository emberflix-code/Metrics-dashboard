const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(__dirname));

// Fetch all ad accounts for a token
app.get('/api/meta/adaccounts', async (req, res) => {
  const { access_token } = req.query;
  if (!access_token) return res.status(400).json({ error: { message: 'Missing access_token' } });

  const url = `https://graph.facebook.com/v22.0/me/adaccounts?fields=id,name,account_status&limit=100&access_token=${access_token}`;
  console.log('\n[Meta API] Fetching ad accounts for token...');
  try {
    const response = await fetch(url);
    const json = await response.json();
    if (json.error) {
      console.error('[Meta API] ERROR:', JSON.stringify(json.error, null, 2));
    } else {
      console.log(`[Meta API] Found ${(json.data || []).length} ad account(s)`);
      (json.data || []).forEach(a => console.log(`  - ${a.name} (${a.id})`));
    }
    res.status(response.status).json(json);
  } catch (err) {
    console.error('[Meta API] adaccounts fetch failed:', err.message);
    res.status(500).json({ error: { message: err.message, type: 'NetworkError' } });
  }
});

// Fetch campaign list with effective_status
app.get('/api/meta/campaigns', async (req, res) => {
  const { account_id, fields, limit, access_token } = req.query;
  if (!account_id || !access_token) return res.status(400).json({ error: { message: 'Missing account_id or access_token' } });

  const url = new URL(`https://graph.facebook.com/v22.0/act_${account_id}/campaigns`);
  url.searchParams.set('fields', fields || 'id,name,effective_status');
  url.searchParams.set('limit', limit || '100');
  url.searchParams.set('access_token', access_token);
  console.log(`\n[Meta API] Fetching campaign statuses for act_${account_id}...`);
  try {
    const response = await fetch(url.toString());
    const json = await response.json();
    if (json.error) {
      console.error('[Meta API] campaigns ERROR:', JSON.stringify(json.error, null, 2));
    } else {
      console.log(`[Meta API] Got ${(json.data || []).length} campaign statuses`);
    }
    res.status(response.status).json(json);
  } catch (err) {
    console.error('[Meta API] campaigns fetch failed:', err.message);
    res.status(500).json({ error: { message: err.message, type: 'NetworkError' } });
  }
});

// Generic entity status fetch (adsets or ads)
async function fetchEntityStatuses(accountId, entity, accessToken) {
  const url = `https://graph.facebook.com/v22.0/act_${accountId}/${entity}?fields=id,name,effective_status&limit=200&access_token=${accessToken}`;
  const response = await fetch(url);
  const json = await response.json();
  if (json.error) console.error(`[Meta API] ${entity} ERROR:`, JSON.stringify(json.error, null, 2));
  else console.log(`[Meta API] Got ${(json.data || []).length} ${entity} statuses`);
  return json;
}

app.get('/api/meta/adsets', async (req, res) => {
  const { account_id, access_token } = req.query;
  if (!account_id || !access_token) return res.status(400).json({ error: { message: 'Missing params' } });
  console.log(`\n[Meta API] Fetching adset statuses for act_${account_id}...`);
  try {
    const json = await fetchEntityStatuses(account_id, 'adsets', access_token);
    res.status(json.error ? 400 : 200).json(json);
  } catch (err) {
    res.status(500).json({ error: { message: err.message, type: 'NetworkError' } });
  }
});

app.get('/api/meta/ads', async (req, res) => {
  const { account_id, access_token } = req.query;
  if (!account_id || !access_token) return res.status(400).json({ error: { message: 'Missing params' } });
  console.log(`\n[Meta API] Fetching ad statuses for act_${account_id}...`);
  try {
    const json = await fetchEntityStatuses(account_id, 'ads', access_token);
    res.status(json.error ? 400 : 200).json(json);
  } catch (err) {
    res.status(500).json({ error: { message: err.message, type: 'NetworkError' } });
  }
});

// Meta API proxy — all requests/responses logged to terminal
app.get('/api/meta/insights', async (req, res) => {
  const { account_id, fields, level, time_range, limit, access_token, time_increment, action_attribution_windows } = req.query;

  if (!account_id || !access_token) {
    console.error('[Meta Proxy] Missing account_id or access_token');
    return res.status(400).json({ error: { message: 'Missing account_id or access_token' } });
  }

  const url = new URL(`https://graph.facebook.com/v22.0/act_${account_id}/insights`);
  url.searchParams.set('fields', fields || 'campaign_name,reach,impressions,spend,inline_link_clicks,actions');
  url.searchParams.set('level', level || 'campaign');
  url.searchParams.set('time_range', time_range || '{}');
  url.searchParams.set('limit', limit || '100');
  if (time_increment) url.searchParams.set('time_increment', time_increment);
  url.searchParams.set('action_attribution_windows', action_attribution_windows || '["7d_click","1d_view","1d_ev"]');
  url.searchParams.set('access_token', access_token);

  console.log('\n─────────────────────────────────────────');
  console.log('[Meta API] Requesting insights');
  console.log(`  Account:    act_${account_id}`);
  console.log(`  Time range: ${time_range}`);
  console.log(`  Fields:     ${fields}`);
  console.log('─────────────────────────────────────────');

  try {
    const response = await fetch(url.toString());
    const json = await response.json();

    if (json.error) {
      console.error('[Meta API] ERROR RESPONSE:');
      console.error(JSON.stringify(json.error, null, 2));
    } else {
      console.log(`[Meta API] Success — ${(json.data || []).length} records returned`);
      if (json.paging) console.log(`  Paging:`, json.paging.cursors ? 'cursors present' : json.paging.next ? 'next page available' : 'no more pages');
    }

    res.status(response.status).json(json);
  } catch (err) {
    console.error('[Meta API] Fetch failed:', err.message);
    res.status(500).json({ error: { message: err.message, type: 'NetworkError' } });
  }
});

// Proxy for paginated next-page URLs
app.get('/api/meta/next', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: { message: 'Missing url param' } });

  console.log('\n[Meta API] Fetching next page...');
  try {
    const response = await fetch(decodeURIComponent(url));
    const json = await response.json();
    if (json.error) {
      console.error('[Meta API] ERROR on next page:', JSON.stringify(json.error, null, 2));
    } else {
      console.log(`[Meta API] Next page — ${(json.data || []).length} records`);
    }
    res.status(response.status).json(json);
  } catch (err) {
    console.error('[Meta API] Next page fetch failed:', err.message);
    res.status(500).json({ error: { message: err.message, type: 'NetworkError' } });
  }
});

app.listen(PORT, () => {
  console.log('');
  console.log('  Meta Ads Dashboard');
  console.log(`  http://localhost:${PORT}/Meta.html`);
  console.log('');
  console.log('  All Meta API calls and errors will be logged here.');
  console.log('  Press Ctrl+C to stop.\n');
});
