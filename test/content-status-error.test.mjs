'use strict';

/*
 * Reproduction test for GitHub Issue #2.
 *
 * The content script's 'hys-status' message handler
 * (src/content/main.js) chains
 *
 *   hysSubs.status().then((s) => sendResponse({ ... }))
 *
 * WITHOUT a .catch(). If hysSubs.status() rejects (e.g. an
 * api.storage.local.get failure in src/content/subs.js), sendResponse is
 * never called and the popup (src/popup/popup.js renderStatus) waits
 * forever for a status reply. The rejection also escapes as an unhandled
 * promise rejection. The adjacent 'hys-refresh-subs' handler
 * (src/content/main.js:151-160) shows the correct pattern:
 * `.catch((e) => sendResponse({ error: String(e) }))`.
 *
 * This test loads main.js in a VM sandbox with mocked DOM/extension
 * globals, makes hysSubs.status() reject, dispatches { type: 'hys-status' }
 * from a valid sender, and asserts that sendResponse is invoked with an
 * `error` property and that no unhandled rejection escapes. It MUST FAIL
 * against the current (unfixed) code.
 *
 * NOTE: Deliberately self-contained (duplicates harness helpers from
 * test/content-main.test.mjs / test/content-regression.test.mjs) — the
 * project accepts duplication between test files, see the NOTE in
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
      refresh: async () => {
        calls.refresh += 1;
        return { count: 0 };
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

/** Sentinel returned by dispatchOrTimeout when sendResponse is never called. */
const NO_RESPONSE = Symbol('no response');

/**
 * Invokes the listener and resolves with whatever is passed to
 * sendResponse. The script signals an async response by returning true; if
 * the listener returns without claiming the response channel, flush
 * microtasks and resolve with undefined.
 *
 * Unlike the plain dispatch() helper in the sibling tests, this variant is
 * bounded: on the unfixed code the 'hys-status' handler never calls
 * sendResponse when status() rejects, so awaiting it would hang forever —
 * exactly the popup's bug. After `timeoutMs` of settled event-loop turns it
 * resolves with the NO_RESPONSE sentinel instead.
 */
function dispatchOrTimeout(listener, msg, sender, timeoutMs = 100) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(NO_RESPONSE), timeoutMs);
    const sendResponse = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    const ret = listener(msg, sender, sendResponse);
    if (ret !== true) {
      queueMicrotask(() => {
        clearTimeout(timer);
        resolve(undefined);
      });
    }
  });
}

test('hys-status responds with { error: <string> } when hysSubs.status rejects', async () => {
  // Capture unhandled rejections instead of letting them crash the test
  // runner — the unfixed handler leaks the status() rejection.
  const unhandled = [];
  const onUnhandledRejection = (reason) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandledRejection);

  try {
    const { listener, calls } = await loadMain({
      status: async () => {
        throw new Error('storage boom');
      },
    });

    const response = await dispatchOrTimeout(
      listener,
      { type: 'hys-status' },
      { id: EXTENSION_ID },
    );

    // Let any pending rejection surface before asserting on it.
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(calls.status, 1, 'hysSubs.status must have been invoked exactly once');
    assert.notEqual(
      response,
      NO_RESPONSE,
      'sendResponse must be called even when status() rejects — the popup must not wait forever',
    );
    assert.ok(response, 'valid sender must still receive a response when status() rejects');
    assert.equal(typeof response.error, 'string', 'error response must carry a string error');
    assert.match(response.error, /storage boom/, 'error string must describe the rejection reason');
    assert.equal(
      unhandled.length,
      0,
      `status() rejection must be handled by the listener, not escape as an unhandled rejection (got: ${unhandled.map(String).join(', ')})`,
    );
  } finally {
    process.removeListener('unhandledRejection', onUnhandledRejection);
  }
});
