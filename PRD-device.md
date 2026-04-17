# PRD: Ghost Device — USB Location Privacy Hardware

**Version:** 2.0  
**Status:** Draft  
**Last updated:** 2026-03-24

> **Architecture change from v1.0:** The Ghost Device is no longer a BLE peripheral that attempts to feed NMEA data into iOS via CoreBluetooth. Research confirmed that path cannot achieve system-wide location override without MFi certification, which Apple will not grant for a location-spoofing device. The v2.0 device is a small USB-connected Linux SBC that injects location directly into iOS via Apple's own developer DVT (`simulate-location`) API — the same mechanism used by Xcode and iAnyGo. This approach requires no MFi, no jailbreak, and produces a true system-wide override that all apps (Find My, Life360, Snapchat) see as authoritative.

---

## 1. Overview

### 1.1 Product summary

Ghost Device is a small, battery-powered Linux computer that physically connects to an iPhone via USB-C and injects a cover route as the phone's system-wide GPS source using Apple's iOS developer location simulation API. When connected, iOS reports the cover route's coordinates to every location-consuming app on the device. No app can distinguish this from normal GPS operation through any currently available API.

The device runs a minimal Linux image on a Raspberry Pi Zero 2W (or equivalent SBC) and communicates with the iPhone over USB using the `pymobiledevice3` protocol stack — a fully documented, open, pure-Python reimplementation of Apple's own `lockdownd`/DVT protocol.

### 1.2 Problem statement

Users who share their location with family members, partners, or others sometimes need location privacy without the social signal of "stopping sharing." Turning off location sharing is visible and often escalates concern or conflict. Ghost Device allows users to maintain the appearance of normal location sharing while keeping their actual whereabouts private.

### 1.3 How it works (technical summary)

```
iPhone (iOS 16+)
    │
    │  USB-C cable
    │
Ghost Device (Linux SBC)
    │
    ├── usbmuxd: detects phone, manages USB multiplexer
    ├── pymobiledevice3: speaks lockdownd + RemoteXPC protocols
    ├── tunneld daemon: establishes encrypted QUIC/TCP tunnel to iOS (iOS 17+)
    ├── DVT simulate-location: streams waypoints to locationd on phone
    └── ghost-daemon: reads active .grf route, feeds waypoints at 1 Hz
```

The injection happens inside iOS's own `locationd` daemon via a trusted developer channel. The simulated location is indistinguishable from real GPS to any app reading `CLLocation`. The `CLLocationSourceInformation.isSimulatedBySoftware` flag is set to `true` by iOS when this path is used — this is the known limitation and detection vector (see Section 8).

### 1.4 Success metrics

| Metric | Target |
|--------|--------|
| Time from USB connect to active session | < 15 seconds (including pairing check) |
| Location injection fidelity | Accepted by iOS locationd 100% of attempts |
| Battery life (active session, SBC + phone charging disabled) | ≥ 8 hours |
| Cover route believability (movement pattern) | > 85% of observers cannot distinguish from real movement |
| iOS version compatibility | iOS 16.0 through latest (iOS 18+) |
| Session continuity if USB briefly disconnected | Resume within 10 seconds on reconnect |

---

## 2. Users

### 2.1 Primary user

The person carrying the device. They are fully aware their location is being simulated. They want privacy from a specific person or group who has access to their location and cannot or do not want to revoke that access. They are non-technical and do not want to configure software.

### 2.2 Non-users (intentionally excluded)

This device is not designed for:
- Bypassing app-level geofencing for commercial gain
- Game cheating (Pokémon GO, etc.)
- Deceiving law enforcement or court-ordered monitoring
- Any use where the device operator is unaware of the simulation

---

## 3. Hardware requirements

### 3.1 Main compute module

**Primary recommendation:** Raspberry Pi Zero 2W

