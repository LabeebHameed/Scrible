/**
 * Local app-trigger matching (pure — unit-tested in Node).
 * Everything here runs on the user's machine; process names never leave it.
 */

export function normalizeName(raw: string): string {
  let s = raw.trim().toLowerCase();
  s = s.split(/[\\/]/).pop() ?? s;
  for (const suffix of ['.exe', '.app', '.bin']) {
    if (s.endsWith(suffix)) s = s.slice(0, -suffix.length);
  }
  return s.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const tokens = (s: string): string[] => normalizeName(s).split(' ').filter(Boolean);

/**
 * Does a launched process match an item's app trigger?
 * Rule: every trigger token must match some process token (exact, or a prefix
 * relationship where the shorter side is ≥ 4 chars). Triggers under 3 chars never
 * match — too noisy.
 *
 *   matchesApp('photoshop', 'Adobe Photoshop 2026') → true
 *   matchesApp('premiere pro', 'Adobe Premiere Pro.exe') → true
 *   matchesApp('slack', 'blackslacks') → false (token match, not substring)
 */
export function matchesApp(trigger: string, processName: string): boolean {
  const trig = normalizeName(trigger);
  if (trig.length < 3) return false;
  const trigTokens = tokens(trig);
  const procTokens = tokens(processName);
  if (trigTokens.length === 0 || procTokens.length === 0) return false;
  return trigTokens.every((t) =>
    procTokens.some(
      (p) =>
        p === t ||
        (p.startsWith(t) && t.length >= 4) ||
        (t.startsWith(p) && p.length >= 4),
    ),
  );
}

export interface TriggerItem {
  id: string;
  title: string;
  appTrigger: string | null;
  status: string;
}

/** Items whose trigger matches the launched app, excluding done/dismissed. */
export function matchingItems(items: TriggerItem[], launchedApp: string): TriggerItem[] {
  return items.filter(
    (item) =>
      item.appTrigger &&
      !['done', 'dismissed'].includes(item.status) &&
      matchesApp(item.appTrigger, launchedApp),
  );
}
