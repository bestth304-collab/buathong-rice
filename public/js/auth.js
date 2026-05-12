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
  // รีเซ็ต OTP step กลับไปขั้นที่ 1
  clearInterval(_otpTimerInterval);
  clearInterval(_resendInterval);
  const s1 = document.getElementById('regStep1');
  const s2 = document.getElementById('regStep2');
  if (s1) s1.style.display = 'block';
  if (s2) s2.style.display = 'none';
  document.getElementById('registerError').style.display = 'none';
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

// ─── Register Field Validation ────────────────────────────────────────────────
const ALLOWED_EMAIL_DOMAINS = [
  'gmail.com','googlemail.com',
  'hotmail.com','hotmail.co.th','hotmail.co.uk',
  'outlook.com','outlook.co.th',
  'yahoo.com','yahoo.co.th','yahoo.co.uk',
  'live.com','live.co.th',
  'msn.com','icloud.com','me.com','mac.com',
  'protonmail.com','proton.me',
  'aol.com','zoho.com',
  'truecorp.co.th','dtac.co.th','ais.th',
];

function setFieldHint(id, msg, ok) {
  const el = document.getElementById('hint-' + id);
  if (!el) return;
  el.textContent  = msg;
  el.className    = 'field-hint ' + (ok === true ? 'hint-ok' : ok === false ? 'hint-err' : '');
}

function markInput(inputId, ok) {
  const el = document.getElementById(inputId);
  if (!el) return;
  el.classList.toggle('input-ok',  ok === true);
  el.classList.toggle('input-err', ok === false);
}

function validateRegField(field) {
  const name  = document.getElementById('registerName')?.value.trim()    || '';
  const phone = document.getElementById('registerPhone')?.value.trim()   || '';
  const email = document.getElementById('registerEmail')?.value.trim()   || '';
  const pass  = document.getElementById('registerPassword')?.value       || '';
  const pass2 = document.getElementById('registerPassword2')?.value      || '';

  if (field === 'name') {
    if (!name) return setFieldHint('name', '', null);
    if (name.length < 2) { markInput('registerName', false); return setFieldHint('name', '❌ กรุณากรอกชื่อ-นามสกุล', false); }
    markInput('registerName', true);
    setFieldHint('name', '✅ ถูกต้อง', true);
  }

  if (field === 'phone') {
    if (!phone) return setFieldHint('phone', '', null);
    if (!/^\d+$/.test(phone))   { markInput('registerPhone', false); return setFieldHint('phone', '❌ กรอกตัวเลขเท่านั้น', false); }
    if (!phone.startsWith('0')) { markInput('registerPhone', false); return setFieldHint('phone', '❌ เบอร์ต้องขึ้นต้นด้วย 0', false); }
    if (phone.length < 10)      { markInput('registerPhone', false); return setFieldHint('phone', `⌛ ต้องการอีก ${10 - phone.length} หลัก`, false); }
    markInput('registerPhone', true);
    setFieldHint('phone', '✅ เบอร์ถูกต้อง', true);
  }

  if (field === 'email') {
    if (!email) return (markInput('registerEmail', null), setFieldHint('email', '', null));
    const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRx.test(email)) {
      markInput('registerEmail', false);
      return setFieldHint('email', '❌ รูปแบบอีเมลไม่ถูกต้อง (ต้องมี @)', false);
    }
    const domain = email.split('@')[1]?.toLowerCase();
    if (!ALLOWED_EMAIL_DOMAINS.includes(domain)) {
      markInput('registerEmail', false);
      return setFieldHint('email', `❌ โดเมนไม่รองรับ (ใช้ gmail.com, hotmail.com, yahoo.com ฯลฯ)`, false);
    }
    markInput('registerEmail', true);
    setFieldHint('email', `✅ ${domain}`, true);
  }

  if (field === 'pass') {
    const wrap = document.getElementById('strengthWrap');
    const bar  = document.getElementById('strengthBar');
    if (!pass) {
      if (wrap) wrap.style.display = 'none';
      markInput('registerPassword', null);
      return setFieldHint('pass', '', null);
    }
    if (wrap) wrap.style.display = 'block';
    // Strength score
    let score = 0;
    if (pass.length >= 6)  score++;
    if (pass.length >= 10) score++;
    if (/[A-Z]/.test(pass)) score++;
    if (/[0-9]/.test(pass)) score++;
    if (/[^A-Za-z0-9]/.test(pass)) score++;
    const levels = [
      { cls: 'str-1', label: 'อ่อนมาก' },
      { cls: 'str-2', label: 'อ่อน' },
      { cls: 'str-3', label: 'พอใช้' },
      { cls: 'str-4', label: 'แข็งแกร่ง' },
      { cls: 'str-5', label: 'แข็งแกร่งมาก' },
    ];
    const lv = levels[Math.min(score, 4)];
    if (bar) bar.className = `strength-bar ${lv.cls}`;
    if (pass.length < 6) {
      markInput('registerPassword', false);
      setFieldHint('pass', `❌ ต้องมีอย่างน้อย 6 ตัวอักษร (ยังขาดอีก ${6 - pass.length})`, false);
    } else {
      markInput('registerPassword', true);
      setFieldHint('pass', `✅ ความแข็งแกร่ง: ${lv.label}`, score >= 2 ? true : null);
    }
  }

  if (field === 'pass2') {
    if (!pass2) return (markInput('registerPassword2', null), setFieldHint('pass2', '', null));
    if (pass2 !== pass) {
      markInput('registerPassword2', false);
      return setFieldHint('pass2', '❌ รหัสผ่านไม่ตรงกัน', false);
    }
    markInput('registerPassword2', true);
    setFieldHint('pass2', '✅ รหัสผ่านตรงกัน', true);
  }
}

