'use strict';

/*
 * Regression tests for GitHub Issue #2 (hardening wave).
 *
 * The fix appended `.catch((e) => sendResponse({ error: String(e) }))` to
 * the 'hys-status' handler chain in src/content/main.js (mirroring the
 * adjacent 'hys-refresh-subs' handler). The reproduction test
 * (test/content-status-error.test.mjs) already covers a status() rejection
 * with an Error instance; these tests protect the surrounding behavior:
 *
 *   1. Success path unchanged: status() resolves -> the response carries
 *      loggedIn, mode, and the spread status fields, and gains NO `error`
 *      property from the new catch handler.
 *   2. Error coercion: status() rejecting with NON-Error values (a string,
 *      a plain object) still yields a response whose `error` is a string
 *      (String(e) must not be regressed to e.message or similar).
 *   3. The listener keeps returning `true` for 'hys-status' in both the
 *      success and error cases, so the async response channel stays open.
 *   4. The sibling 'hys-refresh-subs' error path still responds with
 *      `{ error: <string> }` (guards against an accidental regression of
 *      the handler the fix was modeled on).
 *
 * NOTE: Deliberately self-contained (duplicates harness helpers from
 * test/content-status-error.test.mjs / test/content-regression.test.mjs) —
 * the project accepts duplication between test files, see the NOTE in
 * test/integration.test.mjs.
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
 * @param {() => Promise<any>} [opts.status] override for hysSubs.status
 *   (still counted in `calls.status`).
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
      status: async (...args) => {
        calls.status += 1;
        if (opts.status) return opts.status(...args);
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

/** Sentinel resolved by dispatchCapture when sendResponse is never called. */
const NO_RESPONSE = Symbol('no response');

/**
 * Invokes the listener and exposes BOTH its synchronous return value
 * (`returned` — must be `true` for handlers that respond asynchronously,
 * otherwise the browser closes the response channel) and a bounded promise
 * for whatever is passed to sendResponse (`response`). If sendResponse is
 * never called within `timeoutMs` of settled event-loop turns, `response`
 * resolves with the NO_RESPONSE sentinel instead of hanging — the very
 * popup hang Issue #2 fixed.
 */
function dispatchCapture(listener, msg, sender, timeoutMs = 100) {
  let returned;
  const response = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(NO_RESPONSE), timeoutMs);
    const sendResponse = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    returned = listener(msg, sender, sendResponse);
    if (returned !== true) {
      queueMicrotask(() => {
        clearTimeout(timer);
        resolve(undefined);
      });
    }
  });
  return { returned, response };
}

test('hys-status success path: response spreads status fields with loggedIn/mode and no error property', async () => {
  const { listener, calls } = await loadMain({
    status: async () => ({ count: 7, lastSync: 12345 }),
  });

  const { returned, response: pending } = dispatchCapture(
    listener,
    { type: 'hys-status' },
    { id: EXTENSION_ID },
  );
  const response = await pending;

  assert.equal(returned, true, 'listener must return true to keep the async channel open');
  assert.equal(calls.status, 1, 'hysSubs.status must run exactly once');
  assert.notEqual(response, NO_RESPONSE, 'sendResponse must be called on the success path');
  assert.equal(response.loggedIn, false, 'response must carry loggedIn (no cookie -> false)');
  assert.ok('mode' in response, 'response must carry the effective mode');
  assert.equal(response.count, 7, 'resolved status fields must be spread into the response');
  assert.equal(response.lastSync, 12345, 'all resolved status fields must be spread into the response');
  assert.equal(
    'error' in response,
    false,
    'the added catch handler must not inject an error property on success',
  );
});

test('hys-status coerces a non-Error string rejection into a string error response', async () => {
  const unhandled = [];
  const onUnhandledRejection = (reason) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandledRejection);

  try {
    const { listener, calls } = await loadMain({
      status: async () => {
        // eslint-disable-next-line no-throw-literal
        throw 'plain string failure';
      },
    });

    const { returned, response: pending } = dispatchCapture(
      listener,
      { type: 'hys-status' },
      { id: EXTENSION_ID },
    );
    const response = await pending;

    // Let any pending rejection surface before asserting on it.
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(returned, true, 'listener must return true even when status() will reject');
    assert.equal(calls.status, 1, 'hysSubs.status must run exactly once');
    assert.notEqual(response, NO_RESPONSE, 'sendResponse must be called for a string rejection');
    assert.equal(typeof response.error, 'string', 'error must be coerced to a string');
    assert.match(response.error, /plain string failure/, 'error string must describe the rejection');
    assert.equal(
      unhandled.length,
      0,
      `string rejection must be handled, not leak as unhandled (got: ${unhandled.map(String).join(', ')})`,
    );
  } finally {
    process.removeListener('unhandledRejection', onUnhandledRejection);
  }
});

test('hys-status coerces a non-Error object rejection into a string error response', async () => {
  const unhandled = [];
  const onUnhandledRejection = (reason) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandledRejection);

  try {
    const { listener, calls } = await loadMain({
      status: async () => {
        // eslint-disable-next-line no-throw-literal
        throw { code: 503, detail: 'service unavailable' };
      },
    });

    const { returned, response: pending } = dispatchCapture(
      listener,
      { type: 'hys-status' },
      { id: EXTENSION_ID },
    );
    const response = await pending;

    // Let any pending rejection surface before asserting on it.
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(returned, true, 'listener must return true even when status() will reject');
    assert.equal(calls.status, 1, 'hysSubs.status must run exactly once');
    assert.notEqual(response, NO_RESPONSE, 'sendResponse must be called for an object rejection');
    assert.equal(
      typeof response.error,
      'string',
      'object rejection must still be coerced to a string error',
    );
    assert.equal(
      unhandled.length,
      0,
      `object rejection must be handled, not leak as unhandled (got: ${unhandled.map(String).join(', ')})`,
    );
  } finally {
    process.removeListener('unhandledRejection', onUnhandledRejection);
  }
});

test('hys-refresh-subs error path still responds with { error: <string> } and returns true', async () => {
  const { listener, calls } = await loadMain({
    refresh: async () => {
      throw new Error('refresh boom');
    },
  });

  const { returned, response: pending } = dispatchCapture(
    listener,
    { type: 'hys-refresh-subs' },
    { id: EXTENSION_ID },
  );
  const response = await pending;

  assert.equal(returned, true, 'listener must return true to keep the async channel open');
  assert.equal(calls.refresh, 1, 'hysSubs.refresh must run exactly once');
  assert.notEqual(response, NO_RESPONSE, 'sendResponse must be called when refresh rejects');
  assert.equal(typeof response.error, 'string', 'error response must carry a string error');
  assert.match(response.error, /refresh boom/, 'error string must describe the rejection reason');
});
