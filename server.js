const express    = require('express');
const cors       = require('cors');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const path       = require('path');
const https      = require('https');
const helmet     = require('helmet');
const multer     = require('multer');
const { Readable } = require('stream');
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('อนุญาตเฉพาะไฟล์รูปภาพเท่านั้น'));
  },
});

const db   = require('./database');
const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Security: JWT Secret ─────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('❌ JWT_SECRET env var is required in production. Exiting.');
    process.exit(1);
  }
  console.warn('⚠️  JWT_SECRET not set — using insecure default. Set this before going live!');
}
const SECRET = JWT_SECRET || 'buathong-rice-dev-secret-CHANGE-THIS';

// ─── Security: CORS ───────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  'http://localhost:3000,https://buathong-rice.onrender.com,https://buathongrice.com,https://www.buathongrice.com'
).split(',').map(s => s.trim());

// ─── Security Headers (Helmet) ────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // Frontend uses inline scripts + external CDNs
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: (origin, cb) => {
    // Allow no-origin (mobile apps, curl) only in dev
    if (!origin) return cb(null, process.env.NODE_ENV !== 'production');
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('CORS: origin not allowed'));
  },
  credentials: true,
}));

app.set('trust proxy', 1); // Required for correct req.ip behind Render's reverse proxy
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── In-memory stores ─────────────────────────────────────────────────────────
const otpStore          = new Map();
const resetStore        = new Map();
const loginAttemptStore = new Map();
const adminAttemptStore = new Map();
const registerStore     = new Map(); // IP → { count, resetAt }

setInterval(() => {
  const now = Date.now();
  otpStore.forEach((v, k)          => { if (now > v.expiresAt)   otpStore.delete(k); });
  resetStore.forEach((v, k)        => { if (now > v.expiresAt)   resetStore.delete(k); });
  loginAttemptStore.forEach((v, k) => { if (now > v.lockedUntil) loginAttemptStore.delete(k); });
  adminAttemptStore.forEach((v, k) => { if (now > v.lockedUntil) adminAttemptStore.delete(k); });
  registerStore.forEach((v, k)     => { if (now > v.resetAt)     registerStore.delete(k); });
}, 5 * 60_000);

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const FACEBOOK_APP_ID  = process.env.FACEBOOK_APP_ID  || '';
const PROMPTPAY_ID     = process.env.PROMPTPAY_ID     || '0812345678';
const OMISE_PUBLIC     = process.env.OMISE_PUBLIC_KEY || '';

// ─── Security: Token Verification ────────────────────────────────────────────

