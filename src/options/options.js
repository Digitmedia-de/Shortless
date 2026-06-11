'use strict';

/* Options page: edit all settings, manage caches. */

(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const savedEl = document.getElementById('saved');
  let savedTimer = null;

  function flashSaved() {
    savedEl.hidden = false;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => { savedEl.hidden = true; }, 1500);
  }

  async function renderCacheInfo() {
    const st = await api.storage.local.get(['hysSubsCache', 'hysVideoChannels']);
    const subs = st.hysSubsCache?.channels?.length ?? 0;
    const videos = (st.hysVideoChannels || []).length;
    document.getElementById('cacheInfo').textContent =
      `Cached: ${subs} subscriptions, ${videos} video-to-channel mappings.`;
  }

  async function init() {
    const settings = await hysGetSettings();

    const modeInput = document.querySelector(`input[name="mode"][value="${settings.mode}"]`);
    if (modeInput) modeInput.checked = true;
    for (const input of document.querySelectorAll('input[name="mode"]')) {
      input.addEventListener('change', async () => {
        await hysSaveSettings({ mode: input.value });
        flashSaved();
      });
    }

    for (const id of ['hideSidebarEntry', 'hideChannelTab', 'redirectShortsPlayer']) {
      const box = document.getElementById(id);
      box.checked = settings[id];
      box.addEventListener('change', async () => {
        await hysSaveSettings({ [id]: box.checked });
        flashSaved();
      });
    }

    const hours = document.getElementById('subsCacheHours');
    hours.value = settings.subsCacheHours;
    hours.addEventListener('change', async () => {
      const value = Math.min(720, Math.max(1, parseInt(hours.value, 10) || 24));
      hours.value = value;
      await hysSaveSettings({ subsCacheHours: value });
      flashSaved();
    });

    const whitelist = document.getElementById('whitelist');
    whitelist.value = (settings.whitelist || []).join('\n');
    whitelist.addEventListener('change', async () => {
      const entries = whitelist.value
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      await hysSaveSettings({ whitelist: entries });
      flashSaved();
    });

    document.getElementById('clearCache').addEventListener('click', async () => {
      await api.storage.local.remove(['hysSubsCache', 'hysVideoChannels']);
      renderCacheInfo();
      flashSaved();
    });

    renderCacheInfo();
  }

  init();
})();
