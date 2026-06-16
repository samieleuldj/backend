const API = window.location.origin;
const TOKEN_KEY = 'confortdz_admin_token';

const state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  metrics: null,
  orders: [],
  statuses: [],
  products: [],
  selectedOrderId: null,
  currentTab: 'overview',
  loading: false,
  orderAlerts: {
    enabled: localStorage.getItem('confortdz_order_alerts') !== 'off',
    lastOrderDbId: Number(localStorage.getItem('confortdz_last_order_id') || 0),
    initialized: false,
    pollTimer: null,
    audioReady: false,
  },
};

const $ = (id) => document.getElementById(id);

function money(v) { return `${Number(v || 0).toLocaleString('fr-DZ')} دج`; }
function pct(v) { return `${Number(v || 0).toFixed(2)}%`; }
function fmtDate(v) {
  if (!v) return '—';
  return new Date(v).toLocaleString('ar-DZ', { timeZone: 'Africa/Algiers' });
}

function statusClass(status) {
  const s = String(status || '').trim();
  const lower = s.toLowerCase();
  if (lower.includes('deliver') || s.includes('تسليم') || s.includes('Livré')) return 'delivered';
  if (lower.includes('return') || s.includes('مرتج') || lower.includes('cancel') || s.includes('ملغ')) return 'returned';
  if (lower.includes('ship') || s.includes('شحن') || lower.includes('expédi')) return 'shipped';
  if (lower.includes('confirm') || s.includes('مؤك')) return 'confirmed';
  if (lower.includes('pending') || s.includes('انتظار')) return 'pending';
  return 'pending';
}

function setLoading(on) {
  state.loading = on;
  const el = $('globalLoading');
  if (el) el.classList.toggle('hidden', !on);
}

function showError(msg) {
  const el = $('globalError');
  if (!el) return;
  if (!msg) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  el.textContent = msg;
  el.classList.remove('hidden');
}

const ALGIERS_TZ = 'Africa/Algiers';

function formatAlgiersDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ALGIERS_TZ }).format(date);
}

