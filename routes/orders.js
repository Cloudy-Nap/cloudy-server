const express = require('express');
const router = express.Router();
const { getSupabase } = require('../lib/supabaseServer');
const { logActivity } = require('./activities');

let supabase;
try {
  supabase = getSupabase();
} catch (err) {
  console.warn('[routes/orders]', err.message);
}

router.use((req, res, next) => {
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured for orders API.' });
  }
  next();
});

const normalizeStatus = (status) => {
  if (!status) return 'pending';
  return status.toString().toLowerCase();
};

const extractCustomerName = (order, user) => {
  if (!order && !user) return 'Guest User';

  const orderName =
    order?.customer_name ||
    [order?.first_name, order?.last_name].filter(Boolean).join(' ') ||
    order?.user_name ||
    order?.user_email;
  if (orderName && orderName.trim()) return orderName.trim();

  const userName =
    user?.full_name ||
    [user?.first_name, user?.last_name].filter(Boolean).join(' ') ||
    user?.name ||
    user?.email;
  if (userName && userName.trim()) return userName.trim();

  return 'Guest User';
};

const isPendingStatus = (status) => {
  const normalized = normalizeStatus(status);
  return normalized === 'pending' || normalized === 'in_progress';
};

const updateUserTotals = async (userId, delta) => {
  const toNumber = (value) => {
    const num = Number(value);
    return Number.isNaN(num) ? 0 : num;
  };

  const { data: userData, error: userError } = await supabase
    .from('users')
    .select('totalorders, pending, completed')
    .eq('id', userId)
    .single();

  if (userError) {
    console.error('Failed to fetch user totals:', userError);
    return;
  }

  const currentTotals = {
    totalorders: toNumber(userData.totalorders),
    pending: toNumber(userData.pending),
    completed: toNumber(userData.completed),
  };

  const totalsUpdate = {
    totalorders: Math.max(0, currentTotals.totalorders + (delta.totalorders || 0)),
    pending: Math.max(0, currentTotals.pending + (delta.pending || 0)),
    completed: Math.max(0, currentTotals.completed + (delta.completed || 0)),
  };

  const { error: updateError } = await supabase
    .from('users')
    .update(totalsUpdate)
    .eq('id', userId);

  if (updateError) {
    console.error('Failed to update user totals:', updateError);
  }
};

const parseAddressObject = (input) => {
  if (!input) return null;

  if (typeof input === 'object' && !Array.isArray(input)) {
    return input;
  }

  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch (error) {
      // Ignore parse errors; treat as unstructured string
    }
  }

  return null;
};

const firstNonEmpty = (...candidates) =>
  candidates.find((value) => typeof value === 'string' && value.trim())?.trim() || null;

router.post('/', async (req, res) => {
  try {
    const {
      userId,
      status = 'pending',
      totals = {},
      shippingAddress,
      billingAddress,
      paymentMethod,
      items = [],
      orderNotes,
      customer = {},
      customerName,
      customerEmail,
      customerPhone,
      firstName,
      lastName,
      phone,
      phoneNumber,
    } = req.body;

    if (!userId || !items.length) {
      return res.status(400).json({ error: 'userId and at least one item are required' });
    }

    const normalizedStatus = normalizeStatus(status);

    const shippingAddressObject = parseAddressObject(shippingAddress);
    const billingAddressObject = parseAddressObject(billingAddress);

    const resolvedFirstName = firstNonEmpty(
      customer?.firstName,
      customer?.firstname,
      firstName,
      shippingAddressObject?.first_name,
      billingAddressObject?.first_name,
    );

    const resolvedLastName = firstNonEmpty(
      customer?.lastName,
      customer?.lastname,
      lastName,
      shippingAddressObject?.last_name,
      billingAddressObject?.last_name,
    );

    const combinedName = (() => {
      const parts = [resolvedFirstName, resolvedLastName].filter(Boolean);
      return parts.length ? parts.join(' ') : null;
    })();

    const resolvedCustomerName = firstNonEmpty(
      combinedName,
      customer?.name,
      customerName,
      shippingAddressObject?.name,
      billingAddressObject?.name,
    );

    const resolvedCustomerEmail = firstNonEmpty(
      customer?.email,
      customerEmail,
      shippingAddressObject?.email,
      billingAddressObject?.email,
    );

    const resolvedCustomerPhone = firstNonEmpty(
      customer?.phone,
      customer?.phoneNumber,
      customer?.phone_number,
      customerPhone,
      phone,
      phoneNumber,
      shippingAddressObject?.phone,
      billingAddressObject?.phone,
    );

    const insertPayload = {
      user_id: userId,
      status: normalizedStatus,
      subtotal: totals.subtotal || 0,
      tax: totals.tax || 0,
      shipping: totals.shipping || 0,
      total: totals.total || 0,
      shipping_address: shippingAddress || null,
      billing_address: billingAddress || null,
      payment_method: paymentMethod || null,
      customer_name: resolvedCustomerName,
      customer_email: resolvedCustomerEmail,
      customer_phone: resolvedCustomerPhone,
    };

    if (typeof orderNotes === 'string' && orderNotes.trim()) {
      insertPayload.order_notes = orderNotes.trim();
    }

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .insert(insertPayload)
      .select()
      .single();

    if (orderError) throw orderError;

    const orderItems = items.map((item) => {
      const rawProductId = item.productId ?? item.id ?? null;
      let resolvedProductId = null;

      if (typeof rawProductId === 'number' && Number.isFinite(rawProductId)) {
        resolvedProductId = rawProductId;
      } else if (typeof rawProductId === 'string') {
        const trimmed = rawProductId.trim();
        const directNumber = Number(trimmed);
        if (Number.isFinite(directNumber)) {
          resolvedProductId = directNumber;
        } else {
          const match = trimmed.match(/(\d+)/);
          if (match) {
            const parsed = Number(match[1]);
            if (Number.isFinite(parsed)) {
              resolvedProductId = parsed;
            }
          }
        }
      }

      return {
        order_id: order.id,
        product_id: resolvedProductId,
        name: item.name || item.title || 'Product',
        price: Number(item.price || 0),
        quantity: Number(item.quantity || 1),
        metadata: item.metadata || null,
      };
    });

    const { error: itemsError } = await supabase.from('order_items').insert(orderItems);
    if (itemsError) throw itemsError;

    const totalsDelta = {
      totalorders: 1,
      pending: isPendingStatus(normalizedStatus) ? 1 : 0,
      completed: normalizedStatus === 'completed' ? 1 : 0,
    };

    updateUserTotals(userId, totalsDelta).catch((err) =>
      console.error('User total update error:', err),
    );

    res.json({ order, items: orderItems });
  } catch (error) {
    console.error('Create order error:', error);
    res.status(500).json({ error: error.message || 'Failed to create order' });
  }
});

