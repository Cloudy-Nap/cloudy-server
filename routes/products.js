const express = require('express');
const multer = require('multer');
const path = require('path');
const { parse: parseCsv } = require('csv-parse/sync');
const { getSupabase } = require('../lib/supabaseServer');
const { logActivity } = require('./activities');
const catalogDealsModule = require('./catalogDeals');
const rowToDealProduct = catalogDealsModule.rowToDealProduct;
const isMissingDealsTable = catalogDealsModule.isMissingTableError;

const router = express.Router();

let supabase;
try {
  supabase = getSupabase();
} catch (err) {
  console.warn('[routes/products]', err.message);
}

/** Cloudynap catalog: beds, accessories, furniture, sofacumbed */
const CLOUDYNAP_SOURCES = [
  { table: 'beds', type: 'bed' },
  { table: 'accessories', type: 'accessory' },
  { table: 'sofacumbed', type: 'sofacumbed' },
  { table: 'furniture', type: 'furniture' },
];

const normalizeSortParam = (value) => {
  if (!value) return null;
  const normalized = value.toString().trim().toLowerCase().replace(':', '_');
  if (['price_asc', 'price-low-high', 'price_low_high'].includes(normalized)) {
    return { key: 'price', ascending: true };
  }
  if (['price_desc', 'price-high-low', 'price_high_low'].includes(normalized)) {
    return { key: 'price', ascending: false };
  }
  return null;
};

const coercePriceValue = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const cleaned = value.replace(/[^\d.-]/g, '');
    if (!cleaned) return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const attachType = (records, type) => {
  if (!Array.isArray(records)) return [];
  return records.map((item) => ({
    ...item,
    type,
  }));
};

/** CMS + API: Cloudynap catalog tables (matches public.beds, accessories, furniture, sofacumbed). */
const CLOUDYNAP_CATEGORIES = ['bed', 'accessory', 'furniture', 'sofacumbed'];
const CLOUDYNAP_TABLE = {
  bed: 'beds',
  accessory: 'accessories',
  furniture: 'furniture',
  sofacumbed: 'sofacumbed',
};

/**
 * Supabase Storage bucket names must match Dashboard → Storage exactly (case-sensitive).
 * Env overrides: SUPABASE_STORAGE_BUCKET_BED, _ACCESSORY, _FURNITURE, _SOFACUMBED, or SUPABASE_STORAGE_CATALOG_BUCKET.
 */
const DEFAULT_CLOUDYNAP_STORAGE_BUCKETS = {
  bed: 'Beds',
  accessory: 'Accessories',
  furniture: 'Furniture',
  sofacumbed: 'SofaCumBed',
};

const getCloudynapStorageBucket = (category) => {
  const envSpecific = {
    bed: process.env.SUPABASE_STORAGE_BUCKET_BED,
    accessory: process.env.SUPABASE_STORAGE_BUCKET_ACCESSORY,
    furniture: process.env.SUPABASE_STORAGE_BUCKET_FURNITURE,
    sofacumbed: process.env.SUPABASE_STORAGE_BUCKET_SOFACUMBED,
  }[category];
  if (envSpecific && String(envSpecific).trim()) return String(envSpecific).trim();
  const global = process.env.SUPABASE_STORAGE_CATALOG_BUCKET;
  if (global && String(global).trim()) return String(global).trim();
  return DEFAULT_CLOUDYNAP_STORAGE_BUCKETS[category] || DEFAULT_CLOUDYNAP_STORAGE_BUCKETS.bed;
};

const pickCloudynapStr = (specs, body, ...keys) => {
  for (const k of keys) {
    const raw = specs[k] ?? body[k];
    if (raw === undefined || raw === null) continue;
    const s = normalizeString(raw);
    if (s) return s;
  }
  return null;
};

