const express = require('express');
const multer = require('multer');
const path = require('path');
const { parse: parseCsv } = require('csv-parse/sync');
const { createClient } = require('@supabase/supabase-js');
const { logActivity } = require('./activities');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

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

const normalizeString = (value) => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  return String(value).trim();
};

const parseOptionalBoolean = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return null;
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  }
  return null;
};

const parseImageUrls = (raw) => {
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
    } catch (error) {
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
};

const coerceCsvValue = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const stringValue = String(value).trim();
  return stringValue === '' ? null : stringValue;
};

const SCANNER_ALLOWED_COLUMNS = [
  'name',
  'brand',
  'model',
  'series',
  'sku',
  'price',
  'stock',
  'description',
  'image',
  'image_urls',
  'memory',
  'paper_types',
  'paper_size',
  'duplex',
  'resolution',
  'power',
  'weight',
  'dimensions',
  'color_scan',
  'wireless',
];

const buildColumnLookup = (columnList) => {
  const set = new Set(columnList);
  const lowerCaseMap = columnList.reduce((acc, column) => {
    acc[column.toLowerCase()] = column;
    return acc;
  }, {});
  return { set, lowerCaseMap };
};

const SCANNER_COLUMN_LOOKUP = buildColumnLookup(SCANNER_ALLOWED_COLUMNS);
const SCANNER_REQUIRED_COLUMNS = ['name', 'brand', 'price'];

const sanitizeCsvRow = (row, columnLookup) => {
  const sanitized = {};
  Object.entries(row || {}).forEach(([rawKey, rawValue]) => {
    if (!rawKey) return;
    const trimmedKey = rawKey.trim();
    if (!trimmedKey) return;

    const directMatch = columnLookup.set.has(trimmedKey) ? trimmedKey : null;
    const lookupMatch = columnLookup.lowerCaseMap[trimmedKey.toLowerCase()];
    const column = directMatch || lookupMatch;
    if (!column) return;

    if (column === 'image_urls') {
      const urls = parseImageUrls(rawValue);
      if (urls.length) {
        sanitized[column] = urls;
      }
      return;
    }

    const value = coerceCsvValue(rawValue);
    if (value === null) return;
    sanitized[column] = value;
  });
  return sanitized;
};

const uploadImages = async (files) => {
  if (!files || !files.length) {
    return { urls: [], coverUrl: '' };
  }

  const bucket = 'scanner_images';

  const uploads = await Promise.all(
    files.map(async (file, index) => {
      const extension = path.extname(file.originalname) || '.jpg';
      const safeBase = path.basename(file.originalname, extension).replace(/[^a-zA-Z0-9-_]/g, '').slice(0, 32);
      const filePath = `scanner/${Date.now()}-${index}-${safeBase}${extension}`;

      const { error: uploadError } = await supabase.storage
        .from(bucket)
        .upload(filePath, file.buffer, {
          contentType: file.mimetype || 'application/octet-stream',
          cacheControl: '3600',
          upsert: false,
        });

      if (uploadError) {
        throw new Error(`Failed to upload image: ${uploadError.message || uploadError}`);
      }

      const {
        data: { publicUrl },
      } = supabase.storage.from(bucket).getPublicUrl(filePath);

      return publicUrl;
    })
  );

  return {
    urls: uploads,
    coverUrl: uploads[0] || '',
  };
};

