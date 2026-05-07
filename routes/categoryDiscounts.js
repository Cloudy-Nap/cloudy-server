const express = require('express');
const { getSupabase } = require('../lib/supabaseServer');
const { logActivity } = require('./activities');

const TABLE = 'category_batch_discounts';
const ALLOWED = new Set(['bed', 'accessory', 'furniture', 'sofacumbed']);

let supabase;
try {
  supabase = getSupabase();
} catch (err) {
  console.warn('[routes/categoryDiscounts]', err.message);
}

const normalizeCategory = (param) => {
  const p = String(param || '').trim().toLowerCase();
  return ALLOWED.has(p) ? p : null;
};

const isRowActive = (row, now = new Date()) => {
  if (!row) return false;
  const pct = Number(row.discount_percent);
  if (!Number.isFinite(pct) || pct <= 0) return false;
  const start = new Date(row.starts_at);
  const end = new Date(row.ends_at);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false;
  return now >= start && now <= end;
};

const isMissingTableError = (error) =>
  error?.code === '42P01' ||
  (typeof error?.message === 'string' &&
    (error.message.includes('does not exist') || error.message.includes('schema cache')));

function requireSupabase(req, res, next) {
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }
  next();
}

const publicRouter = express.Router();
publicRouter.use(requireSupabase);

publicRouter.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('category, discount_percent, starts_at, ends_at');

    if (error) {
      if (isMissingTableError(error)) {
        return res.json({ discounts: [] });
      }
      throw error;
    }

    const now = new Date();
    const discounts = (data || [])
      .filter((r) => isRowActive(r, now))
      .map((r) => ({
        category: r.category,
        discount_percent: Number(r.discount_percent),
        starts_at: r.starts_at,
        ends_at: r.ends_at,
      }));

    res.json({ discounts });
  } catch (err) {
    console.error('GET /api/discounts:', err);
    res.status(500).json({ error: err.message || 'Failed to load discounts' });
  }
});

const cmsRouter = express.Router();
cmsRouter.use(requireSupabase);

cmsRouter.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase.from(TABLE).select('*').order('category');

    if (error) {
      if (isMissingTableError(error)) {
        return res.json({ discounts: [] });
      }
      throw error;
    }

    res.json({ discounts: data || [] });
  } catch (err) {
    console.error('GET /api/cms/discounts:', err);
    res.status(500).json({ error: err.message || 'Failed to load discounts' });
  }
});

cmsRouter.put('/:category', async (req, res) => {
  try {
    const category = normalizeCategory(req.params.category);
    if (!category) {
      return res.status(400).json({ error: 'Invalid category.' });
    }

    const percentRaw = req.body?.discount_percent;
    const percent = Number(percentRaw);
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
      return res.status(400).json({ error: 'discount_percent must be between 0.01 and 100.' });
    }

    const startImmediate = Boolean(req.body?.start_immediate);
    let startsAt;
    if (startImmediate) {
      startsAt = new Date();
    } else {
      const rawStart = req.body?.starts_at;
      if (!rawStart) {
        return res.status(400).json({ error: 'starts_at is required unless start_immediate is true.' });
      }
      startsAt = new Date(rawStart);
      if (Number.isNaN(startsAt.getTime())) {
        return res.status(400).json({ error: 'Invalid starts_at.' });
      }
    }

    const rawEnd = req.body?.ends_at;
    if (!rawEnd) {
      return res.status(400).json({ error: 'ends_at is required.' });
    }
    const endsAt = new Date(rawEnd);
    if (Number.isNaN(endsAt.getTime())) {
      return res.status(400).json({ error: 'Invalid ends_at.' });
    }
    if (endsAt <= startsAt) {
      return res.status(400).json({ error: 'ends_at must be after starts_at.' });
    }

    const row = {
      category,
      discount_percent: Math.round(percent * 100) / 100,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from(TABLE)
      .upsert(row, { onConflict: 'category' })
      .select('*')
      .single();

    if (error) {
      if (isMissingTableError(error)) {
        return res.status(503).json({
          error:
            'Table category_batch_discounts not found. Run supabase/category_batch_discounts.sql in the SQL editor.',
        });
      }
      throw error;
    }

    await logActivity(
      {
        type: 'discount_updated',
        action: `Set ${category} batch discount to ${row.discount_percent}% until ${row.ends_at}`,
        entityType: 'discount',
        entityId: category,
        entityName: category,
        details: { category, discount_percent: row.discount_percent },
      },
      req,
    );

    res.json({ discount: data });
  } catch (err) {
    console.error('PUT /api/cms/discounts:', err);
    res.status(500).json({ error: err.message || 'Failed to save discount' });
  }
});

cmsRouter.delete('/:category', async (req, res) => {
  try {
    const category = normalizeCategory(req.params.category);
    if (!category) {
      return res.status(400).json({ error: 'Invalid category.' });
    }

    const { error } = await supabase.from(TABLE).delete().eq('category', category);

    if (error) {
      if (isMissingTableError(error)) {
        return res.status(503).json({ error: 'Discount table not found.' });
      }
      throw error;
    }

    await logActivity(
      {
        type: 'discount_cleared',
        action: `Cleared batch discount for ${category}`,
        entityType: 'discount',
        entityId: category,
        entityName: category,
      },
      req,
    );

    res.json({ ok: true, category });
  } catch (err) {
    console.error('DELETE /api/cms/discounts:', err);
    res.status(500).json({ error: err.message || 'Failed to delete discount' });
  }
});

module.exports = { publicRouter, cmsRouter };
