const API = window.location.origin;
const TOKEN_KEY = 'confortdz_admin_token';

const state = { token: localStorage.getItem(TOKEN_KEY) || '', metrics: null, orders: [], statuses: [], selectedOrderId: null };

const $ = (id) => document.getElementById(id);

function money(v) { return `${Number(v || 0).toLocaleString('fr-DZ')} دج`; }
function pct(v) { return `${Number(v || 0).toFixed(2)}%`; }
function fmtDate(v) {
  if (!v) return '—';
  return new Date(v).toLocaleString('ar-DZ', { timeZone: 'Africa/Algiers' });
}

function statusClass(status) {
  const s = String(status || '').toLowerCase();
  if (s.includes('pending') || s.includes('انتظار')) return 'pending';
  if (s.includes('confirm') || s.includes('مؤك')) return 'confirmed';
  if (s.includes('ship') || s.includes('شحن')) return 'shipped';
  if (s.includes('deliver') || s.includes('تسل')) return 'delivered';
  return 'returned';
}

function setRangeDays(days) {
  const end = new Date();
  const start = new Date();
  if (days === 0) start.setHours(0, 0, 0, 0);
  else start.setDate(end.getDate() - (days - 1));
  $('dateFrom').value = start.toISOString().slice(0, 10);
  $('dateTo').value = end.toISOString().slice(0, 10);
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(`${API}${path}`, { ...options, headers });
  if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || 'Request failed');
  }
  return res.json();
}

function showLogin() { $('loginView').classList.remove('hidden'); $('appView').classList.add('hidden'); }
function showApp() { $('loginView').classList.add('hidden'); $('appView').classList.remove('hidden'); }
function logout() { state.token = ''; localStorage.removeItem(TOKEN_KEY); showLogin(); }

async function login(username, password) {
  const data = await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ username, password }) });
  state.token = data.access_token;
  localStorage.setItem(TOKEN_KEY, state.token);
  showApp();
  await bootstrap();
}

function queryRange() {
  return `from=${$('dateFrom').value}&to=${$('dateTo').value}`;
}

async function loadStatuses() {
  state.statuses = await api('/api/admin/statuses');
  $('orderStatus').innerHTML = '<option value="">All statuses</option>' +
    state.statuses.map((s) => `<option value="${s}">${s}</option>`).join('');
  $('modalStatus').innerHTML = state.statuses.map((s) => `<option value="${s}">${s}</option>`).join('');
}

async function loadMetrics() {
  state.metrics = await api(`/api/admin/metrics?${queryRange()}`);
  renderOverview();
}

async function loadOrders() {
  const params = new URLSearchParams({ from: $('dateFrom').value, to: $('dateTo').value });
  if ($('orderSearch').value.trim()) params.set('search', $('orderSearch').value.trim());
  if ($('orderStatus').value) params.set('status', $('orderStatus').value);
  state.orders = await api(`/api/admin/orders?${params.toString()}`);
  renderOrders();
}