function filterPhoneInput(input) {
  // กรองให้เหลือแต่ตัวเลข และไม่เกิน 10 ตัว
  input.value = input.value.replace(/\D/g, '').slice(0, 10);
}

function togglePassVis(inputId, btn) {
  const el = document.getElementById(inputId);
  if (!el) return;
  el.type = el.type === 'password' ? 'text' : 'password';
  btn.textContent = el.type === 'password' ? '👁' : '🙈';
}

function validateAllRegFields() {
  ['name','phone','email','pass','pass2'].forEach(validateRegField);
  // คืนค่า true ถ้าผ่านหมด
  const name  = document.getElementById('registerName')?.value.trim()  || '';
  const phone = document.getElementById('registerPhone')?.value.trim() || '';
  const email = document.getElementById('registerEmail')?.value.trim() || '';
  const pass  = document.getElementById('registerPassword')?.value     || '';
  const pass2 = document.getElementById('registerPassword2')?.value    || '';

  if (name.length < 2) return { ok: false, msg: 'กรุณากรอกชื่อ-นามสกุล' };
  if (!/^0\d{9}$/.test(phone)) return { ok: false, msg: 'เบอร์โทรต้องเป็น 0 ตามด้วยตัวเลข 9 หลัก' };
  if (email) {
    const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const domain  = email.split('@')[1]?.toLowerCase();
    if (!emailRx.test(email) || !ALLOWED_EMAIL_DOMAINS.includes(domain))
      return { ok: false, msg: 'รูปแบบอีเมลไม่ถูกต้อง หรือโดเมนไม่รองรับ' };
  }
  if (pass.length < 6) return { ok: false, msg: 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร' };
  if (pass !== pass2)  return { ok: false, msg: 'รหัสผ่านไม่ตรงกัน' };
  return { ok: true };
}

// ─── Phone Register — Step 1: ส่ง OTP ────────────────────────────────────────
let _otpTimerInterval = null;
let _resendInterval   = null;

async function sendPhoneOtp(e) {
  e.preventDefault();
  const errEl = document.getElementById('registerError');
  const btn   = document.getElementById('sendOtpBtn');
  errEl.style.display = 'none';

  const check = validateAllRegFields();
  if (!check.ok) { errEl.textContent = check.msg; errEl.style.display = 'block'; return; }

  const phone = document.getElementById('registerPhone').value.trim();
  btn.disabled = true; btn.textContent = 'กำลังส่ง OTP...';
  try {
    const res  = await fetch('/api/user/otp/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    // ไปขั้น 2
    document.getElementById('regStep1').style.display = 'none';
    document.getElementById('regStep2').style.display = 'block';
    document.getElementById('otpPhoneDisplay').textContent = phone;
    document.getElementById('otpInput').value = '';
    document.getElementById('otpInput').focus();

    // Dev mode: แสดง OTP บนหน้าจอ
    if (data._dev_otp) {
      document.getElementById('otpDemoCode').textContent = data._dev_otp;
      document.getElementById('otpDemoHint').style.display = 'block';
    } else {
      document.getElementById('otpDemoHint').style.display = 'none';
    }

    startOtpCountdown();
    startResendCountdown();
  } catch (err) {
    errEl.textContent = err.message; errEl.style.display = 'block';
  } finally { btn.disabled = false; btn.textContent = '📱 ส่ง OTP ยืนยันเบอร์'; }
}

function startOtpCountdown() {
  clearInterval(_otpTimerInterval);
  let secs = 5 * 60;
  const el = document.getElementById('otpCountdown');
  _otpTimerInterval = setInterval(() => {
    secs--;
    const m = Math.floor(secs / 60), s = secs % 60;
    if (el) el.textContent = `${m}:${s.toString().padStart(2,'0')}`;
    if (secs <= 0) {
      clearInterval(_otpTimerInterval);
      const timerEl = document.getElementById('otpTimer');
      if (timerEl) timerEl.innerHTML = '⚠️ OTP หมดอายุแล้ว กรุณาขอใหม่';
    }
  }, 1000);
}

function startResendCountdown(wait = 60) {
  clearInterval(_resendInterval);
  const btn = document.getElementById('resendOtpBtn');
  const span = document.getElementById('resendCountdown');
  let secs = wait;
  btn.disabled = true;
  _resendInterval = setInterval(() => {
    secs--;
    if (span) span.textContent = secs;
    if (secs <= 0) {
      clearInterval(_resendInterval);
      btn.disabled = false;
      btn.textContent = 'ส่งรหัสใหม่';
    }
  }, 1000);
}

async function resendOtp() {
  const errEl = document.getElementById('registerError');
  errEl.style.display = 'none';
  const phone = document.getElementById('registerPhone').value.trim();
  try {
    const res  = await fetch('/api/user/otp/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    if (data._dev_otp) { document.getElementById('otpDemoCode').textContent = data._dev_otp; }
    startOtpCountdown();
    startResendCountdown();
    showToast('📩 ส่ง OTP ใหม่แล้ว');
  } catch (err) {
    errEl.textContent = err.message; errEl.style.display = 'block';
  }
}

function backToRegStep1() {
  clearInterval(_otpTimerInterval);
  clearInterval(_resendInterval);
  document.getElementById('regStep1').style.display = 'block';
  document.getElementById('regStep2').style.display = 'none';
  document.getElementById('registerError').style.display = 'none';
}

// ─── Phone Register — Step 2: ยืนยัน OTP และสมัคร ───────────────────────────
async function doPhoneRegister() {
  const errEl = document.getElementById('registerError');
  const btn   = document.getElementById('registerSubmitBtn');
  errEl.style.display = 'none';

  const otp = document.getElementById('otpInput').value.trim();
  if (!/^\d{6}$/.test(otp)) {
    errEl.textContent = 'กรุณากรอกรหัส OTP 6 หลัก'; errEl.style.display = 'block'; return;
  }

  btn.disabled = true; btn.textContent = 'กำลังยืนยัน...';
  try {
    const res = await fetch('/api/user/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name:     document.getElementById('registerName').value,
        phone:    document.getElementById('registerPhone').value.trim(),
        email:    document.getElementById('registerEmail').value,
        password: document.getElementById('registerPassword').value,
        otp
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    clearInterval(_otpTimerInterval);
    clearInterval(_resendInterval);
    setToken(data.token);
    await checkUserAuth();
    closeAuthModal();
    showToast(`🎉 สมัครสมาชิกสำเร็จ ยินดีต้อนรับ ${data.name}!`);
  } catch (err) {
    errEl.textContent = err.message; errEl.style.display = 'block';
  } finally { btn.disabled = false; btn.textContent = '✅ ยืนยันและสมัครสมาชิก'; }
}

// ─── Google Sign-In ───────────────────────────────────────────────────────────
function initGoogleSignIn(clientId) {
  if (!window.google || !clientId) return;
  google.accounts.id.initialize({
    client_id: clientId,
    callback: handleGoogleCallback,
    auto_select: false,        // ปิด One-Tap auto sign-in (ป้องกัน callback ยิงเองตอน page load)
    cancel_on_tap_outside: true,
    itp_support: true,
  });
  const btn = document.getElementById('googleSignInBtn');
  if (btn) {
    google.accounts.id.renderButton(btn, { theme: 'outline', size: 'large', width: btn.offsetWidth || 340, text: 'signin_with', shape: 'rectangular', logo_alignment: 'left' });
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
  if (sec === 'payment') { renderSavedCards(); renderPaymentHistory(); }
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

// ─── Saved Cards ──────────────────────────────────────────────────────────────
const BRAND_META = {
  Visa:       { icon: 'VISA',  cls: 'visa' },
  Mastercard: { icon: 'MC',    cls: 'mastercard' },
  Amex:       { icon: 'AMEX',  cls: 'amex' },
  JCB:        { icon: 'JCB',   cls: 'jcb' },
  Discover:   { icon: 'DISC',  cls: 'discover' },
  Other:      { icon: '💳',    cls: '' },
};

function detectBrand(numStr) {
  const n = numStr.replace(/\s/g, '');
  if (n.startsWith('4'))                    return 'Visa';
  if (/^(5[1-5]|2[2-7])/.test(n))         return 'Mastercard';
  if (/^3[47]/.test(n))                    return 'Amex';
  if (/^(6011|65|64[4-9])/.test(n))        return 'Discover';
  if (n.startsWith('35'))                   return 'JCB';
  return 'Other';
}

async function renderSavedCards() {
  const el = document.getElementById('savedCardsList');
  if (!el) return;
  el.innerHTML = '<div class="empty-state" style="padding:16px 0">กำลังโหลด...</div>';

  try {
    const token = localStorage.getItem('btUserToken');
    const res  = await fetch('/api/user/cards', { headers: { Authorization: `Bearer ${token}` } });
    const cards = await res.json();

    if (!cards.length) {
      el.innerHTML = '<div class="empty-state" style="padding:16px 0">ยังไม่มีบัตรที่บันทึกไว้<br><small>กด "+ เพิ่มบัตร" เพื่อเพิ่มบัตรครั้งแรก</small></div>';
      return;
    }

    el.innerHTML = cards.map(c => {
      const meta = BRAND_META[c.card_brand] || BRAND_META.Other;
      return `
      <div class="saved-card-item ${c.is_default ? 'sc-default' : ''}" id="sc-item-${c.id}">
        <div class="saved-card-chip ${meta.cls}">
          <div class="sc-top">
            <span class="sc-label-text">${c.label}</span>
            <span class="sc-brand-badge">${meta.icon}</span>
          </div>
          <div class="sc-number">•••• •••• •••• ${c.last_four}</div>
          <div class="sc-bottom">
            <div><div class="sc-sub">ผู้ถือบัตร</div><div class="sc-val">${c.holder_name}</div></div>
            <div style="text-align:right"><div class="sc-sub">หมดอายุ</div><div class="sc-val">${c.expiry}</div></div>
          </div>
          ${c.is_default ? '<div class="sc-default-badge">⭐ บัตรหลัก</div>' : ''}
        </div>
        <div class="sc-actions">
          ${!c.is_default ? `<button class="btn btn-ghost btn-sm" onclick="setDefaultCard(${c.id})">ตั้งเป็นหลัก</button>` : ''}
          <button class="btn btn-danger btn-sm" onclick="deleteCard(${c.id}, '${c.last_four}')">🗑 ลบ</button>
        </div>
      </div>`;
    }).join('');
  } catch {
    el.innerHTML = '<div class="empty-state" style="color:#c53030">โหลดข้อมูลไม่สำเร็จ</div>';
  }
}

async function deleteCard(id, last4) {
  if (!confirm(`ต้องการลบบัตรที่ลงท้ายด้วย ${last4}?`)) return;
  const token = localStorage.getItem('btUserToken');
  const res = await fetch(`/api/user/cards/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  if (res.ok) { showToast('🗑 ลบบัตรแล้ว'); renderSavedCards(); }
  else { const d = await res.json(); showToast(`❌ ${d.error}`); }
}

async function setDefaultCard(id) {
  const token = localStorage.getItem('btUserToken');
  const res = await fetch(`/api/user/cards/${id}/default`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}` } });
  if (res.ok) { showToast('⭐ ตั้งเป็นบัตรหลักแล้ว'); renderSavedCards(); }
  else { const d = await res.json(); showToast(`❌ ${d.error}`); }
}

function showAddCardForm(show) {
  const formEl = document.getElementById('addCardForm');
  if (!formEl) return;
  formEl.style.display = show ? 'block' : 'none';
  if (show) {
    ['scCardNumber','scCardName','scCardExpiry','scCardCVV','scCardLabel'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    const def = document.getElementById('scCardDefault');
    if (def) def.checked = false;
    updateSavedCardPreview();
    document.getElementById('scCardNumber')?.focus();
    formEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function formatSavedCardNumber(input) {
  let v = input.value.replace(/\D/g, '').slice(0, 16);
  input.value = v.replace(/(.{4})/g, '$1 ').trim();
  updateSavedCardPreview();
}

function formatSavedCardExpiry(input) {
  let v = input.value.replace(/\D/g, '').slice(0, 4);
  if (v.length >= 2) v = v.slice(0, 2) + '/' + v.slice(2);
  input.value = v;
  updateSavedCardPreview();
}

function updateSavedCardPreview() {
  const num  = document.getElementById('scCardNumber')?.value  || '';
  const name = document.getElementById('scCardName')?.value    || '';
  const exp  = document.getElementById('scCardExpiry')?.value  || '';
  const brand = detectBrand(num);
  const meta  = BRAND_META[brand] || BRAND_META.Other;

  const numEl   = document.getElementById('savedPreviewNum');
  const nameEl  = document.getElementById('savedPreviewName');
  const expEl   = document.getElementById('savedPreviewExp');
  const brandEl = document.getElementById('savedPreviewBrand');
  const cardEl  = document.getElementById('savedCardPreview');

  if (numEl)   numEl.textContent   = num  || '•••• •••• •••• ••••';
  if (nameEl)  nameEl.textContent  = name || 'ชื่อบนบัตร';
  if (expEl)   expEl.textContent   = exp  || 'MM/YY';
  if (brandEl) brandEl.textContent = meta.icon;
  if (cardEl)  cardEl.className    = `card-preview-mini${meta.cls ? ' ' + meta.cls : ''}`;
}

async function saveNewCard(e) {
  e.preventDefault();
  const btn = document.getElementById('saveCardBtn');
  btn.disabled = true; btn.textContent = 'กำลังบันทึก...';

  try {
    const numRaw = document.getElementById('scCardNumber').value.replace(/\s/g, '');
    const expiry = document.getElementById('scCardExpiry').value.trim();
    const holder = document.getElementById('scCardName').value.trim();
    const label  = document.getElementById('scCardLabel').value.trim() || 'บัตรของฉัน';
    const isDefault = document.getElementById('scCardDefault')?.checked || false;

    if (numRaw.length < 13) throw new Error('หมายเลขบัตรไม่ถูกต้อง (ต้องมี 13–16 หลัก)');
    if (!/^\d{2}\/\d{2}$/.test(expiry)) throw new Error('วันหมดอายุไม่ถูกต้อง (MM/YY)');

    const last_four  = numRaw.slice(-4);
    const card_brand = detectBrand(numRaw);
    let   card_token = '';

    // Omise tokenization (production)
    if (window.appConfig?.hasOmise && window.Omise) {
      const [month, year] = expiry.split('/');
      card_token = await new Promise((resolve, reject) => {
        Omise.setPublicKey(window.appConfig.omisePublicKey);
        Omise.createToken('card', {
          name: holder, number: numRaw,
          expiration_month: parseInt(month),
          expiration_year: parseInt('20' + year),
          security_code: document.getElementById('scCardCVV').value,
        }, (code, resp) => code === 200 ? resolve(resp.id) : reject(new Error(resp.message)));
      });
    }

    const token = localStorage.getItem('btUserToken');
    const res = await fetch('/api/user/cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ last_four, card_brand, expiry, holder_name: holder, label, card_token, is_default: isDefault })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    showAddCardForm(false);
    await renderSavedCards();
    showToast(`💳 บันทึกบัตร ${card_brand} •••• ${last_four} สำเร็จ`);
  } catch (err) {
    showToast(`❌ ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = '💾 บันทึกบัตร';
  }
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
