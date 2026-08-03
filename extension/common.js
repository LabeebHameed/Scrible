// Shared helpers for the Scrible extension (MV3 — no persistent state in memory;
// everything lives in chrome.storage so service-worker suspensions are harmless).

export const DEFAULT_API_URL = 'http://localhost:8787';

export async function getConfig() {
  const stored = await chrome.storage.local.get(['apiUrl', 'token', 'deviceId']);
  return {
    apiUrl: stored.apiUrl || DEFAULT_API_URL,
    token: stored.token || null,
    deviceId: stored.deviceId || null,
  };
}

export async function api(path, { method = 'GET', body } = {}) {
  const { apiUrl, token } = await getConfig();
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    await chrome.storage.local.remove('token');
    throw new Error('signed out');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Check in with the backend and return pending computer-action items.
 * Safe to call from any wake event; the backend is the single source of truth.
 */
export async function checkIn() {
  const { token, deviceId } = await getConfig();
  if (!token) return [];
  const { items } = await api('/v1/extension/checkin', {
    method: 'POST',
    body: { deviceId },
  });
  await chrome.action.setBadgeText({ text: items.length ? String(items.length) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#E8B84B' });
  return items;
}
