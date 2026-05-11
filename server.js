const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const dbModule = require('./database');
const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'buathong-rice-secret-2024';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let db;

// ─── Auth Middleware ───────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.admin = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ─── Admin Auth ────────────────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'กรุณากรอกข้อมูล' });
  const admin = db.getOne('SELECT * FROM admins WHERE username = ?', [username]);
  if (!admin || !bcrypt.compareSync(password, admin.password)) {
    return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
  }
  const token = jwt.sign({ id: admin.id, username: admin.username, name: admin.name }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, name: admin.name });
});

app.get('/api/auth/verify', requireAdmin, (req, res) => {
  res.json({ valid: true, name: req.admin.name });
});

// ─── Products (public) ─────────────────────────────────────────────────────────
app.get('/api/products', (req, res) => {
  const { category, search } = req.query;
  let sql = 'SELECT * FROM products WHERE active = 1';
  const params = [];
  if (category && category !== 'all') { sql += ' AND category = ?'; params.push(category); }
  if (search) { sql += ' AND (name LIKE ? OR description LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  sql += ' ORDER BY id ASC';
  res.json(db.getAll(sql, params));
});

app.get('/api/products/categories', (req, res) => {
  const cats = db.getAll('SELECT DISTINCT category FROM products WHERE active = 1');
  res.json(cats.map(c => c.category));
});

// ─── Products (admin) ──────────────────────────────────────────────────────────
app.get('/api/admin/products', requireAdmin, (req, res) => {
  res.json(db.getAll('SELECT * FROM products ORDER BY id DESC'));
});

app.post('/api/admin/products', requireAdmin, (req, res) => {
  const { name, description, price, unit, stock, image_url, category } = req.body;
  if (!name || price === undefined) return res.status(400).json({ error: 'กรุณากรอกชื่อสินค้าและราคา' });
  db.run(
    'INSERT INTO products (name,description,price,unit,stock,image_url,category) VALUES (?,?,?,?,?,?,?)',
    [name, description || '', parseFloat(price), unit || 'กิโลกรัม', parseInt(stock) || 0, image_url || '', category || 'ข้าวสาร']
  );
  const id = db.lastId();
  res.status(201).json(db.getOne('SELECT * FROM products WHERE id = ?', [id]));
});

app.put('/api/admin/products/:id', requireAdmin, (req, res) => {
  const { name, description, price, unit, stock, image_url, category, active } = req.body;
  const existing = db.getOne('SELECT id FROM products WHERE id = ?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'ไม่พบสินค้า' });
  db.run(
    `UPDATE products SET name=?,description=?,price=?,unit=?,stock=?,image_url=?,category=?,active=?,
     updated_at=datetime('now','localtime') WHERE id=?`,
    [name, description || '', parseFloat(price), unit, parseInt(stock), image_url || '', category, active ? 1 : 0, req.params.id]
  );
  res.json(db.getOne('SELECT * FROM products WHERE id = ?', [req.params.id]));
});

app.delete('/api/admin/products/:id', requireAdmin, (req, res) => {
  const existing = db.getOne('SELECT id FROM products WHERE id = ?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'ไม่พบสินค้า' });
  db.run('UPDATE products SET active = 0 WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

// ─── Orders (public) ──────────────────────────────────────────────────────────
app.post('/api/orders', (req, res) => {
  const { customer_name, customer_phone, customer_address, items, note } = req.body;
  if (!customer_name || !customer_phone || !customer_address || !items?.length) {
    return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบถ้วน' });
  }

  let total = 0;
  const enriched = [];
  for (const item of items) {
    const product = db.getOne('SELECT * FROM products WHERE id = ? AND active = 1', [item.product_id]);
    if (!product) return res.status(400).json({ error: `ไม่พบสินค้า ID: ${item.product_id}` });
    if (product.stock < item.quantity) return res.status(400).json({ error: `สินค้า "${product.name}" มีไม่เพียงพอ` });
    total += product.price * item.quantity;
    enriched.push({ ...item, product });
  }

  const orderNumber = 'BT' + Date.now().toString().slice(-8);
  try {
    db.run(
      'INSERT INTO orders (order_number,customer_name,customer_phone,customer_address,total_amount,note) VALUES (?,?,?,?,?,?)',
      [orderNumber, customer_name, customer_phone, customer_address, total, note || '']
    );
    const orderId = db.lastId();
    for (const item of enriched) {
      db.run(
        'INSERT INTO order_items (order_id,product_id,product_name,quantity,unit,price) VALUES (?,?,?,?,?,?)',
        [orderId, item.product_id, item.product.name, item.quantity, item.product.unit, item.product.price]
      );
      db.run('UPDATE products SET stock = stock - ? WHERE id = ?', [item.quantity, item.product_id]);
    }
    const order = db.getOne('SELECT * FROM orders WHERE id = ?', [orderId]);
    res.status(201).json(order);
  } catch (err) {
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการบันทึกคำสั่งซื้อ' });
  }
});

// ─── Orders (admin) ────────────────────────────────────────────────────────────
app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const orders = db.getAll('SELECT * FROM orders ORDER BY id DESC');
  const result = orders.map(o => ({
    ...o,
    items: db.getAll('SELECT * FROM order_items WHERE order_id = ?', [o.id])
  }));
  res.json(result);
});

app.put('/api/admin/orders/:id/status', requireAdmin, (req, res) => {
  const { status } = req.body;
  const validStatuses = ['pending', 'confirmed', 'shipping', 'delivered', 'cancelled'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'สถานะไม่ถูกต้อง' });
  db.run('UPDATE orders SET status = ? WHERE id = ?', [status, req.params.id]);
  res.json({ success: true });
});

app.get('/api/admin/dashboard', requireAdmin, (req, res) => {
  const totalOrders = db.getOne('SELECT COUNT(*) as cnt FROM orders').cnt;
  const pendingOrders = db.getOne("SELECT COUNT(*) as cnt FROM orders WHERE status = 'pending'").cnt;
  const revenueRow = db.getOne("SELECT IFNULL(SUM(total_amount),0) as total FROM orders WHERE status != 'cancelled'");
  const totalRevenue = revenueRow ? revenueRow.total : 0;
  const totalProducts = db.getOne('SELECT COUNT(*) as cnt FROM products WHERE active = 1').cnt;
  res.json({ totalOrders, pendingOrders, totalRevenue, totalProducts });
});

// ─── SPA Fallback ──────────────────────────────────────────────────────────────
app.get('/admin*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── Start ─────────────────────────────────────────────────────────────────────
dbModule.init().then(() => {
  db = dbModule;
  app.listen(PORT, () => console.log(`🌾 บัวทองไรซ์ server running on port ${PORT}`));
}).catch(err => {
  console.error('Database init failed:', err);
  process.exit(1);
});
