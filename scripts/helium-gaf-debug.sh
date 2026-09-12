#!/usr/bin/env bash
# Launch Helium in GAF Debug mode — separate profile + full Chrome DevTools Protocol (CDP).
#
# Daily Helium stays untouched (default User Data / net.imput.Helium).
# This starts a second instance with:
#   - dedicated user-data-dir under XDG_DATA_HOME/Helium-GAF-Debug
#   - --remote-debugging-port (real /json/version CDP)
#   - --load-extension for unpacked GAF
#
# Flags (spirit of helium-gaf-debug.ps1):
#   --port N            CDP port (default 9333)
#   --url URL           Optional start URL (default helium://extensions)
#   --no-extension      Skip --load-extension
#   --kill-existing     Stop processes using this debug user-data-dir, then relaunch
#   --probe-only        Only check whether CDP responds (exit 1 if not)
#
# Override the browser binary with HELIUM_EXE. Do not pass --remote-allow-origins=*.

set -euo pipefail

PORT=9333
URL='helium://extensions'
NO_EXTENSION=0
KILL_EXISTING=0
PROBE_ONLY=0

usage() {
  cat <<'EOF'
Usage: helium-gaf-debug.sh [options]

  --port N            CDP port (default 9333)
  --url URL           Start URL (default helium://extensions)
  --no-extension      Do not pass --load-extension
  --kill-existing     Stop processes using the debug user-data-dir, then relaunch
  --probe-only        Check CDP only; exits 1 if /json/version is not responding
  -h, --help          Show this help

Environment:
  HELIUM_EXE          Explicit Helium/Chromium binary (never the daily profile)

The debug profile is ${XDG_DATA_HOME:-$HOME/.local/share}/Helium-GAF-Debug/User Data.
Never point --user-data-dir at the daily Helium profile.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)
      PORT="${2:?--port requires a port number}"
      shift 2
      ;;
    --url)
      URL="${2:?--url requires a URL}"
      shift 2
      ;;
    --no-extension)
      NO_EXTENSION=1
      shift
      ;;
    --kill-existing)
      KILL_EXISTING=1
      shift
      ;;
    --probe-only)
      PROBE_ONLY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ! "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  echo "Invalid CDP port: $PORT" >&2
  exit 2
fi

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
GAF_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)
XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
DEBUG_ROOT="$XDG_DATA_HOME/Helium-GAF-Debug"
USER_DATA="$DEBUG_ROOT/User Data"
LOG_DIR="$DEBUG_ROOT/logs"

is_executable_file() {
  local path="$1"
  [[ -n "$path" && -e "$path" && -x "$path" && ! -d "$path" ]]
}

