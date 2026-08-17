const state = {
  user: null,
  meta: null,
  dashboard: null,
  deals: [],
  customers: [],
  currentView: "dashboard",
  dealType: "order",
  status: "all",
  query: "",
  currentDeal: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatMoney(value, currency = "UAH") {
  return new Intl.NumberFormat("uk-UA", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(Number(value) || 0);
}

function formatDate(value, withTime = false) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("uk-UA", withTime
    ? { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }
    : { day: "2-digit", month: "short", year: "numeric" }).format(date);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    window.location.replace("/login");
    throw new Error("unauthorized");
  }
  if (!response.ok || !data.ok) {
    const error = new Error(data.error || "request_failed");
    error.status = response.status;
    throw error;
  }
  return data;
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.hidden = true; }, 3600);
}

function statusMeta(id) {
  return state.meta?.statuses.find((item) => item.id === id) || { id, label: id, tone: "neutral" };
}

function typeMeta(id) {
  return state.meta?.types.find((item) => item.id === id) || { id, label: id };
}

function sourceLabel(deal) {
  return deal.utm_source || deal.source || "Невідомо";
}

function renderStatus(id) {
  const item = statusMeta(id);
  return `<span class="status status-${escapeHtml(item.tone)}">${escapeHtml(item.label)}</span>`;
}

function renderType(id) {
  return `<span class="type-pill">${escapeHtml(typeMeta(id).label)}</span>`;
}

function dealRow(deal, compact = false) {
  return `<tr data-deal-id="${escapeHtml(deal.id)}" tabindex="0">
    <td><span class="cell-primary">${escapeHtml(deal.customer_name)}</span><span class="cell-secondary">${escapeHtml(compact ? deal.customer_phone : `${deal.external_id || deal.id} · ${deal.customer_phone}`)}</span></td>
    ${compact ? `<td>${renderType(deal.type)}</td>` : `<td><span class="source-tag">${escapeHtml(sourceLabel(deal))}</span><span class="cell-secondary">${escapeHtml(deal.utm_campaign || deal.source_detail || "—")}</span></td>`}
    <td>${renderStatus(deal.status)}</td>
    <td class="money">${deal.total ? formatMoney(deal.total, deal.currency) : "—"}</td>
    ${compact ? "" : `<td>${escapeHtml(deal.manager_name || "Не призначено")}</td>`}
    <td><span class="cell-primary">${formatDate(deal.created_at)}</span><span class="cell-secondary">${new Date(deal.created_at).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" })}</span></td>
    ${compact ? "" : `<td><button class="icon-button row-open" aria-label="Відкрити звернення"><svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg></button></td>`}
  </tr>`;
}

function bindDealRows(root = document) {
  $$('[data-deal-id]', root).forEach((row) => {
    const open = () => openDeal(row.dataset.dealId);
    row.addEventListener("click", open);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
  });
}

async function loadBootstrap() {
  const [me, meta] = await Promise.all([api("/api/auth/me"), api("/api/meta")]);
  state.user = me.user;
  state.meta = meta;
  $("#userName").textContent = me.user.name;
  $("#userRole").textContent = me.user.role === "admin" ? "Адміністратор" : "Менеджер";
  $("#userAvatar").textContent = me.user.name.trim().charAt(0).toUpperCase();
  $("#statusFilter").innerHTML = `<option value="all">Усі статуси</option>${meta.statuses.map((item) => `<option value="${item.id}">${escapeHtml(item.label)}</option>`).join("")}`;
  renderTrackingSettings();
}

function renderTrackingSettings() {
  const tracking = state.meta.tracking;
  $("#trackingSettings").innerHTML = [
    ["Meta Conversions API", tracking.meta],
    ["Google Analytics 4", tracking.ga4],
  ].map(([name, ready]) => `<div class="integration-row"><div><strong>${name}</strong><span>${ready ? "Події надсилаються із сервера" : "Потрібно додати ключі доступу"}</span></div><span class="integration-badge ${ready ? "ready" : ""}">${ready ? "Підключено" : "Очікує"}</span></div>`).join("");
}