function renderOverview() {
  const m = state.metrics;
  if (!m) return;
  const acc = m.accounting || {};

  $('mDeliveredRevenue').textContent = money(acc.revenue_delivered || 0);
  $('mNetProfit').textContent = `Net profit ${money(acc.net_profit || 0)}`;
  $('mAdSpend').textContent = money(acc.ad_spend_total || 0);
  $('mRoas').textContent = acc.roas || 0;

  const cards = [
    ['Confirmed Orders', acc.orders_confirmed || 0],
    ['Confirmation Rate', pct(acc.confirmation_rate)],
    ['Delivery Rate', pct(acc.delivery_rate)],
    ['Conversion Rate', pct(m.conversion_rate)],
    ['Checkout CVR', pct(m.checkout_cvr)],
    ['Page Views', m.page_views || 0],
    ['Clicks', m.clicks || 0],
    ['AOV', money(m.avg_order_value)],
    ['Delivered Orders', acc.orders_delivered || 0],
    ['Gross Profit', money(acc.gross_profit || 0)],
    ['Product Cost', money(acc.product_cost || 0)],
    ['Total Orders', acc.orders_total || 0],
  ];

  $('metricsGrid').innerHTML = cards.map(([label, value]) => `
    <div class="metric-card"><span>${label}</span><strong>${value}</strong></div>
  `).join('');

  const maxRev = Math.max(...(m.daily || []).map((d) => d.revenue || 0), 1);
  $('dailyChart').innerHTML = (m.daily || []).map((d) => `
    <div class="bar-row">
      <span>${d.date.slice(5)}</span>
      <div class="bar-track"><div class="bar-fill green" style="width:${((d.revenue || 0) / maxRev) * 100}%"></div></div>
      <span>${money(d.revenue)}</span>
    </div>
  `).join('') || '<p class="muted">No data</p>';

  const channels = m.by_channel || [];
  const maxCh = Math.max(...channels.map((c) => c.revenue || 0), 1);
  $('channelChart').innerHTML = channels.map((c) => `
    <div class="bar-row">
      <span>${c.channel}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${((c.revenue || 0) / maxCh) * 100}%"></div></div>
      <span>${money(c.revenue)}</span>
    </div>
  `).join('') || '<p class="muted">No channel data</p>';

  $('productsTableBody').innerHTML = (m.by_product || []).map((p) => `
    <tr><td>${p.product_name}</td><td>${p.clicks || 0}</td><td>${p.orders}</td><td>${money(p.revenue)}</td></tr>
  `).join('') || '<tr><td colspan="4">No products</td></tr>';

  $('pnlTableBody').innerHTML = (m.daily_pnl || []).map((row) => `
    <tr>
      <td>${row.date}</td><td>${row.orders}</td><td>${money(row.revenue_delivered)}</td>
      <td>${money(row.ad_spend)}</td><td>${money(row.product_cost)}</td>
      <td><strong>${money(row.net_profit)}</strong></td>
    </tr>
  `).join('') || '<tr><td colspan="6">No P&amp;L data</td></tr>';

  renderAccounting();
}

function renderAccounting() {
  const m = state.metrics;
  const acc = m?.accounting || {};
  $('accountingSummary').innerHTML = [
    ['Delivered revenue', money(acc.revenue_delivered)],
    ['Confirmed revenue', money(acc.revenue_confirmed)],
    ['Product cost (COGS)', money(acc.product_cost)],
    ['Gross profit', money(acc.gross_profit)],
    ['Ad spend', money(acc.ad_spend_total)],
    ['Net profit', money(acc.net_profit)],
    ['Confirmation rate', pct(acc.confirmation_rate)],
    ['Delivery rate', pct(acc.delivery_rate)],
    ['ROAS', acc.roas || 0],
  ].map(([k, v]) => `<div class="summary-row"><span>${k}</span><strong>${v}</strong></div>`).join('');

  $('adSpendTableBody').innerHTML = (m?.ad_spend_entries || []).map((row) => `
    <tr>
      <td>${row.spend_date}</td><td>${row.platform}</td><td>${money(row.amount_dzd)}</td>
      <td>${row.notes || '—'}</td>
      <td><button class="btn btn-soft" data-delete-ad="${row.id}">Delete</button></td>
    </tr>
  `).join('') || '<tr><td colspan="5">No ad spend yet — add from form above</td></tr>';

  $('adSpendTableBody').querySelectorAll('[data-delete-ad]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/admin/ad-spend/${btn.dataset.deleteAd}`, { method: 'DELETE' });
      await loadMetrics();
    });
  });
}

function renderOrders() {
  $('ordersTableBody').innerHTML = state.orders.map((o) => `
    <tr>
      <td><strong>${o.order_id}</strong></td>
      <td>${o.customer_name}<div class="muted small">${o.phone}</div></td>
      <td>${o.product_name}</td><td>${o.wilaya}</td><td>${money(o.total_price)}</td>
      <td><span class="status ${statusClass(o.status)}">${o.status}</span></td>
      <td>${fmtDate(o.created_at)}</td>
      <td><button class="btn btn-soft" data-order-id="${o.order_id}">View</button></td>
    </tr>
  `).join('') || '<tr><td colspan="8">No orders</td></tr>';

  $('ordersTableBody').querySelectorAll('[data-order-id]').forEach((btn) => {
    btn.addEventListener('click', () => openOrder(btn.dataset.orderId));
  });
}

