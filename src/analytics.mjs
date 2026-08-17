import crypto from "node:crypto";

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}
function normalizedPhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizedEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizedName(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function unixSeconds(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : Math.floor(Date.now() / 1000);
}

function stableClientId(deal) {
  if (deal.ga_client_id) return deal.ga_client_id;
  const digest = crypto.createHash("sha256").update(deal.customer_id).digest();
  return `${digest.readUInt32BE(0)}.${digest.readUInt32BE(4)}`;
}

function analyticsItems(deal) {
  return (deal.items || []).map((item) => ({
    item_id: item.sku || item.id,
    item_name: item.name,
    price: Number(item.price) || 0,
    quantity: Math.max(1, Number(item.quantity) || 1),
  }));
}

function metaUserData(deal) {
  const userData = {};
  const phone = normalizedPhone(deal.customer_phone);
  const email = normalizedEmail(deal.customer_email);
  const nameParts = normalizedName(deal.customer_name).split(" ").filter(Boolean);
  if (phone) userData.ph = [sha256(phone)];
  if (email) userData.em = [sha256(email)];
  if (nameParts[0]) userData.fn = [sha256(nameParts[0])];
  if (nameParts.length > 1) userData.ln = [sha256(nameParts.at(-1))];
  if (deal.fbp) userData.fbp = deal.fbp;
  if (deal.fbc) userData.fbc = deal.fbc;
  if (deal.client_ip) userData.client_ip_address = deal.client_ip;
  if (deal.user_agent) userData.client_user_agent = deal.user_agent;
  userData.external_id = [sha256(deal.customer_id)];
  return userData;
}

async function sendMeta(deal, kind, env) {
  const pixelId = env.META_PIXEL_ID;
  const accessToken = env.META_CAPI_ACCESS_TOKEN;
  if (!pixelId || !accessToken) return { provider: "meta", state: "unconfigured" };

  const eventName = kind === "purchase" ? "Purchase" : "Lead";
  const eventId = kind === "purchase" ? `purchase-${deal.id}` : (deal.lead_event_id || `lead-${deal.id}`);
  const eventTime = kind === "purchase" ? deal.completed_at : deal.created_at;
  const contents = (deal.items || []).map((item) => ({
    id: item.sku || item.id,
    quantity: Math.max(1, Number(item.quantity) || 1),
    item_price: Number(item.price) || 0,
  }));
  const customData = {
    currency: deal.currency || "UAH",
    value: Number(deal.total) || 0,
    content_type: "product",
  };
  if (contents.length) {
    customData.contents = contents;
    customData.content_ids = contents.map((item) => item.id);
    customData.num_items = contents.reduce((sum, item) => sum + item.quantity, 0);
  }

  const body = {
    data: [{
      event_name: eventName,
      event_time: unixSeconds(eventTime),
      event_id: eventId,
      action_source: "website",
      event_source_url: deal.landing_page || env.CRM_STORE_URL || "https://sofiivkawater.com/",
      user_data: metaUserData(deal),
      custom_data: customData,
    }],
  };
  if (env.META_TEST_EVENT_CODE) body.test_event_code = env.META_TEST_EVENT_CODE;
  const version = env.META_GRAPH_API_VERSION || "v23.0";
  const endpoint = new URL(`https://graph.facebook.com/${version}/${pixelId}/events`);
  endpoint.searchParams.set("access_token", accessToken);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Meta CAPI ${response.status}: ${detail.slice(0, 400)}`);
  }
  return { provider: "meta", state: "sent" };
}

async function sendGa4(deal, kind, env) {
  const measurementId = env.GA4_MEASUREMENT_ID;
  const apiSecret = env.GA4_API_SECRET;
  if (!measurementId || !apiSecret) return { provider: "ga4", state: "unconfigured" };

  const items = analyticsItems(deal);
  const params = {
    currency: deal.currency || "UAH",
    value: Number(deal.total) || 0,
    engagement_time_msec: 1,
    source: deal.utm_source || deal.source || "website",
    medium: deal.utm_medium || "website",
  };
  if (items.length) params.items = items;
  if (kind === "purchase") params.transaction_id = deal.external_id || deal.id;
  else params.lead_id = deal.external_id || deal.id;

  const endpoint = new URL("https://www.google-analytics.com/mp/collect");
  endpoint.searchParams.set("measurement_id", measurementId);
  endpoint.searchParams.set("api_secret", apiSecret);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: stableClientId(deal),
      user_id: deal.customer_id,
      timestamp_micros: String(unixSeconds(kind === "purchase" ? deal.completed_at : deal.created_at) * 1_000_000),
      events: [{
        name: kind === "purchase" ? "purchase" : "generate_lead",
        params,
      }],
    }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`GA4 MP ${response.status}: ${detail.slice(0, 400)}`);
  }
  return { provider: "ga4", state: "sent" };
}

export function trackingConfigured(env = process.env) {
  return {
    meta: Boolean(env.META_PIXEL_ID && env.META_CAPI_ACCESS_TOKEN),
    ga4: Boolean(env.GA4_MEASUREMENT_ID && env.GA4_API_SECRET),
  };
}

export async function dispatchConversion(deal, kind, env = process.env) {
  const results = await Promise.allSettled([
    sendMeta(deal, kind, env),
    sendGa4(deal, kind, env),
  ]);
  const errors = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
  const values = results
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value);
  const configured = values.some((value) => value.state !== "unconfigured") || errors.length > 0;
  if (errors.length) return { state: "failed", error: errors.join(" | "), providers: values };
  return {
    state: configured ? "sent" : "unconfigured",
    error: null,
    providers: values,
  };
}
