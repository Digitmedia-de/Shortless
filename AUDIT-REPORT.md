# 🔍 Project Audit Report

**Project**: Digitmedia-de/Shortless
**Date**: 2026-06-11
**Analyzed files**: 31 (source, scripts, docs — dist/ excluded)
**Detected language(s)**: JavaScript (vanilla, MV3 WebExtension), CSS, Node.js build scripts

---

## Executive Summary

Shortless is in very good shape for a young project: no secrets, no unsafe DOM handling, a strict zero-dependency policy that holds up under inspection, accurate documentation and a green CI. The audit found **no critical or high findings**. The main gaps are operational maturity items — hardening the privileged fetch proxy, one error-handling bug in the popup status path, missing tests for the fragile parsing logic, and a missing release workflow.

| Severity | Findings | Created Issues |
|----------|----------|----------------|
| 🔴 Critical | 0 | 0 |
| 🟠 High | 0 | 0 |
| 🟡 Medium | 4 | 4 |
| 🟢 Low | 6 | 6 |
| **Total** | **10** | **10** |

Several agent reports were rejected as false positives during consolidation (claimed missing try/catch blocks that exist; `storage.sync.get(defaults)` default-filling misunderstood; MV3 message-handler findings downgraded because `runtime.onMessage` cannot receive messages from foreign extensions or websites).

---

## 🟡 Medium Findings

### 1. Harden background fetch proxy
- **Category**: SECURITY / validation
- **File**: `src/background/worker.js` (lines 15–29)
- **Issue**: [#1](https://github.com/Digitmedia-de/Shortless/issues/1)
- **Problem**: `msg.init` is passed unvalidated into `fetch()`; raw exception strings are returned; no sender check. Defense-in-depth at the extension's privileged boundary.
- **Recommendation**: Allowlist init properties (method, credentials, headers, body), generic error strings, sender check.

### 2. `hys-status` handler lacks `.catch` — popup can hang
- **Category**: BUG / error-handling
- **File**: `src/content/main.js` (lines 141–148)
- **Issue**: [#2](https://github.com/Digitmedia-de/Shortless/issues/2)
- **Problem**: If `hysSubs.status()` rejects, `sendResponse` is never called.
- **Recommendation**: Add `.catch((e) => sendResponse({ error: String(e) }))`.

### 3. No test infrastructure
- **Category**: STRUCTURE / tests
- **File**: Project root
- **Issue**: [#3](https://github.com/Digitmedia-de/Shortless/issues/3)
- **Problem**: Zero tests; the most fragile logic (parsing, regexes, manifest transforms) is only verified manually.
- **Recommendation**: Minimal `node:test` suite (no new dependencies), wired into CI.

### 4. No release workflow
- **Category**: STRUCTURE / config
- **File**: `.github/workflows/`
- **Issue**: [#4](https://github.com/Digitmedia-de/Shortless/issues/4)
- **Problem**: Tags exist but produce no GitHub releases with ZIP assets.
- **Recommendation**: `release.yml` on `v*` tag push attaching `dist/*.zip`.

---

## 🟢 Low Findings

### 5. Sender validation in content-script message handler — [#5](https://github.com/Digitmedia-de/Shortless/issues/5)
Defense-in-depth: early-return unless `sender.id === api.runtime.id` (`src/content/main.js`).

### 6. `hysSubs.ensureFresh` exported but only used internally — [#6](https://github.com/Digitmedia-de/Shortless/issues/6)
Remove from public API or document as cache pre-warm hook (`src/content/subs.js`).

### 7. Add `.editorconfig` — [#7](https://github.com/Digitmedia-de/Shortless/issues/7)

### 8. Add `CODE_OF_CONDUCT.md` — [#8](https://github.com/Digitmedia-de/Shortless/issues/8)

### 9. Add `engines` field to `package.json` — [#9](https://github.com/Digitmedia-de/Shortless/issues/9)
README requires Node ≥ 18; npm should enforce it.

### 10. Add `web-ext lint` to CI — [#10](https://github.com/Digitmedia-de/Shortless/issues/10)
Would have caught the AMO `data_collection_permissions` / `strict_min_version` issues before upload.

---

## ✅ Positive Observations

- No hardcoded secrets; the InnerTube API key is correctly extracted at runtime.
- No unsafe DOM sinks — user-/network-controlled data is rendered exclusively via `textContent`.
- The fetch proxy's URL allowlist (`www`/`m.youtube.com` over HTTPS) is correct.
- Zero runtime and zero dev dependencies — verified, not just claimed.
- All manifest paths (icons, scripts, pages) exist; all HTML ids and CSS classes are used.
- README and CONTRIBUTING match the actual scripts and file layout exactly; versions in `manifest.json` and `package.json` are in sync (0.1.1).
- Well-designed issue forms (mode, page, signed-in state, outerHTML) tailored to selector-breakage reports.
- CI covers check + icons + build for all three browsers with artifact upload; first run green in 17 s.
- Repository is clean: 0 open issues before the audit, 0 TODO/FIXME markers, no junk files, no oversized files (largest: 311 lines).

---

## 📊 Metrics

| Metric | Value |
|--------|-------|
| Project size | 31 files |
| JS source files | 8 |
| Test files | 0 |
| Test ratio | 0% |
| Open issues (before audit) | 0 |
| Stale issues | 0 |
| TODO/FIXME in code | 0 |
| Runtime dependencies | 0 |
| Outdated dependencies | 0 |

---

## 🎯 Quick Wins

1. **#2** — one `.catch()` line fixes the popup-hang path (5 minutes).
2. **#9** — one `engines` line in package.json (2 minutes).
3. **#10** — one CI step that prevents the next AMO upload surprise (10 minutes).

---

## Created Issues

| # | Title | Severity | Category |
|---|-------|----------|----------|
| 1 | Harden background fetch proxy | medium | security |
| 2 | hys-status handler lacks .catch | medium | bug |
| 3 | No test infrastructure | medium | structure |
| 4 | No release workflow | medium | structure |
| 5 | Sender validation in content-script handler | low | security |
| 6 | ensureFresh exported but internal-only | low | hygiene |
| 7 | Add .editorconfig | low | structure |
| 8 | Add CODE_OF_CONDUCT.md | low | structure |
| 9 | Add engines field to package.json | low | structure |
| 10 | Add web-ext lint to CI | low | structure |

---

<sub>Created by audit-project skill on 2026-06-11</sub>
