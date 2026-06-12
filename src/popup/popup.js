'use strict';

/* Popup: switch modes, show status, refresh the subscription list. */

(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const statusEl = document.getElementById('status');

  const MODE_LABELS = {
    off: 'Off',
    all: 'All Shorts hidden',
    subs: 'Subscribed channels only'
  };

  async function activeYouTubeTab() {
    try {
      const tabs = await api.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (tab?.url && /^https?:\/\/(www|m)\.youtube\.com\//.test(tab.url)) return tab;
    } catch {
      /* no access */
    }
    return null;
  }

  function formatTs(ts) {
    if (!ts) return 'never';
    return new Date(ts).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
  }

  async function renderStatus() {
    const settings = await hysGetSettings();
    const lines = [];
    const tab = await activeYouTubeTab();
    let tabStatus = null;

    if (tab) {
      try {
        tabStatus = await api.tabs.sendMessage(tab.id, { type: 'hys-status' });
        if (tabStatus?.error) tabStatus = null;
      } catch {
        lines.push('Reload the YouTube tab to see its status.');
      }
    }

    if (tabStatus) {
      lines.push(`Active: ${MODE_LABELS[tabStatus.mode] ?? tabStatus.mode}`);
      lines.push(`Signed in: ${tabStatus.loggedIn ? 'yes' : 'no'}`);
      if (settings.mode === 'subs' && !tabStatus.loggedIn) {
        lines.push('While signed out, all Shorts are hidden.');
      }
      lines.push(`Cached subscriptions: ${tabStatus.subsCount} (updated: ${formatTs(tabStatus.subsTs)})`);
    } else {
      // Fallback without a YouTube tab: read the cache directly
      const st = await api.storage.local.get('hysSubsCache');
      const cache = st.hysSubsCache;
      lines.push(`Mode: ${MODE_LABELS[settings.mode] ?? settings.mode}`);
      lines.push(`Cached subscriptions: ${cache?.channels?.length ?? 0} (updated: ${formatTs(cache?.ts)})`);
      if (!tab) lines.push('No active YouTube tab.');
    }

    statusEl.textContent = lines.join('\n');
  }

  async function init() {
    const settings = await hysGetSettings();
    const current = document.querySelector(`input[name="mode"][value="${settings.mode}"]`);
    if (current) current.checked = true;

    for (const input of document.querySelectorAll('input[name="mode"]')) {
      input.addEventListener('change', async () => {
        await hysSaveSettings({ mode: input.value });
        renderStatus();
      });
    }

    document.getElementById('options').addEventListener('click', (e) => {
      e.preventDefault();
      api.runtime.openOptionsPage();
    });

    document.getElementById('refresh').addEventListener('click', async () => {
      const tab = await activeYouTubeTab();
      if (!tab) {
        statusEl.textContent = 'Please open a YouTube tab first.';
        return;
      }
      statusEl.textContent = 'Refreshing subscriptions …';
      try {
        const result = await api.tabs.sendMessage(tab.id, { type: 'hys-refresh-subs' });
        if (result?.error) {
          statusEl.textContent = 'Error: ' + result.error;
          return;
        }
      } catch {
        statusEl.textContent = 'Please reload the YouTube tab and try again.';
        return;
      }
      renderStatus();
    });

    renderStatus();
  }

  init();
})();