| Spec | Value |
|------|-------|
| SoC | Broadcom BCM2710A1 (quad-core ARM Cortex-A53, 64-bit, 1 GHz) |
| RAM | 512 MB LPDDR2 |
| Storage | 8 GB microSD (Class 10 / A1 rated minimum) |
| USB | 1× micro-USB OTG (USB 2.0); USB-C adapter for phone connection |
| Wireless | 802.11b/g/n Wi-Fi + Bluetooth 4.2 (unused in Phase 1) |
| Dimensions | 65mm × 30mm × 5mm |
| Idle current | ~100 mA @ 5V |
| Active current | ~200 mA @ 5V (peak) |

**Why Pi Zero 2W over Pi Pico:**
The Raspberry Pi Pico is a microcontroller (RP2040), not a Linux SBC. It cannot run Python, usbmuxd, or the RemoteXPC tunnel stack required for iOS 17+. The Pi Zero 2W runs a full Linux kernel and is the smallest off-the-shelf board that supports the complete protocol stack. The "Pico" naming in this context refers to the form-factor goal (small/pico-sized), not the RP2040 product.

**Alternative SBCs (evaluated):**

| Board | Pros | Cons |
|-------|------|------|
| Orange Pi Zero 2W | Cheaper, similar specs | Less community support, USB OTG less tested |
| CM4 + custom carrier | More RAM, better thermals | Larger, more expensive, overkill |
| Radxa Zero 3W | Slightly faster | Less documentation for USB OTG gadget mode |

The Pi Zero 2W is the recommended choice for Phase 1 due to ecosystem maturity and community support for usbmuxd/pymobiledevice3 on Raspberry Pi OS.

### 3.2 USB connection architecture

The device connects to the iPhone using a USB-C to USB-C (or USB-C to Lightning) cable. The Pi Zero 2W's micro-USB OTG port operates in **USB host mode** — it acts as the host, the iPhone as the device. A USB-C adapter sits on the Pi end; the phone end matches the iPhone model.

For iOS 17.0–17.3, the connection requires enabling a non-standard CDC-NCM USB interface via a `usbmuxd` environment variable (`USBMUXD_DEFAULT_DEVICE_MODE=3`). For iOS 17.4+ and iOS 16.x, standard usbmuxd operation suffices.

### 3.3 Non-volatile storage

The SD card serves as primary storage. Routes are stored as `.grf` files in `/var/ghost/routes/`. An 8 GB card provides substantial headroom:

| Content | Size |
|---------|------|
| Linux OS (minimal, read-only root) | ~1.2 GB |
| Python runtime + pymobiledevice3 | ~80 MB |
| Ghost daemon + config | ~5 MB |
| 50 × 1-hour routes @ ~43 KB each | ~2.2 MB |
| Logs (capped, rotating) | < 100 MB |
| Free headroom | ~6.5 GB |

Route data is stored in a read-write `/data` partition, separate from the read-only OS partition, to survive filesystem corruption from power loss.

### 3.4 Power

The device is powered by an integrated LiPo battery with USB-C passthrough charging. Two form factor SKUs are planned:

| SKU | Battery | Runtime | Dimensions |
|-----|---------|---------|------------|
| Compact | 2000 mAh | ~8 hours | ~85mm × 54mm × 12mm |
| Extended | 5000 mAh | ~20 hours | ~100mm × 60mm × 15mm |

Power circuit requirements:

| Component | Spec |
|-----------|------|
| Battery | LiPo, 3.7V nominal |
| PMIC | TP4056 or MCP73831 for charge management |
| 5V boost converter | MT3608 or similar for Pi supply |
| USB-C input | 5V/2A (charges battery; also powers Pi directly when connected) |
| Fuel gauge | MAX17048 or LC709203F (I²C) |
| USB data passthrough | No — USB-C port is power-only on the charger side; data runs from Pi's OTG port via separate cable to phone |

> Note: The phone charges from the Pi's USB OTG port in passthrough mode via a software-controlled USB power switch (e.g., MAX14578). This keeps the phone charged during long sessions but is an optional feature in Phase 1.

