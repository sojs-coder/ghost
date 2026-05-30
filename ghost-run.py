#!/usr/bin/env python3
"""
ghost-run.py — Ghost route playback engine (GPX, persistent DVT session)

Plays a GPX route file into iOS via the pymobiledevice3 Python API directly —
no subprocess spawning per waypoint. One persistent DVT session streams all
coordinates, reconnecting automatically if the tunnel drops (phone screen sleep).

Called by ghost-init.sh with RSD tunnel already established.
Can also be run standalone if the tunnel is already up:
    python3 ghost-run.py route.gpx --rsd-file /tmp/ghost-rsd.txt

Control file (/tmp/ghost-control.json) — written by dashboard or init script:
    { "cmd": "pause" }
    { "cmd": "play" }
    { "cmd": "stop" }
    { "cmd": "set_speed", "multiplier": 2 }
    { "cmd": "set_route", "route_id": "my-route", "route_path": "/data/routes/my-route.grf" }

Status file (/tmp/ghost-status.json) — written by this process every tick:
    See _write_status() for schema.

GPX format:
    <?xml version="1.0"?>
    <gpx version="1.1">
      <wpt lat="37.7749" lon="-122.4194"><time>1970-01-01T00:00:00Z</time></wpt>
      <wpt lat="37.7750" lon="-122.4180"><time>1970-01-01T00:00:30Z</time></wpt>
      ...
    </gpx>

    The <time> values are used for relative spacing only — absolute date doesn't
    matter, only differences between consecutive timestamps. If <time> is absent,
    pymobiledevice3 advances 1 waypoint/second.
"""

import argparse
import asyncio
import contextlib
import json
import os
import signal
import sys
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# ── File paths ────────────────────────────────────────────────────────────────
CONTROL_FILE = "/tmp/ghost-control.json"
STATUS_FILE  = "/tmp/ghost-status.json"
ROUTES_DIR   = "/data/routes"

# ── pymobiledevice3 imports ───────────────────────────────────────────────────
def _import_pmd3():
    try:
        from pymobiledevice3.remote.remote_service_discovery import RemoteServiceDiscoveryService
        from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
        from pymobiledevice3.services.dvt.instruments.location_simulation import LocationSimulation
        return RemoteServiceDiscoveryService, DvtProvider, LocationSimulation
    except ImportError as e:
        err(f"pymobiledevice3 not importable: {e}")
        err("Make sure you're running inside the ghost venv, or use ghost-init.sh.")
        sys.exit(1)


# ── Async-to-sync helpers for pymobiledevice3 ─────────────────────────────────
@contextlib.contextmanager
def _sync_async_ctx(async_cm, loop):
    """Enter an async context manager synchronously on the given event loop."""
    obj = loop.run_until_complete(async_cm.__aenter__())
    try:
        yield obj
    except Exception as exc:
        loop.run_until_complete(async_cm.__aexit__(type(exc), exc, exc.__traceback__))
        raise
    else:
        loop.run_until_complete(async_cm.__aexit__(None, None, None))


class _SyncSim:
    """Sync wrapper around the async LocationSimulation for use in the playback loop."""
    def __init__(self, sim, loop):
        self._sim = sim
        self._loop = loop

    def set(self, lat, lon):
        self._loop.run_until_complete(self._sim.set(lat, lon))


# ── ANSI colors ───────────────────────────────────────────────────────────────
def _c(code, text): return f"\033[{code}m{text}\033[0m"
def green(t):  return _c("0;32", t)
def yellow(t): return _c("0;33", t)
def red(t):    return _c("0;31", t)
def cyan(t):   return _c("0;36", t)
def dim(t):    return _c("2", t)
def bold(t):   return _c("1", t)

def log(msg):  print(f"{dim(datetime.now().strftime('%H:%M:%S'))} {msg}")
def ok(msg):   print(f"{green('✓')} {msg}")
def warn(msg): print(f"{yellow('⚠')}  {msg}")
def err(msg):  print(f"{red('✗')} {msg}", file=sys.stderr)


# ── GPX parser ────────────────────────────────────────────────────────────────
@dataclass
class Waypoint:
    lat: float
    lon: float
    offset_seconds: float


