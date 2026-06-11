'use strict';

/*
 * Shared settings (chrome.storage.sync).
 * Loaded as a classic script in content scripts, popup and options.
 */

const HYS_DEFAULTS = Object.freeze({
  // 'off' = hide nothing, 'all' = hide all Shorts,
  // 'subs' = only allow Shorts from subscribed channels
  mode: 'all',
  // Hide the Shorts entry in the navigation (sidebar / mobile pivot bar)
  hideSidebarEntry: true,
  // Hide the Shorts tab on channel pages
  hideChannelTab: false,
  // Automatically redirect /shorts/<id> to the regular player (/watch?v=<id>)
  redirectShortsPlayer: true,
  // Manually allowed channels (handles like "@channel" or channel names)
  whitelist: [],
  // Lifetime of the cached subscription list, in hours
  subsCacheHours: 24
});

const hysApi = globalThis.browser ?? globalThis.chrome;

async function hysGetSettings() {
  const stored = await hysApi.storage.sync.get(HYS_DEFAULTS);
  return { ...HYS_DEFAULTS, ...stored };
}

async function hysSaveSettings(patch) {
  await hysApi.storage.sync.set(patch);
}