async function openOrder(orderId) {
  state.selectedOrderId = orderId;
  const o = await api(`/api/admin/orders/${orderId}`);
  $('modalTitle').textContent = o.order_id;
  $('modalSubtitle').textContent = `${fmtDate(o.created_at)} • ${o.wilaya}`;
  $('modalStatus').value = o.status;
  $('orderPreview').innerHTML = `
    <div class="preview-grid">
      <div class="preview-item"><span>Customer</span><strong>${o.customer_name}</strong></div>
      <div class="preview-item"><span>Phone</span><strong dir="ltr">${o.phone}</strong></div>
      <div class="preview-item"><span>Wilaya / Commune</span><strong>${o.wilaya}<br>${o.commune}</strong></div>
      <div class="preview-item"><span>Product</span><strong>${o.product_name} x${o.quantity}</strong></div>
      <div class="preview-item"><span>Total</span><strong>${money(o.total_price)}</strong></div>
      <div class="preview-item"><span>Source</span><strong>${o.utm_source || 'direct'}</strong></div>
      <div class="preview-item"><span>IP / City</span><strong>${o.ip_address || '—'}<br>${o.city || '—'}</strong></div>
      <div class="preview-item"><span>Status</span><strong>${o.status}</strong></div>
    </div>
  `;
  $('orderModal').classList.remove('hidden');
}

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('active', el.dataset.tab === tab));
  $('tab-overview').classList.toggle('hidden', tab !== 'overview');
  $('tab-orders').classList.toggle('hidden', tab !== 'orders');
  $('tab-accounting').classList.toggle('hidden', tab !== 'accounting');
  const titles = { overview: 'Overview', orders: 'Orders', accounting: 'Comptabilité' };
  $('pageTitle').textContent = titles[tab] || 'Admin';
}

async function bootstrap() {
  setRangeDays(7);
  $('adDate').value = new Date().toISOString().slice(0, 10);
  await loadStatuses();
  await Promise.all([loadMetrics(), loadOrders()]);
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginError').classList.add('hidden');
  try {
    await login($('username').value.trim(), $('password').value);
  } catch (err) {
    $('loginError').textContent = err.message;
    $('loginError').classList.remove('hidden');
  }
});

$('logoutBtn').addEventListener('click', logout);
$('applyFilters').addEventListener('click', () => Promise.all([loadMetrics(), loadOrders()]));
document.querySelectorAll('.preset').forEach((btn) => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('.preset').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    setRangeDays(btn.dataset.range === 'today' ? 0 : Number(btn.dataset.range));
    await Promise.all([loadMetrics(), loadOrders()]);
  });
});
document.querySelectorAll('.tab').forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
$('reloadOrders').addEventListener('click', loadOrders);
$('orderSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadOrders(); });
$('orderStatus').addEventListener('change', loadOrders);
$('closeModal').addEventListener('click', () => $('orderModal').classList.add('hidden'));
$('saveStatusBtn').addEventListener('click', async () => {
  await api(`/api/admin/orders/${state.selectedOrderId}`, {
    method: 'PATCH', body: JSON.stringify({ status: $('modalStatus').value }),
  });
  $('orderModal').classList.add('hidden');
  await Promise.all([loadOrders(), loadMetrics()]);
});

$('adSpendForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('/api/admin/ad-spend', {
    method: 'POST',
    body: JSON.stringify({
      spend_date: $('adDate').value,
      platform: $('adPlatform').value,
      amount_dzd: Number($('adAmount').value),
      notes: $('adNotes').value.trim() || null,
    }),
  });
  $('adAmount').value = '';
  $('adNotes').value = '';
  await loadMetrics();
});

if (state.token) { showApp(); bootstrap().catch(logout); }
else showLogin();
