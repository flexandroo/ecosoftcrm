import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  clearSessionCookie,
  createSessionToken,
  hashPassword,
  hashToken,
  parseCookies,
  safeUser,
  sessionCookie,
  verifyPassword,
} from "./src/auth.mjs";
import { dispatchConversion, trackingConfigured } from "./src/analytics.mjs";
import {
  DEAL_STATUSES,
  DEAL_TYPES,
  PAYMENT_METHODS,
  PAYMENT_METHOD_IDS,
  PAYMENT_STATUSES,
  PAYMENT_STATUS_IDS,
  STATUS_IDS,
  TYPE_IDS,
} from "./src/constants.mjs";
import { normalizePhone, openCrmDatabase } from "./src/db.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");
const HOST = process.env.CRM_HOST || "127.0.0.1";
const PORT = Number(process.env.CRM_PORT || 3100);
const BASE_URL = process.env.CRM_BASE_URL || `http://${HOST}:${PORT}`;
const DATABASE_PATH = process.env.CRM_DATABASE_PATH || path.join(ROOT, "data", "ecosoftcrm.sqlite");
const BACKUP_DIR = process.env.CRM_BACKUP_DIR || path.join(ROOT, "backups");
const INTAKE_TOKEN = process.env.CRM_INTAKE_TOKEN || "";
const SESSION_DAYS = Math.min(30, Math.max(1, Number(process.env.SESSION_DAYS || 14)));
const MAX_JSON_BYTES = 1_000_000;

const db = openCrmDatabase(DATABASE_PATH);
const loginAttempts = new Map();

const MIME = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

function securityHeaders(contentType = "application/json; charset=utf-8") {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob: https:",
      "connect-src 'self'",
      "worker-src 'self' blob: https://cdnjs.cloudflare.com",
    ].join("; "),
  };
}

function json(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { ...securityHeaders(), ...extraHeaders });
  res.end(JSON.stringify(body));
}

function redirect(res, location) {
  res.writeHead(302, { ...securityHeaders("text/plain; charset=utf-8"), Location: location });
  res.end("Redirecting");
}

function clean(value, max = 500) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function bodyJson(req) {
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > MAX_JSON_BYTES) throw Object.assign(new Error("payload_too_large"), { status: 413 });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) throw Object.assign(new Error("payload_too_large"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("bad_json"), { status: 400 });
  }
}

function requestIp(req) {
  return clean(String(req.headers["x-forwarded-for"] || "").split(",")[0] || req.socket.remoteAddress, 80);
}

function rateAllowed(key, limit, windowMs) {
  const timestamp = Date.now();
  const record = loginAttempts.get(key);
  if (!record || record.resetAt <= timestamp) {
    loginAttempts.set(key, { count: 1, resetAt: timestamp + windowMs });
    return true;
  }
  record.count += 1;
  return record.count <= limit;
}

function sessionUser(req) {
  const token = parseCookies(req.headers.cookie).ecosoftcrm_session;
  if (!token) return null;
  const session = db.getSession(hashToken(token));
  return session ? safeUser(session) : null;
}

function requireUser(req, res) {
  const user = sessionUser(req);
  if (!user) json(res, 401, { ok: false, error: "unauthorized" });
  return user;
}

function verifyOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(BASE_URL).origin;
  } catch {
    return false;
  }
}

