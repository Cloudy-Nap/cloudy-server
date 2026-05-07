const express = require('express');
const { getSupabase } = require('../lib/supabaseServer');

const router = express.Router();

/** Mirrors `routes/products` enrich for variant rows on JSON responses. */
const enrichBedCatalogRow = (row) => {
  if (!row || typeof row !== 'object') return row;
  const variants = Array.isArray(row.product_variants_bed) ? row.product_variants_bed : [];
  const rest = { ...row };
  delete rest.product_variants_bed;
  const prices = variants
    .map((v) => {
      const n = v?.price != null ? Number(v.price) : NaN;
      return Number.isFinite(n) ? n : null;
    })
    .filter((n) => n !== null);
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
    .map((v) => {
      const n = v?.price != null ? Number(v.price) : NaN;
      return Number.isFinite(n) ? n : null;
    })
    .filter((n) => n !== null);
  const minPrice = prices.length ? Math.min(...prices) : null;
  return { ...rest, variants, price: minPrice };
};

/** Maps API type segment → Supabase table name */
const TYPE_TABLE = {
  bed: 'beds',
  accessory: 'accessories',
  furniture: 'furniture',
  sofacumbed: 'sofacumbed',
  deal: 'catalog_deals',
};

router.get('/:type/:id', async (req, res) => {
  try {
    const supabase = getSupabase();
    const type = String(req.params.type || '').toLowerCase();
    const id = req.params.id;
    const table = TYPE_TABLE[type];

    if (!table) {
      return res.status(400).json({ error: 'Invalid product type' });
    }

    if (table === 'beds') {
      /** Separate query: PostgREST embed `product_variants_bed(*)` is unreliable without a visible FK in schema cache. */
      const { data: row, error: rowErr } = await supabase.from('beds').select('*').eq('id', id).maybeSingle();
      if (rowErr) {
        console.error('catalog fetch error:', rowErr);
        return res.status(500).json({ error: 'Failed to fetch product' });
      }
      if (!row) {
        return res.status(404).json({ error: 'Product not found' });
      }
      const { data: variantRows, error: varErr } = await supabase
        .from('product_variants_bed')
        .select('*')
        .eq('product_id', id);
      if (varErr) {
        console.error('catalog mattress variants fetch error:', varErr);
        return res.status(500).json({ error: 'Failed to fetch product' });
      }
      const enriched = enrichBedCatalogRow({
        ...row,
        product_variants_bed: Array.isArray(variantRows) ? variantRows : [],
      });
      return res.json({ ...enriched, type });
    }

    if (table === 'sofacumbed') {
      /** Separate query: PostgREST often fails to embed `product_variants_sofacumbed` even when the FK exists. */
      const { data: row, error: rowErr } = await supabase.from('sofacumbed').select('*').eq('id', id).maybeSingle();
      if (rowErr) {
        console.error('catalog fetch error:', rowErr);
        return res.status(500).json({ error: 'Failed to fetch product' });
      }
      if (!row) {
        return res.status(404).json({ error: 'Product not found' });
      }
      const { data: variantRows, error: varErr } = await supabase
        .from('product_variants_sofacumbed')
        .select('*')
        .eq('product_id', id);
      if (varErr) {
        console.error('catalog sofa variants fetch error:', varErr);
        return res.status(500).json({ error: 'Failed to fetch product' });
      }
      const enriched = enrichSofacumbedCatalogRow({
        ...row,
        product_variants_sofacumbed: Array.isArray(variantRows) ? variantRows : [],
      });
      return res.json({ ...enriched, type });
    }

    const { data, error } = await supabase.from(table).select('*').eq('id', id).maybeSingle();

    if (error) {
      console.error('catalog fetch error:', error);
      return res.status(500).json({ error: 'Failed to fetch product' });
    }
    if (!data) {
      return res.status(404).json({ error: 'Product not found' });
    }

    if (table === 'catalog_deals') {
      return res.json({
        ...data,
        type: 'deal',
        name: data.title,
        price: data.deal_price,
        items: data.items,
      });
    }

    res.json({ ...data, type });
  } catch (err) {
    if (err.code === 'SUPABASE_CONFIG') {
      return res.status(503).json({ error: err.message });
    }
    console.error('catalog route error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
