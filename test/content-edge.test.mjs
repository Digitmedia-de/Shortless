'use strict';

/*
 * Hardening (edge-case) tests for GitHub Issue #5.
 *
 * The content script (src/content/main.js) guards its runtime.onMessage
 * listener with `if (sender?.id !== api.runtime.id) return;`. These tests
 * cover the boundary inputs the reproduction test does not:
 *
 *   - falsy/incomplete sender values (undefined, null, {}, { id: undefined })
 *     must be rejected by the optional-chaining guard WITHOUT throwing;
 *   - malformed messages (null, non-string type) from a VALID sender must
 *     still be ignored by the type check below the guard;
 *   - unknown message types from a valid sender fall through both handler
 *     branches and produce no response.
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
 * Returns { listener, calls } where `calls` counts hysSubs.status/refresh
 * invocations.
 */
async function loadMain() {
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

test('sender guard rejects undefined sender without throwing', async () => {
  const { listener, calls } = await loadMain();

  // A throw inside the listener would reject the dispatch promise, so the
  // plain await also asserts the optional-chaining guard does not throw.
  const response = await dispatch(listener, { type: 'hys-status' }, undefined);

  assert.equal(response, undefined, 'undefined sender must not receive a response');
  assert.equal(calls.status, 0, 'hysSubs.status must not run for undefined sender');
  assert.equal(calls.refresh, 0, 'hysSubs.refresh must not run for undefined sender');
});

test('sender guard rejects null sender without throwing', async () => {
  const { listener, calls } = await loadMain();

  const response = await dispatch(listener, { type: 'hys-status' }, null);

  assert.equal(response, undefined, 'null sender must not receive a response');
  assert.equal(calls.status, 0, 'hysSubs.status must not run for null sender');
  assert.equal(calls.refresh, 0, 'hysSubs.refresh must not run for null sender');
});

test('sender guard rejects empty-object sender (no id property)', async () => {
  const { listener, calls } = await loadMain();

  const response = await dispatch(listener, { type: 'hys-status' }, {});

  assert.equal(response, undefined, 'sender without id must not receive a response');
  assert.equal(calls.status, 0, 'hysSubs.status must not run for sender without id');
  assert.equal(calls.refresh, 0, 'hysSubs.refresh must not run for sender without id');
});

test('sender guard rejects sender with explicitly undefined id', async () => {
  const { listener, calls } = await loadMain();

  const response = await dispatch(listener, { type: 'hys-refresh-subs' }, { id: undefined });

  assert.equal(response, undefined, 'sender with id: undefined must not receive a response');
  assert.equal(calls.refresh, 0, 'hysSubs.refresh must not run for sender with undefined id');
  assert.equal(calls.status, 0, 'hysSubs.status must not run for sender with undefined id');
});

test('malformed messages from a valid sender are ignored without throwing', async () => {
  const { listener, calls } = await loadMain();
  const validSender = { id: EXTENSION_ID };

  // null message — the `!msg` branch of the type check below the guard.
  const nullResponse = await dispatch(listener, null, validSender);
  assert.equal(nullResponse, undefined, 'null message must not receive a response');

  // non-string type — the `typeof msg.type !== 'string'` branch.
  const numericTypeResponse = await dispatch(listener, { type: 42 }, validSender);
  assert.equal(numericTypeResponse, undefined, 'message with numeric type must not receive a response');

  assert.equal(calls.status, 0, 'hysSubs.status must not run for malformed messages');
  assert.equal(calls.refresh, 0, 'hysSubs.refresh must not run for malformed messages');
});

test('unknown message type from a valid sender gets no response', async () => {
  const { listener, calls } = await loadMain();

  const response = await dispatch(listener, { type: 'hys-unknown' }, { id: EXTENSION_ID });

  assert.equal(response, undefined, 'unknown message type must not receive a response');
  assert.equal(calls.status, 0, 'hysSubs.status must not run for unknown message type');
  assert.equal(calls.refresh, 0, 'hysSubs.refresh must not run for unknown message type');
});
