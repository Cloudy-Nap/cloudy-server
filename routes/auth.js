const express = require('express');
const router = express.Router();
const { getSupabase } = require('../lib/supabaseServer');
const nodemailer = require('nodemailer');

// In-memory OTP storage (in production, use Redis or database)
const otpStore = new Map();

// Generate 6-digit OTP
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// Clean expired OTPs (older than 10 minutes)
const cleanExpiredOTPs = () => {
  const now = Date.now();
  for (const [email, data] of otpStore.entries()) {
    if (now - data.timestamp > 10 * 60 * 1000) {
      otpStore.delete(email);
    }
  }
};

// Run cleanup every 5 minutes
setInterval(cleanExpiredOTPs, 5 * 60 * 1000);

// Create email transporter
const createEmailTransporter = () => {
  // Connection options for better reliability
  const connectionOptions = {
    connectionTimeout: 5000, // 5 seconds
    greetingTimeout: 5000,
    socketTimeout: 5000,
  };

  // Option 1: Gmail (using App Password)
  if (process.env.EMAIL_SERVICE === 'gmail' || process.env.EMAIL_USER?.includes('@gmail.com')) {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD, // Use App Password, not regular password
      },
      ...connectionOptions,
      // Use OAuth2 if available, otherwise use app password
      pool: true,
      maxConnections: 1,
    });
  }

  // Option 2: SendGrid (Recommended for production)
  if (process.env.EMAIL_SERVICE === 'sendgrid' || process.env.SENDGRID_API_KEY) {
    return nodemailer.createTransport({
      host: 'smtp.sendgrid.net',
      port: 587,
      secure: false,
      auth: {
        user: 'apikey',
        pass: process.env.SENDGRID_API_KEY,
      },
      ...connectionOptions,
    });
  }

  // Option 3: Custom SMTP
  if (process.env.SMTP_HOST) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD,
      },
      ...connectionOptions,
    });
  }

  // Fallback: Return null if no email config (will log to console)
  return null;
};

const emailTransporter = createEmailTransporter();

// Log email configuration status
if (emailTransporter) {
  console.log('✅ Email transporter configured successfully');
} else {
  console.log('⚠️  Email transporter not configured - emails will be logged to console');
  console.log('   Set EMAIL_USER and EMAIL_PASSWORD (or SMTP_* variables) to enable email sending');
}

const supabaseUrl =
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '(set SUPABASE_URL)';

let supabase;
try {
  supabase = getSupabase();
  console.log(
    '[routes/auth] Supabase ready:',
    supabaseUrl,
    process.env.SUPABASE_SERVICE_ROLE_KEY ? '(service role)' : '(anon or fallback key)',
  );
} catch (err) {
  console.warn('[routes/auth]', err.message);
}

(async () => {
  if (!supabase) return;
  try {
    const { error } = await supabase.from('users').select('count').limit(1);
    if (error) {
      console.error('❌ Auth: users table check failed:', error.message);
    } else {
      console.log('✅ Auth: users table reachable');
    }
  } catch (err) {
    console.error('❌ Auth: Supabase connection error:', err.message);
  }
})();

router.use((req, res, next) => {
  if (!supabase) {
    return res.status(503).json({
      error:
        'Authentication database is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY) in the API server .env.',
    });
  }
  next();
});

