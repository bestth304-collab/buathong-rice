// ─── PromptPay QR Generator (EMVCo Standard) ──────────────────────────────────
function crc16(str) {
  let crc = 0xFFFF;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
  }
  return crc;
}

function tlv(tag, value) {
  const v = String(value);
  return String(tag).padStart(2, '0') + String(v.length).padStart(2, '0') + v;
}

function buildPromptPayPayload(promptpayId, amount) {
  let id = promptpayId.replace(/[^0-9]/g, '');
  // Phone: 0XXXXXXXXX (10 digits) → 00660XXXXXXXXX... wait: 0066 + 9 digits
  // e.g. 0812345678 → remove leading 0 → 812345678 → prepend 0066 → 0066812345678 (13 chars)
  if (id.length === 10 && id.startsWith('0')) {
    id = '0066' + id.slice(1); // 13 chars total
  }
  // National ID / Tax ID (13 digits) → use as-is

  const guid = 'A000000677010111';
  const accountInfo = tlv('00', guid) + tlv('01', id);

  let payload =
    tlv('00', '01') +                        // payload format indicator
    tlv('01', amount ? '12' : '11') +        // 12=dynamic, 11=static
    tlv('29', accountInfo) +                 // merchant account info
    tlv('52', '0000') +                      // merchant category
    tlv('53', '764') +                       // THB currency
    (amount ? tlv('54', parseFloat(amount).toFixed(2)) : '') +
    tlv('58', 'TH') +                        // country
    tlv('59', 'BUATHONG RICE') +             // merchant name
    tlv('60', 'BANGKOK') +                   // city
    '6304';                                  // CRC placeholder

  const checksum = crc16(payload).toString(16).toUpperCase().padStart(4, '0');
  return payload + checksum;
}

// ─── Payment State ────────────────────────────────────────────────────────────
let currentOrderId = null;
let currentOrderTotal = 0;
let qrCodeInstance = null;

function openPaymentModal(orderId, total, orderNumber) {
  currentOrderId = orderId;
  currentOrderTotal = total;
  document.getElementById('payOrderNum').textContent = orderNumber || '';
  document.getElementById('payTotalAmt').textContent = `฿${total.toLocaleString()}`;
  document.getElementById('paymentModal').classList.add('open');
  switchPayTab('promptpay');
}

function closePaymentModal() {
  document.getElementById('paymentModal').classList.remove('open');
}

function switchPayTab(tab) {
  ['promptpay', 'card'].forEach(t => {
    document.getElementById(`paytab-${t}`).classList.toggle('active', t === tab);
    document.getElementById(`paypanel-${t}`).style.display = t === tab ? 'block' : 'none';
  });
  if (tab === 'promptpay') renderPromptPayQR();
}

// ─── PromptPay Panel ──────────────────────────────────────────────────────────
async function renderPromptPayQR() {
  const canvas = document.getElementById('promptpayCanvas');
  const amountEl = document.getElementById('ppAmount');
  const idEl = document.getElementById('ppId');
  amountEl.textContent = `฿${currentOrderTotal.toLocaleString()}`;

  const promptpayId = appConfig?.promptpayId || '0812345678';
  // Display masked ID
  if (promptpayId.length === 10) {
    idEl.textContent = promptpayId.slice(0, 3) + '-xxx-' + promptpayId.slice(6);
  } else {
    idEl.textContent = promptpayId.slice(0, 3) + 'XXXXXXXXXX';
  }

  const payload = buildPromptPayPayload(promptpayId, currentOrderTotal);

  try {
    await QRCode.toCanvas(canvas, payload, {
      width: 240, margin: 2,
      color: { dark: '#1a3a1a', light: '#ffffff' }
    });
  } catch (err) {
    canvas.getContext('2d').fillText('QR Error', 10, 20);
    console.error(err);
  }
}

async function confirmPromptPay() {
  const btn = document.getElementById('confirmPromptPayBtn');
  btn.disabled = true; btn.textContent = 'กำลังยืนยัน...';
  try {
    await fetch(`/api/orders/${currentOrderId}/payment`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) },
      body: JSON.stringify({ payment_method: 'promptpay', payment_status: 'paid' })
    });
    closePaymentModal();
    showPaymentSuccess('promptpay');
    if (typeof checkUserAuth === 'function') await checkUserAuth();
  } finally { btn.disabled = false; btn.textContent = '✅ ยืนยันการชำระเงิน'; }
}

