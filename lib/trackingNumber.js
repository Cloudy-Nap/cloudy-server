const TRACKING_PREFIX = 'CN-';
const TRACKING_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const TRACKING_SUFFIX_LENGTH = 8;

/** Public tracking code, e.g. CN-A7K9X2M4 */
function generateTrackingNumber() {
  let suffix = '';
  for (let i = 0; i < TRACKING_SUFFIX_LENGTH; i += 1) {
    suffix += TRACKING_CHARS[Math.floor(Math.random() * TRACKING_CHARS.length)];
  }
  return `${TRACKING_PREFIX}${suffix}`;
}

/** Normalize user input for lookup (uppercase, optional CN- prefix). */
function normalizeTrackingNumberInput(value) {
  const trimmed = String(value || '').trim().toUpperCase();
  if (!trimmed) return null;

  if (/^CN-[A-Z0-9]{6,14}$/.test(trimmed)) {
    return trimmed;
  }

  const alnum = trimmed.replace(/[^A-Z0-9]/g, '');
  if (alnum.length >= 6 && alnum.length <= 14) {
    return alnum.startsWith('CN') && alnum.length > 2
      ? `CN-${alnum.slice(2)}`
      : `${TRACKING_PREFIX}${alnum}`;
  }

  return null;
}

module.exports = {
  TRACKING_PREFIX,
  generateTrackingNumber,
  normalizeTrackingNumberInput,
};