// Verify Google ID token via Google's tokeninfo API (validates signature + expiry + audience)
function verifyGoogleToken(credential) {
  return new Promise((resolve, reject) => {
    const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const payload = JSON.parse(data);
          if (payload.error_description) return reject(new Error(payload.error_description));
          if (GOOGLE_CLIENT_ID && payload.aud !== GOOGLE_CLIENT_ID)
            return reject(new Error('Token audience mismatch'));
          resolve(payload);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// Verify Facebook access_token via Graph API (validates token + fetches real user data)
function verifyFacebookToken(accessToken) {
  return new Promise((resolve, reject) => {
    const url = `https://graph.facebook.com/me?fields=id,name,email,picture.type(large)&access_token=${encodeURIComponent(accessToken)}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const payload = JSON.parse(data);
          if (payload.error) return reject(new Error(payload.error.message));
          if (!payload.id) return reject(new Error('No user id in response'));
          resolve(payload);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ─── Security: Rate Limiting Helpers ─────────────────────────────────────────
function cooldownResponse(store, key) {
  const a = store.get(key);
  if (a && a.lockedUntil > Date.now()) {
    const secs = Math.ceil((a.lockedUntil - Date.now()) / 1000);
    const mins = Math.floor(secs / 60), s = secs % 60;
    return { error: `พยายามมากเกินไป กรุณารอ ${mins > 0 ? mins + ' นาที ' : ''}${s} วินาที`, retryAfter: secs };
  }
  return null;
}

function recordFailedAttempt(store, key, max = 3, lockMs = 5 * 60_000) {
  const cur = store.get(key) || { attempts: 0, lockedUntil: 0 };
  cur.attempts += 1;
  if (cur.attempts >= max) {
    cur.lockedUntil = Date.now() + lockMs;
    store.set(key, cur);
    return { locked: true, error: `พยายามผิดพลาดเกิน ${max} ครั้ง ระงับชั่วคราว 5 นาที`, retryAfter: Math.ceil(lockMs / 1000) };
  }
  store.set(key, cur);
  return { locked: false, error: `ข้อมูลไม่ถูกต้อง (เหลืออีก ${max - cur.attempts} ครั้ง)` };
}

function checkRegisterLimit(ip) {
  const now = Date.now();
  const r = registerStore.get(ip) || { count: 0, resetAt: now + 3_600_000 };
  if (now > r.resetAt) { r.count = 0; r.resetAt = now + 3_600_000; }
  r.count++;
  registerStore.set(ip, r);
  return r.count > 10; // max 10 registrations/hour/IP
}

// ─── Middleware: Auth ─────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const token = (req.headers.authorization || '').slice(7);
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const p = jwt.verify(token, SECRET);
    if (p.type !== 'admin') throw new Error();
    req.admin = p; next();
  } catch { res.status(401).json({ error: 'Unauthorized' }); }
}

function requireUser(req, res, next) {
  const token = (req.headers.authorization || '').slice(7);
  if (!token) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
  try {
    const p = jwt.verify(token, SECRET);
    if (p.type !== 'user') throw new Error();
    req.user = p; next();
  } catch { res.status(401).json({ error: 'กรุณาเข้าสู่ระบบใหม่' }); }
}

function optionalUser(req, res, next) {
  const token = (req.headers.authorization || '').slice(7);
  if (token) {
    try { const p = jwt.verify(token, SECRET); if (p.type === 'user') req.user = p; } catch {}
  }
  next();
}

function userToken(user) {
  return jwt.sign(
    { type: 'user', id: user.id, name: user.name, phone: user.phone, email: user.email },
    SECRET, { expiresIn: '30d' }
  );
}

// ─── Security: Input Validation ───────────────────────────────────────────────
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

function sanitizeStr(s, maxLen = 200) {
  return typeof s === 'string' ? s.trim().slice(0, maxLen) : '';
}

// ─── Public Config ────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({
    googleClientId: GOOGLE_CLIENT_ID,
    facebookAppId:  FACEBOOK_APP_ID,
    promptpayId:    PROMPTPAY_ID,
    omisePublicKey: OMISE_PUBLIC,
    hasOmise:    !!OMISE_PUBLIC,
    hasGoogle:   !!GOOGLE_CLIENT_ID,
    hasFacebook: !!FACEBOOK_APP_ID,
  });
});

// ─── Admin Auth ───────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const username = sanitizeStr(req.body.username, 100);
    const password = req.body.password || '';
    if (!username || !password) return res.status(400).json({ error: 'กรุณากรอกข้อมูล' });

    const key = username.toLowerCase();
    const cd  = cooldownResponse(adminAttemptStore, key);
    if (cd) return res.status(429).json(cd);

    const admin = await db.getOne('SELECT * FROM admins WHERE username = ?', [username]);
    // Always run bcrypt even if admin not found to prevent timing attacks
    const validPass = admin ? bcrypt.compareSync(password, admin.password) : bcrypt.compareSync(password, '$2a$10$invalidhashfortimingprevention');
    if (!admin || !validPass) {
      const r = recordFailedAttempt(adminAttemptStore, key);
      return res.status(r.locked ? 429 : 401).json({ error: r.error, ...(r.retryAfter && { retryAfter: r.retryAfter }) });
    }

    adminAttemptStore.delete(key);
    const token = jwt.sign(
      { type: 'admin', id: admin.id, username: admin.username, name: admin.name },
      SECRET, { expiresIn: '8h' }
    );
    res.json({ token, name: admin.name });
  } catch { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.get('/api/auth/verify', requireAdmin, (req, res) => res.json({ valid: true, name: req.admin.name }));

// ─── User Auth ────────────────────────────────────────────────────────────────
app.post('/api/user/otp/send', async (req, res) => {
  try {
    const phone = sanitizeStr(req.body.phone, 10);
    if (!phone || !/^0[0-9]{9}$/.test(phone))
      return res.status(400).json({ error: 'เบอร์โทรไม่ถูกต้อง (0XXXXXXXXX)' });
    if (await db.getOne('SELECT id FROM users WHERE phone = ?', [phone]))
      return res.status(409).json({ error: 'เบอร์โทรนี้ถูกใช้งานแล้ว' });

    const existing = otpStore.get(phone);
    if (existing && Date.now() - existing.sentAt < 60_000) {
      const wait = Math.ceil((60_000 - (Date.now() - existing.sentAt)) / 1000);
      return res.status(429).json({ error: `กรุณารอ ${wait} วินาทีก่อนส่งใหม่` });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore.set(phone, { otp, expiresAt: Date.now() + 5 * 60_000, sentAt: Date.now(), attempts: 0 });
    // TODO: ส่ง SMS จริงผ่าน Twilio / AIS / True
    const isDev = process.env.NODE_ENV !== 'production';
    res.json({ ok: true, ...(isDev && { _dev_otp: otp }) });
  } catch { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.post('/api/user/register', async (req, res) => {
  try {
    // Rate limit by IP
    const ip = req.ip || '0.0.0.0';
    if (checkRegisterLimit(ip)) return res.status(429).json({ error: 'ส่งคำขอมากเกินไป กรุณารอสักครู่' });

    const name     = sanitizeStr(req.body.name, 100);
    const phone    = sanitizeStr(req.body.phone, 10);
    const email    = sanitizeStr(req.body.email, 200).toLowerCase();
    const password = req.body.password || '';

    if (!name || !phone || !password) return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบ' });
    if (name.length < 2) return res.status(400).json({ error: 'ชื่อสั้นเกินไป' });
    if (!/^0[0-9]{9}$/.test(phone)) return res.status(400).json({ error: 'เบอร์โทรไม่ถูกต้อง (0XXXXXXXXX)' });
    if (password.length < 6) return res.status(400).json({ error: 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร' });
    if (email && !isValidEmail(email)) return res.status(400).json({ error: 'รูปแบบอีเมลไม่ถูกต้อง' });

    if (await db.getOne('SELECT id FROM users WHERE phone = ?', [phone]))
      return res.status(409).json({ error: 'เบอร์โทรนี้ถูกใช้งานแล้ว' });
    if (email && await db.getOne('SELECT id FROM users WHERE email = ?', [email]))
      return res.status(409).json({ error: 'อีเมลนี้ถูกใช้งานแล้ว' });

    const user = await db.queryOne(
      'INSERT INTO users (name,phone,email,password) VALUES (?,?,?,?) RETURNING *',
      [name, phone, email || null, bcrypt.hashSync(password, 10)]
    );
    if (!user) return res.status(500).json({ error: 'สร้างบัญชีไม่สำเร็จ' });
    res.status(201).json({ token: userToken(user), name: user.name, id: user.id });
  } catch { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

// ─── Forgot / Reset Password ──────────────────────────────────────────────────
app.post('/api/user/forgot-password', async (req, res) => {
  try {
    const email = sanitizeStr(req.body.email, 200).toLowerCase();
    if (!email || !isValidEmail(email)) return res.status(400).json({ error: 'กรุณากรอกอีเมลให้ถูกต้อง' });

    // Always return success to prevent email enumeration attacks
    const user = await db.getOne('SELECT id FROM users WHERE email=?', [email]);

    const existing = resetStore.get(email);
    if (existing && Date.now() - existing.sentAt < 60_000) {
      return res.json({ ok: true }); // Silently ignore — no enumeration
    }

    if (user) {
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      resetStore.set(email, { code, expiresAt: Date.now() + 15 * 60_000, sentAt: Date.now() });
      // TODO: ส่งอีเมลจริงผ่าน Nodemailer / Resend
      const isDev = process.env.NODE_ENV !== 'production';
      if (isDev) console.log(`[RESET] 📧 ${email} → ${code}`);
      return res.json({ ok: true, ...(isDev && { _dev_code: code }) });
    }

    res.json({ ok: true }); // Email not found — same response to prevent enumeration
  } catch { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.post('/api/user/reset-password', async (req, res) => {
  try {
    const email    = sanitizeStr(req.body.email, 200).toLowerCase();
    const code     = sanitizeStr(req.body.code, 10);
    const password = req.body.password || '';
    if (!email || !code || !password) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
    if (password.length < 6) return res.status(400).json({ error: 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร' });

    const record = resetStore.get(email);
    if (!record) return res.status(400).json({ error: 'ไม่พบรหัสรีเซ็ต หรือหมดอายุแล้ว กรุณาขอใหม่' });
    if (Date.now() > record.expiresAt) { resetStore.delete(email); return res.status(400).json({ error: 'รหัสหมดอายุแล้ว (15 นาที) กรุณาขอใหม่' }); }
    record.attempts = (record.attempts || 0) + 1;
    if (record.attempts > 5) { resetStore.delete(email); return res.status(400).json({ error: 'ใส่รหัสผิดเกิน 5 ครั้ง กรุณาขอรหัสใหม่' }); }
    if (record.code !== code) return res.status(400).json({ error: `รหัสยืนยันไม่ถูกต้อง (เหลือ ${5 - record.attempts} ครั้ง)` });

    const user = await db.getOne('SELECT id FROM users WHERE email=?', [email]);
    if (!user) return res.status(400).json({ error: 'ข้อมูลไม่ถูกต้อง' }); // Don't reveal email not found
    await db.run('UPDATE users SET password=? WHERE email=?', [bcrypt.hashSync(password, 10), email]);
    resetStore.delete(email);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.post('/api/user/login', async (req, res) => {
  try {
    const identifier = sanitizeStr(req.body.phone, 200).toLowerCase();
    const password   = req.body.password || '';
    if (!identifier || !password) return res.status(400).json({ error: 'กรุณากรอกข้อมูล' });

    const cd = cooldownResponse(loginAttemptStore, identifier);
    if (cd) return res.status(429).json(cd);

    const user = await db.getOne('SELECT * FROM users WHERE email = ? OR phone = ?', [identifier, identifier]);
    const validPass = user?.password ? bcrypt.compareSync(password, user.password) : false;
    if (!user || !validPass) {
      const r = recordFailedAttempt(loginAttemptStore, identifier);
      return res.status(r.locked ? 429 : 401).json({ error: r.error, ...(r.retryAfter && { retryAfter: r.retryAfter }) });
    }

    loginAttemptStore.delete(identifier);
    res.json({ token: userToken(user), name: user.name, id: user.id });
  } catch { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.post('/api/user/google', async (req, res) => {
  const { credential } = req.body;
  if (!credential || typeof credential !== 'string')
    return res.status(400).json({ error: 'ข้อมูลไม่ถูกต้อง' });
  try {
    // Verify token via Google's API — validates signature, expiry, and audience
    const payload = await verifyGoogleToken(credential);
    const { sub: googleId, name, email, picture } = payload;
    if (!googleId) throw new Error('Missing sub claim');

    let user = await db.getOne('SELECT * FROM users WHERE google_id = ?', [googleId]);
    if (!user && email) user = await db.getOne('SELECT * FROM users WHERE email = ?', [email]);

    if (user) {
      if (!user.google_id) await db.run('UPDATE users SET google_id=?,avatar_url=? WHERE id=?', [googleId, picture || '', user.id]);
    } else {
      user = await db.queryOne(
        'INSERT INTO users (name,email,google_id,avatar_url) VALUES (?,?,?,?) RETURNING *',
        [sanitizeStr(name || 'ผู้ใช้ Google', 100), email || null, googleId, picture || '']
      );
    }
    if (!user) throw new Error('User lookup failed');
    res.json({ token: userToken(user), name: user.name, id: user.id });
  } catch (err) {
    console.error('[Google Login]', err.message);
    res.status(401).json({ error: 'Google login ไม่สำเร็จ' });
  }
});

app.post('/api/user/facebook', async (req, res) => {
  try {
    const { accessToken } = req.body;
    if (!accessToken || typeof accessToken !== 'string')
      return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });

    // Verify access_token via Facebook Graph API — prevents spoofing
    const fbUser = await verifyFacebookToken(accessToken);
    const fbId   = fbUser.id;
    const name   = sanitizeStr(fbUser.name || '', 100);
    const email  = fbUser.email || null;
    const picture = fbUser.picture?.data?.url || '';

    let user = await db.getOne('SELECT * FROM users WHERE facebook_id = ?', [fbId]);
    if (!user && email) user = await db.getOne('SELECT * FROM users WHERE email = ?', [email]);
    if (user) {
      if (!user.facebook_id) await db.run('UPDATE users SET facebook_id=?,avatar_url=? WHERE id=?', [fbId, picture, user.id]);
      user = await db.getOne('SELECT * FROM users WHERE id = ?', [user.id]);
    } else {
      user = await db.queryOne(
        'INSERT INTO users (name,email,facebook_id,avatar_url) VALUES (?,?,?,?) RETURNING *',
        [name, email, fbId, picture]
      );
    }
    if (!user) throw new Error('User lookup failed');
    res.json({ token: userToken(user), name: user.name, id: user.id });
  } catch (err) {
    console.error('[Facebook Login]', err.message);
    res.status(500).json({ error: 'Facebook login ไม่สำเร็จ' });
  }
});

app.get('/api/user/profile', requireUser, async (req, res) => {
  try {
    const user      = await db.getOne('SELECT id,name,phone,email,avatar_url,created_at FROM users WHERE id=?', [req.user.id]);
    const addresses = await db.getAll('SELECT * FROM user_addresses WHERE user_id=? ORDER BY is_default DESC,id DESC', [req.user.id]);
    const ordersRaw = await db.getAll('SELECT * FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 50', [req.user.id]);
    const orders    = await Promise.all(ordersRaw.map(async o => ({
      ...o, items: await db.getAll('SELECT * FROM order_items WHERE order_id=?', [o.id])
    })));
    const wishlist = await db.getAll(`
      SELECT p.* FROM user_wishlist w
      JOIN products p ON p.id = w.product_id
      WHERE w.user_id = ? AND p.active = 1
      ORDER BY w.created_at DESC`, [req.user.id]);
    const stats = {
      delivered: orders.filter(o => o.status === 'delivered').length,
      shipping:  orders.filter(o => o.status === 'shipping').length,
      pending:   orders.filter(o => o.status === 'pending' || o.status === 'confirmed').length,
      unpaid:    orders.filter(o => o.payment_status !== 'paid' && o.status !== 'cancelled').length,
    };
    res.json({ ...user, addresses, orders, wishlist, stats });
  } catch { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.put('/api/user/profile', requireUser, async (req, res) => {
  try {
    const name  = sanitizeStr(req.body.name, 100);
    const email = sanitizeStr(req.body.email, 200).toLowerCase();
    if (!name || name.length < 2) return res.status(400).json({ error: 'ชื่อไม่ถูกต้อง' });
    if (email && !isValidEmail(email)) return res.status(400).json({ error: 'อีเมลไม่ถูกต้อง' });
    await db.run('UPDATE users SET name=?,email=? WHERE id=?', [name, email || null, req.user.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.put('/api/user/password', requireUser, async (req, res) => {
  try {
    const { current, next } = req.body;
    const user = await db.getOne('SELECT * FROM users WHERE id=?', [req.user.id]);
    if (user.password && !bcrypt.compareSync(current || '', user.password))
      return res.status(400).json({ error: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' });
    if (!next || next.length < 6) return res.status(400).json({ error: 'รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัว' });
    await db.run('UPDATE users SET password=? WHERE id=?', [bcrypt.hashSync(next, 10), req.user.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

// ─── Wishlist ─────────────────────────────────────────────────────────────────
app.get('/api/user/wishlist', requireUser, async (req, res) => {
  try {
    res.json(await db.getAll(`
      SELECT p.* FROM user_wishlist w JOIN products p ON p.id=w.product_id
      WHERE w.user_id=? AND p.active=1 ORDER BY w.created_at DESC`, [req.user.id]));
  } catch { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.post('/api/user/wishlist/:productId', requireUser, async (req, res) => {
  try {
    const pid = parseInt(req.params.productId);
    if (!pid || isNaN(pid)) return res.status(400).json({ error: 'ข้อมูลไม่ถูกต้อง' });
    if (!await db.getOne('SELECT id FROM products WHERE id=? AND active=1', [pid]))
      return res.status(404).json({ error: 'ไม่พบสินค้า' });
    try { await db.run('INSERT INTO user_wishlist (user_id,product_id) VALUES (?,?)', [req.user.id, pid]); } catch {}
    res.json({ ok: true, inWishlist: true });
  } catch { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.delete('/api/user/wishlist/:productId', requireUser, async (req, res) => {
  try {
    const pid = parseInt(req.params.productId);
    if (!pid || isNaN(pid)) return res.status(400).json({ error: 'ข้อมูลไม่ถูกต้อง' });
    await db.run('DELETE FROM user_wishlist WHERE user_id=? AND product_id=?', [req.user.id, pid]);
    res.json({ ok: true, inWishlist: false });
  } catch { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

// ─── Addresses ────────────────────────────────────────────────────────────────
app.get('/api/user/addresses', requireUser, async (req, res) => {
  try {
    res.json(await db.getAll('SELECT * FROM user_addresses WHERE user_id=? ORDER BY is_default DESC,id ASC', [req.user.id]));
  } catch { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.post('/api/user/addresses', requireUser, async (req, res) => {
  try {
    const label          = sanitizeStr(req.body.label, 50)          || 'บ้าน';
    const recipient_name = sanitizeStr(req.body.recipient_name, 100);
    const phone          = sanitizeStr(req.body.phone, 20);
    const address_text   = sanitizeStr(req.body.address_text, 500);
    const is_default     = !!req.body.is_default;
    if (!recipient_name || !phone || !address_text) return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบ' });
    if (is_default) await db.run('UPDATE user_addresses SET is_default=0 WHERE user_id=?', [req.user.id]);
    const addr = await db.queryOne(
      'INSERT INTO user_addresses (user_id,label,recipient_name,phone,address_text,is_default) VALUES (?,?,?,?,?,?) RETURNING *',
      [req.user.id, label, recipient_name, phone, address_text, is_default ? 1 : 0]
    );
    res.status(201).json(addr);
  } catch { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.put('/api/user/addresses/:id', requireUser, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!await db.getOne('SELECT id FROM user_addresses WHERE id=? AND user_id=?', [id, req.user.id]))
      return res.status(404).json({ error: 'ไม่พบที่อยู่' });
    const label          = sanitizeStr(req.body.label, 50)          || 'บ้าน';
    const recipient_name = sanitizeStr(req.body.recipient_name, 100);
    const phone          = sanitizeStr(req.body.phone, 20);
    const address_text   = sanitizeStr(req.body.address_text, 500);
    const is_default     = !!req.body.is_default;
    if (!recipient_name || !phone || !address_text) return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบ' });
    if (is_default) await db.run('UPDATE user_addresses SET is_default=0 WHERE user_id=?', [req.user.id]);
    await db.run('UPDATE user_addresses SET label=?,recipient_name=?,phone=?,address_text=?,is_default=? WHERE id=?',
      [label, recipient_name, phone, address_text, is_default ? 1 : 0, id]);
    res.json(await db.getOne('SELECT * FROM user_addresses WHERE id=?', [id]));
  } catch { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.delete('/api/user/addresses/:id', requireUser, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!await db.getOne('SELECT id FROM user_addresses WHERE id=? AND user_id=?', [id, req.user.id]))
      return res.status(404).json({ error: 'ไม่พบที่อยู่' });
    await db.run('DELETE FROM user_addresses WHERE id=? AND user_id=?', [id, req.user.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

// ─── Saved Cards ──────────────────────────────────────────────────────────────
app.get('/api/user/cards', requireUser, async (req, res) => {
  try {
    res.json(await db.getAll('SELECT * FROM user_saved_cards WHERE user_id=? ORDER BY is_default DESC,created_at DESC', [req.user.id]));
  } catch { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.post('/api/user/cards', requireUser, async (req, res) => {
  try {
    const last_four   = sanitizeStr(req.body.last_four, 4);
    const card_brand  = sanitizeStr(req.body.card_brand, 20);
    const expiry      = sanitizeStr(req.body.expiry, 7);
    const holder_name = sanitizeStr(req.body.holder_name, 100);
    const label       = sanitizeStr(req.body.label, 50) || 'บัตรของฉัน';
    const card_token  = sanitizeStr(req.body.card_token, 200);
    const is_default  = !!req.body.is_default;

    if (!last_four || !card_brand || !expiry || !holder_name) return res.status(400).json({ error: 'ข้อมูลบัตรไม่ครบ' });
    if (!/^\d{4}$/.test(last_four)) return res.status(400).json({ error: 'เลขท้ายบัตรไม่ถูกต้อง' });

    const count = (await db.getOne('SELECT COUNT(*) as c FROM user_saved_cards WHERE user_id=?', [req.user.id]))?.c || 0;
    const setDefault = (is_default || parseInt(count) === 0) ? 1 : 0;
    if (setDefault) await db.run('UPDATE user_saved_cards SET is_default=0 WHERE user_id=?', [req.user.id]);

    const card = await db.queryOne(
      'INSERT INTO user_saved_cards (user_id,last_four,card_brand,expiry,holder_name,label,card_token,is_default) VALUES (?,?,?,?,?,?,?,?) RETURNING *',
      [req.user.id, last_four, card_brand, expiry, holder_name, label, card_token, setDefault]
    );
    res.status(201).json(card);
  } catch { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.delete('/api/user/cards/:id', requireUser, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const card = await db.getOne('SELECT * FROM user_saved_cards WHERE id=? AND user_id=?', [id, req.user.id]);
    if (!card) return res.status(404).json({ error: 'ไม่พบบัตร' });
    await db.run('DELETE FROM user_saved_cards WHERE id=?', [id]);
    if (card.is_default) {
      const next = await db.getOne('SELECT id FROM user_saved_cards WHERE user_id=? ORDER BY created_at DESC', [req.user.id]);
      if (next) await db.run('UPDATE user_saved_cards SET is_default=1 WHERE id=?', [next.id]);
    }
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.patch('/api/user/cards/:id/default', requireUser, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!await db.getOne('SELECT id FROM user_saved_cards WHERE id=? AND user_id=?', [id, req.user.id]))
      return res.status(404).json({ error: 'ไม่พบบัตร' });
    await db.run('UPDATE user_saved_cards SET is_default=0 WHERE user_id=?', [req.user.id]);
    await db.run('UPDATE user_saved_cards SET is_default=1 WHERE id=?', [id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

// ─── Image Upload (admin) ─────────────────────────────────────────────────────
app.post('/api/admin/upload', requireAdmin, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ไม่พบไฟล์รูปภาพ' });
  if (!process.env.CLOUDINARY_CLOUD_NAME)
    return res.status(500).json({ error: 'ยังไม่ได้ตั้งค่า Cloudinary กรุณาตั้งค่า env vars ก่อน' });
  try {
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'buathong-rice', resource_type: 'image', quality: 'auto', fetch_format: 'auto' },
        (err, result) => { if (err) reject(err); else resolve(result); }
      );
      Readable.from(req.file.buffer).pipe(stream);
    });
    res.json({ url: result.secure_url });
  } catch (err) {
    console.error('[Upload]', err.message);
    res.status(500).json({ error: 'อัปโหลดรูปไม่สำเร็จ' });
  }
});

// ─── Products (public) ────────────────────────────────────────────────────────
app.get('/api/products', async (req, res) => {
  try {
    const category = sanitizeStr(req.query.category, 50);
    const search   = sanitizeStr(req.query.search, 100);
    let sql = 'SELECT * FROM products WHERE active=1';
    const p = [];
    if (category && category !== 'all') { sql += ' AND category=?'; p.push(category); }
    if (search) { sql += ' AND (name LIKE ? OR description LIKE ?)'; p.push(`%${search}%`, `%${search}%`); }
    res.json(await db.getAll(sql + ' ORDER BY id ASC', p));
  } catch { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.get('/api/products/categories', async (req, res) => {
  try {
    res.json((await db.getAll('SELECT DISTINCT category FROM products WHERE active=1')).map(c => c.category));
  } catch { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

// ─── Products (admin) ─────────────────────────────────────────────────────────
app.get('/api/admin/products', requireAdmin, async (req, res) => {
  try { res.json(await db.getAll('SELECT * FROM products ORDER BY id DESC')); }
  catch { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.post('/api/admin/products', requireAdmin, async (req, res) => {
  try {
    const name        = sanitizeStr(req.body.name, 200);
    const description = sanitizeStr(req.body.description, 1000);
    const price       = parseFloat(req.body.price);
    const unit        = sanitizeStr(req.body.unit, 50)     || 'กิโลกรัม';
    const stock       = parseInt(req.body.stock)           || 0;
    const image_url   = sanitizeStr(req.body.image_url, 500);
    const category    = sanitizeStr(req.body.category, 50) || 'ข้าวสาร';
    const badge       = sanitizeStr(req.body.badge, 20);

    if (!name) return res.status(400).json({ error: 'กรุณากรอกชื่อสินค้า' });
    if (isNaN(price) || price < 0) return res.status(400).json({ error: 'ราคาไม่ถูกต้อง' });
    if (stock < 0) return res.status(400).json({ error: 'จำนวนสต็อกไม่ถูกต้อง' });
    const VALID_BADGES = ['', 'bestseller', 'new', 'sale', 'recommended'];
    if (!VALID_BADGES.includes(badge)) return res.status(400).json({ error: 'แท็กไม่ถูกต้อง' });

    const product = await db.queryOne(
      'INSERT INTO products (name,description,price,unit,stock,image_url,category,badge) VALUES (?,?,?,?,?,?,?,?) RETURNING *',
      [name, description, price, unit, stock, image_url, category, badge]
    );
    res.status(201).json(product);
  } catch { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.put('/api/admin/products/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!await db.getOne('SELECT id FROM products WHERE id=?', [id]))
      return res.status(404).json({ error: 'ไม่พบสินค้า' });

    const name        = sanitizeStr(req.body.name, 200);
    const description = sanitizeStr(req.body.description, 1000);
    const price       = parseFloat(req.body.price);
    const unit        = sanitizeStr(req.body.unit, 50);
    const stock       = parseInt(req.body.stock);
    const image_url   = sanitizeStr(req.body.image_url, 500);
    const category    = sanitizeStr(req.body.category, 50);
    const badge       = sanitizeStr(req.body.badge, 20);
    const active      = !!req.body.active;

    if (!name) return res.status(400).json({ error: 'กรุณากรอกชื่อสินค้า' });
    if (isNaN(price) || price < 0) return res.status(400).json({ error: 'ราคาไม่ถูกต้อง' });
    if (isNaN(stock) || stock < 0) return res.status(400).json({ error: 'จำนวนสต็อกไม่ถูกต้อง' });
    const VALID_BADGES = ['', 'bestseller', 'new', 'sale', 'recommended'];
    if (!VALID_BADGES.includes(badge)) return res.status(400).json({ error: 'แท็กไม่ถูกต้อง' });

    await db.run(
      'UPDATE products SET name=?,description=?,price=?,unit=?,stock=?,image_url=?,category=?,active=?,badge=?,updated_at=NOW() WHERE id=?',
      [name, description, price, unit, stock, image_url, category, active ? 1 : 0, badge, id]
    );
    res.json(await db.getOne('SELECT * FROM products WHERE id=?', [id]));
  } catch { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.delete('/api/admin/products/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!await db.getOne('SELECT id FROM products WHERE id=?', [id]))
      return res.status(404).json({ error: 'ไม่พบสินค้า' });
    await db.run('UPDATE products SET active=0 WHERE id=?', [id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

// ─── Orders ───────────────────────────────────────────────────────────────────
app.post('/api/orders', optionalUser, async (req, res) => {
  try {
    const customer_name    = sanitizeStr(req.body.customer_name, 100);
    const customer_phone   = sanitizeStr(req.body.customer_phone, 20);
    const customer_address = sanitizeStr(req.body.customer_address, 500);
    const note             = sanitizeStr(req.body.note, 500);
    const payment_method   = sanitizeStr(req.body.payment_method, 50) || 'pending';
    const items            = req.body.items;

    if (!customer_name || !customer_phone || !customer_address || !Array.isArray(items) || !items.length)
      return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบ' });
    if (items.length > 50) return res.status(400).json({ error: 'จำนวนสินค้าเกินกำหนด' });

    let total = 0;
    const enriched = [];
    for (const item of items) {
      const pid = parseInt(item.product_id);
      const qty = parseInt(item.quantity);
      if (!pid || isNaN(pid) || !qty || qty < 1 || qty > 9999) return res.status(400).json({ error: 'ข้อมูลสินค้าไม่ถูกต้อง' });
      const p = await db.getOne('SELECT * FROM products WHERE id=? AND active=1', [pid]);
      if (!p) return res.status(400).json({ error: `ไม่พบสินค้า` });
      if (p.stock < qty) return res.status(400).json({ error: `"${p.name}" มีสต็อกไม่พอ` });
      total += p.price * qty;
      enriched.push({ product_id: pid, quantity: qty, product: p });
    }

    const orderNum = 'BT' + Date.now().toString().slice(-8);
    const newOrder = await db.queryOne(
      'INSERT INTO orders (order_number,user_id,customer_name,customer_phone,customer_address,total_amount,note,payment_method) VALUES (?,?,?,?,?,?,?,?) RETURNING *',
      [orderNum, req.user?.id || null, customer_name, customer_phone, customer_address, total, note, payment_method]
    );
    if (!newOrder) return res.status(500).json({ error: 'บันทึกออเดอร์ไม่สำเร็จ' });

    for (const item of enriched) {
      await db.run('INSERT INTO order_items (order_id,product_id,product_name,quantity,unit,price) VALUES (?,?,?,?,?,?)',
        [newOrder.id, item.product_id, item.product.name, item.quantity, item.product.unit, item.product.price]);
      await db.run('UPDATE products SET stock=stock-? WHERE id=?', [item.quantity, item.product_id]);
    }
    res.status(201).json(newOrder);
  } catch { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.put('/api/orders/:id/payment', optionalUser, async (req, res) => {
  try {
    const id             = parseInt(req.params.id);
    const payment_method = sanitizeStr(req.body.payment_method, 50);
    const payment_status = sanitizeStr(req.body.payment_status, 20);
    const VALID_STATUS   = ['unpaid', 'paid', 'pending'];
    if (!VALID_STATUS.includes(payment_status)) return res.status(400).json({ error: 'สถานะไม่ถูกต้อง' });
    const order = await db.getOne('SELECT * FROM orders WHERE id=?', [id]);
    if (!order) return res.status(404).json({ error: 'ไม่พบออเดอร์' });
    await db.run('UPDATE orders SET payment_method=?,payment_status=?,status=? WHERE id=?',
      [payment_method, payment_status, payment_status === 'paid' ? 'confirmed' : order.status, id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

// ─── Users (admin) ────────────────────────────────────────────────────────────
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    res.json(await db.getAll(`
      SELECT u.id, u.name, u.phone, u.email, u.avatar_url, u.created_at,
        (u.google_id IS NOT NULL)   as has_google,
        (u.facebook_id IS NOT NULL) as has_facebook,
        COUNT(o.id) as order_count,
        COALESCE(SUM(o.total_amount), 0) as total_spent
      FROM users u
      LEFT JOIN orders o ON o.user_id = u.id AND o.status != 'cancelled'
      GROUP BY u.id ORDER BY u.id DESC
    `, []));
  } catch { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

// ─── Orders (admin) ───────────────────────────────────────────────────────────
app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  try {
    const orders = await db.getAll('SELECT * FROM orders ORDER BY id DESC');
    res.json(await Promise.all(orders.map(async o => ({
      ...o, items: await db.getAll('SELECT * FROM order_items WHERE order_id=?', [o.id])
    }))));
  } catch { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.put('/api/admin/orders/:id/status', requireAdmin, async (req, res) => {
  try {
    const VALID = ['pending','confirmed','shipping','delivered','cancelled'];
    const status = sanitizeStr(req.body.status, 20);
    if (!VALID.includes(status)) return res.status(400).json({ error: 'สถานะไม่ถูกต้อง' });
    await db.run('UPDATE orders SET status=? WHERE id=?', [status, parseInt(req.params.id)]);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.get('/api/admin/dashboard', requireAdmin, async (req, res) => {
  try {
    const [totalOrders, pendingOrders, revenue, totalProducts, totalUsers] = await Promise.all([
      db.getOne('SELECT COUNT(*) as c FROM orders'),
      db.getOne("SELECT COUNT(*) as c FROM orders WHERE status='pending'"),
      db.getOne("SELECT COALESCE(SUM(total_amount),0) as t FROM orders WHERE status!='cancelled'"),
      db.getOne('SELECT COUNT(*) as c FROM products WHERE active=1'),
      db.getOne('SELECT COUNT(*) as c FROM users'),
    ]);
    res.json({
      totalOrders:   parseInt(totalOrders.c),
      pendingOrders: parseInt(pendingOrders.c),
      totalRevenue:  parseFloat(revenue.t),
      totalProducts: parseInt(totalProducts.c),
      totalUsers:    parseInt(totalUsers.c),
    });
  } catch { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

// ─── SPA Fallback ─────────────────────────────────────────────────────────────
app.get('/admin*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

db.init().then(() => {
  app.listen(PORT, () => console.log(`🌾 บัวทองไรซ์ running on port ${PORT}`));
}).catch(err => { console.error('DB init failed:', err); process.exit(1); });
