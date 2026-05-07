const express = require('express');
const path = require('path');
const multer = require('multer');
const { getSupabase } = require('../lib/supabaseServer');
const { logActivity } = require('./activities');

const TABLE = 'catalog_deals';
const ALLOWED_TYPES = new Set(['bed', 'accessory', 'furniture', 'sofacumbed']);

const DEALS_BUCKET = process.env.SUPABASE_STORAGE_BUCKET_DEALS || 'Deals';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 10 },
});

let supabase;
try {
  supabase = getSupabase();
} catch (err) {
  console.warn('[routes/catalogDeals]', err.message);
}

const normalizeString = (value) => {
  if (value === undefined || value === null) return '';
  return String(value).trim();
};

const isMissingTableError = (error) =>
  error?.code === '42P01' ||
  (typeof error?.message === 'string' &&
    (error.message.includes('does not exist') || error.message.includes('schema cache')));

function parseImageUrlsArray(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw.map((u) => (typeof u === 'string' ? u.trim() : String(u || '').trim())).filter(Boolean);
  }
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return [];
    try {
      const p = JSON.parse(t);
      if (Array.isArray(p)) return parseImageUrlsArray(p);
    } catch {
      /* single url */
    }
    return [t];
  }
  return [];
}

/** Shape a DB row for GET /api/products?subcategory=deals */
function rowToDealProduct(row) {
  if (!row) return null;
  const urls = parseImageUrlsArray(row.image_urls);
  const cover = normalizeString(row.image) || urls[0] || '';
  return {
    id: row.id,
    name: row.title,
    title: row.title,
    description: row.description || '',
    price: Number(row.deal_price) || 0,
    type: 'deal',
    category: 'Deals',
    image: cover || null,
    image_urls: urls.length ? urls : cover ? [cover] : [],
    imageUrls: urls.length ? urls : cover ? [cover] : [],
    items: row.items,
    deal_items: row.items,
    rating: 4.8,
    reviews: 0,
  };
}

function validateItems(raw) {
  let items = raw;
  if (typeof items === 'string') {
    try {
      items = JSON.parse(items);
    } catch {
      return { ok: false, error: 'Invalid items JSON.' };
    }
  }
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, error: 'Add at least one product to the package.' };
  }
  const normalized = [];
  for (const it of items) {
    const t = normalizeString(it.catalog_type).toLowerCase();
    if (!ALLOWED_TYPES.has(t)) {
      return { ok: false, error: `Invalid catalog type: ${t || '(empty)'}` };
    }
    const pid = it.product_id;
    if (pid === undefined || pid === null || normalizeString(String(pid)) === '') {
      return { ok: false, error: 'Each line needs a product.' };
    }
    const qty = Number(it.quantity);
    if (!Number.isFinite(qty) || qty < 1) {
      return { ok: false, error: 'Quantity must be at least 1.' };
    }
    const label = normalizeString(it.label);
    normalized.push({
      catalog_type: t,
      product_id: String(pid),
      quantity: Math.max(1, Math.floor(qty)),
      is_free: Boolean(it.is_free),
      ...(label ? { label } : {}),
    });
  }
  return { ok: true, normalized };
}

async function uploadDealImages(files) {
  if (!files || !files.length || !supabase) {
    return { urls: [], coverUrl: '' };
  }
  const uploads = await Promise.all(
    files.map(async (file, index) => {
      const extension = path.extname(file.originalname) || '.jpg';
      const safeBase = path
        .basename(file.originalname, extension)
        .replace(/[^a-zA-Z0-9-_]/g, '')
        .slice(0, 32);
      const filePath = `deals/${Date.now()}-${index}-${safeBase}${extension}`;
      const { error: uploadError } = await supabase.storage
        .from(DEALS_BUCKET)
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
      } = supabase.storage.from(DEALS_BUCKET).getPublicUrl(filePath);
      return publicUrl;
    }),
  );
  return { urls: uploads, coverUrl: uploads[0] || '' };
}

function requireDb(req, res, next) {
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }
  next();
}

const router = express.Router();
router.use(requireDb);

router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false });

    if (error) {
      if (isMissingTableError(error)) return res.json({ deals: [] });
      throw error;
    }
    res.json({ deals: data || [] });
  } catch (err) {
    console.error('GET /api/cms/deals', err);
    res.status(500).json({ error: err.message || 'Failed to load deals' });
  }
});

