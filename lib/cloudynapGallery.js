'use strict';

const CLOUDYNAP_TYPES = new Set(['bed', 'accessory', 'furniture', 'sofacumbed']);

/** Persist gallery with cover URL first so consumers using `image_urls[0]` match `image`. */
function reorderGalleryUrlsCoverFirst(urls, coverUrl) {
  if (!Array.isArray(urls) || !urls.length) return urls;
  const cover = typeof coverUrl === 'string' ? coverUrl.trim() : '';
  if (!cover || !urls.includes(cover)) return urls;
  return [cover, ...urls.filter((u) => u !== cover)];
}

function parseImageUrls(raw) {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((value) => (typeof value === 'string' ? value.trim() : String(value || '').trim()))
      .filter((value) => value);
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .map((value) => (typeof value === 'string' ? value.trim() : String(value || '').trim()))
          .filter((value) => value);
      }
    } catch {
      // fall through to delimiter split
    }
    return trimmed
      .split(/[;,|]/)
      .map((value) => value.trim())
      .filter((value) => value);
  }

  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return [String(raw)];
  }

  return [];
}

/**
 * Align `image` (cover) with `image_urls` for Cloudynap tables — storefront reads `[0]`; CMS uses `image`.
 */
function normalizeCloudynapGalleryFields(row, catalogType) {
  if (!row || typeof row !== 'object') return row;
  const t = catalogType !== undefined && catalogType !== null ? catalogType : row.type;
  if (!CLOUDYNAP_TYPES.has(String(t || '').toLowerCase())) return row;

  const coverRaw = typeof row.image === 'string' ? row.image.trim() : '';
  let urls = parseImageUrls(row.image_urls);
  const seen = new Set();
  urls = urls.filter((u) => {
    if (!u || seen.has(u)) return false;
    seen.add(u);
    return true;
  });

  if (!urls.length && coverRaw) {
    return { ...row, image: coverRaw, image_urls: [coverRaw] };
  }
  if (urls.length && !coverRaw) {
    return { ...row, image: urls[0], image_urls: urls };
  }
  if (urls.length && coverRaw) {
    const merged = urls.includes(coverRaw) ? urls : [coverRaw, ...urls];
    const image_urls = reorderGalleryUrlsCoverFirst(merged, coverRaw);
    return { ...row, image: coverRaw, image_urls };
  }
  return row;
}

module.exports = {
  parseImageUrls,
  reorderGalleryUrlsCoverFirst,
  normalizeCloudynapGalleryFields,
};
