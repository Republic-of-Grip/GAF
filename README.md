# GAF — General Annoyance Filter

**Personal web filter for Chromium-family browsers** (Chrome, Edge, Brave, Helium, Chromium on Windows, Linux/Ubuntu, macOS).

Take back control of noisy pages: autoplay thumbnails, looping GIFs, decorative motion, soft paywalls, and other annoyances. Built in the spirit of tools like F.B. Purity and Social Fixer — **on by default**, with exclusions as a **review backlog** when a site breaks.

> Not a universal paywall cracker. GAF bends timers, freezes motion, and hides chrome that already arrived in the browser — the same arms race as ad/tracker blocking.

## Features (v0.2.26)

| Feature | Default | What it does |
|--------|---------|----------------|
| Freeze GIFs | On | Canvas still frames (skips lazy-load spacers) |
| Video autoplay policy | **Heuristic** | Broader muted/loop/autoplay freeze; full-bleed heroes stay visible (paused, sources kept) |
| CSS motion | Moderate | Early inject at `document_start` |
| Scripted motion pause | On | Infinite WAAPI / SVG / Lottie loops only |
| **Time freeze** | **Slow** (soft-wall hosts) | Stretches long page timers for soft paywalls |
| Time freeze Stop | Optional | Heavy timer stretch + **reading snapshot** overlay |
| **Meter reset** | **Auto** | Disarm free-article gates; auto wipe is meter-named cookies only, after two wall signals |
| Element hiding | On | Built-in soft-paywall / regwall selectors + your rules |
| Custom CSS per host | On (empty map) | Options → Advanced |
| Exclusion backlog | — | Exclude site → review / resolve later |
| Inspection archive | — | Right-click: save object + escape hints → promote to hide rule |
| Import / export | — | Filter pack JSON |

## Soft paywalls (“slow / stop time”)

Sites like **The Telegraph** often show the article briefly, then a timer or script applies a wall.

- **Slow (default):** multiplies `setTimeout` / `setInterval` delays in the **page** (MAIN world). A 5s meter at factor 80 becomes minutes — enough for Reader Mode or Save as PDF.
- **Stop + snapshot:** even longer timer stretch, and GAF can capture a **reading snapshot** of the page (clone in an overlay). When the live DOM is ruined by the wall, you still have the snapshot. Click a link or **Thaw** to return to the live page.

Also available:

- Context menu → **GAF: Freeze reading snapshot now**
- Context menu → **GAF: Thaw page**
- Popup buttons for the same

Built-in soft-wall host hints include Telegraph, NYT, FT, WSJ, and others. Timer slow applies on those hosts when scope is **softwall** (default), or on all sites when scope is **all** — unless the site is excluded.

**Path-aware skip:** game / puzzle routes (`/games/`, `/puzzles/`, Wordle, Connections, crossword, etc., plus `games.*` hosts) never get timer stretch. Those apps use multi-second timeouts for UX (toasts, win modals); stretching them freezes the puzzle for minutes after a win.

## Free-article meters (cookies)

Some sites give N free reads/month, then ask you to register. If **Incognito still works**, the counter is almost always a **cookie** (sometimes `localStorage`) — not a crypto gate.

**Reset free-article meter** (popup button or right-click → *GAF: Reset free-article meter*):

1. **Disarm gate chrome** in the page when the article body is already in the HTML  
   (Spiked ships the full story and only flips `.gated-content-wrap.paywall.active` + a fade — cookie wipe alone was not enough)
2. Clears cookies for that site (all, or only meter-like names)
3. Optionally clears `localStorage` / `sessionStorage` / Cache / IndexedDB
4. Reloads only if the body still looks empty after disarm

Same spirit as “open in Incognito,” without a second window. You may need to log in again if you had a membership session on that host.

**Automatic by default:** multi-pass **disarm** on soft-wall hosts, plus **cookie wipe + reload** once if the body is still empty after disarm (mode **auto**). Popup button remains for a forced wipe anytime.

Built-in soft-wall hosts include `spiked-online.com` and the usual newspaper list.

