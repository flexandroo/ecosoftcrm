import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";

function now() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function normalizePhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10 && digits.startsWith("0")) digits = `38${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) digits = `3${digits}`;
  return digits;
}

export function openCrmDatabase(databasePath) {
  const resolved = path.resolve(databasePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'manager',
      password_hash TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      normalized_phone TEXT NOT NULL UNIQUE,
      email TEXT,
      city TEXT,
      address TEXT,
      source_first TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deals (
      id TEXT PRIMARY KEY,
      external_id TEXT UNIQUE,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      customer_id TEXT NOT NULL REFERENCES customers(id),
      manager_id TEXT REFERENCES users(id),
      total REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'UAH',
      payment_method TEXT NOT NULL DEFAULT 'none',
      payment_status TEXT NOT NULL DEFAULT 'unpaid',
      delivery_address TEXT,
      comment TEXT,
      source TEXT,
      source_detail TEXT,
      landing_page TEXT,
      referrer TEXT,
      utm_source TEXT,
      utm_medium TEXT,
      utm_campaign TEXT,
      utm_content TEXT,
      utm_term TEXT,
      fbclid TEXT,
      fbp TEXT,
      fbc TEXT,
      gclid TEXT,
      ga_client_id TEXT,
      client_ip TEXT,
      user_agent TEXT,
      lead_event_id TEXT,
      lead_tracking_state TEXT NOT NULL DEFAULT 'pending',
      purchase_tracking_state TEXT NOT NULL DEFAULT 'not_ready',
      tracking_error TEXT,
      raw_payload TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS deal_items (
      id TEXT PRIMARY KEY,
      deal_id TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
      sku TEXT,
      name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      price REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS status_history (
      id TEXT PRIMARY KEY,
      deal_id TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
      from_status TEXT,
      to_status TEXT NOT NULL,
      user_id TEXT REFERENCES users(id),
      note TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      deal_id TEXT REFERENCES deals(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      description TEXT,
      due_at TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      assignee_user_id TEXT REFERENCES users(id),
      created_by_user_id TEXT REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS deals_status_idx ON deals(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS deals_type_idx ON deals(type, created_at DESC);
    CREATE INDEX IF NOT EXISTS deals_customer_idx ON deals(customer_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS history_deal_idx ON status_history(deal_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
  `);

  const api = {
    raw: db,
    path: resolved,

    close() {
      db.close();
    },

    findUserByEmail(email) {
      return db.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE AND active = 1").get(email);
    },

    findUserById(userId) {
      return db.prepare("SELECT * FROM users WHERE id = ? AND active = 1").get(userId);
    },

    createUser({ email, name, role = "manager", passwordHash }) {
      const userId = id("usr");
      const timestamp = now();
      db.prepare(`
        INSERT INTO users (id, email, name, role, password_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(userId, email.toLowerCase(), name, role, passwordHash, timestamp, timestamp);
      return api.findUserById(userId);
    },

    listUsers() {
      return db.prepare(`
        SELECT id, email, name, role, active, created_at, last_login_at
        FROM users ORDER BY active DESC, name COLLATE NOCASE
      `).all();
    },

    updatePassword(userId, passwordHash) {
      db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
        .run(passwordHash, now(), userId);
    },

    markLogin(userId) {
      db.prepare("UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?")
        .run(now(), now(), userId);
    },

    createSession(tokenHash, userId, expiresAt) {
      db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now());
      db.prepare(`
        INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
        VALUES (?, ?, ?, ?)
      `).run(tokenHash, userId, expiresAt, now());
    },

    getSession(tokenHash) {
      return db.prepare(`
        SELECT s.token_hash, s.expires_at, u.*
        FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1
      `).get(tokenHash, now());
    },

    deleteSession(tokenHash) {
      db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    },

    createIntake(payload) {
      const transaction = db.transaction((input) => {
        if (input.externalId) {
          const duplicate = db.prepare("SELECT id FROM deals WHERE external_id = ?").get(input.externalId);
          if (duplicate) return { ...api.getDeal(duplicate.id), duplicate: true };
        }

        const timestamp = now();
        const phone = String(input.customer.phone || "").trim();
        const phoneKey = normalizePhone(phone);
        let customer = db.prepare("SELECT * FROM customers WHERE normalized_phone = ?").get(phoneKey);
        if (customer) {
          db.prepare(`
            UPDATE customers SET
              name = COALESCE(NULLIF(?, ''), name),
              phone = COALESCE(NULLIF(?, ''), phone),
              email = COALESCE(NULLIF(?, ''), email),
              city = COALESCE(NULLIF(?, ''), city),
              address = COALESCE(NULLIF(?, ''), address),
              updated_at = ?
            WHERE id = ?
          `).run(
            input.customer.name,
            phone,
            input.customer.email || "",
            input.customer.city || "",
            input.customer.address || input.deliveryAddress || "",
            timestamp,
            customer.id,
          );
          customer = db.prepare("SELECT * FROM customers WHERE id = ?").get(customer.id);
        } else {
          const customerId = id("cus");
          db.prepare(`
            INSERT INTO customers (
              id, name, phone, normalized_phone, email, city, address, source_first, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            customerId,
            input.customer.name || "Без імені",
            phone,
            phoneKey,
            input.customer.email || null,
            input.customer.city || null,
            input.customer.address || input.deliveryAddress || null,
            input.source || null,
            timestamp,
            timestamp,
          );
          customer = db.prepare("SELECT * FROM customers WHERE id = ?").get(customerId);
        }

        const dealId = input.externalId || id("deal");
        const attribution = input.attribution || {};
        db.prepare(`
          INSERT INTO deals (
            id, external_id, type, status, customer_id, total, currency,
            payment_method, payment_status, delivery_address, comment, source, source_detail,
            landing_page, referrer, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
            fbclid, fbp, fbc, gclid, ga_client_id, client_ip, user_agent,
            lead_event_id, raw_payload, created_at, updated_at
          ) VALUES (
            ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          )
        `).run(
          dealId,
          input.externalId || null,
          input.type,
          customer.id,
          Number(input.total) || 0,
          input.currency || "UAH",
          input.paymentMethod || "none",
          input.paymentStatus || (input.type === "order" ? "unpaid" : "not_required"),
          input.deliveryAddress || input.customer.address || null,
          input.comment || input.message || null,
          input.source || "website",
          input.sourceDetail || null,
          attribution.landingPage || null,
          attribution.referrer || null,
          attribution.utmSource || null,
          attribution.utmMedium || null,
          attribution.utmCampaign || null,
          attribution.utmContent || null,
          attribution.utmTerm || null,
          attribution.fbclid || null,
          attribution.fbp || null,
          attribution.fbc || null,
          attribution.gclid || null,
          attribution.gaClientId || null,
          input.clientIp || null,
          input.userAgent || null,
          input.eventId || null,
          JSON.stringify(input),
          timestamp,
          timestamp,
        );

        const insertItem = db.prepare(`
          INSERT INTO deal_items (id, deal_id, sku, name, quantity, price)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const item of input.items || []) {
          insertItem.run(
            id("itm"),
            dealId,
            item.sku || null,
            item.name || item.sku || "Товар",
            Math.max(1, Math.floor(Number(item.quantity) || 1)),
            Math.max(0, Number(item.price) || 0),
          );
        }

        const creationNote = input.source === "manual"
          ? "Створено менеджером вручну"
          : "Автоматично створено із сайту";
        db.prepare(`
          INSERT INTO status_history (id, deal_id, from_status, to_status, note, created_at)
          VALUES (?, ?, NULL, 'new', ?, ?)
        `).run(id("hst"), dealId, creationNote, timestamp);

        return { ...api.getDeal(dealId), duplicate: false };
      });
      return transaction(payload);
    },

    createManualDeal(input, userId) {
      const payload = {
        ...input,
        externalId: input.externalId || `CRM-${Date.now()}`,
        type: input.type || "manual",
        source: input.source || "manual",
      };
      const deal = api.createIntake(payload);
      db.prepare(`
        UPDATE deals SET manager_id = ?, lead_tracking_state = 'not_required' WHERE id = ?
      `).run(userId, deal.id);
      return api.getDeal(deal.id);
    },

    listDeals({ status, type, search, limit = 100, offset = 0 } = {}) {
      const where = [];
      const params = [];
      if (status && status !== "all") {
        where.push("d.status = ?");
        params.push(status);
      }
      if (type === "lead") {
        where.push("d.type != 'order'");
      } else if (type && type !== "all") {
        where.push("d.type = ?");
        params.push(type);
      }
      if (search) {
        where.push("(c.name LIKE ? OR c.phone LIKE ? OR d.id LIKE ? OR d.external_id LIKE ?)");
        const query = `%${search}%`;
        params.push(query, query, query, query);
      }
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const rows = db.prepare(`
        SELECT d.*, c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email,
               u.name AS manager_name,
               (SELECT COUNT(*) FROM deal_items i WHERE i.deal_id = d.id) AS item_count
        FROM deals d
        JOIN customers c ON c.id = d.customer_id
        LEFT JOIN users u ON u.id = d.manager_id
        ${whereSql}
        ORDER BY CASE d.status WHEN 'new' THEN 0 WHEN 'contacting' THEN 1 ELSE 2 END, d.created_at DESC
        LIMIT ? OFFSET ?
      `).all(...params, Math.min(500, Math.max(1, limit)), Math.max(0, offset));
      const total = db.prepare(`
        SELECT COUNT(*) AS count FROM deals d JOIN customers c ON c.id = d.customer_id ${whereSql}
      `).get(...params).count;
      return { rows, total };
    },

    getDeal(dealId) {
      const deal = db.prepare(`
        SELECT d.*, c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email,
               c.city AS customer_city, c.address AS customer_address, u.name AS manager_name
        FROM deals d
        JOIN customers c ON c.id = d.customer_id
        LEFT JOIN users u ON u.id = d.manager_id
        WHERE d.id = ?
      `).get(dealId);
      if (!deal) return null;
      deal.items = db.prepare("SELECT * FROM deal_items WHERE deal_id = ? ORDER BY rowid").all(dealId);
      deal.history = db.prepare(`
        SELECT h.*, u.name AS user_name
        FROM status_history h LEFT JOIN users u ON u.id = h.user_id
        WHERE h.deal_id = ? ORDER BY h.created_at DESC
      `).all(dealId);
      return deal;
    },

    updateDeal(dealId, changes, userId) {
      const transaction = db.transaction(() => {
        const current = db.prepare("SELECT * FROM deals WHERE id = ?").get(dealId);
        if (!current) return null;
        const nextStatus = changes.status ?? current.status;
        const completedAt = nextStatus === "completed"
          ? (current.completed_at || now())
          : null;
        const purchaseState = nextStatus === "completed"
          ? (current.purchase_tracking_state === "sent" ? "sent" : "pending")
          : "not_ready";
        db.prepare(`
          UPDATE deals SET
            status = ?, manager_id = ?, payment_method = ?, payment_status = ?,
            delivery_address = ?, comment = ?, total = ?, completed_at = ?,
            purchase_tracking_state = ?, updated_at = ?
          WHERE id = ?
        `).run(
          nextStatus,
          changes.managerId === undefined ? current.manager_id : (changes.managerId || null),
          changes.paymentMethod ?? current.payment_method,
          changes.paymentStatus ?? current.payment_status,
          changes.deliveryAddress ?? current.delivery_address,
          changes.comment ?? current.comment,
          changes.total === undefined ? current.total : Math.max(0, Number(changes.total) || 0),
          completedAt,
          purchaseState,
          now(),
          dealId,
        );
        if (nextStatus !== current.status || changes.note) {
          db.prepare(`
            INSERT INTO status_history (id, deal_id, from_status, to_status, user_id, note, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            id("hst"),
            dealId,
            current.status,
            nextStatus,
            userId,
            changes.note || null,
            now(),
          );
        }
        return api.getDeal(dealId);
      });
      return transaction();
    },

    listCustomers({ search, limit = 100 } = {}) {
      const params = [];
      const where = search ? "WHERE c.name LIKE ? OR c.phone LIKE ? OR c.email LIKE ?" : "";
      if (search) {
        const query = `%${search}%`;
        params.push(query, query, query);
      }
      return db.prepare(`
        SELECT c.*,
          COUNT(d.id) AS deal_count,
          COALESCE(SUM(CASE WHEN d.status = 'completed' THEN d.total ELSE 0 END), 0) AS completed_revenue,
          MAX(d.created_at) AS last_deal_at
        FROM customers c LEFT JOIN deals d ON d.customer_id = c.id
        ${where}
        GROUP BY c.id
        ORDER BY COALESCE(MAX(d.created_at), c.created_at) DESC
        LIMIT ?
      `).all(...params, Math.min(500, Math.max(1, limit)));
    },

    dashboard() {
      const byStatus = db.prepare(`
        SELECT status, COUNT(*) AS count, COALESCE(SUM(total), 0) AS value
        FROM deals GROUP BY status
      `).all();
      const byType = db.prepare(`
        SELECT type, COUNT(*) AS count FROM deals GROUP BY type
      `).all();
      const totals = db.prepare(`
        SELECT
          COUNT(*) AS total_deals,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_deals,
          COALESCE(SUM(CASE WHEN status = 'completed' THEN total ELSE 0 END), 0) AS completed_revenue,
          SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS new_deals,
          SUM(CASE WHEN status = 'new' AND type = 'order' THEN 1 ELSE 0 END) AS new_orders,
          SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_deals
        FROM deals
      `).get();
      const sources = db.prepare(`
        SELECT COALESCE(NULLIF(utm_source, ''), NULLIF(source, ''), 'Невідомо') AS source,
               COUNT(*) AS count,
               SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
               COALESCE(SUM(CASE WHEN status = 'completed' THEN total ELSE 0 END), 0) AS revenue
        FROM deals
        GROUP BY COALESCE(NULLIF(utm_source, ''), NULLIF(source, ''), 'Невідомо')
        ORDER BY count DESC LIMIT 8
      `).all();
      const recent = api.listDeals({ limit: 8 }).rows;
      return { totals, byStatus, byType, sources, recent };
    },

    markTracking(dealId, kind, state, error = null) {
      const field = kind === "purchase" ? "purchase_tracking_state" : "lead_tracking_state";
      db.prepare(`UPDATE deals SET ${field} = ?, tracking_error = ?, updated_at = ? WHERE id = ?`)
        .run(state, error ? String(error).slice(0, 1000) : null, now(), dealId);
    },

    getTrackingCandidates(kind, limit = 20) {
      if (kind === "purchase") {
        return db.prepare(`
          SELECT id FROM deals
          WHERE status = 'completed' AND purchase_tracking_state IN ('pending', 'failed')
          ORDER BY completed_at ASC LIMIT ?
        `).all(limit).map((row) => api.getDeal(row.id));
      }
      return db.prepare(`
        SELECT id FROM deals
        WHERE lead_tracking_state IN ('pending', 'failed')
        ORDER BY created_at ASC LIMIT ?
      `).all(limit).map((row) => api.getDeal(row.id));
    },
  };

  return api;
}
