# PRD: Ghost App — iOS Companion Application

**Version:** 2.0  
**Status:** Draft  
**Last updated:** 2026-03-24

> **Architecture change from v1.0:** The app no longer acts as a location bridge. In v1.0, the app was responsible for receiving NMEA data from a BLE device and injecting it into iOS via CoreLocation — a path that cannot achieve system-wide override without MFi. In v2.0, the Ghost Device itself performs the location injection via USB. The app's role is: (1) session control and status display, (2) route management and transfer to the device, and (3) first-time setup and pairing guidance. The app is now genuinely lightweight — it is a control surface, not a protocol bridge.

---

## 1. Overview

### 1.1 Product summary

Ghost App is the iOS companion to the Ghost Device hardware. It serves three roles: (1) it provides the user with a simple, discreet control surface for managing their privacy session; (2) it manages route acquisition from the Ghost Server, local storage, and transfer to the device over USB; and (3) it guides the user through first-time device setup including the iOS Developer Mode and Trust prompts.

The location injection itself happens entirely on the Ghost Device — the app does not participate in the injection path and does not require any special location permissions to operate the core session feature.

### 1.2 Core design principles

**Discreet by default.** The app's icon, name, and UI should not immediately reveal its function to a casual observer. Recommended name: "Ghost" with a neutral icon. No map pins, no GPS symbols on the icon.

**Zero ambiguity about simulation.** Every session must begin with a clear, explicit statement that the phone's location is being simulated. The user consents actively. This is both an ethical requirement and an App Store compliance mechanism.

**Minimal permissions footprint.** Because the app is no longer a location bridge, it does not need `Always` location permission. The reduced permissions profile makes App Store review simpler and makes the app less suspicious if inspected.

**Reliable, not feature-heavy.** The primary job is to give the user confidence that their session is running. UI is secondary to session clarity.

### 1.3 Success metrics

| Metric | Target |
|--------|--------|
| Time from app open to confirmed active session | < 20 seconds (includes USB connection check) |
| Route download + transfer to device | < 15 seconds for a 1-hour route |
| App Store approval | No privacy or guideline rejections |
| App size | < 15 MB |
| Session status refresh latency | < 2 seconds from device state change |

---

## 2. Users

### 2.1 Primary user

A person who owns a Ghost Device and wants to protect their location from specific contacts who have location-sharing access. They are non-technical. They understand they are simulating a location. They are potentially in a situation that requires safety — the UX must not be condescending or over-explain the ethics of the product.

### 2.2 Threat model context

The app should be designed with the understanding that the user's phone may be subject to casual inspection by the person they are protecting their location from. The app should not display the user's real location anywhere in its UI. All map previews show only the cover route.

---

## 3. iOS technical requirements

### 3.1 Entitlements

| Entitlement | Purpose | Required? |
|-------------|---------|-----------|
| `NSLocationWhenInUseUsageDescription` | Displaying cover route on in-app map preview only | Optional (map feature) |
| `UIBackgroundModes: fetch` | Periodic route sync in background | Yes |
| `com.apple.security.files.user-selected.read-write` | Route import from Files app | Yes |

> Note: `NSLocationAlwaysAndWhenInUseUsageDescription` and `UIBackgroundModes: location` are **not required** in v2.0. The app is no longer a location bridge. This significantly simplifies App Store review positioning — the app does not need to justify requesting `Always` location permission.

