'use strict';

/*
 * Edge-case tests for the GitHub Issue #2 fix.
 *
 * The 'hys-status' handler in src/content/main.js now ends with
 * `.catch((e) => sendResponse({ error: String(e) }))`. These tests cover
 * the boundary conditions NOT exercised by the sibling tests
 * (test/content-status-error.test.mjs covers rejection-with-Error;
 * test/content-status-regression.test.mjs covers the success path and
 * non-Error rejection coercion):
 *
 *   1. status() rejecting with `undefined` / `null` — String(undefined)
 *      and String(null) still yield a string error, and sendResponse is
 *      called exactly once.
 *   2. status() resolving with an object that itself carries an `error`
 *      property — the content script spreads it through unchanged
 *      (`{ loggedIn, mode, ...s }`), so the popup guard
 *      `if (tabStatus?.error) tabStatus = null;` treats it as an error.
 *      This documents that pass-through contract.
 *   3. Rapid double dispatch — two concurrent 'hys-status' messages where
 *      the first rejects and the second resolves; each message's own
 *      sendResponse closure receives its own correct payload.
 *
 * Skipped by design: a SYNCHRONOUS throw from hysSubs.status(). main.js
 * calls `hysSubs.status().then(...).catch(...)`; if status were a plain
 * function that threw before returning a promise, the exception would
 * escape the listener before .then/.catch ever attached. That cannot
 * happen in practice because status() in src/content/subs.js is declared
 * `async function status()` (any throw inside becomes a rejection), so the
 * code makes no guarantee for non-async replacements and we do not invent
 * one here.
 *
 * NOTE: Deliberately self-contained (duplicates harness helpers from
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
const MAIN_PATH = path.join(__dirname, '..', 'src', 'content', 'main.js');
const EXTENSION_ID = 'test-ext-id';

/**
 * Loads main.js in a fresh VM context (same harness as the sibling
 * status tests). main.js is a plain content script that resolves the
 * extension API via `globalThis.browser ?? globalThis.chrome`, touches the
 * DOM, and uses the helper globals `hysGetSettings`/`hysSubs` provided by
 * sibling content scripts; the sandbox mocks all of these.
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

/**
 * Dispatches one message and records EVERY sendResponse invocation.
 * Resolves once at least `expect` responses arrived (or after timeoutMs),
 * after letting the event loop settle so duplicate calls would be caught.
 *
 * @returns {Promise<{ responses: any[], returned: any }>}
 */
async function dispatchCollect(listener, msg, sender, { expect = 1, timeoutMs = 100 } = {}) {
  const responses = [];
  let returned;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    const sendResponse = (value) => {
      responses.push(value);
      if (responses.length >= expect) {
        clearTimeout(timer);
        // Settle a turn so an (incorrect) second call would still land
        // in `responses` before we assert.
        setImmediate(resolve);
      }
    };
    returned = listener(msg, sender, sendResponse);
  });
  return { responses, returned };
}

test('hys-status: rejection with undefined still yields a string error, exactly one response', async () => {
  const unhandled = [];
  const onUnhandledRejection = (reason) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandledRejection);

  try {
    const { listener, calls } = await loadMain({
      status: () => Promise.reject(undefined),
    });

    const { responses, returned } = await dispatchCollect(
      listener,
      { type: 'hys-status' },
      { id: EXTENSION_ID },
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(returned, true, 'listener must claim the async response channel');
    assert.equal(calls.status, 1, 'hysSubs.status must have been invoked exactly once');
    assert.equal(responses.length, 1, 'sendResponse must be called exactly once');
    assert.equal(typeof responses[0].error, 'string', 'error must be coerced to a string');
    assert.equal(responses[0].error, 'undefined', "String(undefined) is 'undefined'");
    assert.equal(unhandled.length, 0, 'rejection must not escape as unhandledRejection');
  } finally {
    process.removeListener('unhandledRejection', onUnhandledRejection);
  }
});