// ─── Credit Card Panel ────────────────────────────────────────────────────────
function formatCardNumber(input) {
  let v = input.value.replace(/\D/g, '').slice(0, 16);
  input.value = v.replace(/(.{4})/g, '$1 ').trim();
  updateCardPreview();
}

function formatExpiry(input) {
  let v = input.value.replace(/\D/g, '').slice(0, 4);
  if (v.length >= 2) v = v.slice(0, 2) + '/' + v.slice(2);
  input.value = v;
  updateCardPreview();
}

function updateCardPreview() {
  const num = document.getElementById('cardNumber').value || '•••• •••• •••• ••••';
  const name = document.getElementById('cardName').value || 'ชื่อบนบัตร';
  const exp = document.getElementById('cardExpiry').value || 'MM/YY';
  document.getElementById('previewNum').textContent = num || '•••• •••• •••• ••••';
  document.getElementById('previewName').textContent = name;
  document.getElementById('previewExp').textContent = exp;

  // Card type detection
  const raw = num.replace(/\s/g, '');
  const cardEl = document.getElementById('cardPreview');
  if (raw.startsWith('4')) cardEl.className = 'card-preview visa';
  else if (raw.startsWith('5') || raw.startsWith('2')) cardEl.className = 'card-preview mastercard';
  else if (raw.startsWith('3')) cardEl.className = 'card-preview amex';
  else cardEl.className = 'card-preview';
}

async function submitCard(e) {
  e.preventDefault();
  const btn = document.getElementById('cardSubmitBtn');

  if (appConfig?.hasOmise && window.Omise) {
    // Real Omise payment
    btn.disabled = true; btn.textContent = 'กำลังประมวลผล...';
    Omise.setPublicKey(appConfig.omisePublicKey);
    const [month, year] = document.getElementById('cardExpiry').value.split('/');
    Omise.createToken('card', {
      name: document.getElementById('cardName').value,
      number: document.getElementById('cardNumber').value.replace(/\s/g, ''),
      expiration_month: parseInt(month),
      expiration_year: parseInt('20' + year),
      security_code: document.getElementById('cardCVV').value,
    }, async (statusCode, response) => {
      if (statusCode !== 200) {
        showToast(`❌ ${response.message}`);
        btn.disabled = false; btn.textContent = 'ชำระเงิน';
        return;
      }
      // Send token to server (would charge via Omise API)
      await fetch(`/api/orders/${currentOrderId}/payment`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) },
        body: JSON.stringify({ payment_method: 'card', payment_status: 'paid' })
      });
      closePaymentModal();
      showPaymentSuccess('card');
      btn.disabled = false; btn.textContent = 'ชำระเงิน';
    });
  } else {
    // Demo mode
    btn.disabled = true; btn.textContent = 'กำลังประมวลผล...';
    await new Promise(r => setTimeout(r, 1500));
    await fetch(`/api/orders/${currentOrderId}/payment`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) },
      body: JSON.stringify({ payment_method: 'card', payment_status: 'paid' })
    });
    closePaymentModal();
    showPaymentSuccess('card');
    btn.disabled = false; btn.textContent = 'ชำระเงิน';
  }
}

// ─── Payment Success ──────────────────────────────────────────────────────────
function showPaymentSuccess(method) {
  const icon = method === 'promptpay' ? '📱' : '💳';
  const methodName = method === 'promptpay' ? 'พร้อมเพย์' : 'บัตรเครดิต';
  document.getElementById('paySuccessIcon').textContent = icon;
  document.getElementById('paySuccessMethod').textContent = methodName;
  document.getElementById('paySuccessModal').classList.add('open');
  if (typeof checkUserAuth === 'function') checkUserAuth();
}

function closePaySuccessModal() {
  document.getElementById('paySuccessModal').classList.remove('open');
  cart = []; saveCart(); renderCart();
  if (typeof loadProducts === 'function') loadProducts();
}

// helper: get token from auth.js
function getToken() { return localStorage.getItem('btUserToken'); }

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('paymentModal')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) closePaymentModal();
  });
  document.getElementById('paySuccessModal')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) closePaySuccessModal();
  });
});
