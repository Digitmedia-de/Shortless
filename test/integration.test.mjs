'use strict';

/*
 * Integration tests for GitHub Issue #1 (hardened background fetch proxy).
 *
 * Exercises the full message flow at the privileged boundary of
 * src/background/worker.js: content-script message (mirroring the real
 * caller contract of httpText() in src/content/subs.js) -> onMessage
 * listener -> sender validation -> sanitized fetch -> response shape.
 *
 * NOTE: the loadWorker/dispatch harness below is intentionally a copy of
 * the pattern in test/worker.test.mjs. Three test-writers run in parallel
 * on separate files, so each file is fully self-contained (accepted
 * duplication for parallel-write isolation).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, '..', 'src', 'background', 'worker.js');
const EXTENSION_ID = 'test-ext-id';

/**
 * Loads worker.js in a fresh VM context.
 *
 * worker.js is a plain (non-module) script that resolves the extension API
 * via `globalThis.browser ?? globalThis.chrome` and calls the bare global
 * `fetch`. The sandbox therefore provides a mock `chrome` object and the
 * given fetch implementation. `browser` is intentionally left undefined.
 *
 * Returns the listener registered via runtime.onMessage.addListener so
 * tests can invoke it directly as (msg, sender, sendResponse).
 */
function loadWorker({ fetchImpl }) {
  const code = fs.readFileSync(WORKER_PATH, 'utf8');
  let listener = null;
  const sandbox = {
    fetch: fetchImpl,
    chrome: {
      runtime: {
        id: EXTENSION_ID,
        onMessage: {
          addListener(fn) {
            listener = fn;
          },
        },
      },
    },
  };
  vm.runInNewContext(code, sandbox, { filename: WORKER_PATH });
  assert.equal(typeof listener, 'function', 'worker must register an onMessage listener');
  return listener;
}

/**
 * Invokes the listener and resolves with both the value passed to
 * sendResponse and the listener's synchronous return value:
 *   { response, returned, responded }
 *
 * The worker signals an async response by returning true and resolves
 * sendResponse on the microtask queue, so awaiting this promise suffices.
 * If the listener returns without claiming the response channel (sync
 * return, no `true`), microtasks are flushed and the promise settles with
 * whatever sendResponse received synchronously (or response: undefined,
 * responded: false when sendResponse was never called).
 */
function dispatch(listener, msg, sender) {
  return new Promise((resolve) => {
    let responded = false;
    let response;
    const sendResponse = (value) => {
      responded = true;
      // Responses are constructed inside the VM realm; copy to a host-realm
      // object so assert.deepEqual (strict) does not trip over the foreign
      // Object.prototype. Worker responses are flat objects.
      response = value && typeof value === 'object' ? { ...value } : value;
      // Settle only here for async (`return true`) paths.
      if (settleOnResponse) resolve({ response, returned, responded });
    };
    let settleOnResponse = false;
    const returned = listener(msg, sender, sendResponse);
    if (returned === true) {
      if (responded) {
        resolve({ response, returned, responded });
      } else {
        settleOnResponse = true;
      }
    } else {
      // No async response pending; flush microtasks then settle.
      queueMicrotask(() => resolve({ response, returned, responded }));
    }
  });
}

// Minimal fetch-response shape the worker consumes: ok, status, text().
function makeResponse({ ok = true, status = 200, body = 'body' } = {}) {
  return { ok, status, text: async () => body };
}

/*
 * Mirror of the real caller contract from src/content/subs.js httpText():
 *
 *   async function httpText(url, init) {
 *     const r = await api.runtime.sendMessage({ type: 'hys-fetch', url, init });
 *     if (!r || !r.ok) throw new Error(`HTTP ${r?.status ?? '?'} for ${url}`);
 *     return r.text;
 *   }
 *
 * Here sendMessage is replaced by dispatching into the worker listener.
 */
function makeHttpText(listener, sender) {
  return async function httpText(url, init) {
    const { response: r } = await dispatch(listener, { type: 'hys-fetch', url, init }, sender);
    if (!r || !r.ok) throw new Error(`HTTP ${r?.status ?? '?'} for ${url}`);
    return r.text;
  };
}

const VALID_SENDER = Object.freeze({ id: EXTENSION_ID, url: 'https://www.youtube.com/feed/channels' });

