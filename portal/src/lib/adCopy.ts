// Extracts every copy variant from a Meta ad creative for the marketer
// asset library (meta_ad_copy / meta_copy_texts). Pure — no I/O.
//
// Two creative shapes:
//   DCO / Advantage+ creative — creative.asset_feed_spec { bodies[{text}],
//     titles[{text}], descriptions[{text}], link_urls[{website_url}],
//     call_to_action_types['LEARN_MORE'] }. Meta's body_asset/title_asset/
//     description_asset insight breakdowns report per-variant performance.
//   Static — creative.object_story_spec.link_data { message, name,
//     description, link, call_to_action{type,value{link}}, child_attachments[] }
//     or .video_data { message, title, link_description, call_to_action }.
//     One variant each; its performance is the ad's own row.
import { createHash } from 'crypto';

export type CopyKind = 'body' | 'title' | 'description';

export interface CopyVariant { text: string; hash: string }

export interface ExtractedCopy {
  isDco: boolean;
  bodies: CopyVariant[];
  titles: CopyVariant[];
  descriptions: CopyVariant[];
  linkUrls: string[];
  ctaTypes: string[];
}

export function normalizeCopyText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

/** Stable identity for a piece of copy: sha1 of the whitespace-normalized text. */
export function copyHash(text: string): string {
  return createHash('sha1').update(normalizeCopyText(text)).digest('hex');
}

type AnyRec = Record<string, unknown>;
const rec = (v: unknown): AnyRec | undefined => (v && typeof v === 'object' && !Array.isArray(v)) ? v as AnyRec : undefined;
const arr = (v: unknown): AnyRec[] => Array.isArray(v) ? v as AnyRec[] : [];

function variants(texts: (string | null | undefined)[]): CopyVariant[] {
  const out: CopyVariant[] = [];
  const seen = new Set<string>();
  for (const t of texts) {
    if (typeof t !== 'string') continue;
    const norm = normalizeCopyText(t);
    if (!norm) continue;
    const hash = copyHash(norm);
    if (seen.has(hash)) continue;
    seen.add(hash);
    out.push({ text: norm, hash });
  }
  return out;
}

export function extractCopy(creative: unknown): ExtractedCopy {
  const c = rec(creative) ?? {};
  const afs = rec(c.asset_feed_spec);
  const oss = rec(c.object_story_spec);

  const bodies: (string | null | undefined)[] = [];
  const titles: (string | null | undefined)[] = [];
  const descriptions: (string | null | undefined)[] = [];
  const linkUrls = new Set<string>();
  const ctaTypes = new Set<string>();

  const isDco = !!afs && (arr(afs.bodies).length > 0 || arr(afs.titles).length > 0 || arr(afs.descriptions).length > 0);
  if (afs) {
    for (const b of arr(afs.bodies)) bodies.push(b.text as string);
    for (const t of arr(afs.titles)) titles.push(t.text as string);
    for (const d of arr(afs.descriptions)) descriptions.push(d.text as string);
    for (const l of arr(afs.link_urls)) if (typeof l.website_url === 'string') linkUrls.add(l.website_url);
    for (const cta of (Array.isArray(afs.call_to_action_types) ? afs.call_to_action_types as unknown[] : [])) if (typeof cta === 'string') ctaTypes.add(cta);
  }

  if (oss) {
    const ld = rec(oss.link_data);
    const vd = rec(oss.video_data);
    const pd = rec(oss.photo_data);
    if (ld) {
      bodies.push(ld.message as string);
      titles.push(ld.name as string);
      descriptions.push(ld.description as string);
      if (typeof ld.link === 'string') linkUrls.add(ld.link);
      const cta = rec(ld.call_to_action);
      if (cta && typeof cta.type === 'string') ctaTypes.add(cta.type);
      const ctaLink = rec(cta?.value)?.link;
      if (typeof ctaLink === 'string') linkUrls.add(ctaLink);
      for (const child of arr(ld.child_attachments)) {
        titles.push(child.name as string);
        descriptions.push(child.description as string);
        if (typeof child.link === 'string') linkUrls.add(child.link);
      }
    }
    if (vd) {
      bodies.push(vd.message as string);
      titles.push(vd.title as string);
      descriptions.push(vd.link_description as string);
      const cta = rec(vd.call_to_action);
      if (cta && typeof cta.type === 'string') ctaTypes.add(cta.type);
      const ctaLink = rec(cta?.value)?.link;
      if (typeof ctaLink === 'string') linkUrls.add(ctaLink);
    }
    if (pd) {
      bodies.push(pd.caption as string);
    }
  }

  // Legacy top-level creative fields (older creatives without a spec).
  if (bodies.length === 0 && typeof c.body === 'string') bodies.push(c.body);
  if (titles.length === 0 && typeof c.title === 'string') titles.push(c.title);

  return {
    isDco,
    bodies: variants(bodies),
    titles: variants(titles),
    descriptions: variants(descriptions),
    linkUrls: Array.from(linkUrls),
    ctaTypes: Array.from(ctaTypes),
  };
}

/** All copy text of an ad joined, for offer/city consistency rules. */
export function joinCopyText(copy: Pick<ExtractedCopy, 'bodies' | 'titles' | 'descriptions'>): string {
  return [...copy.bodies, ...copy.titles, ...copy.descriptions].map(v => v.text).join('\n');
}