test('hys-status: rejection with null still yields a string error, exactly one response', async () => {
  const unhandled = [];
  const onUnhandledRejection = (reason) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandledRejection);

  try {
    const { listener, calls } = await loadMain({
      status: () => Promise.reject(null),
    });

    const { responses } = await dispatchCollect(
      listener,
      { type: 'hys-status' },
      { id: EXTENSION_ID },
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(calls.status, 1, 'hysSubs.status must have been invoked exactly once');
    assert.equal(responses.length, 1, 'sendResponse must be called exactly once');
    assert.equal(typeof responses[0].error, 'string', 'error must be coerced to a string');
    assert.equal(responses[0].error, 'null', "String(null) is 'null'");
    assert.equal(unhandled.length, 0, 'rejection must not escape as unhandledRejection');
  } finally {
    process.removeListener('unhandledRejection', onUnhandledRejection);
  }
});

test('hys-status: a resolved status object carrying an `error` property is passed through unchanged', async () => {
  // Contract documentation: the handler builds `{ loggedIn, mode, ...s }`,
  // so a successful status() result that happens to contain `error` reaches
  // the popup as-is — and the popup guard `if (tabStatus?.error)` will then
  // discard the whole status. Anyone adding an `error` field to a
  // successful status() payload changes popup behavior.
  const { listener, calls } = await loadMain({
    status: async () => ({ count: 3, error: 'partial fetch failed' }),
  });

  const { responses } = await dispatchCollect(
    listener,
    { type: 'hys-status' },
    { id: EXTENSION_ID },
  );

  assert.equal(calls.status, 1, 'hysSubs.status must have been invoked exactly once');
  assert.equal(responses.length, 1, 'sendResponse must be called exactly once');
  const response = responses[0];
  assert.equal(response.error, 'partial fetch failed', 'error property must pass through unchanged');
  assert.equal(response.count, 3, 'other status fields must pass through unchanged');
  assert.equal(typeof response.loggedIn, 'boolean', 'loggedIn must still be attached');
  assert.equal(typeof response.mode, 'string', 'mode must still be attached');
});

test('hys-status: rapid double dispatch — first rejects, second resolves, responses are not crossed', async () => {
  // Each message gets its own sendResponse closure; verify the .then/.catch
  // chains stay isolated even when the responses settle out of dispatch
  // order (second resolves before the first rejects).
  let call = 0;
  let rejectFirst;
  let resolveSecond;
  const { listener, calls } = await loadMain({
    status: () => {
      call += 1;
      if (call === 1) {
        return new Promise((resolve, reject) => {
          rejectFirst = reject;
        });
      }
      return new Promise((resolve) => {
        resolveSecond = resolve;
      });
    },
  });

  const first = dispatchCollect(listener, { type: 'hys-status' }, { id: EXTENSION_ID }, { timeoutMs: 200 });
  const second = dispatchCollect(listener, { type: 'hys-status' }, { id: EXTENSION_ID }, { timeoutMs: 200 });

  // Both handlers are now pending on their own status() promise.
  assert.equal(calls.status, 2, 'both messages must trigger their own status() call');

  // Settle them in reverse order to expose any closure mix-up.
  resolveSecond({ count: 7 });
  await new Promise((resolve) => setImmediate(resolve));
  rejectFirst(new Error('first boom'));

  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult.responses.length, 1, 'first message must get exactly one response');
  assert.equal(secondResult.responses.length, 1, 'second message must get exactly one response');

  const firstResponse = firstResult.responses[0];
  const secondResponse = secondResult.responses[0];
  assert.equal(typeof firstResponse.error, 'string', 'first (rejected) must get an error response');
  assert.match(firstResponse.error, /first boom/, 'first error must describe its own rejection');
  assert.equal(secondResponse.error, undefined, 'second (resolved) must not get an error');
  assert.equal(secondResponse.count, 7, 'second must receive its own status payload');
  assert.equal(typeof secondResponse.loggedIn, 'boolean', 'second must carry loggedIn');
  assert.equal(typeof secondResponse.mode, 'string', 'second must carry mode');
});