### 3.5 Physical indicators

| Component | Spec |
|-----------|------|
| LED | Single RGB LED (WS2812B or discrete RGB with 3 PWM GPIOs) |
| Button | 1× tactile button (3.3V GPIO, software-debounced) |
| Enclosure | 3D-printed or injection-molded ABS, no exposed ports except USB-C (power) and USB-C (phone) |

### 3.6 Certification requirements

| Certification | Required for | Notes |
|---------------|-------------|-------|
| FCC Part 15B | US market | Unintentional radiator only; no RF transmitter active |
| CE / RED | EU market | EMC compliance |
| RoHS | Material compliance | Standard |
| Apple MFi | **Not required** | DVT path uses USB host; no MFi chip or certification needed |
| Bluetooth SIG | Not required | BLE not used in Phase 1 |

> MFi is explicitly not required. The DVT `simulate-location` path is a standard USB host-to-device communication that does not use any Apple proprietary MFi protocols. Apple certifies MFi for accessories in the `EAAccessory` framework path; the developer DVT path is separate and MFi-independent.

---

## 4. Software / firmware requirements

### 4.1 Operating system

**Base:** Raspberry Pi OS Lite (64-bit, Bookworm), headless configuration.

The root filesystem runs **read-only** after initial setup to protect against SD card corruption from abrupt power loss (the user will yank the battery without warning). A small read-write `/data` partition holds routes, the pairing record, and logs.

Key OS configuration:
- Disable all unused services (Bluetooth, Wi-Fi, HDMI, audio, camera)
- `tmpfs` on `/tmp` and `/var/log`
- Watchdog timer enabled (hardware watchdog via `bcm2835_wdt`)
- `systemd-journald` writing to RAM only, flushing to `/data/logs` on clean shutdown
- Automatic NTP sync on Wi-Fi connect (optional, for RTC-less operation)

### 4.2 Ghost daemon (`ghostd`)

A Python 3 systemd service that manages the full session lifecycle.

**Dependencies:**
- `pymobiledevice3` ≥ 4.x (pure Python; no native Apple frameworks)
- `usbmuxd` (system package)
- `python3-cryptography`, `python3-construct`, `python3-click`

**Daemon responsibilities:**

```
1. On startup:
   - Load active route from /data/routes/active.grf
   - Start usbmuxd if not running
   - Begin polling for USB device connection

2. On iPhone detected (usbmux event):
   - Check pairing record in /data/pairing/
   - If not paired: LED = amber pulse, wait for user to tap Trust on phone
   - If paired: proceed immediately

3. On paired device connected:
   - Mount Developer Disk Image (pymobiledevice3 mounter auto-mount)
   - iOS < 17.4: attempt standard lockdown DVT path
   - iOS ≥ 17.4: run `pymobiledevice3 lockdown start-tunnel` as privileged subprocess
   - Establish tunnel; obtain RSD host/port
   - Call DVT simulate-location with first waypoint
   - LED = green solid
   - Begin 1 Hz playback loop

4. Playback loop (1 Hz timer):
   - Advance waypoint index by speed_multiplier
   - Apply believability jitter (±0–4m Gaussian)
   - Vary reported accuracy between 3–8m
   - Call dvt.simulate_location(lat, lon)
   - On loop end: restart from waypoint 0 if route has loop flag set
   - Write heartbeat to /data/status.json

5. On USB disconnect:
   - LED = amber pulse
   - Hold last known state for 30 seconds
   - On reconnect within 30s: resume session
   - On timeout: LED = red flash, session ended

6. Session control via GPIO button:
   - Single tap: toggle play/pause
   - Double tap: cycle speed (1× → 2× → 4× → 1×)
   - Hold 3s: shutdown (clean unmount, sync, power off)

7. On session end or shutdown:
   - Send dvt.simulate_location_clear()
   - Log session end to /data/sessions.db
```