const pickCloudynapInt = (specs, body, ...keys) => {
  for (const k of keys) {
    const raw = specs[k] ?? body[k];
    if (raw === undefined || raw === null || raw === '') continue;
    const n = parseInt(String(raw).replace(/[^\d-]/g, ''), 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
};

const buildCloudynapRow = (category, body, specs, coverUrl, urls) => {
  const name = normalizeString(body.name);
  const description = normalizeString(body.description);
  const base = {
    name: name || null,
    description: description || null,
    image: coverUrl,
    image_urls: urls,
  };

  if (category === 'bed') {
    /** Sizes & PKR live in `product_variants_bed`; parent row is marketing + media only. */
    return {
      ...base,
      brand: pickCloudynapStr(specs, body, 'brand'),
      series: pickCloudynapStr(specs, body, 'series'),
      features: pickCloudynapStr(specs, body, 'features'),
      benefits: pickCloudynapStr(specs, body, 'benefits'),
      firmness: pickCloudynapStr(specs, body, 'firmness'),
      fabric: pickCloudynapStr(specs, body, 'fabric'),
      warranty: pickCloudynapStr(specs, body, 'warranty'),
    };
  }

  if (category === 'accessory') {
    const p = coercePriceValue(body.price);
    return {
      ...base,
      price: p !== null ? Math.round(p) : null,
      series: pickCloudynapStr(specs, body, 'series'),
      features: pickCloudynapStr(specs, body, 'features'),
      benefits: pickCloudynapStr(specs, body, 'benefits'),
      firmness: pickCloudynapStr(specs, body, 'firmness'),
      fabric: pickCloudynapStr(specs, body, 'fabric'),
      warranty: pickCloudynapStr(specs, body, 'warranty'),
    };
  }

  if (category === 'furniture') {
    const priceText = normalizeString(body.price);
    return {
      ...base,
      price: priceText || null,
      length: pickCloudynapStr(specs, body, 'length'),
      width: pickCloudynapStr(specs, body, 'width'),
      height: pickCloudynapStr(specs, body, 'height'),
      structure: pickCloudynapStr(specs, body, 'structure'),
      fabric: pickCloudynapStr(specs, body, 'fabric'),
      seats: pickCloudynapInt(specs, body, 'seats'),
      material: pickCloudynapStr(specs, body, 'material'),
      warranty: pickCloudynapStr(specs, body, 'warranty'),
    };
  }

  if (category === 'sofacumbed') {
    /** PKR + fabric live in `product_variants_sofacumbed`. */
    return {
      ...base,
      series: pickCloudynapStr(specs, body, 'series'),
      features: pickCloudynapStr(specs, body, 'features'),
      benefits: pickCloudynapStr(specs, body, 'benefits'),
      firmness: pickCloudynapStr(specs, body, 'firmness'),
      warranty: pickCloudynapStr(specs, body, 'warranty'),
    };
  }

  return base;
};

const resolveCloudynapCategoryParam = (param) => {
  const p = normalizeString(param).toLowerCase();
  if (p === 'bed' || p === 'beds' || p === 'matteress' || p === 'mattress' || p === 'mattresses') return 'bed';
  if (p === 'accessory' || p === 'accessories') return 'accessory';
  if (p === 'furniture') return 'furniture';
  if (p === 'sofacumbed' || p === 'sofa-cum-bed' || p === 'sofa_cum_bed') return 'sofacumbed';
  return null;
};

/** Which tables to load for ?subcategory= and legacy ?category= */
const resolveCloudynapPlans = (subRaw, legacyCategoryRaw) => {
  const sub = subRaw ? String(subRaw).trim().toLowerCase() : '';
  const legacy = legacyCategoryRaw ? String(legacyCategoryRaw).trim().toLowerCase() : '';

  if (sub) {
    if (sub === 'matteress') return CLOUDYNAP_SOURCES.filter((p) => p.table === 'beds');
    if (sub === 'pillows') return CLOUDYNAP_SOURCES.filter((p) => p.table === 'accessories');
    if (sub === 'accessories') return CLOUDYNAP_SOURCES.filter((p) => p.table === 'accessories');
    if (sub === 'sofa-cum-bed') return CLOUDYNAP_SOURCES.filter((p) => p.table === 'sofacumbed');
    if (sub === 'furniture') return CLOUDYNAP_SOURCES.filter((p) => p.table === 'furniture');
    return CLOUDYNAP_SOURCES.slice();
  }

  if (
    legacy &&
    ['laptop', 'laptops', 'printer', 'printers', 'scanner', 'scanners', 'notebook', 'notebooks'].includes(legacy)
  ) {
    return [];
  }

  return CLOUDYNAP_SOURCES.slice();
};

/** Attach `variants`, expose listing `price` as minimum variant PKR for sorting/cards. */
const enrichBedCatalogRow = (row) => {
  if (!row || typeof row !== 'object') return row;
  const variants = Array.isArray(row.product_variants_bed) ? row.product_variants_bed : [];
  const rest = { ...row };
  delete rest.product_variants_bed;
  const prices = variants
    .map((v) => coercePriceValue(v?.price))
    .filter((n) => n !== null && Number.isFinite(n));
  const minPrice = prices.length ? Math.min(...prices) : null;
  return { ...rest, variants, price: minPrice };
};

const enrichSofacumbedCatalogRow = (row) => {
  if (!row || typeof row !== 'object') return row;
  const raw = row.product_variants_sofacumbed;
  let variants = [];
  if (Array.isArray(raw)) variants = raw;
  else if (raw && typeof raw === 'object') variants = [raw];
  const rest = { ...row };
  delete rest.product_variants_sofacumbed;
  const prices = variants
    .map((v) => coercePriceValue(v?.price))
    .filter((n) => n !== null && Number.isFinite(n));
  const minPrice = prices.length ? Math.min(...prices) : null;
  return { ...rest, variants, price: minPrice };
};

const parseBedVariantsFromInputs = (specsPayload, body) => {
  let raw = specsPayload?.variants;
  if (raw === undefined && body?.variants !== undefined) {
    const v = body.variants;
    if (typeof v === 'string') {
      try {
        const parsed = JSON.parse(v);
        raw = parsed;
      } catch {
        raw = undefined;
      }
    } else if (Array.isArray(v)) {
      raw = v;
    }
  }
  return Array.isArray(raw) ? raw.filter(Boolean) : [];
};

const normalizeBedVariantForDb = (entry) => {
  if (!entry || typeof entry !== 'object') return null;
  const price = coercePriceValue(entry.price);
  if (price === null) return null;
  return {
    width: pickCloudynapInt(entry, entry, 'width'),
    height: pickCloudynapInt(entry, entry, 'height'),
    length: pickCloudynapInt(entry, entry, 'length'),
    price: Math.round(price),
  };
};

const replaceBedVariants = async (productId, normalizedVariants) => {
  const { error: delErr } = await supabase.from('product_variants_bed').delete().eq('product_id', productId);
  if (delErr) throw delErr;
  if (!normalizedVariants.length) return;
  const rows = normalizedVariants.map((v) => ({
    product_id: productId,
    width: v.width,
    height: v.height,
    length: v.length,
    price: v.price,
  }));
  const { error: insErr } = await supabase.from('product_variants_bed').insert(rows);
  if (insErr) throw insErr;
};

const fetchBedWithVariants = async (id) => {
  const { data: row, error: rowErr } = await supabase.from('beds').select('*').eq('id', id).maybeSingle();
  if (rowErr) throw rowErr;
  if (!row) return null;
  const { data: variantRows, error: varErr } = await supabase
    .from('product_variants_bed')
    .select('*')
    .eq('product_id', id);
  if (varErr) throw varErr;
  return enrichBedCatalogRow({
    ...row,
    product_variants_bed: Array.isArray(variantRows) ? variantRows : [],
  });
};

const sanitizedRowToBedVariant = (sanitized) => {
  const price = coercePriceValue(sanitized.price);
  if (price === null) return null;
  return {
    width: pickCloudynapInt(sanitized, sanitized, 'width'),
    height: pickCloudynapInt(sanitized, sanitized, 'height'),
    length: pickCloudynapInt(sanitized, sanitized, 'length'),
    price: Math.round(price),
  };
};

const normalizeSofacumbedVariantForDb = (entry) => {
  if (!entry || typeof entry !== 'object') return null;
  const price = coercePriceValue(entry.price);
  if (price === null) return null;
  const fabricRaw = normalizeString(entry.fabric);
  return {
    price: Math.round(price),
    fabric: fabricRaw || null,
  };
};

const replaceSofacumbedVariants = async (productId, normalizedVariants) => {
  const { error: delErr } = await supabase
    .from('product_variants_sofacumbed')
    .delete()
    .eq('product_id', productId);
  if (delErr) throw delErr;
  if (!normalizedVariants.length) return;
  const rows = normalizedVariants.map((v) => ({
    product_id: productId,
    price: v.price,
    fabric: v.fabric,
  }));
  const { error: insErr } = await supabase.from('product_variants_sofacumbed').insert(rows);
  if (insErr) throw insErr;
};

const fetchSofacumbedWithVariants = async (id) => {
  const { data: row, error: rowErr } = await supabase.from('sofacumbed').select('*').eq('id', id).maybeSingle();
  if (rowErr) throw rowErr;
  if (!row) return null;
  const { data: variantRows, error: varErr } = await supabase
    .from('product_variants_sofacumbed')
    .select('*')
    .eq('product_id', id);
  if (varErr) throw varErr;
  return enrichSofacumbedCatalogRow({
    ...row,
    product_variants_sofacumbed: Array.isArray(variantRows) ? variantRows : [],
  });
};

const sanitizedRowToSofacumbedVariant = (sanitized) => {
  const price = coercePriceValue(sanitized.price);
  if (price === null) return null;
  const fabricRaw = normalizeString(sanitized.fabric);
  return {
    price: Math.round(price),
    fabric: fabricRaw || null,
  };
};

router.get('/', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    const { sort, category, limit, subcategory } = req.query;
    const sortConfig = normalizeSortParam(sort);
    const parsedLimit = Number(limit);
    const applyLimit = Number.isFinite(parsedLimit) && parsedLimit > 0;

    const subNorm = subcategory ? String(subcategory).trim().toLowerCase() : '';
    if (subNorm === 'deals') {
      const { data, error } = await supabase
        .from('catalog_deals')
        .select('*')
        .eq('is_active', true)
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: false });

      if (error) {
        if (isMissingDealsTable(error)) {
          return res.json([]);
        }
        console.error('Failed to fetch catalog_deals:', error);
        return res.status(500).json({ error: 'Failed to fetch deals' });
      }

      let rows = (data || []).map(rowToDealProduct).filter(Boolean);
      if (sortConfig?.key === 'price') {
        rows = rows.slice().sort((a, b) => {
          const priceA = Number(a.price);
          const priceB = Number(b.price);
          return sortConfig.ascending ? priceA - priceB : priceB - priceA;
        });
      }
      if (applyLimit) {
        rows = rows.slice(0, parsedLimit);
      }
      return res.json(rows);
    }

    const plans = resolveCloudynapPlans(subcategory, category);

    if (plans.length === 0) {
      return res.json([]);
    }

    const responses = await Promise.all(
      plans.map(({ table }) => {
        if (table === 'beds') {
          return supabase.from('beds').select('*');
        }
        if (table === 'sofacumbed') {
          return supabase.from('sofacumbed').select('*');
        }
        return supabase.from(table).select('*');
      }),
    );

    let combined = [];
    for (let index = 0; index < responses.length; index += 1) {
      const { data, error } = responses[index];
      const { type, table } = plans[index];

      if (error) {
        console.error(`Failed to fetch ${table}:`, error);
        return res.status(500).json({ error: 'Failed to fetch products' });
      }

      let rows = attachType(data || [], type);
      if (table === 'beds') {
        const parents = data || [];
        const ids = parents.map((p) => p.id).filter((pid) => pid != null);
        const variantByProductId = {};
        if (ids.length) {
          const { data: allVar, error: varErr } = await supabase
            .from('product_variants_bed')
            .select('*')
            .in('product_id', ids);
          if (varErr) {
            console.error(`Failed to fetch ${table} variants:`, varErr);
            return res.status(500).json({ error: 'Failed to fetch products' });
          }
          for (const v of allVar || []) {
            const pid = v.product_id;
            if (!variantByProductId[pid]) variantByProductId[pid] = [];
            variantByProductId[pid].push(v);
          }
        }
        rows = attachType(parents, type).map((r) =>
          enrichBedCatalogRow({
            ...r,
            product_variants_bed: variantByProductId[r.id] || [],
          }),
        );
      }
      if (table === 'sofacumbed') {
        const parents = data || [];
        const ids = parents.map((p) => p.id).filter((pid) => pid != null);
        const variantByProductId = {};
        if (ids.length) {
          const { data: allVar, error: varErr } = await supabase
            .from('product_variants_sofacumbed')
            .select('*')
            .in('product_id', ids);
          if (varErr) {
            console.error(`Failed to fetch ${table} variants:`, varErr);
            return res.status(500).json({ error: 'Failed to fetch products' });
          }
          for (const v of allVar || []) {
            const pid = v.product_id;
            if (!variantByProductId[pid]) variantByProductId[pid] = [];
            variantByProductId[pid].push(v);
          }
        }
        rows = attachType(parents, type).map((r) =>
          enrichSofacumbedCatalogRow({
            ...r,
            product_variants_sofacumbed: variantByProductId[r.id] || [],
          }),
        );
      }
      /** `pillows` and `accessories` both resolve to the `accessories` table above — no extra name filter. */
      combined = combined.concat(rows);
    }

    if (sortConfig?.key === 'price') {
      combined = combined
        .slice()
        .sort((a, b) => {
          const priceA = coercePriceValue(a.price);
          const priceB = coercePriceValue(b.price);

          if (priceA === null && priceB === null) return 0;
          if (priceA === null) return sortConfig.ascending ? 1 : -1;
          if (priceB === null) return sortConfig.ascending ? -1 : 1;

          return sortConfig.ascending ? priceA - priceB : priceB - priceA;
        });
    } else {
      combined = combined
        .slice()
        .sort((a, b) => {
          const idA = Number(a.id);
          const idB = Number(b.id);
          if (Number.isFinite(idA) && Number.isFinite(idB)) {
            return idA - idB;
          }
          return (a.id || '').toString().localeCompare((b.id || '').toString());
        });
    }

    if (applyLimit) {
      combined = combined.slice(0, parsedLimit);
    }

    res.json(combined);
  } catch (err) {
    console.error('Unexpected error fetching products:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 8 * 1024 * 1024, // 8MB per file
    files: 10,
  },
});