// Login endpoint - Authenticate against custom users table
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    console.log('Login attempt:', { email: email?.trim(), passwordLength: password?.length });

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const originalEmail = email.trim();
    console.log('Normalized email:', normalizedEmail);

    // First, try to fetch all users and filter manually (most reliable for text columns)
    // This ensures we can handle case-insensitive matching properly
    console.log('Attempting to query users table...');
    
    let allUsers, fetchError;
    try {
      const result = await supabase
        .from('users')
        .select('*');
      allUsers = result.data;
      fetchError = result.error;
    } catch (networkError) {
      // Handle network/connection errors (e.g., fetch failed)
      console.error('❌ Network error connecting to Supabase:', networkError);
      console.error('Error type:', networkError.name);
      console.error('Error message:', networkError.message);
      console.error('Error stack:', networkError.stack);
      console.error('Supabase URL:', supabaseUrl);
      
      const isDnsError = networkError.message?.includes('resolve') || 
                        networkError.message?.includes('ENOTFOUND') ||
                        networkError.code === 'ENOTFOUND';
      
      return res.status(500).json({ 
        error: 'Database error occurred: ' + networkError.message,
        details: isDnsError 
          ? 'DNS resolution failed - cannot resolve Supabase hostname. Please check:\n' +
            '- Your internet connection\n' +
            '- DNS server configuration\n' +
            '- If the Supabase URL is correct: ' + supabaseUrl
          : 'Unable to connect to Supabase. Please check your internet connection and Supabase URL configuration.',
        type: 'network_error',
        url: supabaseUrl
      });
    }

    if (fetchError) {
      console.error('❌ Database query error:', fetchError);
      console.error('Error code:', fetchError.code);
      console.error('Error message:', fetchError.message);
      console.error('Error hint:', fetchError.hint);
      console.error('Error details:', fetchError.details);
      console.error('Supabase URL:', supabaseUrl);
      
      // Check for network/fetch errors
      const errorMessage = fetchError.message || '';
      const errorDetails = fetchError.details || '';
      const errorString = JSON.stringify(fetchError).toLowerCase();
      
      // Check for various network error patterns
      const isNetworkError = 
        errorMessage.includes('fetch failed') || 
        errorMessage.includes('TypeError') || 
        errorMessage.includes('ECONNREFUSED') ||
        errorMessage.includes('ENOTFOUND') ||
        errorMessage.includes('ETIMEDOUT') ||
        errorMessage.includes('resolve host') ||
        errorDetails.includes('fetch failed') || 
        errorDetails.includes('TypeError') ||
        errorString.includes('fetch failed') ||
        errorString.includes('could not resolve');
      
      if (isNetworkError) {
        return res.status(500).json({ 
          error: 'Database error occurred: ' + (errorMessage || 'Network connection failed'),
          details: 'Unable to connect to Supabase database. This could be due to:\n' +
                   '- DNS resolution failure (cannot resolve Supabase hostname)\n' +
                   '- No internet connection\n' +
                   '- Firewall blocking outbound HTTPS connections\n' +
                   '- Incorrect Supabase URL configuration\n' +
                   'Please verify your Supabase URL is correct and your network connection is working.',
          type: 'network_error',
          url: supabaseUrl,
          suggestion: 'Try running: curl -I ' + supabaseUrl + ' to test connectivity'
        });
      }
      
      // More specific error messages
      if (fetchError.code === 'PGRST301' || errorMessage.includes('permission denied')) {
        return res.status(500).json({ 
          error: 'Permission denied. Please check your Supabase API key permissions or disable RLS on the users table.',
          details: errorMessage 
        });
      } else if (errorMessage.includes('relation') || errorMessage.includes('does not exist')) {
        return res.status(500).json({ 
          error: 'Users table not found. Please check if the table name is correct.',
          details: errorMessage 
        });
      } else {
        return res.status(500).json({ 
          error: 'Database connection failed. Please check your Supabase configuration.',
          details: errorMessage || errorDetails || 'Unknown error'
        });
      }
    }

    if (!allUsers || allUsers.length === 0) {
      console.log('No users found in database');
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Find user with case-insensitive email match
    const user = allUsers.find(u => {
      if (!u.email) return false;
      const userEmail = u.email.trim().toLowerCase();
      return userEmail === normalizedEmail || userEmail === originalEmail.toLowerCase();
    });

    const users = user ? [user] : [];

    if (!users || users.length === 0) {
      console.log('User not found for email:', normalizedEmail);
      console.log('Available emails in database:', allUsers.map(u => u.email).slice(0, 5));
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const foundUser = users[0];
    console.log('User found:', { id: foundUser.id, email: foundUser.email, hasPassword: !!foundUser.password });

    // Compare password - direct text comparison since both are text columns
    const storedPassword = foundUser.password;
    
    if (!storedPassword) {
      console.error('No password field found in user record');
      return res.status(500).json({ error: 'User record is missing password field' });
    }

    // Direct text comparison (trim both for safety)
    const inputPassword = password.trim();
    const dbPassword = storedPassword.trim();
    
    console.log('Password comparison:', {
      inputLength: inputPassword.length,
      dbLength: dbPassword.length,
      match: inputPassword === dbPassword
    });

    if (inputPassword !== dbPassword) {
      console.log('Password mismatch for user:', foundUser.email);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    console.log('Login successful for user:', foundUser.email);

    // Remove password from response for security
    const { password: userPassword, password_hash, ...userData } = foundUser;

    // Create a simple session object
    const session = {
      access_token: 'custom_token_' + Date.now(),
      user: {
        id: foundUser.id,
        email: foundUser.email,
      },
    };

    res.json({
      user: {
        id: foundUser.id,
        email: foundUser.email,
      },
      session: session,
      userData: userData,
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Send OTP endpoint
router.post('/send-otp', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const originalEmail = email.trim();

    // Check if user already exists
    const { data: allUsers, error: fetchError } = await supabase
      .from('users')
      .select('email');

    if (fetchError) {
      console.error('Database query error:', fetchError);
      return res.status(500).json({ 
        error: 'Database connection failed',
        details: fetchError.message 
      });
    }

    const existingUser = allUsers?.find(u => {
      if (!u.email) return false;
      return u.email.trim().toLowerCase() === normalizedEmail;
    });

    if (existingUser) {
      return res.status(400).json({ error: 'An account with this email already exists' });
    }

    // Generate OTP
    const otp = generateOTP();
    const timestamp = Date.now();

    // Store OTP (expires in 10 minutes)
    otpStore.set(normalizedEmail, {
      otp,
      timestamp,
      email: originalEmail,
    });

    // Send email with OTP (non-blocking - respond immediately)
    const fromEmail = process.env.EMAIL_FROM || process.env.EMAIL_USER || 'noreply@hitechcomputers.com';
    
    // Send response immediately, then try to send email in background
    res.json({ 
      message: 'OTP sent successfully',
      // Always include OTP in response for now (until email is working reliably)
      otp: otp
    });

    // Try to send email in background (don't block response)
    if (emailTransporter) {
      // Send email asynchronously without blocking
      setImmediate(async () => {
        try {
          console.log('📧 Attempting to send OTP email to:', originalEmail);
          
          const emailPromise = emailTransporter.sendMail({
            from: fromEmail,
            to: originalEmail,
            subject: 'Verify your email - Hi-Tek Computers',
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                <h2 style="color: #00aeef;">Email Verification</h2>
                <p>Thank you for signing up with Hi-Tek Computers!</p>
                <p>Your verification code is:</p>
                <div style="background-color: #f5f5f5; padding: 20px; text-align: center; margin: 20px 0; border-radius: 8px;">
                  <h1 style="color: #00aeef; font-size: 32px; letter-spacing: 5px; margin: 0;">${otp}</h1>
                </div>
                <p>This code will expire in 10 minutes.</p>
                <p style="color: #666; font-size: 12px; margin-top: 30px;">If you didn't request this code, please ignore this email.</p>
              </div>
            `,
            text: `Your verification code is: ${otp}\n\nThis code will expire in 10 minutes.\n\nIf you didn't request this code, please ignore this email.`,
          });

          // Wait max 3 seconds for email to send
          await Promise.race([
            emailPromise,
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Email sending timeout')), 3000)
            )
          ]);

          console.log('✅ OTP email sent successfully to:', originalEmail);
        } catch (emailError) {
          console.error('❌ Failed to send OTP email:', emailError.message || emailError);
          console.error('Email error code:', emailError.code);
          if (emailError.code === 'ETIMEDOUT' || emailError.code === 'ECONNREFUSED') {
            console.error('⚠️  Gmail SMTP connection issue. Consider using SendGrid or another email service.');
            console.error('   Gmail SMTP may be blocked on Render. Try SendGrid instead.');
          }
        }
      });
    } else {
      // Fallback: Log to console if email is not configured
      console.log('='.repeat(50));
      console.log('📧 OTP EMAIL (Email not configured - check console)');
      console.log('='.repeat(50));
      console.log(`To: ${originalEmail}`);
      console.log(`Subject: Verify your email - Hi-Tek Computers`);
      console.log(`\nYour verification code is: ${otp}`);
      console.log(`This code will expire in 10 minutes.`);
      console.log('='.repeat(50));
      console.log('⚠️  Configure EMAIL_USER and EMAIL_PASSWORD environment variables to send real emails');
    }
  } catch (error) {
    console.error('Send OTP error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Verify OTP endpoint
router.post('/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ error: 'Email and OTP are required' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const storedData = otpStore.get(normalizedEmail);

    if (!storedData) {
      return res.status(400).json({ error: 'OTP not found or expired. Please request a new one.' });
    }

    // Check if OTP expired (10 minutes)
    const now = Date.now();
    if (now - storedData.timestamp > 10 * 60 * 1000) {
      otpStore.delete(normalizedEmail);
      return res.status(400).json({ error: 'OTP has expired. Please request a new one.' });
    }

    // Verify OTP
    if (storedData.otp !== otp.trim()) {
      return res.status(400).json({ error: 'Invalid OTP. Please try again.' });
    }

    // OTP verified - mark as verified (valid for 5 minutes)
    otpStore.set(normalizedEmail, {
      ...storedData,
      verified: true,
      verifiedAt: now,
    });

    res.json({ 
      message: 'OTP verified successfully',
      email: storedData.email
    });
  } catch (error) {
    console.error('Verify OTP error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Register endpoint - Store directly in users table (now requires OTP verification)
router.post('/register', async (req, res) => {
  try {
    const { email, password, first_name, last_name, skipOTP } = req.body;

    console.log('Registration attempt:', { email: email?.trim(), first_name: first_name?.trim(), last_name: last_name?.trim(), passwordLength: password?.length, skipOTP });

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const originalEmail = email.trim();

    // Check if OTP was verified (unless skipOTP is true)
    if (!skipOTP) {
      const storedData = otpStore.get(normalizedEmail);
      if (!storedData || !storedData.verified) {
        return res.status(400).json({ 
          error: 'Email not verified. Please verify your email with OTP first.',
          requiresVerification: true
        });
      }

      // Check if verification is still valid (5 minutes)
      const now = Date.now();
      if (!storedData.verifiedAt || now - storedData.verifiedAt > 5 * 60 * 1000) {
        otpStore.delete(normalizedEmail);
        return res.status(400).json({ 
          error: 'Email verification expired. Please verify your email again.',
          requiresVerification: true
        });
      }
    }

    // Check if user already exists by fetching all users
    console.log('Checking if user already exists...');
    
    let allUsers, fetchError;
    try {
      const result = await supabase
        .from('users')
        .select('*');
      allUsers = result.data;
      fetchError = result.error;
    } catch (networkError) {
      console.error('❌ Network error connecting to Supabase:', networkError);
      console.error('Error type:', networkError.name);
      console.error('Error message:', networkError.message);
      console.error('Supabase URL:', supabaseUrl);
      
      const isDnsError = networkError.message?.includes('resolve') || 
                        networkError.message?.includes('ENOTFOUND') ||
                        networkError.code === 'ENOTFOUND';
      
      return res.status(500).json({ 
        error: 'Database error occurred: ' + networkError.message,
        details: isDnsError 
          ? 'DNS resolution failed - cannot resolve Supabase hostname. Please check:\n' +
            '- Your internet connection\n' +
            '- DNS server configuration\n' +
            '- If the Supabase URL is correct: ' + supabaseUrl
          : 'Unable to connect to Supabase. Please check your internet connection and Supabase URL configuration.',
        type: 'network_error',
        url: supabaseUrl
      });
    }

    if (fetchError) {
      console.error('❌ Database query error:', fetchError);
      return res.status(500).json({ 
        error: 'Database connection failed. Please check your Supabase configuration.',
        details: fetchError.message 
      });
    }

    // Check if email already exists (case-insensitive)
    const existingUser = allUsers?.find(u => {
      if (!u.email) return false;
      const userEmail = u.email.trim().toLowerCase();
      return userEmail === normalizedEmail;
    });

    if (existingUser) {
      console.log('User already exists with email:', normalizedEmail);
      return res.status(400).json({ error: 'An account with this email already exists' });
    }

    // Insert new user into users table (let database auto-generate ID if it's auto-increment)
    console.log('Inserting new user into database...');
    console.log('User data to insert:', {
      email: originalEmail,
      password: '***' + password.trim().substring(password.length - 2),
      first_name: first_name ? first_name.trim() : null,
      last_name: last_name ? last_name.trim() : null,
    });
    
    let insertResult, insertError;
    try {
      // Try insert without .single() first to see if that's the issue
      let result = await supabase
        .from('users')
        .insert({
          email: originalEmail,
          password: password.trim(), // Store password as plain text (matching login logic)
          first_name: first_name ? first_name.trim() : null,
          last_name: last_name ? last_name.trim() : null,
        })
        .select();
      
      console.log('Insert result (without .single()):', JSON.stringify(result, null, 2));
      
      insertError = result.error;
      
      // If no error, try to get the data
      if (!insertError && result.data && result.data.length > 0) {
        insertResult = result.data[0];
        console.log('✅ Got user data from insert:', insertResult);
      } else if (!insertError && result.data && result.data.length === 0) {
        console.error('❌ Insert returned empty array - no data inserted');
        // Try with .single() to get better error message
        result = await supabase
          .from('users')
          .insert({
            email: originalEmail,
            password: password.trim(),
            first_name: first_name ? first_name.trim() : null,
            last_name: last_name ? last_name.trim() : null,
          })
          .select()
          .single();
        
        insertResult = result.data;
        insertError = result.error;
      }
      
      if (insertError) {
        console.error('❌ Supabase insert error:', insertError);
        console.error('Error code:', insertError.code);
        console.error('Error message:', insertError.message);
        console.error('Error details:', insertError.details);
        console.error('Error hint:', insertError.hint);
      } else if (!insertResult) {
        console.error('❌ No data returned from insert, but no error either');
      }
    } catch (networkError) {
      console.error('❌ Network error inserting user:', networkError);
      console.error('Error type:', networkError.name);
      console.error('Error message:', networkError.message);
      console.error('Error stack:', networkError.stack);
      return res.status(500).json({ 
        error: 'Database error occurred: ' + networkError.message,
        details: 'Unable to connect to Supabase. Please check your internet connection.',
        type: 'network_error'
      });
    }

    if (insertError) {
      console.error('❌ Error inserting user:', insertError);
      return res.status(500).json({ 
        error: 'Failed to create account. Please try again.',
        details: insertError.message || JSON.stringify(insertError),
        code: insertError.code
      });
    }

    if (!insertResult) {
      console.error('❌ Insert succeeded but no data returned');
      return res.status(500).json({ 
        error: 'User was created but data could not be retrieved. Please try logging in.',
      });
    }

    console.log('✅ Registration successful for user:', originalEmail);
    console.log('✅ Inserted user ID:', insertResult.id);

    // Remove OTP from store after successful registration (only if OTP was used)
    if (!skipOTP) {
      otpStore.delete(normalizedEmail);
    }

    // Remove password from response for security
    const { password: userPassword, ...userData } = insertResult;

    // Create a simple session object (matching login format)
    const session = {
      access_token: 'custom_token_' + Date.now(),
      user: {
        id: insertResult.id,
        email: insertResult.email,
      },
    };

    res.json({
      user: {
        id: insertResult.id,
        email: insertResult.email,
        first_name: insertResult.first_name || null,
        last_name: insertResult.last_name || null,
      },
      session: session,
      userData: userData,
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Logout endpoint
router.post('/logout', async (req, res) => {
  try {
    const { session } = req.body;

    if (!session) {
      return res.status(400).json({ error: 'Session is required' });
    }

    const { error } = await supabase.auth.signOut();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Forgot password endpoint
router.post('/forgot-password', async (req, res) => {
  try {
    const { email, redirectTo } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: redirectTo || `${process.env.FRONTEND_URL || 'http://localhost:3000'}/reset-password`,
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ message: 'Password reset email sent successfully' });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Reset password endpoint
router.post('/reset-password', async (req, res) => {
  try {
    const { email, password, token } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long' });
    }

    // Find user by email
    const normalizedEmail = email.trim().toLowerCase();
    const { data: allUsers, error: fetchError } = await supabase
      .from('users')
      .select('*');

    if (fetchError) {
      console.error('Database query error:', fetchError);
      return res.status(500).json({ 
        error: 'Database connection failed. Please check your Supabase configuration.',
        details: fetchError.message 
      });
    }

    const user = allUsers?.find(u => {
      if (!u.email) return false;
      const userEmail = u.email.trim().toLowerCase();
      return userEmail === normalizedEmail;
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Update password in users table
    const { data: updatedUser, error: updateError } = await supabase
      .from('users')
      .update({ password: password.trim() })
      .eq('id', user.id)
      .select()
      .single();

    if (updateError) {
      console.error('Password update error:', updateError);
      return res.status(500).json({ 
        error: 'Failed to update password. Please try again.',
        details: updateError.message 
      });
    }

    // Remove password from response
    const { password: userPassword, ...userData } = updatedUser;

    res.json({ 
      message: 'Password reset successfully',
      user: userData
    });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Verify token endpoint
router.post('/verify-token', async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    const { data, error } = await supabase.auth.getUser(token);

    if (error) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    res.json({ user: data.user });
  } catch (error) {
    console.error('Verify token error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Google OAuth - Initiate login
router.get('/google', async (req, res) => {
  try {
    const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
    const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/auth/google/callback`;
    const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

    if (!GOOGLE_CLIENT_ID) {
      return res.status(500).json({ error: 'Google OAuth not configured. Please set GOOGLE_CLIENT_ID environment variable.' });
    }

    // Generate state for CSRF protection
    const state = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    
    // Store state in session/cookie (for production, use proper session management)
    // For now, we'll include it in the redirect URL
    const scope = 'openid email profile';
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${GOOGLE_CLIENT_ID}&` +
      `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
      `response_type=code&` +
      `scope=${encodeURIComponent(scope)}&` +
      `state=${state}&` +
      `access_type=offline&` +
      `prompt=consent`;

    // Store state in cookie or return it to frontend
    res.cookie('oauth_state', state, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 600000 });
    res.redirect(authUrl);
  } catch (error) {
    console.error('Google OAuth initiation error:', error);
    res.status(500).json({ error: 'Failed to initiate Google login' });
  }
});

// Google OAuth - Callback handler
router.get('/google/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;
    const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

    if (error) {
      console.error('Google OAuth error:', error);
      return res.redirect(`${FRONTEND_URL}/accounts/signup?error=${encodeURIComponent(error)}`);
    }

    if (!code) {
      return res.redirect(`${FRONTEND_URL}/accounts/signup?error=${encodeURIComponent('No authorization code received')}`);
    }

    const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
    const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
    const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/auth/google/callback`;

    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      return res.redirect(`${FRONTEND_URL}/accounts/signup?error=${encodeURIComponent('Google OAuth not configured')}`);
    }

    // Exchange code for access token
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        code: code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.json().catch(() => ({}));
      console.error('Token exchange error:', errorData);
      return res.redirect(`${FRONTEND_URL}/accounts/signup?error=${encodeURIComponent('Failed to exchange authorization code')}`);
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    // Get user info from Google
    const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!userInfoResponse.ok) {
      console.error('Failed to fetch user info from Google');
      return res.redirect(`${FRONTEND_URL}/accounts/signup?error=${encodeURIComponent('Failed to get user information')}`);
    }

    const googleUser = await userInfoResponse.json();
    const { email, given_name, family_name, name, picture, id: googleId } = googleUser;

    if (!email) {
      return res.redirect(`${FRONTEND_URL}/accounts/signup?error=${encodeURIComponent('Email not provided by Google')}`);
    }

    const normalizedEmail = email.trim().toLowerCase();
    const originalEmail = email.trim();

    // Check if user already exists
    let allUsers, fetchError;
    try {
      const result = await supabase.from('users').select('*');
      allUsers = result.data;
      fetchError = result.error;
    } catch (networkError) {
      console.error('❌ Network error connecting to Supabase:', networkError);
      return res.redirect(`${FRONTEND_URL}/accounts/signup?error=${encodeURIComponent('Database connection failed')}`);
    }

    if (fetchError) {
      console.error('❌ Database query error:', fetchError);
      return res.redirect(`${FRONTEND_URL}/accounts/signup?error=${encodeURIComponent('Database error')}`);
    }

    // Find existing user
    const existingUser = allUsers?.find((u) => {
      if (!u.email) return false;
      const userEmail = u.email.trim().toLowerCase();
      return userEmail === normalizedEmail;
    });

    let user;
    if (existingUser) {
      // User exists - login
      user = existingUser;
      console.log('✅ Google login successful for existing user:', originalEmail);
    } else {
      // New user - create account
      console.log('Creating new user from Google OAuth:', originalEmail);
      
      const insertResult = await supabase
        .from('users')
        .insert({
          email: originalEmail,
          first_name: given_name || name?.split(' ')[0] || null,
          last_name: family_name || name?.split(' ').slice(1).join(' ') || null,
          password: `google_oauth_${googleId}`, // Special password for Google users
          // Store Google ID for future reference
        })
        .select()
        .single();

      if (insertResult.error) {
        console.error('❌ Error creating user:', insertResult.error);
        return res.redirect(`${FRONTEND_URL}/accounts/signup?error=${encodeURIComponent('Failed to create account')}`);
      }

      user = insertResult.data;
      console.log('✅ Google registration successful for new user:', originalEmail);
    }

    // Create session
    const { password: userPassword, ...userData } = user;
    const session = {
      access_token: 'custom_token_' + Date.now(),
      user: {
        id: user.id,
        email: user.email,
      },
    };

    // Store user data in a temporary token/code that frontend can exchange
    // For simplicity, we'll encode it in the redirect URL (in production, use proper session storage)
    const userToken = Buffer.from(JSON.stringify({ user: userData, session })).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    
    // Redirect to frontend with success token
    res.redirect(`${FRONTEND_URL}/accounts/signup?google_success=1&token=${encodeURIComponent(userToken)}`);
  } catch (error) {
    console.error('Google OAuth callback error:', error);
    const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
    res.redirect(`${FRONTEND_URL}/accounts/signup?error=${encodeURIComponent('OAuth authentication failed')}`);
  }
});

module.exports = router;

