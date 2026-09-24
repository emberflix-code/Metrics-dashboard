// Offer vocabulary + parsers shared by the marketer module. Ported from the
// (kept, read-only) audit script portal/_omega_copy_audit.ts, which was
// validated against every ACTIVE Omega ad on 2026-09-22 — see the
// project memory "Omega active campaign audit". The agency's campaign
// naming convention is:
//
//   GMN - Instant Form - Join40%Off - #1303 - Tampa, FL
//   GMN - Conversion - Free7DayPass - #4105 - Anderson, CA
//
// i.e. "<prefix> - <offer> - #<club number> - <City>, <ST>". Accounts that
// don't follow it (Alloy, most non-AF brands) parse to null and fall back
// to the Meta KPI sheet's Offer column or the client's own `offer` label
// (see resolveOffer).

/** Canonical offer tokens the copy/offer consistency rules know about. */
export const CANONICAL_OFFERS = [
  'Join40%Off', 'Join50%Off', 'Join30%Off', '25%Off',
  'JoinFor$1', 'JoinFor$1+1MonthFree', '14DayKeyFob',
  'Free7DayPass', 'Free1DayPass', '1MonthFree', '2MonthsFree',
  '6WeekChallenge', '6WC Back2School',
  'PreSale', 'RefreshSale', 'RemodelSpecial', 'GrandOpeningOffer',
] as const;

// Raw campaign-name spellings -> canonical token. Keys are compared after
// lower-casing and stripping whitespace.
const OFFER_ALIASES: Record<string, string> = {
  'join40%off': 'Join40%Off',
  '40%off': 'Join40%Off',
  'join50%off': 'Join50%Off',
  '50%off': 'Join50%Off',
  'join30%off': 'Join30%Off',
  '30%off': 'Join30%Off',
  '25%off': '25%Off',
  'join25%off': '25%Off',
  'joinfor$1': 'JoinFor$1',
  'join$1': 'JoinFor$1',
  '$1enrollment': 'JoinFor$1',
  'joinfor$1+1monthfree': 'JoinFor$1+1MonthFree',
  '14daykeyfob': '14DayKeyFob',
  'keyfob': '14DayKeyFob',
  'free7daypass': 'Free7DayPass',
  '7daypass': 'Free7DayPass',
  'free1daypass': 'Free1DayPass',
  '1daypass': 'Free1DayPass',
  '1monthfree': '1MonthFree',
  'onemonthfree': '1MonthFree',
  'joinget2monthsfree': '2MonthsFree',
  '2monthsfree': '2MonthsFree',
  '2monthfree': '2MonthsFree',
  '6weekchallenge': '6WeekChallenge',
  '6wc': '6WeekChallenge',
  '6-wc': '6WeekChallenge',
  'free6wc': '6WeekChallenge',
  'free6-wc': '6WeekChallenge',
  'free6weekchallenge': '6WeekChallenge',
  '6wcback2school': '6WC Back2School',
  'free14-daykeyfob': '14DayKeyFob',
  'free14daykeyfob': '14DayKeyFob',
  '14-daykeyfob': '14DayKeyFob',
  'free7-daypass': 'Free7DayPass',
  '30daysfree': '30 Days Free',
  '30-daysfree': '30 Days Free',
  'presale': 'PreSale',
  'refreshsale': 'RefreshSale',
  'refreshspecial': 'RefreshSale',
  'remodelspecial': 'RemodelSpecial',
  'grandopeningoffer': 'GrandOpeningOffer',
  'grandopening': 'GrandOpeningOffer',
};

// The N-week-challenge family is spelled a dozen ways across accounts
// ("6-WC Non Free", "Non Free 6WC", "Non-Free 6-WC", "6-Week Challenge Non
// Free", "Free 6-WC", "6WC"...). Two real offers: the free challenge and
// the paid ("non free") one, per length.
function normalizeChallenge(t: string): string | null {
  const m = t.match(/(\d{1,2})\s*-?\s*(?:w(?:ee)?k\s*-?\s*c(?:hallenge)?|wc)\b/i);
  if (!m) return null;
  const weeks = m[1];
  const paid = /non\s*-?\s*free/i.test(t);
  if (weeks === '6' && !paid) return '6WeekChallenge';
  return paid ? `${weeks}WC Non Free` : `${weeks}WC Free`;
}

/** Normalizes a raw offer spelling to its canonical token, or returns the whitespace-collapsed raw string when unknown. */
export function normalizeOffer(raw: string): string {
  const t = raw.replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const k = t.toLowerCase().replace(/\s+/g, '').replace(/off$/i, 'off');
  if (OFFER_ALIASES[k]) return OFFER_ALIASES[k];
  const challenge = normalizeChallenge(t);
  if (challenge) return challenge;
  return t.replace(/OFF$/i, 'Off');
}

