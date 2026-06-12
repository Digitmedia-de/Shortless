'use strict';

/*
 * Integration tests for GitHub Issue #5 (hardening wave).
 *
 * Simulates the popup -> content-script message flow end-to-end through the
 * runtime.onMessage listener registered by src/content/main.js:
 *
 *   popup.js line 39: api.tabs.sendMessage(tab.id, { type: 'hys-status' })
 *     consumes: tabStatus.mode, tabStatus.loggedIn, tabStatus.subsCount,
 *               tabStatus.subsTs (popup.js lines 46-51)
 *   popup.js line 89: api.tabs.sendMessage(tab.id, { type: 'hys-refresh-subs' })
 *     consumes: result?.error (popup.js line 90); success shape is the
 *               hysSubs.refresh() result { subsCount, subsTs } (subs.js 253-256)
 *
 * The fix under test: `if (sender?.id !== api.runtime.id) return;` as the
 * first statement of the listener (src/content/main.js:141). These tests
 * verify the legitimate popup flow still works through the guard, that the
 * guard is stateless (no poisoning across messages), and that the listener's
 * return value (Chrome's keep-sendResponse-channel-open signal) is `true`
 * only for valid senders.
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
 * Loads main.js in a fresh VM context (plain content script, resolved via
 * `globalThis.browser ?? globalThis.chrome`; `browser` left undefined).
 * Mocks DOM globals and the hysGetSettings/hysSubs helpers provided by
 * sibling content scripts. The mocked hysSubs returns the same shape as the
 * real src/content/subs.js ({ subsCount, subsTs }).
 *
 * Options:
 *   cookie   - document.cookie value (drives detectLogin / loggedIn)
 *   settings - settings object returned by hysGetSettings
 *
 * Returns { listener, calls } where `calls` records hysSubs.status/refresh
 * invocations (refresh also captures the settings argument it received).
 */
