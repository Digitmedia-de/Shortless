'use strict';

/*
 * Subs mode: obtain the subscription list and map Shorts videos to their channels.
 *
 * - Subscription list: /feed/channels is fetched (via the background worker)
 *   and ytInitialData is parsed; continuations are followed through the
 *   InnerTube API.
 * - Channel per video: oEmbed endpoint (no API key required), results are
 *   cached in storage.local.
 */

const hysSubs = (() => {
  const api = globalThis.browser ?? globalThis.chrome;

  const SUBS_KEY = 'hysSubsCache';
  const VIDEO_KEY = 'hysVideoChannels';
  const VIDEO_CACHE_MAX = 5000;
  const MAX_PARALLEL = 4;

  let subsCache = null;   // { ts, channels: [{ id, title, handle }] }
  let videoCache = null;  // Map videoId -> { name, handle }
  let loadPromise = null;
  let fetchPromise = null;
  let persistTimer = null;
  const pending = new Map();

  /* ---------- small semaphore for oEmbed lookups ---------- */
  let active = 0;
  const queue = [];
  function limit(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      pump();
    });
  }
  function pump() {
    while (active < MAX_PARALLEL && queue.length) {
      const { fn, resolve, reject } = queue.shift();
      active++;
      fn().then(resolve, reject).finally(() => { active--; pump(); });
    }
  }

  /* ---------- fetch through the background worker (CORS-free) ---------- */
  async function httpText(url, init) {
    const r = await api.runtime.sendMessage({ type: 'hys-fetch', url, init });
    if (!r || !r.ok) throw new Error(`HTTP ${r?.status ?? '?'} for ${url}`);
    return r.text;
  }

  /* ---------- load / persist caches ---------- */
  function load() {
    if (!loadPromise) {
      loadPromise = api.storage.local.get([SUBS_KEY, VIDEO_KEY]).then((st) => {
        subsCache = st[SUBS_KEY] || null;
        videoCache = new Map(st[VIDEO_KEY] || []);
      });
    }
    return loadPromise;
  }

  function schedulePersist() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      let entries = [...videoCache.entries()];
      if (entries.length > VIDEO_CACHE_MAX) {
        entries = entries.slice(entries.length - VIDEO_CACHE_MAX);
        videoCache = new Map(entries);
      }
      api.storage.local.set({ [VIDEO_KEY]: entries });
    }, 2000);
  }

  /* ---------- helpers ---------- */
  function normHandle(value) {
    if (!value) return '';
    return decodeURIComponent(String(value))
      .replace(/^.*\//, '')
      .replace(/^@/, '')
      .toLowerCase();
  }

  function extractJson(html, name) {
    const marker = `var ${name} = `;
    const i = html.indexOf(marker);
    if (i < 0) throw new Error(`${name} not found`);
    const start = i + marker.length;
    // YouTube escapes "<" inside the JSON, so ";</script>" is a safe terminator.
    const end = html.indexOf(';</script>', start);
    if (end < 0) throw new Error(`${name}: end not found`);
    return JSON.parse(html.slice(start, end));
  }

  function walk(node, visit) {
    if (!node || typeof node !== 'object') return;
    visit(node);
    for (const key of Object.keys(node)) walk(node[key], visit);
  }

  function collectChannels(data, out) {
    let continuation = null;
    walk(data, (n) => {
      const r = n.channelRenderer;
      if (r && r.channelId) {
        out.push({
          id: r.channelId,
          title: (r.title && (r.title.simpleText || (r.title.runs || []).map((x) => x.text).join(''))) || '',
          handle: normHandle(r.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || '')
        });
      }
      if (n.continuationCommand?.token) continuation = n.continuationCommand.token;
    });
    return continuation;
  }

  /* ---------- obtain the subscription list ---------- */
  async function fetchSubscriptions() {
    const html = await httpText('https://www.youtube.com/feed/channels', { credentials: 'include' });
    const channels = [];
    let token = collectChannels(extractJson(html, 'ytInitialData'), channels);

    const key = (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1];
    const version = (html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/) || [])[1];

    let guard = 0;
    while (token && key && guard++ < 25) {
      const prev = token;
      token = null;
      try {
        const body = await httpText(
          `https://www.youtube.com/youtubei/v1/browse?key=${key}&prettyPrint=false`,
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              context: { client: { clientName: 'WEB', clientVersion: version || '2.20260601.00.00' } },
              continuation: prev
            })
          }
        );
        token = collectChannels(JSON.parse(body), channels);
        if (token === prev) break;
      } catch {
        break;
      }
    }

    const seen = new Set();
    const result = [];
    for (const c of channels) {
      if (!seen.has(c.id)) {
        seen.add(c.id);
        result.push(c);
      }
    }
    return result;
  }

  async function ensureFresh(settings, force = false) {
    await load();
    const maxAge = Math.max(1, settings?.subsCacheHours ?? 24) * 3600 * 1000;
    const fresh = subsCache && subsCache.channels.length > 0 && Date.now() - subsCache.ts < maxAge;
    if (fresh && !force) return subsCache;

    if (!fetchPromise) {
      fetchPromise = fetchSubscriptions()
        .then((channels) => {
          // Empty results (e.g. parser breakage) never overwrite a usable cache.
          if (channels.length > 0 || !subsCache) {
            subsCache = { ts: Date.now(), channels };
            api.storage.local.set({ [SUBS_KEY]: subsCache });
          }
          return subsCache;
        })
        .finally(() => { fetchPromise = null; });
    }
    try {
      return await fetchPromise;
    } catch {
      return subsCache || { ts: 0, channels: [] };
    }
  }

  /* ---------- allowed sets (subscriptions + whitelist) ---------- */
  function handleSet(settings) {
    const s = new Set();
    for (const c of subsCache?.channels || []) if (c.handle) s.add(c.handle);
    for (const w of settings?.whitelist || []) {
      const h = normHandle(String(w).trim());
      if (h) s.add(h);
    }
    return s;
  }

  function nameSet(settings) {
    const s = new Set();
    for (const c of subsCache?.channels || []) if (c.title) s.add(c.title.toLowerCase());
    for (const w of settings?.whitelist || []) {
      const t = String(w).trim().toLowerCase();
      if (t && !t.startsWith('@')) s.add(t);
    }
    return s;
  }

  /* ---------- resolve the channel of a video (oEmbed) ---------- */
  function channelForVideo(videoId) {
    if (videoCache.has(videoId)) return Promise.resolve(videoCache.get(videoId));
    if (pending.has(videoId)) return pending.get(videoId);

    const p = limit(async () => {
      const url = 'https://www.youtube.com/oembed?url=' +
        encodeURIComponent('https://www.youtube.com/watch?v=' + videoId) + '&format=json';
      const json = JSON.parse(await httpText(url, { credentials: 'omit' }));
      const entry = { name: json.author_name || '', handle: normHandle(json.author_url || '') };
      videoCache.set(videoId, entry);
      schedulePersist();
      return entry;
    }).catch(() => null).finally(() => pending.delete(videoId));

    pending.set(videoId, p);
    return p;
  }

  /* ---------- public API ---------- */
  async function isVideoAllowed(videoId, settings) {
    await ensureFresh(settings);
    const entry = await channelForVideo(videoId);
    if (!entry) return false;
    return (entry.handle !== '' && handleSet(settings).has(entry.handle)) ||
           (entry.name !== '' && nameSet(settings).has(entry.name.toLowerCase()));
  }

  async function isChannelAllowed(pathname, settings) {
    await ensureFresh(settings);
    let m = pathname.match(/^\/@([^/]+)/);
    if (m) return handleSet(settings).has(normHandle(m[1]));
    m = pathname.match(/^\/channel\/([\w-]+)/);
    if (m) return (subsCache?.channels || []).some((c) => c.id === m[1]);
    return false;
  }

  async function status() {
    await load();
    return {
      subsCount: subsCache?.channels.length ?? 0,
      subsTs: subsCache?.ts ?? 0
    };
  }

  async function refresh(settings) {
    await ensureFresh(settings, true);
    return status();
  }

  return { isVideoAllowed, isChannelAllowed, status, refresh, ensureFresh };
})();
