// ─── State ────────────────────────────────────────────────────────────────────
let products = [];
let cart = JSON.parse(localStorage.getItem('btCart') || '[]');
let currentCategory = 'all';

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadCategories();
  loadProducts();
  renderCart();
  initNavbar();
});

function initNavbar() {
  const navbar = document.getElementById('navbar');
  window.addEventListener('scroll', () => {
    navbar.classList.toggle('scrolled', window.scrollY > 50);
  });
}

// ─── Products ─────────────────────────────────────────────────────────────────
async function loadCategories() {
  const res = await fetch('/api/products/categories');
  const cats = await res.json();
  const tabs = document.getElementById('categoryTabs');
  cats.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = 'cat-btn';
    btn.textContent = cat;
    btn.dataset.cat = cat;
    btn.onclick = () => filterCategory(cat, btn);
    tabs.appendChild(btn);
  });
}

async function loadProducts(search = '') {
  const grid = document.getElementById('productsGrid');
  grid.innerHTML = '<div class="loading">กำลังโหลดสินค้า...</div>';
  let url = '/api/products?';
  if (currentCategory !== 'all') url += `category=${encodeURIComponent(currentCategory)}&`;
  if (search) url += `search=${encodeURIComponent(search)}`;
  const res = await fetch(url);
  products = await res.json();
  renderProducts(products);
}

function renderProducts(list) {
  const grid = document.getElementById('productsGrid');
  if (!list.length) {
    grid.innerHTML = '<div class="no-products">😕 ไม่พบสินค้าที่ค้นหา</div>';
    return;
  }
  grid.innerHTML = list.map(p => {
    const cartItem = cart.find(c => c.id === p.id);
    const qty = cartItem ? cartItem.qty : 1;
    const outOfStock = p.stock === 0;
    return `
    <div class="product-card" id="product-${p.id}">
      <div class="product-img">
        <img src="${p.image_url || 'https://images.unsplash.com/photo-1536304929831-ee1ca9d44906?w=400'}"
             alt="${p.name}" loading="lazy" onerror="this.src='https://images.unsplash.com/photo-1536304929831-ee1ca9d44906?w=400'">
        ${outOfStock ? '<div class="product-badge out">สินค้าหมด</div>' : '<div class="product-badge">มีสินค้า</div>'}
      </div>
      <div class="product-body">
        <div class="product-cat">${p.category}</div>
        <div class="product-name">${p.name}</div>
        <div class="product-desc">${p.description || ''}</div>
        <div class="product-footer">
          <div>
            <div class="product-price">฿${p.price.toLocaleString()} <span>/ ${p.unit}</span></div>
            <div class="product-stock ${p.stock <= 10 && p.stock > 0 ? 'low' : ''}">
              ${p.stock > 0 ? (p.stock <= 10 ? `⚠️ เหลือ ${p.stock} ${p.unit}` : `คงเหลือ ${p.stock} ${p.unit}`) : 'สินค้าหมด'}
            </div>
          </div>
        </div>
        ${!outOfStock ? `
        <div class="qty-control">
          <button class="qty-btn" onclick="changeQty(${p.id}, -1)">−</button>
          <input class="qty-input" id="qty-${p.id}" type="number" value="${qty}" min="1" max="${p.stock}" onchange="clampQty(${p.id})">
          <button class="qty-btn" onclick="changeQty(${p.id}, 1)">+</button>
          <button class="btn btn-primary btn-sm add-cart-btn" onclick="addToCart(${p.id})">ใส่ตะกร้า</button>
        </div>` : ''}
      </div>
    </div>`;
  }).join('');
}

function filterCategory(cat, btn) {
  currentCategory = cat;
  document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  loadProducts(document.getElementById('searchInput').value);
}

let searchTimeout;
function searchProducts() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => loadProducts(document.getElementById('searchInput').value), 350);
}

function changeQty(id, delta) {
  const input = document.getElementById(`qty-${id}`);
  const product = products.find(p => p.id === id);
  let val = parseInt(input.value) + delta;
  val = Math.max(1, Math.min(val, product?.stock || 99));
  input.value = val;
}

function clampQty(id) {
  const input = document.getElementById(`qty-${id}`);
  const product = products.find(p => p.id === id);
  let val = parseInt(input.value) || 1;
  val = Math.max(1, Math.min(val, product?.stock || 99));
  input.value = val;
}

// ─── Cart ─────────────────────────────────────────────────────────────────────
function addToCart(productId) {
  const product = products.find(p => p.id === productId);
  if (!product) return;
  const qty = parseInt(document.getElementById(`qty-${productId}`)?.value || 1);
  const existing = cart.find(c => c.id === productId);
  if (existing) {
    existing.qty = Math.min(existing.qty + qty, product.stock);
  } else {
    cart.push({ id: productId, qty, name: product.name, price: product.price, unit: product.unit, image: product.image_url });
  }
  saveCart();
  renderCart();
  showToast(`✅ เพิ่ม "${product.name}" ลงตะกร้าแล้ว`);
}

function removeFromCart(id) {
  cart = cart.filter(c => c.id !== id);
  saveCart();
  renderCart();
}

function changeCartQty(id, delta) {
  const item = cart.find(c => c.id === id);
  const product = products.find(p => p.id === id);
  if (!item) return;
  item.qty = Math.max(1, item.qty + delta);
  if (product) item.qty = Math.min(item.qty, product.stock);
  saveCart();
  renderCart();
}