# Prefer Helium, then a Chromium-family browser. Never return a daily profile directory.
find_helium_exe() {
  local candidate name exe target
  if [[ -n "${HELIUM_EXE:-}" ]]; then
    if is_executable_file "$HELIUM_EXE"; then
      printf '%s\n' "$HELIUM_EXE"
      return 0
    fi
    echo "HELIUM_EXE is set but not an executable file: $HELIUM_EXE" >&2
    return 1
  fi

  local candidates=(
    "$HOME/.local/bin/helium"
    "$HOME/.local/bin/helium-browser"
    "$HOME/.local/bin/helium-bin"
    "$HOME/.local/share/helium/helium"
    "$HOME/.local/share/helium/helium-browser"
    "$HOME/.local/share/helium/chrome"
    "$HOME/.local/share/helium/chrome-wrapper"
    /opt/helium/helium
    /opt/helium/helium-browser
    /opt/helium/chrome
    /opt/helium/chrome-wrapper
    /opt/helium/helium.AppImage
    /opt/helium-browser-bin/helium
    /usr/bin/helium
    /usr/bin/helium-browser
    /usr/local/bin/helium
    /usr/local/bin/helium-browser
  )

  shopt -s nullglob
  candidates+=(
    "$HOME/.local/bin/"[Hh]elium*.AppImage
    "$HOME/.local/share/"[Hh]elium*.AppImage
    "$HOME/.local/share/helium/"[Hh]elium*.AppImage
    /opt/helium/*.AppImage
    /opt/*[Hh]elium*/helium
    /opt/*[Hh]elium*/chrome
  )
  shopt -u nullglob

  for candidate in "${candidates[@]}"; do
    if is_executable_file "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  for name in helium helium-browser helium-bin; do
    exe=$(command -v "$name" 2>/dev/null || true)
    if is_executable_file "$exe"; then
      printf '%s\n' "$exe"
      return 0
    fi
  done

  if [[ -d /proc ]]; then
    for exe in /proc/[0-9]*/exe; do
      target=$(readlink -f "$exe" 2>/dev/null || true)
      case "$target" in
        *[Hh]elium*|*/imput/*)
          if is_executable_file "$target"; then
            printf '%s\n' "$target"
            return 0
          fi
          ;;
      esac
    done
  fi

  for name in chromium chromium-browser google-chrome google-chrome-stable; do
    exe=$(command -v "$name" 2>/dev/null || true)
    if is_executable_file "$exe"; then
      printf '%s\n' "$exe"
      return 0
    fi
  done

  return 1
}

fetch_cdp_version() {
  local url="http://127.0.0.1:${PORT}/json/version"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 2 "$url" 2>/dev/null || return 1
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O - --timeout=2 "$url" 2>/dev/null || return 1
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$url" <<'PY' 2>/dev/null || return 1
import sys, urllib.request
print(urllib.request.urlopen(sys.argv[1], timeout=2).read().decode())
PY
  else
    return 1
  fi
}

test_cdp_alive() {
  local body
  body=$(fetch_cdp_version) || return 1
  [[ "$body" == *webSocketDebuggerUrl* || "$body" == *Browser* ]]
}

url_encode() {
  local raw="$1"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$raw"
    return 0
  fi
  # Fallback: only encode characters that commonly appear in http(s) URLs.
  local encoded="" i c hex
  for ((i = 0; i < ${#raw}; i++)); do
    c=${raw:i:1}
    case "$c" in
      [a-zA-Z0-9.~_-]) encoded+="$c" ;;
      *)
        printf -v hex '%02X' "'$c"
        encoded+="%$hex"
        ;;
    esac
  done
  printf '%s\n' "$encoded"
}

open_url_via_cdp() {
  local encoded new_url
  encoded=$(url_encode "$URL")
  new_url="http://127.0.0.1:${PORT}/json/new?${encoded}"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 3 -X PUT "$new_url" >/dev/null 2>&1 \
      || curl -fsS --max-time 3 "$new_url" >/dev/null 2>&1
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O - --timeout=3 --method=PUT "$new_url" >/dev/null 2>&1 \
      || wget -q -O - --timeout=3 "$new_url" >/dev/null 2>&1
  else
    return 1
  fi
}

write_env_helper() {
  local path="$1"
  cat >"$path" <<EOF
# Source before browser-use:
#   . "\${XDG_DATA_HOME:-\$HOME/.local/share}/Helium-GAF-Debug/set-cdp-env.sh"
export BU_CDP_URL='http://127.0.0.1:${PORT}'
export PATH="\${HOME}/.local/bin:\${PATH}"
echo "BU_CDP_URL=\${BU_CDP_URL}"
EOF
}

kill_debug_profile_processes() {
  local pid cmdline
  [[ -d /proc ]] || return 0
  for cmdline in /proc/[0-9]*/cmdline; do
    [[ -r "$cmdline" ]] || continue
    if tr '\0' ' ' <"$cmdline" 2>/dev/null | grep -F -- "$USER_DATA" >/dev/null 2>&1; then
      pid=$(basename "$(dirname "$cmdline")")
      echo "  Stopping PID ${pid} (debug profile)..."
      kill "$pid" 2>/dev/null || true
    fi
  done
  sleep 1
}

