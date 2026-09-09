# GAF Maintainer Response — External Code Assessment

**To:** Sol (external auditor)  
**From:** GAF maintainer  
**Date:** 2026-08-07  
**Codebase version at review:** ~0.2.21  
**Codebase version after consolidation:** **0.2.22**  
**Baseline before changes:** 89/89 unit tests passing  
**After consolidation:** see test run in this response  

**Purpose:** Confirm each finding, state what was changed, what was deferred, and the reasoning.

---

## Overall agreement

We agree with the assessment posture:

- No rewrite is warranted.
- Architecture is coherent; risk is **local fixes outrunning global invariants**.
- The right move is a **consolidation pass** plus explicit invariant testing, then continue iterative site repair.

The six proposed architectural invariants (I–VI) are adopted as maintainer policy.

---

## Finding 1 — Settings source-of-truth inconsistency

| | |
|--|--|
| **Verdict** | Confirmed. Bug, not intentional. |
| **Action** | **Fixed in 0.2.22** |

### What was wrong

`src/content/main.js` `refreshState()` read settings only from `chrome.storage.sync`, while popup, options, service worker, and early scripts used **local-first** (`storage.mjs` / equivalent).

On Helium (and similar), that could desync main filtering from the badge/popup master switch.

### What changed

1. `main.js` now loads settings via `core.loadSettings()` and exclusions via `core.getActiveExclusionHosts()` (same abstraction as popup/SW).
2. `storage.mjs` exports pure `resolveAuthoritativeSettings(local, sync)` so the precedence rule is testable and shared:
   - **local** if present → authoritative  
   - else **sync** (migrate into local)  
   - else defaults  

### Tests added

- `tests/storage.test.mjs` — local wins over conflicting sync; sync fallback; empty-object handling; defaults.

### Not done

- Full cross-layer browser harness asserting popup + SW + early + main against split local/sync values. Unit coverage encodes the precedence rule; live multi-context check remains on the browser-invariant backlog (Finding 5).

---

## Finding 2 — `preview-video` interception vs OFF/exclusion

| | |
|--|--|
| **Verdict** | Confirmed. Optimistic enable + unconditional dead-`define` violated OFF semantics. |
| **Action** | **Fixed in 0.2.22** (with documented CE limits) |

### What was wrong

1. Boot set `killEnabled = true` optimistically before config arrived.  
2. `customElements.define` always substituted `GafDeadPreviewVideo` for name `preview-video`, regardless of effective GAF state. Registration is irreversible for the document.

So a page could permanently lose its real `preview-video` constructor while GAF was OFF or the host was excluded.

### What changed (`preview-video-main.js`)

1. **`killEnabled` starts `false`** — wait for `early.js` `GAF_PREVIEW_VIDEO_CONFIG`.  
2. **Dead class only when `killEnabled` is already true** at define time; otherwise the site’s constructor is registered unchanged.  
3. When kill turns on after a live define, **CSS + neuter loop** remain the recovery path (unchanged effectiveness strategy for VG race).  
4. Comments document: **toggle OFF after a dead define cannot restore the original constructor** (platform CE limit).

### Tests

- Existing freeze-media / preview-video unit tests retained.  
- Full “GAF OFF → original constructor survives” requires a browser document with real `customElements`; deferred to browser-invariant suite (Recommended tests 5–6).

### Not done / accepted trade-off

- First paint on VG with GAF ON may rely more on early isolated-world CSS + neuter if the page defines CE before config posts. That is preferred over permanently breaking OFF/excluded pages.  
- Mid-session OFF after dead define: inert CSS/neuter stop; original CE is not restored (documented).

---

## Finding 3 — Automatic meter reset vs weak heuristic

| | |
|--|--|
| **Verdict** | Confirmed mechanism risk; policy tightened. |
| **Action** | **Fixed in 0.2.22** |

### What was wrong

Auto wipe could run when:

```text
wallDetected OR articleChars < 400
```

Short legitimate articles, partial DOM, or odd layouts could trigger broad origin deletion (cookies, storage, IDB, cache) without positive wall evidence.

### What changed

1. New pure helper `shouldEscalateMeterWipe({ wallDetected, disarmUseful, articleChars })`:
   - if `disarmUseful` → no wipe  
   - **require `wallDetected`** for auto wipe  
   - **short body alone is never enough**  
2. `main.js` auto path uses this helper.  
3. Options copy updated: Auto clears only when a meter wall is positively detected after disarm; popup remains full manual wipe.

### Policy (explicit)

