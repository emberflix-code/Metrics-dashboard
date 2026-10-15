/**
 * Read-only: Top 10 creatives for the GMN Marketing Report (Alloy), for one month.
 *  - Per-creative metrics come from Meta's image/video asset breakdown (meta_asset_breakdown_daily) — the same per-asset
 *    numbers Ads Manager shows. In Sep 2026 every Alloy ad was Dynamic Creative, so this covers ~99.8% of spend.
 *  - Creatives are grouped REGARDLESS of the text/headline overlay (user, 2026-10-16): two assets are the same creative
 *    when they share the same file across accounts, or their full-frame dHash is within FULL_T bits, or the dHash of the
 *    TOP half of the image (above the usual bottom headline band, computed here from the stored thumbnail bytes) is
 *    within TOP_T bits. Videos use their poster frame.
 *  - Ranked by CPL (Meta leads) among creatives with ≥ MIN_SPEND spend and ≥1 lead (user: $300 floor); top 10.
 *  - Each creative lists the locations that ran it (campaign name → Alloy location by campaign filter, most specific wins).
 * Output: { topCreatives, note } consumed by _build_alloy_month_xlsx.py (9th arg) into the report payload.
 * Run (from portal/): railway run --service Metrics-dashboard npx --yes tsx scripts/monthly-report/_alloy_month_top_creatives.ts 2026-09 <outFile>
 */
import { Pool } from 'pg'
import { writeFileSync } from 'fs'
import sharp from 'sharp'

const [MONTH, OUT] = [process.argv[2] || '2026-09', process.argv[3] || 'alloy_top_creatives.json']
const [y, m] = MONTH.split('-').map(Number)
const SINCE = `${MONTH}-01`, UNTIL = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
const ACCOUNTS = ['1007481743408819', '3023829647843614']
const MIN_SPEND = 300, TOP_N = 10, FULL_T = 6, TOP_T = 6
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 2 })

const matches = (name: string, filter: string) => {
  const needles = (filter || '').split('|').map(s => s.trim()).filter(s => s && !s.startsWith('unfiltered:'))
  return needles.length > 0 && needles.some(n => name.toLowerCase().includes(n.toLowerCase()))
}
const popcount = (x: bigint) => { let c = 0; while (x) { c += Number(x & 1n); x >>= 1n } return c }
const hamming = (a: string, b: string) => popcount(BigInt('0x' + a) ^ BigInt('0x' + b))

/** 64-bit dHash (9x8 grayscale, compare horizontal neighbours) of the top half of an image, as hex. */
async function topHalfHash(bytes: Buffer): Promise<string | null> {
  try {
    const img = sharp(bytes)
    const meta = await img.metadata()
    if (!meta.width || !meta.height) return null
    const px = await img.extract({ left: 0, top: 0, width: meta.width, height: Math.max(1, Math.floor(meta.height / 2)) })
      .grayscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer()
    let h = 0n
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) h = (h << 1n) | (px[r * 9 + c] < px[r * 9 + c + 1] ? 1n : 0n)
    return h.toString(16).padStart(16, '0')
  } catch { return null }
}

type Agg = { spend: number; impressions: number; linkClicks: number; leads: number }
const add = (a: Agg, b: Agg) => { a.spend += b.spend; a.impressions += b.impressions; a.linkClicks += b.linkClicks; a.leads += b.leads }
const zero = (): Agg => ({ spend: 0, impressions: 0, linkClicks: 0, leads: 0 })
const finish = (a: Agg) => ({ spend: Math.round(a.spend * 100) / 100, impressions: a.impressions, linkClicks: a.linkClicks,
  ctr: a.impressions ? Math.round(a.linkClicks / a.impressions * 10000) / 100 : null, leads: a.leads,
  cpl: a.leads ? Math.round(a.spend / a.leads * 100) / 100 : null })

