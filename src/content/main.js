'use strict';

/*
 * Controls hiding via data-hys-* attributes on <html>, watches SPA
 * navigation and dynamically loaded content, and marks allowed Shorts
 * in subs mode.
 */

(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const docEl = document.documentElement;

  let settings = null;
  let loggedIn = false;

  const CONTAINER_SELECTOR = [
    'ytd-rich-item-renderer',
    'ytd-video-renderer',
    'ytd-compact-video-renderer',
    'ytd-grid-video-renderer',
    'ytd-reel-item-renderer',
    'yt-lockup-view-model',
    'ytm-shorts-lockup-view-model',
    'ytm-shorts-lockup-view-model-v2',
    'ytm-video-with-context-renderer'
  ].join(',');

  // SAPISID cookies are not HttpOnly and only exist while logged in.
  function detectLogin() {
    return /(?:^|;\s*)(?:SAPISID|__Secure-3PAPISID)=/.test(document.cookie);
  }

  function pageKind() {
    const p = location.pathname;
    if (p.startsWith('/feed/subscriptions')) return 'subscriptions';
    if (p.startsWith('/feed/history')) return 'history';
    if (/^\/(@|channel\/|c\/|user\/)/.test(p)) return 'channel';
    if (p.startsWith('/shorts/')) return 'shorts';
    return 'other';
  }

  function effectiveMode() {
    if (!settings || settings.mode === 'off') return 'off';
    // Without a login there is no subscription list -> hide everything.
    if (settings.mode === 'subs' && !loggedIn) return 'all';
    return settings.mode;
  }

  function maybeRedirect() {
    if (!settings || settings.mode === 'off' || !settings.redirectShortsPlayer) return;
    const m = location.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{5,})/);
    if (m) location.replace('/watch?v=' + m[1]);
  }

  function clearMarks() {
    for (const el of document.querySelectorAll('[data-hys-checked]')) {
      el.removeAttribute('data-hys-checked');
      el.removeAttribute('data-hys-allowed');
    }
  }

  function scanShortsItems() {
    if (effectiveMode() !== 'subs') return;
    const kind = pageKind();
    if (kind === 'subscriptions' || kind === 'history' || docEl.hasAttribute('data-hys-channel-allowed')) return;

    for (const a of document.querySelectorAll('a[href^="/shorts/"]')) {
      const container = a.closest(CONTAINER_SELECTOR);
      if (!container) continue;
      const videoId = ((a.getAttribute('href') || '').match(/^\/shorts\/([A-Za-z0-9_-]{5,})/) || [])[1];
      // YouTube recycles containers on navigation/scroll -> use the video id as marker.
      if (!videoId || container.getAttribute('data-hys-checked') === videoId) continue;
      container.setAttribute('data-hys-checked', videoId);
      container.removeAttribute('data-hys-allowed');
      hysSubs.isVideoAllowed(videoId, settings).then((allowed) => {
        if (allowed && container.getAttribute('data-hys-checked') === videoId) {
          container.setAttribute('data-hys-allowed', '');
        }
      });
    }
  }

  let scanScheduled = false;
  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      scanShortsItems();
    });
  }

  async function applyState() {
    loggedIn = detectLogin();
    const mode = effectiveMode();
    docEl.setAttribute('data-hys-mode', mode);
    docEl.setAttribute('data-hys-page', pageKind());
    docEl.toggleAttribute('data-hys-sidebar', mode !== 'off' && settings.hideSidebarEntry);
    docEl.toggleAttribute('data-hys-chtab', mode !== 'off' && settings.hideChannelTab);
    docEl.removeAttribute('data-hys-channel-allowed');
    maybeRedirect();

    if (mode === 'subs') {
      if (pageKind() === 'channel') {
        const ok = await hysSubs.isChannelAllowed(location.pathname, settings);
        docEl.toggleAttribute('data-hys-channel-allowed', ok);
      }
      scanShortsItems();
    }
  }

  async function init() {
    settings = await hysGetSettings();
    await applyState();

    const observer = new MutationObserver(scheduleScan);
    const startObserve = () => observer.observe(document.body ?? docEl, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href']
    });
    if (document.body) startObserve();
    else document.addEventListener('DOMContentLoaded', startObserve, { once: true });

    // YouTube SPA navigation
    document.addEventListener('yt-navigate-start', maybeRedirect, true);
    document.addEventListener('yt-navigate-finish', () => {
      clearMarks();
      applyState();
    }, true);

    api.storage.onChanged.addListener(async (changes, area) => {
      if (area !== 'sync') return;
      settings = await hysGetSettings();
      clearMarks();
      applyState();
    });

    api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'hys-status') {
        hysSubs.status().then((s) => sendResponse({
          loggedIn,
          mode: effectiveMode(),
          ...s
        }));
        return true;
      }
      if (msg.type === 'hys-refresh-subs') {
        hysSubs.refresh(settings)
          .then((s) => {
            clearMarks();
            applyState();
            sendResponse(s);
          })
          .catch((e) => sendResponse({ error: String(e) }));
        return true;
      }
    });
  }

  init();
})();
