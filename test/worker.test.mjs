'use strict';

/*
 * Reproduction test for GitHub Issue #1.
 *
 * The background worker (src/background/worker.js) acts as a privileged
 * fetch proxy for content scripts. It currently:
 *   1. forwards `msg.init` verbatim into fetch() (method/headers/mode etc.),
 *   2. leaks raw exception text via String(e) in the error response,
 *   3. performs no sender validation at all.
 *
 * This test loads the worker script in a VM sandbox with a mocked
 * extension API and fetch, and asserts the hardened behavior. It MUST
 * FAIL against the current (unfixed) code.
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

test('worker fetch proxy strips disallowed init properties, hides error details, and rejects foreign senders', async () => {
  const validSender = { id: EXTENSION_ID, url: 'https://www.youtube.com/' };

  // --- Gap 1: msg.init must not be forwarded verbatim into fetch() ---
  {
    const fetchCalls = [];
    const listener = loadWorker({
      fetchImpl: async (url, init) => {
        fetchCalls.push({ url, init });
        return makeOkResponse();
      },
    });

    await dispatch(
      listener,
      {
        type: 'hys-fetch',
        url: 'https://www.youtube.com/feed/channels',
        init: {
          method: 'DELETE',
          headers: { Authorization: 'Bearer x' },
          mode: 'no-cors',
        },
      },
      validSender,
    );

    assert.equal(fetchCalls.length, 1, 'fetch should be called once for a valid request');
    const init = fetchCalls[0].init ?? {};
    assert.notEqual(
      init.method,
      'DELETE',
      'disallowed method DELETE must not be forwarded to fetch',
    );
    const headers = init.headers ?? {};
    assert.ok(
      !('Authorization' in headers),
      'Authorization header from content script must not be forwarded to fetch',
    );
    assert.ok(
      !('mode' in init),
      'mode from content script must not be forwarded to fetch',
    );
  }

  // --- Gap 2: raw exception text must not leak to the content script ---
  {
    const listener = loadWorker({
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED 10.0.0.5:443 internal-host');
      },
    });

    const response = await dispatch(
      listener,
      { type: 'hys-fetch', url: 'https://www.youtube.com/feed/channels' },
      validSender,
    );

    assert.ok(response, 'worker should send an error response');
    assert.equal(response.ok, false);
    const errorText = String(response.error ?? '');
    assert.ok(
      !errorText.includes('internal-host'),
      `error response must not leak raw exception details, got: ${errorText}`,
    );
    assert.ok(
      !errorText.includes('ECONNREFUSED'),
      `error response must not leak raw exception details, got: ${errorText}`,
    );
  }

  // --- Gap 3: messages from foreign senders must never reach fetch ---
  {
    const fetchCalls = [];
    const listener = loadWorker({
      fetchImpl: async (url, init) => {
        fetchCalls.push({ url, init });
        return makeOkResponse();
      },
    });

    const msg = { type: 'hys-fetch', url: 'https://www.youtube.com/feed/channels' };

    await dispatch(listener, msg, { id: 'some-other-extension', url: 'https://www.youtube.com/' });
    assert.equal(
      fetchCalls.length,
      0,
      'fetch must not be called for a message from a foreign extension id',
    );

    await dispatch(listener, msg, { id: EXTENSION_ID, url: 'https://evil.example/' });
    assert.equal(
      fetchCalls.length,
      0,
      'fetch must not be called for a message from a non-YouTube sender page',
    );
  }
});
