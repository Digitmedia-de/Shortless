'use strict';

/*
 * Background worker: fetch proxy for content scripts.
 *
 * Content scripts are subject to the page's CORS (e.g. m.youtube.com cannot
 * access www.youtube.com). The worker may access YouTube cross-origin thanks
 * to host_permissions.
 */

const api = globalThis.browser ?? globalThis.chrome;

const ALLOWED_URL = /^https:\/\/(www|m)\.youtube\.com\//;

/*
 * Builds a fresh init object from an untrusted one. Only an explicit
 * allowlist is honored: method GET/POST only, credentials include/omit
 * (omit by default), a single content-type: application/json header, and
 * a string body only for JSON POSTs. Everything else from the sender is
 * intentionally dropped so this privileged fetch cannot be steered by
 * arbitrary init properties.
 */
function sanitizeInit(init) {
  const safe = { method: 'GET', credentials: 'omit' };
  if (!init || typeof init !== 'object') return safe;
  if (typeof init.method === 'string' && init.method.toUpperCase() === 'POST') {
    safe.method = 'POST';
  }
  if (init.credentials === 'include') {
    safe.credentials = 'include';
  }
  // Only a content-type: application/json header (any key casing, exact
  // value) is passed through; all other headers are dropped.
  if (init.headers && typeof init.headers === 'object') {
    for (const key of Object.keys(init.headers)) {
      if (key.toLowerCase() === 'content-type' && init.headers[key] === 'application/json') {
        safe.headers = { 'content-type': 'application/json' };
        break;
      }
    }
  }
  // Body is only forwarded for JSON POSTs, i.e. when the sanitized headers
  // above contain the application/json content-type.
  if (typeof init.body === 'string' && safe.method === 'POST' && safe.headers) {
    safe.body = init.body;
  }
  return safe;
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'hys-fetch') return;
  if (sender?.id !== api.runtime.id) return;
  if (typeof sender.url !== 'string' || !ALLOWED_URL.test(sender.url)) {
    sendResponse({ ok: false, status: 0, error: 'Sender not allowed' });
    return;
  }
  if (typeof msg.url !== 'string' || !ALLOWED_URL.test(msg.url)) {
    sendResponse({ ok: false, status: 0, error: 'URL not allowed' });
    return;
  }
  (async () => {
    try {
      const res = await fetch(msg.url, sanitizeInit(msg.init));
      sendResponse({ ok: res.ok, status: res.status, text: await res.text() });
    } catch {
      sendResponse({ ok: false, status: 0, error: 'fetch failed' });
    }
  })();
  return true;
});
