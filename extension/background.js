// Scrible MV3 service worker. Event-driven by design (build plan §8.1): wakes on
// browser startup and first-activity-after-idle, pulls pending computer-action
// reminders, and surfaces at most ONE notification per browser session — the
// browser never nags (§8.3 frequency capping).
import { checkIn } from './common.js';

const SESSION_FLAG = 'surfacedThisSession';

async function surfaceIfNeeded(trigger) {
  let items;
  try {
    items = await checkIn();
  } catch {
    return; // offline or signed out — badge stays as-is, popup handles sign-in
  }
  if (!items.length) return;

  // Frequency cap: one proactive surfacing per browser session.
  const session = await chrome.storage.session.get(SESSION_FLAG);
  if (session[SESSION_FLAG]) return;
  await chrome.storage.session.set({ [SESSION_FLAG]: true });

  const first = items[0].title;
  const more = items.length > 1 ? ` (+${items.length - 1} more)` : '';
  chrome.notifications.create('scrible-pending', {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: "You're at your computer —",
    message: `${first}${more}`,
    priority: 0,
  });
  try {
    await import('./common.js').then(({ api }) =>
      api('/v1/extension/shown', { method: 'POST', body: { itemIds: items.map((i) => i.id) } }),
    );
  } catch {
    /* surfacing record is best-effort */
  }
}

// Browser session starts.
chrome.runtime.onStartup.addListener(() => void surfaceIfNeeded('startup'));
chrome.runtime.onInstalled.addListener(() => void surfaceIfNeeded('installed'));

// First activity after idle (≥5 min away).
chrome.idle.setDetectionInterval(300);
chrome.idle.onStateChanged.addListener((state) => {
  if (state === 'active') {
    // New "session" for capping purposes when returning from idle.
    void chrome.storage.session.remove(SESSION_FLAG).then(() => surfaceIfNeeded('idle-return'));
  }
});

// Badge freshness while the browser is open (pull channel; MV3-safe).
chrome.alarms.create('scrible-refresh', { periodInMinutes: 5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'scrible-refresh') void checkIn().catch(() => {});
});

// Clicking the notification opens the popup's item list via the action badge.
chrome.notifications.onClicked.addListener(() => {
  chrome.action.openPopup?.();
});