The map preview feature (showing the cover route's path) can use a static MKMapView with a MKPolyline overlay derived from the route's waypoints — no live CLLocation needed.

### 3.2 Frameworks

| Framework | Use |
|-----------|-----|
| `libimobiledevice` / AFC | USB file access to device (route push, status read) |
| `Network` | Server API calls; command socket to device |
| `CryptoKit` | Route data decryption (AES-256-GCM) |
| `MapKit` | Cover route preview (static overlay only) |
| `BackgroundTasks` | Periodic route sync |
| `UserNotifications` | Session status alerts |

> The app communicates with the Ghost Device via the AFC (Apple File Conduit) USB protocol, not BLE. This is the same protocol iTunes uses for file transfers. No special entitlements are required for this path beyond standard USB accessory communication.

### 3.3 Device communication

The app communicates with the connected Ghost Device over two channels, both over USB:

**Status polling:** The app reads `/data/status.json` from the device via AFC every 2 seconds to update the session state display. This is a simple HTTP-style file read over the USB tunnel.

**Command channel:** The app sends JSON commands to the `ghostd` command socket (proxied over USB via a lockdown TCP tunnel). This controls play/pause/stop/speed/route selection without requiring BLE.

**Route transfer:** `.grf` files are pushed to the device's `/data/routes/` directory via AFC. The transfer is fast (~43 KB / 1-hour route over USB 2.0 = effectively instantaneous).

---

## 4. Feature requirements

### 4.1 Onboarding

**First launch only.** A clear, non-skippable onboarding flow:

1. **Screen 1 — What this does:** "Ghost replaces your phone's GPS with a pre-recorded route. Every app that reads your location — including Find My, Life360, and Maps — will see this route instead of where you actually are."
2. **Screen 2 — What this doesn't do:** "Ghost does not hide your cellular or Wi-Fi network location from your carrier. It does not affect iCloud account location. It is not designed to deceive apps or services for financial gain or game cheating."
3. **Screen 3 — Your consent:** "I understand my location will be simulated. I am using this for my own privacy." — explicit checkbox, not pre-checked.
4. **Screen 4 — Device setup:** Step-by-step guide to:
   - Enable Developer Mode on iPhone (Settings → Privacy & Security → Developer Mode)
   - Connect Ghost Device via USB-C
   - Tap "Trust" when prompted by iOS

Onboarding is stored as completed after the consent screen. It cannot be re-triggered but can be reviewed in Settings.

### 4.2 Home screen

The home screen has exactly three states:

**State A — Device not connected**
- Large status label: "Not connected"
- Subtext: "Connect your Ghost Device with a USB-C cable."
- USB connection indicator (animated cable icon)
- Route library shortcut

**State B — Connected, session inactive**
- Device status indicator (green dot + "Ghost Device connected")
- Device battery %
- Active route name and duration
- "Start Session" primary button (prominent)
- Speed selector (1× / 2× / 4×)
- Route selector

**State C — Session active**
- Persistent top banner: "Location privacy active" (subtle, not alarming)
- Mini map showing current position on cover route (static overlay; position marker advances along the route path — sourced from `status.json` waypoint index, not from CLLocation)
- Progress indicator: time elapsed / route duration
- Speed selector
- "End Session" button (requires confirmation)
- Session timer

> The map in State C shows what other apps see. It is derived entirely from the route file and the current waypoint index reported by the device — the app's real GPS location is never read or displayed.

### 4.3 Route library

A list view of all available cover routes. Each route card shows:
- Route name (user-editable)
- Duration
- General area description (e.g., "Residential neighborhood — ~2.1 km loop")
- No actual coordinates or map unless user explicitly taps to preview

**Route sources:**
- Downloaded from Ghost Server (curated library)
- Imported via `.grf` file (AirDrop, Files app)
- Recorded via iOS location (optional: app records a real walk using device GPS and saves as `.grf`) — off by default, requires explicit user action

**Route preview:** Tapping a route shows a static MKMapView with the cover route drawn as a MKPolyline. User location dot is disabled. The map region is set from the route's bounding box of waypoints.

### 4.4 Route transfer to device

When user selects a route and taps "Load to Device":
1. Verify Ghost Device is USB-connected
2. Check if route is already present on device (compare checksum against device manifest)
3. If not present: push `.grf` file via AFC to `/data/routes/`
4. Send `set_route` command over command socket with route ID
5. Confirm with "Route loaded" toast

Estimated transfer time: 1-hour route (~43 KB) over USB 2.0 = < 1 second. Progress bar shown for large route batches.

### 4.5 Session management

**Starting a session:**
1. Verify Ghost Device USB-connected
2. Verify route loaded on device (check `status.json`)
3. Send `play` command over command socket
4. Poll `status.json` to confirm state transitions to `playing`
5. Log session start to local SQLite

**Ending a session:**
1. Confirmation alert: "End location privacy session? Your real location will resume."
2. Send `stop` command over command socket
3. Poll `status.json` to confirm state transitions to `idle`
4. Log session end

**Session persistence:** If the app is killed while a session is active on the device, the device continues running the session independently. On relaunch, the app reads `status.json` to discover the active session and resumes the UI in State C without interrupting the injection.

**USB disconnect handling:** If the cable is disconnected during a session, the app shows a full-screen alert: "Cable disconnected — your real location may be visible. Reconnect to resume." The device attempts automatic reconnect for 30 seconds.

> Critical note: the session runs on the device, not in the app. The app crashing or being force-quit does NOT end the session. This is the core architectural improvement over v1.0.

### 4.6 First-time setup flow

For users who have not yet enabled Developer Mode or paired their device, the app surfaces a guided setup flow:

**Step 1 — Developer Mode**
- Deep link to Settings → Privacy & Security → Developer Mode
- Inline screenshot showing exactly where to tap
- Detection: app polls for successful pairing response to determine if DVT is accessible

**Step 2 — Trust this computer**
- Instructions: "When you connect the Ghost Device for the first time, iOS will ask if you trust it. Tap Trust and enter your passcode."
- Visual: illustration of the Trust dialog
- After Trust: LED turns from amber to blue

This flow is shown once per iPhone. The app tracks setup completion in UserDefaults.

### 4.7 Device management

- View device firmware version
- Check for firmware updates (triggers OTA download on device)
- View session history (duration, route used — pulled from device's `sessions.db`)
- Rename device (writes to device config file)
- Factory reset device (wipes routes, sessions, pairing records)

### 4.8 Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Auto-start on connect | Off | Send `play` automatically when USB connects and a route is loaded |
| Notifications | On | Alert when session ends unexpectedly (USB disconnect) |
| Route sync | On (Wi-Fi only) | Auto-download new routes from server |
| App lock | Off | Require Face ID / passcode to open app |
| Stealth mode | Off | Minimal decoy UI when app is accessed from multitasking |
| DNS privacy mode | Off | Install NextDNS profile blocking Apple location verification domains |

### 4.9 Stealth mode

When enabled:
- App shows a minimal clock/weather screen when accessed via the iOS app switcher without authentication
- Real UI requires Face ID / passcode to reveal
- App name in share sheets replaced with a generic name ("Utilities")

### 4.10 DNS privacy mode

When enabled, the app installs a DNS-over-HTTPS profile (using NextDNS or a Ghost-operated resolver) that blocks Apple's location verification domains (`gs.apple.com`, `apple-dns.net`, and related hosts used for Wi-Fi-based cross-check). This prevents iOS from supplementing the simulated GPS with Wi-Fi-derived position data that could be served back to location-tracking apps. The user is clearly informed that this installs a VPN/DNS profile visible in Settings.

---

## 5. App Store submission

### 5.1 Category
Utilities

### 5.2 App description framing
"Ghost is a location privacy tool. Connect a Ghost Device to replace your phone's GPS with a pre-recorded route, giving you control over what location is shared with others."

### 5.3 Review notes for Apple
- App requires physical hardware (Ghost Device) to function; core location feature is not testable without the hardware
- App does not request `Always` location permission; location permission is only requested if the user opts into the in-app route recording feature
- The app communicates with the connected hardware accessory over USB using standard file transfer protocols
- No real location data is collected, stored, or transmitted by the app
- User provides explicit informed consent before any location simulation begins

### 5.4 Age rating
17+

---

## 6. Server API integration

See Server PRD for full API spec. App-side requirements:
- Authenticate with JWT (stored in Keychain, not UserDefaults)
- Route downloads use resumable downloads (support background download continuation)
- All API calls use certificate pinning
- Offline mode: app is fully functional without network if routes are cached locally

---

## 7. Privacy and data handling

| Data type | Where stored | Sent to server |
|-----------|-------------|----------------|
| User's real location | Never stored by app | Never |
| Cover route coordinates | Local (app cache) + device flash | Routes downloaded from server only |
| Session logs | On device (`sessions.db`); mirrored locally | Never |
| Account credentials | iOS Keychain, OAuth | Auth tokens only |
| Device pairing info | Stored on device; not in app | Never |

**No analytics SDK.** The app shall not include any third-party analytics, crash reporting that phones home, or advertising frameworks.

---

## 8. Non-functional requirements

| Requirement | Target |
|-------------|--------|
| iOS minimum version | iOS 16.0 |
| App size | < 15 MB |
| Launch time | < 1.5 seconds to interactive |
| Accessibility | VoiceOver supported on all primary flows (Phase 2) |
| Localization | English (Phase 1); Spanish, French, German (Phase 2) |
| Dark mode | Full support |

---

## 9. Open questions

| # | Question | Owner | Due |
|---|----------|-------|-----|
| 1 | Stealth mode app name — legal review needed | Legal | — |
| 2 | DNS privacy mode: operate Ghost's own resolver or partner with NextDNS? | Engineering | — |
| 3 | Android version: DVT equivalent is ADB `am set-mock-location` — timeline? | Engineering | — |
| 4 | In-app purchase model vs hardware bundle vs subscription? | Business | — |
| 5 | Should session logs be exportable from device? | Product | — |
| 6 | App Store risk: does requesting no location permission make review easier, or does Apple still scrutinize based on app description? | Legal | Before submission |