const LAPTOP_SPEC_MAP = {
  processor: 'processor',
  graphics: 'graphics',
  display: 'display',
  memory: 'memory',
  storage: 'storage',
  adapter: 'adapter',
  wifi: 'wifi',
  bluetooth: 'bluetooth',
  camera: 'camera',
  ports: 'port',
  operatingSystem: 'os',
  microphone: 'mic',
  battery: 'battery',
  warranty: 'warranty',
};

const PRINTER_SPEC_MAP = {
  brand: 'brand',
  series: 'series',
  memory: 'memory',
  paperInput: 'paperinput',
  paperOutput: 'paperoutput',
  paperTypes: 'papertypes',
  dimensions: 'dimensions',
  weight: 'weight',
  power: 'power',
  warranty: 'warranty',
  resolution: 'resolution',
  duplex: 'duplex',
  copyFeature: 'copyfeature',
  scanFeature: 'scanfeature',
  wireless: 'wireless',
};

const SCANNER_SPEC_MAP = {
  memory: 'memory',
  paper_types: 'paper_types',
  paper_size: 'paper_size',
  duplex: 'duplex',
  resolution: 'resolution',
  power: 'power',
  weight: 'weight',
  dimensions: 'dimensions',
  color_scan: 'color_scan',
  wireless: 'wireless',
};

const GENERAL_PRODUCT_COLUMNS = [
  'name',
  'brand',
  'model',
  'series',
  'sku',
  'price',
  'stock',
  'description',
  'image',
  'image_urls',
  'featured',
];

const LAPTOP_ALLOWED_COLUMNS = [
  ...GENERAL_PRODUCT_COLUMNS,
  ...Object.values(LAPTOP_SPEC_MAP),
];

const PRINTER_ALLOWED_COLUMNS = [
  ...GENERAL_PRODUCT_COLUMNS,
  ...Object.values(PRINTER_SPEC_MAP),
];

const SCANNER_ALLOWED_COLUMNS = [
  ...GENERAL_PRODUCT_COLUMNS,
  ...Object.values(SCANNER_SPEC_MAP),
];

const parseOptionalBoolean = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return null;
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  }
  return null;
};

const ensureFeaturedLimit = async (tableName, shouldBeFeatured, excludeId = null) => {
  if (!shouldBeFeatured) return;

  let query = supabase
    .from(tableName)
    .select('id', { count: 'exact', head: true })
    .eq('featured', true);

  if (excludeId !== null && excludeId !== undefined) {
    query = query.neq('id', excludeId);
  }

  const { count, error } = await query;
  if (error) {
    throw error;
  }

  if ((count || 0) >= 3) {
    const limitError = new Error('You can feature at most 3 products in this category.');
    limitError.statusCode = 400;
    throw limitError;
  }
};

const LAPTOP_REQUIRED_COLUMNS = ['name', 'brand', 'price'];
const PRINTER_REQUIRED_COLUMNS = ['name', 'brand', 'price'];
const SCANNER_REQUIRED_COLUMNS = ['name', 'brand', 'price'];

const buildColumnLookup = (columnList) => {
  const set = new Set(columnList);
  const lowerCaseMap = columnList.reduce((acc, column) => {
    acc[column.toLowerCase()] = column;
    return acc;
  }, {});
  return { set, lowerCaseMap };
};

const LAPTOP_COLUMN_LOOKUP = buildColumnLookup(LAPTOP_ALLOWED_COLUMNS);
const PRINTER_COLUMN_LOOKUP = buildColumnLookup(PRINTER_ALLOWED_COLUMNS);
const SCANNER_COLUMN_LOOKUP = buildColumnLookup(SCANNER_ALLOWED_COLUMNS);

const normalizeString = (value) => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  return String(value).trim();
};

/** Multipart `category` may be a string or duplicated as an array; normalize for routing. */
const pickBodyCategory = (body) => {
  const raw = body?.category;
  if (raw === undefined || raw === null) return '';
  if (Array.isArray(raw)) {
    const firstNonEmpty = raw.map((x) => normalizeString(x).toLowerCase()).find(Boolean);
    return firstNonEmpty || '';
  }
  return normalizeString(raw).toLowerCase();
};

/**
 * Bulk CSV: `category` should be in the multipart body, but some proxies/clients drop text fields
 * or leave body empty. Also accept `?category=bed` and `X-Bulk-Category: bed`.
 */
const readBulkImportCategory = (req) => {
  const fromBody = pickBodyCategory(req.body);
  if (fromBody) return fromBody;
  const fromQuery = normalizeString(req.query?.category).toLowerCase();
  if (fromQuery) return fromQuery;
  const fromHeader = normalizeString(
    req.get('x-bulk-category') || req.get('X-Bulk-Category'),
  ).toLowerCase();
  if (fromHeader) return fromHeader;
  return '';
};

const resolvePostedCatalogCategory = (body) => {
  const raw = pickBodyCategory(body);
  if (!raw) return { cloud: null, legacy: null };
  const cloud =
    resolveCloudynapCategoryParam(raw) || (CLOUDYNAP_CATEGORIES.includes(raw) ? raw : null);
  const legacy = ['laptop', 'printer', 'scanner'].includes(raw) ? raw : null;
  return { cloud, legacy };
};

const mapSpecs = (category, specs = {}) => {
  let map;
  if (category === 'printer') {
    map = PRINTER_SPEC_MAP;
  } else if (category === 'scanner') {
    map = SCANNER_SPEC_MAP;
  } else {
    map = LAPTOP_SPEC_MAP;
  }
  return Object.entries(specs).reduce((acc, [key, value]) => {
    const target = map[key];
    if (!target) return acc;
    const normalized = normalizeString(value);
    if (!normalized) return acc;
    acc[target] = normalized;
    return acc;
  }, {});
};

const parseLookupId = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : value;
};

const parseSpecsPayload = (raw) => {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch (error) {
      return {};
    }
  }
  return {};
};

const parseExistingImages = (raw) => {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed)) {
      return parsed
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter((value) => value);
    }
  } catch (error) {
    return [];
  }
  return [];
};

const parseImageUrls = (raw) => {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((value) => (typeof value === 'string' ? value.trim() : String(value || '').trim()))
      .filter((value) => value);
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .map((value) => (typeof value === 'string' ? value.trim() : String(value || '').trim()))
          .filter((value) => value);
      }
    } catch (error) {
      // fall through to delimiter split
    }
    return trimmed
      .split(/[;,|]/)
      .map((value) => value.trim())
      .filter((value) => value);
  }

  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return [String(raw)];
  }

  return [];
};

const coerceCsvValue = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const stringValue = String(value).trim();
  return stringValue === '' ? null : stringValue;
};

const sanitizeCsvRow = (row, columnLookup) => {
  const sanitized = {};
  Object.entries(row || {}).forEach(([rawKey, rawValue]) => {
    if (!rawKey) return;
    const trimmedKey = rawKey.trim();
    if (!trimmedKey) return;

    const directMatch = columnLookup.set.has(trimmedKey) ? trimmedKey : null;
    const lookupMatch = columnLookup.lowerCaseMap[trimmedKey.toLowerCase()];
    const column = directMatch || lookupMatch;
    if (!column) return;

    if (column === 'image_urls') {
      const urls = parseImageUrls(rawValue);
      if (urls.length) {
        sanitized[column] = urls;
      }
      return;
    }

    if (column === 'featured') {
      const parsed = parseOptionalBoolean(rawValue);
      if (parsed !== null) {
        sanitized[column] = parsed;
      }
      return;
    }

    const value = coerceCsvValue(rawValue);
    if (value === null) return;
    sanitized[column] = value;
  });
  return sanitized;
};

const REQUIRED_COLUMNS_LOOKUP = {
  laptop: LAPTOP_REQUIRED_COLUMNS,
  printer: PRINTER_REQUIRED_COLUMNS,
  scanner: SCANNER_REQUIRED_COLUMNS,
};

/** DB columns for bulk CSV (Supabase public.beds, accessories, furniture, sofacumbed). */
const CLOUDYNAP_CSV_ALLOWED = {
  bed: [
    'name',
    'description',
    'price',
    'brand',
    'length',
    'width',
    'height',
    'series',
    'features',
    'benefits',
    'firmness',
    'fabric',
    'warranty',
    'image',
    'image_urls',
  ],
  accessory: [
    'name',
    'price',
    'description',
    'series',
    'features',
    'benefits',
    'firmness',
    'fabric',
    'warranty',
    'image',
    'image_urls',
  ],
  furniture: [
    'name',
    'price',
    'description',
    'seats',
    'material',
    'warranty',
    'image',
    'image_urls',
    'width',
    'length',
    'height',
    'structure',
    'fabric',
  ],
  sofacumbed: [
    'name',
    'description',
    'price',
    'series',
    'features',
    'benefits',
    'firmness',
    'fabric',
    'warranty',
    'image',
    'image_urls',
  ],
};

