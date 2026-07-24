// Name-prefix grouping heuristic for the Agency Overview. Splits on the
// first " - " or ":" (an explicit region/line separator, e.g. "Omega -
// California", "Ncognito Wellington: STRETCH"); otherwise falls back to the
// first word (e.g. "Alloy Bearden", "StretchLab Crown Point, IN" both group
// under "Alloy" / "StretchLab"). Trailing ", ST"-style city/state suffixes
// are NOT treated as a delimiter — they're noise, not a grouping signal.
export function namePrefixGroup(name: string): string {
  const delimiterMatch = name.match(/^(.*?)\s*(?:-|:)\s/);
  if (delimiterMatch) return delimiterMatch[1].trim();
  const firstWord = name.split(/[\s,]+/)[0];
  return firstWord || name;
}
