#!/usr/bin/env bash
# ghost-mac.sh — Ghost Device environment initializer (macOS)
# Installs dependencies, establishes DVT tunnel,
# then hands off to ghost-run.py to play a GPX route file.
#
# Usage:
#   ./ghost-mac.sh <route.gpx>
#   ./ghost-mac.sh <route.gpx> --speed 2        # 2x speed
#   ./ghost-mac.sh <route.gpx> --no-loop        # play once then hold last position
#   ./ghost-mac.sh <route.gpx> --skip-deps      # skip brew/pip checks (faster re-runs)

set -uo pipefail

# Guard: must run under bash, not sh
if [ -z "${BASH_VERSION:-}" ]; then
  echo "ERROR: run with bash, not sh:  sudo bash ghost-mac.sh <route.gpx>" >&2
  exit 1
fi

# ── Config ────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$SCRIPT_DIR/ghost-env"
PYTHON="$VENV_DIR/bin/python3"
PMD3="$PYTHON -m pymobiledevice3"

# macOS-safe realpath substitute
_realpath() { python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$1"; }
RUNNER="$(dirname "$(_realpath "$0")")/ghost-run.py"

TUNNEL_LOG="/tmp/ghost-tunnel.log"
TUNNEL_PID_FILE="/tmp/ghost-tunnel.pid"
RUNNER_PID_FILE="/tmp/ghost-runner.pid"
RSD_FILE="/tmp/ghost-rsd.txt"
WATCHDOG_PID_FILE="/tmp/ghost-watchdog.pid"
CONTROL_FILE="/tmp/ghost-control.json"
STATUS_FILE="/tmp/ghost-status.json"

TUNNEL_READY_TIMEOUT=20
WATCHDOG_INTERVAL=3

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GRN='\033[0;32m'; YLW='\033[0;33m'
BLU='\033[0;34m'; CYN='\033[0;36m'; DIM='\033[2m'; NC='\033[0m'

log()  { echo -e "${DIM}[$(date +%H:%M:%S)]${NC} $*"; }
ok()   { echo -e "${GRN}✓${NC} $*"; }
warn() { echo -e "${YLW}⚠${NC}  $*"; }
err()  { echo -e "${RED}✗${NC} $*" >&2; }
info() { echo -e "${CYN}→${NC} $*"; }
die()  { err "$1"; exit 1; }

# ── Usage ─────────────────────────────────────────────────────────────────────
usage() {
  cat <<EOF
Usage: $0 <route.gpx> [OPTIONS]

Options:
  --speed <N>     Speed multiplier, e.g. 2 plays route at 2x (default: 1)
  --no-loop       Play route once then hold last position (default: loop)
  --skip-deps     Skip brew/pip dependency checks on subsequent runs
  --help

GPX route format:
  Standard GPX with <wpt> or <trkpt> waypoints. <time> tags set relative timing.
  If no <time> tags present, advances 1 waypoint/second.

Control interface (once running):
  Write JSON to $CONTROL_FILE — runner polls every ~0.25s:
    { "cmd": "pause" }
    { "cmd": "play" }
    { "cmd": "stop" }
    { "cmd": "set_speed", "multiplier": 2 }
    { "cmd": "set_route", "route_id": "name", "route_path": "/data/routes/name.gpx" }

  Status is written to $STATUS_FILE every waypoint tick.
  Runner PID is in $RUNNER_PID_FILE.

Examples:
  $0 routes/morning-walk.gpx
  $0 routes/morning-walk.gpx --speed 2 --no-loop
EOF
  exit 1
}

# ── Arg parsing ───────────────────────────────────────────────────────────────
[[ $# -lt 1 ]] && usage

ROUTE_FILE=""
SPEED_OVERRIDE="1"
LOOP=true
SKIP_DEPS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --speed)     SPEED_OVERRIDE="$2"; shift 2 ;;
    --no-loop)   LOOP=false; shift ;;
    --skip-deps) SKIP_DEPS=1; shift ;;
    --help|-h)   usage ;;
    -*)          die "Unknown option: $1" ;;
    *)
      [[ -z "$ROUTE_FILE" ]] && ROUTE_FILE="$1" || die "Unexpected argument: $1"
      shift ;;
  esac
done

