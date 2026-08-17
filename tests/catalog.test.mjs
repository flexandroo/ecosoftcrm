import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCatalogPayload } from "../src/catalog.mjs";

test("normalizes a website catalog and skips invalid rows", () => {
  const result = normalizeCatalogPayload({
    currency: "UAH",
    products: [
      { id: "A-1", sku: "A-1", slug: "filter-a", name: "Filter A", price: 1250, inStock: true, image: "https://example.com/a.jpg" },
      { id: "broken", name: "Broken", price: -1 },
      { id: "A-1", name: "Duplicate", price: 50 },
    ],
  });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], {
    id: "A-1",
    sku: "A-1",
    slug: "filter-a",
    name: "Filter A",
    category: "",
    categoryName: "",
    price: 1250,
    oldPrice: null,
    currency: "UAH",
    inStock: true,
    ctaType: "",
    description: "",
    image: "https://example.com/a.jpg",
    url: "",
  });
});

test("rejects an empty catalog", () => {
  assert.throws(() => normalizeCatalogPayload({ products: [] }), /empty_catalog/);
});
