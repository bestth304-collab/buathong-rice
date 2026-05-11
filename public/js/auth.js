// ─── Auth State ───────────────────────────────────────────────────────────────
let currentUser = null;
let appConfig = {};

async function loadConfig() {
  const res = await fetch('/api/config');
  appConfig = await res.json();

  // Google Sign-In
  if (appConfig.hasGoogle && appConfig.googleClientId) {
    // wait for GIS script to load
    if (window.google) initGoogleSignIn(appConfig.googleClientId);
    else window.addEventListener('load', () => initGoogleSignIn(appConfig.googleClientId));
  } else {
    // Hide Google button, show "ต้องตั้งค่า" notice
    document.querySelectorAll('.google-btn-wrap').forEach(el => {
      el.innerHTML = '<button class="oauth-unavailable" onclick="showOAuthHelp(\'google\')" type="button">🔵 Sign in with Google <span class="oauth-tag">ต้องตั้งค่า</span></button>';
    });
  }

  // Facebook Login
  if (appConfig.hasFacebook && appConfig.facebookAppId) {
    initFacebook(appConfig.facebookAppId);
  } else {
    document.querySelectorAll('.fb-login-btn').forEach(el => {
      el.onclick = () => showOAuthHelp('facebook');
      el.innerHTML = el.innerHTML + ' <span class="oauth-tag">ต้องตั้งค่า</span>';
    });
  }
}

function getToken() { return localStorage.getItem('btUserToken'); }
function setToken(token) { localStorage.setItem('btUserToken', token); }
function clearToken() { localStorage.removeItem('btUserToken'); }

function authHeaders() {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
}

async function checkUserAuth() {
  const token = getToken();
  if (!token) return updateAuthUI(null);
  try {
    const res = await fetch('/api/user/profile', { headers: authHeaders() });
    if (!res.ok) throw new Error();
    currentUser = await res.json();
    updateAuthUI(currentUser);
  } catch {
    clearToken();
    updateAuthUI(null);
  }
}

function updateAuthUI(user) {
  const loginBtn = document.getElementById('authNavBtn');
  const userMenu = document.getElementById('userNavMenu');
  if (!loginBtn) return;
  if (user) {
    loginBtn.style.display = 'none';
    userMenu.style.display = 'flex';
    document.getElementById('navUserName').textContent = user.name;
    const avatar = document.getElementById('navAvatar');
    if (user.avatar_url) { avatar.src = user.avatar_url; avatar.style.display = 'block'; }
  } else {
    loginBtn.style.display = 'flex';
    userMenu.style.display = 'none';
    currentUser = null;
  }
}

// ─── Auth Modal ───────────────────────────────────────────────────────────────
function openAuthModal(tab = 'login') {
  document.getElementById('authModal').classList.add('open');
  switchAuthTab(tab);
  document.getElementById('loginError').style.display = 'none';
  document.getElementById('registerError').style.display = 'none';
}

function closeAuthModal() {
  document.getElementById('authModal').classList.remove('open');
  document.getElementById('loginForm').reset();
  document.getElementById('registerForm').reset();
}

function switchAuthTab(tab) {
  document.getElementById('loginTab').classList.toggle('active', tab === 'login');
  document.getElementById('registerTab').classList.toggle('active', tab === 'register');
  document.getElementById('loginPanel').style.display = tab === 'login' ? 'block' : 'none';
  document.getElementById('registerPanel').style.display = tab === 'register' ? 'block' : 'none';
}