async function loadDashboard() {
  $("#dashboardSkeleton").hidden = false;
  $("#dashboardContent").hidden = true;
  const data = await api("/api/dashboard");
  state.dashboard = data;
  const totals = data.totals;
  const conversion = totals.total_deals ? Math.round((totals.completed_deals / totals.total_deals) * 100) : 0;
  const metrics = [
    ["Нові звернення", totals.new_deals || 0, "Потребують першого контакту"],
    ["Усі звернення", totals.total_deals || 0, "Замовлення та консультації"],
    ["Завершені продажі", totals.completed_deals || 0, `Конверсія ${conversion}%`],
    ["Виторг", formatMoney(totals.completed_revenue || 0), "Тільки успішно завершені"],
  ];
  $("#metricsStrip").innerHTML = metrics.map(([label, value, note]) => `<div class="metric"><span class="metric-label">${label}</span><strong class="metric-value">${value}</strong><span class="metric-note">${note}</span></div>`).join("");
  const max = Math.max(1, ...data.byStatus.map((item) => item.count));
  $("#pipelineList").innerHTML = state.meta.statuses.map((status) => {
    const found = data.byStatus.find((item) => item.status === status.id) || { count: 0 };
    return `<div class="pipeline-row"><span class="pipeline-name">${escapeHtml(status.label)}</span><div class="pipeline-bar"><span style="width:${Math.round(found.count / max * 100)}%"></span></div><span class="pipeline-count">${found.count}</span></div>`;
  }).join("");
  $("#sourceList").innerHTML = data.sources.length ? data.sources.map((source) => `<div class="source-row"><span class="source-name">${escapeHtml(source.source)}</span><span class="source-count">${source.count}</span><span class="source-revenue">${formatMoney(source.revenue)}</span></div>`).join("") : `<div class="source-row"><span class="source-name">Даних ще немає</span><span></span><span></span></div>`;
  $("#recentDeals").innerHTML = data.recent.length ? data.recent.map((deal) => dealRow(deal, true)).join("") : `<tr><td colspan="5">Нових звернень поки немає.</td></tr>`;
  $("#newOrdersCount").textContent = totals.new_orders || 0;
  $("#newOrdersCount").hidden = !(totals.new_orders > 0);
  bindDealRows($("#recentDeals"));
  $("#dashboardSkeleton").hidden = true;
  $("#dashboardContent").hidden = false;
}

async function loadDeals() {
  $("#dealsSkeleton").hidden = false;
  $("#dealsTable").hidden = true;
  $("#dealsEmpty").hidden = true;
  const params = new URLSearchParams({
    type: state.dealType,
    status: state.status,
    q: state.query,
  });
  const data = await api(`/api/deals?${params}`);
  state.deals = data.rows;
  $("#dealCount").textContent = `${data.total} ${plural(data.total, ["звернення", "звернення", "звернень"])}`;
  $("#dealsSkeleton").hidden = true;
  if (!data.rows.length) {
    $("#dealsEmpty").hidden = false;
    return;
  }
  $("#dealsBody").innerHTML = data.rows.map((deal) => dealRow(deal)).join("");
  $("#dealsTable").hidden = false;
  bindDealRows($("#dealsBody"));
}

async function loadCustomers() {
  $("#customersSkeleton").hidden = false;
  $("#customersTable").hidden = true;
  const query = encodeURIComponent($("#customerSearch").value.trim());
  const data = await api(`/api/customers?q=${query}`);
  state.customers = data.customers;
  const canDelete = state.user?.role === "admin";
  $("#customersBody").innerHTML = data.customers.length ? data.customers.map((customer) => `<tr><td><span class="cell-primary">${escapeHtml(customer.name)}</span><span class="cell-secondary">Клієнт з ${formatDate(customer.created_at)}</span></td><td><span class="cell-primary">${escapeHtml(customer.phone)}</span><span class="cell-secondary">${escapeHtml(customer.email || "—")}</span></td><td class="money">${customer.deal_count}</td><td class="money">${formatMoney(customer.completed_revenue)}</td><td>${formatDate(customer.last_deal_at || customer.updated_at, true)}</td><td class="row-actions">${canDelete ? `<button class="icon-button icon-button-danger" data-delete-customer="${escapeHtml(customer.id)}" aria-label="Видалити клієнта ${escapeHtml(customer.name)}"><svg viewBox="0 0 24 24"><path d="M4 7h16m-10 4v6m4-6v6M9 7l1-3h4l1 3m-9 0 1 14h10l1-14"/></svg></button>` : ""}</td></tr>`).join("") : `<tr><td colspan="6">Клієнтів поки немає.</td></tr>`;
  $("#customersSkeleton").hidden = true;
  $("#customersTable").hidden = false;
  bindCustomerActions();
}

