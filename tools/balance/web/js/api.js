/** Thin fetch wrappers over the local JSON API. */

export class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

async function request(method, url, body, { keepalive = false } = {}) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    keepalive,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(payload.error ?? `HTTP ${res.status}`, res.status, payload);
  return payload;
}

export const api = {
  state: () => request('GET', '/api/state'),
  save: (name, doc, expectedRevision, opts) => request('PUT', `/api/${name}`, { doc, expectedRevision }, opts),
  importCompendium: () => request('POST', '/api/import', {}),
  simulate: (req) => request('POST', '/api/simulate', req),
  check: (opts) => request('POST', '/api/check', opts ?? {}),
  exportMarkdown: (save = true) => request('GET', `/api/export${save ? '?save=1' : ''}`),
  writeBackPlan: () => request('POST', '/api/writeback/plan', {}),
  writeBackApply: () => request('POST', '/api/writeback/apply', {}),
  pack: () => request('POST', '/api/writeback/pack', {}),
};
