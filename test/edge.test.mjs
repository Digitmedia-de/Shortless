'use strict';

/*
 * Edge-case hardening tests for GitHub Issue #1 (Wave 6).
 *
 * Targets the sanitizeInit() allowlist boundaries in
 * src/background/worker.js: body forwarding guards, header allowlist,
 * method/credentials coercion, non-object init values, and the exact
 * shape of the init object forwarded to the privileged fetch (deferred
 * finding F-7).
 *
 * NOTE: The loadWorker/dispatch harness below is intentionally a copy of
 * the one in test/worker.test.mjs. Duplication is accepted so parallel
 * test-writers can work on separate files without write conflicts; this
 * file is fully self-contained.
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

const VALID_SENDER = { id: EXTENSION_ID, url: 'https://www.youtube.com/' };
const VALID_URL = 'https://www.youtube.com/feed/channels';

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
 * (sync return, no `true`), resolve with undefined.
 */
function dispatch(listener, msg, sender) {
  return new Promise((resolve) => {
    const ret = listener(msg, sender, resolve);
    if (ret !== true) {
      // No async response pending; flush microtasks then settle.
      queueMicrotask(() => resolve(undefined));
    }
  });
}

// Minimal fetch-response shape the worker consumes: ok, status, text().
function makeOkResponse() {
  return { ok: true, status: 200, text: async () => 'body' };
}

/**
 * Asserts the forwarded headers object contains exactly the single
 * sanitized json content-type entry. Compares keys/values explicitly
 * instead of assert.deepEqual because the headers object is created
 * inside the VM realm (foreign Object.prototype breaks deepStrictEqual).
 */
function assertJsonHeaderOnly(headers, message) {
  assert.ok(headers && typeof headers === 'object', message);
  assert.deepEqual(Object.keys(headers), ['content-type'], message);
  assert.equal(headers['content-type'], 'application/json', message);
}

/**
 * Loads a fresh worker with a recording fetch stub, dispatches one
 * hys-fetch message with the given init, and returns the init object the
 * worker forwarded to fetch (plus the sendResponse payload).
 */
async function forwardInit(init, { msgUrl = VALID_URL, sender = VALID_SENDER } = {}) {
  const fetchCalls = [];
  const listener = loadWorker({
    fetchImpl: async (url, fetchInit) => {
      fetchCalls.push({ url, init: fetchInit });
      return makeOkResponse();
    },
  });
  const msg = { type: 'hys-fetch', url: msgUrl };
  if (init !== undefined) msg.init = init;
  const response = await dispatch(listener, msg, sender);
  assert.equal(fetchCalls.length, 1, 'fetch should be called exactly once for a valid request');
  return { init: fetchCalls[0].init, response };
}

test('POST + string body without headers: body is not forwarded', async () => {
  const { init } = await forwardInit({ method: 'POST', body: '{"a":1}' });
  assert.equal(init.method, 'POST');
  assert.ok(!('body' in init), 'body must not be forwarded without a sanitized json header');
  assert.ok(!('headers' in init), 'no headers were supplied, none must appear');
});

test('POST + string body + non-json content-type: neither body nor headers forwarded', async () => {
  const { init } = await forwardInit({
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'hello',
  });
  assert.equal(init.method, 'POST');
  assert.ok(!('headers' in init), 'text/plain header must be dropped');
  assert.ok(!('body' in init), 'body must not be forwarded without the json content-type');
});

test('GET + string body: body is not forwarded', async () => {
  const { init } = await forwardInit({
    method: 'GET',
    headers: { 'content-type': 'application/json' },
    body: '{"a":1}',
  });
  assert.equal(init.method, 'GET');
  assert.ok(!('body' in init), 'body must never be forwarded for GET requests');
});

test('POST + non-string body (object) with json header: body is not forwarded', async () => {
  const { init } = await forwardInit({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { a: 1 },
  });
  assert.equal(init.method, 'POST');
  assertJsonHeaderOnly(init.headers, 'sanitized json header should still be present');
  assert.ok(!('body' in init), 'non-string object body must not be forwarded');
});

test('POST + non-string body (number) with json header: body is not forwarded', async () => {
  const { init } = await forwardInit({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 42,
  });
  assert.ok(!('body' in init), 'non-string number body must not be forwarded');
});

test('non-object init values fall back to safe defaults', async () => {
  for (const badInit of [undefined, null, 'GET', 7]) {
    const { init } = await forwardInit(badInit);
    assert.equal(init.method, 'GET', `init=${String(badInit)}: method must default to GET`);
    assert.equal(init.credentials, 'omit', `init=${String(badInit)}: credentials must default to omit`);
    assert.ok(!('headers' in init), `init=${String(badInit)}: no headers expected`);
    assert.ok(!('body' in init), `init=${String(badInit)}: no body expected`);
  }
});

test('non-allowlisted credentials values are coerced to omit', async () => {
  for (const creds of ['same-origin', 'INCLUDE', 'Include', '', 0, true, {}, ['include']]) {
    const { init } = await forwardInit({ credentials: creds });
    assert.equal(
      init.credentials,
      'omit',
      `credentials=${JSON.stringify(creds)} must be coerced to omit`,
    );
  }
});

test("credentials 'include' (exact) is honored", async () => {
  const { init } = await forwardInit({ credentials: 'include' });
  assert.equal(init.credentials, 'include');
});

test('extra headers alongside content-type: only content-type forwarded', async () => {
  const { init } = await forwardInit({
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-extra': '1',
      Authorization: 'Bearer x',
    },
    body: '{"a":1}',
  });
  assertJsonHeaderOnly(init.headers, 'only the json content-type header may be forwarded');
  assert.equal(init.body, '{"a":1}', 'sanitized json POST body should still be forwarded');
});

test('hostile init: forwarded init has the exact safe key shape (F-7)', async () => {
  const { init } = await forwardInit({
    method: 'DELETE',
    headers: { Authorization: 'x' },
    mode: 'no-cors',
    redirect: 'follow',
    referrer: 'r',
    cache: 'no-store',
    body: 'b',
  });
  assert.deepEqual(
    Object.keys(init).sort(),
    ['credentials', 'method'].sort(),
    'no keys beyond the safe defaults may leak through for a hostile init',
  );
  assert.equal(init.method, 'GET', 'DELETE must be coerced to GET');
  assert.equal(init.credentials, 'omit');
});

test("method case variations: 'post' and 'PoSt' are honored as POST", async () => {
  for (const method of ['post', 'PoSt']) {
    const { init } = await forwardInit({ method });
    assert.equal(init.method, 'POST', `method=${method} must be normalized to POST`);
  }
});

test('header key casing is honored, but value variants are not', async () => {
  // Any key casing with the exact value is honored.
  for (const key of ['Content-Type', 'CONTENT-TYPE', 'content-type']) {
    const { init } = await forwardInit({
      method: 'POST',
      headers: { [key]: 'application/json' },
      body: '{"a":1}',
    });
    assertJsonHeaderOnly(init.headers, `header key '${key}' must be honored and normalized`);
    assert.equal(init.body, '{"a":1}', `body must be forwarded when '${key}' header is honored`);
  }
  // A non-exact value (charset suffix) is not honored.
  const { init } = await forwardInit({
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: '{"a":1}',
  });
  assert.ok(!('headers' in init), 'charset-suffixed content-type must not be honored');
  assert.ok(!('body' in init), 'body must not be forwarded without an honored json header');
});