function switchView(view) {
  state.currentView = view;
  const target = ["orders", "leads"].includes(view) ? "deals" : view;
  $$(".view").forEach((element) => element.classList.toggle("active", element.id === `view-${target}`));
  $$('[data-view]').forEach((element) => element.classList.toggle("active", element.dataset.view === view));
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (view === "dashboard") loadDashboard().catch(showLoadError);
  if (view === "orders" || view === "leads") {
    state.dealType = view === "orders" ? "order" : "lead";
    $("#dealsTitle").textContent = view === "orders" ? "Замовлення" : "Заявки";
    $("#dealsContext").textContent = view === "orders" ? "Робота з продажами" : "Консультації та дзвінки";
    $("#dealsDescription").textContent = view === "orders" ? "Кошики, оформлені на сайті та вручну." : "Контактні форми й замовлення зворотного дзвінка.";
    loadDeals().catch(showLoadError);
  }
  if (view === "customers") loadCustomers().catch(showLoadError);
  if (view === "selection") $("#selectionFrame")?.focus();
}

function showLoadError(error) {
  if (error.message !== "unauthorized") toast("Не вдалося завантажити дані. Оновіть сторінку.");
}

async function openDeal(id) {
  const dialog = $("#dealDialog");
  $("#dealDialogTitle").textContent = id;
  $("#dealDialogType").textContent = "Завантаження…";
  $("#dealDialogBody").innerHTML = `<div class="skeleton table-skeleton"></div>`;
  dialog.showModal();
  const data = await api(`/api/deals/${encodeURIComponent(id)}`);
  state.currentDeal = data.deal;
  renderDeal(data.deal);
}