**Interaction guard** (auto + popup **Thaw**):

| Situation | GAF action |
|-----------|------------|
| **Page-locking cookie wall** (body `noscroll` / full grey scrim + accept buttons) | Clicks least-privilege accept — e.g. ditur.no **Godta valgte** (necessary only) before **Godta alle** — then unlocks scroll |
| **Orphan grey dimmer** (Hyvä `.backdrop`, filter scrim, auth overlay mid-transition) | Hides dimmer + unlocks body (`noscroll`, `phantom-scroll-bar`, `overflow-hidden`) |
| Login / cart / filter panel with real UI | Left alone |
| **X.com / Twitter compose & reply** | Tool-SPA host — unstick + CSS motion skipped so the mask is not treated as a cookie grey (clicks no longer fall through to the timeline). GIF freeze still runs on the feed. |
| **X.com photo / status lightbox** | Media inside dialogs is not source-stripped (avoids stacked/garbled conversation column). Toggling GAF **off** now restores unstick hides without a full page reload. |
| **BankID / Morrow payment auth** | First-party 3DS / BankID windows and iframes are left alone so card verification can open. Ads and unrelated popups stay blocked. |

Verified live on **ditur.no** Orient Bambino PLP (Helium GAF Debug): cookie stack uses `bg-gray-500/75` + “Vi tilpasser opplevelsen din”; accepting uncovers 30+ products underneath.

## Exclusion backlog

When GAF breaks a site:

1. Popup → **Exclude site → review backlog**, or context menu **Exclude site**
2. Filtering stops for that host
3. Open **Options → Exclusion backlog**
4. Add notes, mark *reviewing* / *resolved*, or remove to filter again

Resolved entries stop excluding; they remain as history until removed.

## Inspection archive

1. Right-click an annoying/escaping object  
2. **GAF: Save object for inspection**  
3. Options → **Inspection archive**  

Each entry stores:

- Page URL & title  
- Tag, selector path, classes, outer HTML sample  
- **Escape hints** (e.g. cross-origin GIF, video policy, iframe, shadow DOM, CSS background GIF)

## Install (Windows / Ubuntu / any Chromium)

1. Folder with `manifest.json`, e.g. `~/Extensions/gaf`
2. `chrome://extensions` (or `helium://extensions`) → Developer mode → **Load unpacked**
3. Pin GAF; open Options for backlog & archive

Reload the extension after upgrades (0.1 → 0.2).

### Helium GAF Debug mode (recommended for automation)

Separate Helium profile with **full CDP** for browser-use / extension QA — daily browsing stays on your normal profile.

```powershell
cd <your-gaf-folder>/scripts
./helium-gaf-debug.ps1
# optional desktop icon:
./create-desktop-shortcut.ps1
```

See [docs/HELIUM-DEBUG.md](docs/HELIUM-DEBUG.md).

## Develop

```bash
cd gaf
npm test
npm run icons
```

Node 18+ for tests only. No bundler required.

## Project layout

```text
gaf/
  manifest.json
  src/
    background/service-worker.js
    content/
      time-freeze-main.js   # MAIN world timer stretch
      early.js              # document_start CSS / hide / config
      main.js               # media, snapshot, archive hook
    core/
      settings.mjs
      exclusions.mjs
      archive.mjs
      freeze-media.mjs
      css-motion.mjs
      scripted-motion.mjs
      element-hide.mjs
      site-css.mjs
      time-freeze.mjs
      storage.mjs
    popup/
    options/
  tests/
```

## Privacy

Everything is local (`chrome.storage.sync` for settings, `local` for backlog & archive). No analytics, no remote rules.

## Roadmap

- Richer paywall heuristics / site packs  
- Element-hide rule builder from archived objects  
- Feed / social noise packs  
- Optional declarativeNetRequest for known thumbnail CDNs  

## Contributing

Issues and pull requests are welcome later. There is no formal process yet.

## License

Personal / local use freely. Keep attribution if you redistribute. MIT license in `LICENSE`.
