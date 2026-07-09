/**
 * Scrible desktop frontend. Sign in → sync app-triggered items → listen for
 * `app-opened` events from the Rust watcher → match locally → notify.
 * Consent-gated: the watcher only runs after the app_watcher consent is granted.
 */
import { DesktopApi } from './api';
import { matchingItems, type TriggerItem } from './matcher';

/** Reminder id → the `deliveredAt` value we last notified for (dedup across polls). */
const notifiedReminders = new Map<string, number>();

// Tauri APIs are absent when the frontend runs in a plain browser (vite dev).
const inTauri = '__TAURI_INTERNALS__' in globalThis;

const DEFAULT_API = 'http://localhost:8787';
const root = document.getElementById('root')!;

interface State {
  apiUrl: string;
  token: string | null;
  deviceId: string | null;
  cursor: number;
  items: TriggerItem[];
  watcherGranted: boolean;
  /** item ids already surfaced for the current launch of an app (session cap). */
  shownThisSession: Set<string>;
}

const state: State = {
  apiUrl: localStorage.getItem('scrible.apiUrl') ?? DEFAULT_API,
  token: localStorage.getItem('scrible.token'),
  deviceId: localStorage.getItem('scrible.deviceId'),
  cursor: Number(localStorage.getItem('scrible.cursor') ?? 0),
  items: JSON.parse(localStorage.getItem('scrible.items') ?? '[]') as TriggerItem[],
  watcherGranted: false,
  shownThisSession: new Set(),
};

const api = new DesktopApi(state.apiUrl, state.token);

function persist(): void {
  localStorage.setItem('scrible.apiUrl', state.apiUrl);
  if (state.token) localStorage.setItem('scrible.token', state.token);
  else localStorage.removeItem('scrible.token');
  if (state.deviceId) localStorage.setItem('scrible.deviceId', state.deviceId);
  localStorage.setItem('scrible.cursor', String(state.cursor));
  localStorage.setItem('scrible.items', JSON.stringify(state.items));
}

// ---------- sync ----------

async function fullRefresh(): Promise<void> {
  state.items = await api.checkin(state.deviceId);
  persist();
  render();
}

async function drainChanges(): Promise<void> {
  try {
    const { changes } = await api.changesSince(state.cursor);
    for (const change of changes) {
      state.cursor = Math.max(state.cursor, change.seq);
      if (change.entityType !== 'item') continue;
      state.items = state.items.filter((i) => i.id !== change.entityId);
      if (change.op === 'upsert' && change.data?.appTrigger && !['done', 'dismissed'].includes(change.data.status)) {
        state.items.push(change.data);
      }
    }
    persist();
    render();
  } catch {
    /* offline — retry next tick */
  }
}

// ---------- watcher wiring ----------

async function setWatcher(enabled: boolean): Promise<void> {
  if (!inTauri) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('set_watcher_enabled', { enabled });
}

async function showNotification(title: string, body: string): Promise<void> {
  if (!inTauri) return;
  const { isPermissionGranted, requestPermission, sendNotification } = await import(
    '@tauri-apps/plugin-notification'
  );
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === 'granted';
  if (!granted) return;
  sendNotification({ title, body });
}

async function notifyMatches(appName: string, matches: TriggerItem[]): Promise<void> {
  if (matches.length === 0) return;
  const first = matches[0]!;
  const more = matches.length > 1 ? ` (+${matches.length - 1} more)` : '';
  await showNotification(`While you're in ${appName}`, `${first.title}${more}`);
}

/**
 * Poll due reminders and notify for any the backend has (re-)delivered since we
 * last showed it — the backend's ReminderScheduler already owns the re-nag cadence
 * (every 5 min, up to 2h) and the "seen" gate; this just mirrors it locally,
 * deduped on `deliveredAt` so a 30s poll doesn't re-notify every cycle.
 */
async function checkReminders(): Promise<void> {
  if (!state.token) return;
  try {
    const due = await api.reminders();
    const now = Date.now();
    for (const r of due) {
      if (r.seenAt || r.fireAt > now || r.deliveredAt == null) continue;
      if (notifiedReminders.get(r.id) === r.deliveredAt) continue;
      notifiedReminders.set(r.id, r.deliveredAt);
      await showNotification('Scrible reminder', r.title);
    }
  } catch {
    /* offline — retry next poll */
  }
}

async function onAppOpened(appName: string): Promise<void> {
  if (!state.watcherGranted) return;
  const matches = matchingItems(state.items, appName).filter((m) => !state.shownThisSession.has(m.id));
  if (matches.length === 0) return;
  for (const m of matches) state.shownThisSession.add(m.id);
  await notifyMatches(appName, matches);
  render(matches.map((m) => m.id));
}

