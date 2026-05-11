// ─── State ────────────────────────────────────────────────────────────────────
let token = localStorage.getItem('btAdminToken');
let allProducts = [];
let allOrders = [];
let currentOrderFilter = 'all';
let deleteTargetId = null;

const STATUS_LABELS = {
  pending:   { label: 'รอดำเนินการ', cls: 'badge-warning' },
  confirmed: { label: 'ยืนยันแล้ว',  cls: 'badge-info' },
  shipping:  { label: 'กำลังจัดส่ง', cls: 'badge-info' },
  delivered: { label: 'ส่งสำเร็จ',   cls: 'badge-success' },
  cancelled: { label: 'ยกเลิก',      cls: 'badge-danger' },
};

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  if (token) {
    const ok = await verifyToken();
    if (ok) return showApp();
  }
  showLogin();
});

function showLogin() {
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('adminApp').style.display = 'none';
}

function showApp() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('adminApp').style.display = 'flex';
  loadDashboard();
  loadProducts();
  loadOrders();
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
async function verifyToken() {
  try {
    const res = await apiFetch('/api/auth/verify');
    if (res.ok) {
      const data = await res.json();
      document.getElementById('adminName').textContent = data.name;
      return true;
    }
  } catch {}
  return false;
}

async function doLogin(e) {
  e.preventDefault();
  const btn = document.getElementById('loginBtn');
  const errEl = document.getElementById('loginError');
  btn.disabled = true;
  btn.textContent = 'กำลังเข้าสู่ระบบ...';
  errEl.style.display = 'none';

  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: document.getElementById('loginUser').value,
      password: document.getElementById('loginPass').value,
    })
  });
  const data = await res.json();
  btn.disabled = false;
  btn.textContent = 'เข้าสู่ระบบ';

  if (!res.ok) {
    errEl.textContent = data.error || 'เกิดข้อผิดพลาด';
    errEl.style.display = 'block';
    return;
  }
  token = data.token;
  localStorage.setItem('btAdminToken', token);
  document.getElementById('adminName').textContent = data.name;
  showApp();
}

function doLogout() {
  token = null;
  localStorage.removeItem('btAdminToken');
  showLogin();
}

// ─── API Helper ───────────────────────────────────────────────────────────────
function apiFetch(url, opts = {}) {
  return fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) }
  });
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
function showTab(tab, el) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(`tab-${tab}`).classList.add('active');
  el.classList.add('active');
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
async function loadDashboard() {
  const res = await apiFetch('/api/admin/dashboard');
  const data = await res.json();
  document.getElementById('statProducts').textContent = data.totalProducts.toLocaleString();
  document.getElementById('statOrders').textContent = data.totalOrders.toLocaleString();
  document.getElementById('statPending').textContent = data.pendingOrders.toLocaleString();
  document.getElementById('statRevenue').textContent = `฿${data.totalRevenue.toLocaleString()}`;
  if (data.pendingOrders > 0) {
    const badge = document.getElementById('pendingBadge');
    badge.textContent = data.pendingOrders;
    badge.style.display = 'inline-block';
  }
  renderRecentOrders();
}

function renderRecentOrders() {
  const el = document.getElementById('recentOrders');
  const recent = [...allOrders].slice(0, 5);
  if (!recent.length) { el.innerHTML = '<div style="padding:20px;color:#999;text-align:center">ยังไม่มีคำสั่งซื้อ</div>'; return; }
  el.innerHTML = recent.map(o => {
    const st = STATUS_LABELS[o.status] || STATUS_LABELS.pending;
    return `
    <div class="recent-order-item">
      <div class="recent-order-info">
        <div class="recent-order-name">${o.customer_name} · ${o.order_number}</div>
        <div class="recent-order-meta">${o.created_at} · ${o.items?.length || 0} รายการ</div>
      </div>
      <span class="badge ${st.cls}">${st.label}</span>
      <span class="recent-order-amt">฿${o.total_amount.toLocaleString()}</span>
    </div>`;
  }).join('');
}

// ─── Products ─────────────────────────────────────────────────────────────────
async function loadProducts() {
  const res = await apiFetch('/api/admin/products');
  allProducts = await res.json();
  renderProductTable(allProducts);
}

