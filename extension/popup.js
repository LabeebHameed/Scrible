// Scrible extension popup: sign-in/pairing, pending computer-action list with
// complete / snooze / open-dashboard (build plan §8.3).
import { api, checkIn, getConfig, DEFAULT_API_URL } from './common.js';

const main = document.getElementById('main');
const signoutBtn = document.getElementById('signout');

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

async function render() {
  const { token } = await getConfig();
  signoutBtn.hidden = !token;
  main.replaceChildren();
  if (!token) return renderSignIn();
  return renderList();
}

function renderSignIn() {
  const form = el(`
    <div>
      <p class="dim">Pair this browser with your Scrible account.</p>
      <input id="apiUrl" placeholder="server url" />
      <input id="email" type="email" placeholder="email" autocomplete="username" />
      <input id="password" type="password" placeholder="password" autocomplete="current-password" />
      <div class="error" id="err" hidden></div>
      <button class="primary" id="login">Sign in</button>
    </div>
  `);
  main.append(form);
  getConfig().then(({ apiUrl }) => (form.querySelector('#apiUrl').value = apiUrl || DEFAULT_API_URL));
  form.querySelector('#login').addEventListener('click', async () => {
    const apiUrl = form.querySelector('#apiUrl').value.trim().replace(/\/$/, '');
    const email = form.querySelector('#email').value.trim();
    const password = form.querySelector('#password').value;
    const err = form.querySelector('#err');
    err.hidden = true;
    try {
      await chrome.storage.local.set({ apiUrl });
      const res = await api('/v1/auth/login', { method: 'POST', body: { email, password } });
      await chrome.storage.local.set({ token: res.token });
      // Enroll in the device registry as a popup-capable device (plan §8.1).
      const device = await api('/v1/devices', {
        method: 'POST',
        body: { platform: 'extension', capabilities: { canShowPopups: true } },
      });
      await chrome.storage.local.set({ deviceId: device.id });
      await render();
    } catch (e) {
      err.textContent = e.message === 'signed out' ? 'Wrong email or password.' : `Could not sign in: ${e.message}`;
      err.hidden = false;
    }
  });
}

async function renderList() {
  let items = [];
  try {
    items = await checkIn();
  } catch (e) {
    main.append(el(`<p class="error">Can't reach Scrible (${e.message}).</p>`));
    return;
  }
  const snoozed = (await chrome.storage.session.get('snoozed')).snoozed || {};
  const visible = items.filter((i) => !snoozed[i.id] || snoozed[i.id] < Date.now());
  if (!visible.length) {
    main.append(el(`<p class="dim">Nothing needs your computer right now. 🎉</p>`));
    return;
  }
  main.append(el(`<p class="dim">While you're here:</p>`));
  for (const item of visible) {
    const card = el(`
      <div class="item">
        <div class="title"></div>
        <div class="actions">
          <button class="primary" data-act="done">Done</button>
          <button data-act="later">Later today</button>
          <button data-act="next">Next session</button>
        </div>
      </div>
    `);
    card.querySelector('.title').textContent = item.title;
    card.addEventListener('click', async (ev) => {
      const act = ev.target?.dataset?.act;
      if (!act) return;
      if (act === 'done') {
        await api(`/v1/items/${item.id}/complete`, { method: 'POST', body: {} });
      } else {
        const until = act === 'later' ? Date.now() + 3 * 3600_000 : Number.MAX_SAFE_INTEGER;
        const cur = (await chrome.storage.session.get('snoozed')).snoozed || {};
        cur[item.id] = until;
        await chrome.storage.session.set({ snoozed: cur });
      }
      card.remove();
      const left = main.querySelectorAll('.item').length;
      chrome.action.setBadgeText({ text: left ? String(left) : '' });
      if (!left) main.append(el(`<p class="dim">All clear. 🎉</p>`));
    });
    main.append(card);
  }
}

signoutBtn.addEventListener('click', async () => {
  await chrome.storage.local.remove(['token', 'deviceId']);
  await chrome.action.setBadgeText({ text: '' });
  await render();
});

void render();
