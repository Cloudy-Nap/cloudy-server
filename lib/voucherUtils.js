const TAX_RATE = 0.02;

/** Uppercase alphanumeric + hyphens/underscores for voucher codes. */
function normalizeVoucherCode(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

function parseDiscountPercent(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0 || num > 100) return null;
  return Math.round(num * 100) / 100;
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/** Subtotal discount, then 2% tax on discounted subtotal (matches checkout). */
function calculateCheckoutTotals(subtotal, discountPercent = 0) {
  const sub = roundMoney(subtotal);
  const pct = parseDiscountPercent(discountPercent) || 0;
  const discount = pct > 0 ? roundMoney(sub * (pct / 100)) : 0;
  const discountedSubtotal = Math.max(0, roundMoney(sub - discount));
  const tax = Math.round(discountedSubtotal * TAX_RATE);
  const shipping = 0;
  const total = roundMoney(discountedSubtotal + tax + shipping);

  return {
    subtotal: sub,
    discount,
    discountedSubtotal,
    tax,
    shipping,
    total,
    discount_percent: pct,
  };
}

module.exports = {
  TAX_RATE,
  normalizeVoucherCode,
  parseDiscountPercent,
  calculateCheckoutTotals,
};
