import fsp from "node:fs/promises";
import path from "node:path";

const DEFAULT_TTL_MS = 5 * 60 * 1000;

function text(value, max = 1000) {
  return String(value ?? "").trim().slice(0, max);
}

function absoluteHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

export function normalizeCatalogPayload(payload) {
  if (!payload || !Array.isArray(payload.products)) throw new Error("invalid_catalog_payload");
  const seen = new Set();
  const products = [];
  for (const item of payload.products) {
    const sku = text(item?.sku, 100);
    const slug = text(item?.slug, 200);
    const id = text(item?.id || sku || slug, 200);
    const name = text(item?.name, 400);
    const price = Number(item?.price);
    if (!id || !name || !Number.isFinite(price) || price < 0 || seen.has(id)) continue;
    seen.add(id);
    products.push({
      id,
      sku,
      slug,
      name,
      category: text(item?.category, 100),
      categoryName: text(item?.categoryName || item?.category, 200),
      price,
      oldPrice: Number.isFinite(Number(item?.oldPrice)) && Number(item.oldPrice) > price ? Number(item.oldPrice) : null,
      currency: text(item?.currency || payload.currency || "UAH", 8),
      inStock: Boolean(item?.inStock),
      ctaType: text(item?.ctaType, 20),
      description: text(item?.description, 2000),
      image: absoluteHttpUrl(item?.image),
      url: absoluteHttpUrl(item?.url),
    });
  }
  if (!products.length) throw new Error("empty_catalog");
  return products;
}

export function createCatalogService({
  url,
  cachePath,
  ttlMs = DEFAULT_TTL_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  let memory = null;
  let pending = null;

  async function readDiskCache() {
    if (!cachePath) return null;
    try {
      const stored = JSON.parse(await fsp.readFile(cachePath, "utf8"));
      const products = normalizeCatalogPayload(stored);
      return { products, syncedAt: text(stored.syncedAt, 40) || null };
    } catch {
      return null;
    }
  }

  async function writeDiskCache(result) {
    if (!cachePath) return;
    await fsp.mkdir(path.dirname(cachePath), { recursive: true });
    await fsp.writeFile(cachePath, JSON.stringify({ ...result, ok: true }, null, 2), "utf8");
  }

  async function sync() {
    if (!url) throw new Error("catalog_url_missing");
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json", "User-Agent": "SofiivkaWaterCRM/1.0" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error(`catalog_http_${response.status}`);
    const products = normalizeCatalogPayload(await response.json());
    const result = { products, syncedAt: new Date().toISOString() };
    memory = { ...result, fetchedAt: Date.now() };
    await writeDiskCache(result).catch(() => {});
    return { ...result, stale: false, source: "website" };
  }

  async function getCatalog({ force = false } = {}) {
    if (!force && memory && Date.now() - memory.fetchedAt < ttlMs) {
      return { products: memory.products, syncedAt: memory.syncedAt, stale: false, source: "memory" };
    }
    if (!pending) pending = sync().finally(() => { pending = null; });
    try {
      return await pending;
    } catch (error) {
      if (memory) return { products: memory.products, syncedAt: memory.syncedAt, stale: true, source: "memory", warning: error.message };
      const disk = await readDiskCache();
      if (disk) {
        memory = { ...disk, fetchedAt: 0 };
        return { ...disk, stale: true, source: "disk", warning: error.message };
      }
      throw error;
    }
  }

  return { getCatalog };
}