### 4.3 iOS version compatibility matrix

| iOS Version | Protocol | Tunnel Method | Notes |
|-------------|----------|---------------|-------|
| 16.0–16.7 | lockdownd DVT | Standard usbmuxd | Simplest path; no tunnel needed |
| 17.0–17.3 | RemoteXPC | CDC-NCM via `USBMUXD_DEFAULT_DEVICE_MODE=3` | Requires patched usbmuxd; CDC-NCM kernel module |
| 17.4+ | RemoteXPC | `lockdown start-tunnel` (CoreDeviceProxy) | Clean path; works with unmodified usbmuxd |
| 18.x | RemoteXPC | Same as 17.4+ | Confirmed working as of 18.3 |

The `ghostd` daemon auto-detects iOS version from the device record returned by usbmux and selects the appropriate path. No user configuration required.

### 4.4 Developer mode requirement

iOS 16+ requires Developer Mode to be enabled on the phone for DVT services to be accessible. This is a one-time, per-device setting:

**Settings → Privacy & Security → Developer Mode → Enable**

The device prompts the user (via the companion app notification, or via a QR code in the packaging) to enable Developer Mode before first use. This is the only manual iOS configuration step required. Developer Mode persists across reboots and iOS updates; it does not need to be re-enabled.

> Developer Mode does not expose the phone to any additional risk beyond allowing USB-based developer tooling. It does not jailbreak the device, does not affect App Store restrictions, and is reversible.

### 4.5 Pairing

The first time a Ghost Device connects to a specific iPhone, iOS displays a "Trust This Computer?" dialog. The user taps **Trust** and enters their passcode. This creates a pairing record stored in `/data/pairing/` on the device and in the Secure Enclave on the phone. Pairing is persistent and survives reboots on both sides. It must be re-established only if the user explicitly removes trusted computers from iPhone settings.

The Ghost companion app handles the pairing prompt UX — it detects when the device is not yet paired and guides the user through the Trust flow.

### 4.6 DDI (Developer Disk Image) management

For iOS < 17, a Developer Disk Image (DDI) must be mounted on the phone before DVT services are accessible. `pymobiledevice3 mounter auto-mount` handles this automatically — it downloads the correct DDI for the detected iOS version from Apple's CDN and mounts it. For iOS 17+, DDI mounting is handled via Personalized Developer Disk Images (PDDI) fetched per-device from Apple.

The DDI is fetched once per iOS version and cached on the device's `/data/ddi/` directory to avoid repeated downloads.

### 4.7 Route playback engine

The playback engine reads from GRF binary files (see Section 5.1) and feeds coordinates to DVT at 1 Hz.

**Per-tick logic:**
1. Read waypoint at current index
2. Advance index by `speed_multiplier` (1, 2, or 4)
3. If skipping waypoints (speed > 1×), interpolate intermediate position
4. Apply believability noise:
   - Lat/lon: Gaussian jitter, σ = 1.5m
   - Horizontal accuracy: random in range [3.0, 8.0] meters
   - Altitude: smooth variation ±0.5m from stored value
5. Call `dvt.simulate_location(lat, lon)` via pymobiledevice3 Python API
6. On route end: loop if flag set, else hold last waypoint

Speed multiplier is controlled by button double-tap and visible via LED pulse rate.

### 4.8 LED and button behavior

#### LED states

| Color | Pattern | Meaning |
|-------|---------|---------|
| White | Slow pulse (3s) | Booting / initializing |
| Amber | Pulse (1s) | Waiting for phone connection |
| Amber | Fast pulse | Waiting for Trust / pairing |
| Blue | Solid | Phone connected, session inactive |
| Green | Solid | Session active, playing at 1× |
| Green | Fast pulse (0.5s) | Session active, playing at 2×+ |
| Red | Single flash | Error (see logs) |
| Red | Double flash | Low battery (<10%) |
| Off | — | Deep sleep / powered off |