// ─── Phone Login ──────────────────────────────────────────────────────────────
async function doPhoneLogin(e) {
  e.preventDefault();
  const errEl = document.getElementById('loginError');
  const btn = document.getElementById('loginSubmitBtn');
  errEl.style.display = 'none';
  btn.disabled = true; btn.textContent = 'กำลังเข้าสู่ระบบ...';
  try {
    const res = await fetch('/api/user/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: document.getElementById('loginPhone').value, password: document.getElementById('loginPassword').value })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    setToken(data.token);
    await checkUserAuth();
    closeAuthModal();
    showToast(`✅ ยินดีต้อนรับกลับ ${data.name}!`);
  } catch (err) {
    errEl.textContent = err.message; errEl.style.display = 'block';
  } finally { btn.disabled = false; btn.textContent = 'เข้าสู่ระบบ'; }
}

// ─── Phone Register ───────────────────────────────────────────────────────────
async function doPhoneRegister(e) {
  e.preventDefault();
  const errEl = document.getElementById('registerError');
  const btn = document.getElementById('registerSubmitBtn');
  errEl.style.display = 'none';
  const pass = document.getElementById('registerPassword').value;
  const pass2 = document.getElementById('registerPassword2').value;
  if (pass !== pass2) { errEl.textContent = 'รหัสผ่านไม่ตรงกัน'; errEl.style.display = 'block'; return; }
  btn.disabled = true; btn.textContent = 'กำลังสมัครสมาชิก...';
  try {
    const res = await fetch('/api/user/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: document.getElementById('registerName').value,
        phone: document.getElementById('registerPhone').value,
        email: document.getElementById('registerEmail').value,
        password: pass
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    setToken(data.token);
    await checkUserAuth();
    closeAuthModal();
    showToast(`🎉 สมัครสมาชิกสำเร็จ ยินดีต้อนรับ ${data.name}!`);
  } catch (err) {
    errEl.textContent = err.message; errEl.style.display = 'block';
  } finally { btn.disabled = false; btn.textContent = 'สมัครสมาชิก'; }
}

// ─── Google Sign-In ───────────────────────────────────────────────────────────
function initGoogleSignIn(clientId) {
  if (!window.google || !clientId) return;
  google.accounts.id.initialize({
    client_id: clientId,
    callback: handleGoogleCallback,
  });
  const btn = document.getElementById('googleSignInBtn');
  if (btn) {
    google.accounts.id.renderButton(btn, { theme: 'outline', size: 'large', width: btn.offsetWidth || 340, text: 'signin_with', shape: 'rectangular', logo_alignment: 'left' });
  }
  const btn2 = document.getElementById('googleSignInBtn2');
  if (btn2) {
    google.accounts.id.renderButton(btn2, { theme: 'outline', size: 'large', width: btn2.offsetWidth || 340, text: 'signin_with', shape: 'rectangular', logo_alignment: 'left' });
  }
}

async function handleGoogleCallback(response) {
  try {
    const res = await fetch('/api/user/google', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: response.credential })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    setToken(data.token);
    await checkUserAuth();
    closeAuthModal();
    showToast(`✅ เข้าสู่ระบบด้วย Google สำเร็จ!`);
  } catch (err) { showToast(`❌ ${err.message}`); }
}

// ─── Facebook Login ───────────────────────────────────────────────────────────
function initFacebook(appId) {
  if (!appId) return;
  window.fbAsyncInit = function() {
    FB.init({ appId, cookie: true, xfbml: true, version: 'v18.0' });
  };
  (function(d, s, id) {
    var js, fjs = d.getElementsByTagName(s)[0];
    if (d.getElementById(id)) return;
    js = d.createElement(s); js.id = id;
    js.src = 'https://connect.facebook.net/th_TH/sdk.js';
    fjs.parentNode.insertBefore(js, fjs);
  }(document, 'script', 'facebook-jssdk'));
}

function showOAuthHelp(provider) {
  const msgs = {
    google: '🔵 Google Sign-In\n\nต้องตั้งค่า GOOGLE_CLIENT_ID ใน Render:\n1. ไปที่ console.cloud.google.com\n2. สร้าง OAuth 2.0 Client ID\n3. เพิ่ม buathong-rice.onrender.com เป็น Authorized domain\n4. Copy Client ID → ใส่ใน Render Environment Variables',
    facebook: '🔷 Facebook Login\n\nต้องตั้งค่า FACEBOOK_APP_ID ใน Render:\n1. ไปที่ developers.facebook.com\n2. สร้าง App ใหม่ → เลือก Consumer\n3. เพิ่ม Facebook Login product\n4. ใส่ buathong-rice.onrender.com ใน Valid OAuth Redirect URIs\n5. Copy App ID → ใส่ใน Render Environment Variables',
  };
  alert(msgs[provider] || 'ต้องตั้งค่าก่อนใช้งาน');
}

async function doFacebookLogin() {
  if (!appConfig.hasFacebook) { showOAuthHelp('facebook'); return; }
  if (!window.FB) { showToast('⏳ Facebook SDK กำลังโหลด กรุณารอสักครู่...'); return; }
  FB.login(async (response) => {
    if (response.authResponse) {
      FB.api('/me', { fields: 'name,email,picture' }, async (user) => {
        try {
          const res = await fetch('/api/user/facebook', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fbId: response.authResponse.userID, name: user.name, email: user.email, picture: user.picture?.data?.url })
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error);
          setToken(data.token);
          await checkUserAuth();
          closeAuthModal();
          showToast('✅ เข้าสู่ระบบด้วย Facebook สำเร็จ!');
        } catch (err) { showToast(`❌ ${err.message}`); }
      });
    }
  }, { scope: 'email,public_profile' });
}

