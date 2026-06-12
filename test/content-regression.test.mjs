'use strict';

/*
 * Regression tests for GitHub Issue #5 (hardening wave).
 *
 * The fix added a sender guard as the FIRST statement of the content
 * script's runtime.onMessage listener (src/content/main.js:141):
 *
 *   if (sender?.id !== api.runtime.id) return;
 *
 * These tests verify the guard sits ABOVE the message-type branches and
 * does not break them, i.e. a VALID sender still gets:
 *   1. the refresh result for 'hys-refresh-subs' (success path),
 *   2. `{ error: <string> }` when hysSubs.refresh rejects (review
 *      finding F-2 — this error path was previously never exercised
 *      with a valid sender),
 *   3. a loggedIn/mode status response for 'hys-status'.
 *
 * NOTE: Deliberately self-contained (duplicates harness helpers from
 * test/content-main.test.mjs) — the project accepts duplication between
 * test files, see the NOTE in test/integration.test.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAIN_PATH = path.join(__dirname, '..', 'src', 'content', 'main.js');
const EXTENSION_ID = 'test-ext-id';

/**
 * Loads main.js in a fresh VM context.
 *
 * main.js is a plain (non-module) content script that resolves the
 * extension API via `globalThis.browser ?? globalThis.chrome`, touches the
 * DOM (document/location/MutationObserver/requestAnimationFrame), and uses
 * the helper globals `hysGetSettings`/`hysSubs` provided by sibling content
 * scripts. The sandbox mocks all of these; `browser` is intentionally left
 * undefined.
 *
 * main.js runs its async init() immediately; the onMessage listener is only
 * registered after awaited settings/applyState steps, so the caller must
 * await loadMain() which waits for the event loop to settle.
 *
 * @param {object} [opts]
 * @param {() => Promise<any>} [opts.refresh] override for hysSubs.refresh
 *   (still counted in `calls.refresh`).
 * @returns {Promise<{ listener: Function, calls: { status: number, refresh: number } }>}
 */
async function loadMain(opts = {}) {
  const code = fs.readFileSync(MAIN_PATH, 'utf8');
  let listener = null;
  const calls = { status: 0, refresh: 0 };

  const docEl = {
    setAttribute() {},
    removeAttribute() {},
    toggleAttribute() {},
    hasAttribute() {
      return false;
    },
  };

  const sandbox = {
    chrome: {
      runtime: {
        id: EXTENSION_ID,
        onMessage: {
          addListener(fn) {
            listener = fn;
          },
        },
      },
      storage: {
        onChanged: {
          addListener() {},
        },
      },
    },
    document: {
      documentElement: docEl,
      cookie: '',
      body: {},
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
    location: { pathname: '/', replace: () => {} },
    MutationObserver: class {
      observe() {}
    },
    requestAnimationFrame: (fn) => fn(),
    hysGetSettings: async () => ({
      mode: 'off',
      redirectShortsPlayer: false,
      hideSidebarEntry: false,
      hideChannelTab: false,
    }),
    hysSubs: {
      status: async () => {
        calls.status += 1;
        return { count: 0 };
      },
      refresh: async (...args) => {
        calls.refresh += 1;
        if (opts.refresh) return opts.refresh(...args);
        return { count: 3 };
      },
      isVideoAllowed: async () => false,
      isChannelAllowed: async () => false,
    },
  };

  vm.runInNewContext(code, sandbox, { filename: MAIN_PATH });

  // init() awaits hysGetSettings/applyState before registering the
  // listener; let pending promises settle first.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(typeof listener, 'function', 'main.js must register an onMessage listener');
  return { listener, calls };
}

/**
 * Invokes the listener and resolves with whatever is passed to
 * sendResponse. The script signals an async response by returning true; if
 * the listener returns without claiming the response channel, flush
 * microtasks and resolve with undefined.
 */
function dispatch(listener, msg, sender) {
  return new Promise((resolve) => {
    const ret = listener(msg, sender, resolve);
    if (ret !== true) {
      queueMicrotask(() => resolve(undefined));
    }
  });
}

test('hys-refresh-subs from a valid sender still returns the refresh result', async () => {
  const { listener, calls } = await loadMain();

  const response = await dispatch(
    listener,
    { type: 'hys-refresh-subs' },
    { id: EXTENSION_ID },
  );

  assert.deepEqual(
    response,
    { count: 3 },
    'valid sender must receive the resolved refresh result',
  );
  assert.equal(calls.refresh, 1, 'hysSubs.refresh must run exactly once for a valid sender');
});

test('hys-refresh-subs error path responds with { error: <string> } for a valid sender', async () => {
  const { listener, calls } = await loadMain({
    refresh: async () => {
      throw new Error('boom');
    },
  });

  const response = await dispatch(
    listener,
    { type: 'hys-refresh-subs' },
    { id: EXTENSION_ID },
  );

  assert.ok(response, 'valid sender must still receive a response when refresh rejects');
  assert.equal(typeof response.error, 'string', 'error response must carry a string error');
  assert.match(response.error, /boom/, 'error string must describe the rejection reason');
  assert.equal(calls.refresh, 1, 'hysSubs.refresh must have been invoked (guard must not block it)');
});

test('hys-status from a valid sender still returns loggedIn/mode after the guard', async () => {
  const { listener, calls } = await loadMain();

  const response = await dispatch(listener, { type: 'hys-status' }, { id: EXTENSION_ID });

  assert.ok(response, 'valid sender must receive a status response');
  assert.ok('loggedIn' in response, 'status response must include loggedIn');
  assert.ok('mode' in response, 'status response must include mode');
  assert.equal(calls.status, 1, 'hysSubs.status must run exactly once for a valid sender');
});
