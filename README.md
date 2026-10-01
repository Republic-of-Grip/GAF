# GAF — General Annoyance Filter

**Personal web filter for Chromium-family browsers** (Chrome, Edge, Brave, Helium, Chromium on Windows, Linux/Ubuntu, macOS).

Take back control of noisy pages: autoplay thumbnails, looping GIFs, decorative motion, soft paywalls, and other annoyances. Built in the spirit of tools like F.B. Purity and Social Fixer — **on by default**, with exclusions as a **review backlog** when a site breaks.

> Not a universal paywall cracker. GAF bends timers, freezes motion, and hides chrome that already arrived in the browser — the same arms race as ad/tracker blocking.

## Features (v0.2.35)

| Feature | Default | What it does |
|--------|---------|----------------|
| Freeze GIFs | On | Canvas still frames (skips lazy-load spacers) |
| Video autoplay policy | **Heuristic** | Broader muted/loop/autoplay freeze; full-bleed heroes stay visible (paused, sources kept). A player’s play control can start that clip (Mixkit and similar) |
| **Videos start on** | **Click** | Videos start only when you click them or their play button (or with *Hover or click*, when the pointer rests on them). Stops feeds such as X starting videos as you scroll |
| CSS motion | Moderate | Early inject at `document_start` |
| Scripted motion pause | On | Infinite WAAPI / SVG / Lottie loops only |
| **Time freeze** | **Slow** (soft-wall hosts) | Stretches long page timers for soft paywalls |
| Time freeze Stop | Optional | Heavy timer stretch + **reading snapshot** overlay |
| **Meter reset** | **Auto** | Disarm free-article gates; auto wipe is meter-named cookies only, with corroborating wall evidence |
| Element hiding | On | Built-in soft-paywall / regwall selectors + your rules |
| Custom CSS per host | On (empty map) | Options → Advanced |
| **Pause on this tab** | — | Popup button: stop filtering in one tab only, until you resume or close it |
| Exclusion backlog | — | Exclude site → review / resolve later |
| **Leave this element alone** | — | Right-click an object: GAF stops freezing / pausing it on that site (the reverse of uBlock's *Block element*) |
| Inspection archive | — | Right-click: save object + escape hints → promote to hide rule |
| Import / export | — | Filter pack JSON |

Muted autoplay still starts paused, including a stock-video page such as Mixkit. The play control on that player (a button beside the video, or a click on the video) starts the clip and GAF leaves it playing. Hover-preview grids stay frozen. Full-bleed heroes stay visible and paused, with their sources kept.

### Videos start on: Click / Hover or click / Site decides

Feeds such as X start videos from their own script as each post scrolls into view; the videos carry no `autoplay` attribute, so the autoplay policy above never saw them. **Videos start on** stops that at the source: a page's request to start a video is refused exactly the way the browser's own autoplay block refuses it, and the site shows its normal play button.

- **Click** (default): a video plays when you click it, its play overlay or a play button beside it, or focus it and press Space / Enter / K. Once you started a video it may keep playing (buffering, scrolling back).
- **Hover or click**: also plays a video when the pointer rests on it for about half a second without scrolling; moving the pointer away pauses it again. Scrolling past videos does not start them.
- **Site decides**: no extra blocking.

Not applied on dedicated video sites (YouTube, Vimeo, Twitch, Netflix and the like), to live camera / video-call streams, to audio, in popup windows or payment / eID pages, when the site is excluded or the tab is paused, or when *Video autoplay policy* is Off. *Leave this element alone* rules also let a video play. Choose the mode in the popup or in Options → Video.

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

**Automatic by default:** multi-pass **disarm** on soft-wall hosts. If the body remains unreadable and wall evidence is sufficient (a specific gate selector, or a generic selector plus meter text), GAF may clear meter-named cookies and reload once per tab/article path per browser session. Automatic mode never clears page storage or durable data. The retry record lives in extension session storage and survives page reloads. Resets stop when GAF is off, the site is excluded, or the tab navigates away. Popup reset remains a manual action using the selected deletion options.

Built-in soft-wall hosts include `spiked-online.com` and the usual newspaper list.

**Interaction guard** (auto + popup **Thaw**):

| Situation | GAF action |
|-----------|------------|
| **Page-locking cookie wall** (body `noscroll` / full grey scrim + accept buttons) | Clicks only explicit **Reject all** / **Necessary only** choices in consent panels. **Accept selected** and **Accept all** remain for the user |
| **Orphan grey dimmer** (Hyvä `.backdrop`, filter scrim, auth overlay mid-transition) | Hides dimmer + unlocks body (`noscroll`, `phantom-scroll-bar`, `overflow-hidden`) |
| Login / cart / filter panel with real UI | Left alone |
| **X.com / Twitter compose & reply** | Tool-SPA host — unstick + CSS motion skipped so the mask is not treated as a cookie grey (clicks no longer fall through to the timeline). GIF freeze still runs on the feed. |
| **X.com photo / status lightbox** | Media inside dialogs is not source-stripped (avoids stacked/garbled conversation column). Toggling GAF **off** now restores unstick hides without a full page reload. |
| **Checkout, 3-D Secure, eID, captcha** | A full-viewport layer that hosts a visible iframe is never treated as an empty grey: cross-origin frames have no readable text, so GAF cannot tell a card-verification window from an ad scrim and leaves it alone. Pages with a password, one-time-code or card field, and popup windows (verification and sign-in flows), are never unstuck. Orphan-dimmer hiding runs in the top page only, and timer stretch never runs in frames or popups. Known payment, 3-D Secure, eID and captcha provider hosts (Stripe, PayPal, Adyen, Klarna, Vipps, Cardinal, ID-porten, MitID, hCaptcha, Cloudflare Turnstile and others) also skip motion CSS and scripted-motion pause. |

Earlier versions were tested live against Ditur's “Godta valgte” flow. Version 0.2.28 deliberately leaves that ambiguous choice to you; selected categories are not assumed to be necessary-only. No consent cookie or consent event is fabricated by the automatic handlers.

## Pause on this tab

For a one-off step that GAF gets in the way of — a checkout, a bank or 3-D Secure check, a sign-in — use **Pause on this tab** in the popup instead of turning GAF off everywhere.

- Filtering stops in that tab only (all frames in it). Every other tab keeps filtering.
- The pause survives navigation inside the tab, so a checkout that redirects to your bank and back stays paused.
- It ends when you click **Resume on this tab**, close the tab, or restart the browser. Nothing is saved to settings.
- The toolbar shows an orange **II** badge on a paused tab. Resume clears it, so that tab shows the usual ON/OFF badge again.
- If a pause and a resume overlap, the later choice wins. A slower reply cannot turn filtering back on or off. A history change during startup, or a meter re-read that overlaps that choice, cannot leave filtering running or stopped against it.
- As with turning GAF off, reload the page if you need stretched timers or already-replaced page components fully restored.

## Exclusion backlog

When GAF breaks a site:

1. Popup → **Exclude site → review backlog**, or context menu **Exclude site**
2. Filtering stops for that host; reload the page for a full recovery
3. Open **Options → Exclusion backlog**
4. Add notes, mark *reviewing* / *resolved*, or remove to filter again

Resolved entries stop excluding; they remain as history until removed.

### Turning filtering off

OFF/exclusion cancels queued meter actions and restores tracked meter styles, media, and scripted animations. Reload the page to fully restore existing stretched timers, replaced custom elements, and page-managed state. Completed cookie/storage deletion and consent choices cannot be undone by the switch. A deletion already in flight may complete; current policy is checked again before each subsequent action.

## Leave this element alone

The reverse of uBlock Origin's *Block element*: when GAF freezes something you actually want moving — a GIF, a looping video, an animation — right-click it → **GAF: Leave this element alone (remember on this site)**.

- That element (and everything inside it) plays and animates normally. The rest of the page stays filtered.
- The choice is remembered for the site and applies on every visit. The toolbar flashes **OK** when a rule is saved.
- Right-clicking a frozen GIF works: the rule points at the real image behind GAF's still frame.
- Manage the rules in **Options → Element hiding → Left alone**, one per line in uBlock's exception syntax, e.g. `example.com#@#figure.hero > img`. Delete a line to have GAF filter that element again.
- Rules are CSS selectors built from the element's position and classes. Ids and classes are escaped like `CSS.escape`, including ones that start with a digit (`#123` is not a valid selector). Sites that rename their classes on redesigns can break a rule; add it again from the right-click menu.

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

Reload the extension after upgrades (0.1 → 0.2). **0.2.35** adds **Videos start on: Click** (default) / **Hover or click** / **Site decides** — feeds like X no longer start videos as you scroll. **0.2.34** restores the ON/OFF toolbar badge when a paused tab is resumed, keeps automatic meter resets off on a paused tab, ignores an older pause reply when a newer pause or resume is already in flight (including when a history change or meter re-read overlaps that choice), and fixes **Leave this element alone** when the element or an ancestor has an id or class that starts with a digit. **0.2.33** adds right-click **Leave this element alone**. **0.2.32** adds **Pause on this tab**. **0.2.31** stops the interaction guard from hiding checkout / 3-D Secure / captcha overlays. **0.2.30** ships the Mixkit play-control thaw (muted autoplay stays paused until you hit play). **0.2.29+:** **Check for updates** finds a newer GitHub version; **Update** downloads it into the GAF folder Helium already loaded. Then open `helium://extensions` / `chrome://extensions` and click **Reload** on the GAF card. Do **not** Load unpacked again. The first download may ask you to point at that existing folder so files can land there.

## Updates

GAF is an **unpacked** install (`Load unpacked` or Helium `--load-extension`). Chromium has no silent self-update for that, and Windows will not sideload a self-hosted CRX via `update_url`.

| Step | What happens |
|------|----------------|
| **Check for updates** | Reads GitHub releases/tags/`manifest.json`. |
| **Update** | Downloads the GitHub source zip into the existing GAF folder (first time: pick that same folder so the files can be written). |
| **Extensions → Reload** | The one remaining step. On the GAF card click **Reload** (developer mode). Helium/Chrome may also show an **Update** control on that page — use the GAF card **Reload** so unpacked files on disk are picked up. Do not Load unpacked again. |
| **Download zip only** | Fallback: extract the zip **over** the existing GAF folder, then the same Reload. Still not a new Load unpacked. |

If daily Helium and Helium GAF Debug both use the same folder, Reload (or restart debug) in each profile that is already running.

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
      video-start-main.js   # MAIN world: videos start on click / hover
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
      tab-pause.mjs         # per-tab pause (session storage, ends when the tab closes)
      element-allow.mjs     # "Leave this element alone" rules (site#@#selector)
    popup/
    options/
    update/               # download GitHub zip into the existing unpacked folder
  tests/
```

## Privacy

Settings are stored locally and mirrored, best-effort, to `chrome.storage.sync`. On browsers with account sync enabled, that mirror may be uploaded and shared across your synced browsers. Local settings remain authoritative; sync is also used as a legacy fallback when local settings are missing.

The exclusion backlog and inspection archive stay in `chrome.storage.local`. Automatic reset retry records and per-tab pauses (tab id plus the page URL at the time you paused) stay in `chrome.storage.session`, which the browser clears on restart. Archive entries can contain page URLs, titles and HTML; exported filter packs include exclusion URLs and notes, and your settings, including *Leave this element alone* rules (site names and element selectors), which are also part of the settings sync mirror. Review these before sharing them or attaching them to public issues.

No analytics or remotely downloaded filter rules. **Check for updates** contacts GitHub for version metadata. **Update** downloads the published GAF source ZIP from GitHub into your existing unpacked folder. Applying it is the Extensions-page **Reload** on the GAF card. That is user-initiated extension code from this repository, not remote filter rules.

## Roadmap

- Richer paywall heuristics / site packs  
- Element-hide rule builder from archived objects  
- Feed / social noise packs  
- Optional declarativeNetRequest for known thumbnail CDNs  

## Contributing

Issues and pull requests are welcome later. There is no formal process yet.

## License

Personal / local use freely. Keep attribution if you redistribute. MIT license in `LICENSE`.