// ─── Logout ───────────────────────────────────────────────────────────────────
function doLogout() {
  clearToken();
  currentUser = null;
  updateAuthUI(null);
  closeProfileModal();
  showToast('👋 ออกจากระบบเรียบร้อย');
}

// ─── Profile Modal ────────────────────────────────────────────────────────────
function openProfileModal() {
  if (!currentUser) { openAuthModal('login'); return; }
  document.getElementById('profileModal').classList.add('open');
  showProfileSection('info');
  renderProfile();
}

function closeProfileModal() { document.getElementById('profileModal').classList.remove('open'); }

function showProfileSection(sec) {
  const sections = ['info','edit','address','payment','orders','wishlist'];
  sections.forEach(s => {
    const el = document.getElementById(`psec-${s}`);
    if (el) el.style.display = s === sec ? 'block' : 'none';
  });
  // sidebar active state (map edit→info for active highlight)
  const navKey = sec === 'edit' ? 'info' : sec;
  document.querySelectorAll('.profile-nav-item').forEach(b => b.classList.remove('active'));
  const active = document.getElementById(`pnav-${navKey}`);
  if (active) active.classList.add('active');

  if (sec === 'orders') renderOrderHistory();
  if (sec === 'wishlist') renderWishlist();
  if (sec === 'payment') renderPaymentHistory();
}

async function renderProfile() {
  if (!currentUser) return;

  // Sidebar
  document.getElementById('sidebarName').textContent = currentUser.name || '-';
  document.getElementById('sidebarPhone').textContent = currentUser.phone || currentUser.email || '-';
  const avatarImg = document.getElementById('profileAvatarImg');
  const avatarInit = document.getElementById('profileAvatarInitial');
  if (currentUser.avatar_url) {
    avatarImg.src = currentUser.avatar_url; avatarImg.style.display = 'block'; avatarInit.style.display = 'none';
  } else {
    avatarImg.style.display = 'none'; avatarInit.style.display = 'flex';
    avatarInit.textContent = (currentUser.name || '?')[0].toUpperCase();
  }

  // Info section
  document.getElementById('infoName').textContent = currentUser.name || '-';
  document.getElementById('infoEmail').textContent = currentUser.email || '-';
  document.getElementById('infoPhone').textContent = currentUser.phone || '-';
  document.getElementById('infoSince').textContent = fmtDate(currentUser.created_at);

  // Edit form
  document.getElementById('profileName').value = currentUser.name || '';
  document.getElementById('profileEmail').value = currentUser.email || '';
  document.getElementById('profilePhone').textContent = currentUser.phone || '-';

  // Stats
  const s = currentUser.stats || {};
  document.getElementById('statDelivered').textContent = s.delivered || 0;
  document.getElementById('statShipping').textContent = s.shipping || 0;
  document.getElementById('statPending').textContent = s.pending || 0;
  document.getElementById('statUnpaid').textContent = s.unpaid || 0;

  // Badges
  const wl = currentUser.wishlist || [];
  const wbadge = document.getElementById('pnav-wishlist-badge');
  wbadge.textContent = wl.length; wbadge.style.display = wl.length ? 'inline-flex' : 'none';

  const pendingOrders = (currentUser.orders || []).filter(o => o.status === 'pending' || o.status === 'confirmed').length;
  const obadge = document.getElementById('pnav-orders-badge');
  obadge.textContent = pendingOrders; obadge.style.display = pendingOrders ? 'inline-flex' : 'none';

  renderAddresses();
}

async function saveProfile(e) {
  e.preventDefault();
  const res = await fetch('/api/user/profile', {
    method: 'PUT', headers: authHeaders(),
    body: JSON.stringify({ name: document.getElementById('profileName').value, email: document.getElementById('profileEmail').value })
  });
  if (res.ok) {
    await checkUserAuth();
    showToast('✅ บันทึกข้อมูลเรียบร้อย');
  }
}

