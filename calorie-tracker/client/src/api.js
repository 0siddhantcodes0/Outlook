// Thin fetch wrapper around the Snap Calories HTTP API (see CONTRACT.md).

const TOKEN_KEY = 'snapcal.token';

// Header values must be Latin-1. fetch throws on anything else (emoji, "€",
// most non-Latin keyboards), and that would look like the server being down.
export const isValidToken = (token) => /^[\x20-\x7e\xa0-\xff]+$/.test(token);

export function getToken() {
  try {
    const token = localStorage.getItem(TOKEN_KEY) || '';
    return isValidToken(token) ? token : '';
  } catch {
    return '';
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private mode or storage disabled: the passcode just won't persist.
  }
}

export class ApiError extends Error {
  constructor(code, message, status = 0) {
    super(message || code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

async function request(path, { method = 'GET', json, body, signal } = {}) {
  const headers = { accept: 'application/json' };
  const token = getToken();
  if (token) headers['x-app-token'] = token;
  if (json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(json);
  }

  let res;
  try {
    res = await fetch(path, { method, headers, body, signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError('network_error', 'Could not reach the server.');
  }

  if (res.status === 204) return null;

  let data = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON body, e.g. a dev proxy error page.
  }

  if (!res.ok) {
    if (data?.error) throw new ApiError(data.error, data.message, res.status);
    // No JSON error body means something in between answered (proxy, server down).
    const code =
      res.status === 401 ? 'unauthorized'
      : res.status === 413 ? 'image_too_large'
      : res.status >= 500 ? 'network_error'
      : `http_${res.status}`;
    throw new ApiError(code, res.statusText, res.status);
  }
  return data;
}

const qs = (params) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, value);
  }
  const str = search.toString();
  return str ? `?${str}` : '';
};

export const api = {
  health: () => request('/api/health'),

  async scan({ file, date, hint, signal }) {
    const form = new FormData();
    form.append('image', file, file.name || 'photo.jpg');
    if (date) form.append('date', date);
    if (hint) form.append('hint', hint);
    const { meal } = await request('/api/scan', { method: 'POST', body: form, signal });
    return meal;
  },

  meals: (date) => request(`/api/meals${qs({ date })}`),

  async addMeal(fields) {
    const { meal } = await request('/api/meals', { method: 'POST', json: fields });
    return meal;
  },

  async updateMeal(id, fields) {
    const { meal } = await request(`/api/meals/${id}`, { method: 'PATCH', json: fields });
    return meal;
  },

  deleteMeal: (id) => request(`/api/meals/${id}`, { method: 'DELETE' }),

  history: (end, days = 7) => request(`/api/history${qs({ end, days })}`),

  settings: () => request('/api/settings'),

  saveSettings: (fields) => request('/api/settings', { method: 'PUT', json: fields }),
};

// --- Dates -------------------------------------------------------------------
// Dates are local-calendar strings (YYYY-MM-DD). Never use toISOString() here:
// it is UTC and would log late-evening meals to the wrong day.

const pad = (n) => String(n).padStart(2, '0');

export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Noon, so a DST shift can never push the date across midnight.
export function parseLocalDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}

export function addDays(str, days) {
  const d = parseLocalDate(str);
  d.setDate(d.getDate() + days);
  return localDate(d);
}
