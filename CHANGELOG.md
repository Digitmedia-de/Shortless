# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-06-11

### Added

- Three modes: off, hide all Shorts, allow only Shorts from subscribed channels
- Subscriptions-only mode with default-deny CSS, per-video channel resolution via oEmbed and subscription list parsing from `/feed/channels` (incl. InnerTube continuations)
- Automatic fallback to "hide all" while signed out (SAPISID cookie detection)
- Optional hiding of the Shorts navigation entry and channel-page Shorts tab
- Optional redirect of `/shorts/<id>` to the regular player (`/watch?v=<id>`)
- Channel whitelist and configurable subscription cache lifetime
- Desktop (`www.youtube.com`) and mobile web (`m.youtube.com`) support
- Popup with mode switcher and status; options page with all settings
- Modern UI with icons, toggle switches and dark mode support
- Build pipeline for Chrome, Firefox and Safari (MV3, zero dependencies)

[Unreleased]: https://github.com/Lazybone/Shortless/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Lazybone/Shortless/releases/tag/v0.1.0
