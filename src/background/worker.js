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

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'hys-fetch') return;
  if (typeof msg.url !== 'string' || !ALLOWED_URL.test(msg.url)) {
    sendResponse({ ok: false, status: 0, error: 'URL not allowed' });
    return;
  }
  (async () => {
    try {
      const res = await fetch(msg.url, msg.init);
      sendResponse({ ok: res.ok, status: res.status, text: await res.text() });
    } catch (e) {
      sendResponse({ ok: false, status: 0, error: String(e) });
    }
  })();
  return true;
});
