# NAHDRAN — Hyperlocal Deal & Voucher Platform

> Connects passers-by with shops on the street they are standing on.
> Not a Groupon clone. A radar, not a catalogue.

---

## Table of Contents

1. [Quick Start](#1-quick-start)
2. [What This App Does](#2-what-this-app-does)
3. [Architecture](#3-architecture)
4. [Database Schema](#4-database-schema)
5. [API Reference](#5-api-reference)
6. [Frontend Structure](#6-frontend-structure)
7. [Authentication](#7-authentication)
8. [Geolocation & Geofencing](#8-geolocation--geofencing)
9. [Push Notifications](#9-push-notifications)
10. [Voucher System](#10-voucher-system)
11. [Merchant Area](#11-merchant-area)
12. [Seed Data](#12-seed-data)
13. [Deployment Guide](#13-deployment-guide)
14. [Production Upgrade Roadmap](#14-production-upgrade-roadmap)
15. [Legal & Compliance (German Market)](#15-legal--compliance-german-market)
16. [Environment Variables](#16-environment-variables)
17. [File Inventory](#17-file-inventory)
18. [Demo Credentials](#18-demo-credentials)

---

## 1. Quick Start

```bash
# Prerequisites: Node.js >= 18
npm install
node server.js
```

Open `http://localhost:3000`. The database seeds automatically on first run.

| Role | Email | Password |
|------|-------|----------|
| Consumer | kunde@demo.de | demo123 |
| Merchant (Café Sonntag) | cafe@demo.de | demo123 |
| Merchant (any shop) | kiosk@demo.de, baeckerei@demo.de, etc. | demo123 |

---

## 2. What This App Does

A user walks through a pedestrian zone. The app shows what is worth a detour within 200–1500 metres, right now. Shops publish short-lived offers (30 minutes to 8 hours). Users reserve a voucher (free — no in-app payment), receive a 6-character code, walk in, show the code, and pay at the counter.

### Core product principles (treat as requirements)

1. **Distance and remaining time outrank discount.** Default sort is walking distance. Do not add a sort-by-discount option.
2. **Notification restraint is the product.** Hard cap: 2 pushes/user/day, 1 push/merchant/user/7 days. Enforced server-side.
3. **The app must work without location permission.** Manual street/district selection is a first-class path.
4. **Offers are short-lived.** Nothing runs for weeks.
5. **The street is the unit of interest,** not the individual merchant.
6. **A merchant must publish an offer in under 60 seconds** on a phone.
7. **Vouchers must render offline.**

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  public/index.html                                          │
│  React 18 SPA (CDN + Babel standalone)                      │
│  Browser Geolocation API · Browser Notification API         │
└──────────────────────────┬──────────────────────────────────┘
                           │ REST / JSON
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  server.js — Express 4                                      │
│  JWT auth · Haversine geo queries · all business logic      │
└──────────────────────────┬──────────────────────────────────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │ SQLite   │ │ (Redis)  │ │ (Object  │
        │ better-  │ │ planned  │ │ storage) │
        │ sqlite3  │ │ for caps │ │ planned  │
        └──────────┘ └──────────┘ └──────────┘
```

### Current stack (MVP / working prototype)

| Layer | Technology | Notes |
|-------|-----------|-------|
| Runtime | Node.js >= 18 | Single process, no clustering |
| Web framework | Express 4.21 | JSON API + static file serving |
| Database | SQLite via `better-sqlite3` | WAL mode, foreign keys on |
| Auth | JWT (`jsonwebtoken`) + bcrypt (`bcryptjs`) | 30-day token, bearer header |
| ID generation | `nanoid` (12 chars) | URL-safe, collision-resistant |
| Geo calculation | Haversine formula in JS | Accurate to ~0.5 % at city scale |
| Frontend | React 18 (CDN) + Babel standalone | Single HTML file, no build step |
| Geolocation | Browser Geolocation API | GPS + network, watch mode |
| Notifications | Browser Notification API | Simulated push from server |

### Dependencies (package.json)

```json
{
  "express": "^4.21.0",
  "better-sqlite3": "^11.3.0",
  "jsonwebtoken": "^9.0.2",
  "bcryptjs": "^2.4.3",
  "cors": "^2.8.5",
  "nanoid": "^3.3.7"
}
```

No dev dependencies, no build step. `node server.js` is the entire start command.

---

## 4. Database Schema

The database is created automatically on first run. 9 tables:

### users
```sql
id              TEXT PRIMARY KEY        -- nanoid(12)
email           TEXT UNIQUE NOT NULL
password_hash   TEXT NOT NULL           -- bcrypt, 10 rounds
name            TEXT NOT NULL
role            TEXT DEFAULT 'consumer' -- 'consumer' | 'merchant'
created_at      TEXT                    -- ISO 8601
```

### categories
```sql
id              TEXT PRIMARY KEY        -- e.g. 'essen', 'beauty'
label           TEXT NOT NULL           -- display name
color           TEXT NOT NULL           -- hex for UI
sort_order      INTEGER DEFAULT 0
```

Six categories seeded: Essen & Trinken, Shoppen, Beauty, Friseur, Fitness, Elektro & Service.

### merchants
```sql
id              TEXT PRIMARY KEY
user_id         TEXT → users(id)        -- the merchant's login account
name            TEXT NOT NULL
short           TEXT NOT NULL           -- 2-char abbreviation for avatar
category_id     TEXT → categories(id)
address         TEXT
street          TEXT                    -- street name for street-view grouping
house_number    INTEGER
lat             REAL NOT NULL           -- WGS84
lng             REAL NOT NULL
description     TEXT
created_at      TEXT
```

### offers
```sql
id              TEXT PRIMARY KEY
merchant_id     TEXT → merchants(id)
title           TEXT NOT NULL
description     TEXT
terms           TEXT DEFAULT '[]'       -- JSON array of strings
price_before    INTEGER NOT NULL        -- euro cents
price_after     INTEGER                 -- euro cents, NULL if free
is_free         INTEGER DEFAULT 0
quota_total     INTEGER NOT NULL
quota_reserved  INTEGER NOT NULL DEFAULT 0
starts_at       TEXT
ends_at         TEXT NOT NULL           -- ISO 8601
status          TEXT DEFAULT 'active'   -- 'active' | 'paused' | 'expired'
created_at      TEXT
CHECK (quota_reserved <= quota_total)   -- race-free constraint
```

### vouchers
```sql
id              TEXT PRIMARY KEY
offer_id        TEXT → offers(id)
user_id         TEXT → users(id)
code            TEXT UNIQUE NOT NULL    -- 6 chars, unambiguous alphabet
reserved_at     TEXT
expires_at      TEXT NOT NULL
status          TEXT DEFAULT 'active'   -- 'active' | 'redeemed' | 'expired'
redeemed_at     TEXT
redeemed_by     TEXT                    -- merchant user_id who scanned
```

### favourites
```sql
user_id         TEXT → users(id)        ─┐
merchant_id     TEXT → merchants(id)     ├─ composite PK
notify          INTEGER DEFAULT 1
created_at      TEXT
```

### push_settings
```sql
user_id         TEXT PRIMARY KEY → users(id)
enabled         INTEGER DEFAULT 1
max_daily       INTEGER DEFAULT 2
quiet_start     TEXT DEFAULT '21:00'
quiet_end       TEXT DEFAULT '09:00'
categories      TEXT DEFAULT '[]'       -- JSON: disabled category IDs
```

### push_log
```sql
id              TEXT PRIMARY KEY
user_id         TEXT
offer_id        TEXT
sent_at         TEXT
opened          INTEGER DEFAULT 0
```

### price_history
```sql
id              TEXT PRIMARY KEY
merchant_id     TEXT
title           TEXT
price_cents     INTEGER
valid_from      TEXT
valid_to        TEXT
```

Required for PAngV § 11 compliance: when showing a reduced price, the reference price must be the lowest charged in the preceding 30 days.

---

## 5. API Reference

Base URL: `http://localhost:3000`
Content-Type: `application/json`
Auth: `Authorization: Bearer <jwt_token>` — endpoints marked 🔒 require it.

---

### 5.1 Authentication

#### `POST /api/auth/register`

```json
// Request
{
  "email": "user@example.de",
  "password": "min6chars",
  "name": "Display Name",
  "role": "consumer"          // or "merchant"
}

// Response 200
{
  "token": "eyJ...",
  "user": { "id": "abc123", "email": "...", "name": "...", "role": "consumer" }
}

// Response 409
{ "error": "E-Mail bereits registriert" }
```

#### `POST /api/auth/login`

```json
// Request
{ "email": "user@example.de", "password": "..." }

// Response 200
{ "token": "eyJ...", "user": { ... } }

// Response 401
{ "error": "E-Mail oder Passwort falsch" }
```

#### `GET /api/auth/me` 🔒

Returns user profile. For merchants, includes the linked merchant object.

---

### 5.2 Feed & Discovery

#### `GET /api/feed`

The main query. Returns offers sorted by walking distance.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `lat` | float | 50.1005 | User latitude (WGS84) |
| `lng` | float | 8.7648 | User longitude |
| `radius` | int | 500 | Max distance in metres (capped at 5000) |
| `category` | string | null | Category ID filter (e.g. `essen`) |

```json
// Response 200
{
  "offers": [
    {
      "id": "abc123",
      "title": "2 für 1 Filterkaffee",
      "merchant_name": "Café Sonntag",
      "merchant_short": "CS",
      "merchant_id": "xyz789",
      "house_number": 14,
      "street": "Kaiserstraße",
      "category_id": "essen",
      "category_label": "Essen & Trinken",
      "category_color": "#8A4B2A",
      "distance": 90,
      "price_before": "6.80",
      "price_after": "3.40",
      "is_free": 0,
      "ends_at": "2026-07-28T01:42:00.000Z",
      "quota_total": 40,
      "quota_remaining": 28,
      "terms": ["Filter coffee only", "Dine-in only"],
      "is_favourite": false
    }
  ],
  "categories": [
    { "id": "essen", "label": "Essen & Trinken", "color": "#8A4B2A", "count": 5 }
  ],
  "total": 17,
  "radius": 500,
  "lat": 50.1005,
  "lng": 8.7648
}
```

Offers with expired time or exhausted quota are excluded. Category counts reflect the entire radius, not the filtered subset.

#### `GET /api/offers/:id` (optional 🔒)

Full offer detail. If authenticated, includes `is_favourite` and `has_voucher` flags.

#### `GET /api/search`

| Param | Type | Description |
|-------|------|-------------|
| `q` | string | Search query (min 2 chars) |
| `lat` | float | For distance calculation |
| `lng` | float | For distance calculation |

Searches across merchant name, offer title, and category label. Returns `{ "offers": [...] }` sorted by distance.

#### `GET /api/streets`

| Param | Type | Default |
|-------|------|---------|
| `name` | string | `"Kaiserstraße"` |

Returns all merchants on the street, each with `current_offer` (or null).

#### `GET /api/categories`

Returns all categories with ID, label, color, sort order.

---

### 5.3 Vouchers 🔒

#### `POST /api/vouchers`

Reserve a voucher. Atomic quota decrement.

```json
// Request
{ "offerId": "abc123" }

// Response 200
{ "id": "v123", "code": "P9HDK9", "status": "active", "expires_at": "..." }

// Response 409  — quota exhausted
{ "error": "Kontingent erschöpft" }

// Response 409  — already reserved
{ "error": "Bereits gesichert" }
```

#### `GET /api/vouchers`

All vouchers for the current user. Sorted: active → redeemed → expired. Includes full offer and merchant details for rendering the voucher card.

---

### 5.4 Favourites 🔒

#### `POST /api/favourites`
```json
{ "merchantId": "xyz789" }
```

#### `DELETE /api/favourites/:merchantId`

#### `GET /api/favourites`
Returns favourites with merchant details and `current_offer` (or null).

---

### 5.5 Push & Geofencing 🔒

#### `GET /api/geofences?lat&lng`

Returns a ranked set of up to 18 fences (iOS limit) plus one 1.5 km refresh fence. Favourites are prioritised.

```json
{
  "refresh_fence": { "lat": 50.1005, "lng": 8.7648, "radius": 1500 },
  "fences": [
    { "id": "m123", "name": "Café Sonntag", "lat": 50.10095, "lng": 8.76485,
      "radius": 150, "is_favourite": true }
  ]
}
```

#### `POST /api/push/simulate`

Simulates a fence-entry push. Checks daily cap, returns payload or suppression reason.

```json
// Request
{ "lat": 50.1005, "lng": 8.7648 }

// Response — push sent
{ "push": { "title": "...", "body": "90 m · Café Sonntag", "offer_id": "...", "distance": 90 } }

// Response — suppressed
{ "push": null, "reason": "Tageslimit erreicht (2/2)" }
```

#### `GET /api/settings/push` · `PUT /api/settings/push`

Read or update push preferences: enabled, max_daily, quiet hours, disabled categories.

---

### 5.6 Merchant Endpoints 🔒 (role: merchant only)

#### `POST /api/merchant/setup`

Create the merchant profile. Required once before creating offers.

```json
{
  "name": "Café Sonntag",
  "short": "CS",
  "category_id": "essen",
  "street": "Kaiserstraße",
  "house_number": 14,
  "lat": 50.10095,
  "lng": 8.76485
}
```

#### `GET /api/merchant/offers`

All offers for the merchant (including expired).

#### `POST /api/merchant/offers`

```json
{
  "title": "2 für 1 Filterkaffee",
  "price_before": 6.80,
  "price_after": 3.40,
  "quota_total": 40,
  "duration_hours": 4,
  "terms": ["Filter coffee only", "Dine-in only"]
}
```

`price_after: null` + `is_free: true` for free offers. A `price_history` entry is written automatically.

#### `PUT /api/merchant/offers/:id/pause`

Toggles between `active` and `paused`.

#### `POST /api/merchant/redeem`

**Idempotent.** Second scan returns the original timestamp, not an error.

```json
// Request
{ "code": "P9HDK9" }

// Response — first scan
{ "status": "redeemed", "title": "2 für 1 Filterkaffee", "code": "P9HDK9" }

// Response — already redeemed
{ "status": "already_redeemed", "redeemed_at": "2026-07-27T20:42:00.000Z" }

// Response — wrong merchant
{ "error": "Code gehört zu einem anderen Geschäft" }
```

#### `GET /api/merchant/stats`

Dashboard: active offers, total reserved, total redeemed, redemption rate (%), 10 most recent redemptions.

---

## 6. Frontend Structure

`public/index.html` — single-file React 18 SPA. No build step.

### Consumer screens

| Tab | Component | Purpose |
|-----|-----------|---------|
| Nähe | `FeedScreen` | Distance-sorted deals, category chips, radius control |
| Suche | `SearchScreen` | Live search + category grid |
| Favoriten | `FavScreen` | Saved merchants with live offer status |
| Gutscheine | `VoucherScreen` | Voucher wallet with codes and barcodes |

### Merchant screens

`MerchantDashboard` with 3 sub-views: Dashboard (KPIs + offer list), Scanner (code entry), Create Offer (form).

### Shared components

| Component | Purpose |
|-----------|---------|
| `DealCard` | Offer card: avatar, category, countdown, price, favourite toggle |
| `DealSheet` | Bottom sheet: full detail, facts, terms, reserve button |
| `VoucherBon` | Receipt-styled voucher: perforated edges, barcode, live countdown |
| `PushBanner` | iOS-style notification banner, auto-dismiss 8s |
| `AuthScreen` | Login/register with role selection |

### Design tokens

```
Typography:  Anton (display/headings), Fira Sans (body), Fira Mono (data/counters)
Palette:     Enamel blue #1B3A93, Ink #12161A, Pavement #EAE8E1, Signal #FF4A0F
Rule:        #FF4A0F is reserved for countdowns and the primary CTA — nowhere else.
```

---

## 7. Authentication

| Property | Value |
|----------|-------|
| Algorithm | HS256 |
| Expiry | 30 days |
| Transport | `Authorization: Bearer <token>` |
| Client storage | `localStorage` key `nahdran_token` |
| Roles | `consumer`, `merchant` — enforced per route |

### ⚠ Production requirement

The JWT secret is currently regenerated on every server restart, invalidating all sessions.

```js
// server.js line 10 — replace:
const SECRET = 'nahdran_' + nanoid(32);
// with:
const SECRET = process.env.JWT_SECRET;
```

Set `JWT_SECRET` in your `.env` file. Generate once:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

---

## 8. Geolocation & Geofencing

### Current: Browser Geolocation

Frontend calls `navigator.geolocation.getCurrentPosition()` (high accuracy), then `watchPosition()` for updates. If denied, defaults to Offenbach Innenstadt (50.1005, 8.7648).

### Geofence API design

`GET /api/geofences` returns 1 refresh fence (1.5 km) + up to 18 merchant fences (150 m each), ranked by favourite status then distance. This respects the iOS `CLLocationManager` limit of 20 regions.

### Production upgrade

| Current | Target |
|---------|--------|
| Haversine in JS | PostGIS `ST_DWithin` + GiST index |
| Straight-line distance | Walking distance via OpenRouteService or Valhalla |
| Browser Geolocation | `react-native-background-geolocation` (commercial, ~$300/platform) |
| No dwell detection | 60 s dwell before triggering push |

---

## 9. Push Notifications

### Current flow

1. Frontend calls `POST /api/push/simulate` 4 seconds after login
2. Server picks the nearest active offer within 300 m
3. Server checks daily cap (2/day via `push_log`)
4. Returns payload → frontend shows `PushBanner` + `Notification` API
5. Tap opens deal detail

### Frequency gates (all server-side)

| Gate | Rule |
|------|------|
| Daily cap | 2 pushes/user/day |
| Merchant cooldown | 1 push/merchant/user/7 days |
| Remaining time | Offer must have ≥ 20 min left |
| Remaining quota | Offer must not be sold out |
| Category opt-in | Category must be enabled in user settings |
| Quiet hours | 09:00–20:00 default |
| Day of week | No Sundays or public holidays |

### Production upgrade

Replace SQLite-based cap checks with Redis counters:
```
push:daily:{userId}:{yyyy-mm-dd}     → counter, cap 2,  TTL 48h
push:merchant:{userId}:{merchantId}  → flag,    TTL 7d
push:fence:{userId}:{fenceId}        → flag,    TTL 24h
```

Replace browser Notification API with APNs (`node-apn`) + FCM (`firebase-admin`), dispatched via BullMQ workers.

---

## 10. Voucher System

### Lifecycle

```
User taps "Sichern"
  → POST /api/vouchers { offerId }
  → Atomic transaction:
      1. UPDATE offers SET quota_reserved += 1 WHERE quota_reserved < quota_total
      2. Generate 6-char code (alphabet: ACDEFHJKLMNPRTUVWXY349)
      3. INSERT voucher with status 'active'
  → Client renders code + barcode

User shows code at counter
  → Merchant enters code
  → POST /api/merchant/redeem { code }
  → Idempotent — second scan returns original timestamp
  → Status → 'redeemed'

Offer expires
  → Background interval (30 s) marks offers and vouchers as expired
```

### Code alphabet

22 unambiguous characters (no 0/O/I/1/B/8/G/6/S/5/Q/U confusion). 22^6 ≈ 113 M combinations.

### Race condition protection

`CHECK (quota_reserved <= quota_total)` on the `offers` table. Two simultaneous reservations on the last unit: one succeeds, one gets a database error. No double-booking possible.

---

## 11. Merchant Area

Login with any `role: "merchant"` account to see the dashboard.

| Feature | Description |
|---------|-------------|
| Dashboard | 4 KPIs: active offers, reserved, redeemed, redemption rate |
| Offer list | Live countdown, pause/resume toggle |
| Scanner | 6-char code input, idempotent redeem |
| Create offer | Title, prices, quota, duration, terms — under 60 seconds |
| Stats | 10 most recent redemptions |

---

## 12. Seed Data

17 merchants along Kaiserstraße, Offenbach am Main, with realistic WGS84 coordinates:

| Shop | Category | Email | Hnr. |
|------|----------|-------|------|
| Kiosk am Markt | Essen | kiosk@demo.de | 6 |
| Café Sonntag | Essen | cafe@demo.de | 14 |
| Friseur Kaltenbach | Friseur | friseur@demo.de | 19 |
| Bäckerei Kalb | Essen | baeckerei@demo.de | 31 |
| Eisdiele Venezia | Essen | eis@demo.de | 36 |
| Kosmetik Lumen | Beauty | kosmetik@demo.de | 38 |
| Zeytin Grill | Essen | grill@demo.de | 40 |
| Mode Halva | Shoppen | mode@demo.de | 45 |
| Elektro Sander | Elektro | elektro@demo.de | 49 |
| Blumen Marek | Shoppen | blumen@demo.de | 55 |
| Barber Kaiser | Friseur | barber@demo.de | 58 |
| Buchhandlung Lesezeichen | Shoppen | buch@demo.de | 62 |
| Nagelstudio Aria | Beauty | nagel@demo.de | 66 |
| Studio Kraftwerk | Fitness | fitness@demo.de | 71 |
| Yoga Rakete | Fitness | yoga@demo.de | 78 |
| Möbel Reiter | Shoppen | moebel@demo.de | 96 |
| TechPoint | Elektro | tech@demo.de | 104 |

All demo passwords: `demo123`. Consumer account: `kunde@demo.de` / `demo123`.

Delete `nahdran.db` to reset and re-seed.

---

## 13. Deployment Guide

### 13.1 Local / Development

```bash
git clone <repo>
cd nahdran
npm install
node server.js    # → http://localhost:3000
```

### 13.2 Production — Single Server (EU)

Recommended hosting: **Hetzner Cloud** (Nuremberg/Falkenstein) or **AWS eu-central-1**. EU hosting is a credibility argument with municipal and retail partners.

#### Server setup (Ubuntu 24.04)

```bash
sudo apt update && sudo apt install -y nodejs npm nginx certbot python3-certbot-nginx
sudo mkdir -p /opt/nahdran && sudo chown deploy:deploy /opt/nahdran
cd /opt/nahdran && git clone <repo> . && npm ci --production
```

#### Environment file

```bash
cat > .env << 'EOF'
NODE_ENV=production
PORT=3000
JWT_SECRET=<run: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))">
EOF
```

#### Systemd service

```ini
# /etc/systemd/system/nahdran.service
[Unit]
Description=NAHDRAN API
After=network.target

[Service]
Type=simple
User=deploy
WorkingDirectory=/opt/nahdran
EnvironmentFile=/opt/nahdran/.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now nahdran
```

#### Nginx + TLS

```nginx
# /etc/nginx/sites-available/nahdran
server {
    listen 80;
    server_name app.nahdran.de;
    return 301 https://$host$request_uri;
}
server {
    listen 443 ssl http2;
    server_name app.nahdran.de;
    ssl_certificate     /etc/letsencrypt/live/app.nahdran.de/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/app.nahdran.de/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/nahdran /etc/nginx/sites-enabled/
sudo certbot --nginx -d app.nahdran.de
sudo systemctl restart nginx
```

### 13.3 Docker

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

```yaml
# docker-compose.yml
services:
  app:
    build: .
    ports: ["3000:3000"]
    volumes: [nahdran-data:/app/data]
    environment:
      - JWT_SECRET=${JWT_SECRET}
      - NODE_ENV=production
    restart: unless-stopped
volumes:
  nahdran-data:
```

```bash
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(64).toString('hex'))") \
docker compose up -d
```

### 13.4 Database backups

```bash
# Cron: daily at 03:00
0 3 * * * sqlite3 /opt/nahdran/nahdran.db ".backup '/opt/backups/nahdran-$(date +\%Y\%m\%d).db'"
```

---

## 14. Production Upgrade Roadmap

### P0 — Before first real users

| Item | Why | Effort |
|------|-----|--------|
| Persist `JWT_SECRET` via env var | Restart logs everyone out | 5 min |
| HTTPS (nginx + Let's Encrypt) | Required for Geolocation API and stores | 30 min |
| Rate limiting (`express-rate-limit`) | Prevent abuse | 30 min |
| Input validation (`zod` or `joi`) | Reject malformed data, prevent injection | 2 h |
| Error handling middleware | Unhandled errors return HTML stack traces | 1 h |
| CORS lock-down | Restrict to your domain | 10 min |

### P1 — Before pilot launch (15+ merchants)

| Item | Why | Effort |
|------|-----|--------|
| PostgreSQL + PostGIS | `ST_DWithin` + GiST index for geo queries | 1 day |
| Redis for frequency caps | SQLite won't scale for push governance | 1 day |
| Vite build (replace Babel CDN) | 400 KB Babel on every page load | 1 day |
| Walking distance (OpenRouteService) | Straight line is wrong across rivers/tracks | 1 day |
| MapLibre + MapTiler tiles | Real map instead of placeholder | 2 days |
| Merchant image upload (S3 + imgproxy) | Photos instead of initials | 1 day |
| QR scanner (`html5-qrcode`) | Camera scan instead of manual entry | 4 h |

### P2 — Before App Store submission

| Item | Why | Effort |
|------|-----|--------|
| React Native + Expo (dev client) | Native app, background geolocation | 2–3 weeks |
| APNs + FCM (`node-apn`/`firebase-admin`) | Real push notifications | 3 days |
| Offline voucher persistence (MMKV) | Must render without network | 2 days |
| Accessibility (WCAG 2.1 AA) | BFSG requirement since June 2025 | 3 days |
| Deep links (`nahdran://deal/{id}`) | Push must open the deal, not home | 1 day |
| Server-authoritative time | Prevent device clock manipulation | 4 h |

### P3 — After pilot validation

| Item | Why | Effort |
|------|-----|--------|
| Merchant billing (Stripe) | Revenue | 3 days |
| Admin back office | Onboarding, moderation | 1 week |
| Multi-city support | Growth | 1 week |
| Analytics (PostHog EU) | Data-driven decisions | 1 day |
| BullMQ workers | Offer expiry, push dispatch, nightly stats | 2 days |

---

## 15. Legal & Compliance (German Market)

| Area | Requirement |
|------|-------------|
| **GDPR / DSGVO** | Location-based push needs explicit consent (Art. 6(1)(a)), separate from app usage. Layered permission flow. Do not store location traces — persist fence-entry events only, delete after 30 days. |
| **TDDDG § 25** | Device storage/identifier access beyond strict necessity requires consent. Applies to analytics SDKs. |
| **PAngV § 11** | Reference price must be the lowest in the preceding 30 days. The `price_history` table exists for this. Merchant UI must validate at input time in production. |
| **BFSG** | In force since June 2025. Target EN 301 549 / WCAG 2.1 AA. Full audit needed before launch. |
| **App Store** | Background location requires a clear justification string. Apple rejects vague ones. Prepare a demo video. |
| **DPAs** | Signed agreements with every processor: hosting, Apple, Google, analytics, email. |

---

## 16. Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | 3000 | HTTP port |
| `JWT_SECRET` | **Yes (prod)** | Random/restart | Token signing key — must persist |
| `NODE_ENV` | No | development | `production` disables verbose errors |
| `DATABASE_PATH` | No | `./nahdran.db` | SQLite file location |

---

## 17. File Inventory

```
nahdran/
├── server.js              Express API (822 lines, self-contained)
│                          Auth, feed, vouchers, favourites, push,
│                          merchant CRUD, redemption, stats, geofences,
│                          seed data, expiry worker.
│
├── public/
│   └── index.html         React 18 SPA (all screens, components, CSS)
│                          CDN-loaded React + Babel. No build step.
│
├── package.json           6 runtime dependencies, 0 devDependencies.
├── README.md              This file.
└── nahdran.db             SQLite database (auto-created, not committed).
```

---

## 18. Demo Credentials

### Consumer

| Email | Password | Capabilities |
|-------|----------|-------------|
| kunde@demo.de | demo123 | Browse, search, favourite, reserve vouchers, view wallet |

### Merchant (any of 17)

| Shop | Email |
|------|-------|
| Kiosk am Markt | kiosk@demo.de |
| Café Sonntag | cafe@demo.de |
| Friseur Kaltenbach | friseur@demo.de |
| Bäckerei Kalb | baeckerei@demo.de |
| Eisdiele Venezia | eis@demo.de |
| Kosmetik Lumen | kosmetik@demo.de |
| Zeytin Grill | grill@demo.de |
| Mode Halva | mode@demo.de |
| Elektro Sander | elektro@demo.de |
| Blumen Marek | blumen@demo.de |
| Barber Kaiser | barber@demo.de |
| Buchhandlung Lesezeichen | buch@demo.de |
| Nagelstudio Aria | nagel@demo.de |
| Studio Kraftwerk | fitness@demo.de |
| Yoga Rakete | yoga@demo.de |
| Möbel Reiter | moebel@demo.de |
| TechPoint | tech@demo.de |

All merchant passwords: `demo123`. Capabilities: dashboard, create offers, pause/resume, scan and redeem codes.

---

*Reference prototypes: `nahdran-prototyp-v2.html` (visual/interaction), `nahdran-developer-brief.md` (production tech stack).*