test('end-to-end happy path: httpText() contract over the worker for GET and JSON POST', async () => {
  const fetchCalls = [];
  const listener = loadWorker({
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init });
      if (init.method === 'POST') {
        return makeResponse({ body: '{"continuation":null}' });
      }
      return makeResponse({ body: '<html>ytInitialData</html>' });
    },
  });
  const httpText = makeHttpText(listener, VALID_SENDER);

  // GET, exactly like fetchSubscriptions() does for the channels page.
  const html = await httpText('https://www.youtube.com/feed/channels', { credentials: 'include' });
  assert.equal(html, '<html>ytInitialData</html>', 'httpText must receive the body via r.text');

  // JSON POST, exactly like the innertube continuation call.
  const body = await httpText(
    'https://www.youtube.com/youtubei/v1/browse?key=K&prettyPrint=false',
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ context: {}, continuation: 'token' }),
    },
  );
  assert.equal(body, '{"continuation":null}');

  assert.equal(fetchCalls.length, 2, 'each httpText call must reach fetch exactly once');

  // The privileged fetch sees only sanitized init, but the caller-relevant
  // parts of the contract survive sanitization.
  const [getCall, postCall] = fetchCalls;
  assert.equal(getCall.url, 'https://www.youtube.com/feed/channels');
  assert.equal(getCall.init.method, 'GET');
  assert.equal(getCall.init.credentials, 'include');

  assert.equal(postCall.init.method, 'POST');
  assert.equal(postCall.init.credentials, 'include');
  // Spread: sanitizeInit builds this object in the VM realm (foreign prototype).
  assert.deepEqual({ ...postCall.init.headers }, { 'content-type': 'application/json' });
  assert.equal(postCall.init.body, JSON.stringify({ context: {}, continuation: 'token' }));
});

test('sender matrix: foreign id ignored silently; bad sender.url rejected; m.youtube.com allowed', async () => {
  const msg = { type: 'hys-fetch', url: 'https://www.youtube.com/feed/channels' };

  // (a) foreign extension id -> no response at all, fetch never called,
  // listener does not claim the async channel (returns undefined, not true).
  {
    const fetchCalls = [];
    const listener = loadWorker({
      fetchImpl: async (...args) => {
        fetchCalls.push(args);
        return makeResponse();
      },
    });
    const { response, returned, responded } = await dispatch(listener, msg, {
      id: 'some-other-extension',
      url: 'https://www.youtube.com/',
    });
    assert.equal(responded, false, 'sendResponse must never be called for a foreign sender id');
    assert.equal(response, undefined);
    assert.notEqual(returned, true, 'listener must not return true for an ignored foreign message');
    assert.equal(fetchCalls.length, 0, 'fetch must never be called for a foreign sender id');
  }

  // (b) correct id but sender.url missing -> 'Sender not allowed'.
  {
    const fetchCalls = [];
    const listener = loadWorker({
      fetchImpl: async (...args) => {
        fetchCalls.push(args);
        return makeResponse();
      },
    });
    const { response } = await dispatch(listener, msg, { id: EXTENSION_ID });
    assert.deepEqual(response, { ok: false, status: 0, error: 'Sender not allowed' });
    assert.equal(fetchCalls.length, 0, 'fetch must not be called when sender.url is missing');
  }

  // (c) correct id + non-YouTube sender.url -> 'Sender not allowed'.
  {
    const fetchCalls = [];
    const listener = loadWorker({
      fetchImpl: async (...args) => {
        fetchCalls.push(args);
        return makeResponse();
      },
    });
    const { response } = await dispatch(listener, msg, {
      id: EXTENSION_ID,
      url: 'https://evil.example/watch',
    });
    assert.deepEqual(response, { ok: false, status: 0, error: 'Sender not allowed' });
    assert.equal(fetchCalls.length, 0, 'fetch must not be called for a non-YouTube sender page');
  }

  // (d) correct id + m.youtube.com sender.url -> allowed (mobile subdomain).
  {
    const fetchCalls = [];
    const listener = loadWorker({
      fetchImpl: async (url, init) => {
        fetchCalls.push({ url, init });
        return makeResponse({ body: 'mobile-ok' });
      },
    });
    const { response, returned } = await dispatch(listener, msg, {
      id: EXTENSION_ID,
      url: 'https://m.youtube.com/feed/subscriptions',
    });
    assert.equal(fetchCalls.length, 1, 'fetch must be called for an m.youtube.com sender');
    assert.equal(returned, true, 'listener must return true for the async fetch path');
    assert.deepEqual(response, { ok: true, status: 200, text: 'mobile-ok' });
  }
});

