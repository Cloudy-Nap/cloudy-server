const express = require('express');
const router = express.Router();
const { getSupabase } = require('../lib/supabaseServer');

let supabase;
try {
  supabase = getSupabase();
} catch (err) {
  console.warn('[routes/cmsAuth]', err.message);
}

router.use((req, res, next) => {
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured for CMS auth API.' });
  }
  next();
});

const normalize = (value) => {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
};

// Get all CMS users
router.get('/users', async (req, res) => {
  try {
    console.log('Fetching CMS users from Supabase...');
    const { data, error } = await supabase
      .from('cmsusers')
      .select('*')
      .order('id', { ascending: false });

    if (error) {
      console.error('Supabase error fetching CMS users:', error);
      console.error('Error code:', error.code);
      console.error('Error message:', error.message);
      console.error('Error details:', error.details);
      return res.status(500).json({ 
        error: 'Failed to fetch users', 
        details: error.message,
        code: error.code 
      });
    }

    // Ensure data is an array
    const usersArray = Array.isArray(data) ? data : [];
    console.log(`Found ${usersArray.length} CMS users`);
    
    // Remove passwords from response
    const sanitized = usersArray.map((user) => {
      const { password, ...userWithoutPassword } = user;
      return userWithoutPassword;
    });
    
    res.json(sanitized);
  } catch (err) {
    console.error('Get CMS users error:', err);
    console.error('Error stack:', err.stack);
    res.status(500).json({ 
      error: 'Internal server error', 
      details: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

// Get single CMS user
router.get('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('cmsusers')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'User not found' });
      }
      return res.status(500).json({ error: 'Failed to fetch user' });
    }

    const { password, ...user } = data;
    res.json(user);
  } catch (err) {
    console.error('Get CMS user error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Helper function to get access pages based on role
const getAccessPagesForRole = (role) => {
  const roleAccessMap = {
    admin: ['dashboard', 'products', 'orders', 'inventory', 'customers', 'discounts', 'deals', 'settings'],
    inventory_manager: ['inventory', 'products', 'discounts', 'deals'],
    order_manager: ['orders'],
  };
  return roleAccessMap[role] || [];
};

// Create CMS user
router.post('/users', async (req, res) => {
  try {
    const { email, username, password, role } = req.body;

    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }

    if (!password) {
      return res.status(400).json({ error: 'Password is required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    if (!role) {
      return res.status(400).json({ error: 'Role is required' });
    }

    // Check if user already exists
    const { data: existingUsers, error: fetchError } = await supabase
      .from('cmsusers')
      .select('*');

    if (fetchError) {
      return res.status(500).json({ error: 'Failed to check existing users' });
    }

    const normalizedUsername = username.trim().toLowerCase();

    const exists = existingUsers?.find((u) => {
      const uUsername = u.username ? u.username.trim().toLowerCase() : null;
      return normalizedUsername === uUsername;
    });

    if (exists) {
      return res.status(400).json({ error: 'User with this username already exists' });
    }

    // Get access pages for role
    const accessPages = getAccessPagesForRole(role);

    // Insert new user
    const insertData = {
      username: username.trim(),
      password: password.trim(),
      role: role,
      accesspages: accessPages,
    };

    if (email) insertData.email = email.trim();

    const { data, error } = await supabase
      .from('cmsusers')
      .insert(insertData)
      .select()
      .single();

    if (error) {
      console.error('Failed to create CMS user:', error);
      return res.status(500).json({ error: 'Failed to create user', details: error.message });
    }

    const { password: _password, ...user } = data;
    res.json({ user, message: 'User created successfully' });
  } catch (err) {
    console.error('Create CMS user error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update CMS user
router.put('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { email, username, password, role } = req.body;

    const updateData = {};

    if (email !== undefined) updateData.email = email ? email.trim() : null;
    if (username !== undefined) updateData.username = username ? username.trim() : null;
    if (password !== undefined) {
      if (password && password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
      }
      updateData.password = password ? password.trim() : null;
    }
    if (role !== undefined) {
      updateData.role = role;
      // Update access pages when role changes
      updateData.accesspages = getAccessPagesForRole(role);
    }

    // Check for duplicate username if updating
    if (username) {
      const { data: existingUsers, error: fetchError } = await supabase
        .from('cmsusers')
        .select('*')
        .neq('id', id);

      if (!fetchError && existingUsers) {
        const normalizedUsername = username.trim().toLowerCase();

        const exists = existingUsers.find((u) => {
          const uUsername = u.username ? u.username.trim().toLowerCase() : null;
          return normalizedUsername === uUsername;
        });

        if (exists) {
          return res.status(400).json({ error: 'User with this username already exists' });
        }
      }
    }

    const { data, error } = await supabase
      .from('cmsusers')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Failed to update CMS user:', error);
      return res.status(500).json({ error: 'Failed to update user', details: error.message });
    }

    const { password: _password, ...user } = data;
    res.json({ user, message: 'User updated successfully' });
  } catch (err) {
    console.error('Update CMS user error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete CMS user
router.delete('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('cmsusers')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('Failed to delete CMS user:', error);
      return res.status(500).json({ error: 'Failed to delete user', details: error.message });
    }

    res.json({ message: 'User deleted successfully' });
  } catch (err) {
    console.error('Delete CMS user error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { identifier, password } = req.body || {};

    if (!identifier || !password) {
      return res.status(400).json({ error: 'Identifier and password are required' });
    }

    const normalizedIdentifier = normalize(identifier);

    const { data, error } = await supabase.from('cmsusers').select('*');

    if (error) {
      console.error('Failed to fetch CMS users:', error);
      return res.status(500).json({ error: 'Failed to authenticate. Please try again.' });
    }

    if (!Array.isArray(data) || data.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const match = data.find((user) => {
      const possibleIdentifiers = [
        user.email,
        user.username,
        user.user_name,
        user.handle,
        user.login,
      ]
        .map(normalize)
        .filter(Boolean);
      return possibleIdentifiers.includes(normalizedIdentifier);
    });

    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const storedPassword = typeof match.password === 'string' ? match.password.trim() : '';
    if (storedPassword.length === 0) {
      console.error('CMS user record missing password field.');
      return res.status(500).json({ error: 'CMS user record is misconfigured.' });
    }

    const incomingPassword = password.trim();
    if (incomingPassword !== storedPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const { password: _password, ...cmsUser } = match;
    const session = {
      access_token: `cms_${Date.now()}`,
      user: {
        id: cmsUser.id,
        email: cmsUser.email || null,
        username: cmsUser.username || cmsUser.user_name || null,
      },
    };

    // Ensure accesspages is included in the response
    const userResponse = {
      ...cmsUser,
      accesspages: cmsUser.accesspages || getAccessPagesForRole(cmsUser.role || 'staff'),
    };

    return res.json({
      user: userResponse,
      session,
    });
  } catch (err) {
    console.error('Unexpected CMS login error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;


