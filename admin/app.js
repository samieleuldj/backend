const API = window.location.origin;
const TOKEN_KEY = 'confortdz_admin_token';

const state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  metrics: null,
  orders: [],
  statuses: [],
  selectedOrderId: null,
  activeTab: 'overview',
};

const els = {
  loginView: document.getElementById('loginView'),
  appView: document.getElementById('appView'),
  loginForm: document.getElementById('loginForm'),
  loginError: document.getElementById('loginError'),
  logoutBtn: document.getElementById('logoutBtn'),
  dateFrom: document.getElementById('dateFrom'),
  dateTo: document.getElementById('dateTo'),
  applyFilters: document.getElementById('applyFilters'),
  pageTitle: document.getElementById('pageTitle'),
  ordersTableBody: document.getElementById('ordersTableBody'),
  productsTableBody: document.getElementById('productsTableBody'),
  wilayasTableBody: document.getElementById('wilayasTableBody'),
  orderSearch: document.getElementById('orderSearch'),
  orderStatus: document.getElementById('orderStatus'),
  reloadOrders: document.getElementById('reloadOrders'),
  orderModal: document.getElementById('orderModal'),
  closeModal: document.getElementById('closeModal'),
  modalTitle: document.getElementById('modalTitle'),
  modalSubtitle: document.getElementById('modalSubtitle'),
  orderPreview: document.getElementById('orderPreview'),
  modalStatus: document.getElementById('modalStatus'),
  saveStatusBtn: document.getElementById('saveStatusBtn'),
};

function formatMoney(value) {
  return `${Number(value || 0).toLocaleString('fr-DZ')} دج`;
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('ar-DZ', { timeZone: 'Africa/Algiers' });
}

function statusClass(status) {
  const key = String(status || '').toLowerCase();
  if (key.includes('pending') || key.includes('انتظار')) return 'pending';
  if (key.includes('confirm') || key.includes('مؤك')) return 'confirmed';
  if (key.includes('ship') || key.includes('شحن')) return 'shipped';
  if (key.includes('deliver') || key.includes('تسل')) return 'delivered';
  if (key.includes('return') || key.includes('cancel')) return 'returned';
  return 'pending';
}

function setRangeDays(days) {
  const end = new Date();
  const start = new Date();
  if (days === 0) {
    start.setHours(0, 0, 0, 0);
  } else {
    start.setDate(end.getDate() - (days - 1));
  }
  els.dateFrom.value = start.toISOString().slice(0, 10);
  els.dateTo.value = end.toISOString().slice(0, 10);
}

async function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  if (state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }

  const response = await fetch(`${API}${path}`, {
    ...options,
    headers,
  });

  if (response.status === 401) {
    logout();
    throw new Error('Unauthorized');
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || 'Request failed');
  }

  return response.json();
}

function showLogin() {
  els.loginView.classList.remove('hidden');
  els.appView.classList.add('hidden');
}

