const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'buathong.db');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

let db;

function save() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

async function init() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, description TEXT DEFAULT '',
      price REAL NOT NULL, unit TEXT NOT NULL DEFAULT 'กิโลกรัม',
      stock INTEGER NOT NULL DEFAULT 0, image_url TEXT DEFAULT '',
      category TEXT DEFAULT 'ข้าวสาร', active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT UNIQUE,
      email TEXT,
      password TEXT,
      google_id TEXT,
      facebook_id TEXT,
      avatar_url TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS user_addresses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      label TEXT DEFAULT 'บ้าน',
      recipient_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      address_text TEXT NOT NULL,
      is_default INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT UNIQUE NOT NULL,
      user_id INTEGER,
      customer_name TEXT NOT NULL, customer_phone TEXT NOT NULL,
      customer_address TEXT NOT NULL, total_amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      payment_method TEXT DEFAULT 'pending',
      payment_status TEXT DEFAULT 'unpaid',
      note TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
      product_name TEXT NOT NULL, quantity INTEGER NOT NULL,
      unit TEXT NOT NULL, price REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
      name TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS user_wishlist (
      user_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      PRIMARY KEY (user_id, product_id)
    );
    CREATE TABLE IF NOT EXISTS user_saved_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      label TEXT DEFAULT 'บัตรของฉัน',
      card_brand TEXT NOT NULL DEFAULT 'Other',
      last_four TEXT NOT NULL,
      expiry TEXT NOT NULL,
      holder_name TEXT NOT NULL,
      card_token TEXT DEFAULT '',
      is_default INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // migrate: add columns if missing
  const migrations = [
    'ALTER TABLE orders ADD COLUMN user_id INTEGER',
    'ALTER TABLE orders ADD COLUMN payment_method TEXT DEFAULT \'pending\'',
    'ALTER TABLE orders ADD COLUMN payment_status TEXT DEFAULT \'unpaid\'',
  ];
  for (const sql of migrations) {
    try { db.run(sql); } catch {}
  }

  // seed admin
  const adminExists = getOne('SELECT id FROM admins WHERE username = ?', ['BUATHONGRICE1']);
  if (!adminExists) {
    // อัปเดต admin เดิม (ถ้ามี) หรือสร้างใหม่
    const oldAdmin = getOne('SELECT id FROM admins LIMIT 1');
    if (oldAdmin) {
      db.run('UPDATE admins SET username=?,password=?,name=? WHERE id=?',
        ['BUATHONGRICE1', bcrypt.hashSync('rice1234', 10), 'ผู้ดูแลระบบ', oldAdmin.id]);
    } else {
      db.run('INSERT INTO admins (username,password,name) VALUES (?,?,?)',
        ['BUATHONGRICE1', bcrypt.hashSync('rice1234', 10), 'ผู้ดูแลระบบ']);
    }
  }

  // seed products
  const cnt = getOne('SELECT COUNT(*) as c FROM products').c;
  if (cnt === 0) {
    const ins = (p) => db.run(
      'INSERT INTO products (name,description,price,unit,stock,image_url,category) VALUES (?,?,?,?,?,?,?)', p
    );
    [
      ['ข้าวหอมมะลิ 100%','ข้าวหอมมะลิแท้ 100% คัดเกรดพิเศษ จากทุ่งนาภาคอีสาน หุงสุกหอม นุ่ม อร่อย',65,'กิโลกรัม',500,'https://images.unsplash.com/photo-1586201375761-83865001e31c?w=400','ข้าวสาร'],
      ['ข้าวหอมมะลิ 5 กก.','ข้าวหอมมะลิพรีเมียม บรรจุถุง 5 กิโลกรัม เหมาะสำหรับครอบครัว',310,'ถุง (5 กก.)',200,'https://images.unsplash.com/photo-1536304929831-ee1ca9d44906?w=400','ข้าวสาร'],
      ['ข้าวหอมมะลิ 10 กก.','ข้าวหอมมะลิพรีเมียม บรรจุถุง 10 กิโลกรัม ประหยัดกว่า',590,'ถุง (10 กก.)',150,'https://images.unsplash.com/photo-1586201375761-83865001e31c?w=400','ข้าวสาร'],
      ['ข้าวกล้องหอมมะลิ','ข้าวกล้องหอมมะลิ ยังคงคุณค่าทางโภชนาการครบถ้วน เหมาะสำหรับผู้รักสุขภาพ',70,'กิโลกรัม',300,'https://images.unsplash.com/photo-1574323347407-f5e1ad6d020b?w=400','ข้าวกล้อง'],
      ['ข้าวกล้องงาดำ','ข้าวกล้องผสมงาดำ อุดมด้วยสารต้านอนุมูลอิสระ บำรุงร่างกาย',85,'กิโลกรัม',200,'https://images.unsplash.com/photo-1574323347407-f5e1ad6d020b?w=400','ข้าวกล้อง'],
      ['ข้าวไรซ์เบอร์รี่','ข้าวไรซ์เบอร์รี่ อุดมด้วยสารอาหาร สีม่วงเข้ม หอม นุ่ม',95,'กิโลกรัม',180,'https://images.unsplash.com/photo-1551754655-cd27e38d2076?w=400','ข้าวพิเศษ'],
      ['ข้าวหอมนิล','ข้าวหอมนิล ข้าวสีดำ อุดมด้วยสารต้านอนุมูลอิสระสูง',90,'กิโลกรัม',150,'https://images.unsplash.com/photo-1551754655-cd27e38d2076?w=400','ข้าวพิเศษ'],
      ['ข้าวขาวพื้นนุ่ม','ข้าวขาวพันธุ์พื้นนุ่ม คุณภาพดี ราคาประหยัด เหมาะสำหรับร้านอาหาร',45,'กิโลกรัม',1000,'https://images.unsplash.com/photo-1536304929831-ee1ca9d44906?w=400','ข้าวสาร'],
    ].forEach(ins);
  }

  save();
}

function getAll(sql, params = []) {
  const res = db.exec(sql, params);
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

function getOne(sql, params = []) { return getAll(sql, params)[0] || null; }

function run(sql, params = []) { db.run(sql, params); save(); }

function lastId() { return getOne('SELECT last_insert_rowid() as id').id; }

module.exports = { init, getAll, getOne, run, lastId, save, getDb: () => db };