const CLOUDYNAP_CSV_COLUMN_LOOKUPS = {
  bed: buildColumnLookup(CLOUDYNAP_CSV_ALLOWED.bed),
  accessory: buildColumnLookup(CLOUDYNAP_CSV_ALLOWED.accessory),
  furniture: buildColumnLookup(CLOUDYNAP_CSV_ALLOWED.furniture),
  sofacumbed: buildColumnLookup(CLOUDYNAP_CSV_ALLOWED.sofacumbed),
};

const cloudynapCsvHasPrice = (cloudCat, row) => {
  const p = row?.price;
  if (p === undefined || p === null) return false;
  if (typeof p === 'string' && p.trim() === '') return false;
  if (cloudCat === 'bed' || cloudCat === 'accessory' || cloudCat === 'sofacumbed') {
    return coercePriceValue(p) !== null;
  }
  return normalizeString(p) !== '';
};

const cloudynapCsvHasImage = (row) => {
  const cover = normalizeString(row?.image);
  if (cover) return true;
  return Array.isArray(row?.image_urls) && row.image_urls.length > 0;
};

const buildCloudynapRowFromCsv = (cloudCat, sanitized) => {
  let coverUrl = normalizeString(sanitized.image);
  const urls = Array.isArray(sanitized.image_urls) ? [...sanitized.image_urls] : [];
  if (!coverUrl && urls.length) {
    coverUrl = normalizeString(urls[0]);
  }
  if (!urls.length && coverUrl) {
    urls.push(coverUrl);
  }
  return buildCloudynapRow(cloudCat, sanitized, sanitized, coverUrl, urls);
};

const uploadImages = async (category, files) => {
  if (!files || !files.length) {
    return { urls: [], coverUrl: '' };
  }

  let bucket;
  if (CLOUDYNAP_CATEGORIES.includes(category)) {
    bucket = getCloudynapStorageBucket(category);
  } else if (category === 'printer') {
    bucket = 'printer_images';
  } else if (category === 'scanner') {
    bucket = 'scanner_images';
  } else {
    bucket = 'laptop_images';
  }

  const uploads = await Promise.all(
    files.map(async (file, index) => {
      const extension = path.extname(file.originalname) || '.jpg';
      const safeBase = path.basename(file.originalname, extension).replace(/[^a-zA-Z0-9-_]/g, '').slice(0, 32);
      const filePath = `${category}/${Date.now()}-${index}-${safeBase}${extension}`;

      const { error: uploadError } = await supabase.storage
        .from(bucket)
        .upload(filePath, file.buffer, {
          contentType: file.mimetype || 'application/octet-stream',
          cacheControl: '3600',
          upsert: false,
        });

      if (uploadError) {
        throw new Error(`Failed to upload image: ${uploadError.message || uploadError}`);
      }

      const {
        data: { publicUrl },
      } = supabase.storage.from(bucket).getPublicUrl(filePath);

      return publicUrl;
    })
  );

  return {
    urls: uploads,
    coverUrl: uploads[0] || '',
  };
};

router.post('/', upload.array('images', 10), async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({ error: 'Database not configured' });
    }
    const { cloud: cloudCategory, legacy: legacyCategory } = resolvePostedCatalogCategory(req.body);

    if (cloudCategory) {
      const category = cloudCategory;
      const name = normalizeString(req.body.name);

      if (category === 'bed') {
        if (!name) {
          return res.status(400).json({ error: 'Product name is required.' });
        }

        const specsPayload = parseSpecsPayload(req.body.specs);
        const variantEntries = parseBedVariantsFromInputs(specsPayload, req.body)
          .map(normalizeBedVariantForDb)
          .filter(Boolean);
        if (!variantEntries.length) {
          return res.status(400).json({
            error: 'Add at least one mattress size with a valid price (PKR).',
          });
        }

        const files = req.files || [];
        if (!files.length) {
          return res.status(400).json({ error: 'Please upload at least one product image.' });
        }

        const { urls, coverUrl } = await uploadImages(category, files);
        if (!coverUrl) {
          return res.status(500).json({ error: 'Unable to determine cover image URL.' });
        }

        const insertPayload = buildCloudynapRow(category, req.body, specsPayload, coverUrl, urls);

        const { data, error } = await supabase.from('beds').insert(insertPayload).select('*').single();

        if (error) {
          console.error('Failed to create Cloudynap product:', error);
          return res.status(500).json({
            error:
              error?.message ||
              error?.details ||
              error?.hint ||
              'Failed to create product. Check column types and Storage: set SUPABASE_STORAGE_CATALOG_BUCKET to your bucket id, bucket must exist and allow uploads.',
          });
        }

        try {
          await replaceBedVariants(data.id, variantEntries);
        } catch (variantErr) {
          console.error('Failed to insert mattress variants:', variantErr);
          await supabase.from('beds').delete().eq('id', data.id);
          return res.status(500).json({
            error: variantErr?.message || 'Failed to save mattress variants.',
          });
        }

        let full;
        try {
          full = await fetchBedWithVariants(data.id);
        } catch (fetchErr) {
          console.error('Failed to load mattress after create:', fetchErr);
          full = { ...data, variants: [], price: null };
        }

        const userFromBody = req.body?.cmsUserId || req.body?.cmsUserName || req.body?.cmsUserRole
          ? {
              userId: req.body.cmsUserId,
              userName: req.body.cmsUserName,
              userRole: req.body.cmsUserRole,
            }
          : null;

        await logActivity(
          {
            type: 'product_created',
            action: `Created new ${category}: ${full.name || name}`,
            entityType: 'product',
            entityId: full.id,
            entityName: full.name || name,
            details: { category, price: full.price },
            userId: userFromBody?.userId,
            userName: userFromBody?.userName,
            userRole: userFromBody?.userRole,
          },
          req,
        );

        return res.status(201).json({ product: { ...full, type: category } });
      }

      if (category === 'sofacumbed') {
        if (!name) {
          return res.status(400).json({ error: 'Product name is required.' });
        }

        const specsPayload = parseSpecsPayload(req.body.specs);
        const variantEntries = parseBedVariantsFromInputs(specsPayload, req.body)
          .map(normalizeSofacumbedVariantForDb)
          .filter(Boolean);
        if (!variantEntries.length) {
          return res.status(400).json({
            error: 'Add at least one sofa cum bed option with a valid price (PKR).',
          });
        }

        const files = req.files || [];
        if (!files.length) {
          return res.status(400).json({ error: 'Please upload at least one product image.' });
        }

        const { urls, coverUrl } = await uploadImages(category, files);
        if (!coverUrl) {
          return res.status(500).json({ error: 'Unable to determine cover image URL.' });
        }

        const insertPayload = buildCloudynapRow(category, req.body, specsPayload, coverUrl, urls);

        const { data, error } = await supabase.from('sofacumbed').insert(insertPayload).select('*').single();

        if (error) {
          console.error('Failed to create Cloudynap product:', error);
          return res.status(500).json({
            error:
              error?.message ||
              error?.details ||
              error?.hint ||
              'Failed to create product. Check column types and Storage: set SUPABASE_STORAGE_CATALOG_BUCKET to your bucket id, bucket must exist and allow uploads.',
          });
        }

        try {
          await replaceSofacumbedVariants(data.id, variantEntries);
        } catch (variantErr) {
          console.error('Failed to insert sofa cum bed variants:', variantErr);
          await supabase.from('sofacumbed').delete().eq('id', data.id);
          return res.status(500).json({
            error: variantErr?.message || 'Failed to save sofa cum bed variants.',
          });
        }

        let full;
        try {
          full = await fetchSofacumbedWithVariants(data.id);
        } catch (fetchErr) {
          console.error('Failed to load sofa cum bed after create:', fetchErr);
          full = { ...data, variants: [], price: null };
        }

        const userFromBody = req.body?.cmsUserId || req.body?.cmsUserName || req.body?.cmsUserRole
          ? {
              userId: req.body.cmsUserId,
              userName: req.body.cmsUserName,
              userRole: req.body.cmsUserRole,
            }
          : null;

        await logActivity(
          {
            type: 'product_created',
            action: `Created new ${category}: ${full.name || name}`,
            entityType: 'product',
            entityId: full.id,
            entityName: full.name || name,
            details: { category, price: full.price },
            userId: userFromBody?.userId,
            userName: userFromBody?.userName,
            userRole: userFromBody?.userRole,
          },
          req,
        );

        return res.status(201).json({ product: { ...full, type: category } });
      }

      const priceRaw = normalizeString(req.body.price);
      if (!name || !priceRaw) {
        return res.status(400).json({ error: 'Product name and price are required.' });
      }

      const specsPayload = parseSpecsPayload(req.body.specs);
      const files = req.files || [];
      if (!files.length) {
        return res.status(400).json({ error: 'Please upload at least one product image.' });
      }

      const { urls, coverUrl } = await uploadImages(category, files);
      if (!coverUrl) {
        return res.status(500).json({ error: 'Unable to determine cover image URL.' });
      }

      const tableName = CLOUDYNAP_TABLE[category];
      const insertPayload = buildCloudynapRow(category, req.body, specsPayload, coverUrl, urls);

      const { data, error } = await supabase
        .from(tableName)
        .insert(insertPayload)
        .select('*')
        .single();

      if (error) {
        console.error('Failed to create Cloudynap product:', error);
        return res.status(500).json({
          error:
            error?.message ||
            error?.details ||
            error?.hint ||
            'Failed to create product. Check column types and Storage: set SUPABASE_STORAGE_CATALOG_BUCKET to your bucket id, bucket must exist and allow uploads.',
        });
      }

      const userFromBody = req.body?.cmsUserId || req.body?.cmsUserName || req.body?.cmsUserRole
        ? {
            userId: req.body.cmsUserId,
            userName: req.body.cmsUserName,
            userRole: req.body.cmsUserRole,
          }
        : null;

      await logActivity(
        {
          type: 'product_created',
          action: `Created new ${category}: ${data.name || name}`,
          entityType: 'product',
          entityId: data.id,
          entityName: data.name || name,
          details: { category, price: data.price },
          userId: userFromBody?.userId,
          userName: userFromBody?.userName,
          userRole: userFromBody?.userRole,
        },
        req,
      );

      return res.status(201).json({ product: { ...data, type: category } });
    }

    if (!legacyCategory) {
      return res.status(400).json({
        error: 'Invalid or missing product category.',
        hint:
          'Cloudynap: bed, accessory, furniture, sofacumbed (or beds, accessories, sofa-cum-bed). Legacy CSV: laptop, printer, scanner.',
      });
    }

    const category = legacyCategory;

    const details = {
      name: normalizeString(req.body.name),
      brand: normalizeString(req.body.brand),
      model: normalizeString(req.body.model),
      series: normalizeString(req.body.series),
      sku: normalizeString(req.body.sku),
      price: normalizeString(req.body.price),
      stock: normalizeString(req.body.stock),
      description: normalizeString(req.body.description),
    };

    if (!details.name || !details.price) {
      return res.status(400).json({ error: 'Product name and price are required.' });
    }

    if (!details.brand) {
      return res.status(400).json({ error: 'Brand is required.' });
    }

    const requestedFeatured = parseOptionalBoolean(req.body.featured);
    const featuredFlag = requestedFeatured === null ? false : requestedFeatured;

    const specsPayload = parseSpecsPayload(req.body.specs);
    const specs = mapSpecs(category, specsPayload);

    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ error: 'Please upload at least one product image.' });
    }

    const { urls, coverUrl } = await uploadImages(category, files);

    if (!coverUrl) {
      return res.status(500).json({ error: 'Unable to determine cover image URL.' });
    }

    let tableName;
    if (category === 'printer') {
      tableName = 'printers';
    } else if (category === 'scanner') {
      tableName = 'scanners';
    } else {
      tableName = 'laptops';
    }

    if (tableName === 'laptops') {
      await ensureFeaturedLimit(tableName, featuredFlag);
    }

    const insertPayload = {
      ...details,
      ...specs,
      image: coverUrl,
      image_urls: urls,
      featured: featuredFlag,
    };

    const { data, error } = await supabase
      .from(tableName)
      .insert(insertPayload)
      .select('*')
      .single();

    if (error) {
      console.error('Failed to create product:', error);
      return res.status(500).json({
        error:
          error?.message ||
          error?.details ||
          error?.hint ||
          'Failed to create product. Check server logs for details.',
      });
    }

    // Log activity - get user info from body (FormData) or headers
    const userFromBody = req.body?.cmsUserId || req.body?.cmsUserName || req.body?.cmsUserRole
      ? {
          userId: req.body.cmsUserId,
          userName: req.body.cmsUserName,
          userRole: req.body.cmsUserRole,
        }
      : null;

    await logActivity(
      {
        type: 'product_created',
        action: `Created new ${category}: ${data.name || details.name}`,
        entityType: 'product',
        entityId: data.id,
        entityName: data.name || details.name,
        details: {
          category,
          brand: data.brand || details.brand,
          price: data.price || details.price,
          stock: data.stock || details.stock,
        },
        userId: userFromBody?.userId,
        userName: userFromBody?.userName,
        userRole: userFromBody?.userRole,
      },
      req,
    );

    res.status(201).json({ product: data });
  } catch (err) {
    console.error('Unexpected error creating product:', err);
    if (err?.statusCode === 400) {
      res.status(400).json({ error: err.message });
    } else {
      res.status(500).json({ error: err?.message || 'Internal server error.' });
    }
  }
});

