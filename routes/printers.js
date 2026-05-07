const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || 'https://svyrkggjjkbxsbvumfxj.supabase.co';
const supabaseServiceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN2eXJrZ2dqamtieHNidnVtZnhqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjIyODgyNTEsImV4cCI6MjA3Nzg2NDI1MX0.1aRKA1GT8nM2eNKF6-bqQV9K40vP7cRSxuj-QtbpO0g';

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

const parseBooleanQuery = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return null;
    if (['true', '1', 'yes', 'on', 'y'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off', 'n'].includes(normalized)) return false;
  }
  return null;
};

router.get('/', async (req, res) => {
  try {
    const { featured, limit } = req.query;

    const featuredFilter = parseBooleanQuery(featured);
    let query = supabase.from('printers').select('*').order('id', { ascending: true });

    if (featuredFilter !== null) {
      query = query.eq('featured', featuredFilter);
    }

    const parsedLimit = Number(limit);
    if (Number.isFinite(parsedLimit) && parsedLimit > 0) {
      query = query.limit(parsedLimit);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Failed to fetch printers:', error);
      return res.status(500).json({ error: 'Failed to fetch printers' });
    }

    res.json(data || []);
  } catch (err) {
    console.error('Unexpected error fetching printers:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase.from('printers').select('*').eq('id', id).single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Printer not found' });
      }
      console.error('Failed to fetch printer by id:', error);
      return res.status(500).json({ error: 'Failed to fetch printer' });
    }

    res.json(data);
  } catch (err) {
    console.error('Unexpected error fetching printer by id:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/:id/stock', async (req, res) => {
  try {
    const { id } = req.params;
    const { stock } = req.body;

    const idValue = Number(id);
    const lookupId = Number.isFinite(idValue) ? idValue : id;

    const stockString = String(stock ?? '').trim();
    const parsedStock = Number(stockString);
    if (!Number.isFinite(parsedStock) || parsedStock < 0) {
      return res.status(400).json({ error: 'Stock must be a non-negative number' });
    }

    const { data, error } = await supabase
      .from('printers')
      .update({ stock: stockString })
      .eq('id', lookupId)
      .select('*')
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Printer not found' });
      }
      console.error('Failed to update printer stock:', error);
      return res.status(500).json({ error: 'Failed to update stock' });
    }

    res.json(data);
  } catch (err) {
    console.error('Unexpected error updating printer stock:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;


