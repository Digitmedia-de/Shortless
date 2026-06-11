# Shortless

[![CI](https://github.com/Digitmedia-de/Shortless/actions/workflows/ci.yml/badge.svg)](https://github.com/Digitmedia-de/Shortless/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-green)

Browser extension (Chrome, Firefox, Safari) that hides YouTube Shorts – either completely, or so that only Shorts from channels you subscribe to remain visible. While signed out of YouTube, all Shorts are always hidden.

## Modes

| Mode | Behavior |
|---|---|
| **Off** | No changes |
| **Hide all** | Shorts shelves, tiles, navigation entry etc. are removed everywhere |
| **Subscriptions only** | Shorts from subscribed channels (and whitelisted channels) stay visible, all others are hidden. Signed out → behaves like “Hide all” |

Additional settings (options page):

- Hide the “Shorts” entry in the navigation
- Hide the “Shorts” tab on channel pages
- Automatically open Shorts links in the regular player (`/shorts/<id>` → `/watch?v=<id>`)
- Whitelist of additional channels (handle `@channel` or channel name)
- Cache lifetime of the subscription list

Watch history (`/feed/history`) is never filtered.

## Installation (development)

Build first:

```sh
node scripts/make-icons.mjs   # only needed if icons/ is missing
node scripts/build.mjs        # creates dist/chrome, dist/firefox, dist/safari + ZIPs
```

**Chrome:** `chrome://extensions` → Developer mode → “Load unpacked” → `dist/chrome`

**Firefox:** `about:debugging#/runtime/this-firefox` → “Load Temporary Add-on” → `dist/firefox/manifest.json` (permanent: submit the ZIP to addons.mozilla.org, MV3 requires Firefox ≥ 121)

**Safari:** full Xcode required (not just the Command Line Tools), then:

```sh
./scripts/safari-convert.sh   # creates platform/safari (Xcode project)
```

Open the project in Xcode, build and run the wrapper app, then enable the extension in Safari → Settings → Extensions. For local use the free signing is sufficient; distribution goes through the Mac App Store (Apple Developer Program).

## Architecture

```
manifest.json                 MV3, shared base (the build adapts it per browser)
src/common/settings.js        Defaults + storage.sync helpers
src/content/hide-shorts.css   All hiding rules, toggled via data-hys-* attributes on <html>
src/content/main.js           Mode application, MutationObserver, SPA navigation, redirect, marking allowed Shorts
src/content/subs.js           Subscription list (/feed/channels + InnerTube continuations), per-video channel resolution (oEmbed), caches
src/background/worker.js      Fetch proxy (bypasses page CORS, e.g. on m.youtube.com)
src/popup/                    Quick mode switcher + status
src/options/                  All settings
scripts/                      Icons, build, Safari conversion
```

How it works, in short:

- **CSS first:** Static rules apply from `document_start` (no flicker). `main.js` only sets attributes like `data-hys-mode="all"` on `<html>`; the CSS reacts to them. Selectors cover old (`ytd-…-renderer`) and new (`…-view-model`) YouTube components, desktop and mobile web.
- **Subs mode = default-deny:** Shorts tiles start hidden. `main.js` extracts the video id from the `/shorts/` link, `subs.js` resolves the channel via the oEmbed endpoint (cached in `storage.local`) and compares it against the subscription list; allowed tiles get `data-hys-allowed` and become visible. The subscriptions feed and pages of subscribed channels pass through entirely.
- **Subscription list:** parsed from `/feed/channels` (signed-in session) including continuation pages; refreshed after the cache lifetime expires or via the popup button.
- **Login detection:** presence of the `SAPISID` cookie (not HttpOnly, only exists while signed in).

## Known limitations / maintenance

- YouTube changes its DOM regularly and rolls out variants via A/B tests. If something slips through, the selectors in `src/content/hide-shorts.css` need to be extended. Good reference: [gijsdev/ublock-hide-yt-shorts](https://github.com/gijsdev/ublock-hide-yt-shorts).
- The subscription list parser (`ytInitialData` / `channelRenderer`) relies on undocumented YouTube internals and may break. Fallback: the whitelist in the settings; in doubt, subs mode behaves like “Hide all” (default-deny).
- oEmbed lookups are limited to 4 parallel requests and cached persistently (max. 5000 videos); on the very first scroll in subs mode, allowed Shorts therefore appear with a short delay.
- Firefox MV3 shows host permissions in the install dialog; they must be granted, otherwise the content script will not run.

## Contributing

Contributions are welcome – especially selector fixes when YouTube changes its DOM. Please read [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup, project rules and how to report bugs effectively. Releases are documented in the [CHANGELOG](CHANGELOG.md).

Questions or problems that don't fit an issue? Contact: **support@digitmedia.de** (security reports: see [SECURITY.md](SECURITY.md)).

## Privacy

Shortless stores all settings and caches locally in your browser (`storage.sync`/`storage.local`), talks only to youtube.com (subscription list, oEmbed channel lookup) and sends no data anywhere else. No analytics, no tracking, no external services.

## License

[MIT](LICENSE)

*Shortless is an independent open-source project and is not affiliated with or endorsed by YouTube or Google. YouTube is a trademark of Google LLC.*
