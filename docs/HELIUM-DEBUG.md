# Helium GAF Debug mode

Two Helium profiles, deliberately separate:

| Profile | Path | Purpose |
|---------|------|---------|
| **Daily** | `%LOCALAPPDATA%\imput\Helium\User Data` | Normal browsing, privacy, bookmarks |
| **GAF Debug** | `%LOCALAPPDATA%\Helium-GAF-Debug\User Data` | Extension QA, full CDP, automation |

No need to fork [imputnet/helium](https://github.com/imputnet/helium) for this. A second `user-data-dir` + classic Chromium remote-debugging flags is enough.

## Why not the in-browser “Allow remote debugging” toggle?

Helium’s `helium://inspect/#remote-debugging` can show “Server running at 127.0.0.1:9222” while still returning **HTTP 404** for `/json/version` and `/json/list`. Tools like **browser-use** need the real DevTools HTTP API.

This launcher uses:

```text
--remote-debugging-port=9333
--remote-allow-origins=*
--user-data-dir=…\Helium-GAF-Debug\User Data
--load-extension=<your-gaf-folder>
```

Port **9333** avoids clashing with daily Helium’s 9222 listener.

## Launch

From a terminal:

```powershell
cd <your-gaf-folder>/scripts
./helium-gaf-debug.ps1
```

Or double-click:

```text
helium-gaf-debug.cmd
```

Optional desktop shortcut:

```powershell
.\create-desktop-shortcut.ps1
```

Useful flags:

```powershell
.\helium-gaf-debug.ps1 -Url "https://www.spiked-online.com/"
.\helium-gaf-debug.ps1 -KillExisting          # restart debug instance
.\helium-gaf-debug.ps1 -ProbeOnly             # check CDP only
.\helium-gaf-debug.ps1 -Port 9334             # alternate port
.\helium-gaf-debug.ps1 -NoExtension           # no auto --load-extension
```

## Connect browser-use

After CDP prints **READY**:

```powershell
$env:PATH = "$env:USERPROFILE\.local\bin;$env:PATH"
$env:BU_CDP_URL = "http://127.0.0.1:9333"
# or:  . "$env:LOCALAPPDATA\Helium-GAF-Debug\set-cdp-env.ps1"
browser-use --doctor
```

Expect `/json/version` to return JSON with `webSocketDebuggerUrl` — not 404.

Example session:

```powershell
@'
ensure_real_tab()
new_tab("https://www.spiked-online.com/2026/07/18/the-anne-widdecombe-investigation-has-been-embarrassing-for-the-police/")
wait_for_load()
print(page_info())
print(js("!!document.querySelector('.gated-content-wrap.paywall')"))
print(js("document.querySelector('[data-gaf-meter-disarmed]')?.tagName || 'none'"))
'@ | browser-use
```

## GAF on first run

The launcher passes `--load-extension` for the GAF folder next to `scripts/`.

If GAF is missing from `helium://extensions`:

1. Enable **Developer mode**
2. **Load unpacked** → the folder that contains `manifest.json`
3. Reload after code changes (or restart this debug Helium)

Daily Helium keeps its own extension list; reload GAF there separately when you want it for normal browsing.

## Safety notes

- Debug profile has **full automation access** (CDP can read cookies, drive tabs). Only connect trusted tools (`BU_CDP_URL` localhost).
- Do **not** set `user-data-dir` to your daily profile while CDP is on.
- You can run **both** profiles at once (two windows, two data dirs).
- Wiping debug state: quit debug Helium, delete `%LOCALAPPDATA%\Helium-GAF-Debug`.

## When a Helium fork would make sense

Only if you need browser-level patches (e.g. always-on CDP in the main UI, policy defaults for unpacked extensions). For GAF QA, a dedicated profile is simpler than maintaining a fork of [imputnet/helium](https://github.com/imputnet/helium).

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Port in use | `-Port 9334` or `-KillExisting` |
| CDP 404 on 9222 | That’s daily Helium’s inspect toggle — use this launcher (9333) |
| GAF not loaded | Load unpacked; check path to `manifest.json` |
| browser-use still fails | Confirm `BU_CDP_URL=http://127.0.0.1:9333` and `.\helium-gaf-debug.ps1 -ProbeOnly` |

## Case study: ditur.no grey lock (2026-07)

```powershell
.\helium-gaf-debug.ps1 -Url "https://www.ditur.no/merker/orient/bambino"
# then: $env:BU_CDP_URL = "http://127.0.0.1:9333"
```

Live CDP findings that fed **GAF 0.2.8** interaction-guard:

- `body` classes: `noscroll phantom-scroll-bar` → `overflow: hidden`
- Full-viewport dimmer: `fixed inset-0 bg-gray-500/75` (`rgba(107,114,128,0.75)`)
- Dialog: **Vi tilpasser opplevelsen din** / `#cookie-popup`
- Buttons: **Godta valgte** (prefer) / **Godta alle**
- No `cookie_consent` cookie until accept; catalog has products underneath (~34)
- After accept: scroll unlocks, popup gone, PLP interactive

GAF now auto-dismisses that wall (minimal accept) on load passes and via **Thaw**.
