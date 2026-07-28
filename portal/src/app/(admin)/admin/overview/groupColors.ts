// Deterministic accent color per group, Monday.com-style — same group name
// always gets the same color across renders/reloads (hash of the key, not
// row order, which can shift as clients are added/removed/filtered).
const PALETTE = [
  { bar: '#fdab3d', tint: 'rgba(253,171,61,0.12)' },   // amber
  { bar: '#e2445c', tint: 'rgba(226,68,92,0.12)' },    // red
  { bar: '#a25ddc', tint: 'rgba(162,93,220,0.12)' },   // purple
  { bar: '#0086c0', tint: 'rgba(0,134,192,0.12)' },    // blue
  { bar: '#00c875', tint: 'rgba(0,200,117,0.12)' },    // green
  { bar: '#ff642e', tint: 'rgba(255,100,46,0.12)' },   // orange
  { bar: '#579bfc', tint: 'rgba(87,155,252,0.12)' },   // light blue
  { bar: '#bb3354', tint: 'rgba(187,51,84,0.12)' },    // maroon
  { bar: '#66ccff', tint: 'rgba(102,204,255,0.12)' },  // sky
  { bar: '#9d99b9', tint: 'rgba(157,153,185,0.12)' },  // grey-purple
];

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function groupColorFor(key: string): { bar: string; tint: string } {
  return PALETTE[hashString(key) % PALETTE.length];
}
