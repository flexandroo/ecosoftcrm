import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hashPassword, verifyPassword } from "../src/auth.mjs";
import { openCrmDatabase } from "../src/db.mjs";

test("passwords use a salted scrypt hash", async () => {
  const hash = await hashPassword("A-strong-test-password-2026");
  assert.equal(await verifyPassword("A-strong-test-password-2026", hash), true);
  assert.equal(await verifyPassword("wrong-password", hash), false);
});
test("intake is idempotent and status history is recorded", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ecosoftcrm-test-"));
  const database = openCrmDatabase(path.join(directory, "crm.sqlite"));
  t.after(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const passwordHash = await hashPassword("Another-strong-test-password-2026");
  const admin = database.createUser({
    email: "admin@example.com",
    name: "Admin",
    role: "admin",
    passwordHash,
  });
  const payload = {
    externalId: "ECO-TEST-1",
    eventId: "lead-ECO-TEST-1",
    type: "order",
    customer: { name: "Тестовий клієнт", phone: "+380501112233" },
    items: [{ sku: "SKU-1", name: "Фільтр", quantity: 2, price: 1500 }],
    total: 3000,
    currency: "UAH",
    paymentMethod: "cod",
    paymentStatus: "unpaid",
    source: "website",
    attribution: { utmSource: "facebook", landingPage: "https://sofiivkawater.com/" },
  };

  const created = database.createIntake(payload);
  assert.equal(created.duplicate, false);
  assert.equal(created.id, "ECO-TEST-1");
  assert.equal(created.items.length, 1);
  assert.equal(created.status, "new");

  const duplicate = database.createIntake(payload);
  assert.equal(duplicate.duplicate, true);
  assert.equal(database.listDeals().total, 1);

  const completed = database.updateDeal(
    created.id,
    { status: "completed", paymentStatus: "paid", note: "Оплату отримано" },
    admin.id,
  );
  assert.equal(completed.status, "completed");
  assert.equal(completed.payment_status, "paid");
  assert.equal(completed.purchase_tracking_state, "pending");
  assert.equal(completed.history.length, 2);
  assert.equal(database.dashboard().totals.completed_deals, 1);

  const deletedDeal = database.deleteDeal(created.id);
  assert.equal(deletedDeal.dealId, created.id);
  assert.equal(database.getDeal(created.id), null);
  assert.equal(database.listCustomers().length, 1);

  const second = database.createIntake({
    ...payload,
    externalId: "ECO-TEST-2",
  });
  const customer = database.listCustomers()[0];
  const deletedCustomer = database.deleteCustomer(customer.id);
  assert.equal(deletedCustomer.deletedDeals, 1);
  assert.equal(database.getDeal(second.id), null);
  assert.equal(database.listCustomers().length, 0);
});