async function savePassword(e) {
  e.preventDefault();
  const current = document.getElementById('pwCurrent').value;
  const next = document.getElementById('pwNew').value;
  const next2 = document.getElementById('pwNew2').value;
  if (next !== next2) { showToast('❌ รหัสผ่านใหม่ไม่ตรงกัน'); return; }
  const res = await fetch('/api/user/password', { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ current, next }) });
  const data = await res.json();
  if (!res.ok) { showToast(`❌ ${data.error}`); return; }
  showToast('✅ เปลี่ยนรหัสผ่านเรียบร้อย');
  document.getElementById('passwordForm').reset();
}

// ─── Addresses Management ─────────────────────────────────────────────────────
function renderAddresses() {
  const addresses = currentUser?.addresses || [];
  const el = document.getElementById('addressList');
  if (!addresses.length) { el.innerHTML = '<div class="empty-state">ยังไม่มีที่อยู่บันทึกไว้</div>'; return; }
  el.innerHTML = addresses.map(a => `
    <div class="address-card ${a.is_default ? 'default' : ''}">
      <div class="address-header">
        <span class="address-label">${a.label}</span>
        ${a.is_default ? '<span class="badge badge-success">ค่าเริ่มต้น</span>' : ''}
      </div>
      <div class="address-body">
        <strong>${a.recipient_name}</strong> · ${a.phone}<br>${a.address_text}
      </div>
      <div class="address-actions">
        <button class="btn btn-sm btn-ghost" onclick="openAddressForm(${JSON.stringify(a).replace(/"/g,'&quot;')})">✏️ แก้ไข</button>
        <button class="btn btn-sm btn-danger" onclick="deleteAddress(${a.id})">🗑 ลบ</button>
      </div>
    </div>`).join('');
}

function openAddressForm(addr = null) {
  document.getElementById('addrFormPanel').style.display = 'block';
  document.getElementById('addrId').value = addr?.id || '';
  document.getElementById('addrLabel').value = addr?.label || 'บ้าน';
  document.getElementById('addrName').value = addr?.recipient_name || currentUser?.name || '';
  document.getElementById('addrPhone').value = addr?.phone || currentUser?.phone || '';
  document.getElementById('addrText').value = addr?.address_text || '';
  document.getElementById('addrDefault').checked = !!addr?.is_default;
}

function closeAddressForm() { document.getElementById('addrFormPanel').style.display = 'none'; }

async function saveAddress(e) {
  e.preventDefault();
  const id = document.getElementById('addrId').value;
  const payload = {
    label: document.getElementById('addrLabel').value,
    recipient_name: document.getElementById('addrName').value,
    phone: document.getElementById('addrPhone').value,
    address_text: document.getElementById('addrText').value,
    is_default: document.getElementById('addrDefault').checked,
  };
  const url = id ? `/api/user/addresses/${id}` : '/api/user/addresses';
  const res = await fetch(url, { method: id ? 'PUT' : 'POST', headers: authHeaders(), body: JSON.stringify(payload) });
  if (res.ok) {
    await checkUserAuth();
    closeAddressForm();
    renderProfile();
    showToast('✅ บันทึกที่อยู่เรียบร้อย');
  }
}

async function deleteAddress(id) {
  if (!confirm('ลบที่อยู่นี้?')) return;
  await fetch(`/api/user/addresses/${id}`, { method: 'DELETE', headers: authHeaders() });
  await checkUserAuth();
  renderAddresses();
  showToast('🗑 ลบที่อยู่แล้ว');
}

// ─── Wishlist ─────────────────────────────────────────────────────────────────
function renderWishlist() {
  const items = currentUser?.wishlist || [];
  const el = document.getElementById('wishlistGrid');
  if (!el) return;
  if (!items.length) { el.innerHTML = '<div class="empty-state">❤️ ยังไม่มีสินค้าที่ถูกใจ<br><small>กดปุ่ม ❤ บนสินค้าที่สนใจ</small></div>'; return; }
  el.innerHTML = items.map(p => `
    <div class="wishlist-card">
      <img src="${p.image_url || 'https://images.unsplash.com/photo-1536304929831-ee1ca9d44906?w=300'}" alt="${p.name}"
           onerror="this.src='https://images.unsplash.com/photo-1536304929831-ee1ca9d44906?w=300'">
      <div class="wishlist-card-body">
        <div class="wishlist-cat">${p.category}</div>
        <div class="wishlist-name">${p.name}</div>
        <div class="wishlist-price">฿${p.price.toLocaleString()} / ${p.unit}</div>
      </div>
      <div class="wishlist-card-footer">
        <button class="btn btn-primary btn-sm" style="flex:1" onclick="closeProfileModal();setTimeout(()=>document.getElementById('products').scrollIntoView({behavior:'smooth'}),200)">ดูสินค้า</button>
        <button class="btn btn-danger btn-sm" onclick="toggleWishlist(${p.id},true)">🗑</button>
      </div>
    </div>`).join('');
}