function optionList(items, selected) {
  return items.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === selected ? "selected" : ""}>${escapeHtml(item.label || item.name)}</option>`).join("");
}

function trackingCopy(stateValue) {
  const copy = {
    sent: ["sent", "Передано"],
    failed: ["failed", "Помилка — можна повторити"],
    pending: ["", "Очікує передачі"],
    unconfigured: ["", "Ключі аналітики ще не підключені"],
    not_required: ["", "Не застосовується"],
    not_ready: ["", "Буде передано після завершення"],
  };
  return copy[stateValue] || ["", stateValue || "—"];
}

function renderDeal(deal) {
  const type = typeMeta(deal.type);
  $("#dealDialogType").textContent = `${type.label} · ${formatDate(deal.created_at, true)}`;
  $("#dealDialogTitle").textContent = deal.external_id || deal.id;
  const items = deal.items.length ? deal.items.map((item) => `<div class="item-row"><div><div class="item-name">${escapeHtml(item.name)}</div><div class="item-meta">${escapeHtml(item.sku || "Без артикулу")} · ${item.quantity} × ${formatMoney(item.price)}</div></div><div class="item-total">${formatMoney(item.quantity * item.price)}</div></div>`).join("") : `<div class="item-row"><div class="item-name">Товарів не додано</div></div>`;
  const history = deal.history.map((item) => `<div class="timeline-item"><span class="timeline-dot"></span><div class="timeline-copy"><strong>${escapeHtml(statusMeta(item.to_status).label)}</strong><span>${formatDate(item.created_at, true)}${item.user_name ? ` · ${escapeHtml(item.user_name)}` : ""}</span>${item.note ? `<span class="timeline-note">${escapeHtml(item.note)}</span>` : ""}</div></div>`).join("");
  const leadTracking = trackingCopy(deal.lead_tracking_state);
  const purchaseTracking = trackingCopy(deal.purchase_tracking_state);
  $("#dealDialogBody").innerHTML = `
    <section class="detail-section"><p class="detail-section-title">КЛІЄНТ</p><div class="detail-grid"><div class="detail-field"><span>Ім’я</span><strong>${escapeHtml(deal.customer_name)}</strong></div><div class="detail-field"><span>Телефон</span><a href="tel:${escapeHtml(deal.customer_phone)}">${escapeHtml(deal.customer_phone)}</a></div><div class="detail-field"><span>Email</span><a href="mailto:${escapeHtml(deal.customer_email || "")}">${escapeHtml(deal.customer_email || "—")}</a></div><div class="detail-field"><span>Адреса</span><strong>${escapeHtml(deal.delivery_address || deal.customer_address || "—")}</strong></div></div></section>
    <section class="detail-section"><p class="detail-section-title">РОБОТА ІЗ ЗАМОВЛЕННЯМ</p><div class="deal-controls"><label><span>Статус</span><select id="dealStatus">${optionList(state.meta.statuses, deal.status)}</select></label><label><span>Менеджер</span><select id="dealManager"><option value="">Не призначено</option>${state.meta.users.filter((user) => user.active).map((user) => `<option value="${user.id}" ${user.id === deal.manager_id ? "selected" : ""}>${escapeHtml(user.name)}</option>`).join("")}</select></label><label><span>Спосіб оплати</span><select id="dealPaymentMethod">${optionList(state.meta.paymentMethods, deal.payment_method)}</select></label><label><span>Стан оплати</span><select id="dealPaymentStatus">${optionList(state.meta.paymentStatuses, deal.payment_status)}</select></label></div><label style="margin-top:14px;display:block"><span>Коментар менеджера</span><textarea id="dealComment" rows="3">${escapeHtml(deal.comment || "")}</textarea></label><label style="margin-top:14px;display:block"><span>Нотатка до зміни статусу</span><input id="dealNote" placeholder="Наприклад: клієнт підтвердив післяплату"></label><div style="display:flex;justify-content:flex-end;margin-top:14px"><button id="saveDealButton" class="button button-primary">Зберегти зміни</button></div></section>
    <section class="detail-section"><p class="detail-section-title">ТОВАРИ</p><div class="items-list">${items}</div><div class="deal-total"><span>Сума замовлення</span><strong>${formatMoney(deal.total, deal.currency)}</strong></div></section>
    <section class="detail-section"><p class="detail-section-title">ДЖЕРЕЛО ТА АНАЛІТИКА</p><div class="detail-grid"><div class="detail-field"><span>Джерело</span><strong>${escapeHtml(sourceLabel(deal))}</strong></div><div class="detail-field"><span>Кампанія</span><strong>${escapeHtml(deal.utm_campaign || "—")}</strong></div><div class="detail-field"><span>Lead</span><strong class="tracking-state ${leadTracking[0]}">${escapeHtml(leadTracking[1])}</strong></div><div class="detail-field"><span>Purchase</span><strong class="tracking-state ${purchaseTracking[0]}">${escapeHtml(purchaseTracking[1])}</strong></div><div class="detail-field"><span>Сторінка входу</span><a href="${escapeHtml(deal.landing_page || "#")}" target="_blank" rel="noopener">${escapeHtml(deal.landing_page || "—")}</a></div><div class="detail-field"><span>Referrer</span><strong>${escapeHtml(deal.referrer || "—")}</strong></div></div>${deal.tracking_error ? `<p class="form-error" style="margin-top:14px">${escapeHtml(deal.tracking_error)}</p><button id="retryTracking" class="button" style="margin-top:10px">Повторити передачу</button>` : ""}</section>
    <section class="detail-section"><p class="detail-section-title">ІСТОРІЯ</p><div class="timeline">${history}</div></section>
    ${state.user?.role === "admin" ? `<section class="danger-zone"><div><strong>Видалити звернення</strong><p>Запис, товари та історію статусів буде видалено без можливості відновлення.</p></div><button id="deleteDealButton" class="button button-danger">Видалити</button></section>` : ""}`;
  $("#saveDealButton").addEventListener("click", saveCurrentDeal);
  $("#retryTracking")?.addEventListener("click", retryTracking);
  $("#deleteDealButton")?.addEventListener("click", deleteCurrentDeal);
}

async function deleteCurrentDeal() {
  const deal = state.currentDeal;
  if (!deal) return;
  const label = deal.external_id || deal.id;
  if (!window.confirm(`Видалити звернення ${label}? Цю дію неможливо скасувати.`)) return;
  const button = $("#deleteDealButton");
  button.disabled = true;
  try {
    await api(`/api/deals/${encodeURIComponent(deal.id)}`, { method: "DELETE" });
    $("#dealDialog").close();
    state.currentDeal = null;
    toast("Звернення видалено.");
    if (["orders", "leads"].includes(state.currentView)) await loadDeals();
    await loadDashboard();
  } catch (error) {
    button.disabled = false;
    toast(error.message === "admin_required" ? "Видаляти звернення може лише адміністратор." : "Не вдалося видалити звернення.");
  }
}

function bindCustomerActions() {
  $$('[data-delete-customer]').forEach((button) => {
    button.addEventListener("click", async () => {
      const customer = state.customers.find((item) => item.id === button.dataset.deleteCustomer);
      if (!customer) return;
      const suffix = customer.deal_count
        ? ` Разом із клієнтом буде видалено ${customer.deal_count} ${plural(customer.deal_count, ["звернення", "звернення", "звернень"])}.`
        : "";
      if (!window.confirm(`Видалити клієнта «${customer.name}»?${suffix} Цю дію неможливо скасувати.`)) return;
      button.disabled = true;
      try {
        await api(`/api/customers/${encodeURIComponent(customer.id)}`, { method: "DELETE" });
        toast("Клієнта та пов’язані звернення видалено.");
        await loadCustomers();
        await loadDashboard();
      } catch (error) {
        button.disabled = false;
        toast(error.message === "admin_required" ? "Видаляти клієнтів може лише адміністратор." : "Не вдалося видалити клієнта.");
      }
    });
  });
}

async function saveCurrentDeal() {
  const button = $("#saveDealButton");
  button.disabled = true;
  const data = await api(`/api/deals/${encodeURIComponent(state.currentDeal.id)}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: $("#dealStatus").value,
      managerId: $("#dealManager").value || null,
      paymentMethod: $("#dealPaymentMethod").value,
      paymentStatus: $("#dealPaymentStatus").value,
      comment: $("#dealComment").value,
      note: $("#dealNote").value,
    }),
  });
  state.currentDeal = data.deal;
  renderDeal(data.deal);
  toast(data.tracking?.state === "sent" ? "Збережено. Продаж передано в аналітику." : "Зміни збережено.");
  if (["orders", "leads"].includes(state.currentView)) loadDeals().catch(showLoadError);
  loadDashboard().catch(() => {});
}

