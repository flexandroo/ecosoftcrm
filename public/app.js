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
  catalog: [],
  catalogSyncedAt: null,
  catalogStale: false,
  proposalItems: [],
  proposalLoaded: false,
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

function formatPlainDate(value) {
  return new Intl.DateTimeFormat("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric" }).format(value);
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
  window.scrollTo({ top: 0, behavior: "instant" });
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
  if (view === "proposal" && !state.proposalLoaded) loadCatalog().catch(showCatalogError);
}

function catalogSyncLabel(result) {
  const synced = result.syncedAt ? formatDate(result.syncedAt, true) : "щойно";
  return result.stale
    ? `Показано останню збережену версію (${synced}). Сайт тимчасово недоступний.`
    : `${result.count} товарів · ціни синхронізовано із sofiivkawater.com ${synced}`;
}

async function loadCatalog(force = false) {
  const button = $("#refreshCatalogButton");
  const bar = $("#catalogSyncBar");
  button.disabled = true;
  bar.className = "catalog-sync-bar";
  $("#catalogSyncText").textContent = force ? "Оновлюємо ціни із сайту…" : "Завантажуємо каталог із сайту…";
  $("#proposalCatalogSkeleton").hidden = false;
  $("#proposalCatalogList").hidden = true;
  try {
    const result = await api(`/api/catalog${force ? "?refresh=1" : ""}`);
    state.catalog = result.products;
    state.catalogSyncedAt = result.syncedAt;
    state.catalogStale = result.stale;
    state.proposalLoaded = true;
    bar.classList.add(result.stale ? "stale" : "ready");
    $("#catalogSyncText").textContent = catalogSyncLabel(result);
    renderCatalogFilters();
    refreshProposalPrices();
    renderProposalCatalog();
    renderProposalItems();
    if (force) toast("Каталог і ціни оновлено із сайту.");
  } finally {
    button.disabled = false;
    $("#proposalCatalogSkeleton").hidden = true;
  }
}

function showCatalogError() {
  $("#proposalCatalogSkeleton").hidden = true;
  $("#proposalCatalogEmpty").hidden = false;
  $("#proposalCatalogEmpty").textContent = "Не вдалося завантажити каталог. Натисніть «Оновити ціни», щоб повторити.";
  $("#catalogSyncBar").className = "catalog-sync-bar stale";
  $("#catalogSyncText").textContent = "Каталог зараз недоступний.";
}

function renderCatalogFilters() {
  const select = $("#proposalCategoryFilter");
  const current = select.value;
  const categories = [...new Map(state.catalog.map((item) => [item.category, item.categoryName || item.category])).entries()]
    .filter(([id]) => id)
    .sort((a, b) => a[1].localeCompare(b[1], "uk"));
  select.innerHTML = `<option value="all">Усі категорії</option>${categories.map(([id, label]) => `<option value="${escapeHtml(id)}">${escapeHtml(label)}</option>`).join("")}`;
  if (["all", ...categories.map(([id]) => id)].includes(current)) select.value = current;
}

function renderProposalCatalog() {
  const query = $("#proposalCatalogSearch").value.trim().toLowerCase();
  const category = $("#proposalCategoryFilter").value;
  const products = state.catalog.filter((item) => {
    const matchesCategory = category === "all" || item.category === category;
    const haystack = `${item.name} ${item.sku}`.toLowerCase();
    return matchesCategory && (!query || haystack.includes(query));
  });
  $("#catalogCount").textContent = `${products.length} із ${state.catalog.length} товарів`;
  const list = $("#proposalCatalogList");
  const empty = $("#proposalCatalogEmpty");
  empty.hidden = products.length > 0;
  empty.textContent = "За цим запитом товарів не знайдено.";
  list.hidden = products.length === 0;
  list.innerHTML = products.map((item) => `<div class="catalog-product">
    ${item.image ? `<img class="catalog-product-image" src="${escapeHtml(item.image)}" alt="" loading="lazy">` : `<span class="catalog-product-image"></span>`}
    <div class="catalog-product-copy"><strong class="catalog-product-name">${escapeHtml(item.name)}</strong><span class="catalog-product-meta">${escapeHtml(item.sku || "Без артикулу")} · ${escapeHtml(item.categoryName)}</span></div>
    <span class="catalog-stock ${item.inStock ? "" : "out"}">${item.inStock ? "В наявності" : "Під замовлення"}</span>
    <strong class="catalog-product-price">${formatMoney(item.price, item.currency)}</strong>
    <button class="button button-small catalog-add" type="button" data-add-product="${escapeHtml(item.id)}">Додати</button>
  </div>`).join("");
  $$('[data-add-product]', list).forEach((button) => button.addEventListener("click", () => addProposalProduct(button.dataset.addProduct)));
}

