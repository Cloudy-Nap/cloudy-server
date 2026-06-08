const express = require('express');
const { getSupabase } = require('../lib/supabaseServer');
const {
  normalizeVoucherCode,
  parseDiscountPercent,
  calculateCheckoutTotals,
} = require('../lib/voucherUtils');
const { logActivity } = require('./activities');

const VOUCHER_TABLE = 'single_voucher';

let supabase;
try {
  supabase = getSupabase();
} catch (err) {
  console.warn('[routes/vouchers]', err.message);
}

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

async function fetchActiveVoucherByCode(code) {
  const normalized = normalizeVoucherCode(code);
  if (!normalized) return { voucher: null, error: 'Voucher code is required.' };

  const { data, error } = await supabase
    .from(VOUCHER_TABLE)
    .select('*')
    .eq('code', normalized)
    .maybeSingle();

  if (error) {
    if (isMissingTableError(error)) {
      return { voucher: null, error: 'Voucher system is not set up yet. Run supabase/single_voucher.sql.' };
    }
    throw error;
  }

  if (!data) {
    return { voucher: null, error: 'Voucher code not found.' };
  }

  if (data.is_used) {
    return { voucher: null, error: 'This voucher has already been used.' };
  }

  return { voucher: data, error: null };
}

const publicRouter = express.Router();
publicRouter.use(requireSupabase);

/** Preview voucher discount for checkout (does not mark as used). */
publicRouter.post('/validate', async (req, res) => {
  try {
    const { code, subtotal } = req.body || {};
    const cartSubtotal = Number(subtotal);
    if (!Number.isFinite(cartSubtotal) || cartSubtotal <= 0) {
      return res.status(400).json({ error: 'A valid cart subtotal is required.' });
    }

    const { voucher, error: lookupError } = await fetchActiveVoucherByCode(code);
    if (lookupError) {
      return res.status(400).json({ error: lookupError });
    }

    const totals = calculateCheckoutTotals(cartSubtotal, voucher.discount_percent);

    res.json({
      valid: true,
      voucher: {
        id: voucher.id,
        name: voucher.name,
        code: voucher.code,
        discount_percent: Number(voucher.discount_percent),
      },
      discount_amount: totals.discount,
      totals,
    });
  } catch (error) {
    console.error('POST /api/vouchers/validate:', error);
    res.status(500).json({ error: error.message || 'Failed to validate voucher.' });
  }
});

const cmsRouter = express.Router();
cmsRouter.use(requireSupabase);

cmsRouter.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from(VOUCHER_TABLE)
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      if (isMissingTableError(error)) {
        return res.json({ vouchers: [] });
      }
      throw error;
    }

    res.json({ vouchers: data || [] });
  } catch (error) {
    console.error('GET /api/cms/vouchers:', error);
    res.status(500).json({ error: error.message || 'Failed to load vouchers.' });
  }
});

cmsRouter.post('/', async (req, res) => {
  try {
    const { name, code, discount_percent: discountPercentRaw, notes } = req.body || {};

    const trimmedName = typeof name === 'string' ? name.trim() : '';
    const normalizedCode = normalizeVoucherCode(code);
    const discount_percent = parseDiscountPercent(discountPercentRaw);

    if (!trimmedName) {
      return res.status(400).json({ error: 'Voucher name is required.' });
    }
    if (!normalizedCode || normalizedCode.length < 3) {
      return res.status(400).json({ error: 'Voucher code must be at least 3 characters.' });
    }
    if (discount_percent == null) {
      return res.status(400).json({ error: 'Discount must be between 0.01 and 100.' });
    }

    const createdBy =
      req.headers['x-cms-user-name'] ||
      req.headers['x-cms-user-id'] ||
      'cms';

    const { data, error } = await supabase
      .from(VOUCHER_TABLE)
      .insert({
        name: trimmedName,
        code: normalizedCode,
        discount_percent,
        notes: typeof notes === 'string' && notes.trim() ? notes.trim() : null,
        is_used: false,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'A voucher with this code already exists.' });
      }
      if (isMissingTableError(error)) {
        return res.status(503).json({ error: 'single_voucher table missing. Run supabase/single_voucher.sql.' });
      }
      throw error;
    }

    await logActivity({
      type: 'voucher_created',
      action: `Created voucher ${normalizedCode} (${discount_percent}% off)`,
      entityType: 'voucher',
      entityId: String(data.id),
      entityName: trimmedName,
      details: { code: normalizedCode, discount_percent, createdBy },
    }, req);

    res.status(201).json({ voucher: data });
  } catch (error) {
    console.error('POST /api/cms/vouchers:', error);
    res.status(500).json({ error: error.message || 'Failed to create voucher.' });
  }
});

cmsRouter.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: existing, error: fetchError } = await supabase
      .from(VOUCHER_TABLE)
      .select('id, code, is_used')
      .eq('id', id)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!existing) {
      return res.status(404).json({ error: 'Voucher not found.' });
    }
    if (existing.is_used) {
      return res.status(400).json({ error: 'Cannot delete a voucher that has already been used.' });
    }

    const { error: deleteError } = await supabase.from(VOUCHER_TABLE).delete().eq('id', id);
    if (deleteError) throw deleteError;

    res.json({ success: true });
  } catch (error) {
    console.error('DELETE /api/cms/vouchers/:id:', error);
    res.status(500).json({ error: error.message || 'Failed to delete voucher.' });
  }
});

module.exports = {
  publicRouter,
  cmsRouter,
  fetchActiveVoucherByCode,
  redeemVoucherForOrder: async (voucherId, orderId) => {
    const { data, error } = await supabase
      .from(VOUCHER_TABLE)
      .update({
        is_used: true,
        used_at: new Date().toISOString(),
        used_by_order_id: orderId,
      })
      .eq('id', voucherId)
      .eq('is_used', false)
      .select()
      .maybeSingle();

    if (error) throw error;
    return data;
  },
};