// Segment words that describe the campaign type, not the club or the offer.
const TYPE_SEGMENT = /^(instant form|conversion|conversions|lead form|leads?|traffic|messages|engagement|awareness|sales|retargeting)$/i;
// "9/8", "9/22", "10/3/26", "7/29 (men only)"
const DATE_SEGMENT = /^\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/;
const COPY_SEGMENT = /^copy(\s*\d+)?$/i;

/** Splits a campaign name on " - " (also en/em dashes), trimming each segment. */
export function campaignNameSegments(name: string): string[] {
  return name.split(/\s+[-–—]\s+/).map(s => s.trim()).filter(Boolean);
}

/**
 * Generic agency convention: "GMN - <club/client name> - <Offer> - <M/D>"
 * (optionally with a theme segment after the offer, e.g. "… - Free 6-WC -
 * Fall Slimdown - 9/13", and Meta's "- Copy" suffix). Requires the trailing
 * date so unrelated dash-separated names aren't mis-read as offers.
 * Returns the club and offer segments, or null.
 */
export function parseGenericCampaignName(name: string): { club: string; offer: string } | null {
  let seg = campaignNameSegments(name);
  while (seg.length && COPY_SEGMENT.test(seg[seg.length - 1])) seg.pop();
  if (seg.length < 4) return null;                     // GMN, club, offer, date at minimum
  if (!DATE_SEGMENT.test(seg[seg.length - 1])) return null;
  seg = seg.slice(0, -1);
  if (/^gmn\b/i.test(seg[0])) seg = seg.slice(1);
  seg = seg.filter(s => !TYPE_SEGMENT.test(s));
  if (seg.length < 2) return null;
  return { club: seg[0], offer: seg[1] };
}

/**
 * Offer token from a campaign name. Two conventions:
 *  1. Omega: "<prefix> - <Offer> - #<club number> - City, ST"
 *  2. Generic: "GMN - <club> - <Offer> - <M/D>"
 * Null when neither structure is present.
 */
