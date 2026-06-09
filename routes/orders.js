const express = require('express');
const router = express.Router();
const { getSupabase } = require('../lib/supabaseServer');
const { generateTrackingNumber, normalizeTrackingNumberInput } = require('../lib/trackingNumber');
const { calculateCheckoutTotals } = require('../lib/voucherUtils');
const { fetchActiveVoucherByCode, redeemVoucherForOrder } = require('./vouchers');
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

const isCancelledStatus = (status) => {
  const normalized = normalizeStatus(status);
  return normalized === 'cancelled' || normalized === 'canceled' || normalized.includes('cancel');
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

const isUniqueTrackingViolation = (error) =>
  error?.code === '23505' &&
  (String(error.message || '').toLowerCase().includes('tracking_number') ||
    String(error.details || '').toLowerCase().includes('tracking_number'));

async function insertOrderWithTracking(insertPayload, maxAttempts = 6) {
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const tracking_number = generateTrackingNumber();
    const { data, error } = await supabase
      .from('orders')
      .insert({ ...insertPayload, tracking_number })
      .select()
      .single();

    if (!error) {
      return { order: data, error: null };
    }

    lastError = error;
    if (!isUniqueTrackingViolation(error)) {
      return { order: null, error };
    }
  }

  return {
    order: null,
    error: lastError || new Error('Failed to allocate a unique tracking number'),
  };
}

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
      voucherCode,
      voucher_code: voucherCodeSnake,
    } = req.body;

    const normalizedItems = Array.isArray(items) ? items : [];
    if (!normalizedItems.length) {
      return res.status(400).json({ error: 'At least one order item is required' });
    }

    const resolvedUserId =
      userId === undefined || userId === null || userId === '' ? null : userId;

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

    if (!resolvedUserId) {
      const hasEmail = resolvedCustomerEmail && String(resolvedCustomerEmail).trim();
      const hasPhone = resolvedCustomerPhone && String(resolvedCustomerPhone).trim();
      if (!hasEmail && !hasPhone) {
        return res.status(400).json({
          error: 'Guest checkout requires a customer email or phone number on the order.',
        });
      }
    }

    const rawVoucherCode = voucherCode || voucherCodeSnake || null;
    let voucherRecord = null;
    let resolvedTotals = {
      subtotal: Number(totals.subtotal) || 0,
      tax: Number(totals.tax) || 0,
      shipping: Number(totals.shipping) || 0,
      total: Number(totals.total) || 0,
      discount: Number(totals.discount) || 0,
    };

    if (rawVoucherCode) {
      const { voucher, error: voucherError } = await fetchActiveVoucherByCode(rawVoucherCode);
      if (voucherError) {
        return res.status(400).json({ error: voucherError });
      }
      voucherRecord = voucher;
      const computed = calculateCheckoutTotals(resolvedTotals.subtotal, voucher.discount_percent);
      resolvedTotals = {
        subtotal: computed.subtotal,
        tax: computed.tax,
        shipping: computed.shipping,
        total: computed.total,
        discount: computed.discount,
      };
    }

    const insertPayload = {
      user_id: resolvedUserId,
      status: normalizedStatus,
      subtotal: resolvedTotals.subtotal,
      tax: resolvedTotals.tax,
      shipping: resolvedTotals.shipping,
      total: resolvedTotals.total,
      discount: resolvedTotals.discount,
      shipping_address: shippingAddress || null,
      billing_address: billingAddress || null,
      payment_method: paymentMethod || null,
      customer_name: resolvedCustomerName,
      customer_email: resolvedCustomerEmail,
      customer_phone: resolvedCustomerPhone,
    };

    if (voucherRecord) {
      insertPayload.voucher_id = voucherRecord.id;
      insertPayload.voucher_code = voucherRecord.code;
    }

    if (typeof orderNotes === 'string' && orderNotes.trim()) {
      insertPayload.order_notes = orderNotes.trim();
    }

    const { order, error: orderError } = await insertOrderWithTracking(insertPayload);
    if (orderError) throw orderError;

    if (voucherRecord) {
      const redeemed = await redeemVoucherForOrder(voucherRecord.id, order.id);
      if (!redeemed) {
        await supabase.from('orders').delete().eq('id', order.id);
        return res.status(409).json({ error: 'This voucher was just used. Please try again without it.' });
      }
    }

    const orderItems = normalizedItems.map((item) => {
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

    if (resolvedUserId) {
      updateUserTotals(resolvedUserId, totalsDelta).catch((err) =>
        console.error('User total update error:', err),
      );
    }

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

/** Public lookup by tracking_number (must be registered before /:id). */
router.get('/track/:trackingNumber', async (req, res) => {
  try {
    const normalized = normalizeTrackingNumberInput(
      decodeURIComponent(req.params.trackingNumber || ''),
    );
    if (!normalized) {
      return res.status(400).json({ error: 'Invalid tracking number format.' });
    }

    const { data, error } = await supabase
      .from('orders')
      .select('*, order_items(*)')
      .eq('tracking_number', normalized)
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ error: 'No order found for this tracking number.' });
    }

    res.json(data);
  } catch (error) {
    console.error('Fetch order by tracking number error:', error);
    res.status(500).json({ error: error.message || 'Failed to load order' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (id === 'track') {
      return res.status(400).json({ error: 'Tracking number is required.' });
    }

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

router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: existingOrder, error: existingError } = await supabase
      .from('orders')
      .select('id, user_id, status')
      .eq('id', id)
      .single();

    if (existingError) {
      if (existingError.code === 'PGRST116') {
        return res.status(404).json({ error: 'Order not found' });
      }
      throw existingError;
    }

    if (!isCancelledStatus(existingOrder.status)) {
      return res.status(400).json({
        error: 'Only cancelled orders can be deleted. Set the order status to cancelled first.',
      });
    }

    const { error: deleteError } = await supabase.from('orders').delete().eq('id', id);
    if (deleteError) throw deleteError;

    if (existingOrder?.user_id) {
      const previousStatus = normalizeStatus(existingOrder.status);
      const delta = {
        totalorders: -1,
        pending: isPendingStatus(previousStatus) ? -1 : 0,
        completed: previousStatus === 'completed' ? -1 : 0,
      };
      updateUserTotals(existingOrder.user_id, delta).catch((err) =>
        console.error('User totals update error:', err),
      );
    }

    await logActivity({
      type: 'order_deleted',
      action: `Deleted cancelled order #${id}`,
      entityType: 'order',
      entityId: id,
      entityName: `Order #${id}`,
      details: { orderId: id, previousStatus: existingOrder.status },
    }, req);

    res.json({ success: true, id });
  } catch (error) {
    console.error('Delete order error:', error);
    res.status(500).json({ error: error.message || 'Failed to delete order' });
  }
});

module.exports = router;