function addProposalProduct(id) {
  const product = state.catalog.find((item) => item.id === id);
  if (!product) return;
  const existing = state.proposalItems.find((item) => item.id === id);
  if (existing) existing.quantity += 1;
  else state.proposalItems.push({ id: product.id, sku: product.sku, name: product.name, quantity: 1, price: product.price, sitePrice: product.price, currency: product.currency });
  saveProposalDraft();
  renderProposalItems();
  toast(existing ? "Кількість товару збільшено." : "Товар додано до КП.");
}

function refreshProposalPrices() {
  for (const item of state.proposalItems) {
    const current = state.catalog.find((product) => product.id === item.id || (item.sku && product.sku === item.sku));
    if (!current) continue;
    const hadManualPrice = Number(item.price) !== Number(item.sitePrice);
    item.sitePrice = current.price;
    item.name = current.name;
    if (!hadManualPrice) item.price = current.price;
  }
  saveProposalDraft();
}

function proposalTotals() {
  const subtotal = state.proposalItems.reduce((sum, item) => sum + (Number(item.price) || 0) * (Number(item.quantity) || 0), 0);
  const discountPercent = Math.min(100, Math.max(0, Number($("#proposalDiscount").value) || 0));
  const discount = subtotal * discountPercent / 100;
  return { subtotal, discountPercent, discount, total: subtotal - discount };
}

function renderProposalItems() {
  const empty = $("#proposalEmpty");
  const wrap = $("#proposalItemsWrap");
  const hasItems = state.proposalItems.length > 0;
  empty.hidden = hasItems;
  wrap.hidden = !hasItems;
  $("#proposalItemCount").textContent = hasItems
    ? `${state.proposalItems.length} ${plural(state.proposalItems.length, ["позиція", "позиції", "позицій"])}`
    : "Обладнання ще не додано";
  $("#proposalItems").innerHTML = state.proposalItems.map((item) => `<div class="proposal-item" data-proposal-item="${escapeHtml(item.id)}">
    <div class="proposal-item-copy"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.sku || "Без артикулу")}${Number(item.price) !== Number(item.sitePrice) ? ` · ціна змінена менеджером (на сайті ${formatMoney(item.sitePrice)})` : " · актуальна ціна сайту"}</span></div>
    <label><span>Кількість</span><input type="number" min="1" max="999" step="1" value="${item.quantity}" data-item-quantity></label>
    <label><span>Ціна, ₴</span><input type="number" min="0" step="1" value="${item.price}" data-item-price></label>
    <strong class="proposal-line-total">${formatMoney(item.quantity * item.price)}</strong>
    <button class="icon-button icon-button-danger" type="button" data-remove-item aria-label="Видалити"><svg viewBox="0 0 24 24"><path d="M4 7h16m-10 4v6m4-6v6M9 7l1-3h4l1 3m-9 0 1 14h10l1-14"/></svg></button>
  </div>`).join("");
  $$('[data-proposal-item]', $("#proposalItems")).forEach((row) => {
    const item = state.proposalItems.find((entry) => entry.id === row.dataset.proposalItem);
    row.querySelector('[data-item-quantity]').addEventListener("change", (event) => {
      item.quantity = Math.min(999, Math.max(1, Math.floor(Number(event.target.value) || 1)));
      saveProposalDraft();
      renderProposalItems();
    });
    row.querySelector('[data-item-price]').addEventListener("change", (event) => {
      item.price = Math.max(0, Number(event.target.value) || 0);
      saveProposalDraft();
      renderProposalItems();
    });
    row.querySelector('[data-remove-item]').addEventListener("click", () => {
      state.proposalItems = state.proposalItems.filter((entry) => entry.id !== item.id);
      saveProposalDraft();
      renderProposalItems();
    });
  });
  const totals = proposalTotals();
  $("#proposalSubtotal").textContent = formatMoney(totals.subtotal);
  $("#proposalDiscountRow").hidden = totals.discount <= 0;
  $("#proposalDiscountAmount").textContent = `−${formatMoney(totals.discount)}`;
  $("#proposalTotal").textContent = formatMoney(totals.total);
}