async function loadMain({ cookie = '', settings } = {}) {
  const code = fs.readFileSync(MAIN_PATH, 'utf8');
  let listener = null;
  const calls = { status: 0, refresh: 0, refreshSettings: null };

  const effectiveSettings = settings ?? {
    mode: 'subs',
    redirectShortsPlayer: false,
    hideSidebarEntry: false,
    hideChannelTab: false,
    extraChannels: ''
  };

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
      cookie,
      body: {},
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
    location: { pathname: '/', replace: () => {} },
    MutationObserver: class {
      observe() {}
    },
    requestAnimationFrame: (fn) => fn(),
    hysGetSettings: async () => effectiveSettings,
    hysSubs: {
      status: async () => {
        calls.status += 1;
        return { subsCount: 3, subsTs: 1749700000000 };
      },
      refresh: async (s) => {
        calls.refresh += 1;
        calls.refreshSettings = s;
        return { subsCount: 5, subsTs: 1749710000000 };
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
 * Invokes the listener the way Chrome does and resolves with whatever is
 * passed to sendResponse. The script signals an async response by returning
 * true; if the listener returns without claiming the response channel,
 * flush microtasks and resolve with undefined (Chrome closes the channel).
 */
function dispatch(listener, msg, sender) {
  return new Promise((resolve) => {
    const ret = listener(msg, sender, resolve);
    if (ret !== true) {
      queueMicrotask(() => resolve(undefined));
    }
  });
}

test('popup hys-status round-trip: valid sender gets every field popup.js consumes', async () => {
  // SAPISID cookie present -> detectLogin() true -> loggedIn true,
  // mode 'subs' stays 'subs' (effectiveMode does not fall back to 'all').
  const { listener, calls } = await loadMain({ cookie: 'SAPISID=abc123' });

  // popup.js line 39 sends exactly this message; sender.id is our own id.
  const response = await dispatch(listener, { type: 'hys-status' }, { id: EXTENSION_ID });

  assert.ok(response, 'valid popup hys-status must receive a response');
  // Fields consumed by popup.js renderStatus() (lines 46-51):
  assert.equal(response.mode, 'subs', 'popup reads tabStatus.mode (line 46)');
  assert.equal(response.loggedIn, true, 'popup reads tabStatus.loggedIn (lines 47-48)');
  assert.equal(response.subsCount, 3, 'popup reads tabStatus.subsCount (line 51)');
  assert.equal(response.subsTs, 1749700000000, 'popup reads tabStatus.subsTs (line 51)');
  assert.equal(calls.status, 1, 'hysSubs.status must run exactly once');
});

test('popup hys-refresh-subs round-trip: valid sender gets the refresh result popup.js expects', async () => {
  const { listener, calls } = await loadMain({ cookie: 'SAPISID=abc123' });

  // popup.js line 89 sends exactly this message.
  const result = await dispatch(listener, { type: 'hys-refresh-subs' }, { id: EXTENSION_ID });

  assert.ok(result, 'valid popup hys-refresh-subs must receive a response');
  // popup.js line 90 treats result.error as failure -> success must not set it.
  assert.equal(result.error, undefined, 'successful refresh must not carry an error field');
  // Success shape mirrors hysSubs.refresh() -> status() ({ subsCount, subsTs }).
  assert.equal(result.subsCount, 5, 'refresh response must include subsCount');
  assert.equal(result.subsTs, 1749710000000, 'refresh response must include subsTs');
  assert.equal(calls.refresh, 1, 'hysSubs.refresh must run exactly once');
  assert.ok(calls.refreshSettings, 'hysSubs.refresh must receive the current settings');
  assert.equal(calls.refreshSettings.mode, 'subs', 'refresh must be passed the loaded settings');
});

test('mixed sequence on one listener: foreign message dropped, later valid message still answered', async () => {
  const { listener, calls } = await loadMain({ cookie: 'SAPISID=abc123' });

  // 1) Foreign extension first — must be dropped without side effects.
  const foreign = await dispatch(listener, { type: 'hys-status' }, { id: 'evil-other-extension' });
  assert.equal(foreign, undefined, 'foreign hys-status must not receive a response');
  assert.equal(calls.status, 0, 'foreign hys-status must not invoke hysSubs.status');

  const foreignRefresh = await dispatch(
    listener,
    { type: 'hys-refresh-subs' },
    { id: 'evil-other-extension' },
  );
  assert.equal(foreignRefresh, undefined, 'foreign hys-refresh-subs must not receive a response');
  assert.equal(calls.refresh, 0, 'foreign hys-refresh-subs must not invoke hysSubs.refresh');

  // 2) Same listener instance: a valid popup message right after must still
  //    work — the guard is stateless and cannot be poisoned.
  const valid = await dispatch(listener, { type: 'hys-status' }, { id: EXTENSION_ID });
  assert.ok(valid, 'valid sender must still be answered after a foreign attempt');
  assert.equal(valid.mode, 'subs');
  assert.equal(valid.subsCount, 3);
  assert.equal(calls.status, 1, 'only the valid message may reach hysSubs.status');

  const validRefresh = await dispatch(listener, { type: 'hys-refresh-subs' }, { id: EXTENSION_ID });
  assert.ok(validRefresh, 'valid refresh must still be answered after a foreign attempt');
  assert.equal(validRefresh.subsCount, 5);
  assert.equal(calls.refresh, 1, 'only the valid message may reach hysSubs.refresh');
});

test('listener return value: true (async channel kept open) for valid senders, falsy for rejected ones', async () => {
  const { listener } = await loadMain({ cookie: 'SAPISID=abc123' });
  const noop = () => {};

  // Chrome keeps the sendResponse channel open only when the listener
  // returns exactly true — assert the raw return values directly.
  assert.equal(
    listener({ type: 'hys-status' }, { id: EXTENSION_ID }, noop),
    true,
    'hys-status from a valid sender must return true to keep the channel open',
  );
  assert.equal(
    listener({ type: 'hys-refresh-subs' }, { id: EXTENSION_ID }, noop),
    true,
    'hys-refresh-subs from a valid sender must return true to keep the channel open',
  );

  assert.ok(
    !listener({ type: 'hys-status' }, { id: 'evil-other-extension' }, noop),
    'foreign sender must get a falsy return (channel closes immediately)',
  );
  assert.ok(
    !listener({ type: 'hys-refresh-subs' }, { id: 'evil-other-extension' }, noop),
    'foreign sender must get a falsy return (channel closes immediately)',
  );
  assert.ok(
    !listener({ type: 'hys-status' }, undefined, noop),
    'missing sender must get a falsy return',
  );

  // Let the two valid handlers' pending promises settle so the test does
  // not leak async work past its end.
  await new Promise((resolve) => setImmediate(resolve));
});