async function retryTracking() {
  const data = await api(`/api/deals/${encodeURIComponent(state.currentDeal.id)}/retry-tracking`, { method: "POST", body: "{}" });
  state.currentDeal = data.deal;
  renderDeal(data.deal);
  toast(data.tracking.state === "sent" ? "Подію успішно передано." : "Інтеграція ще не налаштована.");
}

function plural(n, words) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return words[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return words[1];
  return words[2];
}

function debounce(fn, delay = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function bindEvents() {
  $$('[data-view]').forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
  $$('[data-open-view]').forEach((button) => button.addEventListener("click", () => switchView(button.dataset.openView)));
  $("#statusFilter").addEventListener("change", (event) => { state.status = event.target.value; loadDeals().catch(showLoadError); });
  $("#dealSearch").addEventListener("input", debounce((event) => { state.query = event.target.value.trim(); loadDeals().catch(showLoadError); }));
  $("#customerSearch").addEventListener("input", debounce(() => loadCustomers().catch(showLoadError)));
  $$('[data-close-dialog]').forEach((button) => button.addEventListener("click", () => $("#dealDialog").close()));
  $$('[data-new-deal]').forEach((button) => button.addEventListener("click", () => $("#newDealDialog").showModal()));
  $$('[data-close-new-deal]').forEach((button) => button.addEventListener("click", () => $("#newDealDialog").close()));
  $("#newDealForm").addEventListener("submit", createManualDeal);
  $("#logoutButton").addEventListener("click", async () => { await api("/api/auth/logout", { method: "POST", body: "{}" }); window.location.replace("/login"); });
  $("#passwordForm").addEventListener("submit", changePassword);
  for (const dialog of $$('dialog')) {
    dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  }
}

async function createManualDeal(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorBox = $("#newDealError");
  errorBox.hidden = true;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const data = await api("/api/deals", {
      method: "POST",
      body: JSON.stringify({
        customer: { name: form.name.value.trim(), phone: form.phone.value.trim(), email: form.email.value.trim(), address: form.address.value.trim() },
        total: Number(form.total.value) || 0,
        comment: form.comment.value.trim(),
        source: "manual",
        items: [],
      }),
    });
    form.reset();
    $("#newDealDialog").close();
    toast("Нову заявку створено.");
    await openDeal(data.deal.id);
    loadDashboard().catch(() => {});
  } catch {
    errorBox.textContent = "Перевірте ім’я та український номер телефону.";
    errorBox.hidden = false;
  } finally {
    submit.disabled = false;
  }
}

async function changePassword(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const message = $("#passwordMessage");
  message.hidden = true;
  try {
    await api("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword: form.currentPassword.value, newPassword: form.newPassword.value }),
    });
    form.reset();
    message.textContent = "Пароль успішно оновлено.";
    message.className = "form-message success";
  } catch (error) {
    message.textContent = error.message === "invalid_current_password" ? "Поточний пароль неправильний." : "Новий пароль має містити щонайменше 12 символів.";
    message.className = "form-message";
  }
  message.hidden = false;
}

async function init() {
  $("#todayLabel").textContent = new Intl.DateTimeFormat("uk-UA", { weekday: "long", day: "numeric", month: "long" }).format(new Date());
  bindEvents();
  await loadBootstrap();
  await loadDashboard();
}

init().catch(showLoadError);