router.post('/bulk/csv', upload.single('file'), async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({ error: 'Database not configured' });
    }
    const rawCategory = readBulkImportCategory(req);
    const cloudCat = resolveCloudynapCategoryParam(rawCategory);
    const legacyCat = ['laptop', 'printer', 'scanner'].includes(rawCategory) ? rawCategory : null;

    if (!cloudCat && !legacyCat) {
      return res.status(400).json({
        error:
          'Invalid or missing category. Cloudynap: bed, accessory, furniture, sofacumbed (or beds, accessories, sofa-cum-bed). Legacy: laptop, printer, scanner.',
      });
    }

    if (!req.file || !req.file.buffer || !req.file.buffer.length) {
      return res.status(400).json({ error: 'Please upload a CSV file.' });
    }

    let records;
    try {
      const csvString = req.file.buffer.toString('utf-8');
      records = parseCsv(csvString, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      });
    } catch (error) {
      return res.status(400).json({
        error: `Unable to parse CSV file: ${error.message || 'Invalid format.'}`,
      });
    }

    if (!Array.isArray(records) || !records.length) {
      return res.status(400).json({ error: 'CSV file does not contain any rows.' });
    }

    /** Cloudynap catalog CSV: column names match DB (beds, accessories, furniture, sofacumbed). */
    if (cloudCat) {
      const columnLookup = CLOUDYNAP_CSV_COLUMN_LOOKUPS[cloudCat];
      const tableName = CLOUDYNAP_TABLE[cloudCat];

      const rowErrors = [];

      if (cloudCat === 'bed') {
        const parsedRows = [];

        records.forEach((row, index) => {
          const rowNumber = index + 2;
          const sanitized = sanitizeCsvRow(row, columnLookup);
          const displayName = sanitized.name || row.name || null;

          if (Array.isArray(sanitized.image_urls) && sanitized.image_urls.length) {
            if (!sanitized.image || typeof sanitized.image !== 'string' || !sanitized.image.trim()) {
              sanitized.image = sanitized.image_urls[0];
            }
          }

          if (!Object.keys(sanitized).length) {
            rowErrors.push({
              row: rowNumber,
              name: displayName,
              error: 'Row does not contain any recognized columns.',
            });
            return;
          }

          const missing = [];
          if (!normalizeString(sanitized.name)) missing.push('name');
          if (!cloudynapCsvHasPrice('bed', sanitized)) missing.push('price');

          if (missing.length) {
            rowErrors.push({
              row: rowNumber,
              name: displayName,
              error: `Missing required: ${missing.join(', ')}`,
            });
            return;
          }

          parsedRows.push({
            payload: sanitized,
            rowNumber,
            displayName,
          });
        });

        if (!parsedRows.length) {
          return res.status(400).json({
            error: 'No valid rows found in CSV.',
            details: rowErrors,
          });
        }

        const groups = new Map();
        for (const entry of parsedRows) {
          const key = normalizeString(entry.payload.name).toLowerCase();
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(entry);
        }

        const insertedRows = [];
        const insertionErrors = [];

        for (const [, groupRows] of groups) {
          groupRows.sort((a, b) => a.rowNumber - b.rowNumber);

          let masterPayload = { ...groupRows[0].payload };
          let mergedImages = false;
          for (const gr of groupRows) {
            if (cloudynapCsvHasImage(gr.payload)) {
              masterPayload = { ...masterPayload, ...gr.payload };
              mergedImages = true;
              break;
            }
          }

          if (!mergedImages) {
            groupRows.forEach((gr) => {
              rowErrors.push({
                row: gr.rowNumber,
                name: gr.displayName,
                error:
                  'Missing required: image or image_urls (provide on at least one row per product name).',
              });
            });
            continue;
          }

          const variants = groupRows.map((gr) => sanitizedRowToBedVariant(gr.payload)).filter(Boolean);
          if (variants.length !== groupRows.length) {
            groupRows.forEach((gr) => {
              rowErrors.push({
                row: gr.rowNumber,
                name: gr.displayName,
                error: 'Invalid variant price.',
              });
            });
            continue;
          }

          try {
            const insertPayload = buildCloudynapRowFromCsv('bed', masterPayload);
            const { data, error } = await supabase.from('beds').insert(insertPayload).select('*').single();
            if (error) throw error;
            await replaceBedVariants(data.id, variants);
            const enriched = await fetchBedWithVariants(data.id);
            insertedRows.push({
              row: groupRows[0].rowNumber,
              name: enriched?.name || masterPayload.name,
              record: enriched,
              variantRows: groupRows.map((g) => g.rowNumber),
              variantCount: variants.length,
            });
          } catch (error) {
            insertionErrors.push({
              row: groupRows[0].rowNumber,
              name: groupRows[0].displayName,
              error: error?.message || error?.details || 'Failed to insert grouped mattress rows.',
            });
          }
        }

        if (insertedRows.length > 0) {
          await logActivity(
            {
              type: 'bulk_import',
              action: `Imported ${insertedRows.length} mattress product(s) (${parsedRows.length} CSV row(s)) via bulk CSV`,
              entityType: 'product',
              entityId: null,
              entityName: `${insertedRows.length} bed(s)`,
              details: {
                category: cloudCat,
                table: tableName,
                count: insertedRows.length,
                attempted: records.length,
                failed: rowErrors.length + insertionErrors.length,
              },
            },
            req,
          );
        }

        return res.json({
          summary: {
            category: cloudCat,
            attempted: records.length,
            processed: parsedRows.length,
            inserted: insertedRows.length,
            failed: rowErrors.length + insertionErrors.length,
          },
          inserted: insertedRows,
          rowValidationErrors: rowErrors,
          insertionErrors,
        });
      }

      if (cloudCat === 'sofacumbed') {
        const parsedRows = [];

        records.forEach((row, index) => {
          const rowNumber = index + 2;
          const sanitized = sanitizeCsvRow(row, columnLookup);
          const displayName = sanitized.name || row.name || null;

          if (Array.isArray(sanitized.image_urls) && sanitized.image_urls.length) {
            if (!sanitized.image || typeof sanitized.image !== 'string' || !sanitized.image.trim()) {
              sanitized.image = sanitized.image_urls[0];
            }
          }

          if (!Object.keys(sanitized).length) {
            rowErrors.push({
              row: rowNumber,
              name: displayName,
              error: 'Row does not contain any recognized columns.',
            });
            return;
          }

          const missing = [];
          if (!normalizeString(sanitized.name)) missing.push('name');
          if (!cloudynapCsvHasPrice('sofacumbed', sanitized)) missing.push('price');

          if (missing.length) {
            rowErrors.push({
              row: rowNumber,
              name: displayName,
              error: `Missing required: ${missing.join(', ')}`,
            });
            return;
          }

          parsedRows.push({
            payload: sanitized,
            rowNumber,
            displayName,
          });
        });

        if (!parsedRows.length) {
          return res.status(400).json({
            error: 'No valid rows found in CSV.',
            details: rowErrors,
          });
        }

        const groups = new Map();
        for (const entry of parsedRows) {
          const key = normalizeString(entry.payload.name).toLowerCase();
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(entry);
        }

        const insertedRows = [];
        const insertionErrors = [];

        for (const [, groupRows] of groups) {
          groupRows.sort((a, b) => a.rowNumber - b.rowNumber);

          let masterPayload = { ...groupRows[0].payload };
          let mergedImages = false;
          for (const gr of groupRows) {
            if (cloudynapCsvHasImage(gr.payload)) {
              masterPayload = { ...masterPayload, ...gr.payload };
              mergedImages = true;
              break;
            }
          }

          if (!mergedImages) {
            groupRows.forEach((gr) => {
              rowErrors.push({
                row: gr.rowNumber,
                name: gr.displayName,
                error:
                  'Missing required: image or image_urls (provide on at least one row per product name).',
              });
            });
            continue;
          }

          const variants = groupRows.map((gr) => sanitizedRowToSofacumbedVariant(gr.payload)).filter(Boolean);
          if (variants.length !== groupRows.length) {
            groupRows.forEach((gr) => {
              rowErrors.push({
                row: gr.rowNumber,
                name: gr.displayName,
                error: 'Invalid variant price.',
              });
            });
            continue;
          }

          try {
            const insertPayload = buildCloudynapRowFromCsv('sofacumbed', masterPayload);
            const { data, error } = await supabase.from('sofacumbed').insert(insertPayload).select('*').single();
            if (error) throw error;
            await replaceSofacumbedVariants(data.id, variants);
            const enriched = await fetchSofacumbedWithVariants(data.id);
            insertedRows.push({
              row: groupRows[0].rowNumber,
              name: enriched?.name || masterPayload.name,
              record: enriched,
              variantRows: groupRows.map((g) => g.rowNumber),
              variantCount: variants.length,
            });
          } catch (error) {
            insertionErrors.push({
              row: groupRows[0].rowNumber,
              name: groupRows[0].displayName,
              error: error?.message || error?.details || 'Failed to insert grouped sofa cum bed rows.',
            });
          }
        }

        if (insertedRows.length > 0) {
          await logActivity(
            {
              type: 'bulk_import',
              action: `Imported ${insertedRows.length} sofa cum bed product(s) (${parsedRows.length} CSV row(s)) via bulk CSV`,
              entityType: 'product',
              entityId: null,
              entityName: `${insertedRows.length} sofa cum bed listing(s)`,
              details: {
                category: cloudCat,
                table: tableName,
                count: insertedRows.length,
                attempted: records.length,
                failed: rowErrors.length + insertionErrors.length,
              },
            },
            req,
          );
        }

        return res.json({
          summary: {
            category: cloudCat,
            attempted: records.length,
            processed: parsedRows.length,
            inserted: insertedRows.length,
            failed: rowErrors.length + insertionErrors.length,
          },
          inserted: insertedRows,
          rowValidationErrors: rowErrors,
          insertionErrors,
        });
      }

      const sanitizedRows = [];

      records.forEach((row, index) => {
        const rowNumber = index + 2;
        const sanitized = sanitizeCsvRow(row, columnLookup);
        const displayName = sanitized.name || row.name || null;

        if (Array.isArray(sanitized.image_urls) && sanitized.image_urls.length) {
          if (!sanitized.image || typeof sanitized.image !== 'string' || !sanitized.image.trim()) {
            sanitized.image = sanitized.image_urls[0];
          }
        }

        if (!Object.keys(sanitized).length) {
          rowErrors.push({
            row: rowNumber,
            name: displayName,
            error: 'Row does not contain any recognized columns.',
          });
          return;
        }

        const missing = [];
        if (!normalizeString(sanitized.name)) missing.push('name');
        if (!cloudynapCsvHasPrice(cloudCat, sanitized)) missing.push('price');
        if (!cloudynapCsvHasImage(sanitized)) missing.push('image or image_urls');

        if (missing.length) {
          rowErrors.push({
            row: rowNumber,
            name: displayName,
            error: `Missing required: ${missing.join(', ')}`,
          });
          return;
        }

        sanitizedRows.push({
          payload: sanitized,
          rowNumber,
          displayName,
        });
      });

      if (!sanitizedRows.length) {
        return res.status(400).json({
          error: 'No valid rows found in CSV.',
          details: rowErrors,
        });
      }

      const insertedRows = [];
      const insertionErrors = [];

      for (const row of sanitizedRows) {
        try {
          const insertPayload = buildCloudynapRowFromCsv(cloudCat, row.payload);
          const { data, error } = await supabase
            .from(tableName)
            .insert(insertPayload)
            .select('*')
            .single();

          if (error) {
            throw error;
          }

          insertedRows.push({
            row: row.rowNumber,
            name: row.displayName || data?.name || null,
            record: data,
          });
        } catch (error) {
          insertionErrors.push({
            row: row.rowNumber,
            name: row.displayName,
            error: error?.message || error?.details || 'Failed to insert row.',
          });
        }
      }

      if (insertedRows.length > 0) {
        await logActivity(
          {
            type: 'bulk_import',
            action: `Imported ${insertedRows.length} new ${cloudCat} catalog row(s) via bulk CSV`,
            entityType: 'product',
            entityId: null,
            entityName: `${insertedRows.length} ${cloudCat}(s)`,
            details: {
              category: cloudCat,
              table: tableName,
              count: insertedRows.length,
              attempted: records.length,
              failed: rowErrors.length + insertionErrors.length,
            },
          },
          req,
        );
      }

      return res.json({
        summary: {
          category: cloudCat,
          attempted: records.length,
          processed: sanitizedRows.length,
          inserted: insertedRows.length,
          failed: rowErrors.length + insertionErrors.length,
        },
        inserted: insertedRows,
        rowValidationErrors: rowErrors,
        insertionErrors,
      });
    }

    const category = legacyCat;
    let columnLookup;
    if (category === 'printer') {
      columnLookup = PRINTER_COLUMN_LOOKUP;
    } else if (category === 'scanner') {
      columnLookup = SCANNER_COLUMN_LOOKUP;
    } else {
      columnLookup = LAPTOP_COLUMN_LOOKUP;
    }
    const requiredColumns = REQUIRED_COLUMNS_LOOKUP[category] || [];
    let tableName;
    if (category === 'printer') {
      tableName = 'printers';
    } else if (category === 'scanner') {
      tableName = 'scanners';
    } else {
      tableName = 'laptops';
    }

    const sanitizedRows = [];
    const rowErrors = [];

    records.forEach((row, index) => {
      const rowNumber = index + 2; // account for header row
      const sanitized = sanitizeCsvRow(row, columnLookup);
      const displayName = sanitized.name || row.name || row.model || null;

      if (Array.isArray(sanitized.image_urls) && sanitized.image_urls.length) {
        if (!sanitized.image || typeof sanitized.image !== 'string' || !sanitized.image.trim()) {
          sanitized.image = sanitized.image_urls[0];
        }
      }

      if (!Object.keys(sanitized).length) {
        rowErrors.push({
          row: rowNumber,
          name: displayName,
          error: 'Row does not contain any recognized columns.',
        });
        return;
      }

      const missingRequired = requiredColumns.filter((column) => !sanitized[column]);
      if (missingRequired.length) {
        rowErrors.push({
          row: rowNumber,
          name: displayName,
          error: `Missing required columns: ${missingRequired.join(', ')}`,
        });
        return;
      }

      sanitizedRows.push({
        payload: sanitized,
        rowNumber,
        displayName,
      });
    });

    if (!sanitizedRows.length) {
      return res.status(400).json({
        error: 'No valid rows found in CSV.',
        details: rowErrors,
      });
    }

    const insertedRows = [];
    const insertionErrors = [];

    for (const row of sanitizedRows) {
      try {
        const payload = {
          ...row.payload,
        };

        if (payload.featured === undefined || payload.featured === null) {
          payload.featured = false;
        } else {
          payload.featured = Boolean(payload.featured);
        }

        if (payload.featured) {
          await ensureFeaturedLimit(tableName, true);
        }

        const { data, error } = await supabase
          .from(tableName)
          .insert(payload)
          .select('*')
          .single();

        if (error) {
          throw error;
        }

        insertedRows.push({
          row: row.rowNumber,
          name: row.displayName || data?.name || null,
          record: data,
        });
      } catch (error) {
        insertionErrors.push({
          row: row.rowNumber,
          name: row.displayName,
          error: error?.message || error?.details || 'Failed to insert row.',
        });
      }
    }

    // Log activity for bulk import
    if (insertedRows.length > 0) {
      await logActivity(
        {
          type: 'bulk_import',
          action: `Imported ${insertedRows.length} new ${category}${insertedRows.length > 1 ? 's' : ''} via bulk upload`,
          entityType: 'product',
          entityId: null,
          entityName: `${insertedRows.length} ${category}${insertedRows.length > 1 ? 's' : ''}`,
          details: {
            category,
            count: insertedRows.length,
            attempted: records.length,
            failed: rowErrors.length + insertionErrors.length,
          },
        },
        req,
      );
    }

    return res.json({
      summary: {
        category,
        attempted: records.length,
        processed: sanitizedRows.length,
        inserted: insertedRows.length,
        failed: rowErrors.length + insertionErrors.length,
      },
      inserted: insertedRows,
      rowValidationErrors: rowErrors,
      insertionErrors,
    });
  } catch (error) {
    console.error('Bulk CSV import error:', error);
    res.status(500).json({ error: error?.message || 'Failed to import CSV.' });
  }
});