router.get('/', async (req, res) => {
  try {
    const { userId } = req.query;

    let query = supabase.from('orders').select('*, order_items(*)').order('created_at', { ascending: false });

    if (userId) {
      query = query.eq('user_id', userId);
    }

    const { data, error } = await query;

    if (error) throw error;

    const enriched = await Promise.all(
      (data || []).map(async (order) => {
        if (!order?.user_id) {
          return {
            ...order,
            customer_name: extractCustomerName(order),
          };
        }

        const { data: userData, error: userError } = await supabase
          .from('users')
          .select('id, first_name, last_name, full_name, name, email')
          .eq('id', order.user_id)
          .single();

        if (userError) {
          console.error('Failed to fetch user for order', order.id, userError.message);
        }

        return {
          ...order,
          customer_name: extractCustomerName(order, userData),
          user: userData || null,
        };
      }),
    );

    res.json(enriched);
  } catch (error) {
    console.error('Fetch orders error:', error);
    res.status(500).json({ error: error.message || 'Failed to load orders' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('orders')
      .select('*, order_items(*)')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Order not found' });
      }
      throw error;
    }

    res.json(data);
  } catch (error) {
    console.error('Fetch order by id error:', error);
    res.status(500).json({ error: error.message || 'Failed to load order' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({ error: 'status is required' });
    }

    const normalizedStatus = normalizeStatus(status);

    const { data: existingOrder, error: existingError } = await supabase
      .from('orders')
      .select('user_id, status')
      .eq('id', id)
      .single();

    if (existingError) throw existingError;

    const { data, error } = await supabase
      .from('orders')
      .update({ status: normalizedStatus })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    if (existingOrder?.user_id) {
      const previousStatus = normalizeStatus(existingOrder.status);
      const delta = {
        totalorders: 0,
        pending: (isPendingStatus(normalizeStatus(existingOrder.status)) ? -1 : 0) +
          (isPendingStatus(normalizedStatus) ? 1 : 0),
        completed:
          (normalizeStatus(existingOrder.status) === 'completed' ? -1 : 0) +
          (normalizedStatus === 'completed' ? 1 : 0),
      };

      updateUserTotals(existingOrder.user_id, delta).catch((err) =>
        console.error('User totals update error:', err),
      );
    }

    // Log activity for order status update
    const statusMessages = {
      'pending': 'Order marked as pending',
      'processing': 'Order is being processed',
      'shipped': 'Order has been shipped',
      'delivered': 'Order has been delivered',
      'completed': 'Order marked as fulfilled',
      'cancelled': 'Order was cancelled',
    };

    const actionMessage = statusMessages[normalizedStatus] || `Order status updated to ${normalizedStatus}`;
    
    await logActivity({
      type: normalizedStatus === 'cancelled' ? 'order_cancelled' : normalizedStatus === 'completed' ? 'order_fulfilled' : 'order_updated',
      action: `${actionMessage}: Order #${id}`,
      entityType: 'order',
      entityId: id,
      entityName: `Order #${id}`,
      details: {
        orderId: id,
        previousStatus: existingOrder?.status || 'unknown',
        newStatus: normalizedStatus,
      },
    }, req);

    res.json(data);
  } catch (error) {
    console.error('Update order error:', error);
    res.status(500).json({ error: error.message || 'Failed to update order' });
  }
});

module.exports = router;

