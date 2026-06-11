# Contributing to Shortless

Thanks for your interest in contributing! Shortless is intentionally small and dependency-free – please keep it that way.

## Development setup

No dependencies to install. You only need Node.js ≥ 18 (for the build scripts) and a browser.

```sh
npm run icons   # generate icons/ (only needed once)
npm run build   # creates dist/chrome, dist/firefox, dist/safari + ZIPs
npm run check   # syntax-check all JS files
```

Load the extension from `dist/chrome` (chrome://extensions → "Load unpacked") or `dist/firefox` (about:debugging → "Load Temporary Add-on"). See the README for Safari.

## Project layout

See the [Architecture section in the README](README.md#architecture). The most important rule: **all hiding is done in CSS** (`src/content/hide-shorts.css`), toggled via `data-hys-*` attributes that `src/content/main.js` sets on `<html>`. JavaScript never hides elements directly.

## Fixing broken selectors

YouTube changes its DOM regularly and rolls out variants via A/B tests. If Shorts slip through:

1. Inspect the leaking element and find its component tag (e.g. `ytd-…-renderer` or `…-view-model`).
2. Add a selector to the matching block in `src/content/hide-shorts.css` (mode "all", mode "subs" **and**, if it is a container, the empty-shelf block).
3. Prefer structural anchors (`a[href^="/shorts/"]`, `[is-shorts]`, `[overlay-style="SHORTS"]`) over localized text like `title="Shorts"`.
4. Never filter `/feed/history`.

[gijsdev/ublock-hide-yt-shorts](https://github.com/gijsdev/ublock-hide-yt-shorts) is a good reference for current selectors.

## Pull requests

- Keep PRs focused; one fix or feature per PR.
- Run `npm run check` and `npm run build` before pushing – CI runs the same.
- No new runtime dependencies, no build frameworks. Plain JS, plain CSS.
- Test at least in Chrome and Firefox, signed in and signed out, and mention what you tested in the PR description.

## Reporting bugs

Please use the bug report template and include:

- The page where it happens (home, search, channel, watch, m.youtube.com …)
- The mode you are in (off / hide all / subscriptions only)
- Browser and version
- If possible, the outer HTML of the element that slipped through
