# Helium GAF Debug mode

Two Helium profiles, deliberately separate:

| Profile | Path | Purpose |
|---------|------|---------|
| **Daily (Windows)** | `%LOCALAPPDATA%\imput\Helium\User Data` | Normal browsing, privacy, bookmarks |
| **GAF Debug (Windows)** | `%LOCALAPPDATA%\Helium-GAF-Debug\User Data` | Extension QA, full CDP, automation |
| **Daily (Linux)** | Typical config dir such as `~/.config/net.imput.Helium` — do not pass this to `--user-data-dir` | Normal browsing |
| **GAF Debug (Linux)** | `${XDG_DATA_HOME:-~/.local/share}/Helium-GAF-Debug/User Data` | Extension QA, full CDP, automation |

No need to fork [imputnet/helium](https://github.com/imputnet/helium) for this. A second `user-data-dir` + classic Chromium remote-debugging flags is enough.

## Why not the in-browser “Allow remote debugging” toggle?

Helium’s `helium://inspect/#remote-debugging` can show “Server running at 127.0.0.1:9222” while still returning **HTTP 404** for `/json/version` and `/json/list`. Tools like **browser-use** need the real DevTools HTTP API.

This launcher uses:

```text
--remote-debugging-port=9333
--user-data-dir=…/Helium-GAF-Debug/User Data
--load-extension=<your-gaf-folder>
```

Port **9333** avoids clashing with daily Helium’s 9222 listener. Neither launcher adds `--remote-allow-origins=*`.

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

### Linux / Ubuntu

Sketch of the same CDP flags as the PowerShell launcher. This path has not been live-verified against Ubuntu Helium.

```bash
cd <your-gaf-folder>/scripts
./helium-gaf-debug.sh
```

The script looks for Helium (then Chromium) under `~/.local`, `/opt`, and `PATH`. Override with `HELIUM_EXE`. The debug `user-data-dir` is always `Helium-GAF-Debug` — never the daily Helium profile.

Useful flags:

```bash
./helium-gaf-debug.sh --url "https://www.spiked-online.com/"
./helium-gaf-debug.sh --kill-existing          # restart debug instance
./helium-gaf-debug.sh --probe-only             # check CDP only; exits 1 if not responding
./helium-gaf-debug.sh --port 9334              # alternate port
./helium-gaf-debug.sh --no-extension           # no auto --load-extension
```

On a Chromium fallback, pass `--url chrome://extensions` if `helium://extensions` is not handled.

## Connect browser-use

After CDP prints **READY**:

```powershell
$env:PATH = "$env:USERPROFILE\.local\bin;$env:PATH"
$env:BU_CDP_URL = "http://127.0.0.1:9333"
# or:  . "$env:LOCALAPPDATA\Helium-GAF-Debug\set-cdp-env.ps1"
browser-use --doctor
```

Linux / Ubuntu (after CDP prints **READY**):

```bash
export PATH="$HOME/.local/bin:$PATH"
export BU_CDP_URL="http://127.0.0.1:9333"
# or:  . "${XDG_DATA_HOME:-$HOME/.local/share}/Helium-GAF-Debug/set-cdp-env.sh"
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

**Check for updates** / **Update** from the GAF popup downloads new files into that same unpacked folder (you may pick the folder once so the download can land there). Then click **Reload** on the GAF card in `helium://extensions`. Do not Load unpacked again. Daily Helium still needs its own Reload if that window was already running.

Daily Helium keeps its own extension list; reload GAF there separately when you want it for normal browsing.

## Safety notes

- The launchers keep the default DevTools WebSocket origin restriction. If an automation client reports an origin rejection, identify that client's exact Origin and allow only that value; do not use a wildcard. Windows scripts have not been live-tested on Helium for v0.2.29. The Ubuntu `helium-gaf-debug.sh` is a path/flag sketch and has not been live-verified against Ubuntu Helium.

- Debug profile has **full automation access** (CDP can read cookies, drive tabs). Only connect trusted tools (`BU_CDP_URL` localhost).
- Do **not** set `user-data-dir` to your daily profile while CDP is on.
- You can run **both** profiles at once (two windows, two data dirs).
- Wiping debug state: quit debug Helium, then delete `%LOCALAPPDATA%\Helium-GAF-Debug` (Windows) or `${XDG_DATA_HOME:-~/.local/share}/Helium-GAF-Debug` (Linux).

## When a Helium fork would make sense

Only if you need browser-level patches (e.g. always-on CDP in the main UI, policy defaults for unpacked extensions). For GAF QA, a dedicated profile is simpler than maintaining a fork of [imputnet/helium](https://github.com/imputnet/helium).

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Port in use | `-Port 9334` or `-KillExisting` |
| CDP 404 on 9222 | That’s daily Helium’s inspect toggle — use this launcher (9333) |
| GAF not loaded | Load unpacked; check path to `manifest.json` |
| browser-use still fails | Confirm `BU_CDP_URL=http://127.0.0.1:9333` and `.\helium-gaf-debug.ps1 -ProbeOnly` (Linux: `./helium-gaf-debug.sh --probe-only`) |
| `--probe-only` exits 1 | CDP is not responding on that port (expected when debug Helium is not running) |
| Helium not found (Linux) | Install Helium, place it under `~/.local` / `/opt` / `PATH`, or set `HELIUM_EXE` |

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

Historical behaviour: earlier GAF versions clicked “Godta valgte”. Since v0.2.28, ambiguous selected consent is left to the user; only explicit rejection / necessary-only choices are automated.
