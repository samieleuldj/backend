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
};

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
  if (s.includes('return') || s.includes('مرتج')) return 'returned';
  if (s.includes('cancel') || s.includes('ملغ')) return 'returned';
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
  state.token = '';
  localStorage.removeItem(TOKEN_KEY);
  showLogin();
}

async function login(username, password) {
  const data = await api('/api/admin/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
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
  renderProductPerformance();
  renderAccounting();
}

async function loadProducts() {
  state.products = await api('/api/admin/products');
  renderProductCosts();
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
    ['Confirmed', acc.orders_confirmed || 0],
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
  $('ordersTableBody').innerHTML = state.orders.map((o) => `
    <tr>
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
  refreshCurrentTab();
}

async function refreshCurrentTab() {
  setLoading(true);
  showError('');
  try {
    if (state.currentTab === 'overview' || state.currentTab === 'products' || state.currentTab === 'accounting') {
      await loadMetrics();
    }
    if (state.currentTab === 'orders') await loadOrders();
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
  setRangeDays(7);
  if ($('adDate')) $('adDate').value = new Date().toISOString().slice(0, 10);
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
$('applyFilters').addEventListener('click', refreshAll);
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
    const result = await api('/api/admin/sync/run', { method: 'POST' });
    alert(`Sync OK\nMeta: ${result.meta?.synced || 0} days\nDHD: ${result.dhd?.updated || 0} updated`);
    await loadMetrics();
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sync now';
  }
});

if (state.token) {
  showApp();
  bootstrap();
} else {
  showLogin();
}