| Mode | Behaviour |
|------|-----------|
| **Automatic** | Multi-pass DOM disarm (as before). Full origin wipe **only** with positive `detectMeterWall`. |
| **Manual** (popup / context menu) | Full wipe still available on demand — unchanged strength. |

### Tests added

- `shouldEscalateMeterWipe` cases: short body no wall → false; wall + failed disarm → true; useful disarm → false.

### Not done

- Narrower automatic cookie set (meter-names only in auto mode) is still a user option, not forced. Further proportionality (auto → meter-names only, manual → all cookies) is a possible follow-up if false positives remain after wall gating.

---

## Finding 4 — Event-listener lifecycle leak

| | |
|--|--|
| **Verdict** | Confirmed for `click` / `contextmenu`. |
| **Action** | **Fixed in 0.2.22** |

### What was wrong

`addMediaEventListeners()` installed anonymous `click` and `contextmenu` handlers; `removeMediaEventListeners()` only removed the stable `mediaEventHandler` for media events. Enable/disable cycles could stack handlers.

### What changed

Stable named handlers:

- `frozenVideoClickHandler`  
- `contextMenuTrackHandler`  

Both are removed in `removeMediaEventListeners()`.

### Tests

- Not unit-tested in isolation (requires document + toggle lifecycle). Logic is mechanical reference equality; covered by code review. Optional browser toggle test remains on the invariant backlog.

---

## Finding 5 — Test coverage shape / browser invariants

| | |
|--|--|
| **Verdict** | Agreed. |
| **Action** | **Partial** — pure invariants added; browser suite not yet |

### What changed

New/extended unit tests for:

- settings authority (`resolveAuthoritativeSettings`)  
- meter wipe proportionality (`shouldEscalateMeterWipe`)  

### What was not done

No automated browser-level suite yet for:

1. GAF OFF ⇒ page as if GAF absent  
2. Excluded host ⇒ same  
3. Settings propagation across layers  
4. Repeated ON/OFF without accumulation  
5–9. VG / X / YouTube / Ditur live regressions  
10. Short non-metered page ⇒ no auto wipe  

Reasoning: keep the consolidation pass focused and ship invariant *logic* under Node tests first. A small Playwright/Helium harness is the next testing investment, not a large unit-test expansion.

---

## Summary table

| Finding | Severity | Status in 0.2.22 | Notes |
|---------|----------|------------------|--------|
| 1 Settings authority | High | **Fixed** | `main.js` → `loadSettings()`; pure resolver + tests |
| 2 preview-video OFF/exclusion | High (narrow) | **Fixed** | No optimistic kill; dead-define only when kill on |
| 3 Meter auto wipe proportionality | Medium–High | **Fixed** | Wall detection required; short body alone insufficient |
| 4 Listener accumulation | Low | **Fixed** | Stable click/contextmenu refs |
| 5 Browser-level invariants | Architectural | **Deferred** | Core rules tested; live multi-layer suite later |

---

## Invariants — adoption status

| # | Invariant | Status |
|---|-----------|--------|
| I | OFF means inert | Strengthened (preview-video); residual CE toggle-OFF limit documented |
| II | Excluded means inert | Same path as I + local-first settings |
| III | One authoritative settings state | Enforced for main content path |
| IV | Automatic actions ∝ evidence | Auto wipe gated on wall detection |
| V | Site fixes must not weaken globals | preview-video define gated on kill |
| VI | Enable/disable idempotent | Listener leak fixed; observers/timers already guarded |

---

## Suggested order vs delivery

Auditor order → delivery:

1. ~~Verify settings inconsistency~~ → **fixed**  
2. ~~Audit preview-video lifecycle~~ → **fixed**  
3. ~~Review meter destructiveness~~ → **fixed** (policy: wall-gated auto wipe)  
4. ~~Fix listener lifecycle~~ → **fixed**  
5. Encode global invariants in browser tests → **partial** (unit-level only)  
6. Continue site-by-site work → **ready to resume**

---

## Test run (post-change)

```text
node --test
ℹ tests 94
ℹ pass 94
ℹ fail 0
```

(+5 vs baseline 89: four storage authority tests + one `shouldEscalateMeterWipe` test.)

---

## Closing

Thank you for the review. The diagnosis matched the tree, prioritization was correct, and “consolidation under invariants” is the path we took—not a rewrite.

We welcome a follow-up pass focused on:

1. Browser-level invariant harness (minimum set 1–10 from the assessment).  
2. Any residual VG first-paint race after non-optimistic kill.  
3. Whether auto wipe should further restrict cookie mode to `meter-names` by default.

— GAF maintainer
