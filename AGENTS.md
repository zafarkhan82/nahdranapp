# AGENTS.md

## Cursor Cloud specific instructions

NAHDRAN is a single, self-contained Node.js/Express app with an embedded SQLite
database (`better-sqlite3`) and a build-less CDN-React frontend served by the
same process. There is exactly one service to run and no external dependencies
(no separate DB server, Redis, or object storage — those are roadmap-only).

### Running the app
- Start (dev = prod, no build step, no hot reload): `npm start` (i.e. `node server.js`), serves API + SPA on `http://localhost:3000`.
- On first run the app auto-creates and seeds `nahdran.db` (17 merchants, 17 offers, 1 demo consumer). Delete `nahdran.db*` to reset seed data.
- Demo logins: consumer `kunde@demo.de` / `demo123`; merchant `cafe@demo.de` / `demo123` (other merchants `kiosk@demo.de`, `baeckerei@demo.de`, ... also use `demo123`).

### Non-obvious caveats
- The feed is geo-filtered. With no coordinates the API defaults to Frankfurt (`lat=50.1005, lng=8.7648`), where all seed merchants live. Other coordinates (e.g. Berlin) return an empty feed — this is expected, not a bug.
- API request bodies use camelCase keys (e.g. `POST /api/vouchers` expects `offerId`, `POST /api/merchant/redeem` expects `code`). Wrong keys yield `{"error":"Angebot nicht verfügbar"}` / `{"error":"Code nicht gefunden"}`.
- Voucher redemption only succeeds for the merchant that owns the offer; redeeming another merchant's code returns 403.
- No tests, no linter, and no build step are configured. `npm test` / `npm run lint` / `npm run build` do not exist.
- `setup.sh` is a production VPS provisioning script (nginx/certbot/systemd, requires root) — do NOT use it for local dev.
- `JWT_SECRET` is optional in dev (a random one is generated per restart, which invalidates existing tokens on restart). Set it in production so tokens survive restarts.