function bearerToken(req) {
  const header = String(req.headers.authorization || "");
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function validIntake(body, req) {
  const type = TYPE_IDS.has(body.type) ? body.type : null;
  const customer = body.customer && typeof body.customer === "object" ? body.customer : {};
  const phone = clean(customer.phone, 32);
  if (!type || normalizePhone(phone).length < 10) {
    throw Object.assign(new Error("invalid_intake"), { status: 422 });
  }
  const items = Array.isArray(body.items) ? body.items.slice(0, 50).map((item) => ({
    sku: clean(item.sku, 100),
    name: clean(item.name || item.sku || "Товар", 300),
    quantity: Math.min(100, Math.max(1, Math.floor(number(item.quantity, 1)))),
    price: Math.max(0, number(item.price)),
  })) : [];
  const attr = body.attribution && typeof body.attribution === "object" ? body.attribution : {};
  return {
    externalId: clean(body.externalId, 100) || null,
    type,
    eventId: clean(body.eventId, 120) || null,
    customer: {
      name: clean(customer.name || "Без імені", 120),
      phone,
      email: clean(customer.email, 254),
      city: clean(customer.city, 120),
      address: clean(customer.address, 400),
    },
    items,
    total: Math.max(0, number(body.total)),
    currency: clean(body.currency || "UAH", 8),
    paymentMethod: PAYMENT_METHOD_IDS.has(body.paymentMethod) ? body.paymentMethod : "none",
    paymentStatus: PAYMENT_STATUS_IDS.has(body.paymentStatus)
      ? body.paymentStatus
      : (type === "order" ? "unpaid" : "not_required"),
    deliveryAddress: clean(body.deliveryAddress || customer.address, 400),
    comment: clean(body.comment || body.message, 3000),
    message: clean(body.message, 3000),
    source: clean(body.source || "website", 120),
    sourceDetail: clean(body.sourceDetail, 300),
    attribution: {
      landingPage: clean(attr.landingPage, 1000),
      referrer: clean(attr.referrer, 1000),
      utmSource: clean(attr.utmSource, 200),
      utmMedium: clean(attr.utmMedium, 200),
      utmCampaign: clean(attr.utmCampaign, 300),
      utmContent: clean(attr.utmContent, 300),
      utmTerm: clean(attr.utmTerm, 300),
      fbclid: clean(attr.fbclid, 500),
      fbp: clean(attr.fbp, 200),
      fbc: clean(attr.fbc, 500),
      gclid: clean(attr.gclid, 500),
      gaClientId: clean(attr.gaClientId, 200),
    },
    clientIp: clean(body.clientIp || requestIp(req), 80),
    userAgent: clean(body.userAgent || req.headers["user-agent"], 500),
  };
}

function sanitizeDealChanges(body) {
  const changes = {};
  if (body.status !== undefined) {
    if (!STATUS_IDS.has(body.status)) throw Object.assign(new Error("invalid_status"), { status: 422 });
    changes.status = body.status;
  }
  if (body.managerId !== undefined) changes.managerId = clean(body.managerId, 100) || null;
  if (body.paymentMethod !== undefined) {
    if (!PAYMENT_METHOD_IDS.has(body.paymentMethod)) throw Object.assign(new Error("invalid_payment_method"), { status: 422 });
    changes.paymentMethod = body.paymentMethod;
  }
  if (body.paymentStatus !== undefined) {
    if (!PAYMENT_STATUS_IDS.has(body.paymentStatus)) throw Object.assign(new Error("invalid_payment_status"), { status: 422 });
    changes.paymentStatus = body.paymentStatus;
  }
  if (body.deliveryAddress !== undefined) changes.deliveryAddress = clean(body.deliveryAddress, 400);
  if (body.comment !== undefined) changes.comment = clean(body.comment, 3000);
  if (body.total !== undefined) changes.total = Math.max(0, number(body.total));
  if (body.note !== undefined) changes.note = clean(body.note, 1000);
  return changes;
}

async function serveFile(res, filePath, cache = false) {
  const resolved = path.resolve(filePath);
  const allowedRoots = [path.resolve(PUBLIC_DIR), path.resolve(ROOT)];
  if (!allowedRoots.some((root) => resolved.startsWith(`${root}${path.sep}`))) {
    return json(res, 404, { ok: false, error: "not_found" });
  }
  try {
    const stat = await fsp.stat(resolved);
    if (!stat.isFile()) throw new Error("not_file");
    const contentType = MIME[path.extname(resolved).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, {
      ...securityHeaders(contentType),
      "Content-Length": stat.size,
      "Cache-Control": cache ? "public, max-age=3600" : "no-store",
    });
    fs.createReadStream(resolved).pipe(res);
  } catch {
    json(res, 404, { ok: false, error: "not_found" });
  }
}

async function sendTracking(deal, kind) {
  const result = await dispatchConversion(deal, kind);
  db.markTracking(deal.id, kind, result.state, result.error);
  return result;
}

async function route(req, res) {
  const url = new URL(req.url, BASE_URL);
  const pathname = decodeURIComponent(url.pathname);

  if (req.method === "GET" && pathname === "/api/health") {
    return json(res, 200, { ok: true, service: "ecosoftcrm", tracking: trackingConfigured() });
  }

  if (req.method === "POST" && pathname === "/api/v1/intake") {
    if (!INTAKE_TOKEN || !safeEqual(bearerToken(req), INTAKE_TOKEN)) {
      return json(res, 401, { ok: false, error: "unauthorized" });
    }
    const payload = validIntake(await bodyJson(req), req);
    const deal = db.createIntake(payload);
    if (!deal.duplicate) {
      const tracking = await sendTracking(deal, "lead");
      return json(res, 201, { ok: true, dealId: deal.id, duplicate: false, tracking: tracking.state });
    }
    return json(res, 200, { ok: true, dealId: deal.id, duplicate: true });
  }

  if (req.method === "POST" && pathname === "/api/auth/login") {
    if (!verifyOrigin(req)) return json(res, 403, { ok: false, error: "invalid_origin" });
    const ip = requestIp(req);
    if (!rateAllowed(`login:${ip}`, 8, 15 * 60 * 1000)) {
      return json(res, 429, { ok: false, error: "rate_limited" });
    }
    const body = await bodyJson(req);
    const email = clean(body.email, 254).toLowerCase();
    const user = db.findUserByEmail(email);
    const valid = user ? await verifyPassword(String(body.password || ""), user.password_hash) : false;
    if (!valid) return json(res, 401, { ok: false, error: "invalid_credentials" });
    const token = createSessionToken();
    const maxAge = SESSION_DAYS * 24 * 60 * 60;
    db.createSession(hashToken(token), user.id, new Date(Date.now() + maxAge * 1000).toISOString());
    db.markLogin(user.id);
    return json(res, 200, { ok: true, user: safeUser(user) }, { "Set-Cookie": sessionCookie(token, maxAge) });
  }

  if (req.method === "POST" && pathname === "/api/auth/logout") {
    const token = parseCookies(req.headers.cookie).ecosoftcrm_session;
    if (token) db.deleteSession(hashToken(token));
    return json(res, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
  }

  if (req.method === "GET" && pathname === "/api/auth/me") {
    const user = sessionUser(req);
    return user ? json(res, 200, { ok: true, user }) : json(res, 401, { ok: false, error: "unauthorized" });
  }

  if (pathname.startsWith("/api/")) {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && !verifyOrigin(req)) {
      return json(res, 403, { ok: false, error: "invalid_origin" });
    }
    const user = requireUser(req, res);
    if (!user) return;

    if (req.method === "POST" && pathname === "/api/auth/change-password") {
      const body = await bodyJson(req);
      const stored = db.findUserById(user.id);
      if (!stored || !await verifyPassword(String(body.currentPassword || ""), stored.password_hash)) {
        return json(res, 422, { ok: false, error: "invalid_current_password" });
      }
      const nextPassword = String(body.newPassword || "");
      if (nextPassword.length < 12) return json(res, 422, { ok: false, error: "weak_password" });
      db.updatePassword(user.id, await hashPassword(nextPassword));
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && pathname === "/api/meta") {
      return json(res, 200, {
        ok: true,
        statuses: DEAL_STATUSES,
        types: DEAL_TYPES,
        paymentMethods: PAYMENT_METHODS,
        paymentStatuses: PAYMENT_STATUSES,
        users: db.listUsers(),
        tracking: trackingConfigured(),
      });
    }

    if (req.method === "GET" && pathname === "/api/dashboard") {
      return json(res, 200, { ok: true, ...db.dashboard() });
    }

    if (req.method === "GET" && pathname === "/api/deals") {
      const result = db.listDeals({
        status: clean(url.searchParams.get("status"), 50),
        type: clean(url.searchParams.get("type"), 50),
        search: clean(url.searchParams.get("q"), 200),
        limit: number(url.searchParams.get("limit"), 100),
        offset: number(url.searchParams.get("offset"), 0),
      });
      return json(res, 200, { ok: true, ...result });
    }

    if (req.method === "POST" && pathname === "/api/deals") {
      const payload = validIntake({ ...(await bodyJson(req)), type: "manual" }, req);
      const deal = db.createManualDeal(payload, user.id);
      return json(res, 201, { ok: true, deal });
    }

    const dealMatch = pathname.match(/^\/api\/deals\/([^/]+)$/);
    if (dealMatch && req.method === "GET") {
      const deal = db.getDeal(dealMatch[1]);
      return deal ? json(res, 200, { ok: true, deal }) : json(res, 404, { ok: false, error: "not_found" });
    }
    if (dealMatch && req.method === "PATCH") {
      const current = db.getDeal(dealMatch[1]);
      if (!current) return json(res, 404, { ok: false, error: "not_found" });
      const changes = sanitizeDealChanges(await bodyJson(req));
      let deal = db.updateDeal(dealMatch[1], changes, user.id);
      let tracking = null;
      if (deal.status === "completed" && current.status !== "completed") {
        tracking = await sendTracking(deal, "purchase");
        deal = db.getDeal(deal.id);
      }
      return json(res, 200, { ok: true, deal, tracking });
    }

    const retryMatch = pathname.match(/^\/api\/deals\/([^/]+)\/retry-tracking$/);
    if (retryMatch && req.method === "POST") {
      const deal = db.getDeal(retryMatch[1]);
      if (!deal) return json(res, 404, { ok: false, error: "not_found" });
      const kind = deal.status === "completed" ? "purchase" : "lead";
      const tracking = await sendTracking(deal, kind);
      return json(res, 200, { ok: true, tracking, deal: db.getDeal(deal.id) });
    }

    if (req.method === "GET" && pathname === "/api/customers") {
      const customers = db.listCustomers({ search: clean(url.searchParams.get("q"), 200) });
      return json(res, 200, { ok: true, customers });
    }

    return json(res, 404, { ok: false, error: "not_found" });
  }

  if (pathname === "/login" || pathname === "/login.html") {
    if (sessionUser(req)) return redirect(res, "/app");
    return serveFile(res, path.join(PUBLIC_DIR, "login.html"));
  }
  if (pathname === "/" || pathname === "/app") {
    if (!sessionUser(req)) return redirect(res, "/login");
    return serveFile(res, path.join(PUBLIC_DIR, "app.html"));
  }
  if (pathname === "/tools" || pathname === "/tools/") {
    if (!sessionUser(req)) return redirect(res, "/login");
    return serveFile(res, path.join(ROOT, "index.html"));
  }
  if (pathname === "/ecosoft-logo.jpg") {
    return serveFile(res, path.join(ROOT, "ecosoft-logo.jpg"), true);
  }
  if (pathname.startsWith("/assets/")) {
    const relative = pathname.slice("/assets/".length);
    if (relative.includes("..")) return json(res, 404, { ok: false, error: "not_found" });
    return serveFile(res, path.join(PUBLIC_DIR, relative), true);
  }
  return json(res, 404, { ok: false, error: "not_found" });
}

async function ensureAdmin() {
  const email = clean(process.env.CRM_ADMIN_EMAIL, 254).toLowerCase();
  const password = String(process.env.CRM_ADMIN_PASSWORD || "");
  const name = clean(process.env.CRM_ADMIN_NAME || "Адміністратор", 120);
  if (!email) throw new Error("CRM_ADMIN_EMAIL is required.");
  if (db.findUserByEmail(email)) return;
  if (password.length < 12) throw new Error("CRM_ADMIN_PASSWORD must contain at least 12 characters for first start.");
  db.createUser({ email, name, role: "admin", passwordHash: await hashPassword(password) });
  console.log(`[crm] Initial administrator created: ${email}`);
}

async function backup() {
  try {
    await fsp.mkdir(BACKUP_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const target = path.join(BACKUP_DIR, `ecosoftcrm-${date}.sqlite`);
    await db.raw.backup(target);
    const files = (await fsp.readdir(BACKUP_DIR))
      .filter((name) => /^ecosoftcrm-\d{4}-\d{2}-\d{2}\.sqlite$/.test(name))
      .sort()
      .reverse();
    for (const old of files.slice(14)) await fsp.unlink(path.join(BACKUP_DIR, old));
  } catch (error) {
    console.error("[crm] backup failed", error);
  }
}

await ensureAdmin();
await backup();
setInterval(backup, 24 * 60 * 60 * 1000).unref();

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    console.error("[crm] request failed", error);
    if (!res.headersSent) json(res, error.status || 500, { ok: false, error: error.message || "internal_error" });
    else res.destroy();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[crm] listening on http://${HOST}:${PORT}`);
});

function shutdown(signal) {
  console.log(`[crm] ${signal}, shutting down`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
