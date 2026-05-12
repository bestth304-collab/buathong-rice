const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const db = require('./database');
const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'buathong-rice-secret-2024';

// ─── In-memory stores (reset on restart — acceptable for ephemeral data) ───────
const otpStore          = new Map();
const resetStore        = new Map();
const loginAttemptStore = new Map();
const adminAttemptStore = new Map();
setInterval(() => {
  const now = Date.now();
  otpStore.forEach((v, k)          => { if (now > v.expiresAt) otpStore.delete(k); });
  resetStore.forEach((v, k)        => { if (now > v.expiresAt) resetStore.delete(k); });
  loginAttemptStore.forEach((v, k) => { if (now > v.lockedUntil) loginAttemptStore.delete(k); });
  adminAttemptStore.forEach((v, k) => { if (now > v.lockedUntil) adminAttemptStore.delete(k); });
}, 5 * 60_000);

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const FACEBOOK_APP_ID  = process.env.FACEBOOK_APP_ID  || '';
const PROMPTPAY_ID     = process.env.PROMPTPAY_ID     || '0812345678';
const OMISE_PUBLIC     = process.env.OMISE_PUBLIC_KEY || '';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Middleware ───────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const token = (req.headers.authorization || '').slice(7);
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const p = jwt.verify(token, JWT_SECRET);
    if (p.type !== 'admin') throw new Error();
    req.admin = p; next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

function requireUser(req, res, next) {
  const token = (req.headers.authorization || '').slice(7);
  if (!token) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
  try {
    const p = jwt.verify(token, JWT_SECRET);
    if (p.type !== 'user') throw new Error();
    req.user = p; next();
  } catch { res.status(401).json({ error: 'Token ไม่ถูกต้อง' }); }
}

function optionalUser(req, res, next) {
  const token = (req.headers.authorization || '').slice(7);
  if (token) {
    try { const p = jwt.verify(token, JWT_SECRET); if (p.type === 'user') req.user = p; } catch {}
  }
  next();
}

function userToken(user) {
  return jwt.sign(
    { type: 'user', id: user.id, name: user.name, phone: user.phone, email: user.email },
    JWT_SECRET, { expiresIn: '30d' }
  );
}

function cooldownResponse(store, key) {
  const a = store.get(key);
  if (a && a.lockedUntil > Date.now()) {
    const secs = Math.ceil((a.lockedUntil - Date.now()) / 1000);
    const mins = Math.floor(secs / 60), s = secs % 60;
    return { error: `เข้าสู่ระบบผิดพลาดเกินกำหนด กรุณารอ ${mins > 0 ? mins + ' นาที ' : ''}${s} วินาที`, retryAfter: secs };
  }
  return null;
}

function recordFailedAttempt(store, key, max = 3, lockMs = 5 * 60_000) {
  const cur = store.get(key) || { attempts: 0, lockedUntil: 0 };
  cur.attempts += 1;
  if (cur.attempts >= max) {
    cur.lockedUntil = Date.now() + lockMs;
    store.set(key, cur);
    return { locked: true, error: `เข้าสู่ระบบผิดพลาดเกิน ${max} ครั้ง บัญชีถูกระงับชั่วคราว 5 นาที`, retryAfter: Math.ceil(lockMs / 1000) };
  }
  store.set(key, cur);
  return { locked: false, error: `ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง (เหลืออีก ${max - cur.attempts} ครั้ง)` };
}

// ─── Public Config ────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({
    googleClientId: GOOGLE_CLIENT_ID,
    facebookAppId: FACEBOOK_APP_ID,
    promptpayId: PROMPTPAY_ID,
    omisePublicKey: OMISE_PUBLIC,
    hasOmise: !!OMISE_PUBLIC,
    hasGoogle: !!GOOGLE_CLIENT_ID,
    hasFacebook: !!FACEBOOK_APP_ID,
  });
});

