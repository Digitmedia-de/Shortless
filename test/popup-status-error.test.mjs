'use strict';

/*
 * Integration tests for the popup side of GitHub Issue #2 (review finding
 * F-8).
 *
 * The content script's 'hys-status' handler (src/content/main.js) now
 * responds with `{ error: String(e) }` when hysSubs.status() rejects (the
 * content-script side is covered by test/content-status-error.test.mjs).
 * The popup's renderStatus() (src/popup/popup.js) received the matching
 * guard
 *
 *   if (tabStatus?.error) tabStatus = null;
 *
 * so an error response falls back to the local-cache rendering path instead
 * of corrupting the status display (e.g. "Active: undefined",
 * "Cached subscriptions: undefined (updated: never)").
 *
 * These tests load popup.js in a VM sandbox with mocked chrome APIs and a
 * minimal DOM and assert:
 *   1. sendMessage resolves with { error } -> local-cache fallback path is
 *      rendered, no 'undefined' artifacts from reading status fields off
 *      the error object.
 *   2. sendMessage resolves with a normal status object -> the regular
 *      status rendering path is used (the guard does not interfere).
 *   3. sendMessage rejects outright (no content script in the tab) -> the
 *      pre-existing catch still renders the "Reload the YouTube tab" hint
 *      plus the local-cache fallback.
 *
 * NOTE: Deliberately self-contained (duplicates harness ideas from
 * test/content-status-error.test.mjs) — the project accepts duplication
 * between test files, see the NOTE in test/integration.test.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POPUP_PATH = path.join(__dirname, '..', 'src', 'popup', 'popup.js');

const YT_TAB = { id: 7, url: 'https://www.youtube.com/' };

/** Flush pending promise jobs and timers a few event-loop turns deep. */
async function settle(turns = 5) {
  for (let i = 0; i < turns; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Minimal DOM element stub used for every element popup.js touches. */
function makeEl() {
  return {
    textContent: '',
    checked: false,
    addEventListener() {},
  };
}

/**
 * Loads popup.js in a fresh VM context.
 *
 * popup.js is a plain (non-module) IIFE that resolves the extension API via
 * `globalThis.browser ?? globalThis.chrome`, grabs #status/#options/#refresh
 * and the mode radio inputs from the DOM, and uses the helper global
 * `hysGetSettings` provided by src/common/settings.js. The sandbox mocks
 * all of these; `browser` is intentionally left undefined.
 *
 * Its init() runs immediately and ends in an un-awaited renderStatus(), so
 * callers must `await settle()` (done here) before inspecting the DOM.
 *
 * @param {object} opts
 * @param {() => Promise<any>} opts.sendMessage mock for
 *   api.tabs.sendMessage; receives (tabId, msg). Required.
 * @param {object} [opts.cache] value stored under the 'hysSubsCache' key in
 *   storage.local (omitted -> empty storage).
 * @param {string} [opts.mode] settings mode returned by hysGetSettings
 *   (default 'subs').
 * @returns {Promise<{ statusEl: { textContent: string }, calls: { sendMessage: any[] } }>}
 */
async function loadPopup(opts) {
  const code = fs.readFileSync(POPUP_PATH, 'utf8');
  const calls = { sendMessage: [] };
  const statusEl = makeEl();
  const elements = { status: statusEl, options: makeEl(), refresh: makeEl() };

  const sandbox = {
    chrome: {
      tabs: {
        query: async () => [YT_TAB],
        sendMessage: async (tabId, msg) => {
          calls.sendMessage.push({ tabId, msg });
          return opts.sendMessage(tabId, msg);
        },
      },
      storage: {
        local: {
          get: async () => (opts.cache !== undefined ? { hysSubsCache: opts.cache } : {}),
        },
      },
      runtime: {
        openOptionsPage() {},
      },
    },
    document: {
      getElementById: (id) => elements[id] ?? makeEl(),
      querySelector: () => makeEl(),
      querySelectorAll: () => [],
    },
    hysGetSettings: async () => ({ mode: opts.mode ?? 'subs' }),
  };

  vm.runInNewContext(code, sandbox, { filename: POPUP_PATH });
  await settle();
  return { statusEl, calls };
}

test('renderStatus falls back to the local cache when hys-status responds with { error }', async () => {
  const { statusEl, calls } = await loadPopup({
    sendMessage: async () => ({ error: 'Error: storage boom' }),
    cache: { channels: ['UC-a', 'UC-b'], ts: 1717000000000 },
    mode: 'subs',
  });

  assert.equal(calls.sendMessage.length, 1, 'popup must request the tab status exactly once');
  // Note: the message object is created inside the VM realm, so compare
  // fields instead of deepStrictEqual (which checks prototype identity).
  assert.equal(calls.sendMessage[0].msg?.type, 'hys-status');

  const text = statusEl.textContent;
  assert.ok(text.length > 0, 'status element must be rendered');

  // Local-cache fallback path, not the tab-status path.
  assert.match(text, /Mode: Subscribed channels only/, 'fallback must render the settings mode');
  assert.match(text, /Cached subscriptions: 2/, 'fallback must render the local cache count');
  assert.doesNotMatch(text, /Active:/, 'error response must not be rendered as a live tab status');
  assert.doesNotMatch(text, /Signed in:/, 'error response must not be rendered as a live tab status');

  // No field access on the error object may leak into the output.
  assert.doesNotMatch(text, /undefined/, 'no undefined artifacts from reading fields off the error object');
  assert.doesNotMatch(text, /storage boom/, 'the raw error text must not corrupt the status display');

  // The tab exists, so neither no-tab nor reload hints apply.
  assert.doesNotMatch(text, /No active YouTube tab\./);
  assert.doesNotMatch(text, /Reload the YouTube tab/);
});

test('renderStatus uses the normal status path when hys-status responds without error (guard does not interfere)', async () => {
  const { statusEl } = await loadPopup({
    sendMessage: async () => ({
      mode: 'all',
      loggedIn: true,
      subsCount: 3,
      subsTs: 1717000000000,
    }),
    cache: { channels: ['UC-a'], ts: 1 },
    mode: 'all',
  });

  const text = statusEl.textContent;
  assert.match(text, /Active: All Shorts hidden/, 'live tab status must be rendered');
  assert.match(text, /Signed in: yes/);
  assert.match(text, /Cached subscriptions: 3/, 'count must come from the tab status, not the local cache');
  assert.doesNotMatch(text, /Mode: /, 'fallback path must not run for a healthy status response');
  assert.doesNotMatch(text, /undefined/);
});

test('renderStatus keeps the reload hint and cache fallback when sendMessage rejects outright', async () => {
  const { statusEl } = await loadPopup({
    sendMessage: async () => {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    },
    cache: { channels: [], ts: 0 },
    mode: 'off',
  });

  const text = statusEl.textContent;
  assert.match(text, /Reload the YouTube tab to see its status\./, 'pre-existing catch must still render the hint');
  assert.match(text, /Mode: Off/, 'fallback must render the settings mode');
  assert.match(text, /Cached subscriptions: 0/);
  assert.doesNotMatch(text, /Active:/);
  assert.doesNotMatch(text, /undefined/);
});