function saveCart() { localStorage.setItem('btCart', JSON.stringify(cart)); }

function renderCart() {
  const count = cart.reduce((s, c) => s + c.qty, 0);
  document.getElementById('cartCount').textContent = count;
  const body = document.getElementById('cartBody');
  const footer = document.getElementById('cartFooter');

  if (!cart.length) {
    body.innerHTML = '<div class="cart-empty">🛒<br>ยังไม่มีสินค้าในตะกร้า</div>';
    footer.style.display = 'none';
    return;
  }

  const total = cart.reduce((s, c) => s + c.price * c.qty, 0);
  body.innerHTML = cart.map(item => `
    <div class="cart-item">
      <img class="cart-item-img" src="${item.image || 'https://images.unsplash.com/photo-1536304929831-ee1ca9d44906?w=100'}"
           alt="${item.name}" onerror="this.src='https://images.unsplash.com/photo-1536304929831-ee1ca9d44906?w=100'">
      <div class="cart-item-info">
        <div class="cart-item-name">${item.name}</div>
        <div class="cart-item-price">฿${item.price.toLocaleString()} / ${item.unit}</div>
        <div class="cart-item-controls">
          <button class="qty-btn" onclick="changeCartQty(${item.id}, -1)">−</button>
          <span class="cart-item-qty">${item.qty}</span>
          <button class="qty-btn" onclick="changeCartQty(${item.id}, 1)">+</button>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px">
        <span class="cart-item-total">฿${(item.price * item.qty).toLocaleString()}</span>
        <button class="cart-item-remove" onclick="removeFromCart(${item.id})" title="ลบ">🗑</button>
      </div>
    </div>
  `).join('');

  document.getElementById('cartTotal').textContent = `฿${total.toLocaleString()}`;
  const shippingMsg = document.getElementById('freeShippingMsg');
  if (total >= 500) {
    shippingMsg.textContent = '🎉 ฟรีค่าจัดส่ง! (ซื้อครบ ฿500)';
  } else {
    shippingMsg.textContent = `ซื้ออีก ฿${(500 - total).toLocaleString()} รับสิทธิ์ส่งฟรี!`;
  }
  footer.style.display = 'block';
}

// ─── Cart UI ──────────────────────────────────────────────────────────────────
function toggleCart() {
  document.getElementById('cartSidebar').classList.toggle('open');
  document.getElementById('cartOverlay').classList.toggle('open');
}

function openCheckout() {
  const total = cart.reduce((s, c) => s + c.price * c.qty, 0);
  const shipping = total >= 500 ? 0 : 50;

  const summary = document.getElementById('orderSummary');
  summary.innerHTML = cart.map(item =>
    `<div class="order-summary-item"><span>${item.name} × ${item.qty}</span><span>฿${(item.price * item.qty).toLocaleString()}</span></div>`
  ).join('');

  document.getElementById('checkoutSubtotal').textContent = `฿${total.toLocaleString()}`;
  document.getElementById('checkoutShipping').textContent = shipping === 0 ? 'ฟรี 🎉' : `฿${shipping}`;
  document.getElementById('checkoutTotal').textContent = `฿${(total + shipping).toLocaleString()}`;

  document.getElementById('checkoutOverlay').classList.add('open');
  toggleCart();
}

function closeCheckout() { document.getElementById('checkoutOverlay').classList.remove('open'); }

// ─── Order Submission ─────────────────────────────────────────────────────────
async function submitOrder(e) {
  e.preventDefault();
  const btn = document.getElementById('submitBtn');
  btn.disabled = true;
  btn.textContent = 'กำลังส่งคำสั่งซื้อ...';

  const total = cart.reduce((s, c) => s + c.price * c.qty, 0);
  const shipping = total >= 500 ? 0 : 50;

  const payload = {
    customer_name: document.getElementById('custName').value,
    customer_phone: document.getElementById('custPhone').value,
    customer_address: document.getElementById('custAddress').value,
    note: document.getElementById('custNote').value,
    items: cart.map(c => ({ product_id: c.id, quantity: c.qty }))
  };

  try {
    const res = await fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'เกิดข้อผิดพลาด');
    closeCheckout();
    document.getElementById('checkoutForm').reset();
    document.getElementById('successMsg').innerHTML = `
      หมายเลขคำสั่งซื้อ: <strong>${data.order_number}</strong><br>
      ยอดชำระ: <strong>฿${(data.total_amount + shipping).toLocaleString()}</strong><br><br>
      ทีมงานจะติดต่อกลับเพื่อยืนยันคำสั่งซื้อภายใน 30 นาที 📞
    `;
    document.getElementById('successOverlay').classList.add('open');
    cart = [];
    saveCart();
    renderCart();
    loadProducts();
  } catch (err) {
    showToast(`❌ ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'ยืนยันการสั่งซื้อ';
  }
}

function closeSuccess() { document.getElementById('successOverlay').classList.remove('open'); }

// ─── Toast ────────────────────────────────────────────────────────────────────
let toastTimeout;
function showToast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => t.classList.remove('show'), 2500);
}

// Close modals on overlay click
document.getElementById('checkoutOverlay').addEventListener('click', function(e) {
  if (e.target === this) closeCheckout();
});
document.getElementById('successOverlay').addEventListener('click', function(e) {
  if (e.target === this) closeSuccess();
});
