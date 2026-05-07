const express = require('express');
const router = express.Router();
const { getSupabase } = require('../lib/supabaseServer');

let supabase;
try {
  supabase = getSupabase();
} catch (err) {
  console.warn('[routes/activities]', err.message);
}

router.use((req, res, next) => {
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured for activities API.' });
  }
  next();
});

// Helper function to get user info from request headers
const getUserFromRequest = (req) => {
  // Express converts headers to lowercase automatically
  // Check all possible header name variations
  const allHeaders = req.headers;
  const userId = allHeaders['x-cms-user-id'] || allHeaders['x-cms-user-id'] || req.body?.cmsUserId || null;
  const userName = allHeaders['x-cms-user-name'] || allHeaders['x-cms-user-name'] || req.body?.cmsUserName || null;
  const userRole = allHeaders['x-cms-user-role'] || allHeaders['x-cms-user-role'] || req.body?.cmsUserRole || null;
  
  // Debug logging to see what headers are actually received
  const cmsHeaders = Object.keys(allHeaders).filter(k => k.toLowerCase().includes('cms') || k.toLowerCase().includes('user'));
  if (cmsHeaders.length > 0) {
    console.log('CMS Headers found:', cmsHeaders.map(k => ({ [k]: allHeaders[k] })));
  }
  
  // If no user info found, log all headers for debugging
  if (!userName || userName === '' || userName === 'System') {
    console.log('No user name found in headers. Available headers:', Object.keys(allHeaders).slice(0, 20));
    console.log('User ID:', userId, 'User Name:', userName, 'User Role:', userRole);
  }
  
  return {
    userId: userId && userId !== '' ? parseInt(userId) : null,
    userName: userName && userName !== '' ? userName : 'System',
    userRole: userRole && userRole !== '' ? userRole : null,
  };
};

// Helper function to log activity (can be imported by other routes)
const logActivity = async (activityData, req = null) => {
  try {
    if (!supabase) return;
    let { type, action, userId, userName, userRole, entityType, entityId, entityName, details } = activityData;

    // If request is provided and user info not in activityData, get from request
    if (req && (!userId && !userName)) {
      const userInfo = getUserFromRequest(req);
      userId = userId || userInfo.userId;
      userName = userName || userInfo.userName;
      userRole = userRole || userInfo.userRole;
    }

    const { error } = await supabase.from('activities').insert({
      type,
      action,
      user_id: userId || null,
      user_name: userName || null,
      user_role: userRole || null,
      entity_type: entityType || null,
      entity_id: entityId ? String(entityId) : null,
      entity_name: entityName || null,
      details: details || null,
      created_at: new Date().toISOString(), // Explicitly set timestamp in UTC
    });

    if (error) {
      console.error('Failed to log activity:', error);
      // Don't throw error - activity logging shouldn't break the main operation
    }
  } catch (err) {
    console.error('Activity logging error:', err);
    // Don't throw error - activity logging shouldn't break the main operation
  }
};

// Get all activities
router.get('/', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;

    const { data, error } = await supabase
      .from('activities')
      .select('*')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error('Failed to fetch activities:', error);
      return res.status(500).json({ error: 'Failed to fetch activities', details: error.message });
    }

    res.json(data || []);
  } catch (err) {
    console.error('Get activities error:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// Get single activity by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('activities')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Activity not found' });
      }
      return res.status(500).json({ error: 'Failed to fetch activity', details: error.message });
    }

    res.json(data);
  } catch (err) {
    console.error('Get activity error:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// Create an export object that includes both router and helpers
const activitiesModule = router;
activitiesModule.logActivity = logActivity;
activitiesModule.getUserFromRequest = getUserFromRequest;

// Export the router (with helpers attached) as the main export
module.exports = activitiesModule;