def _parse_time(t: str) -> datetime:
    t = t.strip()
    if t.endswith("Z"):
        t = t[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(t)
    except ValueError:
        return datetime.strptime(t, "%Y-%m-%dT%H:%M:%S%z")


def load_gpx(path: str) -> list[Waypoint]:
    tree = ET.parse(path)
    root = tree.getroot()
    ns = ""
    if root.tag.startswith("{"):
        ns = root.tag.split("}")[0] + "}"

    def find_all_points():
        trkpts = root.findall(f".//{ns}trkpt")
        if trkpts:
            return trkpts
        return root.findall(f".//{ns}wpt")

    raw_points = find_all_points()
    if not raw_points:
        raise ValueError("No <wpt> or <trkpt> elements found in GPX file.")

    waypoints = []
    base_time: Optional[datetime] = None

    for i, pt in enumerate(raw_points):
        try:
            lat = float(pt.get("lat"))
            lon = float(pt.get("lon"))
        except (TypeError, ValueError):
            raise ValueError(f"Point {i+1}: invalid or missing lat/lon attributes.")

        if not (-90 <= lat <= 90):
            raise ValueError(f"Point {i+1}: latitude {lat} out of range.")
        if not (-180 <= lon <= 180):
            raise ValueError(f"Point {i+1}: longitude {lon} out of range.")

        time_el = pt.find(f"{ns}time")
        if time_el is not None and time_el.text:
            try:
                t = _parse_time(time_el.text)
                if base_time is None:
                    base_time = t
                offset = (t - base_time).total_seconds()
            except Exception:
                offset = float(i)
        else:
            offset = float(i)

        waypoints.append(Waypoint(lat=lat, lon=lon, offset_seconds=offset))

    waypoints.sort(key=lambda w: w.offset_seconds)
    duration = waypoints[-1].offset_seconds
    ok(
        f"Loaded GPX: {len(waypoints)} waypoints, "
        f"{duration/60:.1f} min duration, "
        f"source: {Path(path).name}"
    )
    return waypoints


# ── RSD helpers ───────────────────────────────────────────────────────────────
def read_rsd(rsd_file: str) -> tuple[str, int]:
    content = Path(rsd_file).read_text().strip()
    parts = content.split()
    if len(parts) != 2:
        raise ValueError(f"Unexpected RSD file content: {content!r}")
    return parts[0], int(parts[1])


def format_time(seconds: float) -> str:
    s = int(abs(seconds))
    return f"{s // 60:02d}:{s % 60:02d}"


# ── Control file ──────────────────────────────────────────────────────────────
def read_control() -> Optional[dict]:
    """
    Read and atomically consume the control file.
    Returns the parsed dict, or None if the file is absent/empty/invalid.
    After reading, the file is cleared so commands are not processed twice.
    """
    try:
        raw = Path(CONTROL_FILE).read_text().strip()
        if not raw:
            return None
        data = json.loads(raw)
        # Clear after reading — one-shot command
        Path(CONTROL_FILE).write_text("{}")
        return data
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def clear_control():
    try:
        Path(CONTROL_FILE).write_text("{}")
    except Exception:
        pass


# ── Status file ───────────────────────────────────────────────────────────────
def write_status(
    state: str,
    route_id: str = "",
    route_name: str = "",
    route_path: str = "",
    waypoint_index: int = 0,
    waypoint_total: int = 0,
    speed_multiplier: float = 1.0,
    loop: bool = True,
    loop_count: int = 0,
    lat: float = 0.0,
    lon: float = 0.0,
    session_start_epoch: int = 0,
):
    payload = {
        "state": state,
        "route_id": route_id,
        "route_name": route_name,
        "route_path": route_path,
        "waypoint_index": waypoint_index,
        "waypoint_total": waypoint_total,
        "speed_multiplier": speed_multiplier,
        "loop": loop,
        "loop_count": loop_count,
        "lat": lat,
        "lon": lon,
        "session_start_epoch": session_start_epoch,
        "updated_at": int(time.time()),
    }
    try:
        tmp = STATUS_FILE + ".tmp"
        Path(tmp).write_text(json.dumps(payload))
        os.replace(tmp, STATUS_FILE)  # atomic
    except Exception as e:
        warn(f"Could not write status file: {e}")


# ── Progress bar ──────────────────────────────────────────────────────────────
def print_status_line(
    idx: int,
    total: int,
    wp: Waypoint,
    elapsed: float,
    duration: float,
    speed: float,
    loop_count: int,
    state: str,
):
    pct = (wp.offset_seconds / duration * 100) if duration > 0 else 0
    bar_width = 28
    filled = int(bar_width * pct / 100)
    bar = "█" * filled + "░" * (bar_width - filled)
    loop_str = f" loop #{loop_count + 1}" if loop_count > 0 else ""
    state_str = f" [{state}]" if state != "playing" else ""
    print(
        f"\r  {dim(format_time(elapsed))} "
        f"[{cyan(bar)}] {pct:5.1f}%  "
        f"wp {idx+1}/{total}  "
        f"({wp.lat:.5f}, {wp.lon:.5f})  "
        f"{dim(str(speed) + 'x' + loop_str + state_str)}",
        end="", flush=True,
    )


# ── Playback engine ───────────────────────────────────────────────────────────
class GhostPlayer:
    def __init__(
        self,
        waypoints: list[Waypoint],
        rsd_file: str,
        speed: float = 1.0,
        loop: bool = True,
        gpx_path: str = "",
        route_id: str = "",
    ):
        self.waypoints   = waypoints
        self.rsd_file    = rsd_file
        self.speed       = speed
        self.loop        = loop
        self.gpx_path    = gpx_path
        self.route_id    = route_id
        self.route_name  = Path(gpx_path).stem.replace("_", " ").replace("-", " ")

        # Runtime state
        self._state      = "idle"   # idle | playing | paused | stopped
        self._stop       = False
        self._loop_count = 0
        self._session_start = 0
        self._pending_route: Optional[dict] = None  # set_route queued mid-session

        signal.signal(signal.SIGINT,  self._handle_stop)
        signal.signal(signal.SIGTERM, self._handle_stop)

    def _handle_stop(self, signum, frame):
        print()
        warn("Stop signal — finishing current waypoint then clearing location...")
        self._stop = True
        self._state = "stopped"

    def _get_rsd(self) -> tuple[str, int]:
        return read_rsd(self.rsd_file)

    def _poll_control(self) -> bool:
        """
        Read the control file and act on any pending command.
        Returns False if a stop was requested, True otherwise.
        """
        ctrl = read_control()
        if not ctrl or "cmd" not in ctrl:
            return True

        cmd = ctrl["cmd"]

        if cmd == "stop":
            warn("\nStop command received.")
            self._stop = True
            self._state = "stopped"
            return False

        elif cmd == "play":
            if self._state == "paused":
                log("\nPlay command received.")
                self._state = "playing"

        elif cmd == "pause":
            if self._state == "playing":
                log("\nPause command received.")
                self._state = "paused"

        elif cmd == "set_speed":
            new_speed = float(ctrl.get("multiplier", self.speed))
            if new_speed > 0:
                log(f"\nSpeed → {new_speed}×")
                self.speed = new_speed

        elif cmd == "set_route":
            # Queue a route change — applied after current waypoint
            route_path = ctrl.get("route_path", "")
            route_id   = ctrl.get("route_id", "")
            if route_path and Path(route_path).exists():
                log(f"\nRoute change queued → {route_id}")
                self._pending_route = {"path": route_path, "id": route_id}
            else:
                warn(f"\nset_route: path not found: {route_path!r}")

        return True

    def _play_one_loop(self, sim, loop_start: float) -> str:
        """
        Stream one full pass through waypoints.
        Returns one of: 'complete' | 'stopped' | 'route_change'
        """
        waypoints = self.waypoints
        total     = len(waypoints)
        duration  = waypoints[-1].offset_seconds

        for i, wp in enumerate(waypoints):
            if self._stop:
                return "stopped"

            if self._pending_route:
                return "route_change"

            # Wall-clock target for this waypoint (adjusted for pause time)
            target = loop_start + (wp.offset_seconds / self.speed)

            # Sleep in small increments so we can react to control commands
            while True:
                now = time.monotonic()
                if self._stop or self._pending_route:
                    break

                # Poll control file ~every 0.25s
                if not self._poll_control():
                    return "stopped"

                if self._state == "paused":
                    # Shift loop_start forward so we don't race ahead after unpause
                    loop_start += 0.25
                    target = loop_start + (wp.offset_seconds / self.speed)
                    write_status(
                        state="paused",
                        route_id=self.route_id,
                        route_name=self.route_name,
                        route_path=self.gpx_path,
                        waypoint_index=i,
                        waypoint_total=total,
                        speed_multiplier=self.speed,
                        loop=self.loop,
                        loop_count=self._loop_count,
                        lat=wp.lat,
                        lon=wp.lon,
                        session_start_epoch=self._session_start,
                    )
                    time.sleep(0.25)
                    continue

                remaining = target - now
                if remaining <= 0:
                    break
                time.sleep(min(0.25, remaining))

            if self._stop or self._pending_route:
                break

            # Inject location
            sim.set(wp.lat, wp.lon)

            elapsed = time.monotonic() - loop_start
            print_status_line(i, total, wp, elapsed, duration, self.speed, self._loop_count, self._state)

            write_status(
                state=self._state,
                route_id=self.route_id,
                route_name=self.route_name,
                route_path=self.gpx_path,
                waypoint_index=i,
                waypoint_total=total,
                speed_multiplier=self.speed,
                loop=self.loop,
                loop_count=self._loop_count,
                lat=wp.lat,
                lon=wp.lon,
                session_start_epoch=self._session_start,
            )

        if self._pending_route:
            return "route_change"
        if self._stop:
            return "stopped"
        return "complete"

    def _load_new_route(self, route_info: dict):
        """Hot-swap waypoints from a queued route change."""
        try:
            new_wps = load_gpx(route_info["path"])
            self.waypoints  = new_wps
            self.gpx_path   = route_info["path"]
            self.route_id   = route_info["id"]
            self.route_name = Path(route_info["path"]).stem.replace("_", " ").replace("-", " ")
            self._loop_count = 0
            self._pending_route = None
            ok(f"Route swapped → {self.route_name}")
        except Exception as e:
            warn(f"Route swap failed: {e} — continuing with current route")
            self._pending_route = None

    def play(self):
        RSD, DVT, LocationSimulation = _import_pmd3()

        waypoints = self.waypoints
        duration  = waypoints[-1].offset_seconds

        print()
        print(bold(f"  Route:     {Path(self.gpx_path).name}"))
        print(bold(f"  Waypoints: {len(waypoints)}"))
        print(bold(f"  Duration:  {format_time(duration)} at 1×  →  {format_time(duration / self.speed)} at {self.speed}×"))
        print(bold(f"  Loop:      {self.loop}"))
        print()
        print(dim("  Control:   ") + CONTROL_FILE)
        print(dim("  Status:    ") + STATUS_FILE)
        print()

        self._state = "playing"
        self._session_start = int(time.time())

        write_status(
            state="playing",
            route_id=self.route_id,
            route_name=self.route_name,
            route_path=self.gpx_path,
            waypoint_total=len(self.waypoints),
            speed_multiplier=self.speed,
            loop=self.loop,
            session_start_epoch=self._session_start,
        )

        while not self._stop:
            try:
                host, port = self._get_rsd()
            except Exception as e:
                warn(f"Cannot read RSD file: {e} — retrying in 3s...")
                write_status(state="reconnecting", route_id=self.route_id, route_name=self.route_name,
                             route_path=self.gpx_path, waypoint_total=len(self.waypoints),
                             speed_multiplier=self.speed, loop=self.loop,
                             session_start_epoch=self._session_start)
                time.sleep(3)
                continue

            log(f"Opening DVT session → {host}:{port}")
            _loop = asyncio.new_event_loop()
            try:
                with _sync_async_ctx(RSD((host, port)), _loop) as rsd:
                    with _sync_async_ctx(DVT(lockdown=rsd), _loop) as dvt:
                        with _sync_async_ctx(LocationSimulation(dvt), _loop) as sim_async:
                            sim = _SyncSim(sim_async, _loop)
                            ok("DVT session open — streaming waypoints.")
                            self._state = "playing"
                            loop_start = time.monotonic()

                            result = self._play_one_loop(sim, loop_start)

                            if result == "stopped":
                                # sim.__aexit__ clears location automatically
                                break

                            elif result == "route_change":
                                print()
                                log("Applying route change...")
                                # sim.__aexit__ clears current location
                            # fall through — re-enter outer while to reopen session

                            elif result == "complete":
                                if self.loop:
                                    self._loop_count += 1
                                    print()
                                    log(f"Loop {self._loop_count} complete — restarting...")
                                    # fall through to reopen session for clean state
                                else:
                                    print()
                                    ok("Route complete. Holding last position (Ctrl+C to stop).")
                                    self._state = "idle"
                                    write_status(
                                        state="idle",
                                        route_id=self.route_id,
                                        route_name=self.route_name,
                                        route_path=self.gpx_path,
                                        waypoint_index=len(self.waypoints) - 1,
                                        waypoint_total=len(self.waypoints),
                                        speed_multiplier=self.speed,
                                        loop=self.loop,
                                        session_start_epoch=self._session_start,
                                    )
                                    while not self._stop:
                                        self._poll_control()
                                        time.sleep(1)
                                    break

            except Exception as e:
                if self._stop:
                    break
                warn(f"Session lost: {e}")
                warn("Waiting 3s for tunnel to recover...")
                write_status(state="reconnecting", route_id=self.route_id, route_name=self.route_name,
                             route_path=self.gpx_path, waypoint_total=len(self.waypoints),
                             speed_multiplier=self.speed, loop=self.loop,
                             session_start_epoch=self._session_start)
                time.sleep(3)
                continue
            finally:
                _loop.close()

            # If we had a route change, load the new route before re-entering the loop
            if self._pending_route:
                self._load_new_route(self._pending_route)

        print()
        ok("Location simulation ended. Real GPS restored.")
        write_status(state="stopped", route_id=self.route_id, route_name=self.route_name,
                     route_path=self.gpx_path, waypoint_total=len(self.waypoints),
                     speed_multiplier=self.speed, loop=self.loop,
                     session_start_epoch=self._session_start)


# ── CLI ───────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(
        description="Ghost GPX route playback. Normally called by ghost-init.sh."
    )
    parser.add_argument("gpx_file", help="Path to GPX route file")
    parser.add_argument(
        "--rsd-file",
        default="/tmp/ghost-rsd.txt",
        help="File containing 'host port' for the RSD tunnel (written by ghost-init.sh)",
    )
    parser.add_argument(
        "--speed", type=float, default=1.0,
        help="Playback speed multiplier (default 1.0)",
    )
    parser.add_argument(
        "--no-loop", action="store_true",
        help="Play once then hold last position instead of looping",
    )
    parser.add_argument("--pmd3", default=None, help=argparse.SUPPRESS)
    args = parser.parse_args()

    if not Path(args.gpx_file).exists():
        err(f"GPX file not found: {args.gpx_file}")
        sys.exit(1)

    if not Path(args.rsd_file).exists():
        err(f"RSD file not found: {args.rsd_file}")
        err("Run ghost-init.sh first to establish the DVT tunnel.")
        sys.exit(1)

    if args.speed <= 0:
        err(f"Speed must be > 0, got {args.speed}")
        sys.exit(1)

    try:
        host, port = read_rsd(args.rsd_file)
        ok(f"RSD tunnel: {host}:{port}")
    except Exception as e:
        err(f"Cannot parse RSD file: {e}")
        sys.exit(1)

    try:
        waypoints = load_gpx(args.gpx_file)
    except Exception as e:
        err(f"Failed to load GPX: {e}")
        sys.exit(1)

    # Derive route ID from filename
    route_id = Path(args.gpx_file).stem

    # Clear any stale control commands from a previous session
    clear_control()

    player = GhostPlayer(
        waypoints=waypoints,
        rsd_file=args.rsd_file,
        speed=args.speed,
        loop=not args.no_loop,
        gpx_path=args.gpx_file,
        route_id=route_id,
    )
    player.play()


if __name__ == "__main__":
    main()