function renderProductTable(list) {
  const tbody = document.getElementById('productsTableBody');
  document.getElementById('productCount').textContent = `${list.length} รายการ`;
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="loading">ไม่พบสินค้า</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(p => `
    <tr>
      <td>${p.image_url
        ? `<img src="${p.image_url}" class="product-thumb" onerror="this.style.display='none'"`
          + ` alt="">`
        : `<div class="product-thumb-placeholder">🌾</div>`}
      </td>
      <td><strong>${p.name}</strong></td>
      <td><span class="badge badge-gray">${p.category}</span></td>
      <td><strong>฿${p.price.toLocaleString()}</strong> / ${p.unit}</td>
      <td>
        <span class="${p.stock === 0 ? 'badge badge-danger' : p.stock <= 10 ? 'badge badge-warning' : 'badge badge-success'}">
          ${p.stock} ${p.unit}
        </span>
      </td>
      <td>
        <span class="badge ${p.active ? 'badge-success' : 'badge-danger'}">
          ${p.active ? '✅ แสดง' : '⛔ ซ่อน'}
        </span>
      </td>
      <td>
        <div class="table-actions">
          <button class="btn btn-sm btn-ghost" onclick="openProductModal(${p.id})">✏️ แก้ไข</button>
          <button class="btn btn-sm btn-danger" onclick="openDeleteModal(${p.id}, '${p.name.replace(/'/g, "\\'")}')">🗑 ลบ</button>
        </div>
      </td>
    </tr>
  `).join('');
}

function filterProductTable() {
  const q = document.getElementById('productSearch').value.toLowerCase();
  const filtered = allProducts.filter(p =>
    p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q)
  );
  renderProductTable(filtered);
}

// ─── Product Modal ────────────────────────────────────────────────────────────
function openProductModal(id = null) {
  const form = document.getElementById('productForm');
  form.reset();
  document.getElementById('imagePreview').style.display = 'none';
  document.getElementById('activeGroup').style.display = 'none';

  if (id) {
    const p = allProducts.find(x => x.id === id);
    if (!p) return;
    document.getElementById('productModalTitle').textContent = 'แก้ไขสินค้า';
    document.getElementById('productId').value = id;
    document.getElementById('pName').value = p.name;
    document.getElementById('pCategory').value = p.category;
    document.getElementById('pDesc').value = p.description || '';
    document.getElementById('pPrice').value = p.price;
    document.getElementById('pUnit').value = p.unit;
    document.getElementById('pStock').value = p.stock;
    document.getElementById('pImage').value = p.image_url || '';
    document.getElementById('pActive').checked = !!p.active;
    document.getElementById('activeGroup').style.display = 'block';
    if (p.image_url) {
      const img = document.getElementById('imagePreview');
      img.src = p.image_url; img.style.display = 'block';
    }
  } else {
    document.getElementById('productModalTitle').textContent = 'เพิ่มสินค้าใหม่';
    document.getElementById('productId').value = '';
  }
  document.getElementById('productModal').classList.add('open');
}

function closeProductModal() { document.getElementById('productModal').classList.remove('open'); }

function previewImage() {
  const url = document.getElementById('pImage').value;
  const img = document.getElementById('imagePreview');
  if (url) { img.src = url; img.style.display = 'block'; img.onerror = () => img.style.display = 'none'; }
  else img.style.display = 'none';
}

async function saveProduct(e) {
  e.preventDefault();
  const id = document.getElementById('productId').value;
  const btn = document.getElementById('saveProductBtn');
  btn.disabled = true; btn.textContent = 'กำลังบันทึก...';

  const payload = {
    name: document.getElementById('pName').value,
    category: document.getElementById('pCategory').value,
    description: document.getElementById('pDesc').value,
    price: parseFloat(document.getElementById('pPrice').value),
    unit: document.getElementById('pUnit').value,
    stock: parseInt(document.getElementById('pStock').value),
    image_url: document.getElementById('pImage').value,
    active: document.getElementById('pActive').checked,
  };

  const url = id ? `/api/admin/products/${id}` : '/api/admin/products';
  const method = id ? 'PUT' : 'POST';
  const res = await apiFetch(url, { method, body: JSON.stringify(payload) });
  btn.disabled = false; btn.textContent = 'บันทึกสินค้า';

  if (!res.ok) { const d = await res.json(); alert(d.error || 'เกิดข้อผิดพลาด'); return; }
  closeProductModal();
  await loadProducts();
  await loadDashboard();
  showAdminToast(id ? '✅ แก้ไขสินค้าเรียบร้อย' : '✅ เพิ่มสินค้าใหม่เรียบร้อย');
}