seed_developer_preferences() {
  local default_dir prefs
  default_dir="$USER_DATA/Default"
  prefs="$default_dir/Preferences"
  mkdir -p "$default_dir"
  if [[ ! -e "$prefs" ]]; then
    cat >"$prefs" <<'EOF'
{"extensions":{"ui":{"developer_mode":true}},"browser":{"has_seen_welcome_page":true,"check_default_browser":false},"distribution":{"import_bookmarks":false,"skip_first_run_ui":true}}
EOF
  fi
}

echo
echo "  Helium GAF Debug launcher"
echo "  ========================="

HELIUM_BIN=""
if HELIUM_BIN=$(find_helium_exe); then
  echo "  Binary     : $HELIUM_BIN"
else
  HELIUM_BIN=""
  echo "  Binary     : (not found)"
fi
echo "  Profile    : $USER_DATA"
echo "  GAF path   : $GAF_ROOT"
echo "  CDP port   : $PORT"
echo "  Start URL  : $URL"
echo

if (( PROBE_ONLY )); then
  if test_cdp_alive; then
    echo "  CDP OK on :${PORT}"
    fetch_cdp_version || true
    echo
    exit 0
  fi
  echo "  CDP not responding on :${PORT}"
  exit 1
fi

if [[ -z "$HELIUM_BIN" ]]; then
  echo "Helium/Chromium not found. Install Helium, add it to ~/.local, /opt, or PATH, or set HELIUM_EXE." >&2
  exit 1
fi

if test_cdp_alive; then
  echo "  CDP already alive on :${PORT} - reusing instance."
  fetch_cdp_version || true
  echo
  echo "  Connect browser-use with:"
  echo "    export BU_CDP_URL=\"http://127.0.0.1:${PORT}\""
  echo "    browser-use"
  echo
  if [[ -n "${URL// }" ]]; then
    if open_url_via_cdp; then
      echo "  Opened: $URL"
    else
      echo "  Could not open URL via CDP; navigate manually in the debug window."
    fi
  fi
  exit 0
fi

mkdir -p "$USER_DATA" "$LOG_DIR"

if (( KILL_EXISTING )); then
  kill_debug_profile_processes
fi

seed_developer_preferences

args=(
  "--user-data-dir=$USER_DATA"
  "--remote-debugging-port=$PORT"
  --no-first-run
  --no-default-browser-check
  --disable-features=TranslateUI
  --password-store=basic
)

if (( ! NO_EXTENSION )); then
  if [[ ! -f "$GAF_ROOT/manifest.json" ]]; then
    echo "GAF manifest.json not found at $GAF_ROOT" >&2
    exit 1
  fi
  # Load GAF unpacked. Do not use --disable-extensions-except: it strips Helium's
  # bundled blockers and has been flaky when daily Helium is also running.
  args+=("--load-extension=$GAF_ROOT")
fi

if [[ -n "${URL// }" ]]; then
  args+=("$URL")
fi

echo "  Starting Helium GAF Debug..."
"$HELIUM_BIN" "${args[@]}" >/dev/null 2>&1 &
helium_pid=$!
echo "  PID $helium_pid"

ok=0
for _ in $(seq 1 40); do
  sleep 0.25
  if test_cdp_alive; then
    ok=1
    break
  fi
done

echo
if (( ok )); then
  echo "  CDP READY  http://127.0.0.1:${PORT}"
  fetch_cdp_version || true
  echo
  echo "  Daily Helium  : normal profile (untouched)"
  echo "  Debug Helium  : this window (GAF + CDP)"
  echo
  echo "  browser-use:"
  echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
  echo "    export BU_CDP_URL=\"http://127.0.0.1:${PORT}\""
  echo "    browser-use --doctor"
  echo
  echo "  First load: confirm GAF on helium://extensions (Developer mode)."
  echo "  If missing: Load unpacked -> $GAF_ROOT"
  echo
  env_helper="$DEBUG_ROOT/set-cdp-env.sh"
  write_env_helper "$env_helper"
  echo "  Env helper : $env_helper"
  exit 0
fi

echo "  CDP did not come up on :${PORT} within ~10s."
echo "  Check the port is free and Helium started a window."
echo "  Probe later: $0 --probe-only --port $PORT"
exit 1