// GET /api/scanners - Fetch all scanners
router.get('/', async (req, res) => {
  try {
    const { featured, limit, brand, sort } = req.query;

    let query = supabase.from('scanners').select('*').order('id', { ascending: true });

    // Filter by featured if provided
    const featuredFilter = parseBooleanQuery(featured);
    if (featuredFilter !== null) {
      query = query.eq('featured', featuredFilter);
    }

    // Filter by brand if provided
    if (brand) {
      const brandValue = brand.toString().trim();
      if (brandValue) {
        query = query.eq('brand', brandValue);
      }
    }

    // Apply sorting
    if (sort) {
      const sortLower = sort.toString().trim().toLowerCase();
      if (sortLower === 'price_asc' || sortLower === 'price-low-high') {
        query = query.order('price', { ascending: true });
      } else if (sortLower === 'price_desc' || sortLower === 'price-high-low') {
        query = query.order('price', { ascending: false });
      }
    }

    // Apply limit if provided
    const parsedLimit = Number(limit);
    if (Number.isFinite(parsedLimit) && parsedLimit > 0) {
      query = query.limit(parsedLimit);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Failed to fetch scanners:', error);
      return res.status(500).json({ error: 'Failed to fetch scanners' });
    }

    res.json(data || []);
  } catch (err) {
    console.error('Unexpected error fetching scanners:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/scanners/:id - Fetch a single scanner by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase.from('scanners').select('*').eq('id', id).single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Scanner not found' });
      }
      console.error('Failed to fetch scanner by id:', error);
      return res.status(500).json({ error: 'Failed to fetch scanner' });
    }

    res.json(data);
  } catch (err) {
    console.error('Unexpected error fetching scanner by id:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/scanners/:id/stock - Update scanner stock
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
      .from('scanners')
      .update({ stock: stockString })
      .eq('id', lookupId)
      .select('*')
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Scanner not found' });
      }
      console.error('Failed to update scanner stock:', error);
      return res.status(500).json({ error: 'Failed to update stock' });
    }

    res.json(data);
  } catch (err) {
    console.error('Unexpected error updating scanner stock:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/scanners - Create a new scanner
router.post('/', upload.array('images', 10), async (req, res) => {
  try {
    const details = {
      name: normalizeString(req.body.name),
      brand: normalizeString(req.body.brand),
      model: normalizeString(req.body.model),
      series: normalizeString(req.body.series),
      sku: normalizeString(req.body.sku),
      price: normalizeString(req.body.price),
      stock: normalizeString(req.body.stock),
      description: normalizeString(req.body.description),
      memory: normalizeString(req.body.memory),
      paper_types: normalizeString(req.body.paper_types),
      paper_size: normalizeString(req.body.paper_size),
      duplex: normalizeString(req.body.duplex),
      resolution: normalizeString(req.body.resolution),
      power: normalizeString(req.body.power),
      weight: normalizeString(req.body.weight),
      dimensions: normalizeString(req.body.dimensions),
      color_scan: normalizeString(req.body.color_scan),
      wireless: normalizeString(req.body.wireless),
    };

    if (!details.name || !details.price) {
      return res.status(400).json({ error: 'Product name and price are required.' });
    }

    if (!details.brand) {
      return res.status(400).json({ error: 'Brand is required.' });
    }

    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ error: 'Please upload at least one product image.' });
    }

    const { urls, coverUrl } = await uploadImages(files);

    if (!coverUrl) {
      return res.status(500).json({ error: 'Unable to determine cover image URL.' });
    }

    const insertPayload = {
      ...details,
      image: coverUrl,
      image_urls: urls,
    };

    const { data, error } = await supabase
      .from('scanners')
      .insert(insertPayload)
      .select('*')
      .single();

    if (error) {
      console.error('Failed to create scanner:', error);
      return res.status(500).json({
        error:
          error?.message ||
          error?.details ||
          error?.hint ||
          'Failed to create scanner. Check server logs for details.',
      });
    }

    // Log activity - get user info from headers (Express lowercases headers) or body
    const userId = req.headers['x-cms-user-id'] || req.body?.cmsUserId;
    const userName = req.headers['x-cms-user-name'] || req.body?.cmsUserName;
    const userRole = req.headers['x-cms-user-role'] || req.body?.cmsUserRole;
    
    const userFromBody = userId || userName || userRole
      ? {
          userId: userId,
          userName: userName,
          userRole: userRole,
        }
      : null;

    await logActivity(
      {
        type: 'product_created',
        action: `Created new scanner: ${data.name || details.name}`,
        entityType: 'product',
        entityId: data.id,
        entityName: data.name || details.name,
        details: {
          category: 'scanner',
          brand: data.brand || details.brand,
          price: data.price || details.price,
          stock: data.stock || details.stock,
        },
        userId: userFromBody?.userId,
        userName: userFromBody?.userName,
        userRole: userFromBody?.userRole,
      },
      req
    );

    res.status(201).json({ product: data });
  } catch (err) {
    console.error('Unexpected error creating scanner:', err);
    res.status(500).json({ error: err?.message || 'Internal server error.' });
  }
});