function shiftIsoDate(isoDate, days) {
  const [year, month, day] = isoDate.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

function setRangeDays(days) {
  const today = formatAlgiersDate(new Date());
  if (days === 0) {
    $('dateFrom').value = today;
    $('dateTo').value = today;
    return;
  }
  $('dateFrom').value = shiftIsoDate(today, -(days - 1));
  $('dateTo').value = today;
}

function getSelectedRangeLabel() {
  const from = $('dateFrom')?.value;
  const to = $('dateTo')?.value;
  if (!from || !to) return '';
  if (from === to) return `اليوم (${from}) — Algeria`;
  return `${from} → ${to}`;
}

function updateRangeUi() {
  const label = getSelectedRangeLabel();
  const ordersLabel = $('ordersRangeLabel');
  if (ordersLabel) ordersLabel.textContent = label;
  if (state.currentTab === 'orders' && $('pageSubtitle')) {
    $('pageSubtitle').textContent = label
      ? `الفترة: ${label} — الطلبيات والإحصائيات حسب توقيت الجزائر`
      : 'الطلبيات والإحصائيات حسب توقيت الجزائر';
  }
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(`${API}${path}`, { ...options, headers });
  if (res.status === 401) {
    logout();
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed (${res.status})`);
  }
  return res.json();
}

function showLogin() {
  $('loginView').classList.remove('hidden');
  $('appView').classList.add('hidden');
}

function showApp() {
  $('loginView').classList.add('hidden');
  $('appView').classList.remove('hidden');
}

function logout() {
  stopOrderAlertPolling();
  state.token = '';
  localStorage.removeItem(TOKEN_KEY);
  showLogin();
}

function unlockOrderAudio() {
  if (state.orderAlerts.audioReady) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.01);
    state.orderAlerts.audioReady = true;
    ctx.close().catch(() => {});
  } catch (err) {
    // Ignore — browser may block until user gesture.
  }
}

function playSaleSound() {
  if (!state.orderAlerts.enabled) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const start = ctx.currentTime;
    const notes = [
      { freq: 880, at: 0, dur: 0.12, vol: 0.22 },
      { freq: 1175, at: 0.1, dur: 0.14, vol: 0.24 },
      { freq: 1568, at: 0.22, dur: 0.28, vol: 0.28 },
    ];

    notes.forEach((note) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = note.freq;
      const t = start + note.at;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(note.vol, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + note.dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + note.dur + 0.02);
    });

    setTimeout(() => ctx.close().catch(() => {}), 700);
  } catch (err) {
    // Ignore audio failures.
  }
}

async function requestOrderNotifications() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') return;
  if (Notification.permission === 'denied') return;
  try {
    await Notification.requestPermission();
  } catch (err) {
    // Ignore.
  }
}

function showOrderToast(order) {
  const stack = $('orderToastStack');
  if (!stack) return;

  const toast = document.createElement('div');
  toast.className = 'order-toast';
  toast.innerHTML = `
    <strong>💰 طلبية جديدة!</strong>
    <span>${order.customer_name} — ${order.product_name || 'منتج'}</span>
    <span>${order.wilaya || ''}</span>
    <div class="amount">${money(order.total_price)}</div>
  `;

  toast.addEventListener('click', async () => {
    toast.remove();
    switchTab('orders');
    try {
      await openOrder(order.order_id);
    } catch (err) {
      showError(err.message);
    }
  });

  stack.prepend(toast);
  setTimeout(() => toast.remove(), 12000);
}

function notifyNewOrder(order) {
  playSaleSound();
  showOrderToast(order);

  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification('طلبية جديدة — Confort DZ', {
        body: `${order.customer_name} — ${money(order.total_price)}`,
        tag: `order-${order.order_id}`,
      });
    } catch (err) {
      // Ignore.
    }
  }
}

function updateOrderAlertUi() {
  const btn = $('orderAlertToggle');
  const live = $('livePulse');
  if (btn) {
    btn.classList.toggle('active', state.orderAlerts.enabled);
    btn.textContent = state.orderAlerts.enabled ? '🔔 صوت ON' : '🔕 صوت OFF';
  }
  if (live) {
    live.classList.toggle('hidden', !state.token || !state.orderAlerts.enabled);
  }
}

async function pollLatestOrder() {
  if (!state.token || !state.orderAlerts.enabled) return;

  try {
    const data = await api('/api/admin/orders/latest');
    const order = data.order;
    if (!order) return;

    if (!state.orderAlerts.initialized) {
      state.orderAlerts.initialized = true;
      state.orderAlerts.lastOrderDbId = order.id;
      localStorage.setItem('confortdz_last_order_id', String(order.id));
      return;
    }

    if (order.id > state.orderAlerts.lastOrderDbId) {
      state.orderAlerts.lastOrderDbId = order.id;
      localStorage.setItem('confortdz_last_order_id', String(order.id));
      notifyNewOrder(order);
      if (state.currentTab === 'orders') await loadOrders();
      if (state.metrics) await loadMetrics();
    }
  } catch (err) {
    // Silent poll failures — dashboard refresh still works.
  }
}

function startOrderAlertPolling() {
  stopOrderAlertPolling();
  if (!state.orderAlerts.enabled) {
    updateOrderAlertUi();
    return;
  }

  updateOrderAlertUi();
  pollLatestOrder();
  state.orderAlerts.pollTimer = window.setInterval(pollLatestOrder, 12000);
}

function stopOrderAlertPolling() {
  if (state.orderAlerts.pollTimer) {
    clearInterval(state.orderAlerts.pollTimer);
    state.orderAlerts.pollTimer = null;
  }
  state.orderAlerts.initialized = false;
  updateOrderAlertUi();
}

function toggleOrderAlerts() {
  state.orderAlerts.enabled = !state.orderAlerts.enabled;
  localStorage.setItem('confortdz_order_alerts', state.orderAlerts.enabled ? 'on' : 'off');
  if (state.orderAlerts.enabled) {
    unlockOrderAudio();
    requestOrderNotifications();
    startOrderAlertPolling();
  } else {
    stopOrderAlertPolling();
  }
  updateOrderAlertUi();
}

async function login(username, password) {
  const data = await api('/api/admin/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  state.token = data.access_token;
  localStorage.setItem(TOKEN_KEY, state.token);
  unlockOrderAudio();
  await requestOrderNotifications();
  showApp();
  await bootstrap();
  startOrderAlertPolling();
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
  renderProductPerformance();
  renderAccounting();
  updateRangeUi();
}

async function loadProducts() {
  state.products = await api('/api/admin/products');
  renderProductCosts();
}

async function loadOrders() {
  const from = $('dateFrom').value;
  const to = $('dateTo').value;
  if (!from || !to) {
    showError('اختر تاريخ البداية والنهاية');
    return;
  }

  const params = new URLSearchParams({ from, to });
  if ($('orderSearch').value.trim()) params.set('search', $('orderSearch').value.trim());
  if ($('orderStatus').value) params.set('status', $('orderStatus').value);
  state.orders = await api(`/api/admin/orders?${params.toString()}`);
  renderOrders();
  updateRangeUi();
}

function renderOverview() {
  const m = state.metrics;
  if (!m) return;
  const acc = m.accounting || {};

  $('mDeliveredRevenue').textContent = money(acc.revenue_delivered || 0);
  $('mNetProfit').textContent = `Net profit ${money(acc.net_profit || 0)}`;
  $('mAdSpend').textContent = money(acc.ad_spend_total || 0);
  $('mRoas').textContent = acc.roas || 0;
  if ($('mLoss')) $('mLoss').textContent = money(acc.loss || 0);

  const filterNote = m.strict_ip_filter ? 'VPN filter ON' : 'All visitors counted';
  if ($('pageSubtitle')) {
    $('pageSubtitle').textContent = `${filterNote} — Sheet + DHD sync for confirmation/delivery.`;
  }

  const cards = [
    ['Total Orders', acc.orders_total || 0],
    ['Confirmation Rate', pct(acc.confirmation_rate)],
    ['Delivery Rate', pct(acc.delivery_rate)],
    ['Conversion Rate', pct(m.conversion_rate)],
    ['Checkout CVR', pct(m.checkout_cvr)],
    ['Unique Visitors', m.unique_visitors || 0],
    ['Page Views', m.page_views || 0],
    ['Product Views', m.product_views || 0],
    ['Pending', acc.orders_pending || 0],
    ['Confirmed+', acc.orders_confirmed || 0],
    ['Shipped', acc.orders_shipped || 0],
    ['Delivered', acc.orders_delivered || 0],
    ['Cancelled', acc.orders_cancelled || 0],
    ['AOV', money(m.avg_order_value)],
    ['Gross Profit', money(acc.gross_profit || 0)],
  ];

  $('metricsGrid').innerHTML = cards.map(([label, value]) => `
    <div class="metric-card"><span>${label}</span><strong>${value}</strong></div>
  `).join('');

  const daily = m.daily || [];
  const maxRev = Math.max(...daily.map((d) => d.revenue || 0), 1);
  $('dailyChart').innerHTML = daily.map((d) => `
    <div class="bar-row">
      <span>${d.date.slice(5)}</span>
      <div class="bar-track"><div class="bar-fill green" style="width:${((d.revenue || 0) / maxRev) * 100}%"></div></div>
      <span>${money(d.revenue)}</span>
    </div>
  `).join('') || '<p class="muted">No data yet</p>';

  const channels = m.by_channel || [];
  const maxCh = Math.max(...channels.map((c) => c.revenue || 0), 1);
  $('channelChart').innerHTML = channels.map((c) => `
    <div class="bar-row">
      <span>${c.channel}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${((c.revenue || 0) / maxCh) * 100}%"></div></div>
      <span>${money(c.revenue)}</span>
    </div>
  `).join('') || '<p class="muted">No channel data</p>';

  $('pnlTableBody').innerHTML = (m.daily_pnl || []).map((row) => `
    <tr>
      <td>${row.date}</td>
      <td>${row.orders}</td>
      <td>${money(row.revenue_delivered)}</td>
      <td>${money(row.ad_spend)}</td>
      <td>${money(row.product_cost)}</td>
      <td><strong>${money(row.net_profit)}</strong></td>
      <td>${money(row.loss || 0)}</td>
    </tr>
  `).join('') || '<tr><td colspan="7">No P&amp;L data</td></tr>';
}

function renderProductPerformance() {
  const rows = state.metrics?.product_performance || [];
  $('productPerfBody').innerHTML = rows.map((p) => `
    <tr>
      <td><strong>${p.product_name}</strong></td>
      <td>${p.product_views || 0}</td>
      <td>${p.orders || 0}</td>
      <td>${pct(p.conversion_rate)}</td>
      <td>${pct(p.confirmation_rate)}</td>
      <td>${pct(p.delivery_rate)}</td>
      <td>${money(p.delivered_revenue)}</td>
      <td>${money(p.ad_spend)}</td>
      <td>${money(p.product_cost)}</td>
      <td><strong>${money(p.net_profit)}</strong></td>
      <td>${money(p.loss || 0)}</td>
    </tr>
  `).join('') || '<tr><td colspan="11">No product data yet — need orders + page views</td></tr>';
}

function renderAccounting() {
  const m = state.metrics;
  const acc = m?.accounting || {};
  $('accountingSummary').innerHTML = [
    ['Delivered revenue', money(acc.revenue_delivered)],
    ['Confirmed revenue', money(acc.revenue_confirmed)],
    ['Product cost', money(acc.product_cost)],
    ['Gross profit', money(acc.gross_profit)],
    ['Ad spend', money(acc.ad_spend_total)],
    ['Net profit', money(acc.net_profit)],
    ['Loss', money(acc.loss || 0)],
    ['Confirmation rate', pct(acc.confirmation_rate)],
    ['Delivery rate', pct(acc.delivery_rate)],
    ['ROAS', acc.roas || 0],
  ].map(([k, v]) => `<div class="summary-row"><span>${k}</span><strong>${v}</strong></div>`).join('');

  $('adSpendTableBody').innerHTML = (m?.ad_spend_entries || []).map((row) => `
    <tr>
      <td>${row.spend_date}</td>
      <td>${row.platform}</td>
      <td>${money(row.amount_dzd)}</td>
      <td>${row.source || 'manual'}</td>
      <td>${row.notes || '—'}</td>
      <td>${row.source === 'auto' ? '—' : `<button type="button" class="btn btn-soft" data-delete-ad="${row.id}">Delete</button>`}</td>
    </tr>
  `).join('') || '<tr><td colspan="6">No ad spend entries</td></tr>';
}

function renderProductCosts() {
  $('productCostsBody').innerHTML = state.products.map((p) => `
    <tr>
      <td><strong>${p.product_name}</strong><div class="muted small">${p.product_id}</div></td>
      <td><input type="number" min="0" step="1" value="${p.purchase_cost_dzd || 0}" data-cost-id="${p.product_id}" /></td>
      <td><button type="button" class="btn btn-primary" data-save-cost="${p.product_id}">Save</button></td>
    </tr>
  `).join('') || '<tr><td colspan="3">No products</td></tr>';
}

function renderOrders() {
  const count = state.orders.length;
  const range = getSelectedRangeLabel();
  const countEl = $('ordersCountLabel');
  if (countEl) {
    countEl.textContent = range
      ? `${count} طلبية في ${range}`
      : `${count} طلبية`;
  }

  $('ordersTableBody').innerHTML = state.orders.map((o) => `
    <tr class="order-row order-row-${statusClass(o.status)}">
      <td><strong>${o.order_id}</strong></td>
      <td>${o.customer_name}<div class="muted small">${o.phone}</div></td>
      <td>${o.product_name}</td>
      <td>${o.wilaya}</td>
      <td>${money(o.total_price)}</td>
      <td><span class="status ${statusClass(o.status)}">${o.status}</span></td>
      <td>${fmtDate(o.created_at)}</td>
      <td><button type="button" class="btn btn-soft" data-order-id="${o.order_id}">View</button></td>
    </tr>
  `).join('') || '<tr><td colspan="8">No orders in this period</td></tr>';
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
      <div class="preview-item"><span>DHD Tracking</span><strong dir="ltr">${o.tracking_number || '—'}</strong></div>
    </div>
  `;
  $('orderModal').classList.remove('hidden');
}

const TAB_TITLES = {
  overview: 'Overview',
  products: 'Products',
  orders: 'Orders',
  accounting: 'Comptabilité',
  costs: 'Product Costs',
};

function switchTab(tab) {
  state.currentTab = tab;
  document.querySelectorAll('.tab').forEach((el) => {
    el.classList.toggle('active', el.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.add('hidden');
  });
  const panel = $(`tab-${tab}`);
  if (panel) panel.classList.remove('hidden');
  $('pageTitle').textContent = TAB_TITLES[tab] || 'Admin';
  updateRangeUi();
  refreshCurrentTab();
}

async function runDhdSync() {
  return api('/api/admin/sync/run', { method: 'POST' });
}

async function refreshCurrentTab() {
  setLoading(true);
  showError('');
  try {
    if (state.currentTab === 'overview' || state.currentTab === 'products' || state.currentTab === 'accounting') {
      await loadMetrics();
    }
    if (state.currentTab === 'orders') {
      await runDhdSync();
      await loadOrders();
    }
    if (state.currentTab === 'costs') await loadProducts();
  } catch (err) {
    showError(err.message || 'Failed to load data');
  } finally {
    setLoading(false);
  }
}

async function refreshAll() {
  setLoading(true);
  showError('');
  try {
    await runDhdSync();
    await loadMetrics();
    if (state.currentTab === 'orders') await loadOrders();
    if (state.currentTab === 'costs') await loadProducts();
  } catch (err) {
    showError(err.message || 'Failed to load data');
  } finally {
    setLoading(false);
  }
}

async function bootstrap() {
  setRangeDays(0);
  if ($('adDate')) $('adDate').value = formatAlgiersDate(new Date());
  document.querySelectorAll('.preset').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.range === 'today');
  });
  updateRangeUi();
  setLoading(true);
  showError('');
  try {
    await loadStatuses();
    await loadMetrics();
    await loadProducts();
  } catch (err) {
    showError(err.message || 'Failed to start dashboard');
  } finally {
    setLoading(false);
  }
}

