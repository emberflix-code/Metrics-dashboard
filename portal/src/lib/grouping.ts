// Name-prefix grouping heuristic shared by the Agency Overview and the
// marketer module ("brand"). Splits on the first " - " or ":" (an explicit
// region/line separator, e.g. "Omega - California", "Ncognito Wellington:
// STRETCH"); otherwise falls back to the first word (e.g. "Alloy Bearden",
// "StretchLab Crown Point, IN" both group under "Alloy" / "StretchLab").
// Trailing ", ST"-style city/state suffixes are NOT treated as a delimiter —
// they're noise, not a grouping signal.
export function namePrefixGroup(name: string): string {
  const delimiterMatch = name.match(/^(.*?)\s*(?:-|:)\s/);
  if (delimiterMatch) return delimiterMatch[1].trim();
  const firstWord = name.split(/[\s,]+/)[0];
  return firstWord || name;
}

// Corporate-group brand for the marketer module. The prefix heuristic
// above splits "AF Chilliwack" / "Anytime Fitness Kelowna" and "Alloy
// Wheaton" / "Alloy Personal Training - Middleton" into separate groups;
// the agency treats each pair as one corporate group (confirmed 2026-09-24),
// so peer medians and brand filters use these merged names.
const BRAND_RULES: { re: RegExp; brand: string }[] = [
  { re: /^(anytime\s*fitness|anytime|af)\b/i, brand: 'Anytime Fitness' },
  { re: /^alloy\b/i, brand: 'Alloy' },
  { re: /^stretch\s*lab\b/i, brand: 'StretchLab' },
  { re: /^stretch\s*zone\b/i, brand: 'Stretch Zone' },
  { re: /^workout\s*anytime\b/i, brand: 'Workout Anytime' },
  { re: /^omega\b/i, brand: 'Omega' },
  { re: /^ncognito\b/i, brand: 'Ncognito' },
];

export function brandGroup(name: string): string {
  for (const r of BRAND_RULES) if (r.re.test(name.trim())) return r.brand;
  return namePrefixGroup(name);
}
