const express = require('express');
const router = express.Router();
const { getSupabase } = require('../lib/supabaseServer');
const { logActivity } = require('./activities');

let supabase;
try {
  supabase = getSupabase();
} catch (err) {
  console.warn('[routes/users]', err.message);
}

router.use((req, res, next) => {
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured for user API.' });
  }
  next();
});

// Create customer (CMS)
router.post('/', async (req, res) => {
  try {
    const { email, password, phone, address, firstName, lastName } = req.body;

    const resolvedFirstName = (req.body.first_name || firstName || '').trim();
    const resolvedLastName = (req.body.last_name || lastName || '').trim();

    if (!email || !String(email).trim()) {
      return res.status(400).json({ error: 'Email is required.' });
    }

    if (!password || String(password).trim().length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    }

    const originalEmail = String(email).trim();
    const normalizedEmail = originalEmail.toLowerCase();

    const { data: existingUsers, error: existingError } = await supabase
      .from('users')
      .select('id, email')
      .ilike('email', normalizedEmail)
      .limit(1);

    if (existingError) {
      return res.status(400).json({ error: existingError.message });
    }

    if (Array.isArray(existingUsers) && existingUsers.length > 0) {
      return res.status(400).json({ error: 'An account with this email already exists.' });
    }

    const insertPayload = {
      email: originalEmail,
      password: String(password).trim(),
      first_name: resolvedFirstName || null,
      last_name: resolvedLastName || null,
    };

    if (phone && String(phone).trim()) insertPayload.phone = String(phone).trim();
    if (address && String(address).trim()) insertPayload.address = String(address).trim();

    const { data, error } = await supabase.from('users').insert(insertPayload).select('*').single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    const displayName = [data.first_name, data.last_name].filter(Boolean).join(' ').trim() || data.email;

    await logActivity(
      {
        type: 'user_created',
        action: `Created customer: ${displayName}`,
        entityType: 'user',
        entityId: data.id,
        entityName: displayName,
        details: { email: data.email },
      },
      req,
    );

    res.status(201).json({ user: data });
  } catch (error) {
    console.error('Create user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'User not found' });
      }
      return res.status(400).json({ error: error.message });
    }

    res.json(data);
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all users
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('*');

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json(data);
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update user
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    const { data, error } = await supabase
      .from('users')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json(data);
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete user
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('users')
      .delete()
      .eq('id', id);

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update shipping details for a user
router.put('/:id/shipping', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      phone,
      shipment_address,
      province,
      city,
      address,
    } = req.body;

    if (!phone || !shipment_address || !province || !city || !address) {
      return res.status(400).json({
        error: 'phone, shipment_address, province, city, and address are required',
      });
    }

    const { data, error } = await supabase
      .from('users')
      .update({
        phone,
        shipment_address,
        province,
        city,
        address,
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({
      message: 'Shipping details updated successfully',
      user: data,
    });
  } catch (error) {
    console.error('Update shipping details error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id/cards', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('user_cards')
      .select('*')
      .eq('user_id', id);

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json(data || []);
  } catch (error) {
    console.error('Fetch user cards error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:id/cards', async (req, res) => {
  try {
    const { id } = req.params;
    const { name_on_card, card_number, cvc, expiry, provider } = req.body || {};

    const sanitize = (value) => {
      if (value === undefined || value === null) return null;
      const stringValue = typeof value === 'string' ? value.trim() : String(value).trim();
      return stringValue === '' ? null : stringValue;
    };

    const payload = {
      user_id: id,
      name_on_card: sanitize(name_on_card),
      card_number: sanitize(card_number)?.replace(/\s+/g, '') || null,
      cvc: sanitize(cvc),
      expiry: sanitize(expiry),
      provider: sanitize(provider)?.toUpperCase() || null,
    };

    if (!payload.name_on_card || !payload.card_number || !payload.cvc || !payload.expiry || !payload.provider) {
      return res.status(400).json({ error: 'All card fields are required.' });
    }

    const { data, error } = await supabase
      .from('user_cards')
      .insert(payload)
      .select('*')
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ message: 'Card saved successfully', card: data });
  } catch (error) {
    console.error('Create card error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id/cards/:cardId', async (req, res) => {
  try {
    const { id, cardId } = req.params;
    const { name_on_card, card_number, cvc, expiry, provider } = req.body || {};

    const sanitize = (value) => {
      if (value === undefined || value === null) return null;
      const stringValue = typeof value === 'string' ? value.trim() : String(value).trim();
      return stringValue === '' ? null : stringValue;
    };

    const payload = {
      name_on_card: sanitize(name_on_card),
      card_number: sanitize(card_number)?.replace(/\s+/g, '') || null,
      cvc: sanitize(cvc),
      expiry: sanitize(expiry),
      provider: sanitize(provider)?.toUpperCase() || null,
    };

    const { data, error } = await supabase
      .from('user_cards')
      .update(payload)
      .eq('user_id', id)
      .eq('id', cardId)
      .select('*')
      .single();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ message: 'Card updated successfully', card: data });
  } catch (error) {
    console.error('Update card error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id/cards/:cardId', async (req, res) => {
  try {
    const { id, cardId } = req.params;

    const { error } = await supabase
      .from('user_cards')
      .delete()
      .eq('user_id', id)
      .eq('id', cardId);

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ message: 'Card removed successfully' });
  } catch (error) {
    console.error('Delete card error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;

