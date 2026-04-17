# PRD: Ghost Server — Backend Platform

**Version:** 2.0  
**Status:** Draft  
**Last updated:** 2026-03-24

> **Changes from v1.0:** The server PRD is largely unchanged — the backend's job (route delivery, auth, firmware distribution) is the same regardless of the injection mechanism on the device. Three changes are made: (1) the `devices` table and registration API are updated to reflect the new hardware identity (Pi-based SBC with serial number, not BLE MAC address), (2) a new `firmware_releases` hardware revision type is added for the Linux image, and (3) a new optional `dns_profiles` endpoint is added to serve the DNS privacy configuration used by the app's opt-in DNS blocking feature.

---

## 1. Overview

### 1.1 Product summary

Ghost Server is the backend platform that supports the Ghost ecosystem. Its responsibilities are: user account management, a curated cover route library, route delivery to client apps, device registration, firmware distribution, and optional cloud sync. It does not receive, store, or process any real location data from users — by design and by policy.

### 1.2 Design philosophy

**Minimal data collection.** The server should know as little as possible about users. No real location is ever sent to the server. Session metadata (which route was played, when) is stored locally on the device only and is never transmitted. The server's primary function is a route content delivery platform, not a surveillance tool.

**Stateless where possible.** Routes are downloaded and cached on-device. The server does not need to be online for the device or app to function after initial setup.

### 1.3 Success metrics

| Metric | Target |
|--------|--------|
| Route download latency (p95) | < 2 seconds for a 1-hour route |
| API uptime | 99.9% monthly |
| Route library size at launch | ≥ 20 curated routes across 5+ cities |
| Auth token issuance | < 200ms p99 |
| Zero real location data stored | Verified by architecture — no field for it exists |

---

## 2. Architecture

### 2.1 Stack recommendation

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20 LTS or Go 1.22 |
| API framework | Fastify (Node) or Chi (Go) |
| Database | PostgreSQL 16 |
| Object storage | S3-compatible (AWS S3 or Cloudflare R2) — for route files and firmware images |
| Cache | Redis 7 |
| Auth | JWT (RS256) + refresh token rotation |
| CDN | Cloudflare (route file and firmware delivery) |
| Hosting | AWS (us-east-1 primary, eu-west-1 secondary) |
| TLS | TLS 1.3 minimum; certificate pinned in app |

### 2.2 Services

```
ghost-api          Main REST API (accounts, routes, devices, firmware)
ghost-worker       Background jobs (route processing, push notifications)
ghost-cdn          Route and firmware delivery via Cloudflare CDN
```

---

## 3. Data model

### 3.1 Users table

```sql
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,           -- bcrypt, cost 12
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  account_status TEXT DEFAULT 'active',  -- active | suspended | deleted
  subscription_tier TEXT DEFAULT 'free'  -- free | pro
);
```

**Deliberately absent:** real location, IP address log, device location history, session content.

### 3.2 Devices table

Updated from v1.0. `hardware_id` is now derived from the SBC's serial number (available via `/proc/cpuinfo` on Pi), not a BLE MAC address. `hardware_rev` reflects the Linux image variant.

```sql
CREATE TABLE devices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  device_name     TEXT NOT NULL,
  hardware_id     TEXT UNIQUE NOT NULL,  -- Pi serial number (from /proc/cpuinfo), set at registration
  hardware_rev    TEXT NOT NULL,         -- e.g. "pi-zero-2w-v1", "orange-pi-zero-v1"
  firmware_version TEXT,                 -- ghost-os semver, e.g. "2.1.0"
  registered_at   TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ            -- last API contact, not location
);
```

### 3.3 Routes table

Unchanged from v1.0.

```sql
CREATE TABLE routes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  description     TEXT,
  area_label      TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL,
  distance_meters  INTEGER NOT NULL,
  waypoint_count   INTEGER NOT NULL,
  file_key        TEXT NOT NULL,
  file_size_bytes  INTEGER NOT NULL,
  checksum_sha256  TEXT NOT NULL,
  is_public       BOOLEAN DEFAULT true,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  tags            TEXT[]
);
```

### 3.4 User route library table

Unchanged from v1.0.

```sql
CREATE TABLE user_routes (
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  route_id    UUID REFERENCES routes(id) ON DELETE CASCADE,
  added_at    TIMESTAMPTZ DEFAULT NOW(),
  custom_name TEXT,
  PRIMARY KEY (user_id, route_id)
);
```

### 3.5 Firmware releases table