export function parseOfferFromCampaignName(name: string): string | null {
  const m = name.match(/-\s*([^#]+?)\s*-\s*#\d+/);
  if (m) {
    const raw = m[1].trim().replace(/^(Instant Form|Conversion)\s*-\s*/i, '');
    return raw ? normalizeOffer(raw) : null;
  }
  const g = parseGenericCampaignName(name);
  return g ? normalizeOffer(g.offer) || null : null;
}

/** Club / client name segment from the generic convention ("GMN - Kelowna Centuria, BC - …" -> "Kelowna Centuria, BC"), or null. */
export function parseClubNameFromCampaignName(name: string): string | null {
  return parseGenericCampaignName(name)?.club ?? null;
}

/** Offer token declared in an AD name ("… UGC - Free7DayPass - …" / "… Dynamic - X - Free7DayPass - …"), or ''. */
export function parseOfferFromAdName(adName: string): string {
  const m = adName.match(/UGC\s*-\s*([^-]+?)\s*-/i) || adName.match(/Dynamic\s*-\s*[^-]+-\s*([^-]+?)\s*-/i);
  return m ? normalizeOffer(m[1]) : '';
}

/** Club number ("#1303" -> "1303") from a campaign name, or null. */
export function parseClubNumberFromCampaignName(name: string): string | null {
  const m = name.match(/#(\d+)/);
  return m ? m[1] : null;
}

/** City part after the club number ("… - #1303 - Tampa, FL" -> "Tampa"), or ''. */
export function parseCityFromCampaignName(name: string): string {
  return (name.match(/#\d+\s*-\s*([^,(]+)/)?.[1] || '').trim();
}

/** "…, FL" -> "FL", or ''. */
export function parseStateFromCampaignName(name: string): string {
  return (name.match(/,\s*([A-Z]{2})\b/)?.[1] || '').trim();
}

// ── Copy vs offer consistency ────────────────────────────────────────────
// Signals detectable in ad copy text. Each canonical offer expects at least
// one of `any` and must not mention any of `conflict`.
export type OfferSignalKey =
  | '50%' | '40%' | '25%' | '30%' | '$1' | 'keyfob' | '14day' | '7daypass' | '1daypass'
  | 'monthfree' | '6wc' | 'b2s' | 'founding' | 'refresh' | 'remodel' | 'grandopening' | '16.99';

export const OFFER_SIGNALS: { key: OfferSignalKey; re: RegExp }[] = [
  { key: '50%', re: /\b50\s?%/ }, { key: '40%', re: /\b40\s?%/ }, { key: '25%', re: /\b25\s?%/ }, { key: '30%', re: /\b30\s?%/ },
  { key: '$1', re: /\$\s?1(?![\d.,])|for just a dollar|for \$1\b|one dollar/i },
  { key: 'keyfob', re: /key\s?fob/i }, { key: '14day', re: /14[\s-]?day/i },
  { key: '7daypass', re: /7[\s-]?day (pass|gym access|trial)|free 7[\s-]?day/i }, { key: '1daypass', re: /\b1[\s-]?day (pass|trial)|one[\s-]?day pass/i },
  { key: 'monthfree', re: /(first|1st|1)\s?month free|30 days free|month free/i },
  { key: '6wc', re: /6[\s-]?week|six[\s-]?week/i }, { key: 'b2s', re: /back to school/i },
  { key: 'founding', re: /founding member|pre[\s-]?sale/i }, { key: 'refresh', re: /refresh/i }, { key: 'remodel', re: /remodel/i }, { key: 'grandopening', re: /grand opening/i },
  { key: '16.99', re: /16\.99/ },
];

export const OFFER_EXPECTATIONS: Record<string, { any: OfferSignalKey[]; conflict: OfferSignalKey[] }> = {
  'Join40%Off': { any: ['40%'], conflict: ['50%', '25%', '30%'] },
  'Join50%Off': { any: ['50%'], conflict: ['40%', '25%', '30%'] },
  '25%Off': { any: ['25%'], conflict: ['40%', '50%', '30%'] },
  'Join30%Off': { any: ['30%'], conflict: ['40%', '50%', '25%'] },
  'JoinFor$1': { any: ['$1'], conflict: ['40%', '50%', '25%', '7daypass', '1daypass', 'keyfob'] },
  'JoinFor$1+1MonthFree': { any: ['$1', 'monthfree'], conflict: ['40%', '50%', '25%'] },
  '14DayKeyFob': { any: ['keyfob', '14day'], conflict: ['40%', '50%', '25%', '7daypass', '1daypass'] },
  'Free7DayPass': { any: ['7daypass'], conflict: ['1daypass', '40%', '50%', 'keyfob'] },
  'Free1DayPass': { any: ['1daypass'], conflict: ['7daypass', '40%', '50%', 'keyfob'] },
  '1MonthFree': { any: ['monthfree'], conflict: ['40%', '50%', '25%'] },
  '2MonthsFree': { any: ['monthfree'], conflict: ['40%', '50%'] },
  '6WeekChallenge': { any: ['6wc'], conflict: ['40%', '50%'] },
  '6WC Back2School': { any: ['6wc', 'b2s'], conflict: ['40%', '50%'] },
  'PreSale': { any: ['founding'], conflict: [] },
  'RefreshSale': { any: ['refresh'], conflict: [] },
  'RemodelSpecial': { any: ['remodel'], conflict: [] },
  'GrandOpeningOffer': { any: ['grandopening'], conflict: [] },
};

export function detectOfferSignals(text: string): OfferSignalKey[] {
  return OFFER_SIGNALS.filter(s => s.re.test(text)).map(s => s.key);
}

/**
 * Judges a blob of ad copy against an offer token. `missing` = the copy never
 * mentions the offer at all; `conflicts` = signals of a competing offer found
 * in the copy. Both null/empty when the offer token is unknown to the rules.
 */
export function judgeCopyAgainstOffer(text: string, offer: string): { known: boolean; missing: boolean; conflicts: OfferSignalKey[]; found: OfferSignalKey[] } {
  const found = detectOfferSignals(text);
  const exp = OFFER_EXPECTATIONS[offer];
  if (!exp) return { known: false, missing: false, conflicts: [], found };
  return {
    known: true,
    missing: !exp.any.some(k => found.includes(k)),
    conflicts: exp.conflict.filter(k => found.includes(k)),
    found,
  };
}

/** Priority: manual override > campaign-name parse > KPI sheet offer > client offer label > 'Unknown'. */
export function resolveOffer(input: { override?: string | null; campaignName?: string | null; kpiSheetOffer?: string | null; clientOffer?: string | null }): string {
  if (input.override && input.override.trim()) return normalizeOffer(input.override);
  const parsed = input.campaignName ? parseOfferFromCampaignName(input.campaignName) : null;
  if (parsed) return parsed;
  if (input.kpiSheetOffer && input.kpiSheetOffer.trim()) return normalizeOffer(input.kpiSheetOffer);
  if (input.clientOffer && input.clientOffer.trim()) return normalizeOffer(input.clientOffer);
  return 'Unknown';
}