[[ -z "$ROUTE_FILE" ]] && usage
[[ -f "$ROUTE_FILE" ]] || die "Route file not found: $ROUTE_FILE"
[[ -f "$RUNNER" ]]     || die "Runner not found: $RUNNER (must be in same directory as this script)"

# ── Step 1: Kill any existing runner ─────────────────────────────────────────
if [[ -f "$RUNNER_PID_FILE" ]]; then
  old_pid=$(cat "$RUNNER_PID_FILE" 2>/dev/null || true)
  if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
    warn "Stopping existing runner (PID $old_pid)..."
    kill "$old_pid" 2>/dev/null || true
    sleep 1
  fi
  rm -f "$RUNNER_PID_FILE"
fi

# ── Step 2: Initialize control and status files ───────────────────────────────
info "Initializing control and status files..."
echo "{}" > "$CONTROL_FILE"
cat > "$STATUS_FILE" <<JSON
{
  "state": "initializing",
  "route_id": "$(basename "$ROUTE_FILE" .gpx)",
  "route_name": "$(basename "$ROUTE_FILE" .gpx | tr '_-' '  ')",
  "route_path": "$ROUTE_FILE",
  "waypoint_index": 0,
  "waypoint_total": 0,
  "speed_multiplier": $SPEED_OVERRIDE,
  "loop": $LOOP,
  "loop_count": 0,
  "lat": 0,
  "lon": 0,
  "session_start_epoch": $(date +%s),
  "updated_at": $(date +%s)
}
JSON
ok "Control file: $CONTROL_FILE"
ok "Status file:  $STATUS_FILE"

# ── Step 3: Dependencies ──────────────────────────────────────────────────────
install_deps() {
  info "Checking system dependencies..."

  # Ensure Homebrew is present
  if ! command -v brew &>/dev/null; then
    die "Homebrew not found. Install it from https://brew.sh then re-run."
  fi

  # python3 via brew if missing from PATH
  if ! command -v python3 &>/dev/null; then
    warn "python3 not found — installing via brew..."
    brew install python3
  else
    ok "python3 present ($(python3 --version 2>&1))."
  fi

  # On macOS, usbmuxd is managed by the OS (launchd / Apple Mobile Device service).
  # No need to install or start it manually.

  if [[ ! -d "$VENV_DIR" ]]; then
    info "Creating Python venv at $VENV_DIR..."
    python3 -m venv "$VENV_DIR"
  fi

  if ! "$PYTHON" -m pymobiledevice3 --version &>/dev/null; then
    info "Installing pymobiledevice3..."
    "$VENV_DIR/bin/pip" install --quiet --upgrade pip
    "$VENV_DIR/bin/pip" install --quiet pymobiledevice3
    ok "pymobiledevice3 installed."
  else
    ok "pymobiledevice3 $("$PYTHON" -m pymobiledevice3 --version 2>&1 | head -1) present."
  fi
}

[[ $SKIP_DEPS -eq 0 ]] && install_deps || log "Skipping dependency check (--skip-deps)."

# ── Step 4: iPhone on USB ─────────────────────────────────────────────────────
info "Checking for connected iPhone..."
# system_profiler fails under sudo, so use pymobiledevice3 which is already installed
DEVICE_CHECK=$($PMD3 usbmux list 2>/dev/null || echo "[]")
if [[ "$DEVICE_CHECK" == "[]" ]] || [[ -z "$DEVICE_CHECK" ]]; then
  die "No Apple device visible. Connect your iPhone, unlock it, and tap Trust — then re-run."
fi
ok "iPhone detected."

# ── Step 5: usbmuxd socket ───────────────────────────────────────────────────
info "Checking usbmuxd..."

# macOS stores the socket at /var/run/usbmuxd (managed by launchd automatically)
USBMUXD_SOCKET=""
for candidate in /var/run/usbmuxd /private/var/run/usbmuxd /tmp/usbmuxd; do
  [[ -S "$candidate" ]] && { USBMUXD_SOCKET="$candidate"; break; }
done

if [[ -z "$USBMUXD_SOCKET" ]]; then
  warn "usbmuxd socket not found."
  warn "Make sure 'Apple Mobile Device Service' is running (Xcode or iTunes must have been installed)."
  warn "You can try: sudo launchctl start com.apple.usbmuxd"
  read -r -p "Press Enter to retry, or Ctrl+C to abort..."
  for candidate in /var/run/usbmuxd /private/var/run/usbmuxd /tmp/usbmuxd; do
    [[ -S "$candidate" ]] && { USBMUXD_SOCKET="$candidate"; break; }
  done
  [[ -z "$USBMUXD_SOCKET" ]] && die "usbmuxd socket still not found. Is Xcode / Apple Mobile Device Support installed?"