Updated from v1.0. Now covers both `ghostd` Python daemon packages and full Ghost OS Linux images. `hardware_rev` values reflect the SBC platform.

```sql
CREATE TABLE firmware_releases (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version         TEXT NOT NULL,            -- semver e.g. "2.1.0"
  hardware_rev    TEXT NOT NULL,            -- "pi-zero-2w-v1", "orange-pi-zero-v1"
  release_type    TEXT NOT NULL,            -- "full-image" | "daemon-only"
  file_key        TEXT NOT NULL,
  file_size_bytes INTEGER NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  min_ios_version TEXT,                     -- e.g. "16.0" (for compatibility notes)
  release_notes   TEXT,
  is_stable       BOOLEAN DEFAULT false,
  released_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(version, hardware_rev)
);
```

`release_type` distinguishes between:
- `full-image`: A complete flashable SD card image (used for new devices and major updates)
- `daemon-only`: A `.tar.gz` containing only the updated `ghostd` Python package (used for minor updates, applied in-place via OTA without reflashing)

---

## 4. API specification

Base URL: `https://api.ghost.app/v1`

All endpoints require TLS 1.3. All request/response bodies are JSON. All authenticated endpoints require `Authorization: Bearer <jwt>`.

---

### 4.1 Authentication

#### POST /auth/register

**Request:**
```json
{
  "email": "user@example.com",
  "password": "minimum 10 characters"
}
```

**Response 201:**
```json
{
  "user_id": "uuid",
  "access_token": "jwt",
  "refresh_token": "opaque string",
  "expires_in": 3600
}
```

**Errors:** 409 email already exists, 422 validation failed

---

#### POST /auth/login

**Request:**
```json
{ "email": "...", "password": "..." }
```

**Response 200:** Same shape as register response.

**Rate limiting:** 5 attempts per 10 minutes per IP.

---

#### POST /auth/refresh

**Request:**
```json
{ "refresh_token": "..." }
```

**Response 200:**
```json
{
  "access_token": "jwt",
  "refresh_token": "new opaque string",
  "expires_in": 3600
}
```

Refresh tokens are single-use and rotate on each call. Reuse of a consumed token invalidates the entire token family.

---

#### POST /auth/logout

**Response 204:** No content.

---

### 4.2 Devices

#### POST /devices

Register a new Ghost Device to the authenticated user's account.

**Request:**
```json
{
  "hardware_id": "10000000abcdef12",
  "hardware_rev": "pi-zero-2w-v1",
  "device_name": "My Ghost",
  "firmware_version": "2.0.0"
}
```

`hardware_id` is the Raspberry Pi CPU serial number (from `/proc/cpuinfo`, 16 hex characters).

**Response 201:**
```json
{
  "device_id": "uuid",
  "device_name": "My Ghost",
  "registered_at": "2026-03-24T12:00:00Z"
}
```

---

#### GET /devices

List all devices registered to the authenticated user.

**Response 200:**
```json
{
  "devices": [
    {
      "device_id": "uuid",
      "device_name": "My Ghost",
      "hardware_rev": "pi-zero-2w-v1",
      "firmware_version": "2.0.0",
      "registered_at": "...",
      "last_seen_at": "..."
    }
  ]
}
```

---

#### PATCH /devices/:device_id

Update device name or record firmware version after OTA.

**Request:**
```json
{ "device_name": "New name", "firmware_version": "2.1.0" }
```

**Response 200:** Updated device object.

---

#### DELETE /devices/:device_id

Remove device from account.

**Response 204:** No content.

---

### 4.3 Routes

#### GET /routes

List available routes. Includes both public library routes and routes the user has added.

**Query parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `tags` | string (comma-separated) | Filter by tag: `loop`, `walking`, `driving`, `suburban`, `urban` |
| `min_duration` | integer | Minimum duration in seconds |
| `max_duration` | integer | Maximum duration in seconds |
| `limit` | integer | Default 20, max 100 |
| `offset` | integer | Pagination offset |

**Response 200:**
```json
{
  "routes": [
    {
      "route_id": "uuid",
      "name": "Lincoln Park morning walk",
      "description": "A 45-minute walking loop through a residential neighborhood.",
      "area_label": "Chicago, IL",
      "duration_seconds": 2700,
      "distance_meters": 3200,
      "waypoint_count": 2700,
      "file_size_bytes": 32416,
      "tags": ["loop", "walking", "suburban"],
      "in_library": true
    }
  ],
  "total": 47,
  "limit": 20,
  "offset": 0
}
```

