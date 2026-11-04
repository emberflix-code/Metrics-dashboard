// The signed-in user's coach-board settings (visible columns, grouping, date
// range, collapsed groups; admins also their coach filter), stored per user
// in user_preferences so they follow the coach to any browser.
import { query } from '../db';
import { defaultPrefs, sanitizeColumns, GROUP_BY_KEYS, RANGE_KEYS, type CoachBoardPrefs } from './columns';

export const BOARD_PREF_KEY = 'coach_board';

export async function loadBoardPrefs(userId: string, isAdmin: boolean): Promise<CoachBoardPrefs> {
  const [row] = await query<{ value: Partial<CoachBoardPrefs> }>(
    `SELECT value FROM user_preferences WHERE user_id = $1 AND pref_key = $2`, [userId, BOARD_PREF_KEY]).catch(() => []);
  const base = defaultPrefs(isAdmin);
  const v = row?.value || {};
  const columns = sanitizeColumns(v.columns);
  return {
    columns: columns.length ? columns : base.columns,
    groupBy: GROUP_BY_KEYS.includes(String(v.groupBy)) && (isAdmin || v.groupBy !== 'coach') ? String(v.groupBy) : base.groupBy,
    range: RANGE_KEYS.includes(String(v.range)) ? String(v.range) : base.range,
    collapsed: Array.isArray(v.collapsed) ? v.collapsed.filter(x => typeof x === 'string').slice(0, 100) : [],
    coachFilter: isAdmin && typeof v.coachFilter === 'string' ? v.coachFilter : '',
  };
}

/** Merge a validated partial update into the stored settings. */
export async function saveBoardPrefs(userId: string, isAdmin: boolean, body: Record<string, unknown>): Promise<void> {
  const patch: Partial<CoachBoardPrefs> = {};
  if (body.columns !== undefined) patch.columns = sanitizeColumns(body.columns);
  if (body.groupBy !== undefined && GROUP_BY_KEYS.includes(String(body.groupBy))) patch.groupBy = String(body.groupBy);
  if (body.range !== undefined && RANGE_KEYS.includes(String(body.range))) patch.range = String(body.range);
  if (Array.isArray(body.collapsed)) patch.collapsed = body.collapsed.filter((x: unknown) => typeof x === 'string').map(x => (x as string).slice(0, 100)).slice(0, 100);
  if (isAdmin && typeof body.coachFilter === 'string') patch.coachFilter = body.coachFilter.slice(0, 100);
  await query(
    `INSERT INTO user_preferences (user_id, pref_key, value, updated_at) VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (user_id, pref_key) DO UPDATE SET value = user_preferences.value || EXCLUDED.value, updated_at = now()`,
    [userId, BOARD_PREF_KEY, JSON.stringify(patch)]
  );
}