#### Button behavior

| Action | Result |
|--------|--------|
| Single tap | Toggle play / pause |
| Double tap | Cycle speed (1× → 2× → 4× → 1×) |
| Hold 3s | Clean shutdown |
| Hold 5s during session | Emergency stop: clear simulated location, disconnect |

### 4.9 OTA firmware updates

The device checks for firmware updates on Wi-Fi connect (if Wi-Fi is configured). Updates are atomic: the new image is written to a secondary partition and only activated on verified checksum. If the updated system fails to boot (watchdog timeout), it falls back to the previous partition automatically.

The Ghost companion app can also push firmware updates over USB when the phone is connected.

---

## 5. Data formats

### 5.1 Ghost Route Format (GRF) — unchanged from v1.0

```
Header (16 bytes):
  [0–3]   Magic: 0x47524654 ("GRFT")
  [4–7]   Route ID (uint32, server-assigned)
  [8–9]   Waypoint count (uint16, max 86,400 = 24 hours at 1Hz)
  [10]    Recording interval in seconds (uint8)
  [11]    Flags (bit 0: looping, bit 1: has altitude, bit 2: reserved)
  [12–15] Creation epoch (uint32)

Waypoint record (12 bytes each):
  [0–3]   Latitude  (int32, degrees × 1e7, WGS84)
  [4–7]   Longitude (int32, degrees × 1e7, WGS84)
  [8–9]   Altitude  (int16, meters MSL, signed)
  [10]    Speed     (uint8, km/h, max 255)
  [11]    Bearing   (uint8, degrees / 1.41, 0–254 maps to 0–358°)
```

A 1-hour route at 1 Hz = 16 + (3600 × 12) = 43,216 bytes (~42 KB).

### 5.2 Status file (`/data/status.json`)

Written by `ghostd` every 5 seconds during active sessions. Read by the companion app over USB for real-time UI updates.

```json
{
  "state": "playing",
  "route_id": "uuid",
  "route_name": "Lincoln Park morning walk",
  "waypoint_index": 1842,
  "waypoint_total": 3600,
  "speed_multiplier": 1,
  "battery_pct": 74,
  "ios_version": "18.2",
  "session_start_epoch": 1742800000,
  "ghostd_version": "2.1.0"
}
```

### 5.3 Session log (`/data/sessions.db`)

SQLite database, never transmitted to server.

```sql
CREATE TABLE sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  INTEGER NOT NULL,  -- unix epoch
  ended_at    INTEGER,
  route_id    TEXT NOT NULL,
  waypoints_played INTEGER DEFAULT 0,
  end_reason  TEXT   -- 'user_stop' | 'usb_disconnect' | 'battery' | 'error'
);
```

---

## 6. Companion app communication

The Ghost companion app communicates with the device over two channels:

### 6.1 USB file access (AFC protocol)

When the phone is connected and trusted, `ghostd` exposes the `/data/routes/` and `/data/status.json` directories via AFC (Apple File Conduit, part of the lockdownd protocol stack). The companion app can:
- Read `status.json` for live session state
- Push new `.grf` route files to `/data/routes/`
- Read `sessions.db` for session history display
- Trigger `play`, `pause`, `stop`, `set_speed`, `set_route` commands via a command socket

### 6.2 Command socket

`ghostd` listens on a Unix domain socket (`/tmp/ghost.sock`) exposed to the companion app via an AFC-proxied TCP tunnel. The companion app sends JSON command messages:

```json
{ "cmd": "play" }
{ "cmd": "pause" }
{ "cmd": "stop" }
{ "cmd": "set_speed", "multiplier": 2 }
{ "cmd": "set_route", "route_id": "uuid" }
{ "cmd": "status" }
```

This allows the companion app to serve as a full control surface without requiring any BLE infrastructure.

---

## 7. Manufacturing and supply chain