---

#### GET /routes/:route_id

Get metadata for a single route.

**Response 200:** Single route object (same fields as list item, plus `checksum_sha256`).

---

#### GET /routes/:route_id/download

Get a pre-signed download URL for the route's `.grf` file.

**Response 200:**
```json
{
  "url": "https://cdn.ghost.app/routes/uuid.grf?token=...",
  "expires_at": "2026-03-24T12:05:00Z",
  "checksum_sha256": "abc123..."
}
```

URL is valid for 5 minutes. The app downloads directly from CDN.

---

#### POST /routes/library

Add a public route to the user's personal library.

**Request:**
```json
{ "route_id": "uuid" }
```

**Response 201:**
```json
{ "added_at": "2026-03-24T12:00:00Z" }
```

---

#### DELETE /routes/library/:route_id

Remove a route from the user's library.

**Response 204:** No content.

---

#### POST /routes/upload *(Pro tier only)*

Upload a user-recorded route as a private route.

**Request:** `multipart/form-data`
- `file`: `.grf` binary (max 10 MB)
- `name`: string
- `description`: string (optional)

**Processing:**
1. Validate GRF magic bytes and checksum
2. Decode waypoints; verify all coordinates are valid WGS84
3. Store to private S3 prefix
4. Create route record with `is_public = false`, `created_by = user_id`

**Response 201:** Route object.

---

### 4.4 Firmware

#### GET /firmware/latest

Get the latest stable firmware version for a given hardware revision and release type.

**Query parameters:** `hardware_rev=pi-zero-2w-v1&release_type=daemon-only`

**Response 200:**
```json
{
  "version": "2.1.0",
  "hardware_rev": "pi-zero-2w-v1",
  "release_type": "daemon-only",
  "download_url": "https://cdn.ghost.app/firmware/ghostd-2.1.0.tar.gz",
  "checksum_sha256": "...",
  "file_size_bytes": 4194304,
  "min_ios_version": "16.0",
  "release_notes": "Improved iOS 17.4+ tunnel stability; reduced boot time.",
  "released_at": "2026-03-20T00:00:00Z"
}
```

---

#### GET /firmware/check

Check if a device's current firmware is up to date.

**Query parameters:** `hardware_rev=pi-zero-2w-v1&current_version=2.0.0&release_type=daemon-only`

**Response 200:**
```json
{
  "up_to_date": false,
  "latest_version": "2.1.0",
  "update_required": false,
  "release_notes": "Improved iOS 17.4+ tunnel stability; reduced boot time."
}
```

---

### 4.5 DNS profiles *(new in v2.0)*

Supports the app's optional DNS privacy mode, which blocks Apple's location verification domains to prevent Wi-Fi-based location cross-checks from supplementing the simulated GPS.

#### GET /dns-profiles/privacy

Returns a signed iOS `.mobileconfig` profile that installs a DNS-over-HTTPS configuration pointing to a Ghost-operated or NextDNS resolver with the appropriate block list.

**Response 200:** `application/x-apple-aspen-config`

The profile:
- Configures DoH resolver (`https://dns.ghost.app/dns-query` or NextDNS handle)
- Blocks: `gs.apple.com`, `gsp1.apple.com`, `gsp-ssl.ls.apple.com`, `apple-dns.net`, and related Apple location verification hosts
- Is signed with Ghost's Apple-approved MDM certificate
- Displays name: "Ghost Privacy DNS" in Settings → VPN & Device Management

> This endpoint is authenticated. The profile is only served to users with a registered account to prevent abuse.

---

### 4.6 Account

#### GET /account/me

**Response 200:**
```json
{
  "user_id": "uuid",
  "email": "user@example.com",
  "subscription_tier": "pro",
  "created_at": "..."
}
```

---

#### DELETE /account/me

**Request:**
```json
{ "confirm": "DELETE MY ACCOUNT" }
```

**Response 204:** No content. Cascade-deletes devices, user_routes, private routes.

---

## 5. Security requirements

### 5.1 Authentication

- JWT signed with RS256 (2048-bit key pair)
- Access token TTL: 1 hour
- Refresh token TTL: 30 days
- Refresh token family invalidation on reuse
- Passwords hashed with bcrypt, cost factor 12

### 5.2 Transport security

- TLS 1.3 minimum; TLS 1.2 with strong ciphers as fallback
- HSTS preload with `max-age=31536000; includeSubDomains; preload`
- Certificate pinned in iOS app (SHA-256 of leaf certificate)
- Certificate rotation procedure documented and tested annually