function proposalFormData() {
  return {
    name: $("#proposalClientName").value.trim(),
    phone: $("#proposalClientPhone").value.trim(),
    email: $("#proposalClientEmail").value.trim(),
    address: $("#proposalClientAddress").value.trim(),
    validity: Math.min(90, Math.max(1, Number($("#proposalValidity").value) || 14)),
    note: $("#proposalNote").value.trim(),
  };
}

function saveProposalDraft() {
  if (!$("#proposalClientName")) return;
  localStorage.setItem("ecosoftcrm_proposal_draft_v1", JSON.stringify({ form: proposalFormData(), discount: $("#proposalDiscount").value, items: state.proposalItems }));
}

function restoreProposalDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem("ecosoftcrm_proposal_draft_v1") || "null");
    if (!draft) return;
    state.proposalItems = Array.isArray(draft.items) ? draft.items.slice(0, 100) : [];
    const fields = { proposalClientName: "name", proposalClientPhone: "phone", proposalClientEmail: "email", proposalClientAddress: "address", proposalValidity: "validity", proposalNote: "note" };
    for (const [id, key] of Object.entries(fields)) if (draft.form?.[key] != null) $(`#${id}`).value = draft.form[key];
    if (draft.discount != null) $("#proposalDiscount").value = draft.discount;
  } catch {
    localStorage.removeItem("ecosoftcrm_proposal_draft_v1");
  }
}