- **Assembly:** Off-the-shelf Pi Zero 2W + custom carrier PCB (power management, USB switching, LED/button)
- **Carrier PCB:** 2-layer, OSHPark or JLCPCB production
- **SD card:** Pre-flashed with Ghost OS image + default routes; sealed with read-only root
- **Programming:** SD card image flashing during manufacturing; OTA in field
- **Test:** Automated USB connection + DVT location injection test fixture; verify location appears in Maps on test iPhone
- **Packaging:** Retail box with USB-C cable (0.5m), USB-C power cable, quick-start card with QR code

---

## 8. Known limitations and detection risks

### 8.1 `isSimulatedBySoftware` flag

iOS sets `CLLocationSourceInformation.isSimulatedBySoftware = true` on all locations delivered via the DVT path (iOS 15+). Any app that checks this flag can detect that location is being simulated. This is the primary detection vector.

**Current status of target apps:**
- **Find My:** Does not currently check this flag in production (as of testing through iOS 18.x). Uses CLLocation directly.
- **Life360:** Internal engineering blog shows they use the DVT path themselves for testing, suggesting they do not block it in production. No confirmed production check observed.
- **Snapchat:** Not confirmed; should be empirically tested before launch.
- **Google Maps:** Does not check; uses CLLocation.

This must be empirically verified against each target app before launch and monitored on each app update. The companion app should surface a warning if the connected iOS version is confirmed to expose this flag to a specific app.

### 8.2 Developer Mode visibility

Developer Mode shows a small indicator in Settings → Privacy & Security. A motivated inspector examining the phone's settings could notice it. This is a known and accepted limitation for the v2.0 architecture; mitigations are out of scope for Phase 1.

### 8.3 USB cable requirement

The user must keep the Ghost Device physically connected via USB cable while the session is active. If the cable is disconnected:
- `ghostd` detects the disconnect within 1 second
- iOS location reverts to real GPS after a short delay (typically 2–5 seconds, device-dependent)
- `ghostd` attempts reconnect for 30 seconds; if the cable is re-inserted within that window, the session resumes automatically

The USB cable is a physical tell. The device should be small enough to keep in a bag or pocket with the cable routed unobtrusively.

### 8.4 Wi-Fi/cell location cross-check

iOS fuses GPS, Wi-Fi, and cellular signal data into its location estimate. The DVT simulation overrides the GPS component, but iOS may blend in Wi-Fi/cell positioning if confidence in the simulated GPS is low. In practice, the DVT override dominates because it feeds `locationd` directly. However, some implementations of Life360 and other apps make independent network-based location requests to Google/Apple location APIs using Wi-Fi scan data. This is a server-side cross-check that the device cannot defeat.

**Mitigation:** The iToolsBT community discovered that blocking `apple-dns.net` and related Apple location verification domains via DNS (e.g., NextDNS) suppresses the Wi-Fi cross-check. The Ghost app should offer an optional DNS profile install that applies this mitigation for users who need maximum coverage.

---

## 9. Open questions

| # | Question | Owner | Due |
|---|----------|-------|-----|
| 1 | Form factor: integrated enclosure vs "kit" (bare board + cable)? | Design | — |
| 2 | Should the device provide USB power passthrough to charge the phone during sessions? | Hardware | — |
| 3 | DNS blocking mitigation: build into device as optional mode, or leave to companion app? | Product | — |
| 4 | iOS 17.0–17.3 support: invest in patched usbmuxd or declare minimum iOS 16 / 17.4+? | Engineering | — |
| 5 | Route recording via device's own Wi-Fi (geolocation) — feasible and desirable? | Product | — |
| 6 | Multiple simultaneous device support (one Ghost per phone vs shared)? | Engineering | — |
| 7 | Carrier PCB design: custom or off-the-shelf hat/bonnet? | Hardware | — |
| 8 | Empirical detection testing: hire security researcher to audit isSimulatedBySoftware exposure in Life360, Find My, Snapchat? | Security | Before launch |
