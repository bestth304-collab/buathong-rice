const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// Convert ? placeholders → $1, $2, ... for PostgreSQL
function pgify(sql, params = []) {
  let i = 0;
  return { text: sql.replace(/\?/g, () => `$${++i}`), values: params };
}

async function getAll(sql, params = []) {
  const { text, values } = pgify(sql, params);
  const { rows } = await pool.query(text, values);
  return rows;
}

async function getOne(sql, params = []) {
  return (await getAll(sql, params))[0] || null;
}

async function run(sql, params = []) {
  const { text, values } = pgify(sql, params);
  await pool.query(text, values);
}

// For INSERT ... RETURNING * (returns first row)
async function queryOne(sql, params = []) {
  const { text, values } = pgify(sql, params);
  const { rows } = await pool.query(text, values);
  return rows[0] || null;
}

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      price REAL NOT NULL,
      unit TEXT NOT NULL DEFAULT 'กิโลกรัม',
      stock INTEGER NOT NULL DEFAULT 0,
      image_url TEXT DEFAULT '',
      category TEXT DEFAULT 'ข้าวสาร',
      active INTEGER NOT NULL DEFAULT 1,
      badge TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT UNIQUE,
      email TEXT,
      password TEXT,
      google_id TEXT,
      facebook_id TEXT,
      avatar_url TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_addresses (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      label TEXT DEFAULT 'บ้าน',
      recipient_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      address_text TEXT NOT NULL,
      is_default INTEGER DEFAULT 0
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      order_number TEXT UNIQUE NOT NULL,
      user_id INTEGER,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      customer_address TEXT NOT NULL,
      total_amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      payment_method TEXT DEFAULT 'pending',
      payment_status TEXT DEFAULT 'unpaid',
      note TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_items (
      id BIGSERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit TEXT NOT NULL,
      price REAL NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id BIGSERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_wishlist (
      user_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, product_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_saved_cards (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      label TEXT DEFAULT 'บัตรของฉัน',
      card_brand TEXT NOT NULL DEFAULT 'Other',
      last_four TEXT NOT NULL,
      expiry TEXT NOT NULL,
      holder_name TEXT NOT NULL,
      card_token TEXT DEFAULT '',
      is_default INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Seed admin
  const adminExists = await getOne('SELECT id FROM admins WHERE username = ?', ['BUATHONGRICE1']);
  if (!adminExists) {
    const oldAdmin = await getOne('SELECT id FROM admins LIMIT 1');
    if (oldAdmin) {
      await run('UPDATE admins SET username=?,password=?,name=? WHERE id=?',
        ['BUATHONGRICE1', bcrypt.hashSync('rice1234', 10), 'ผู้ดูแลระบบ', oldAdmin.id]);
    } else {
      await run('INSERT INTO admins (username,password,name) VALUES (?,?,?)',
        ['BUATHONGRICE1', bcrypt.hashSync('rice1234', 10), 'ผู้ดูแลระบบ']);
    }
  }

  // Seed products
  const cnt = await getOne('SELECT COUNT(*) as c FROM products');
  if (parseInt(cnt.c) === 0) {
    const ins = (p) => run(
      'INSERT INTO products (name,description,price,unit,stock,image_url,category) VALUES (?,?,?,?,?,?,?)', p
    );
    await Promise.all([
      ins(['ข้าวหอมมะลิ 100%','ข้าวหอมมะลิแท้ 100% คัดเกรดพิเศษ จากทุ่งนาภาคอีสาน หุงสุกหอม นุ่ม อร่อย',65,'กิโลกรัม',500,'https://images.unsplash.com/photo-1586201375761-83865001e31c?w=400','ข้าวสาร']),
      ins(['ข้าวหอมมะลิ 5 กก.','ข้าวหอมมะลิพรีเมียม บรรจุถุง 5 กิโลกรัม เหมาะสำหรับครอบครัว',310,'ถุง (5 กก.)',200,'https://images.unsplash.com/photo-1536304929831-ee1ca9d44906?w=400','ข้าวสาร']),
      ins(['ข้าวหอมมะลิ 10 กก.','ข้าวหอมมะลิพรีเมียม บรรจุถุง 10 กิโลกรัม ประหยัดกว่า',590,'ถุง (10 กก.)',150,'https://images.unsplash.com/photo-1586201375761-83865001e31c?w=400','ข้าวสาร']),
      ins(['ข้าวกล้องหอมมะลิ','ข้าวกล้องหอมมะลิ ยังคงคุณค่าทางโภชนาการครบถ้วน เหมาะสำหรับผู้รักสุขภาพ',70,'กิโลกรัม',300,'https://images.unsplash.com/photo-1574323347407-f5e1ad6d020b?w=400','ข้าวกล้อง']),
      ins(['ข้าวกล้องงาดำ','ข้าวกล้องผสมงาดำ อุดมด้วยสารต้านอนุมูลอิสระ บำรุงร่างกาย',85,'กิโลกรัม',200,'https://images.unsplash.com/photo-1574323347407-f5e1ad6d020b?w=400','ข้าวกล้อง']),
      ins(['ข้าวไรซ์เบอร์รี่','ข้าวไรซ์เบอร์รี่ อุดมด้วยสารอาหาร สีม่วงเข้ม หอม นุ่ม',95,'กิโลกรัม',180,'https://images.unsplash.com/photo-1551754655-cd27e38d2076?w=400','ข้าวพิเศษ']),
      ins(['ข้าวหอมนิล','ข้าวหอมนิล ข้าวสีดำ อุดมด้วยสารต้านอนุมูลอิสระสูง',90,'กิโลกรัม',150,'https://images.unsplash.com/photo-1551754655-cd27e38d2076?w=400','ข้าวพิเศษ']),
      ins(['ข้าวขาวพื้นนุ่ม','ข้าวขาวพันธุ์พื้นนุ่ม คุณภาพดี ราคาประหยัด เหมาะสำหรับร้านอาหาร',45,'กิโลกรัม',1000,'https://images.unsplash.com/photo-1536304929831-ee1ca9d44906?w=400','ข้าวสาร']),
    ]);
  }
}

module.exports = { init, getAll, getOne, run, queryOne };