function proposalNumber() {
  const now = new Date();
  const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const time = `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
  return `КП-${date}-${time}`;
}

function buildProposalDocument() {
  if (!state.proposalItems.length) {
    toast("Додайте хоча б одну позицію обладнання.");
    return false;
  }
  const client = proposalFormData();
  const totals = proposalTotals();
  const created = new Date();
  const validUntil = new Date(created.getTime() + client.validity * 86400000);
  const number = proposalNumber();
  $("#proposalDocument").innerHTML = `
    <header class="proposal-doc-header"><img class="proposal-doc-logo" src="/ecosoft-logo.jpg" alt="Ecosoft"><div class="proposal-doc-meta"><strong>${number}</strong>Дата: ${formatPlainDate(created)}<br>Дійсна до: ${formatPlainDate(validUntil)}</div></header>
    <h1 class="proposal-doc-title">Комерційна пропозиція</h1>
    <p class="proposal-doc-intro">Обладнання для очищення води Ecosoft. Ціни сформовані за актуальним каталогом sofiivkawater.com.</p>
    <section class="proposal-doc-client">
      <div><span>Клієнт / компанія</span><strong>${escapeHtml(client.name || "Не вказано")}</strong></div>
      <div><span>Телефон</span><strong>${escapeHtml(client.phone || "Не вказано")}</strong></div>
      <div><span>Email</span><strong>${escapeHtml(client.email || "Не вказано")}</strong></div>
      <div><span>Об’єкт</span><strong>${escapeHtml(client.address || "Не вказано")}</strong></div>
    </section>
    <table class="proposal-doc-table"><thead><tr><th>№</th><th>Обладнання</th><th>К-сть</th><th>Ціна</th><th>Сума</th></tr></thead><tbody>${state.proposalItems.map((item, index) => `<tr><td>${index + 1}</td><td><span class="proposal-doc-product">${escapeHtml(item.name)}</span><span class="proposal-doc-sku">${escapeHtml(item.sku || "")}</span></td><td>${item.quantity}</td><td>${formatMoney(item.price)}</td><td>${formatMoney(item.price * item.quantity)}</td></tr>`).join("")}</tbody></table>
    <div class="proposal-doc-total"><div><span>Сума обладнання</span><strong>${formatMoney(totals.subtotal)}</strong></div>${totals.discount ? `<div><span>Знижка ${totals.discountPercent}%</span><strong>−${formatMoney(totals.discount)}</strong></div>` : ""}<div class="grand"><span>Разом</span><strong>${formatMoney(totals.total)}</strong></div></div>
    ${client.note ? `<div class="proposal-doc-note"><strong>Примітка</strong><br>${escapeHtml(client.note)}</div>` : ""}
    <footer class="proposal-doc-footer"><div><strong>Софіївська вода</strong><br>Офіційне обладнання Ecosoft<br>sofiivkawater.com</div><div>+380 50 358 22 84<br>+380 73 889 64 94</div><div>Умови монтажу, доставки та оплати<br>узгоджуються з менеджером.</div></footer>`;
  $("#proposalDocument").dataset.proposalNumber = number;
  return true;
}

function previewProposal() {
  if (!buildProposalDocument()) return;
  $("#proposalPreviewDialog").showModal();
}

async function downloadProposal() {
  if (!buildProposalDocument()) return;
  if (typeof window.html2pdf !== "function") {
    document.body.classList.add("printing-proposal");
    window.print();
    setTimeout(() => document.body.classList.remove("printing-proposal"), 500);
    toast("Відкрито друк — виберіть «Зберегти як PDF».");
    return;
  }
  const button = $("#downloadProposalButton");
  const previewButton = $("#downloadProposalFromPreview");
  button.disabled = true;
  previewButton.disabled = true;
  const clientName = proposalFormData().name.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 50);
  const filename = `${$("#proposalDocument").dataset.proposalNumber}${clientName ? `-${clientName}` : ""}.pdf`;
  try {
    await window.html2pdf().set({
      margin: 0,
      filename,
      image: { type: "jpeg", quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff" },
      jsPDF: { unit: "px", format: [794, 1123], orientation: "portrait", hotfixes: ["px_scaling"] },
      pagebreak: { mode: ["css", "legacy"] },
    }).from($("#proposalDocument")).save();
    toast("Комерційну пропозицію сформовано.");
  } catch {
    toast("Не вдалося сформувати PDF. Повторіть спробу.");
  } finally {
    button.disabled = false;
    previewButton.disabled = false;
  }
}

function clearProposal() {
  if (state.proposalItems.length && !window.confirm("Очистити всю комплектацію комерційної пропозиції?")) return;
  state.proposalItems = [];
  saveProposalDraft();
  renderProposalItems();
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
  $("#refreshCatalogButton").addEventListener("click", () => loadCatalog(true).catch(showCatalogError));
  $("#proposalCatalogSearch").addEventListener("input", debounce(renderProposalCatalog, 180));
  $("#proposalCategoryFilter").addEventListener("change", renderProposalCatalog);
  $("#proposalDiscount").addEventListener("input", () => { saveProposalDraft(); renderProposalItems(); });
  $$('[id^="proposalClient"], #proposalValidity, #proposalNote').forEach((field) => field.addEventListener("input", saveProposalDraft));
  $("#clearProposalButton").addEventListener("click", clearProposal);
  $("#previewProposalButton").addEventListener("click", previewProposal);
  $("#downloadProposalButton").addEventListener("click", downloadProposal);
  $("#downloadProposalFromPreview").addEventListener("click", downloadProposal);
  $$('[data-close-proposal]').forEach((button) => button.addEventListener("click", () => $("#proposalPreviewDialog").close()));
  $("#selectionSampleButton").addEventListener("click", () => $("#selectionFrame").contentWindow?.loadSample?.());
  $("#selectionManagerButton").addEventListener("click", () => $("#selectionFrame").contentWindow?.openManagerSettings?.());
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
  restoreProposalDraft();
  renderProposalItems();
  await loadBootstrap();
  await loadDashboard();
  setInterval(() => {
    if (state.proposalLoaded) loadCatalog().catch(() => {});
  }, 5 * 60 * 1000);
}

init().catch(showLoadError);