// ─── Admin Auth ───────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'กรุณากรอกข้อมูล' });

    const key = username.toLowerCase().trim();
    const cd  = cooldownResponse(adminAttemptStore, key);
    if (cd) return res.status(429).json(cd);

    const admin = await db.getOne('SELECT * FROM admins WHERE username = ?', [username]);
    if (!admin || !bcrypt.compareSync(password, admin.password)) {
      const r = recordFailedAttempt(adminAttemptStore, key);
      return res.status(r.locked ? 429 : 401).json({ error: r.error, ...(r.retryAfter && { retryAfter: r.retryAfter }) });
    }

    adminAttemptStore.delete(key);
    const token = jwt.sign({ type: 'admin', id: admin.id, username: admin.username, name: admin.name }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, name: admin.name });
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.get('/api/auth/verify', requireAdmin, (req, res) => res.json({ valid: true, name: req.admin.name }));

// ─── User Auth ────────────────────────────────────────────────────────────────
app.post('/api/user/otp/send', async (req, res) => {
  try {
    const { phone } = req.body;
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
    console.log(`[OTP] 📱 ${phone} → ${otp}`);

    const isDev = process.env.NODE_ENV !== 'production';
    res.json({ ok: true, ...(isDev && { _dev_otp: otp }) });
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.post('/api/user/register', async (req, res) => {
  try {
    const { name, phone, email, password } = req.body;
    if (!name || !phone || !password) return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบ' });
    if (!/^0[0-9]{9}$/.test(phone)) return res.status(400).json({ error: 'เบอร์โทรไม่ถูกต้อง (0XXXXXXXXX)' });
    if (password.length < 6) return res.status(400).json({ error: 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร' });
    if (await db.getOne('SELECT id FROM users WHERE phone = ?', [phone]))
      return res.status(409).json({ error: 'เบอร์โทรนี้ถูกใช้งานแล้ว' });

    const user = await db.queryOne(
      'INSERT INTO users (name,phone,email,password) VALUES (?,?,?,?) RETURNING *',
      [name, phone, email || null, bcrypt.hashSync(password, 10)]
    );
    if (!user) return res.status(500).json({ error: 'สร้างบัญชีไม่สำเร็จ กรุณาลองใหม่' });
    res.status(201).json({ token: userToken(user), name: user.name, id: user.id });
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด: ' + err.message }); }
});

// ─── Forgot / Reset Password ──────────────────────────────────────────────────
app.post('/api/user/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'กรุณากรอกอีเมล' });
    const user = await db.getOne('SELECT id FROM users WHERE email=?', [email.toLowerCase().trim()]);
    if (!user) return res.status(404).json({ error: 'ไม่พบบัญชีที่ใช้อีเมลนี้' });

    const existing = resetStore.get(email);
    if (existing && Date.now() - existing.sentAt < 60_000) {
      const wait = Math.ceil((60_000 - (Date.now() - existing.sentAt)) / 1000);
      return res.status(429).json({ error: `กรุณารอ ${wait} วินาทีก่อนส่งใหม่` });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    resetStore.set(email, { code, expiresAt: Date.now() + 15 * 60_000, sentAt: Date.now() });
    console.log(`[RESET] 📧 ${email} → ${code}`);

    const isDev = process.env.NODE_ENV !== 'production';
    res.json({ ok: true, ...(isDev && { _dev_code: code }) });
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.post('/api/user/reset-password', async (req, res) => {
  try {
    const { email, code, password } = req.body;
    if (!email || !code || !password) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
    if (password.length < 6) return res.status(400).json({ error: 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร' });

    const record = resetStore.get(email);
    if (!record) return res.status(400).json({ error: 'ไม่พบรหัสรีเซ็ต หรือหมดอายุแล้ว กรุณาขอใหม่' });
    if (Date.now() > record.expiresAt) { resetStore.delete(email); return res.status(400).json({ error: 'รหัสหมดอายุแล้ว (15 นาที) กรุณาขอใหม่' }); }
    record.attempts = (record.attempts || 0) + 1;
    if (record.attempts > 5) { resetStore.delete(email); return res.status(400).json({ error: 'ใส่รหัสผิดเกิน 5 ครั้ง กรุณาขอรหัสใหม่' }); }
    if (record.code !== code.trim()) return res.status(400).json({ error: `รหัสยืนยันไม่ถูกต้อง (เหลือ ${5 - record.attempts} ครั้ง)` });

    const user = await db.getOne('SELECT id FROM users WHERE email=?', [email]);
    if (!user) return res.status(404).json({ error: 'ไม่พบบัญชีผู้ใช้' });
    await db.run('UPDATE users SET password=? WHERE email=?', [bcrypt.hashSync(password, 10), email]);
    resetStore.delete(email);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.post('/api/user/login', async (req, res) => {
  try {
    const { phone: identifier, password } = req.body;
    if (!identifier || !password) return res.status(400).json({ error: 'กรุณากรอกข้อมูล' });

    const key = identifier.toLowerCase().trim();
    const cd  = cooldownResponse(loginAttemptStore, key);
    if (cd) return res.status(429).json(cd);

    const user = await db.getOne('SELECT * FROM users WHERE email = ? OR phone = ?', [identifier, identifier]);
    if (!user || !user.password || !bcrypt.compareSync(password, user.password)) {
      const r = recordFailedAttempt(loginAttemptStore, key);
      return res.status(r.locked ? 429 : 401).json({ error: r.error, ...(r.retryAfter && { retryAfter: r.retryAfter }) });
    }

    loginAttemptStore.delete(key);
    res.json({ token: userToken(user), name: user.name, id: user.id });
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.post('/api/user/google', async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'ไม่มี credential' });
  try {
    const payloadB64 = credential.split('.')[1];
    if (!payloadB64) throw new Error('Invalid JWT format');
    const padded = payloadB64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((payloadB64.length + 3) % 4);
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    const { sub: googleId, name, email, picture } = payload;
    if (!googleId) throw new Error('Missing sub claim');

    let user = await db.getOne('SELECT * FROM users WHERE google_id = ?', [googleId]);
    if (!user && email) user = await db.getOne('SELECT * FROM users WHERE email = ?', [email]);

    if (user) {
      if (!user.google_id) await db.run('UPDATE users SET google_id=?,avatar_url=? WHERE id=?', [googleId, picture || '', user.id]);
    } else {
      user = await db.queryOne(
        'INSERT INTO users (name,email,google_id,avatar_url) VALUES (?,?,?,?) RETURNING *',
        [name || 'ผู้ใช้ Google', email || null, googleId, picture || '']
      );
    }

    if (!user) throw new Error('User lookup failed after insert');
    res.json({ token: userToken(user), name: user.name, id: user.id });
  } catch (err) {
    console.error('[Google Login]', err.message);
    res.status(401).json({ error: 'Google login ไม่สำเร็จ' });
  }
});

app.post('/api/user/facebook', async (req, res) => {
  try {
    const { fbId, name, email, picture } = req.body;
    if (!fbId || !name) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
    let user = await db.getOne('SELECT * FROM users WHERE facebook_id = ?', [fbId]);
    if (!user && email) user = await db.getOne('SELECT * FROM users WHERE email = ?', [email]);
    if (user) {
      if (!user.facebook_id) await db.run('UPDATE users SET facebook_id=?,avatar_url=? WHERE id=?', [fbId, picture || '', user.id]);
      user = await db.getOne('SELECT * FROM users WHERE id = ?', [user.id]);
    } else {
      user = await db.queryOne(
        'INSERT INTO users (name,email,facebook_id,avatar_url) VALUES (?,?,?,?) RETURNING *',
        [name, email || null, fbId, picture || '']
      );
    }
    if (!user) throw new Error('User lookup failed after insert');
    res.json({ token: userToken(user), name: user.name, id: user.id });
  } catch (err) {
    console.error('[Facebook Login]', err.message);
    res.status(500).json({ error: 'Facebook login ไม่สำเร็จ: ' + err.message });
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
    const wishlist  = await db.getAll(`
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
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.put('/api/user/profile', requireUser, async (req, res) => {
  try {
    const { name, email } = req.body;
    await db.run('UPDATE users SET name=?,email=? WHERE id=?', [name, email || null, req.user.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.put('/api/user/password', requireUser, async (req, res) => {
  try {
    const { current, next } = req.body;
    const user = await db.getOne('SELECT * FROM users WHERE id=?', [req.user.id]);
    if (user.password && !bcrypt.compareSync(current, user.password))
      return res.status(400).json({ error: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' });
    if (!next || next.length < 6) return res.status(400).json({ error: 'รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัว' });
    await db.run('UPDATE users SET password=? WHERE id=?', [bcrypt.hashSync(next, 10), req.user.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

// ─── Wishlist ─────────────────────────────────────────────────────────────────
app.get('/api/user/wishlist', requireUser, async (req, res) => {
  try {
    res.json(await db.getAll(`
      SELECT p.* FROM user_wishlist w JOIN products p ON p.id=w.product_id
      WHERE w.user_id=? AND p.active=1 ORDER BY w.created_at DESC`, [req.user.id]));
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.post('/api/user/wishlist/:productId', requireUser, async (req, res) => {
  try {
    const pid = parseInt(req.params.productId);
    if (!await db.getOne('SELECT id FROM products WHERE id=? AND active=1', [pid]))
      return res.status(404).json({ error: 'ไม่พบสินค้า' });
    try { await db.run('INSERT INTO user_wishlist (user_id,product_id) VALUES (?,?)', [req.user.id, pid]); } catch {}
    res.json({ ok: true, inWishlist: true });
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.delete('/api/user/wishlist/:productId', requireUser, async (req, res) => {
  try {
    await db.run('DELETE FROM user_wishlist WHERE user_id=? AND product_id=?', [req.user.id, parseInt(req.params.productId)]);
    res.json({ ok: true, inWishlist: false });
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

// ─── Addresses ────────────────────────────────────────────────────────────────
app.get('/api/user/addresses', requireUser, async (req, res) => {
  try {
    res.json(await db.getAll('SELECT * FROM user_addresses WHERE user_id=? ORDER BY is_default DESC,id ASC', [req.user.id]));
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.post('/api/user/addresses', requireUser, async (req, res) => {
  try {
    const { label, recipient_name, phone, address_text, is_default } = req.body;
    if (!recipient_name || !phone || !address_text) return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบ' });
    if (is_default) await db.run('UPDATE user_addresses SET is_default=0 WHERE user_id=?', [req.user.id]);
    const addr = await db.queryOne(
      'INSERT INTO user_addresses (user_id,label,recipient_name,phone,address_text,is_default) VALUES (?,?,?,?,?,?) RETURNING *',
      [req.user.id, label || 'บ้าน', recipient_name, phone, address_text, is_default ? 1 : 0]
    );
    res.status(201).json(addr);
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.put('/api/user/addresses/:id', requireUser, async (req, res) => {
  try {
    const addr = await db.getOne('SELECT id FROM user_addresses WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    if (!addr) return res.status(404).json({ error: 'ไม่พบที่อยู่' });
    const { label, recipient_name, phone, address_text, is_default } = req.body;
    if (is_default) await db.run('UPDATE user_addresses SET is_default=0 WHERE user_id=?', [req.user.id]);
    await db.run('UPDATE user_addresses SET label=?,recipient_name=?,phone=?,address_text=?,is_default=? WHERE id=?',
      [label, recipient_name, phone, address_text, is_default ? 1 : 0, req.params.id]);
    res.json(await db.getOne('SELECT * FROM user_addresses WHERE id=?', [req.params.id]));
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.delete('/api/user/addresses/:id', requireUser, async (req, res) => {
  try {
    await db.run('DELETE FROM user_addresses WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

// ─── Saved Cards ──────────────────────────────────────────────────────────────
app.get('/api/user/cards', requireUser, async (req, res) => {
  try {
    res.json(await db.getAll(
      'SELECT * FROM user_saved_cards WHERE user_id=? ORDER BY is_default DESC, created_at DESC', [req.user.id]
    ));
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.post('/api/user/cards', requireUser, async (req, res) => {
  try {
    const { last_four, card_brand, expiry, holder_name, label, card_token, is_default } = req.body;
    if (!last_four || !card_brand || !expiry || !holder_name) return res.status(400).json({ error: 'ข้อมูลบัตรไม่ครบ' });
    if (!/^\d{4}$/.test(last_four)) return res.status(400).json({ error: 'เลขท้ายบัตรไม่ถูกต้อง' });

    const count = (await db.getOne('SELECT COUNT(*) as c FROM user_saved_cards WHERE user_id=?', [req.user.id]))?.c || 0;
    const setDefault = (is_default || parseInt(count) === 0) ? 1 : 0;
    if (setDefault) await db.run('UPDATE user_saved_cards SET is_default=0 WHERE user_id=?', [req.user.id]);

    const card = await db.queryOne(
      'INSERT INTO user_saved_cards (user_id,last_four,card_brand,expiry,holder_name,label,card_token,is_default) VALUES (?,?,?,?,?,?,?,?) RETURNING *',
      [req.user.id, last_four, card_brand, expiry, holder_name, label || 'บัตรของฉัน', card_token || '', setDefault]
    );
    res.status(201).json(card);
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.delete('/api/user/cards/:id', requireUser, async (req, res) => {
  try {
    const card = await db.getOne('SELECT * FROM user_saved_cards WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    if (!card) return res.status(404).json({ error: 'ไม่พบบัตร' });
    await db.run('DELETE FROM user_saved_cards WHERE id=?', [req.params.id]);
    if (card.is_default) {
      const next = await db.getOne('SELECT id FROM user_saved_cards WHERE user_id=? ORDER BY created_at DESC', [req.user.id]);
      if (next) await db.run('UPDATE user_saved_cards SET is_default=1 WHERE id=?', [next.id]);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.patch('/api/user/cards/:id/default', requireUser, async (req, res) => {
  try {
    const card = await db.getOne('SELECT id FROM user_saved_cards WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    if (!card) return res.status(404).json({ error: 'ไม่พบบัตร' });
    await db.run('UPDATE user_saved_cards SET is_default=0 WHERE user_id=?', [req.user.id]);
    await db.run('UPDATE user_saved_cards SET is_default=1 WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

// ─── Products (public) ────────────────────────────────────────────────────────
app.get('/api/products', async (req, res) => {
  try {
    const { category, search } = req.query;
    let sql = 'SELECT * FROM products WHERE active=1';
    const p = [];
    if (category && category !== 'all') { sql += ' AND category=?'; p.push(category); }
    if (search) { sql += ' AND (name LIKE ? OR description LIKE ?)'; p.push(`%${search}%`, `%${search}%`); }
    res.json(await db.getAll(sql + ' ORDER BY id ASC', p));
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.get('/api/products/categories', async (req, res) => {
  try {
    res.json((await db.getAll('SELECT DISTINCT category FROM products WHERE active=1')).map(c => c.category));
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

// ─── Products (admin) ─────────────────────────────────────────────────────────
app.get('/api/admin/products', requireAdmin, async (req, res) => {
  try { res.json(await db.getAll('SELECT * FROM products ORDER BY id DESC')); }
  catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.post('/api/admin/products', requireAdmin, async (req, res) => {
  try {
    const { name, description, price, unit, stock, image_url, category, badge } = req.body;
    if (!name || price === undefined) return res.status(400).json({ error: 'กรุณากรอกชื่อและราคา' });
    const product = await db.queryOne(
      'INSERT INTO products (name,description,price,unit,stock,image_url,category,badge) VALUES (?,?,?,?,?,?,?,?) RETURNING *',
      [name, description || '', parseFloat(price), unit || 'กิโลกรัม', parseInt(stock) || 0, image_url || '', category || 'ข้าวสาร', badge || '']
    );
    res.status(201).json(product);
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.put('/api/admin/products/:id', requireAdmin, async (req, res) => {
  try {
    if (!await db.getOne('SELECT id FROM products WHERE id=?', [req.params.id]))
      return res.status(404).json({ error: 'ไม่พบสินค้า' });
    const { name, description, price, unit, stock, image_url, category, active, badge } = req.body;
    await db.run(
      'UPDATE products SET name=?,description=?,price=?,unit=?,stock=?,image_url=?,category=?,active=?,badge=?,updated_at=NOW() WHERE id=?',
      [name, description || '', parseFloat(price), unit, parseInt(stock), image_url || '', category, active ? 1 : 0, badge || '', req.params.id]
    );
    res.json(await db.getOne('SELECT * FROM products WHERE id=?', [req.params.id]));
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.delete('/api/admin/products/:id', requireAdmin, async (req, res) => {
  try {
    if (!await db.getOne('SELECT id FROM products WHERE id=?', [req.params.id]))
      return res.status(404).json({ error: 'ไม่พบสินค้า' });
    await db.run('UPDATE products SET active=0 WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

// ─── Orders ───────────────────────────────────────────────────────────────────
app.post('/api/orders', optionalUser, async (req, res) => {
  try {
    const { customer_name, customer_phone, customer_address, items, note, payment_method } = req.body;
    if (!customer_name || !customer_phone || !customer_address || !items?.length)
      return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบ' });

    let total = 0;
    const enriched = [];
    for (const item of items) {
      const p = await db.getOne('SELECT * FROM products WHERE id=? AND active=1', [item.product_id]);
      if (!p) return res.status(400).json({ error: `ไม่พบสินค้า ID: ${item.product_id}` });
      if (p.stock < item.quantity) return res.status(400).json({ error: `"${p.name}" มีสต็อกไม่พอ` });
      total += p.price * item.quantity;
      enriched.push({ ...item, product: p });
    }

    const orderNum = 'BT' + Date.now().toString().slice(-8);
    const userId = req.user?.id || null;
    const newOrder = await db.queryOne(
      'INSERT INTO orders (order_number,user_id,customer_name,customer_phone,customer_address,total_amount,note,payment_method) VALUES (?,?,?,?,?,?,?,?) RETURNING *',
      [orderNum, userId, customer_name, customer_phone, customer_address, total, note || '', payment_method || 'pending']
    );
    if (!newOrder) return res.status(500).json({ error: 'บันทึกออเดอร์ไม่สำเร็จ' });

    for (const item of enriched) {
      await db.run('INSERT INTO order_items (order_id,product_id,product_name,quantity,unit,price) VALUES (?,?,?,?,?,?)',
        [newOrder.id, item.product_id, item.product.name, item.quantity, item.product.unit, item.product.price]);
      await db.run('UPDATE products SET stock=stock-? WHERE id=?', [item.quantity, item.product_id]);
    }
    res.status(201).json(newOrder);
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด: ' + err.message }); }
});

app.put('/api/orders/:id/payment', optionalUser, async (req, res) => {
  try {
    const { payment_method, payment_status } = req.body;
    const order = await db.getOne('SELECT * FROM orders WHERE id=?', [req.params.id]);
    if (!order) return res.status(404).json({ error: 'ไม่พบออเดอร์' });
    await db.run('UPDATE orders SET payment_method=?,payment_status=?,status=? WHERE id=?',
      [payment_method, payment_status, payment_status === 'paid' ? 'confirmed' : order.status, req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

// ─── Users (admin) ────────────────────────────────────────────────────────────
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    res.json(await db.getAll(`
      SELECT u.id, u.name, u.phone, u.email, u.avatar_url, u.created_at,
        (u.google_id IS NOT NULL) as has_google,
        (u.facebook_id IS NOT NULL) as has_facebook,
        COUNT(o.id) as order_count,
        COALESCE(SUM(o.total_amount), 0) as total_spent
      FROM users u
      LEFT JOIN orders o ON o.user_id = u.id AND o.status != 'cancelled'
      GROUP BY u.id
      ORDER BY u.id DESC
    `, []));
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

// ─── Orders (admin) ───────────────────────────────────────────────────────────
app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  try {
    const orders = await db.getAll('SELECT * FROM orders ORDER BY id DESC');
    const result = await Promise.all(orders.map(async o => ({
      ...o, items: await db.getAll('SELECT * FROM order_items WHERE order_id=?', [o.id])
    })));
    res.json(result);
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

app.put('/api/admin/orders/:id/status', requireAdmin, async (req, res) => {
  try {
    const valid = ['pending','confirmed','shipping','delivered','cancelled'];
    if (!valid.includes(req.body.status)) return res.status(400).json({ error: 'สถานะไม่ถูกต้อง' });
    await db.run('UPDATE orders SET status=? WHERE id=?', [req.body.status, req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
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
  } catch (err) { res.status(500).json({ error: 'เกิดข้อผิดพลาด' }); }
});

// ─── SPA Fallback ─────────────────────────────────────────────────────────────
app.get('/admin*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

db.init().then(() => {
  app.listen(PORT, () => console.log(`🌾 บัวทองไรซ์ running on port ${PORT}`));
}).catch(err => { console.error('DB init failed:', err); process.exit(1); });
