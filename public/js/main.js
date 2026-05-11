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
  window.addEventListener('scroll', () => navbar.classList.toggle('scrolled', window.scrollY > 50));
}

// ─── Products ─────────────────────────────────────────────────────────────────
async function loadCategories() {
  const cats = await fetch('/api/products/categories').then(r => r.json());
  const tabs = document.getElementById('categoryTabs');
  cats.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = 'cat-btn'; btn.textContent = cat; btn.dataset.cat = cat;
    btn.onclick = () => filterCategory(cat, btn);
    tabs.appendChild(btn);
  });
}

async function loadProducts(search = '') {
  document.getElementById('productsGrid').innerHTML = '<div class="loading">กำลังโหลดสินค้า...</div>';
  let url = '/api/products?';
  if (currentCategory !== 'all') url += `category=${encodeURIComponent(currentCategory)}&`;
  if (search) url += `search=${encodeURIComponent(search)}`;
  products = await fetch(url).then(r => r.json());
  renderProducts(products);
}

function renderProducts(list) {
  const grid = document.getElementById('productsGrid');
  if (!list.length) { grid.innerHTML = '<div class="no-products">😕 ไม่พบสินค้าที่ค้นหา</div>'; return; }
  grid.innerHTML = list.map(p => {
    const cartItem = cart.find(c => c.id === p.id);
    const qty = cartItem ? cartItem.qty : 1;
    const out = p.stock === 0;
    return `
    <div class="product-card" id="product-${p.id}">
      <div class="product-img">
        <img src="${p.image_url || 'https://images.unsplash.com/photo-1536304929831-ee1ca9d44906?w=400'}"
             alt="${p.name}" loading="lazy"
             onerror="this.src='https://images.unsplash.com/photo-1536304929831-ee1ca9d44906?w=400'">
        <div class="product-badge ${out ? 'out' : ''}">${out ? 'สินค้าหมด' : 'มีสินค้า'}</div>
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
        ${!out ? `
        <div class="qty-control">
          <button class="qty-btn" onclick="changeQty(${p.id},-1)">−</button>
          <input class="qty-input" id="qty-${p.id}" type="number" value="${qty}" min="1" max="${p.stock}" onchange="clampQty(${p.id})">
          <button class="qty-btn" onclick="changeQty(${p.id},1)">+</button>
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
  const p = products.find(x => x.id === id);
  let v = parseInt(input.value) + delta;
  input.value = Math.max(1, Math.min(v, p?.stock || 99));
}
function clampQty(id) {
  const input = document.getElementById(`qty-${id}`);
  const p = products.find(x => x.id === id);
  let v = parseInt(input.value) || 1;
  input.value = Math.max(1, Math.min(v, p?.stock || 99));
}

// ─── Cart ─────────────────────────────────────────────────────────────────────
function addToCart(productId) {
  const p = products.find(x => x.id === productId);
  if (!p) return;
  const qty = parseInt(document.getElementById(`qty-${productId}`)?.value || 1);
  const existing = cart.find(c => c.id === productId);
  if (existing) existing.qty = Math.min(existing.qty + qty, p.stock);
  else cart.push({ id: productId, qty, name: p.name, price: p.price, unit: p.unit, image: p.image_url });
  saveCart(); renderCart();
  showToast(`✅ เพิ่ม "${p.name}" ลงตะกร้าแล้ว`);
}

function removeFromCart(id) { cart = cart.filter(c => c.id !== id); saveCart(); renderCart(); }

function changeCartQty(id, delta) {
  const item = cart.find(c => c.id === id);
  const p = products.find(x => x.id === id);
  if (!item) return;
  item.qty = Math.max(1, item.qty + delta);
  if (p) item.qty = Math.min(item.qty, p.stock);
  saveCart(); renderCart();
}

function saveCart() { localStorage.setItem('btCart', JSON.stringify(cart)); }

function renderCart() {
  const count = cart.reduce((s, c) => s + c.qty, 0);
  document.getElementById('cartCount').textContent = count;
  const body = document.getElementById('cartBody');
  const footer = document.getElementById('cartFooter');
  if (!cart.length) {
    body.innerHTML = '<div class="cart-empty">🛒<br>ยังไม่มีสินค้าในตะกร้า</div>';
    footer.style.display = 'none'; return;
  }
  const total = cart.reduce((s, c) => s + c.price * c.qty, 0);
  body.innerHTML = cart.map(item => `
    <div class="cart-item">
      <img class="cart-item-img" src="${item.image || 'https://images.unsplash.com/photo-1536304929831-ee1ca9d44906?w=100'}" alt="${item.name}"
           onerror="this.src='https://images.unsplash.com/photo-1536304929831-ee1ca9d44906?w=100'">
      <div class="cart-item-info">
        <div class="cart-item-name">${item.name}</div>
        <div class="cart-item-price">฿${item.price.toLocaleString()} / ${item.unit}</div>
        <div class="cart-item-controls">
          <button class="qty-btn" onclick="changeCartQty(${item.id},-1)">−</button>
          <span class="cart-item-qty">${item.qty}</span>
          <button class="qty-btn" onclick="changeCartQty(${item.id},1)">+</button>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px">
        <span class="cart-item-total">฿${(item.price * item.qty).toLocaleString()}</span>
        <button class="cart-item-remove" onclick="removeFromCart(${item.id})">🗑</button>
      </div>
    </div>`).join('');
  document.getElementById('cartTotal').textContent = `฿${total.toLocaleString()}`;
  const msg = document.getElementById('freeShippingMsg');
  msg.textContent = total >= 500 ? '🎉 ฟรีค่าจัดส่ง! (ซื้อครบ ฿500)' : `ซื้ออีก ฿${(500-total).toLocaleString()} รับสิทธิ์ส่งฟรี!`;
  footer.style.display = 'block';
}

function toggleCart() {
  document.getElementById('cartSidebar').classList.toggle('open');
  document.getElementById('cartOverlay').classList.toggle('open');
}

// ─── Checkout ─────────────────────────────────────────────────────────────────
function openCheckout() {
  const total = cart.reduce((s, c) => s + c.price * c.qty, 0);
  const shipping = total >= 500 ? 0 : 50;

  // Pre-fill from user profile
  if (currentUser) {
    document.getElementById('custName').value = currentUser.name || '';
    document.getElementById('custPhone').value = currentUser.phone || '';
    // Pre-fill default address
    const def = currentUser.addresses?.find(a => a.is_default) || currentUser.addresses?.[0];
    if (def) document.getElementById('custAddress').value = def.address_text;

    // Populate saved address picker
    const picker = document.getElementById('savedAddressPicker');
    if (currentUser.addresses?.length) {
      picker.style.display = 'block';
      document.getElementById('savedAddressSelect').innerHTML =
        '<option value="">-- เลือกที่อยู่ที่บันทึกไว้ --</option>' +
        currentUser.addresses.map(a => `<option value="${a.id}">${a.label}: ${a.recipient_name} · ${a.address_text.slice(0,40)}...</option>`).join('');
    } else {
      picker.style.display = 'none';
    }
  } else {
    document.getElementById('savedAddressPicker').style.display = 'none';
  }

  const summary = document.getElementById('orderSummary');
  summary.innerHTML = cart.map(item =>
    `<div class="order-summary-item"><span>${item.name} × ${item.qty}</span><span>฿${(item.price*item.qty).toLocaleString()}</span></div>`
  ).join('');

  document.getElementById('checkoutSubtotal').textContent = `฿${total.toLocaleString()}`;
  document.getElementById('checkoutShipping').textContent = shipping === 0 ? 'ฟรี 🎉' : `฿${shipping}`;
  document.getElementById('checkoutTotal').textContent = `฿${(total+shipping).toLocaleString()}`;
  document.getElementById('checkoutOverlay').classList.add('open');
  toggleCart();
}

function useSavedAddress(selectEl) {
  const id = parseInt(selectEl.value);
  if (!id || !currentUser?.addresses) return;
  const addr = currentUser.addresses.find(a => a.id === id);
  if (addr) {
    document.getElementById('custName').value = addr.recipient_name;
    document.getElementById('custPhone').value = addr.phone;
    document.getElementById('custAddress').value = addr.address_text;
  }
}

function closeCheckout() { document.getElementById('checkoutOverlay').classList.remove('open'); }

// ─── Order Submission ─────────────────────────────────────────────────────────
async function submitOrder(e) {
  e.preventDefault();
  const btn = document.getElementById('submitBtn');
  btn.disabled = true; btn.textContent = 'กำลังส่งคำสั่งซื้อ...';

  const total = cart.reduce((s, c) => s + c.price * c.qty, 0);
  const shipping = total >= 500 ? 0 : 50;
  const saveAddr = document.getElementById('saveAddressCheck')?.checked;

  const payload = {
    customer_name: document.getElementById('custName').value,
    customer_phone: document.getElementById('custPhone').value,
    customer_address: document.getElementById('custAddress').value,
    note: document.getElementById('custNote').value,
    items: cart.map(c => ({ product_id: c.id, quantity: c.qty })),
    payment_method: 'pending',
  };

  try {
    const headers = { 'Content-Type': 'application/json' };
    const token = localStorage.getItem('btUserToken');
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch('/api/orders', { method: 'POST', headers, body: JSON.stringify(payload) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'เกิดข้อผิดพลาด');

    // Save new address if user is logged in and checked
    if (currentUser && saveAddr && payload.customer_address) {
      const exists = currentUser.addresses?.some(a => a.address_text === payload.customer_address);
      if (!exists) {
        await fetch('/api/user/addresses', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            label: 'ที่อยู่ใหม่', recipient_name: payload.customer_name,
            phone: payload.customer_phone, address_text: payload.customer_address,
            is_default: !currentUser.addresses?.length,
          })
        });
        await checkUserAuth();
      }
    }

    closeCheckout();
    // Open payment modal
    openPaymentModal(data.id, data.total_amount + shipping, data.order_number);
    loadProducts();
  } catch (err) {
    showToast(`❌ ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = 'ยืนยันการสั่งซื้อ';
  }
}

// ─── Toast ─────────────────────────────────────────────────────────────────────
let toastTimeout;
function showToast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => t.classList.remove('show'), 2800);
}

// ─── Event Listeners ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('checkoutOverlay').addEventListener('click', function(e) {
    if (e.target === this) closeCheckout();
  });
});