### 5.3 Input validation

- All inputs validated and sanitized at the API layer
- SQL queries use parameterized statements only
- Route GRF uploads: validate magic bytes, total size cap 10 MB, waypoint count cap 86,400
- `hardware_id` on device registration: validate as 16-character hex string

### 5.4 Rate limiting

| Endpoint group | Limit |
|---------------|-------|
| Auth (login/register) | 5 req / 10 min / IP |
| Route downloads | 50 req / hour / user |
| Route uploads | 10 req / day / user |
| DNS profile downloads | 10 req / day / user |
| General API | 300 req / min / user |

### 5.5 Data minimization

- Server logs contain request timestamps, endpoint, HTTP status, and latency only
- No IP addresses stored in logs beyond 24 hours
- No real location data fields exist anywhere in the schema
- Audit trail: any access to user data by employees requires approval and is logged

### 5.6 DNS profile signing

The `.mobileconfig` DNS profile served by the API must be signed with a valid Apple-trusted certificate. An unsigned profile triggers a prominent "unsigned profile" warning in iOS Settings, which is suspicious if the phone is casually inspected. Signing requires enrolling in Apple's MDM vendor program.

---

## 6. Privacy policy requirements

The following must be true and verifiable at all times:

1. The server never receives, stores, or processes a user's real GPS coordinates
2. The server never receives session content (which route played, when, for how long)
3. User email is the only PII collected
4. Account deletion results in complete data removal within 30 days
5. No third-party analytics or tracking SDKs are integrated server-side
6. Routes in the public library contain no metadata that could identify individual users
7. The DNS profile service does not log which domains are blocked or queried per user

---

## 7. Route library — curation guidelines

Curated routes should meet the following criteria:

- **Believable residential or mixed-use areas** — not industrial zones, airports, or unusual environments
- **Appropriate speed profile** — walking routes 3–6 km/h, cycling 12–20 km/h, driving 30–60 km/h
- **No PII in route** — waypoints must not trace a route identifying a private residence as origin or destination
- **Minimum duration:** 20 minutes. **Maximum:** 4 hours
- **Loop preferred** — routes that loop back to start for seamless repeat playback
- **Coverage target at launch:** Chicago, New York, Los Angeles, London, Toronto

Route files are pre-processed at ingest:
- Waypoints smoothed with a Gaussian filter (σ=2 waypoints) to remove sharp artificial angles
- Speed profile normalized to remove instantaneous spikes
- Altitude interpolated if gaps exist
- GRF binary generated, SHA-256 checksum computed, stored to S3

---

## 8. Infrastructure and operations

### 8.1 Environments

| Environment | Purpose |
|-------------|---------|
| `production` | Live users |
| `staging` | Pre-release testing; mirrors production config |
| `development` | Local dev; uses SQLite and local storage |

### 8.2 Deployment

- Containerized (Docker); orchestrated via AWS ECS Fargate or Railway
- Zero-downtime deploys (rolling update, health check before traffic shift)
- Database migrations run in CI before deploy, must be backward-compatible

### 8.3 Observability

- Structured JSON logs (no PII in log fields)
- Metrics: API latency, error rate, route download throughput, firmware download volume
- Alerting: PagerDuty on 5xx rate > 1% sustained for 2 minutes, or p99 latency > 5s

### 8.4 Backup and recovery

- PostgreSQL: continuous WAL archiving to S3; daily snapshots; 30-day retention
- Route and firmware files (S3/R2): versioning enabled; cross-region replication
- RTO: < 1 hour. RPO: < 5 minutes

---

## 9. Open questions

| # | Question | Owner | Due |
|---|----------|-------|-----|
| 1 | Subscription model: one-time hardware bundle vs recurring Pro tier? | Business | — |
| 2 | Should user-uploaded routes be shareable between users? | Product | — |
| 3 | GDPR/CCPA: appoint DPO and complete DPIA before EU launch? | Legal | — |
| 4 | Route CDN: self-hosted vs Cloudflare R2? Cost analysis needed. | Engineering | — |
| 5 | Admin dashboard for route curation — internal tool or CLI only? | Engineering | — |
| 6 | DNS profile: operate Ghost's own DoH resolver, or partner with NextDNS? | Engineering | — |
| 7 | MDM certificate for signed DNS profile — enroll as MDM vendor or use existing Apple developer cert path? | Engineering | — |
| 8 | Full-image firmware hosting: CDN costs for ~1 GB images × N devices? | Engineering | — |