async function startListening(): Promise<void> {
  if (!inTauri) return;
  const { listen } = await import('@tauri-apps/api/event');
  await listen<string>('app-opened', (event) => void onAppOpened(event.payload));
}

// ---------- ui ----------

function el(html: string): HTMLElement {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

function render(highlightIds: string[] = []): void {
  root.replaceChildren();
  if (!state.token) return renderLogin();
  renderMain(highlightIds);
}

function renderLogin(): void {
  const view = el(`
    <div class="pane">
      <h1>Scrible</h1>
      <p class="dim">Pair this computer with your Scrible account.</p>
      <input id="apiUrl" placeholder="server url" value="${state.apiUrl}" />
      <input id="email" type="email" placeholder="email" autocomplete="username" />
      <input id="password" type="password" placeholder="password" autocomplete="current-password" />
      <div class="error" id="err" hidden></div>
      <button class="primary" id="login">Sign in</button>
    </div>
  `);
  view.querySelector('#login')!.addEventListener('click', async () => {
    const err = view.querySelector('#err') as HTMLElement;
    err.hidden = true;
    try {
      state.apiUrl = (view.querySelector('#apiUrl') as HTMLInputElement).value.trim().replace(/\/$/, '');
      api.baseUrl = state.apiUrl;
      state.token = await api.login(
        (view.querySelector('#email') as HTMLInputElement).value.trim(),
        (view.querySelector('#password') as HTMLInputElement).value,
      );
      state.deviceId = await api.registerDevice();
      persist();
      await bootstrapAuthed();
    } catch (e) {
      err.textContent = e instanceof Error ? e.message : 'sign-in failed';
      err.hidden = false;
    }
  });
  root.append(view);
}

function renderMain(highlightIds: string[]): void {
  const view = el(`
    <div class="pane">
      <header>
        <h1>Scrible</h1>
        <button id="signout" class="link">sign out</button>
      </header>
      <div id="consent"></div>
      <p class="dim" id="summary"></p>
      <div id="list"></div>
    </div>
  `);

  const consent = view.querySelector('#consent') as HTMLElement;
  if (!state.watcherGranted) {
    consent.append(
      el(`
        <div class="banner">
          <p><strong>App watcher is off.</strong> When on, Scrible notices app launches
          (e.g. Photoshop) and pops your matching items. App names are read and matched
          <em>on this computer only</em> — they are never uploaded.</p>
          <button class="primary" id="enable">Enable app watcher</button>
        </div>
      `),
    );
    consent.querySelector('#enable')!.addEventListener('click', async () => {
      await api.grantWatcherConsent();
      state.watcherGranted = true;
      await setWatcher(true);
      render();
    });
  }

  const summary = view.querySelector('#summary') as HTMLElement;
  summary.textContent =
    state.items.length === 0
      ? 'No app-linked items yet. Try: “when I open Photoshop remind me to export the banner.”'
      : `${state.items.length} item${state.items.length === 1 ? '' : 's'} waiting for their app:`;

  const list = view.querySelector('#list') as HTMLElement;
  for (const item of state.items) {
    const card = el(`
      <div class="item ${highlightIds.includes(item.id) ? 'hot' : ''}">
        <div>
          <div class="title"></div>
          <div class="trigger">opens with: <code></code></div>
        </div>
        <button class="primary" data-done>Done</button>
      </div>
    `);
    (card.querySelector('.title') as HTMLElement).textContent = item.title;
    (card.querySelector('code') as HTMLElement).textContent = item.appTrigger ?? '';
    card.querySelector('[data-done]')!.addEventListener('click', async () => {
      await api.completeItem(item.id);
      state.items = state.items.filter((i) => i.id !== item.id);
      persist();
      render();
    });
    list.append(card);
  }

  view.querySelector('#signout')!.addEventListener('click', async () => {
    state.token = null;
    state.deviceId = null;
    state.items = [];
    state.cursor = 0;
    api.token = null;
    persist();
    localStorage.removeItem('scrible.token');
    await setWatcher(false);
    render();
  });

  root.append(view);
}

// ---------- bootstrap ----------

async function bootstrapAuthed(): Promise<void> {
  try {
    state.watcherGranted = await api.watcherConsent();
  } catch {
    state.watcherGranted = false;
  }
  await setWatcher(state.watcherGranted);
  await fullRefresh().catch(() => {});
  render();
}

void (async () => {
  render();
  await startListening();
  if (state.token) await bootstrapAuthed();
  setInterval(() => {
    if (!state.token) return;
    void drainChanges();
    void checkReminders();
    // Re-check consent so a revoke from the phone stops the watcher within a minute.
    void api
      .watcherConsent()
      .then((granted) => {
        if (granted !== state.watcherGranted) {
          state.watcherGranted = granted;
          void setWatcher(granted);
          render();
        }
      })
      .catch(() => {});
  }, 30_000);
})();
