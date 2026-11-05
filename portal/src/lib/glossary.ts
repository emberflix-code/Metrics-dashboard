// Abbreviations used across the dashboards, shown in the "?" help pop-up.
// audience 'all' = client dashboards and coach board; 'coach' = coach board only
// (internal terms clients never see).

export interface GlossaryEntry {
  term: string;
  meaning: string;
  how?: string;
  audience: 'all' | 'coach';
}

export interface GlossarySection {
  title: string;
  entries: GlossaryEntry[];
}

export const GLOSSARY: GlossarySection[] = [
  {
    title: 'Costs and results',
    entries: [
      { term: 'CPL', meaning: 'Cost Per Lead', how: 'Spend ÷ leads', audience: 'all' },
      { term: 'CPB', meaning: 'Cost Per Booking', how: 'Spend ÷ bookings (booked appointments or tours)', audience: 'all' },
      { term: 'CPJ', meaning: 'Cost Per Join', how: 'Spend ÷ joins (people who signed up for a membership)', audience: 'all' },
      { term: 'CPA', meaning: 'Cost Per Acquisition (cost per sale)', how: '(Ad spend + retainer) ÷ won sales', audience: 'all' },
      { term: 'LTV', meaning: 'Lifetime Value', how: 'Won sales × value of one member', audience: 'all' },
      { term: 'CPM', meaning: 'Cost Per 1,000 impressions', how: 'Spend ÷ impressions × 1,000', audience: 'all' },
      { term: 'CPC', meaning: 'Cost Per Click', how: 'Spend ÷ link clicks', audience: 'all' },
      { term: 'CTR', meaning: 'Click-Through Rate', how: 'Link clicks ÷ impressions', audience: 'all' },
      { term: 'KPI', meaning: 'Key Performance Indicator', how: 'The headline cards at the top (Spend, Leads, CPL, …)', audience: 'all' },
      { term: 'LW CPL Trend', meaning: 'Last Week CPL Trend', how: "Last week's CPL vs the week before (weeks run Friday–Thursday)", audience: 'all' },
      { term: 'Results', meaning: "Meta's count of the result the campaign optimizes for — leads, for lead campaigns", audience: 'all' },
      { term: 'Reach', meaning: 'Number of different people who saw the ads', audience: 'all' },
      { term: 'Impressions', meaning: 'Number of times the ads were shown (one person can see an ad more than once)', audience: 'all' },
    ],
  },
  {
    title: 'Ads and creatives',
    entries: [
      { term: 'DCO', meaning: 'Dynamic Creative Optimization — Meta mixes several images, videos and texts in one ad and shows the best combinations', audience: 'all' },
      { term: 'UGC', meaning: 'User-Generated Content — phone-style videos of real members or staff, as opposed to polished ads', audience: 'all' },
      { term: 'BM', meaning: 'Business Manager (Meta Business Manager that owns the ad accounts)', audience: 'coach' },
    ],
  },
  {
    title: 'Offer codes (in campaign names)',
    entries: [
      { term: 'JF1', meaning: 'Join For $1', audience: 'all' },
      { term: '2MF', meaning: '2 Months Free', audience: 'all' },
      { term: '7DP', meaning: '7-Day Pass', audience: 'all' },
      { term: '1DP', meaning: '1-Day Pass', audience: 'all' },
      { term: 'ROTY', meaning: 'Rest Of The Year free', audience: 'all' },
      { term: 'PreSale', meaning: 'Pre-sale offer before a club opens', audience: 'all' },
    ],
  },
  {
    title: 'Systems and names',
    entries: [
      { term: 'GHL', meaning: 'GoHighLevel — the CRM where leads and bookings are tracked', audience: 'all' },
      { term: 'CRM', meaning: 'Customer Relationship Management system (GHL for most clubs)', audience: 'all' },
      { term: 'GMN', meaning: 'Gym Members Now — campaign names start with "GMN -"', audience: 'all' },
      { term: 'AF', meaning: 'Anytime Fitness', audience: 'all' },
      { term: 'PT', meaning: 'Personal Training (e.g. the "PT Retainers" group)', audience: 'coach' },
      { term: 'ET', meaning: 'US Eastern Time — the coach board counts days in Eastern time', audience: 'coach' },
      { term: 'Cached / Live', meaning: "Meta data source: Cached = synced daily (fast); Live = fetched from Meta on every load", audience: 'coach' },
      { term: 'Rollup', meaning: "A combined dashboard that adds up several clubs' numbers", audience: 'coach' },
      { term: 'CSV', meaning: 'Spreadsheet file you can download with Export', audience: 'all' },
    ],
  },
];

export function glossaryFor(audience: 'client' | 'coach'): GlossarySection[] {
  return GLOSSARY
    .map(s => ({ ...s, entries: s.entries.filter(e => audience === 'coach' || e.audience === 'all') }))
    .filter(s => s.entries.length > 0);
}
