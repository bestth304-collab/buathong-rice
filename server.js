const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const https = require('https');

const db = require('./database');
const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'buathong-rice-secret-2024';

// ─── OTP Store (in-memory, resets on restart) ────────────────────────────────
// phone → { otp, expiresAt, sentAt, attempts }
const otpStore = new Map();
// ลบ OTP ที่หมดอายุทุก 10 นาที
setInterval(() => { const now = Date.now(); otpStore.forEach((v, k) => { if (now > v.expiresAt) otpStore.delete(k); }); }, 10 * 60_000);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const FACEBOOK_APP_ID = process.env.FACEBOOK_APP_ID || '';
const PROMPTPAY_ID = process.env.PROMPTPAY_ID || '0812345678';
const OMISE_SECRET = process.env.OMISE_SECRET_KEY || '';
const OMISE_PUBLIC = process.env.OMISE_PUBLIC_KEY || '';

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
  return jwt.sign({ type: 'user', id: user.id, name: user.name, phone: user.phone, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
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
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const admin = db.getOne('SELECT * FROM admins WHERE username = ?', [username]);
  if (!admin || !bcrypt.compareSync(password, admin.password))
    return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
  const token = jwt.sign({ type: 'admin', id: admin.id, username: admin.username, name: admin.name }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, name: admin.name });
});
app.get('/api/auth/verify', requireAdmin, (req, res) => res.json({ valid: true, name: req.admin.name }));

// ─── User Auth ────────────────────────────────────────────────────────────────

// ส่ง OTP ยืนยันเบอร์ก่อนสมัคร
app.post('/api/user/otp/send', (req, res) => {
  const { phone } = req.body;
  if (!phone || !/^0[0-9]{9}$/.test(phone))
    return res.status(400).json({ error: 'เบอร์โทรไม่ถูกต้อง (0XXXXXXXXX)' });
  if (db.getOne('SELECT id FROM users WHERE phone = ?', [phone]))
    return res.status(409).json({ error: 'เบอร์โทรนี้ถูกใช้งานแล้ว' });

  // Rate limit: ห้ามส่งซ้ำภายใน 60 วินาที
  const existing = otpStore.get(phone);
  if (existing && Date.now() - existing.sentAt < 60_000) {
    const wait = Math.ceil((60_000 - (Date.now() - existing.sentAt)) / 1000);
    return res.status(429).json({ error: `กรุณารอ ${wait} วินาทีก่อนส่งใหม่` });
  }

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  otpStore.set(phone, { otp, expiresAt: Date.now() + 5 * 60_000, sentAt: Date.now(), attempts: 0 });

  // TODO: เชื่อม SMS provider จริง เช่น Twilio, True Move, AIS เป็นต้น
  // ตัวอย่าง Twilio:
  //   await twilioClient.messages.create({ to: '+66'+phone.slice(1), from: process.env.TWILIO_FROM, body: `รหัส OTP บัวทองไรซ์: ${otp} (หมดอายุใน 5 นาที)` });
  console.log(`[OTP] 📱 ${phone} → ${otp}`);

  const isDev = process.env.NODE_ENV !== 'production';
  res.json({ ok: true, ...(isDev && { _dev_otp: otp }) });
});