async function toggleWishlist(productId, forceRemove = false) {
  const token = getToken();
  if (!token) { openAuthModal('login'); return; }
  const inList = currentUser?.wishlist?.some(w => w.id === productId);
  const remove = forceRemove || inList;
  const method = remove ? 'DELETE' : 'POST';
  await fetch(`/api/user/wishlist/${productId}`, { method, headers: authHeaders() });
  await checkUserAuth();
  renderProfile();
  // refresh heart button state on product cards
  document.querySelectorAll(`[data-wish-id="${productId}"]`).forEach(btn => {
    const nowIn = !remove;
    btn.classList.toggle('wished', nowIn);
    btn.title = nowIn ? 'เอาออกจากสินค้าที่ถูกใจ' : 'เพิ่มในสินค้าที่ถูกใจ';
  });
  showToast(remove ? '💔 นำออกจากสินค้าที่ถูกใจแล้ว' : '❤️ เพิ่มในสินค้าที่ถูกใจแล้ว');
}

// ─── Payment History ──────────────────────────────────────────────────────────
function renderPaymentHistory() {
  const orders = (currentUser?.orders || []).filter(o => o.payment_status === 'paid');
  const el = document.getElementById('paymentHistoryList');
  if (!el) return;
  if (!orders.length) { el.innerHTML = '<div class="empty-state">ยังไม่มีประวัติการชำระเงิน</div>'; return; }
  const PAY = { promptpay: '📱 พร้อมเพย์', card: '💳 บัตรเครดิต' };
  el.innerHTML = orders.map(o => `
    <div class="history-card">
      <div class="history-header">
        <div><span class="history-num">${o.order_number}</span><span class="history-date">${fmtDate(o.created_at)}</span></div>
        <span class="badge badge-success">ชำระแล้ว</span>
      </div>
      <div class="history-footer">
        <span>${PAY[o.payment_method] || o.payment_method}</span>
        <strong>฿${o.total_amount.toLocaleString()}</strong>
      </div>
    </div>`).join('');
}

// ─── Order History ────────────────────────────────────────────────────────────
function fmtDate(str) {
  if (!str) return '-';
  const d = new Date(str.replace(' ', 'T'));
  if (isNaN(d)) return str;
  return d.toLocaleString('th-TH', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const ORDER_STATUS = {
  pending: { label: 'รอดำเนินการ', cls: 'badge-warning' },
  confirmed: { label: 'ยืนยันแล้ว', cls: 'badge-info' },
  shipping: { label: 'กำลังจัดส่ง', cls: 'badge-info' },
  delivered: { label: 'ส่งสำเร็จ', cls: 'badge-success' },
  cancelled: { label: 'ยกเลิก', cls: 'badge-danger' },
};

function renderOrderHistory() {
  const orders = currentUser?.orders || [];
  const el = document.getElementById('orderHistoryList');
  if (!orders.length) { el.innerHTML = '<div class="empty-state">ยังไม่มีประวัติการสั่งซื้อ</div>'; return; }
  el.innerHTML = orders.map(o => {
    const st = ORDER_STATUS[o.status] || ORDER_STATUS.pending;
    return `<div class="history-card">
      <div class="history-header">
        <div>
          <span class="history-num">${o.order_number}</span>
          <span class="history-date">${fmtDate(o.created_at)}</span>
        </div>
        <span class="badge ${st.cls}">${st.label}</span>
      </div>
      <div class="history-items">
        ${(o.items||[]).map(i=>`<span>${i.product_name} ×${i.quantity}</span>`).join(', ')}
      </div>
      <div class="history-footer">
        <span>ยอดรวม: <strong>฿${o.total_amount.toLocaleString()}</strong></span>
        <span class="payment-badge">${o.payment_method === 'promptpay' ? '📱 พร้อมเพย์' : o.payment_method === 'card' ? '💳 บัตร' : '💵 ยังไม่ชำระ'}</span>
      </div>
    </div>`;
  }).join('');
}

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadConfig();
  await checkUserAuth();
  document.getElementById('authModal')?.addEventListener('click', e => { if (e.target === e.currentTarget) closeAuthModal(); });
  document.getElementById('profileModal')?.addEventListener('click', e => { if (e.target === e.currentTarget) closeProfileModal(); });
});