router.post('/', upload.array('images', 10), async (req, res) => {
  try {
    const title = normalizeString(req.body.title);
    if (!title) {
      return res.status(400).json({ error: 'Title is required.' });
    }
    const dealPrice = Number(req.body.deal_price);
    if (!Number.isFinite(dealPrice) || dealPrice < 0) {
      return res.status(400).json({ error: 'deal_price must be a non-negative number.' });
    }
    const itemsCheck = validateItems(req.body.items);
    if (!itemsCheck.ok) {
      return res.status(400).json({ error: itemsCheck.error });
    }
    const sortOrder = Number(req.body.sort_order);
    const sort_order = Number.isFinite(sortOrder) ? Math.floor(sortOrder) : 0;
    const is_active = !['false', '0', 'no'].includes(normalizeString(req.body.is_active).toLowerCase());

    const files = req.files || [];
    const { urls, coverUrl } = await uploadDealImages(files);
    const description = normalizeString(req.body.description) || null;

    const row = {
      title,
      description,
      deal_price: Math.round(dealPrice * 100) / 100,
      image: coverUrl || null,
      image_urls: urls,
      items: itemsCheck.normalized,
      sort_order,
      is_active,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase.from(TABLE).insert(row).select('*').single();
    if (error) {
      if (isMissingTableError(error)) {
        return res.status(503).json({
          error: 'Table catalog_deals not found. Run supabase/catalog_deals.sql in the SQL editor.',
        });
      }
      throw error;
    }

    await logActivity(
      {
        type: 'deal_created',
        action: `Created deal: ${title}`,
        entityType: 'deal',
        entityId: data.id,
        entityName: title,
        details: { id: data.id },
      },
      req,
    );

    res.status(201).json({ deal: data });
  } catch (err) {
    console.error('POST /api/cms/deals', err);
    res.status(500).json({ error: err.message || 'Failed to create deal' });
  }
});

const parseExistingImages = (raw) => {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed)) {
      return parsed.map((u) => (typeof u === 'string' ? u.trim() : '')).filter(Boolean);
    }
  } catch {
    /* ignore */
  }
  return [];
};

router.patch('/:id', upload.array('images', 10), async (req, res) => {
  try {
    const id = normalizeString(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'Invalid id.' });
    }

    const { data: existing, error: loadErr } = await supabase.from(TABLE).select('*').eq('id', id).maybeSingle();
    if (loadErr && !isMissingTableError(loadErr)) throw loadErr;
    if (!existing) {
      return res.status(404).json({ error: 'Deal not found.' });
    }

    const title = normalizeString(req.body.title);
    if (!title) {
      return res.status(400).json({ error: 'Title is required.' });
    }
    const dealPrice = Number(req.body.deal_price);
    if (!Number.isFinite(dealPrice) || dealPrice < 0) {
      return res.status(400).json({ error: 'deal_price must be a non-negative number.' });
    }
    const itemsCheck = validateItems(req.body.items);
    if (!itemsCheck.ok) {
      return res.status(400).json({ error: itemsCheck.error });
    }
    const sortOrder = Number(req.body.sort_order);
    const sort_order = Number.isFinite(sortOrder) ? Math.floor(sortOrder) : existing.sort_order ?? 0;
    const is_active = !['false', '0', 'no'].includes(normalizeString(req.body.is_active).toLowerCase());

    const existingImages = parseExistingImages(req.body.existingImages);
    const files = req.files || [];
    let uploadedUrls = [];
    if (files.length) {
      const up = await uploadDealImages(files);
      uploadedUrls = up.urls;
    }
    const finalUrls = [...existingImages, ...uploadedUrls]
      .map((u) => (typeof u === 'string' ? u.trim() : ''))
      .filter((u, i, a) => u && a.indexOf(u) === i);

    const coverExisting = normalizeString(req.body.coverExisting);
    const coverNewIndex =
      req.body.coverNewIndex !== undefined && req.body.coverNewIndex !== null
        ? Number(req.body.coverNewIndex)
        : null;

    let coverImage = existing.image || '';
    if (coverExisting && finalUrls.includes(coverExisting)) {
      coverImage = coverExisting;
    } else if (
      Number.isInteger(coverNewIndex) &&
      coverNewIndex >= 0 &&
      coverNewIndex < uploadedUrls.length
    ) {
      coverImage = uploadedUrls[coverNewIndex];
    } else if (existingImages.length && finalUrls.includes(existingImages[0])) {
      coverImage = existingImages[0];
    } else if (finalUrls.length) {
      coverImage = finalUrls[0];
    }

    const description = normalizeString(req.body.description) || null;

    const row = {
      title,
      description,
      deal_price: Math.round(dealPrice * 100) / 100,
      image: coverImage || null,
      image_urls: finalUrls,
      items: itemsCheck.normalized,
      sort_order,
      is_active,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase.from(TABLE).update(row).eq('id', id).select('*').single();
    if (error) throw error;

    await logActivity(
      {
        type: 'deal_updated',
        action: `Updated deal: ${title}`,
        entityType: 'deal',
        entityId: id,
        entityName: title,
      },
      req,
    );

    res.json({ deal: data });
  } catch (err) {
    console.error('PATCH /api/cms/deals/:id', err);
    res.status(500).json({ error: err.message || 'Failed to update deal' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const id = normalizeString(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'Invalid id.' });
    }
    const { error } = await supabase.from(TABLE).delete().eq('id', id);
    if (error) throw error;

    await logActivity(
      {
        type: 'deal_deleted',
        action: `Deleted deal ${id}`,
        entityType: 'deal',
        entityId: id,
      },
      req,
    );

    res.json({ ok: true, id });
  } catch (err) {
    console.error('DELETE /api/cms/deals/:id', err);
    res.status(500).json({ error: err.message || 'Failed to delete deal' });
  }
});

module.exports = router;
/** @type {typeof rowToDealProduct} */
module.exports.rowToDealProduct = rowToDealProduct;
module.exports.isMissingTableError = isMissingTableError;