fi
ok "usbmuxd socket: $USBMUXD_SOCKET"
export USBMUXD_SOCKET_ADDRESS="$USBMUXD_SOCKET"


# ── Step 6: DVT tunnel ────────────────────────────────────────────────────────
info "Establishing DVT tunnel..."

parse_rsd() {
  local deadline=$((SECONDS + TUNNEL_READY_TIMEOUT))
  while [[ $SECONDS -lt $deadline ]]; do
    local line host port
    line=$(grep -oE "RSD address: [^ ]+ port: [0-9]+" "$TUNNEL_LOG" 2>/dev/null | tail -1 || true)
    if [[ -n "$line" ]]; then
      host=$(awk '{print $3}' <<< "$line"); port=$(awk '{print $5}' <<< "$line")
      echo "$host $port" > "$RSD_FILE"; return 0
    fi
    line=$(grep -oE "\-\-rsd [^ ]+ [0-9]+" "$TUNNEL_LOG" 2>/dev/null | tail -1 || true)
    if [[ -n "$line" ]]; then
      host=$(awk '{print $2}' <<< "$line"); port=$(awk '{print $3}' <<< "$line")
      echo "$host $port" > "$RSD_FILE"; return 0
    fi
    sleep 0.5
  done
  return 1
}

tunnel_running() {
  local pid
  pid=$(sudo cat "$TUNNEL_PID_FILE" 2>/dev/null) || return 1
  [[ -n "$pid" ]] && sudo kill -0 "$pid" 2>/dev/null && [[ -f "$RSD_FILE" ]]
}

start_tunnel() {
  sudo rm -f "$TUNNEL_LOG" "$TUNNEL_PID_FILE" "$RSD_FILE"
  sudo bash -c "USBMUXD_SOCKET_ADDRESS='$USBMUXD_SOCKET' '$PYTHON' -m pymobiledevice3 lockdown start-tunnel > '$TUNNEL_LOG' 2>&1 & echo \$! > '$TUNNEL_PID_FILE'"
  sleep 1

  local pid
  pid=$(sudo cat "$TUNNEL_PID_FILE" 2>/dev/null || true)
  [[ -z "$pid" ]] && { err "Tunnel process did not start."; return 1; }
  sudo kill -0 "$pid" 2>/dev/null || {
    err "Tunnel died immediately. Log:"; cat "$TUNNEL_LOG" 2>/dev/null; return 1
  }

  if parse_rsd; then
    ok "DVT tunnel up (PID $pid) — RSD: $(cat "$RSD_FILE")"
    return 0
  else
    err "Tunnel started but no RSD address within ${TUNNEL_READY_TIMEOUT}s."
    tail -5 "$TUNNEL_LOG" 2>/dev/null || true
    return 1
  fi
}

if tunnel_running; then
  ok "Existing tunnel alive — reusing. RSD: $(cat "$RSD_FILE")"
else
  start_tunnel || die "Could not establish DVT tunnel."
fi

# ── Step 7: Watchdog ──────────────────────────────────────────────────────────
info "Starting tunnel watchdog..."

if [[ -f "$WATCHDOG_PID_FILE" ]]; then
  old=$(cat "$WATCHDOG_PID_FILE" 2>/dev/null || true)
  [[ -n "$old" ]] && kill "$old" 2>/dev/null || true
  rm -f "$WATCHDOG_PID_FILE"
fi