router.patch('/:category/:id', upload.array('images', 10), async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({ error: 'Database not configured' });
    }
    const categoryParam = normalizeString(req.params.category).toLowerCase();
    const cloudCat = resolveCloudynapCategoryParam(categoryParam);

    if (cloudCat) {
      const lookupId = parseLookupId(req.params.id);
      const tableName = CLOUDYNAP_TABLE[cloudCat];
      const { data: existingRow, error: existingCloudError } = await supabase
        .from(tableName)
        .select('id')
        .eq('id', lookupId)
        .single();

      if (existingCloudError || !existingRow) {
        return res.status(404).json({ error: 'Product not found.' });
      }

      const name = normalizeString(req.body.name);
      if (!name) {
        return res.status(400).json({ error: 'Product name is required.' });
      }

      const specsPayload = parseSpecsPayload(req.body.specs);

      if (cloudCat === 'bed') {
        const variantEntries = parseBedVariantsFromInputs(specsPayload, req.body)
          .map(normalizeBedVariantForDb)
          .filter(Boolean);
        if (!variantEntries.length) {
          return res.status(400).json({
            error: 'At least one mattress size with a valid price (PKR) is required.',
          });
        }

        const existingImages = parseExistingImages(req.body.existingImages);
        const files = req.files || [];

        let uploadedUrls = [];
        if (files.length) {
          const uploads = await uploadImages(cloudCat, files);
          uploadedUrls = uploads.urls;
        }

        let finalImages = [...existingImages, ...uploadedUrls]
          .map((url) => (typeof url === 'string' ? url.trim() : ''))
          .filter((url, index, array) => url && array.indexOf(url) === index);

        if (!finalImages.length) {
          return res.status(400).json({ error: 'At least one product image is required.' });
        }

        const coverExisting = normalizeString(req.body.coverExisting);
        const coverNewIndex =
          req.body.coverNewIndex !== undefined && req.body.coverNewIndex !== null
            ? Number(req.body.coverNewIndex)
            : null;

        let coverImage = '';
        if (coverExisting && finalImages.includes(coverExisting)) {
          coverImage = coverExisting;
        } else if (
          Number.isInteger(coverNewIndex) &&
          coverNewIndex >= 0 &&
          coverNewIndex < uploadedUrls.length
        ) {
          coverImage = uploadedUrls[coverNewIndex];
        } else if (existingImages.length && finalImages.includes(existingImages[0])) {
          coverImage = existingImages[0];
        } else {
          coverImage = finalImages[0];
        }

        const updatePayload = buildCloudynapRow(cloudCat, req.body, specsPayload, coverImage, finalImages);

        const { data, error } = await supabase
          .from('beds')
          .update(updatePayload)
          .eq('id', lookupId)
          .select('*')
          .single();

        if (error) {
          console.error('Failed to update Cloudynap product:', error);
          return res.status(500).json({
            error:
              error?.message ||
              error?.details ||
              error?.hint ||
              'Failed to update product.',
          });
        }

        try {
          await replaceBedVariants(lookupId, variantEntries);
        } catch (variantErr) {
          console.error('Failed to update mattress variants:', variantErr);
          return res.status(500).json({
            error: variantErr?.message || 'Failed to update mattress variants.',
          });
        }

        let full;
        try {
          full = await fetchBedWithVariants(lookupId);
        } catch (fetchErr) {
          full = { ...data, variants: [], price: null };
        }

        await logActivity(
          {
            type: 'product_updated',
            action: `Updated ${cloudCat}: ${full.name || name}`,
            entityType: 'product',
            entityId: lookupId,
            entityName: full.name || name,
            details: { category: cloudCat },
          },
          req,
        );

        return res.json({ product: { ...full, type: cloudCat } });
      }

      if (cloudCat === 'sofacumbed') {
        const variantEntries = parseBedVariantsFromInputs(specsPayload, req.body)
          .map(normalizeSofacumbedVariantForDb)
          .filter(Boolean);
        if (!variantEntries.length) {
          return res.status(400).json({
            error: 'At least one sofa cum bed option with a valid price (PKR) is required.',
          });
        }

        const existingImages = parseExistingImages(req.body.existingImages);
        const files = req.files || [];

        let uploadedUrls = [];
        if (files.length) {
          const uploads = await uploadImages(cloudCat, files);
          uploadedUrls = uploads.urls;
        }

        let finalImages = [...existingImages, ...uploadedUrls]
          .map((url) => (typeof url === 'string' ? url.trim() : ''))
          .filter((url, index, array) => url && array.indexOf(url) === index);

        if (!finalImages.length) {
          return res.status(400).json({ error: 'At least one product image is required.' });
        }

        const coverExisting = normalizeString(req.body.coverExisting);
        const coverNewIndex =
          req.body.coverNewIndex !== undefined && req.body.coverNewIndex !== null
            ? Number(req.body.coverNewIndex)
            : null;

        let coverImage = '';
        if (coverExisting && finalImages.includes(coverExisting)) {
          coverImage = coverExisting;
        } else if (
          Number.isInteger(coverNewIndex) &&
          coverNewIndex >= 0 &&
          coverNewIndex < uploadedUrls.length
        ) {
          coverImage = uploadedUrls[coverNewIndex];
        } else if (existingImages.length && finalImages.includes(existingImages[0])) {
          coverImage = existingImages[0];
        } else {
          coverImage = finalImages[0];
        }

        const updatePayload = buildCloudynapRow(cloudCat, req.body, specsPayload, coverImage, finalImages);

        const { data, error } = await supabase
          .from('sofacumbed')
          .update(updatePayload)
          .eq('id', lookupId)
          .select('*')
          .single();

        if (error) {
          console.error('Failed to update Cloudynap product:', error);
          return res.status(500).json({
            error:
              error?.message ||
              error?.details ||
              error?.hint ||
              'Failed to update product.',
          });
        }

        try {
          await replaceSofacumbedVariants(lookupId, variantEntries);
        } catch (variantErr) {
          console.error('Failed to update sofa cum bed variants:', variantErr);
          return res.status(500).json({
            error: variantErr?.message || 'Failed to update sofa cum bed variants.',
          });
        }

        let full;
        try {
          full = await fetchSofacumbedWithVariants(lookupId);
        } catch (fetchErr) {
          full = { ...data, variants: [], price: null };
        }

        await logActivity(
          {
            type: 'product_updated',
            action: `Updated ${cloudCat}: ${full.name || name}`,
            entityType: 'product',
            entityId: lookupId,
            entityName: full.name || name,
            details: { category: cloudCat },
          },
          req,
        );

        return res.json({ product: { ...full, type: cloudCat } });
      }

      const priceRaw = normalizeString(req.body.price);
      if (!priceRaw) {
        return res.status(400).json({ error: 'Price is required.' });
      }

      const existingImages = parseExistingImages(req.body.existingImages);
      const files = req.files || [];

      let uploadedUrls = [];
      if (files.length) {
        const uploads = await uploadImages(cloudCat, files);
        uploadedUrls = uploads.urls;
      }

      let finalImages = [...existingImages, ...uploadedUrls]
        .map((url) => (typeof url === 'string' ? url.trim() : ''))
        .filter((url, index, array) => url && array.indexOf(url) === index);

      if (!finalImages.length) {
        return res.status(400).json({ error: 'At least one product image is required.' });
      }

      const coverExisting = normalizeString(req.body.coverExisting);
      const coverNewIndex =
        req.body.coverNewIndex !== undefined && req.body.coverNewIndex !== null
          ? Number(req.body.coverNewIndex)
          : null;

      let coverImage = '';
      if (coverExisting && finalImages.includes(coverExisting)) {
        coverImage = coverExisting;
      } else if (
        Number.isInteger(coverNewIndex) &&
        coverNewIndex >= 0 &&
        coverNewIndex < uploadedUrls.length
      ) {
        coverImage = uploadedUrls[coverNewIndex];
      } else if (existingImages.length && finalImages.includes(existingImages[0])) {
        coverImage = existingImages[0];
      } else {
        coverImage = finalImages[0];
      }

      const updatePayload = buildCloudynapRow(cloudCat, req.body, specsPayload, coverImage, finalImages);

      const { data, error } = await supabase
        .from(tableName)
        .update(updatePayload)
        .eq('id', lookupId)
        .select('*')
        .single();

      if (error) {
        console.error('Failed to update Cloudynap product:', error);
        return res.status(500).json({
          error:
            error?.message ||
            error?.details ||
            error?.hint ||
            'Failed to update product.',
        });
      }

      await logActivity(
        {
          type: 'product_updated',
          action: `Updated ${cloudCat}: ${data.name || name}`,
          entityType: 'product',
          entityId: lookupId,
          entityName: data.name || name,
          details: { category: cloudCat },
        },
        req,
      );

      return res.json({ product: { ...data, type: cloudCat } });
    }

    let category;
    if (categoryParam === 'printer' || categoryParam === 'printers') {
      category = 'printer';
    } else if (categoryParam === 'scanner' || categoryParam === 'scanners') {
      category = 'scanner';
    } else if (categoryParam === 'laptop' || categoryParam === 'laptops') {
      category = 'laptop';
    } else {
      category = null;
    }

    if (!category) {
      return res.status(400).json({ error: 'Invalid product category.' });
    }

    const lookupId = parseLookupId(req.params.id);
    let tableName;
    if (category === 'printer') {
      tableName = 'printers';
    } else if (category === 'scanner') {
      tableName = 'scanners';
    } else {
      tableName = 'laptops';
    }

    // Get existing product to compare changes
    const { data: existingProduct, error: existingError } = await supabase
      .from(tableName)
      .select('*')
      .eq('id', lookupId)
      .single();

    if (existingError) {
      return res.status(404).json({ error: 'Product not found.' });
    }

    const details = {
      name: normalizeString(req.body.name),
      brand: normalizeString(req.body.brand),
      model: normalizeString(req.body.model),
      series: normalizeString(req.body.series),
      sku: normalizeString(req.body.sku),
      price: normalizeString(req.body.price),
      stock: normalizeString(req.body.stock),
      description: normalizeString(req.body.description),
    };

    if (!details.name) {
      return res.status(400).json({ error: 'Product name is required.' });
    }

    if (!details.brand) {
      return res.status(400).json({ error: 'Brand is required.' });
    }

    if (!details.price) {
      return res.status(400).json({ error: 'Price is required.' });
    }

    const requestedFeatured = parseOptionalBoolean(req.body.featured);

    const specsPayload = parseSpecsPayload(req.body.specs);
    const specs = mapSpecs(category, specsPayload);

    const existingImages = parseExistingImages(req.body.existingImages);
    const files = req.files || [];

    let uploadedUrls = [];
    if (files.length) {
      const uploads = await uploadImages(category, files);
      uploadedUrls = uploads.urls;
    }

    let finalImages = [...existingImages, ...uploadedUrls]
      .map((url) => (typeof url === 'string' ? url.trim() : ''))
      .filter((url, index, array) => url && array.indexOf(url) === index);

    if (!finalImages.length) {
      return res.status(400).json({ error: 'At least one product image is required.' });
    }

    const coverExisting = normalizeString(req.body.coverExisting);
    const coverNewIndex =
      req.body.coverNewIndex !== undefined && req.body.coverNewIndex !== null
        ? Number(req.body.coverNewIndex)
        : null;

    let coverImage = '';
    if (coverExisting && finalImages.includes(coverExisting)) {
      coverImage = coverExisting;
    } else if (
      Number.isInteger(coverNewIndex) &&
      coverNewIndex >= 0 &&
      coverNewIndex < uploadedUrls.length
    ) {
      coverImage = uploadedUrls[coverNewIndex];
    } else if (existingImages.length && finalImages.includes(existingImages[0])) {
      coverImage = existingImages[0];
    } else {
      coverImage = finalImages[0];
    }

    if (requestedFeatured !== null && tableName === 'laptops' && requestedFeatured === true) {
      await ensureFeaturedLimit(tableName, true, lookupId);
    }

    const updatePayload = {
      ...details,
      ...specs,
      image: coverImage,
      image_urls: finalImages,
    };

    if (requestedFeatured !== null) {
      updatePayload.featured = requestedFeatured;
    }

    // Compare old vs new values to find what actually changed
    const changedFields = [];
    const normalizeValue = (val) => {
      if (val === null || val === undefined || val === '') return '';
      // Convert to string and trim, but preserve case for better comparison
      const str = String(val).trim();
      // For numeric fields, compare as numbers
      if (!isNaN(str) && str !== '') {
        return parseFloat(str);
      }
      return str.toLowerCase();
    };

    const compareValues = (oldVal, newVal) => {
      // Handle null/undefined/empty
      if ((!oldVal && !newVal) || (oldVal === '' && newVal === '')) return true;
      if (!oldVal || !newVal) return false;
      
      // Try numeric comparison first
      const oldNum = parseFloat(oldVal);
      const newNum = parseFloat(newVal);
      if (!isNaN(oldNum) && !isNaN(newNum)) {
        return oldNum === newNum;
      }
      
      // String comparison
      return String(oldVal).trim().toLowerCase() === String(newVal).trim().toLowerCase();
    };

    for (const key in updatePayload) {
      if (key === 'image' || key === 'image_urls') continue; // Skip image fields
      
      const oldValue = existingProduct[key];
      const newValue = updatePayload[key];
      
      if (!compareValues(oldValue, newValue)) {
        changedFields.push(key);
      }
    }

    const { data, error } = await supabase
      .from(tableName)
      .update(updatePayload)
      .eq('id', lookupId)
      .select('*')
      .single();

    if (error) {
      console.error('Failed to update product:', error);
      return res.status(500).json({
        error:
          error?.message ||
          error?.details ||
          error?.hint ||
          'Failed to update product. Check server logs for details.',
      });
    }

    // Log activity - only log if there were actual changes
    if (changedFields.length > 0) {
      // Also try to get user info from request body (FormData might not send headers properly)
      const userFromBody = req.body?.cmsUserId || req.body?.cmsUserName || req.body?.cmsUserRole 
        ? {
            userId: req.body.cmsUserId,
            userName: req.body.cmsUserName,
            userRole: req.body.cmsUserRole,
          }
        : null;
      
      await logActivity({
        type: 'product_updated',
        action: `Updated ${category}: ${data.name || details.name}`,
        entityType: 'product',
        entityId: data.id,
        entityName: data.name || details.name,
        details: {
          category,
          brand: data.brand || details.brand,
          price: data.price || details.price,
          stock: data.stock, // Use the updated value from database (data), not the form input
          changes: changedFields, // Only the fields that actually changed
        },
        // Pass user info directly if available from body
        userId: userFromBody?.userId,
        userName: userFromBody?.userName,
        userRole: userFromBody?.userRole,
      }, req);
    }

    res.json({ product: data });
  } catch (err) {
    console.error('Unexpected error updating product:', err);
    if (err?.statusCode === 400) {
      res.status(400).json({ error: err.message });
    } else {
      res.status(500).json({ error: err?.message || 'Internal server error.' });
    }
  }
});

module.exports = router;
