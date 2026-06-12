'use strict';

/*
 * Regression tests for GitHub Issue #1 (hardened MV3 background fetch proxy).
 *
 * These tests prove that LEGITIMATE traffic still works after the hardening
 * of src/background/worker.js: the three real call shapes used by
 * src/content/subs.js (cookie-authenticated GET, JSON InnerTube POST,
 * credential-less oEmbed GET), response relay fidelity for non-2xx results,
 * the unchanged msg.url guard, and message-type dispatch semantics.
 *
 * NOTE: The vm-based loadWorker/dispatch harness below is intentionally a
 * self-contained copy of the pattern in test/worker.test.mjs. The duplication
 * is accepted so parallel test-writer agents can work on separate files
 * without cross-file edits.
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
 * Invokes the listener and resolves with whatever is passed to
 * sendResponse. The worker signals an async response by returning true and
 * resolves sendResponse on the microtask queue, so awaiting this promise
 * suffices. If the listener returns without claiming the response channel
 * (sync return, no `true`), resolve with undefined after a microtask flush.
 * The listener's raw return value is exposed via `returnValue` for tests
 * that assert the message-channel contract.
 */
function dispatch(listener, msg, sender) {
  let returnValue;
  const response = new Promise((resolve) => {
    returnValue = listener(msg, sender, resolve);
    if (returnValue !== true) {
      // No async response pending; flush microtasks then settle.
      queueMicrotask(() => resolve(undefined));
    }
  });
  return { response, returnValue };
}

// Cross-realm note: objects created inside the VM context have a foreign
// Object.prototype, so strict deepEqual would fail on prototype identity.
// Tests therefore spread VM-created objects ({ ...res }) into this realm
// before deep comparison.

// Minimal fetch-response shape the worker consumes: ok, status, text().
function makeResponse({ ok = true, status = 200, text = 'body' } = {}) {
  return { ok, status, text: async () => text };
}

const validSender = { id: EXTENSION_ID, url: 'https://www.youtube.com/' };

test('relays cookie-authenticated GET (subs.js /feed/channels shape) with sanitized init', async () => {
  const fetchCalls = [];
  const listener = loadWorker({
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init });
      return makeResponse({ ok: true, status: 200, text: 'channels-html' });
    },
  });

  const { response, returnValue } = dispatch(
    listener,
    {
      type: 'hys-fetch',
      url: 'https://www.youtube.com/feed/channels',
      init: { credentials: 'include' },
    },
    validSender,
  );
  const res = await response;

  assert.equal(returnValue, true, 'listener must return true to keep the channel open');
  assert.equal(fetchCalls.length, 1, 'fetch must be called exactly once');
  assert.equal(fetchCalls[0].url, 'https://www.youtube.com/feed/channels');
  const init = fetchCalls[0].init;
  assert.equal(init.method, 'GET', 'GET must be preserved as the default method');
  assert.equal(init.credentials, 'include', 'credentials: include must pass through');
  assert.ok(!('body' in init), 'GET request must carry no body');
  assert.ok(!('headers' in init), 'GET request without JSON content-type must carry no headers');
  assert.deepEqual({ ...res }, { ok: true, status: 200, text: 'channels-html' });
});

test('relays JSON POST (subs.js InnerTube shape) with body forwarded intact', async () => {
  const fetchCalls = [];
  const listener = loadWorker({
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init });
      return makeResponse({ ok: true, status: 200, text: '{"items":[]}' });
    },
  });

  const body = JSON.stringify({
    context: { client: { clientName: 'WEB', clientVersion: '2.20240101' } },
    browseId: 'FEchannels',
  });

  const { response } = dispatch(
    listener,
    {
      type: 'hys-fetch',
      url: 'https://www.youtube.com/youtubei/v1/browse?prettyPrint=false',
      init: {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body,
      },
    },
    validSender,
  );
  const res = await response;

  assert.equal(fetchCalls.length, 1, 'fetch must be called exactly once');
  const init = fetchCalls[0].init;
  assert.equal(init.method, 'POST');
  assert.equal(init.credentials, 'include');
  assert.deepEqual(
    { ...init.headers },
    { 'content-type': 'application/json' },
    'sanitized headers must be exactly the JSON content-type header',
  );
  assert.equal(init.body, body, 'JSON POST body must be forwarded intact (exact string)');
  assert.deepEqual({ ...res }, { ok: true, status: 200, text: '{"items":[]}' });
});

test('relays credential-less GET (subs.js oEmbed shape) with credentials omit', async () => {
  const fetchCalls = [];
  const listener = loadWorker({
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init });
      return makeResponse({ ok: true, status: 200, text: '{"title":"video"}' });
    },
  });

  const { response } = dispatch(
    listener,
    {
      type: 'hys-fetch',
      url: 'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dabc',
      init: { credentials: 'omit' },
    },
    validSender,
  );
  const res = await response;

  assert.equal(fetchCalls.length, 1, 'fetch must be called exactly once');
  const init = fetchCalls[0].init;
  assert.equal(init.method, 'GET');
  assert.equal(init.credentials, 'omit');
  assert.ok(!('body' in init), 'GET request must carry no body');
  assert.deepEqual({ ...res }, { ok: true, status: 200, text: '{"title":"video"}' });
});

test('relays non-2xx fetch results faithfully (ok:false, status 403, text)', async () => {
  const listener = loadWorker({
    fetchImpl: async () => makeResponse({ ok: false, status: 403, text: 'Forbidden' }),
  });

  const { response } = dispatch(
    listener,
    {
      type: 'hys-fetch',
      url: 'https://www.youtube.com/feed/channels',
      init: { credentials: 'include' },
    },
    validSender,
  );
  const res = await response;

  assert.deepEqual(
    { ...res },
    { ok: false, status: 403, text: 'Forbidden' },
    'non-2xx responses must be relayed with ok/status/text, not converted to an error',
  );
});

test('rejects msg.url outside the YouTube allowlist without calling fetch', async () => {
  const fetchCalls = [];
  const listener = loadWorker({
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init });
      return makeResponse();
    },
  });

  const { response } = dispatch(
    listener,
    { type: 'hys-fetch', url: 'https://evil.example/', init: { credentials: 'include' } },
    validSender,
  );
  const res = await response;

  assert.equal(fetchCalls.length, 0, 'fetch must not be called for a disallowed URL');
  assert.deepEqual({ ...res }, { ok: false, status: 0, error: 'URL not allowed' });
});

test('ignores unrelated message types and returns true only for handled messages', async () => {
  const fetchCalls = [];
  const listener = loadWorker({
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init });
      return makeResponse();
    },
  });

  // Unrelated message type: no response, no fetch, channel not claimed.
  const other = dispatch(
    listener,
    { type: 'some-other-message', url: 'https://www.youtube.com/feed/channels' },
    validSender,
  );
  const otherRes = await other.response;
  assert.equal(otherRes, undefined, 'listener must not respond to unrelated message types');
  assert.notEqual(other.returnValue, true, 'listener must not claim the channel for unrelated messages');
  assert.equal(fetchCalls.length, 0, 'fetch must not be called for unrelated message types');

  // Handled message: listener must return true to keep the async channel open.
  const handled = dispatch(
    listener,
    { type: 'hys-fetch', url: 'https://www.youtube.com/feed/channels' },
    validSender,
  );
  assert.equal(handled.returnValue, true, 'listener must return true for handled hys-fetch messages');
  const handledRes = await handled.response;
  assert.deepEqual({ ...handledRes }, { ok: true, status: 200, text: 'body' });
  assert.equal(fetchCalls.length, 1, 'fetch must be called once for the handled message');
});