(
  echo $BASHPID > "$WATCHDOG_PID_FILE"
  while true; do
    sleep "$WATCHDOG_INTERVAL"

    # Stop watchdog if runner exited
    if [[ -f "$RUNNER_PID_FILE" ]]; then
      runner_pid=$(cat "$RUNNER_PID_FILE" 2>/dev/null || true)
      if [[ -n "$runner_pid" ]] && ! kill -0 "$runner_pid" 2>/dev/null; then
        log "[watchdog] Runner exited — shutting down watchdog."
        exit 0
      fi
    fi

    pid=$(sudo cat "$TUNNEL_PID_FILE" 2>/dev/null || true)
    if [[ -z "$pid" ]] || ! sudo kill -0 "$pid" 2>/dev/null; then
      echo -e "${YLW}⚠${NC}  [watchdog] Tunnel died — restarting..."
      sudo rm -f "$TUNNEL_LOG" "$TUNNEL_PID_FILE" "$RSD_FILE"
      sudo bash -c "USBMUXD_SOCKET_ADDRESS='$USBMUXD_SOCKET' '$PYTHON' -m pymobiledevice3 lockdown start-tunnel > '$TUNNEL_LOG' 2>&1 & echo \$! > '$TUNNEL_PID_FILE'"
      sleep 2
      local_deadline=$((SECONDS + 20))
      restored=0
      while [[ $SECONDS -lt $local_deadline ]]; do
        line=$(grep -oE "RSD address: [^ ]+ port: [0-9]+" "$TUNNEL_LOG" 2>/dev/null | tail -1 || true)
        if [[ -n "$line" ]]; then
          h=$(awk '{print $3}' <<< "$line"); p=$(awk '{print $5}' <<< "$line")
          echo "$h $p" > "$RSD_FILE"
          echo -e "${GRN}✓${NC} [watchdog] Tunnel restored — RSD: $h $p"
          restored=1; break
        fi
        line=$(grep -oE "\-\-rsd [^ ]+ [0-9]+" "$TUNNEL_LOG" 2>/dev/null | tail -1 || true)
        if [[ -n "$line" ]]; then
          h=$(awk '{print $2}' <<< "$line"); p=$(awk '{print $3}' <<< "$line")
          echo "$h $p" > "$RSD_FILE"
          echo -e "${GRN}✓${NC} [watchdog] Tunnel restored — RSD: $h $p"
          restored=1; break
        fi
        sleep 0.5
      done
      [[ $restored -eq 0 ]] && echo -e "${RED}✗${NC} [watchdog] Restart failed — will retry."
    fi
  done
) &
disown $!
ok "Watchdog started (PID $!)."

# ── Step 8: Hand off to runner ────────────────────────────────────────────────
echo ""
echo -e "${BLU}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLU}  Ghost — starting route playback${NC}"
echo -e "${BLU}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

RUNNER_ARGS=(
  "$ROUTE_FILE"
  --pmd3 "$PYTHON"
  --rsd-file "$RSD_FILE"
  --speed "$SPEED_OVERRIDE"
)
[[ "$LOOP" == false ]] && RUNNER_ARGS+=(--no-loop)

cleanup() {
  echo ""
  warn "Interrupted — stopping watchdog and runner..."
  if [[ -f "$WATCHDOG_PID_FILE" ]]; then
    wdog=$(cat "$WATCHDOG_PID_FILE" 2>/dev/null || true)
    [[ -n "$wdog" ]] && kill "$wdog" 2>/dev/null || true
  fi
  if [[ -f "$RUNNER_PID_FILE" ]]; then
    rp=$(cat "$RUNNER_PID_FILE" 2>/dev/null || true)
    [[ -n "$rp" ]] && kill "$rp" 2>/dev/null || true
  fi
  rm -f "$RUNNER_PID_FILE"
  ok "Done. Goodbye."
  exit 0
}
trap cleanup INT TERM

# Launch runner in background so we can capture its PID, then wait
"$PYTHON" "$RUNNER" "${RUNNER_ARGS[@]}" &
RUNNER_PID=$!
echo "$RUNNER_PID" > "$RUNNER_PID_FILE"
ok "Runner started (PID $RUNNER_PID)"

# macOS-safe local IP detection
LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null \
  || ipconfig getifaddr en1 2>/dev/null \
  || ifconfig 2>/dev/null | awk '/inet / && !/127\.0\.0\.1/{print $2; exit}' \
  || echo "localhost")
ok "Dashboard: http://$LOCAL_IP:7070"
echo ""

wait "$RUNNER_PID"
EXIT_CODE=$?

rm -f "$RUNNER_PID_FILE"

# Kill watchdog now that runner is done
if [[ -f "$WATCHDOG_PID_FILE" ]]; then
  wdog=$(cat "$WATCHDOG_PID_FILE" 2>/dev/null || true)
  [[ -n "$wdog" ]] && kill "$wdog" 2>/dev/null || true
  rm -f "$WATCHDOG_PID_FILE"
fi

exit "$EXIT_CODE"