// ─── Delete ───────────────────────────────────────────────────────────────────
function openDeleteModal(id, name) {
  deleteTargetId = id;
  document.getElementById('deleteMsg').textContent = `คุณต้องการลบสินค้า "${name}" ใช่หรือไม่? สินค้าจะถูกซ่อนออกจากหน้าร้าน`;
  document.getElementById('deleteModal').classList.add('open');
}
function closeDeleteModal() { document.getElementById('deleteModal').classList.remove('open'); deleteTargetId = null; }

async function confirmDelete() {
  if (!deleteTargetId) return;
  const res = await apiFetch(`/api/admin/products/${deleteTargetId}`, { method: 'DELETE' });
  closeDeleteModal();
  if (res.ok) { await loadProducts(); await loadDashboard(); showAdminToast('🗑 ลบสินค้าเรียบร้อย'); }
  else showAdminToast('❌ ลบสินค้าไม่สำเร็จ');
}

// ─── Orders ───────────────────────────────────────────────────────────────────
async function loadOrders() {
  const res = await apiFetch('/api/admin/orders');
  allOrders = await res.json();
  renderOrders(allOrders);
  renderRecentOrders();
}

function filterOrders(status, btn) {
  currentOrderFilter = status;
  document.querySelectorAll('.order-filter').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const filtered = status === 'all' ? allOrders : allOrders.filter(o => o.status === status);
  renderOrders(filtered);
}

function renderOrders(list) {
  const container = document.getElementById('ordersContainer');
  if (!list.length) {
    container.innerHTML = '<div class="no-orders">📭 ไม่มีคำสั่งซื้อในขณะนี้</div>';
    return;
  }
  container.innerHTML = list.map(o => {
    const st = STATUS_LABELS[o.status] || STATUS_LABELS.pending;
    const items = o.items || [];
    return `
    <div class="order-card">
      <div class="order-card-header">
        <div>
          <div class="order-num">🛒 ${o.order_number}</div>
          <div class="order-date">📅 ${o.created_at}</div>
        </div>
        <span class="badge ${st.cls}">${st.label}</span>
      </div>
      <div class="order-card-body">
        <div class="order-customer">
          <div class="order-field"><span>ชื่อลูกค้า</span><strong>${o.customer_name}</strong></div>
          <div class="order-field"><span>เบอร์โทร</span><strong>${o.customer_phone}</strong></div>
          <div class="order-field" style="grid-column:1/-1"><span>ที่อยู่</span><strong>${o.customer_address}</strong></div>
          ${o.note ? `<div class="order-field" style="grid-column:1/-1"><span>หมายเหตุ</span><strong>${o.note}</strong></div>` : ''}
        </div>
        <div class="order-items-list">
          ${items.map(i => `
            <div class="order-item-row">
              <span>${i.product_name} × ${i.quantity} ${i.unit}</span>
              <span>฿${(i.price * i.quantity).toLocaleString()}</span>
            </div>`).join('')}
        </div>
        <div class="order-total">
          <div class="order-total-amt">ยอดรวม: ฿${o.total_amount.toLocaleString()}</div>
          <select class="status-select" onchange="updateOrderStatus(${o.id}, this.value)">
            ${Object.entries(STATUS_LABELS).map(([k, v]) =>
              `<option value="${k}" ${o.status === k ? 'selected' : ''}>${v.label}</option>`
            ).join('')}
          </select>
        </div>
      </div>
    </div>`;
  }).join('');
}

async function updateOrderStatus(id, status) {
  const res = await apiFetch(`/api/admin/orders/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) });
  if (res.ok) {
    const order = allOrders.find(o => o.id === id);
    if (order) order.status = status;
    showAdminToast('✅ อัพเดทสถานะเรียบร้อย');
    loadDashboard();
  }
}

// ─── Toast ────────────────────────────────────────────────────────────────────
let toastTimer;
function showAdminToast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

// Modal click-outside close
document.getElementById('productModal').addEventListener('click', function(e) {
  if (e.target === this) closeProductModal();
});
document.getElementById('deleteModal').addEventListener('click', function(e) {
  if (e.target === this) closeDeleteModal();
});
