const express = require('express');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { nanoid } = require('nanoid');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || ('nahdran_dev_' + nanoid(32));
const CODE_CHARS = 'ACDEFHJKLMNPRTUVWXY349';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Database ───────────────────────────────────────────────────────────

const db = new Database(path.join(__dirname, 'nahdran.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'consumer',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    color TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS merchants (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id),
    name TEXT NOT NULL,
    short TEXT NOT NULL,
    category_id TEXT REFERENCES categories(id),
    address TEXT,
    street TEXT,
    house_number INTEGER,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    description TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS offers (
    id TEXT PRIMARY KEY,
    merchant_id TEXT REFERENCES merchants(id),
    title TEXT NOT NULL,
    description TEXT,
    terms TEXT DEFAULT '[]',
    price_before INTEGER NOT NULL DEFAULT 0,
    price_after INTEGER DEFAULT NULL,
    is_free INTEGER DEFAULT 0,
    quota_total INTEGER NOT NULL DEFAULT 20,
    quota_reserved INTEGER NOT NULL DEFAULT 0,
    starts_at TEXT DEFAULT (datetime('now')),
    ends_at TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now')),
    CHECK (quota_reserved <= quota_total)
  );

  CREATE TABLE IF NOT EXISTS vouchers (
    id TEXT PRIMARY KEY,
    offer_id TEXT REFERENCES offers(id),
    user_id TEXT REFERENCES users(id),
    code TEXT UNIQUE NOT NULL,
    reserved_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    redeemed_at TEXT,
    redeemed_by TEXT
  );

  CREATE TABLE IF NOT EXISTS favourites (
    user_id TEXT REFERENCES users(id),
    merchant_id TEXT REFERENCES merchants(id),
    notify INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, merchant_id)
  );

  CREATE TABLE IF NOT EXISTS push_settings (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    enabled INTEGER DEFAULT 1,
    max_daily INTEGER DEFAULT 2,
    quiet_start TEXT DEFAULT '21:00',
    quiet_end TEXT DEFAULT '09:00',
    categories TEXT DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS push_log (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    offer_id TEXT,
    sent_at TEXT DEFAULT (datetime('now')),
    opened INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS price_history (
    id TEXT PRIMARY KEY,
    merchant_id TEXT,
    title TEXT,
    price_cents INTEGER,
    valid_from TEXT DEFAULT (datetime('now')),
    valid_to TEXT
  );
`);

// ─── Helpers ────────────────────────────────────────────────────────────

function genId() { return nanoid(12); }
function genCode() {
  let c = '';
  for (let i = 0; i < 6; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return c;
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Nicht angemeldet' });
  try {
    req.user = jwt.verify(h.slice(7), SECRET);
    next();
  } catch { res.status(401).json({ error: 'Token ungültig' }); }
}

function optionalAuth(req, res, next) {
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) {
    try { req.user = jwt.verify(h.slice(7), SECRET); } catch {}
  }
  next();
}

function merchantAuth(req, res, next) {
  auth(req, res, () => {
    if (req.user.role !== 'merchant') return res.status(403).json({ error: 'Nur für Händler' });
    next();
  });
}

function cents(eur) { return Math.round(eur * 100); }
function eur(c) { return (c / 100).toFixed(2); }

// expire old offers
function expireOffers() {
  db.prepare(`UPDATE offers SET status = 'expired' WHERE status = 'active' AND ends_at < datetime('now')`).run();
  db.prepare(`UPDATE vouchers SET status = 'expired' WHERE status = 'active' AND expires_at < datetime('now')`).run();
}
setInterval(expireOffers, 30000);

// ─── Auth Routes ────────────────────────────────────────────────────────

app.post('/api/auth/register', (req, res) => {
  const { email, password, name, role } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'Felder fehlen' });
  if (password.length < 6) return res.status(400).json({ error: 'Passwort zu kurz (min. 6)' });

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'E-Mail bereits registriert' });

  const id = genId();
  const hash = bcrypt.hashSync(password, 10);
  const userRole = role === 'merchant' ? 'merchant' : 'consumer';
  db.prepare('INSERT INTO users (id, email, password_hash, name, role) VALUES (?,?,?,?,?)').run(id, email, hash, name, userRole);
  db.prepare('INSERT INTO push_settings (user_id) VALUES (?)').run(id);

  const token = jwt.sign({ id, email, name, role: userRole }, SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id, email, name, role: userRole } });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'E-Mail oder Passwort falsch' });

  const token = jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role }, SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

app.get('/api/auth/me', auth, (req, res) => {
  const user = db.prepare('SELECT id, email, name, role, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Nutzer nicht gefunden' });

  let merchant = null;
  if (user.role === 'merchant') {
    merchant = db.prepare('SELECT * FROM merchants WHERE user_id = ?').get(user.id);
  }
  res.json({ user, merchant });
});

// ─── Feed ───────────────────────────────────────────────────────────────

app.get('/api/feed', optionalAuth, (req, res) => {
  expireOffers();
  const lat = parseFloat(req.query.lat) || 50.1005;
  const lng = parseFloat(req.query.lng) || 8.7648;
  const radius = Math.min(parseInt(req.query.radius) || 500, 5000);
  const category = req.query.category || null;

  let offers = db.prepare(`
    SELECT o.*, m.name as merchant_name, m.short as merchant_short,
           m.house_number, m.street, m.lat as mlat, m.lng as mlng,
           m.category_id, c.label as category_label, c.color as category_color
    FROM offers o
    JOIN merchants m ON m.id = o.merchant_id
    JOIN categories c ON c.id = m.category_id
    WHERE o.status = 'active'
      AND o.ends_at > datetime('now')
      AND o.quota_reserved < o.quota_total
    ORDER BY o.created_at DESC
  `).all();

  offers = offers.map(o => ({
    ...o,
    distance: Math.round(haversine(lat, lng, o.mlat, o.mlng)),
    terms: JSON.parse(o.terms || '[]'),
    price_before: eur(o.price_before),
    price_after: o.price_after != null ? eur(o.price_after) : null,
    quota_remaining: o.quota_total - o.quota_reserved
  }))
  .filter(o => o.distance <= radius)
  .filter(o => !category || o.category_id === category)
  .sort((a, b) => a.distance - b.distance);

  // attach favourite status
  if (req.user) {
    const favs = db.prepare('SELECT merchant_id FROM favourites WHERE user_id = ?').all(req.user.id).map(f => f.merchant_id);
    offers.forEach(o => o.is_favourite = favs.includes(o.merchant_id));
  }

  // category counts
  const allInRadius = offers;
  const counts = {};
  const cats = db.prepare('SELECT * FROM categories ORDER BY sort_order').all();
  cats.forEach(c => counts[c.id] = 0);
  // recount from unfiltered
  const unfilteredOffers = db.prepare(`
    SELECT m.category_id, m.lat as mlat, m.lng as mlng
    FROM offers o JOIN merchants m ON m.id = o.merchant_id
    WHERE o.status = 'active' AND o.ends_at > datetime('now') AND o.quota_reserved < o.quota_total
  `).all();
  unfilteredOffers.forEach(o => {
    if (haversine(lat, lng, o.mlat, o.mlng) <= radius) {
      counts[o.category_id] = (counts[o.category_id] || 0) + 1;
    }
  });

  res.json({
    offers,
    categories: cats.map(c => ({ ...c, count: counts[c.id] || 0 })),
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    radius,
    lat, lng
  });
});

// ─── Offer Detail ───────────────────────────────────────────────────────

app.get('/api/offers/:id', optionalAuth, (req, res) => {
  const o = db.prepare(`
    SELECT o.*, m.name as merchant_name, m.short as merchant_short,
           m.house_number, m.street, m.address, m.lat as mlat, m.lng as mlng,
           m.category_id, m.description as merchant_description,
           c.label as category_label, c.color as category_color
    FROM offers o
    JOIN merchants m ON m.id = o.merchant_id
    JOIN categories c ON c.id = m.category_id
    WHERE o.id = ?
  `).get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Angebot nicht gefunden' });

  o.terms = JSON.parse(o.terms || '[]');
  o.price_before = eur(o.price_before);
  o.price_after = o.price_after != null ? eur(o.price_after) : null;
  o.quota_remaining = o.quota_total - o.quota_reserved;

  if (req.user) {
    o.is_favourite = !!db.prepare('SELECT 1 FROM favourites WHERE user_id = ? AND merchant_id = ?').get(req.user.id, o.merchant_id);
    o.has_voucher = !!db.prepare("SELECT 1 FROM vouchers WHERE offer_id = ? AND user_id = ? AND status = 'active'").get(o.id, req.user.id);
  }
  res.json(o);
});

// ─── Search ─────────────────────────────────────────────────────────────

app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').trim();
  const lat = parseFloat(req.query.lat) || 50.1005;
  const lng = parseFloat(req.query.lng) || 8.7648;
  if (q.length < 2) return res.json({ offers: [] });

  const like = `%${q}%`;
  let offers = db.prepare(`
    SELECT o.*, m.name as merchant_name, m.short as merchant_short,
           m.house_number, m.street, m.lat as mlat, m.lng as mlng,
           m.category_id, c.label as category_label, c.color as category_color
    FROM offers o
    JOIN merchants m ON m.id = o.merchant_id
    JOIN categories c ON c.id = m.category_id
    WHERE o.status = 'active' AND o.ends_at > datetime('now')
      AND (m.name LIKE ? OR o.title LIKE ? OR c.label LIKE ?)
    ORDER BY o.created_at DESC
  `).all(like, like, like);

  offers = offers.map(o => ({
    ...o, terms: JSON.parse(o.terms || '[]'),
    distance: Math.round(haversine(lat, lng, o.mlat, o.mlng)),
    price_before: eur(o.price_before),
    price_after: o.price_after != null ? eur(o.price_after) : null,
    quota_remaining: o.quota_total - o.quota_reserved
  })).sort((a, b) => a.distance - b.distance);

  res.json({ offers });
});

// ─── Street View ────────────────────────────────────────────────────────

app.get('/api/streets', (req, res) => {
  const street = req.query.name || 'Kaiserstraße';
  const merchants = db.prepare(`
    SELECT m.*, c.label as category_label, c.color as category_color
    FROM merchants m JOIN categories c ON c.id = m.category_id
    WHERE m.street = ? ORDER BY m.house_number
  `).all(street);

  // attach current offers
  merchants.forEach(m => {
    m.current_offer = db.prepare(`
      SELECT id, title, ends_at FROM offers
      WHERE merchant_id = ? AND status = 'active' AND ends_at > datetime('now') AND quota_reserved < quota_total
      ORDER BY created_at DESC LIMIT 1
    `).get(m.id) || null;
  });

  res.json({ street, merchants });
});

// ─── Vouchers ───────────────────────────────────────────────────────────

app.post('/api/vouchers', auth, (req, res) => {
  const { offerId } = req.body;
  const offer = db.prepare("SELECT * FROM offers WHERE id = ? AND status = 'active'").get(offerId);
  if (!offer) return res.status(404).json({ error: 'Angebot nicht verfügbar' });
  if (offer.quota_reserved >= offer.quota_total) return res.status(409).json({ error: 'Kontingent erschöpft' });

  const existing = db.prepare("SELECT id FROM vouchers WHERE offer_id = ? AND user_id = ? AND status = 'active'").get(offerId, req.user.id);
  if (existing) return res.status(409).json({ error: 'Bereits gesichert' });

  const id = genId();
  const code = genCode();
  const expiresAt = offer.ends_at;

  const tx = db.transaction(() => {
    db.prepare('UPDATE offers SET quota_reserved = quota_reserved + 1 WHERE id = ? AND quota_reserved < quota_total').run(offerId);
    db.prepare('INSERT INTO vouchers (id, offer_id, user_id, code, expires_at) VALUES (?,?,?,?,?)').run(id, offerId, req.user.id, code, expiresAt);
  });
  tx();

  const voucher = db.prepare('SELECT * FROM vouchers WHERE id = ?').get(id);
  res.json(voucher);
});

app.get('/api/vouchers', auth, (req, res) => {
  expireOffers();
  const vouchers = db.prepare(`
    SELECT v.*, o.title, o.price_before, o.price_after, o.is_free, o.ends_at as offer_ends_at,
           m.name as merchant_name, m.short as merchant_short, m.house_number, m.street,
           m.lat as mlat, m.lng as mlng, m.category_id,
           c.label as category_label, c.color as category_color
    FROM vouchers v
    JOIN offers o ON o.id = v.offer_id
    JOIN merchants m ON m.id = o.merchant_id
    JOIN categories c ON c.id = m.category_id
    WHERE v.user_id = ?
    ORDER BY CASE v.status WHEN 'active' THEN 0 WHEN 'redeemed' THEN 1 ELSE 2 END, v.reserved_at DESC
  `).all(req.user.id);

  vouchers.forEach(v => {
    v.price_before = eur(v.price_before);
    v.price_after = v.price_after != null ? eur(v.price_after) : null;
  });
  res.json(vouchers);
});

// ─── Favourites ─────────────────────────────────────────────────────────

app.get('/api/favourites', auth, (req, res) => {
  const favs = db.prepare(`
    SELECT f.*, m.name as merchant_name, m.short as merchant_short,
           m.house_number, m.street, m.lat, m.lng,
           m.category_id, c.label as category_label, c.color as category_color
    FROM favourites f
    JOIN merchants m ON m.id = f.merchant_id
    JOIN categories c ON c.id = m.category_id
    WHERE f.user_id = ?
    ORDER BY f.created_at DESC
  `).all(req.user.id);

  favs.forEach(f => {
    f.current_offer = db.prepare(`
      SELECT id, title, ends_at FROM offers
      WHERE merchant_id = ? AND status = 'active' AND ends_at > datetime('now') AND quota_reserved < quota_total
      ORDER BY created_at DESC LIMIT 1
    `).get(f.merchant_id) || null;
  });
  res.json(favs);
});

app.post('/api/favourites', auth, (req, res) => {
  const { merchantId } = req.body;
  const merchant = db.prepare('SELECT id FROM merchants WHERE id = ?').get(merchantId);
  if (!merchant) return res.status(404).json({ error: 'Geschäft nicht gefunden' });
  const exists = db.prepare('SELECT 1 FROM favourites WHERE user_id = ? AND merchant_id = ?').get(req.user.id, merchantId);
  if (exists) return res.json({ status: 'already_exists' });
  db.prepare('INSERT INTO favourites (user_id, merchant_id) VALUES (?, ?)').run(req.user.id, merchantId);
  res.json({ status: 'added' });
});

app.delete('/api/favourites/:merchantId', auth, (req, res) => {
  db.prepare('DELETE FROM favourites WHERE user_id = ? AND merchant_id = ?').run(req.user.id, req.params.merchantId);
  res.json({ status: 'removed' });
});

// ─── Push Settings ──────────────────────────────────────────────────────

app.get('/api/settings/push', auth, (req, res) => {
  let s = db.prepare('SELECT * FROM push_settings WHERE user_id = ?').get(req.user.id);
  if (!s) {
    db.prepare('INSERT INTO push_settings (user_id) VALUES (?)').run(req.user.id);
    s = db.prepare('SELECT * FROM push_settings WHERE user_id = ?').get(req.user.id);
  }
  s.categories = JSON.parse(s.categories || '[]');
  res.json(s);
});

app.put('/api/settings/push', auth, (req, res) => {
  const { enabled, max_daily, quiet_start, quiet_end, categories } = req.body;
  db.prepare(`UPDATE push_settings SET
    enabled = COALESCE(?, enabled),
    max_daily = COALESCE(?, max_daily),
    quiet_start = COALESCE(?, quiet_start),
    quiet_end = COALESCE(?, quiet_end),
    categories = COALESCE(?, categories)
    WHERE user_id = ?`
  ).run(
    enabled != null ? (enabled ? 1 : 0) : null,
    max_daily || null,
    quiet_start || null,
    quiet_end || null,
    categories ? JSON.stringify(categories) : null,
    req.user.id
  );
  res.json({ status: 'updated' });
});

// ─── Geofences ──────────────────────────────────────────────────────────

app.get('/api/geofences', auth, (req, res) => {
  const lat = parseFloat(req.query.lat) || 50.1005;
  const lng = parseFloat(req.query.lng) || 8.7648;

  // get merchants with active offers, sorted by distance
  let merchants = db.prepare(`
    SELECT DISTINCT m.id, m.name, m.lat, m.lng, m.category_id
    FROM merchants m
    JOIN offers o ON o.merchant_id = m.id
    WHERE o.status = 'active' AND o.ends_at > datetime('now') AND o.quota_reserved < o.quota_total
  `).all();

  merchants = merchants.map(m => ({
    ...m,
    distance: Math.round(haversine(lat, lng, m.lat, m.lng))
  }))
  .sort((a, b) => a.distance - b.distance)
  .slice(0, 18); // iOS limit

  // favour favourites
  const favIds = db.prepare('SELECT merchant_id FROM favourites WHERE user_id = ?').all(req.user.id).map(f => f.merchant_id);
  merchants.sort((a, b) => {
    const af = favIds.includes(a.id) ? 0 : 1;
    const bf = favIds.includes(b.id) ? 0 : 1;
    return af - bf || a.distance - b.distance;
  });

  res.json({
    refresh_fence: { lat, lng, radius: 1500 },
    fences: merchants.slice(0, 18).map(m => ({
      id: m.id, name: m.name, lat: m.lat, lng: m.lng,
      radius: 150, is_favourite: favIds.includes(m.id)
    }))
  });
});

// ─── Push Simulation ────────────────────────────────────────────────────

app.post('/api/push/simulate', auth, (req, res) => {
  const { lat, lng } = req.body;
  const userLat = lat || 50.1005;
  const userLng = lng || 8.7648;

  // find nearest offer
  let offers = db.prepare(`
    SELECT o.id, o.title, o.ends_at, m.name as merchant_name, m.lat, m.lng, m.id as merchant_id
    FROM offers o JOIN merchants m ON m.id = o.merchant_id
    WHERE o.status = 'active' AND o.ends_at > datetime('now') AND o.quota_reserved < o.quota_total
  `).all();

  offers = offers.map(o => ({ ...o, distance: Math.round(haversine(userLat, userLng, o.lat, o.lng)) }))
    .filter(o => o.distance <= 300)
    .sort((a, b) => a.distance - b.distance);

  if (!offers.length) return res.json({ push: null, reason: 'Kein Angebot im Umkreis von 300 m' });

  // check daily cap
  const today = new Date().toISOString().slice(0, 10);
  const sent = db.prepare("SELECT COUNT(*) as n FROM push_log WHERE user_id = ? AND sent_at LIKE ?").get(req.user.id, today + '%');
  if (sent.n >= 2) return res.json({ push: null, reason: 'Tageslimit erreicht (2/2)' });

  const pick = offers[0];
  const logId = genId();
  db.prepare('INSERT INTO push_log (id, user_id, offer_id) VALUES (?,?,?)').run(logId, req.user.id, pick.id);

  res.json({
    push: {
      title: pick.title,
      body: `${pick.distance} m · ${pick.merchant_name}`,
      offer_id: pick.id,
      distance: pick.distance
    }
  });
});

// ─── Merchant: Offers ───────────────────────────────────────────────────

app.get('/api/merchant/offers', merchantAuth, (req, res) => {
  const merchant = db.prepare('SELECT * FROM merchants WHERE user_id = ?').get(req.user.id);
  if (!merchant) return res.status(404).json({ error: 'Kein Geschäft zugeordnet' });

  const offers = db.prepare(`
    SELECT * FROM offers WHERE merchant_id = ? ORDER BY created_at DESC
  `).all(merchant.id);
  offers.forEach(o => {
    o.terms = JSON.parse(o.terms || '[]');
    o.price_before = eur(o.price_before);
    o.price_after = o.price_after != null ? eur(o.price_after) : null;
    o.quota_remaining = o.quota_total - o.quota_reserved;
  });
  res.json({ merchant, offers });
});

app.post('/api/merchant/offers', merchantAuth, (req, res) => {
  const merchant = db.prepare('SELECT * FROM merchants WHERE user_id = ?').get(req.user.id);
  if (!merchant) return res.status(404).json({ error: 'Kein Geschäft zugeordnet' });

  const { title, description, terms, price_before, price_after, is_free, quota_total, duration_hours } = req.body;
  if (!title || !price_before) return res.status(400).json({ error: 'Titel und Originalpreis benötigt' });

  const id = genId();
  const hours = duration_hours || 4;
  const endsAt = new Date(Date.now() + hours * 3600000).toISOString();

  // price history for PAngV
  db.prepare('INSERT INTO price_history (id, merchant_id, title, price_cents) VALUES (?,?,?,?)')
    .run(genId(), merchant.id, title, cents(price_before));

  db.prepare(`INSERT INTO offers (id, merchant_id, title, description, terms, price_before, price_after, is_free, quota_total, ends_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, merchant.id, title, description || '', JSON.stringify(terms || []),
      cents(price_before), price_after != null ? cents(price_after) : null,
      is_free ? 1 : 0, quota_total || 20, endsAt);

  const offer = db.prepare('SELECT * FROM offers WHERE id = ?').get(id);
  offer.terms = JSON.parse(offer.terms);
  offer.price_before = eur(offer.price_before);
  offer.price_after = offer.price_after != null ? eur(offer.price_after) : null;
  res.json(offer);
});

app.put('/api/merchant/offers/:id/pause', merchantAuth, (req, res) => {
  const merchant = db.prepare('SELECT * FROM merchants WHERE user_id = ?').get(req.user.id);
  const offer = db.prepare('SELECT * FROM offers WHERE id = ? AND merchant_id = ?').get(req.params.id, merchant.id);
  if (!offer) return res.status(404).json({ error: 'Angebot nicht gefunden' });

  const newStatus = offer.status === 'active' ? 'paused' : 'active';
  db.prepare('UPDATE offers SET status = ? WHERE id = ?').run(newStatus, offer.id);
  res.json({ status: newStatus });
});

// ─── Merchant: Redeem ───────────────────────────────────────────────────

app.post('/api/merchant/redeem', merchantAuth, (req, res) => {
  const { code } = req.body;
  const merchant = db.prepare('SELECT * FROM merchants WHERE user_id = ?').get(req.user.id);
  if (!merchant) return res.status(404).json({ error: 'Kein Geschäft zugeordnet' });

  const voucher = db.prepare(`
    SELECT v.*, o.merchant_id, o.title FROM vouchers v
    JOIN offers o ON o.id = v.offer_id
    WHERE v.code = ?
  `).get(code?.toUpperCase());

  if (!voucher) return res.status(404).json({ error: 'Code nicht gefunden' });
  if (voucher.merchant_id !== merchant.id) return res.status(403).json({ error: 'Code gehört zu einem anderen Geschäft' });
  if (voucher.status === 'redeemed') return res.json({ status: 'already_redeemed', redeemed_at: voucher.redeemed_at });
  if (voucher.status === 'expired') return res.status(410).json({ error: 'Gutschein abgelaufen' });

  db.prepare("UPDATE vouchers SET status = 'redeemed', redeemed_at = datetime('now'), redeemed_by = ? WHERE id = ?")
    .run(req.user.id, voucher.id);

  res.json({ status: 'redeemed', title: voucher.title, code: voucher.code });
});

// ─── Merchant: Stats ────────────────────────────────────────────────────

app.get('/api/merchant/stats', merchantAuth, (req, res) => {
  const merchant = db.prepare('SELECT * FROM merchants WHERE user_id = ?').get(req.user.id);
  if (!merchant) return res.status(404).json({ error: 'Kein Geschäft zugeordnet' });

  const activeOffers = db.prepare("SELECT COUNT(*) as n FROM offers WHERE merchant_id = ? AND status = 'active' AND ends_at > datetime('now')").get(merchant.id).n;
  const totalReserved = db.prepare("SELECT COALESCE(SUM(quota_reserved),0) as n FROM offers WHERE merchant_id = ?").get(merchant.id).n;
  const totalRedeemed = db.prepare("SELECT COUNT(*) as n FROM vouchers v JOIN offers o ON o.id = v.offer_id WHERE o.merchant_id = ? AND v.status = 'redeemed'").get(merchant.id).n;
  const totalExpired = db.prepare("SELECT COUNT(*) as n FROM vouchers v JOIN offers o ON o.id = v.offer_id WHERE o.merchant_id = ? AND v.status = 'expired'").get(merchant.id).n;

  const recentRedemptions = db.prepare(`
    SELECT v.code, v.redeemed_at, o.title FROM vouchers v
    JOIN offers o ON o.id = v.offer_id
    WHERE o.merchant_id = ? AND v.status = 'redeemed'
    ORDER BY v.redeemed_at DESC LIMIT 10
  `).all(merchant.id);

  res.json({ merchant, activeOffers, totalReserved, totalRedeemed, totalExpired, recentRedemptions,
    redemptionRate: totalReserved > 0 ? Math.round(totalRedeemed / totalReserved * 100) : 0
  });
});

// ─── Merchant: Setup (create merchant profile for merchant users) ─────

app.post('/api/merchant/setup', merchantAuth, (req, res) => {
  const existing = db.prepare('SELECT id FROM merchants WHERE user_id = ?').get(req.user.id);
  if (existing) return res.status(409).json({ error: 'Geschäft existiert bereits' });

  const { name, short, category_id, address, street, house_number, lat, lng, description } = req.body;
  if (!name || !category_id || !lat || !lng) return res.status(400).json({ error: 'Pflichtfelder fehlen' });

  const id = genId();
  db.prepare(`INSERT INTO merchants (id, user_id, name, short, category_id, address, street, house_number, lat, lng, description)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.user.id, name, short || name.slice(0, 2).toUpperCase(), category_id,
      address || '', street || '', house_number || 0, lat, lng, description || '');

  res.json(db.prepare('SELECT * FROM merchants WHERE id = ?').get(id));
});

// ─── Categories ─────────────────────────────────────────────────────────

app.get('/api/categories', (req, res) => {
  res.json(db.prepare('SELECT * FROM categories ORDER BY sort_order').all());
});

// ─── Rechtliche Seiten (statisches HTML) ────────────────────────────────
//
// Angaben vom Betreiber (Projektteam 50Meter, Stand August 2026). Offene
// Punkte, die der Betreiber selbst prüfen bzw. entscheiden muss:
//  - § 5 DDG verlangt bei nicht eingetragenen Gewerben grundsätzlich die
//    Namen der verantwortlichen natürlichen Personen. Die Nennung erst auf
//    Anfrage ist eine bewusste Entscheidung des Betreibers und rechtlich
//    angreifbar.
//  - Für das Hosting bei Hetzner ist ein Auftragsverarbeitungsvertrag nach
//    Art. 28 DSGVO erforderlich.
//  - Google Fonts und cdnjs werden derzeit von externen Servern geladen und
//    sind deshalb in der Datenschutzerklärung ausgewiesen. Sauberer wäre es,
//    beide selbst zu hosten; dann entfällt der Abschnitt.

function legalPage(title, body) {
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · NAHDRAN</title>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Fira+Sans:wght@400;500;600;700&family=Fira+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{
  --emaille:#1B3A93;--ink:#12161A;--pflaster:#EAE8E1;--weiss:#FFF;--signal:#FF4A0F;--grau:#7A766E;--linie:#D6D3CA;
  --emaille-tief:#122A6E;--emaille-hell:#2E58CC;--papier:#F5F3ED;--ink-weich:#3A4048;
  --grad-emaille:linear-gradient(135deg,var(--emaille-tief) 0%,var(--emaille) 48%,var(--emaille-hell) 100%);
  --display:"Anton",sans-serif;--body:"Fira Sans",system-ui,sans-serif;--mono:"Fira Mono",monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--body);color:var(--ink);background:var(--pflaster);line-height:1.65;-webkit-font-smoothing:antialiased}
.hero{position:relative;background:var(--grad-emaille);color:#fff;overflow:hidden;padding:calc(20px + env(safe-area-inset-top)) 0 30px}
.hero::before{content:"";position:absolute;inset:0;background:linear-gradient(160deg,rgba(255,255,255,.26),rgba(255,255,255,0) 55%)}
.hero::after{content:"";position:absolute;right:-70px;top:-110px;width:280px;height:280px;border-radius:50%;background:radial-gradient(circle,rgba(255,255,255,.16),rgba(255,255,255,0) 70%)}
.hero .wrap{position:relative;z-index:1}
.wrap{max-width:680px;margin:0 auto;padding:0 20px}
.back{display:inline-flex;align-items:center;gap:7px;font-family:var(--mono);font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:rgba(255,255,255,.85);text-decoration:none;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.13);border-radius:999px;padding:7px 13px}
.back:hover{background:rgba(255,255,255,.24)}
h1{font-family:var(--display);font-size:34px;text-transform:uppercase;font-weight:400;line-height:1.05;margin:20px 0 4px}
.sub{font-family:var(--mono);font-size:10.5px;letter-spacing:.2em;text-transform:uppercase;color:rgba(255,255,255,.7)}
.sheet{background:var(--weiss);border:1px solid var(--linie);border-radius:22px;padding:26px 24px;margin:-18px auto 40px;max-width:680px;box-shadow:0 2px 6px rgba(18,22,26,.05),0 22px 44px -24px rgba(18,22,26,.3)}
h2{font-size:16.5px;font-weight:600;letter-spacing:-.01em;margin:28px 0 6px;padding-top:2px}
h2:first-child{margin-top:0}
p,li{font-size:15px;color:var(--ink-weich)}
ul{padding-left:20px;margin-top:5px}
li{margin-top:4px}
li::marker{color:var(--emaille)}
address{font-style:normal;font-size:15px;background:var(--papier);border-radius:12px;padding:14px 16px;display:inline-block;margin-top:4px}
strong{color:var(--ink)}
a{color:var(--emaille);text-underline-offset:3px}
.stand{font-family:var(--mono);font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--grau);margin-top:34px;border-top:1px solid var(--linie);padding-top:14px}
@media(max-width:560px){.sheet{border-radius:20px;padding:22px 18px;margin:-16px 14px 30px}h1{font-size:29px}}
</style>
</head>
<body>
<div class="hero">
  <div class="wrap">
    <a class="back" href="/">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19.5 12h-15"/><path d="m10.5 6-6 6 6 6"/></svg>
      Zurück zur App
    </a>
    <h1>${title}</h1>
    <div class="sub">Nahdran</div>
  </div>
</div>
<main class="sheet">
${body}
</main>
</body>
</html>`;
}

app.get('/impressum', (req, res) => {
  res.type('html').send(legalPage('Impressum', `
<h2>Angaben gemäß § 5 DDG</h2>
<address>
Projektteam 50Meter<br>
Rohrmühlstraße 1<br>
63075 Offenbach am Main<br>
Deutschland
</address>

<h2>Vertreten durch</h2>
<p>Die Namen der verantwortlichen Personen des Projektteams nennen wir auf Anfrage unter
<a href="mailto:info@50meter.de">info@50meter.de</a>.</p>

<h2>Kontakt</h2>
<ul>
<li>E-Mail: <a href="mailto:info@50meter.de">info@50meter.de</a></li>
<li>Eine Telefonnummer wird nicht vorgehalten; Anfragen beantworten wir per E-Mail.</li>
</ul>

<h2>Gewerbe und Registereintrag</h2>
<p>Das Gewerbe ist beim Gewerbeamt der Stadt Offenbach am Main angemeldet. Eine Eintragung im
Handels-, Vereins-, Partnerschafts- oder Genossenschaftsregister besteht nicht.</p>

<h2>Umsatzsteuer</h2>
<p>Eine Umsatzsteuer-Identifikationsnummer gemäß § 27 a Umsatzsteuergesetz liegt nicht vor.
Nahdran wird als Teilgewerbe und Testprojekt betrieben und ist für alle Nutzerinnen, Nutzer und
Geschäfte kostenfrei; es werden keine umsatzsteuerpflichtigen Leistungen abgerechnet.</p>

<h2>Verantwortlich für den Inhalt nach § 18 Abs. 2 MStV</h2>
<address>
Projektteam 50Meter<br>
Rohrmühlstraße 1<br>
63075 Offenbach am Main
</address>

<h2>Verbraucherstreitbeilegung</h2>
<p>Wir sind nicht bereit und nicht verpflichtet, an Streitbeilegungsverfahren vor einer
Verbraucherschlichtungsstelle teilzunehmen.</p>

<h2>Haftung für Inhalte und Links</h2>
<p>Die Inhalte dieser Anwendung werden mit Sorgfalt erstellt. Für die Richtigkeit, Vollständigkeit
und Aktualität der von Händlern eingestellten Angebote wird keine Gewähr übernommen. Für Inhalte
externer Links sind ausschließlich deren Betreiber verantwortlich.</p>

<h2>Datenschutz</h2>
<p>Informationen zur Verarbeitung personenbezogener Daten findest du in der
<a href="/datenschutz">Datenschutzerklärung</a>.</p>

<p class="stand">Stand: August 2026</p>
`));
});

app.get('/datenschutz', (req, res) => {
  res.type('html').send(legalPage('Datenschutz', `
<h2>1. Verantwortliche Stelle</h2>
<p>Verantwortlich für die Datenverarbeitung in dieser Anwendung ist:</p>
<address>
Projektteam 50Meter<br>
Rohrmühlstraße 1<br>
63075 Offenbach am Main<br>
Deutschland<br>
E-Mail: <a href="mailto:info@50meter.de">info@50meter.de</a>
</address>
<p>Die Namen der verantwortlichen Personen nennen wir auf Anfrage. Eine Datenschutzbeauftragte
oder ein Datenschutzbeauftragter ist nicht benannt, da die Voraussetzungen des § 38 BDSG nicht
vorliegen.</p>

<h2>2. Welche Daten wir erheben</h2>
<ul>
<li><strong>Kontodaten:</strong> E-Mail-Adresse, Name und ein verschlüsselt gespeichertes Passwort.</li>
<li><strong>Standortdaten:</strong> Nur wenn du die Standortfunktion aktiv freigibst. Die Koordinaten
werden zur Berechnung der Entfernung zu Angeboten verwendet; ein Standortverlauf wird nicht gespeichert.</li>
<li><strong>Nutzungsdaten:</strong> gesicherte und eingelöste Gutscheine, Favoriten,
Benachrichtigungseinstellungen sowie technische Zugriffsdaten.</li>
<li><strong>Händlerdaten:</strong> bei Händlerkonten zusätzlich Geschäftsname, Kategorie, Adresse,
Koordinaten und Beschreibung des Geschäfts.</li>
</ul>

<h2>3. Zweck der Verarbeitung</h2>
<ul>
<li>Bereitstellung des Nutzerkontos und Anmeldung</li>
<li>Anzeige von Angeboten in der Umgebung und Berechnung der Entfernung</li>
<li>Reservierung und Einlösung von Gutscheinen</li>
<li>Versand von Benachrichtigungen, soweit von dir aktiviert</li>
<li>Betrieb, Sicherheit und Fehleranalyse der Anwendung</li>
</ul>

<h2>4. Rechtsgrundlage</h2>
<p>Die Verarbeitung erfolgt auf Grundlage von Art. 6 Abs. 1 lit. b DSGVO (Erfüllung des
Nutzungsvertrags: Konto, Gutscheine, Händlerprofil) sowie Art. 6 Abs. 1 lit. a DSGVO
(Einwilligung: Standortfreigabe und Benachrichtigungen). Eine erteilte Einwilligung kannst du
jederzeit mit Wirkung für die Zukunft widerrufen, etwa durch Entzug der Standortfreigabe
in den Browsereinstellungen.</p>

<h2>5. Speicherdauer</h2>
<ul>
<li>Kontodaten: bis zur Löschung des Kontos.</li>
<li>Standortdaten: nur für die Dauer der jeweiligen Sitzung zur Entfernungsberechnung; sie werden
nicht dauerhaft gespeichert.</li>
<li>Gutscheine und Einlösedaten: bis zur Löschung des Kontos. Da Nahdran kostenfrei ist und keine
Rechnungen entstehen, greifen keine handels- oder steuerrechtlichen Aufbewahrungsfristen.</li>
</ul>

<h2>6. Empfänger und Auftragsverarbeiter</h2>
<p>Hosting und technischer Betrieb erfolgen auf einem Server der Hetzner Online GmbH,
Industriestraße 25, 91710 Gunzenhausen, Deutschland. Die Daten werden in Deutschland gespeichert.
Weitere Dienstleister setzen wir nicht ein; die Daten werden nicht verkauft und nicht zu
Werbezwecken an Dritte weitergegeben.</p>

<h2>7. Externe Inhalte: Schriftarten und Programmbibliotheken</h2>
<p>Die Anwendung lädt beim Aufruf Schriftarten von Google Fonts (Google Ireland Limited, Gordon
House, Barrow Street, Dublin 4, Irland) sowie Programmbibliotheken von cdnjs (Cloudflare, Inc.,
101 Townsend St., San Francisco, CA 94107, USA). Dabei wird deine IP-Adresse an diese Anbieter
übertragen; im Fall von Cloudflare kann dies eine Übermittlung in die USA bedeuten. Rechtsgrundlage
ist Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse an einer einheitlichen und schnellen
Auslieferung der Anwendung). Wenn du das vermeiden möchtest, kannst du das Laden externer
Ressourcen in deinem Browser unterbinden; die Anwendung ist dann eingeschränkt nutzbar.</p>

<h2>8. Deine Rechte</h2>
<ul>
<li>Auskunft über die zu deiner Person gespeicherten Daten (Art. 15 DSGVO)</li>
<li>Berichtigung unrichtiger Daten (Art. 16 DSGVO)</li>
<li>Löschung (Art. 17 DSGVO) und Einschränkung der Verarbeitung (Art. 18 DSGVO)</li>
<li>Datenübertragbarkeit (Art. 20 DSGVO)</li>
<li>Widerspruch gegen die Verarbeitung (Art. 21 DSGVO)</li>
<li>Widerruf erteilter Einwilligungen (Art. 7 Abs. 3 DSGVO)</li>
<li>Beschwerde bei einer Aufsichtsbehörde (Art. 77 DSGVO). Zuständig ist der Hessische Beauftragte
für Datenschutz und Informationsfreiheit, Gustav-Stresemann-Ring 1, 65189 Wiesbaden.</li>
</ul>

<h2>9. Kontakt für Datenschutzanfragen</h2>
<p>Anfragen zum Datenschutz richtest du bitte an <a href="mailto:info@50meter.de">info@50meter.de</a>
oder postalisch an Projektteam 50Meter, Rohrmühlstraße 1, 63075 Offenbach am Main.</p>

<h2>10. Impressum</h2>
<p>Die Anbieterkennzeichnung findest du im <a href="/impressum">Impressum</a>.</p>

<p class="stand">Stand: August 2026</p>
`));
});

// ─── Seed Data ──────────────────────────────────────────────────────────

function seed() {
  // SEED_DEMO_DATA auf false setzen, sobald echte Händler im System sind, um
  // Demo-Daten beim nächsten Neuaufsetzen der DB nicht erneut zu erzeugen.
  if (process.env.SEED_DEMO_DATA === 'false') return;
  if (db.prepare('SELECT COUNT(*) as n FROM categories').get().n > 0) return;

  console.log('Seeding database...');

  // Categories
  const cats = [
    ['essen','Essen & Trinken','#8A4B2A',1],['shoppen','Shoppen','#2E4E7A',2],
    ['beauty','Beauty','#7A3550',3],['friseur','Friseur','#2A6A72',4],
    ['fitness','Fitness','#3F6B4A',5],['elektro','Elektro & Service','#4A4A52',6]
  ];
  const insertCat = db.prepare('INSERT INTO categories (id,label,color,sort_order) VALUES (?,?,?,?)');
  cats.forEach(c => insertCat.run(...c));

  // Demo merchant users + merchants + offers
  const demos = [
    { email:'kiosk@demo.de', pw:'demo123', name:'Kiosk am Markt',
      m: { short:'KM', cat:'essen', street:'Kaiserstraße', hnr:6, lat:50.10082, lng:8.76432 },
      offers: [{ title:'Eiskaffee für 1,50 €', pb:3.20, pa:1.50, q:60, h:3,
        terms:['Nur zum Mitnehmen','Solange der Vorrat reicht'] }]
    },
    { email:'cafe@demo.de', pw:'demo123', name:'Café Sonntag',
      m: { short:'CS', cat:'essen', street:'Kaiserstraße', hnr:14, lat:50.10095, lng:8.76485 },
      offers: [{ title:'2 für 1 Filterkaffee', pb:6.80, pa:3.40, q:40, h:5,
        terms:['Gilt für Filterkaffee, keine Spezialitäten','Nur vor Ort','Einer pro Person und Tag'] }]
    },
    { email:'friseur@demo.de', pw:'demo123', name:'Friseur Kaltenbach',
      m: { short:'FK', cat:'friseur', street:'Kaiserstraße', hnr:19, lat:50.10108, lng:8.76520 },
      offers: [{ title:'Trockenschnitt für 19 €', pb:29.00, pa:19.00, q:8, h:4,
        terms:['Ohne Termin, solange ein Stuhl frei ist','Nur Damen- und Herrenschnitt'] }]
    },
    { email:'baeckerei@demo.de', pw:'demo123', name:'Bäckerei Kalb',
      m: { short:'BK', cat:'essen', street:'Kaiserstraße', hnr:31, lat:50.10132, lng:8.76578 },
      offers: [{ title:'Brot des Tages −40 %', pb:4.20, pa:2.50, q:25, h:2,
        terms:['Solange der Vorrat reicht','Nicht kombinierbar'] }]
    },
    { email:'eis@demo.de', pw:'demo123', name:'Eisdiele Venezia',
      m: { short:'EV', cat:'essen', street:'Kaiserstraße', hnr:36, lat:50.10148, lng:8.76612 },
      offers: [{ title:'3 Kugeln zum Preis von 2', pb:4.50, pa:3.00, q:50, h:6,
        terms:['Nur Waffel oder Becher zum Mitnehmen'] }]
    },
    { email:'kosmetik@demo.de', pw:'demo123', name:'Kosmetik Lumen',
      m: { short:'KL', cat:'beauty', street:'Kaiserstraße', hnr:38, lat:50.10155, lng:8.76628 },
      offers: [{ title:'Gesichtsbehandlung 39 statt 59 €', pb:59.00, pa:39.00, q:6, h:8,
        terms:['60 Minuten, Termin im Laden vereinbaren','Nicht mit anderen Aktionen kombinierbar'] }]
    },
    { email:'grill@demo.de', pw:'demo123', name:'Zeytin Grill',
      m: { short:'ZG', cat:'essen', street:'Kaiserstraße', hnr:40, lat:50.10162, lng:8.76645 },
      offers: [{ title:'Mittagsteller mit Getränk', pb:11.50, pa:7.90, q:30, h:4,
        terms:['Nur zwischen 11 und 15 Uhr','Getränk bis 0,3 l'] }]
    },
    { email:'mode@demo.de', pw:'demo123', name:'Mode Halva',
      m: { short:'MH', cat:'shoppen', street:'Kaiserstraße', hnr:45, lat:50.10178, lng:8.76675 },
      offers: [{ title:'30 % auf alle Sommerware', pb:69.00, pa:48.30, q:100, h:10,
        terms:['Nicht auf bereits reduzierte Artikel','Umtausch innerhalb 14 Tagen'] }]
    },
    { email:'elektro@demo.de', pw:'demo123', name:'Elektro Sander',
      m: { short:'ES', cat:'elektro', street:'Kaiserstraße', hnr:49, lat:50.10192, lng:8.76702 },
      offers: [{ title:'Akkuwechsel Handy 39 statt 59 €', pb:59.00, pa:39.00, q:10, h:8,
        terms:['Gängige Modelle, ca. 45 Min.','Backup empfohlen'] }]
    },
    { email:'blumen@demo.de', pw:'demo123', name:'Blumen Marek',
      m: { short:'BM', cat:'shoppen', street:'Kaiserstraße', hnr:55, lat:50.10215, lng:8.76738 },
      offers: [{ title:'Jeder 2. Strauß −50 %', pb:24.00, pa:18.00, q:20, h:6,
        terms:['Rabatt auf den günstigeren Strauß','Nicht auf Trauerfloristik'] }]
    },
    { email:'barber@demo.de', pw:'demo123', name:'Barber Kaiser',
      m: { short:'BR', cat:'friseur', street:'Kaiserstraße', hnr:58, lat:50.10228, lng:8.76758 },
      offers: [{ title:'Schnitt und Bart für 25 €', pb:36.00, pa:25.00, q:12, h:6,
        terms:['Ohne Termin','Nur werktags bis 18 Uhr'] }]
    },
    { email:'buch@demo.de', pw:'demo123', name:'Buchhandlung Lesezeichen',
      m: { short:'BL', cat:'shoppen', street:'Kaiserstraße', hnr:62, lat:50.10242, lng:8.76782 },
      offers: [{ title:'5 € Nachlass ab 20 €', pb:20.00, pa:15.00, q:50, h:8,
        terms:['Nicht auf preisgebundene Bücher','Gilt auf Papeterie und Spiele'] }]
    },
    { email:'nagel@demo.de', pw:'demo123', name:'Nagelstudio Aria',
      m: { short:'NA', cat:'beauty', street:'Kaiserstraße', hnr:66, lat:50.10258, lng:8.76808 },
      offers: [{ title:'Maniküre −25 %', pb:32.00, pa:24.00, q:8, h:6,
        terms:['Termin vor Ort vereinbaren'] }]
    },
    { email:'fitness@demo.de', pw:'demo123', name:'Studio Kraftwerk',
      m: { short:'SK', cat:'fitness', street:'Kaiserstraße', hnr:71, lat:50.10275, lng:8.76835 },
      offers: [{ title:'Tageskarte gratis', pb:15.00, pa:null, q:15, h:10, free:true,
        terms:['Nur ohne laufende Mitgliedschaft','Handtuch mitbringen'] }]
    },
    { email:'yoga@demo.de', pw:'demo123', name:'Yoga Rakete',
      m: { short:'YR', cat:'fitness', street:'Kaiserstraße', hnr:78, lat:50.10295, lng:8.76865 },
      offers: [{ title:'Probestunde für 5 €', pb:18.00, pa:5.00, q:10, h:12,
        terms:['Anfängerkurs, Matten vorhanden'] }]
    },
    { email:'moebel@demo.de', pw:'demo123', name:'Möbel Reiter',
      m: { short:'MR', cat:'shoppen', street:'Kaiserstraße', hnr:96, lat:50.10348, lng:8.76942 },
      offers: [{ title:'20 % auf Kleinmöbel', pb:120.00, pa:96.00, q:30, h:10,
        terms:['Nur Lagerware','Lieferung gegen Aufpreis'] }]
    },
    { email:'tech@demo.de', pw:'demo123', name:'TechPoint',
      m: { short:'TP', cat:'elektro', street:'Kaiserstraße', hnr:104, lat:50.10375, lng:8.76985 },
      offers: [{ title:'15 % auf Kopfhörer', pb:89.00, pa:75.65, q:40, h:8,
        terms:['Nicht auf Neuheiten der letzten 30 Tage'] }]
    }
  ];

  const insertUser = db.prepare('INSERT INTO users (id,email,password_hash,name,role) VALUES (?,?,?,?,?)');
  const insertMerch = db.prepare('INSERT INTO merchants (id,user_id,name,short,category_id,street,house_number,lat,lng) VALUES (?,?,?,?,?,?,?,?,?)');
  const insertOffer = db.prepare('INSERT INTO offers (id,merchant_id,title,terms,price_before,price_after,is_free,quota_total,ends_at) VALUES (?,?,?,?,?,?,?,?,?)');
  const insertPS = db.prepare('INSERT INTO push_settings (user_id) VALUES (?)');

  const tx = db.transaction(() => {
    // demo consumer
    const cId = genId();
    insertUser.run(cId, 'kunde@demo.de', bcrypt.hashSync('demo123', 10), 'Demo Kunde', 'consumer');
    insertPS.run(cId);

    demos.forEach(d => {
      const uid = genId(), mid = genId();
      insertUser.run(uid, d.email, bcrypt.hashSync(d.pw, 10), d.name, 'merchant');
      insertPS.run(uid);
      insertMerch.run(mid, uid, d.name, d.m.short, d.m.cat, d.m.street, d.m.hnr, d.m.lat, d.m.lng);
      d.offers.forEach(o => {
        const oid = genId();
        const ends = new Date(Date.now() + (o.h || 4) * 3600000).toISOString();
        insertOffer.run(oid, mid, o.title, JSON.stringify(o.terms || []),
          cents(o.pb), o.pa != null ? cents(o.pa) : null, o.free ? 1 : 0, o.q || 20, ends);
      });
    });
  });
  tx();
  console.log('Seed complete: 17 merchants, 17 offers, 1 demo consumer (kunde@demo.de / demo123)');
}

seed();

// ─── Start ──────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  NAHDRAN läuft auf http://localhost:${PORT}\n`);
  console.log('  Demo-Login Kunde:   kunde@demo.de / demo123');
  console.log('  Demo-Login Händler: cafe@demo.de / demo123\n');
});