function showApp() {
  els.loginView.classList.add('hidden');
  els.appView.classList.remove('hidden');
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

async function loadStatuses() {
  state.statuses = await api('/api/admin/statuses');
  els.orderStatus.innerHTML = '<option value="">كل الحالات</option>' +
    state.statuses.map((status) => `<option value="${status}">${status}</option>`).join('');
  els.modalStatus.innerHTML = state.statuses.map((status) => `<option value="${status}">${status}</option>`).join('');
}

async function loadMetrics() {
  const params = new URLSearchParams({
    from: els.dateFrom.value,
    to: els.dateTo.value,
  });
  state.metrics = await api(`/api/admin/metrics?${params.toString()}`);
  renderMetrics();
}

async function loadOrders() {
  const params = new URLSearchParams({
    from: els.dateFrom.value,
    to: els.dateTo.value,
  });
  if (els.orderSearch.value.trim()) params.set('search', els.orderSearch.value.trim());
  if (els.orderStatus.value) params.set('status', els.orderStatus.value);

  state.orders = await api(`/api/admin/orders?${params.toString()}`);
  renderOrders();
}

function renderMetrics() {
  const m = state.metrics;
  if (!m) return;

  document.getElementById('mVisitors').textContent = m.unique_visitors.toLocaleString('fr-DZ');
  document.getElementById('mPageViews').textContent = m.page_views.toLocaleString('fr-DZ');
  document.getElementById('mOrders').textContent = m.orders.toLocaleString('fr-DZ');
  document.getElementById('mRevenue').textContent = formatMoney(m.revenue);
  document.getElementById('mConversion').textContent = `CR ${m.conversion_rate}%`;
  document.getElementById('mAov').textContent = `AOV ${formatMoney(m.avg_order_value)}`;

  document.getElementById('funnelList').innerHTML = (m.funnel || []).map((step) => `
    <div class="funnel-step">
      <span>${step.step}</span>
      <strong>${Number(step.count).toLocaleString('fr-DZ')}</strong>
    </div>
  `).join('');

  document.getElementById('activityList').innerHTML = (m.recent_activity || []).map((item) => `
    <div class="activity-item">
      <div>
        <strong>${item.label}</strong>
        <div class="muted">${item.detail}</div>
      </div>
      <div>${formatMoney(item.amount)}<div class="muted">${formatDate(item.created_at)}</div></div>
    </div>
  `).join('') || '<p class="muted">لا يوجد نشاط بعد</p>';

  const maxOrders = Math.max(...(m.daily || []).map((d) => d.orders), 1);
  document.getElementById('dailyChart').innerHTML = (m.daily || []).map((day) => `
    <div class="bar-row">
      <span>${day.date.slice(5)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${(day.orders / maxOrders) * 100}%"></div></div>
      <span>${day.orders} / ${formatMoney(day.revenue)}</span>
    </div>
  `).join('') || '<p class="muted">لا توجد بيانات</p>';

  els.productsTableBody.innerHTML = (m.by_product || []).map((row) => `
    <tr>
      <td>${row.product_name}</td>
      <td>${row.clicks || 0}</td>
      <td>${row.orders}</td>
      <td>${formatMoney(row.revenue)}</td>
    </tr>
  `).join('') || '<tr><td colspan="4">لا توجد بيانات</td></tr>';

  els.wilayasTableBody.innerHTML = (m.by_wilaya || []).map((row) => `
    <tr>
      <td>${row.wilaya}</td>
      <td>${row.orders}</td>
      <td>${formatMoney(row.revenue)}</td>
    </tr>
  `).join('') || '<tr><td colspan="3">لا توجد بيانات</td></tr>';
}

function renderOrders() {
  els.ordersTableBody.innerHTML = state.orders.map((order) => `
    <tr>
      <td><strong>${order.order_id}</strong></td>
      <td>${order.customer_name}<div class="muted">${order.phone}</div></td>
      <td>${order.product_name}<div class="muted">x${order.quantity}</div></td>
      <td>${order.wilaya}</td>
      <td>${formatMoney(order.total_price)}</td>
      <td><span class="status ${statusClass(order.status)}">${order.status}</span></td>
      <td>${formatDate(order.created_at)}</td>
      <td><button class="btn btn-soft" data-order-id="${order.order_id}">معاينة</button></td>
    </tr>
  `).join('') || '<tr><td colspan="8">لا توجد طلبيات في هذه الفترة</td></tr>';

  els.ordersTableBody.querySelectorAll('[data-order-id]').forEach((button) => {
    button.addEventListener('click', () => openOrderModal(button.dataset.orderId));
  });
}

async function openOrderModal(orderId) {
  state.selectedOrderId = orderId;
  const order = await api(`/api/admin/orders/${orderId}`);
  els.modalTitle.textContent = `طلبية ${order.order_id}`;
  els.modalSubtitle.textContent = `${formatDate(order.created_at)} • ${order.wilaya}`;
  els.modalStatus.value = order.status;

  const deliveryLabel = order.delivery_type === 'office' ? 'مكتب' : 'منزل';
  els.orderPreview.innerHTML = `
    <div style="display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap;">
      <div>
        <div class="muted">الزبون</div>
        <h3>${order.customer_name}</h3>
      </div>
      <div>
        <span class="status ${statusClass(order.status)}">${order.status}</span>
      </div>
    </div>
    <div class="preview-grid">
      <div class="preview-item"><span>الهاتف</span><strong dir="ltr">${order.phone}</strong></div>
      <div class="preview-item"><span>الولاية / البلدية</span><strong>${order.wilaya}<br>${order.commune}</strong></div>
      <div class="preview-item"><span>المنتج</span><strong>${order.product_name}</strong></div>
      <div class="preview-item"><span>الكمية / التوصيل</span><strong>${order.quantity} • ${deliveryLabel}</strong></div>
      <div class="preview-item"><span>IP / المدينة</span><strong>${order.ip_address || '—'}<br>${order.city || '—'} (${order.country_code || '—'})</strong></div>
      <div class="preview-item"><span>المصدر</span><strong>${order.utm_source || 'direct'} / ${order.utm_medium || '—'}</strong></div>
      <div class="preview-item"><span>Referrer</span><strong>${order.referrer || '—'}</strong></div>
      <div class="preview-item"><span>Risk score</span><strong>${order.risk_score}</strong></div>
    </div>
    ${order.notes ? `<div style="margin-top:14px;" class="preview-item"><span>ملاحظات</span><strong>${order.notes}</strong></div>` : ''}
    <div class="preview-total">
      <span>المجموع الكلي</span>
      <strong>${formatMoney(order.total_price)}</strong>
    </div>
  `;

  els.orderModal.classList.remove('hidden');
}

async function saveOrderStatus() {
  if (!state.selectedOrderId) return;
  await api(`/api/admin/orders/${state.selectedOrderId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: els.modalStatus.value }),
  });
  els.orderModal.classList.add('hidden');
  await Promise.all([loadOrders(), loadMetrics()]);
}

function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.getElementById('tab-overview').classList.toggle('hidden', tab !== 'overview');
  document.getElementById('tab-orders').classList.toggle('hidden', tab !== 'orders');
  document.getElementById('tab-products').classList.toggle('hidden', tab !== 'products');
  document.getElementById('tab-wilayas').classList.toggle('hidden', tab !== 'wilayas');

  const titles = {
    overview: 'نظرة عامة',
    orders: 'الطلبيات',
    products: 'المنتجات',
    wilayas: 'الولايات',
  };
  els.pageTitle.textContent = titles[tab] || 'Admin';
}

async function bootstrap() {
  setRangeDays(7);
  await loadStatuses();
  await Promise.all([loadMetrics(), loadOrders()]);
}

els.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  els.loginError.classList.add('hidden');
  try {
    await login(
      document.getElementById('username').value.trim(),
      document.getElementById('password').value
    );
  } catch (error) {
    els.loginError.textContent = error.message || 'فشل تسجيل الدخول';
    els.loginError.classList.remove('hidden');
  }
});

els.logoutBtn.addEventListener('click', logout);
els.applyFilters.addEventListener('click', async () => {
  await Promise.all([loadMetrics(), loadOrders()]);
});

document.querySelectorAll('.preset').forEach((button) => {
  button.addEventListener('click', async () => {
    document.querySelectorAll('.preset').forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    const range = button.dataset.range;
    if (range === 'today') setRangeDays(0);
    else setRangeDays(Number(range));
    await Promise.all([loadMetrics(), loadOrders()]);
  });
});

document.querySelectorAll('.nav-btn[data-tab]').forEach((button) => {
  button.addEventListener('click', () => switchTab(button.dataset.tab));
});

els.reloadOrders.addEventListener('click', loadOrders);
els.orderSearch.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') loadOrders();
});
els.orderStatus.addEventListener('change', loadOrders);
els.closeModal.addEventListener('click', () => els.orderModal.classList.add('hidden'));
els.saveStatusBtn.addEventListener('click', saveOrderStatus);

if (state.token) {
  showApp();
  bootstrap().catch(logout);
} else {
  showLogin();
}