app.post('/api/user/register', (req, res) => {
  const { name, phone, email, password } = req.body;
  if (!name || !phone || !password) return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบ' });
  if (!/^0[0-9]{9}$/.test(phone)) return res.status(400).json({ error: 'เบอร์โทรไม่ถูกต้อง (0XXXXXXXXX)' });
  if (password.length < 6) return res.status(400).json({ error: 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร' });
  if (db.getOne('SELECT id FROM users WHERE phone = ?', [phone]))
    return res.status(409).json({ error: 'เบอร์โทรนี้ถูกใช้งานแล้ว' });
  db.run('INSERT INTO users (name,phone,email,password) VALUES (?,?,?,?)',
    [name, phone, email || null, bcrypt.hashSync(password, 10)]);
  const user = db.getOne('SELECT * FROM users WHERE phone = ?', [phone]);
  if (!user) return res.status(500).json({ error: 'สร้างบัญชีไม่สำเร็จ กรุณาลองใหม่' });
  res.status(201).json({ token: userToken(user), name: user.name, id: user.id });
});

app.post('/api/user/login', (req, res) => {
  const { phone: identifier, password } = req.body;
  if (!identifier || !password) return res.status(400).json({ error: 'กรุณากรอกข้อมูล' });
  const user = db.getOne('SELECT * FROM users WHERE email = ? OR phone = ?', [identifier, identifier]);
  if (!user || !user.password || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
  res.json({ token: userToken(user), name: user.name, id: user.id });
});

app.post('/api/user/google', async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'ไม่มี credential' });
  try {
    // Decode JWT payload — use manual padding to support all Node.js versions
    const payloadB64 = credential.split('.')[1];
    if (!payloadB64) throw new Error('Invalid JWT format');
    const padded = payloadB64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((payloadB64.length + 3) % 4);
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    const { sub: googleId, name, email, picture } = payload;
    if (!googleId) throw new Error('Missing sub claim');

    let user = db.getOne('SELECT * FROM users WHERE google_id = ?', [googleId]);
    if (!user && email) user = db.getOne('SELECT * FROM users WHERE email = ?', [email]);

    if (user) {
      // Link google_id to existing account if not yet linked
      if (!user.google_id) db.run('UPDATE users SET google_id=?,avatar_url=? WHERE id=?', [googleId, picture || '', user.id]);
    } else {
      // Create new user — look up by google_id after INSERT (avoid lastId() which may be reset by save())
      db.run('INSERT INTO users (name,email,google_id,avatar_url) VALUES (?,?,?,?)',
        [name || 'ผู้ใช้ Google', email || null, googleId, picture || '']);
      user = db.getOne('SELECT * FROM users WHERE google_id = ?', [googleId]);
    }

    if (!user) throw new Error('User lookup failed after insert');
    res.json({ token: userToken(user), name: user.name, id: user.id });
  } catch (err) {
    console.error('[Google Login]', err.message);
    res.status(401).json({ error: 'Google login ไม่สำเร็จ' });
  }
});

app.post('/api/user/facebook', (req, res) => {
  const { fbId, name, email, picture } = req.body;
  if (!fbId || !name) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
  let user = db.getOne('SELECT * FROM users WHERE facebook_id = ?', [fbId]);
  if (!user && email) user = db.getOne('SELECT * FROM users WHERE email = ?', [email]);
  if (user) {
    if (!user.facebook_id) db.run('UPDATE users SET facebook_id=?,avatar_url=? WHERE id=?', [fbId, picture || '', user.id]);
  } else {
    db.run('INSERT INTO users (name,email,facebook_id,avatar_url) VALUES (?,?,?,?)', [name, email || null, fbId, picture || '']);
    user = db.getOne('SELECT * FROM users WHERE id = ?', [db.lastId()]);
  }
  res.json({ token: userToken(user), name: user.name, id: user.id });
});

app.get('/api/user/profile', requireUser, (req, res) => {
  const user = db.getOne('SELECT id,name,phone,email,avatar_url,created_at FROM users WHERE id=?', [req.user.id]);
  const addresses = db.getAll('SELECT * FROM user_addresses WHERE user_id=? ORDER BY is_default DESC,id DESC', [req.user.id]);
  const orders = db.getAll('SELECT * FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 50', [req.user.id]).map(o => ({
    ...o, items: db.getAll('SELECT * FROM order_items WHERE order_id=?', [o.id])
  }));
  const wishlist = db.getAll(`
    SELECT p.* FROM user_wishlist w
    JOIN products p ON p.id = w.product_id
    WHERE w.user_id = ? AND p.active = 1
    ORDER BY w.created_at DESC`, [req.user.id]);
  const stats = {
    delivered: orders.filter(o => o.status === 'delivered').length,
    shipping: orders.filter(o => o.status === 'shipping').length,
    pending: orders.filter(o => o.status === 'pending' || o.status === 'confirmed').length,
    unpaid: orders.filter(o => o.payment_status !== 'paid' && o.status !== 'cancelled').length,
  };
  res.json({ ...user, addresses, orders, wishlist, stats });
});

app.put('/api/user/profile', requireUser, (req, res) => {
  const { name, email } = req.body;
  db.run('UPDATE users SET name=?,email=? WHERE id=?', [name, email || null, req.user.id]);
  res.json({ ok: true });
});

