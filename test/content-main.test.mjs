'use strict';

/*
 * Reproduction test for GitHub Issue #5.
 *
 * The content script (src/content/main.js) registers a runtime.onMessage
 * listener that handles 'hys-status' and 'hys-refresh-subs'. It validates
 * only `msg.type` and never checks `sender.id`, so messages from any
 * sender (e.g. another extension) are processed. Defense-in-depth: the
 * listener should early-return unless `sender?.id === api.runtime.id`,
 * matching the pattern already used in src/background/worker.js.
 *
 * This test loads main.js in a VM sandbox with mocked DOM/extension
 * globals and asserts that a foreign sender gets NO response and does not
 * trigger hysSubs.status/refresh. It MUST FAIL against the current
 * (unfixed) code.
 *
 * NOTE: Deliberately self-contained (duplicates harness helpers from
 * test/worker.test.mjs) — the project accepts duplication between test
 * files, see the NOTE in test/integration.test.mjs.
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

test('content onMessage listener ignores messages from foreign senders', async () => {
  const { listener, calls } = await loadMain();

  // --- Reproduction: a foreign extension id must get no response ---
  const foreignSender = { id: 'some-other-extension' };

  const statusResponse = await dispatch(listener, { type: 'hys-status' }, foreignSender);
  assert.equal(
    statusResponse,
    undefined,
    'hys-status from a foreign sender must not receive a response',
  );
  assert.equal(
    calls.status,
    0,
    'hysSubs.status must not be invoked for a foreign sender',
  );

  const refreshResponse = await dispatch(listener, { type: 'hys-refresh-subs' }, foreignSender);
  assert.equal(
    refreshResponse,
    undefined,
    'hys-refresh-subs from a foreign sender must not receive a response',
  );
  assert.equal(
    calls.refresh,
    0,
    'hysSubs.refresh must not be invoked for a foreign sender',
  );

  // --- Positive control: our own extension id still gets a status ---
  const ownResponse = await dispatch(listener, { type: 'hys-status' }, { id: EXTENSION_ID });
  assert.ok(ownResponse, 'hys-status from our own extension must receive a response');
  assert.ok('loggedIn' in ownResponse, 'status response must include loggedIn');
  assert.ok('mode' in ownResponse, 'status response must include mode');
  assert.equal(calls.status, 1, 'hysSubs.status must run exactly once for the valid sender');
});