// POST /api/scanners/bulk/csv - Bulk upload scanners via CSV
router.post('/bulk/csv', upload.single('file'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer || !req.file.buffer.length) {
      return res.status(400).json({ error: 'Please upload a CSV file.' });
    }

    let records;
    try {
      const csvString = req.file.buffer.toString('utf-8');
      records = parseCsv(csvString, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      });
    } catch (error) {
      return res.status(400).json({
        error: `Unable to parse CSV file: ${error.message || 'Invalid format.'}`,
      });
    }

    if (!Array.isArray(records) || !records.length) {
      return res.status(400).json({ error: 'CSV file does not contain any rows.' });
    }

    const sanitizedRows = [];
    const rowErrors = [];

    records.forEach((row, index) => {
      const rowNumber = index + 2; // account for header row
      const sanitized = sanitizeCsvRow(row, SCANNER_COLUMN_LOOKUP);
      const displayName = sanitized.name || row.name || row.model || null;

      if (Array.isArray(sanitized.image_urls) && sanitized.image_urls.length) {
        if (!sanitized.image || typeof sanitized.image !== 'string' || !sanitized.image.trim()) {
          sanitized.image = sanitized.image_urls[0];
        }
      }

      if (!Object.keys(sanitized).length) {
        rowErrors.push({
          row: rowNumber,
          name: displayName,
          error: 'Row does not contain any recognized columns.',
        });
        return;
      }

      const missingRequired = SCANNER_REQUIRED_COLUMNS.filter((column) => !sanitized[column]);
      if (missingRequired.length) {
        rowErrors.push({
          row: rowNumber,
          name: displayName,
          error: `Missing required columns: ${missingRequired.join(', ')}`,
        });
        return;
      }

      sanitizedRows.push({
        payload: sanitized,
        rowNumber,
        displayName,
      });
    });

    if (!sanitizedRows.length) {
      return res.status(400).json({
        error: 'No valid rows found in CSV.',
        details: rowErrors,
      });
    }

    const insertedRows = [];
    const insertionErrors = [];

    for (const row of sanitizedRows) {
      try {
        const payload = {
          ...row.payload,
        };

        const { data, error } = await supabase
          .from('scanners')
          .insert(payload)
          .select('*')
          .single();

        if (error) {
          throw error;
        }

        insertedRows.push({
          row: row.rowNumber,
          name: row.displayName || data?.name || null,
          record: data,
        });
      } catch (error) {
        insertionErrors.push({
          row: row.rowNumber,
          name: row.displayName,
          error: error?.message || error?.details || 'Failed to insert row.',
        });
      }
    }

    // Log activity for bulk import
    if (insertedRows.length > 0) {
      // Get user info from headers (Express lowercases headers)
      const userId = req.headers['x-cms-user-id'] || req.body?.cmsUserId;
      const userName = req.headers['x-cms-user-name'] || req.body?.cmsUserName;
      const userRole = req.headers['x-cms-user-role'] || req.body?.cmsUserRole;
      
      const userFromBody = userId || userName || userRole
        ? {
            userId: userId,
            userName: userName,
            userRole: userRole,
          }
        : null;

      await logActivity(
        {
          type: 'bulk_import',
          action: `Imported ${insertedRows.length} new scanner${insertedRows.length > 1 ? 's' : ''} via bulk upload`,
          entityType: 'product',
          entityId: null,
          entityName: `${insertedRows.length} scanner${insertedRows.length > 1 ? 's' : ''}`,
          details: {
            category: 'scanner',
            count: insertedRows.length,
            attempted: records.length,
          },
          userId: userFromBody?.userId,
          userName: userFromBody?.userName,
          userRole: userFromBody?.userRole,
        },
        req
      );
    }

    return res.json({
      summary: {
        category: 'scanner',
        attempted: records.length,
        processed: sanitizedRows.length,
        inserted: insertedRows.length,
        failed: rowErrors.length + insertionErrors.length,
      },
      inserted: insertedRows,
      rowValidationErrors: rowErrors,
      insertionErrors,
    });
  } catch (error) {
    console.error('Bulk CSV import error:', error);
    res.status(500).json({ error: error?.message || 'Failed to import CSV.' });
  }
});

module.exports = router;