app.put('/api/user/password', requireUser, (req, res) => {
  const { current, next } = req.body;
  const user = db.getOne('SELECT * FROM users WHERE id=?', [req.user.id]);
  if (user.password && !bcrypt.compareSync(current, user.password))
    return res.status(400).json({ error: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' });
  if (!next || next.length < 6) return res.status(400).json({ error: 'รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัว' });
  db.run('UPDATE users SET password=? WHERE id=?', [bcrypt.hashSync(next, 10), req.user.id]);
  res.json({ ok: true });
});

// ─── Wishlist ─────────────────────────────────────────────────────────────────
app.get('/api/user/wishlist', requireUser, (req, res) => {
  res.json(db.getAll(`
    SELECT p.* FROM user_wishlist w JOIN products p ON p.id=w.product_id
    WHERE w.user_id=? AND p.active=1 ORDER BY w.created_at DESC`, [req.user.id]));
});

app.post('/api/user/wishlist/:productId', requireUser, (req, res) => {
  const pid = parseInt(req.params.productId);
  if (!db.getOne('SELECT id FROM products WHERE id=? AND active=1', [pid]))
    return res.status(404).json({ error: 'ไม่พบสินค้า' });
  try { db.run('INSERT INTO user_wishlist (user_id,product_id) VALUES (?,?)', [req.user.id, pid]); } catch {}
  res.json({ ok: true, inWishlist: true });
});

app.delete('/api/user/wishlist/:productId', requireUser, (req, res) => {
  db.run('DELETE FROM user_wishlist WHERE user_id=? AND product_id=?', [req.user.id, parseInt(req.params.productId)]);
  res.json({ ok: true, inWishlist: false });
});

// ─── Addresses ────────────────────────────────────────────────────────────────
app.get('/api/user/addresses', requireUser, (req, res) => {
  res.json(db.getAll('SELECT * FROM user_addresses WHERE user_id=? ORDER BY is_default DESC,id ASC', [req.user.id]));
});

app.post('/api/user/addresses', requireUser, (req, res) => {
  const { label, recipient_name, phone, address_text, is_default } = req.body;
  if (!recipient_name || !phone || !address_text) return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบ' });
  if (is_default) db.run('UPDATE user_addresses SET is_default=0 WHERE user_id=?', [req.user.id]);
  db.run('INSERT INTO user_addresses (user_id,label,recipient_name,phone,address_text,is_default) VALUES (?,?,?,?,?,?)',
    [req.user.id, label || 'บ้าน', recipient_name, phone, address_text, is_default ? 1 : 0]);
  res.status(201).json(db.getOne('SELECT * FROM user_addresses WHERE id=?', [db.lastId()]));
});

app.put('/api/user/addresses/:id', requireUser, (req, res) => {
  const addr = db.getOne('SELECT id FROM user_addresses WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
  if (!addr) return res.status(404).json({ error: 'ไม่พบที่อยู่' });
  const { label, recipient_name, phone, address_text, is_default } = req.body;
  if (is_default) db.run('UPDATE user_addresses SET is_default=0 WHERE user_id=?', [req.user.id]);
  db.run('UPDATE user_addresses SET label=?,recipient_name=?,phone=?,address_text=?,is_default=? WHERE id=?',
    [label, recipient_name, phone, address_text, is_default ? 1 : 0, req.params.id]);
  res.json(db.getOne('SELECT * FROM user_addresses WHERE id=?', [req.params.id]));
});

app.delete('/api/user/addresses/:id', requireUser, (req, res) => {
  db.run('DELETE FROM user_addresses WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
  res.json({ ok: true });
});

// ─── Saved Cards ─────────────────────────────────────────────────────────────
app.get('/api/user/cards', requireUser, (req, res) => {
  res.json(db.getAll(
    'SELECT * FROM user_saved_cards WHERE user_id=? ORDER BY is_default DESC, created_at DESC',
    [req.user.id]
  ));
});

app.post('/api/user/cards', requireUser, (req, res) => {
  const { last_four, card_brand, expiry, holder_name, label, card_token, is_default } = req.body;
  if (!last_four || !card_brand || !expiry || !holder_name)
    return res.status(400).json({ error: 'ข้อมูลบัตรไม่ครบ' });
  if (!/^\d{4}$/.test(last_four))
    return res.status(400).json({ error: 'เลขท้ายบัตรไม่ถูกต้อง' });

  const count = db.getOne('SELECT COUNT(*) as c FROM user_saved_cards WHERE user_id=?', [req.user.id])?.c || 0;
  const setDefault = (is_default || count === 0) ? 1 : 0;
  if (setDefault) db.run('UPDATE user_saved_cards SET is_default=0 WHERE user_id=?', [req.user.id]);

  db.run(
    'INSERT INTO user_saved_cards (user_id,last_four,card_brand,expiry,holder_name,label,card_token,is_default) VALUES (?,?,?,?,?,?,?,?)',
    [req.user.id, last_four, card_brand, expiry, holder_name, label || 'บัตรของฉัน', card_token || '', setDefault]
  );
  const card = db.getOne(
    'SELECT * FROM user_saved_cards WHERE user_id=? AND last_four=? ORDER BY id DESC',
    [req.user.id, last_four]
  );
  res.status(201).json(card);
});

app.delete('/api/user/cards/:id', requireUser, (req, res) => {
  const card = db.getOne('SELECT * FROM user_saved_cards WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
  if (!card) return res.status(404).json({ error: 'ไม่พบบัตร' });
  db.run('DELETE FROM user_saved_cards WHERE id=?', [req.params.id]);
  // ถ้าลบบัตร default ให้ตั้งบัตรล่าสุดเป็น default แทน
  if (card.is_default) {
    const next = db.getOne('SELECT id FROM user_saved_cards WHERE user_id=? ORDER BY created_at DESC', [req.user.id]);
    if (next) db.run('UPDATE user_saved_cards SET is_default=1 WHERE id=?', [next.id]);
  }
  res.json({ ok: true });
});

app.patch('/api/user/cards/:id/default', requireUser, (req, res) => {
  const card = db.getOne('SELECT id FROM user_saved_cards WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
  if (!card) return res.status(404).json({ error: 'ไม่พบบัตร' });
  db.run('UPDATE user_saved_cards SET is_default=0 WHERE user_id=?', [req.user.id]);
  db.run('UPDATE user_saved_cards SET is_default=1 WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

// ─── Products (public) ────────────────────────────────────────────────────────
app.get('/api/products', (req, res) => {
  const { category, search } = req.query;
  let sql = 'SELECT * FROM products WHERE active=1';
  const p = [];
  if (category && category !== 'all') { sql += ' AND category=?'; p.push(category); }
  if (search) { sql += ' AND (name LIKE ? OR description LIKE ?)'; p.push(`%${search}%`, `%${search}%`); }
  res.json(db.getAll(sql + ' ORDER BY id ASC', p));
});
app.get('/api/products/categories', (req, res) =>
  res.json(db.getAll('SELECT DISTINCT category FROM products WHERE active=1').map(c => c.category)));

// ─── Products (admin) ─────────────────────────────────────────────────────────
app.get('/api/admin/products', requireAdmin, (req, res) =>
  res.json(db.getAll('SELECT * FROM products ORDER BY id DESC')));

app.post('/api/admin/products', requireAdmin, (req, res) => {
  const { name, description, price, unit, stock, image_url, category } = req.body;
  if (!name || price === undefined) return res.status(400).json({ error: 'กรุณากรอกชื่อและราคา' });
  db.run('INSERT INTO products (name,description,price,unit,stock,image_url,category) VALUES (?,?,?,?,?,?,?)',
    [name, description || '', parseFloat(price), unit || 'กิโลกรัม', parseInt(stock) || 0, image_url || '', category || 'ข้าวสาร']);
  res.status(201).json(db.getOne('SELECT * FROM products WHERE id=?', [db.lastId()]));
});

app.put('/api/admin/products/:id', requireAdmin, (req, res) => {
  if (!db.getOne('SELECT id FROM products WHERE id=?', [req.params.id]))
    return res.status(404).json({ error: 'ไม่พบสินค้า' });
  const { name, description, price, unit, stock, image_url, category, active } = req.body;
  db.run(`UPDATE products SET name=?,description=?,price=?,unit=?,stock=?,image_url=?,category=?,active=?,
    updated_at=datetime('now','localtime') WHERE id=?`,
    [name, description || '', parseFloat(price), unit, parseInt(stock), image_url || '', category, active ? 1 : 0, req.params.id]);
  res.json(db.getOne('SELECT * FROM products WHERE id=?', [req.params.id]));
});

app.delete('/api/admin/products/:id', requireAdmin, (req, res) => {
  if (!db.getOne('SELECT id FROM products WHERE id=?', [req.params.id]))
    return res.status(404).json({ error: 'ไม่พบสินค้า' });
  db.run('UPDATE products SET active=0 WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

// ─── Orders (public + user) ───────────────────────────────────────────────────
app.post('/api/orders', optionalUser, (req, res) => {
  const { customer_name, customer_phone, customer_address, items, note, payment_method } = req.body;
  if (!customer_name || !customer_phone || !customer_address || !items?.length)
    return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบ' });

  let total = 0;
  const enriched = [];
  for (const item of items) {
    const p = db.getOne('SELECT * FROM products WHERE id=? AND active=1', [item.product_id]);
    if (!p) return res.status(400).json({ error: `ไม่พบสินค้า ID: ${item.product_id}` });
    if (p.stock < item.quantity) return res.status(400).json({ error: `"${p.name}" มีสต็อกไม่พอ` });
    total += p.price * item.quantity;
    enriched.push({ ...item, product: p });
  }

  const orderNum = 'BT' + Date.now().toString().slice(-8);
  const userId = req.user?.id || null;
  db.run('INSERT INTO orders (order_number,user_id,customer_name,customer_phone,customer_address,total_amount,note,payment_method) VALUES (?,?,?,?,?,?,?,?)',
    [orderNum, userId, customer_name, customer_phone, customer_address, total, note || '', payment_method || 'pending']);
  const newOrder = db.getOne('SELECT * FROM orders WHERE order_number=?', [orderNum]);
  if (!newOrder) return res.status(500).json({ error: 'บันทึกออเดอร์ไม่สำเร็จ' });
  const orderId = newOrder.id;
  for (const item of enriched) {
    db.run('INSERT INTO order_items (order_id,product_id,product_name,quantity,unit,price) VALUES (?,?,?,?,?,?)',
      [orderId, item.product_id, item.product.name, item.quantity, item.product.unit, item.product.price]);
    db.run('UPDATE products SET stock=stock-? WHERE id=?', [item.quantity, item.product_id]);
  }
  res.status(201).json({ ...newOrder });
});

app.put('/api/orders/:id/payment', optionalUser, (req, res) => {
  const { payment_method, payment_status } = req.body;
  const order = db.getOne('SELECT * FROM orders WHERE id=?', [req.params.id]);
  if (!order) return res.status(404).json({ error: 'ไม่พบออเดอร์' });
  db.run('UPDATE orders SET payment_method=?,payment_status=?,status=? WHERE id=?',
    [payment_method, payment_status, payment_status === 'paid' ? 'confirmed' : order.status, req.params.id]);
  res.json({ ok: true });
});

// ─── Users (admin) ───────────────────────────────────────────────────────────
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = db.getAll(`
    SELECT u.id, u.name, u.phone, u.email, u.avatar_url, u.created_at,
      (u.google_id IS NOT NULL) as has_google,
      (u.facebook_id IS NOT NULL) as has_facebook,
      COUNT(o.id) as order_count,
      IFNULL(SUM(o.total_amount), 0) as total_spent
    FROM users u
    LEFT JOIN orders o ON o.user_id = u.id AND o.status != 'cancelled'
    GROUP BY u.id
    ORDER BY u.id DESC
  `, []);
  res.json(users);
});

// ─── Orders (admin) ───────────────────────────────────────────────────────────
app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const orders = db.getAll('SELECT * FROM orders ORDER BY id DESC');
  res.json(orders.map(o => ({ ...o, items: db.getAll('SELECT * FROM order_items WHERE order_id=?', [o.id]) })));
});
app.put('/api/admin/orders/:id/status', requireAdmin, (req, res) => {
  const valid = ['pending','confirmed','shipping','delivered','cancelled'];
  if (!valid.includes(req.body.status)) return res.status(400).json({ error: 'สถานะไม่ถูกต้อง' });
  db.run('UPDATE orders SET status=? WHERE id=?', [req.body.status, req.params.id]);
  res.json({ ok: true });
});

app.get('/api/admin/dashboard', requireAdmin, (req, res) => {
  res.json({
    totalOrders: db.getOne('SELECT COUNT(*) as c FROM orders').c,
    pendingOrders: db.getOne("SELECT COUNT(*) as c FROM orders WHERE status='pending'").c,
    totalRevenue: db.getOne("SELECT IFNULL(SUM(total_amount),0) as t FROM orders WHERE status!='cancelled'").t,
    totalProducts: db.getOne('SELECT COUNT(*) as c FROM products WHERE active=1').c,
    totalUsers: db.getOne('SELECT COUNT(*) as c FROM users').c,
  });
});

// ─── SPA Fallback ─────────────────────────────────────────────────────────────
app.get('/admin*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

db.init().then(() => {
  app.listen(PORT, () => console.log(`🌾 บัวทองไรซ์ running on port ${PORT}`));
}).catch(err => { console.error(err); process.exit(1); });