async function main() {
  const locations = (await pool.query(`SELECT DISTINCT ON (name) name, campaign_filter FROM clients
    WHERE name ILIKE 'alloy%' AND name NOT ILIKE 'alloy ops%' AND name NOT ILIKE '%test%' AND COALESCE(campaign_filter,'') <> ''
    ORDER BY name, active DESC`)).rows
  const locOf = new Map<string, string>()
  const locationFor = (campaign: string) => {
    if (!locOf.has(campaign)) {
      const hit = locations.filter(l => matches(campaign, l.campaign_filter)).sort((a, b) => b.campaign_filter.length - a.campaign_filter.length)[0]
      locOf.set(campaign, hit ? hit.name : '(unmatched campaign)')
    }
    return locOf.get(campaign)!
  }

  // per asset × ad × campaign for the month
  const rows = (await pool.query(
    `SELECT b.account_id, b.asset_key, b.ad_id, COALESCE(NULLIF(b.campaign_name,''), MAX(i.campaign_name)) AS campaign_name,
            SUM(b.spend)::float AS spend, SUM(b.impressions)::bigint AS impressions, SUM(b.link_clicks)::bigint AS link_clicks,
            SUM(b.results)::int AS results
     FROM meta_asset_breakdown_daily b
     LEFT JOIN meta_daily_insights i ON i.account_id = b.account_id AND i.level = 'ad' AND i.entity_id = b.ad_id AND i.date = b.date
     WHERE b.account_id = ANY($1) AND b.date BETWEEN $2 AND $3
     GROUP BY b.account_id, b.asset_key, b.ad_id, b.campaign_name`, [ACCOUNTS, SINCE, UNTIL])).rows
  const assetKeys = Array.from(new Set(rows.map(r => `${r.account_id}|${r.asset_key}`)))
  const meta = new Map<string, any>()
  for (const r of (await pool.query(
    `SELECT account_id, asset_key, type, phash, video_id, title, body, thumbnail_bytes FROM meta_creative_assets
     WHERE (account_id || '|' || asset_key) = ANY($1)`, [assetKeys])).rows) meta.set(`${r.account_id}|${r.asset_key}`, r)

  // per asset totals + per location
  type Asset = { id: string; accountId: string; assetKey: string; total: Agg; byLoc: Map<string, Agg>; ads: Set<string>; phash: string | null; top: string | null; type: string; videoId: string | null; title: string | null; body: string | null; hasBytes: boolean }
  const assets = new Map<string, Asset>()
  for (const r of rows) {
    const id = `${r.account_id}|${r.asset_key}`
    let a = assets.get(id)
    if (!a) {
      const md = meta.get(id)
      a = { id, accountId: r.account_id, assetKey: r.asset_key, total: zero(), byLoc: new Map(), ads: new Set(), phash: md?.phash || null,
        top: md?.thumbnail_bytes ? await topHalfHash(md.thumbnail_bytes) : null, type: md?.type || r.asset_key.split(':')[0],
        videoId: md?.video_id || (r.asset_key.startsWith('video:') ? r.asset_key.slice(6) : null), title: md?.title || null,
        body: md?.body || null, hasBytes: !!md?.thumbnail_bytes }
      assets.set(id, a)
    }
    const v = { spend: r.spend, impressions: Number(r.impressions), linkClicks: Number(r.link_clicks), leads: r.results }
    add(a.total, v)
    const loc = locationFor(r.campaign_name || '')
    if (!a.byLoc.has(loc)) a.byLoc.set(loc, zero())
    add(a.byLoc.get(loc)!, v)
    a.ads.add(r.ad_id)
  }

  // group regardless of overlay: union-find (images with images, videos with videos)
  const list = Array.from(assets.values())
  const parent = new Map(list.map(a => [a.id, a.id]))
  const find = (x: string): string => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)! } return x }
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb) }
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j]
    if (a.type !== b.type) continue
    if (a.assetKey === b.assetKey
      || (a.phash && b.phash && hamming(a.phash, b.phash) <= FULL_T)
      || (a.top && b.top && hamming(a.top, b.top) <= TOP_T)) union(a.id, b.id)
  }
  const groups = new Map<string, Asset[]>()
  for (const a of list) { const r = find(a.id); if (!groups.has(r)) groups.set(r, []); groups.get(r)!.push(a) }

  const creatives = Array.from(groups.values()).map(members => {
    const total = zero(); const byLoc = new Map<string, Agg>()
    for (const a of members) { add(total, a.total); for (const [l, v] of Array.from(a.byLoc)) { if (!byLoc.has(l)) byLoc.set(l, zero()); add(byLoc.get(l)!, v) } }
    // canonical = highest-spend member that has a stored thumbnail (so the card has a picture), else highest-spend
    const sorted = [...members].sort((x, y) => y.total.spend - x.total.spend)
    const canon = sorted.find(a => a.hasBytes) || sorted[0]
    return { members, total, byLoc, canon }
  })
  const ranked = creatives.filter(c => c.total.spend >= MIN_SPEND && c.total.leads > 0)
    .sort((a, b) => a.total.spend / a.total.leads - b.total.spend / b.total.leads).slice(0, TOP_N)

  const topCreatives = ranked.map((c, i) => ({
    rank: i + 1, type: c.canon.type === 'video' ? 'video' : 'image', accountId: c.canon.accountId, assetKey: c.canon.assetKey,
    videoId: c.canon.type === 'video' ? c.canon.videoId : null, sampleAdId: Array.from(c.canon.ads)[0] || null,
    title: c.canon.title, body: c.canon.body ? c.canon.body.slice(0, 400) : null, variants: c.members.length,
    ...finish(c.total),
    locations: Array.from(c.byLoc.entries()).map(([location, v]) => ({ location, ...finish(v) })).sort((a, b) => b.spend - a.spend),
  }))
  const covered = creatives.reduce((s, c) => s + c.total.spend, 0)
  const note = `Top ${TOP_N} creatives by cost per lead among creatives with at least $${MIN_SPEND} spend in the month. The same image or ` +
    `video counts as one creative across all locations, even when its headline text differs. Leads here are Meta's per-creative ` +
    `leads (Meta credits some leads to an ad but not to one image or video, so they total less than the location table).`
  writeFileSync(OUT, JSON.stringify({ month: MONTH, topCreatives, note }, null, 1))
  // QA: contact sheet of up to 12 member thumbnails per ranked creative (env QA_DIR), to eyeball the grouping
  if (process.env.QA_DIR) {
    for (const c of ranked) {
      const ms = [...c.members].sort((x, y) => y.total.spend - x.total.spend).slice(0, 12)
      const tiles: Buffer[] = []
      for (const a of ms) {
        const md = meta.get(a.id)
        if (md?.thumbnail_bytes) tiles.push(await sharp(md.thumbnail_bytes).resize(160, 160, { fit: 'contain', background: '#222' }).png().toBuffer())
      }
      if (!tiles.length) continue
      const cols = 6, rowsN = Math.ceil(tiles.length / cols)
      await sharp({ create: { width: cols * 160, height: rowsN * 160, channels: 3, background: '#111' } })
        .composite(tiles.map((t, i) => ({ input: t, left: (i % cols) * 160, top: Math.floor(i / cols) * 160 })))
        .jpeg().toFile(`${process.env.QA_DIR}/creative_${String(ranked.indexOf(c) + 1).padStart(2, '0')}.jpg`)
    }
  }
  console.log(`${list.length} assets -> ${creatives.length} creatives; ${creatives.filter(c => c.total.spend >= MIN_SPEND).length} with >= $${MIN_SPEND}; breakdown spend $${covered.toFixed(2)}`)
  for (const c of topCreatives) console.log(`#${c.rank} ${c.type} ${c.assetKey.slice(0, 22)} variants ${c.variants} | $${c.spend} leads ${c.leads} CPL $${c.cpl} | ${c.locations.length} locations | ${(c.title || '').slice(0, 40)}`)
  const unmatched = topCreatives.flatMap(c => c.locations.filter(l => l.location === '(unmatched campaign)'))
  if (unmatched.length) console.log('WARNING unmatched campaign rows in top creatives:', unmatched.length)
  await pool.end()
}
main().catch(async e => { console.error(e); await pool.end(); process.exit(1) })