document.addEventListener('click', async (e) => {
  const target = e.target.closest('[data-tab],[data-order-id],[data-save-cost],[data-delete-ad]');
  if (!target) return;

  if (target.dataset.tab) {
    switchTab(target.dataset.tab);
    return;
  }

  if (target.dataset.orderId) {
    try {
      setLoading(true);
      await openOrder(target.dataset.orderId);
    } catch (err) {
      showError(err.message);
    } finally {
      setLoading(false);
    }
    return;
  }

  if (target.dataset.saveCost) {
    const input = document.querySelector(`input[data-cost-id="${target.dataset.saveCost}"]`);
    try {
      setLoading(true);
      await api(`/api/admin/products/${target.dataset.saveCost}`, {
        method: 'PATCH',
        body: JSON.stringify({ purchase_cost_dzd: Number(input?.value || 0) }),
      });
      await loadMetrics();
      await loadProducts();
    } catch (err) {
      showError(err.message);
    } finally {
      setLoading(false);
    }
    return;
  }

  if (target.dataset.deleteAd) {
    try {
      setLoading(true);
      await api(`/api/admin/ad-spend/${target.dataset.deleteAd}`, { method: 'DELETE' });
      await loadMetrics();
    } catch (err) {
      showError(err.message);
    } finally {
      setLoading(false);
    }
  }
});

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
if ($('orderAlertToggle')) {
  $('orderAlertToggle').addEventListener('click', toggleOrderAlerts);
}
$('applyFilters').addEventListener('click', refreshAll);
['dateFrom', 'dateTo'].forEach((id) => {
  const input = $(id);
  if (!input) return;
  input.addEventListener('change', () => {
    document.querySelectorAll('.preset').forEach((btn) => btn.classList.remove('active'));
    refreshAll();
  });
});
document.querySelectorAll('.preset').forEach((btn) => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('.preset').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    setRangeDays(btn.dataset.range === 'today' ? 0 : Number(btn.dataset.range));
    await refreshAll();
  });
});
$('reloadOrders').addEventListener('click', loadOrders);
$('orderSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadOrders(); });
$('orderStatus').addEventListener('change', loadOrders);
$('closeModal').addEventListener('click', () => $('orderModal').classList.add('hidden'));
$('saveStatusBtn').addEventListener('click', async () => {
  try {
    setLoading(true);
    await api(`/api/admin/orders/${state.selectedOrderId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: $('modalStatus').value }),
    });
    $('orderModal').classList.add('hidden');
    await refreshAll();
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(false);
  }
});

$('adSpendForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    setLoading(true);
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
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(false);
  }
});

$('runSyncBtn').addEventListener('click', async () => {
  const btn = $('runSyncBtn');
  btn.disabled = true;
  btn.textContent = 'Syncing...';
  try {
    const result = await runDhdSync();
    alert(
      `Sync OK\n` +
      `DHD → Admin: ${result.dhd?.updated || 0} livrés/shipped mis à jour\n` +
      `Sheet: mis à jour automatiquement si Code.gs à jour`
    );
    await loadMetrics();
    await loadOrders();
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sync now';
  }
});

if (state.token) {
  showApp();
  unlockOrderAudio();
  bootstrap().then(() => startOrderAlertPolling());
} else {
  showLogin();
}
updateOrderAlertUi();