test('error path: fetch rejection yields exactly { ok:false, status:0, error:"fetch failed" }', async () => {
  const listener = loadWorker({
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED 10.0.0.5:443 secret-internal-host token=abc123');
    },
  });

  const { response, returned } = await dispatch(
    listener,
    { type: 'hys-fetch', url: 'https://www.youtube.com/feed/channels' },
    VALID_SENDER,
  );

  assert.equal(returned, true, 'error path is async, listener must return true');
  // Full-shape assertion: no extra fields, no leaked exception text.
  assert.deepEqual(response, { ok: false, status: 0, error: 'fetch failed' });
  assert.deepEqual(Object.keys(response).sort(), ['error', 'ok', 'status']);
});

test('non-2xx upstream response is relayed with ok:false, real status, and body text', async () => {
  const listener = loadWorker({
    fetchImpl: async () => makeResponse({ ok: false, status: 500, body: 'Internal Server Error' }),
  });

  const { response } = await dispatch(
    listener,
    { type: 'hys-fetch', url: 'https://www.youtube.com/youtubei/v1/browse?key=K' },
    VALID_SENDER,
  );

  // Per worker contract the body text IS read and relayed even for non-2xx.
  assert.deepEqual(response, { ok: false, status: 500, text: 'Internal Server Error' });

  // And httpText() turns this into a thrown HTTP error for the caller.
  const httpText = makeHttpText(listener, VALID_SENDER);
  await assert.rejects(
    () => httpText('https://www.youtube.com/youtubei/v1/browse?key=K'),
    /HTTP 500 for https:\/\/www\.youtube\.com/,
  );
});

test('async-response contract: true only on the fetch path; validation rejections respond synchronously', async () => {
  const listener = loadWorker({ fetchImpl: async () => makeResponse() });

  // Fetch path: returns true (async sendResponse).
  {
    const { returned, responded } = await dispatch(
      listener,
      { type: 'hys-fetch', url: 'https://www.youtube.com/feed/channels' },
      VALID_SENDER,
    );
    assert.equal(returned, true);
    assert.equal(responded, true);
  }

  // REAL contract (see Notes): 'Sender not allowed' responds synchronously
  // via sendResponse and then returns undefined — NOT true.
  {
    let syncResponse;
    const returned = listener(
      { type: 'hys-fetch', url: 'https://www.youtube.com/feed/channels' },
      { id: EXTENSION_ID, url: 'https://evil.example/' },
      (r) => {
        syncResponse = { ...r };
      },
    );
    assert.equal(returned, undefined, 'Sender-not-allowed path returns undefined (sync response)');
    assert.deepEqual(syncResponse, { ok: false, status: 0, error: 'Sender not allowed' });
  }

  // Same sync contract for the msg.url guard.
  {
    let syncResponse;
    const returned = listener(
      { type: 'hys-fetch', url: 'https://attacker.example/x' },
      VALID_SENDER,
      (r) => {
        syncResponse = { ...r };
      },
    );
    assert.equal(returned, undefined, 'URL-not-allowed path returns undefined (sync response)');
    assert.deepEqual(syncResponse, { ok: false, status: 0, error: 'URL not allowed' });
  }

  // Non-hys-fetch messages are ignored entirely.
  {
    let called = false;
    const returned = listener({ type: 'other' }, VALID_SENDER, () => {
      called = true;
    });
    assert.equal(returned, undefined);
    assert.equal(called, false, 'unrelated message types must not receive a response');
  }
});

test('sequential messages through one worker instance get independent responses', async () => {
  let call = 0;
  const fetchCalls = [];
  const listener = loadWorker({
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init });
      call += 1;
      return call === 1
        ? makeResponse({ body: 'first-body' })
        : makeResponse({ ok: false, status: 404, body: 'second-not-found' });
    },
  });

  const first = await dispatch(
    listener,
    { type: 'hys-fetch', url: 'https://www.youtube.com/feed/channels', init: { credentials: 'include' } },
    VALID_SENDER,
  );
  const second = await dispatch(
    listener,
    { type: 'hys-fetch', url: 'https://www.youtube.com/youtubei/v1/browse?key=K' },
    VALID_SENDER,
  );

  assert.deepEqual(first.response, { ok: true, status: 200, text: 'first-body' });
  assert.deepEqual(second.response, { ok: false, status: 404, text: 'second-not-found' });

  // No shared-state bleed: each call saw its own URL and a fresh sanitized init.
  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0].url, 'https://www.youtube.com/feed/channels');
  assert.equal(fetchCalls[1].url, 'https://www.youtube.com/youtubei/v1/browse?key=K');
  assert.equal(fetchCalls[0].init.credentials, 'include');
  assert.equal(fetchCalls[1].init.credentials, 'omit', 'second request must not inherit credentials from the first');
  assert.notEqual(fetchCalls[0].init, fetchCalls[1].init, 'each request must get a fresh init object');
});
