// server.js - Multi-Location Version with Supabase Integration and Image Upload
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://yltdxkkqfnhqpgqtobwu.supabase.co',
  process.env.SUPABASE_ANON_KEY || 'your-anon-key-here'
);

// Create uploads directory
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for image uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'image-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|webp/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        
        if (mimetype && extname) {
            return cb(null, true);
        }
        cb(new Error('Only image files are allowed (PNG, JPG, GIF, WEBP)'));
    }
});

// In-memory storage for locations (in production, use a database)
const userLocations = {};

// Middleware
app.use(cors({
  origin: process.env.APP_URL || `http://localhost:${PORT}`,
  credentials: true
}));
app.use(express.json());

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-session-secret-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Initialize Passport
app.use(passport.initialize());
app.use(passport.session());

// Passport serialization
passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((user, done) => {
  done(null, user);
});

// Google OAuth Strategy
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL || '/auth/google/callback'
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      const user = {
        id: profile.id,
        displayName: profile.displayName,
        email: profile.emails[0].value,
        photo: profile.photos[0].value,
        authType: 'google'
      };
      
      // Initialize user's locations array if not exists
      if (!userLocations[user.id]) {
        userLocations[user.id] = [];
      }
      
      return done(null, user);
    } catch (error) {
      console.error('Google OAuth error:', error);
      return done(error);
    }
  }
));

// LeadConnector API configuration
const GHL_API_BASE_URL = 'https://services.leadconnectorhq.com';
const GHL_API_VERSION = '2021-07-28';

// Helper function to create axios instance with auth headers for a specific location
const createGHLClient = (token) => {
  return axios.create({
    baseURL: GHL_API_BASE_URL,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Version': GHL_API_VERSION,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    }
  });
};

// Authentication middleware
const ensureAuthenticated = (req, res, next) => {
  if (req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ 
    success: false, 
    error: 'Authentication required',
    loginUrl: '/auth/google'
  });
};

// Serve static files from public directory
app.use(express.static('public'));

// Authentication Routes
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login.html' }),
  (req, res) => {
    res.redirect('/');
  }
);

app.get('/auth/logout', (req, res) => {
  req.logout((err) => {
    if (err) {
      return res.status(500).json({ success: false, error: 'Logout failed' });
    }
    res.redirect('/login.html');
  });
});

// Supabase Auth - Email/Password Registration
app.post('/auth/register', async (req, res) => {
  const { email, password, displayName } = req.body;
  
  if (!email || !password) {
    return res.status(400).json({
      success: false,
      error: 'Email and password are required'
    });
  }
  
  if (password.length < 8) {
    return res.status(400).json({
      success: false,
      error: 'Password must be at least 8 characters'
    });
  }
  
  try {
    // Use Supabase Auth to create user
    const { data, error } = await supabase.auth.signUp({
      email: email.toLowerCase(),
      password: password,
      options: {
        data: {
          display_name: displayName || email.split('@')[0]
        }
      }
    });
    
    if (error) {
      console.error('Supabase registration error:', error);
      return res.status(400).json({
        success: false,
        error: error.message || 'Registration failed'
      });
    }
    
    // Also create entry in your users table
    if (data.user) {
      await supabase
        .from('users')
        .insert({
          id: data.user.id,
          email: email.toLowerCase(),
          display_name: displayName || email.split('@')[0],
          created_at: new Date().toISOString()
        });
    }
    
    res.json({
      success: true,
      message: 'Account created successfully. You can now login.'
    });
    
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      success: false,
      error: 'Registration failed'
    });
  }
});

// Supabase Auth - Email/Password Login
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.status(400).json({
      success: false,
      error: 'Email and password are required'
    });
  }
  
  try {
    // Use Supabase Auth to sign in
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.toLowerCase(),
      password: password
    });
    
    if (error) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }
    
    // Get user data from your users table
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('id', data.user.id)
      .single();
    
    // Update last login
    await supabase
      .from('users')
      .update({ last_login: new Date().toISOString() })
      .eq('id', data.user.id);
    
    // Create session user object
    const userObj = {
      id: data.user.id,
      email: data.user.email,
      displayName: userData?.display_name || data.user.email.split('@')[0],
      photo: userData?.photo_url || '',
      authType: 'email'
    };
    
    // Log them into Express session
    req.logIn(userObj, (err) => {
      if (err) {
        return res.status(500).json({
          success: false,
          error: 'Login failed'
        });
      }
      
      // Initialize locations
      if (!userLocations[userObj.id]) {
        userLocations[userObj.id] = [];
      }
      
      return res.json({
        success: true,
        message: 'Login successful',
        user: {
          id: userObj.id,
          email: userObj.email,
          displayName: userObj.displayName
        }
      });
    });
    
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      error: 'Login failed'
    });
  }
});

// Get current user info
app.get('/api/user', (req, res) => {
  if (req.isAuthenticated()) {
    res.json({
      success: true,
      user: req.user
    });
  } else {
    res.json({
      success: false,
      user: null
    });
  }
});

// LOCATION MANAGEMENT ENDPOINTS

// Get all locations for current user - LOAD FROM SUPABASE
app.get('/api/locations', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  
  try {
    // Load locations from Supabase
    const { data, error } = await supabase
      .from('saved_locations')
      .select('*')
      .eq('user_id', userId)
      .order('added_at', { ascending: false });
    
    if (!error && data) {
      // Update memory cache and format for compatibility
      userLocations[userId] = data.map(loc => ({
        id: loc.id,
        name: loc.name,
        locationId: loc.location_id,
        token: loc.token,
        ghlName: loc.ghl_name,
        email: loc.email,
        addedAt: loc.added_at,
        lastUsed: loc.last_used
      }));
      
      // Send to client without tokens
      const sanitizedLocations = userLocations[userId].map(loc => ({
        ...loc,
        token: '***'
      }));
      
      res.json({
        success: true,
        locations: sanitizedLocations
      });
    } else {
      res.json({
        success: true,
        locations: []
      });
    }
  } catch (err) {
    console.error('Failed to load locations:', err);
    res.json({
      success: true,
      locations: []
    });
  }
});

// Add a new location
app.post('/api/locations', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { name, locationId, token } = req.body;
  
  if (!name || !locationId || !token) {
    return res.status(400).json({
      success: false,
      error: 'Name, locationId, and token are required'
    });
  }
  
  // Test the connection
  try {
    const client = createGHLClient(token);
    const response = await client.get(`/locations/${locationId}`);
    
    // Get location details
    const locationData = response.data?.location || response.data;
    
    // Create location object
    const newLocation = {
      id: Date.now().toString(),
      name: name,
      locationId: locationId,
      token: token,
      ghlName: locationData?.name || locationData?.companyName || name,
      email: locationData?.email || '',
      addedAt: new Date().toISOString(),
      lastUsed: null
    };
    
    // Add to user's locations
    if (!userLocations[userId]) {
      userLocations[userId] = [];
    }
    userLocations[userId].push(newLocation);
    
    // SAVE TO SUPABASE FOR PERSISTENCE
    try {
      await supabase
        .from('saved_locations')
        .insert({
          id: newLocation.id,
          user_id: userId,
          name: newLocation.name,
          location_id: newLocation.locationId,
          token: newLocation.token,
          ghl_name: newLocation.ghlName,
          email: newLocation.email,
          added_at: newLocation.addedAt,
          last_used: newLocation.lastUsed
        });
    } catch (dbError) {
      console.error('Failed to save location to database:', dbError);
    }
    
    await initializeSupabaseTables(locationId);
    
    res.json({
      success: true,
      location: {
        ...newLocation,
        token: '***'
      }
    });
  } catch (error) {
    console.error('Failed to verify location:', error.response?.data || error.message);
    res.status(400).json({
      success: false,
      error: 'Failed to verify location credentials. Please check your token and location ID.'
    });
  }
});

async function initializeSupabaseTables(locationId) {
  try {
    const { data, error } = await supabase
      .from('location_sync_status')
      .upsert({
        location_id: locationId,
        last_sync: new Date().toISOString(),
        status: 'active'
      }, {
        onConflict: 'location_id'
      });
    
    if (error) {
      console.error('Failed to initialize Supabase tables:', error);
    }
  } catch (error) {
    console.error('Supabase initialization error:', error);
  }
}

// Update a location
app.put('/api/locations/:id', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const locationId = req.params.id;
  const { name, token } = req.body;
  
  if (!userLocations[userId]) {
    return res.status(404).json({
      success: false,
      error: 'Location not found'
    });
  }
  
  const locationIndex = userLocations[userId].findIndex(loc => loc.id === locationId);
  if (locationIndex === -1) {
    return res.status(404).json({
      success: false,
      error: 'Location not found'
    });
  }
  
  if (name) userLocations[userId][locationIndex].name = name;
  if (token) {
    try {
      const client = createGHLClient(token);
      await client.get(`/locations/${userLocations[userId][locationIndex].locationId}`);
      userLocations[userId][locationIndex].token = token;
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: 'Invalid token provided'
      });
    }
  }
  
  res.json({
    success: true,
    location: {
      ...userLocations[userId][locationIndex],
      token: '***'
    }
  });
});

// Delete a location - ALSO DELETE FROM SUPABASE
app.delete('/api/locations/:id', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const locationId = req.params.id;
  
  if (!userLocations[userId]) {
    return res.status(404).json({
      success: false,
      error: 'Location not found'
    });
  }
  
  const locationIndex = userLocations[userId].findIndex(loc => loc.id === locationId);
  if (locationIndex === -1) {
    return res.status(404).json({
      success: false,
      error: 'Location not found'
    });
  }
  
  userLocations[userId].splice(locationIndex, 1);
  
  try {
    await supabase
      .from('saved_locations')
      .delete()
      .eq('id', locationId)
      .eq('user_id', userId);
  } catch (dbError) {
    console.error('Failed to delete from database:', dbError);
  }
  
  res.json({
    success: true,
    message: 'Location removed successfully'
  });
});

// Test connection for a specific location
app.post('/api/test-location', ensureAuthenticated, async (req, res) => {
  const { locationId, token } = req.body;
  
  if (!locationId || !token) {
    return res.status(400).json({
      success: false,
      error: 'locationId and token are required'
    });
  }
  
  try {
    const client = createGHLClient(token);
    const response = await client.get(`/locations/${locationId}`);
    
    const locationData = response.data?.location || response.data;
    
    res.json({
      success: true,
      message: 'Connection successful',
      location: {
        name: locationData?.name || locationData?.companyName || 'Location accessible',
        id: locationData?.id || locationData?._id || locationId,
        email: locationData?.email
      }
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.response?.data?.message || 'Connection failed',
      details: error.response?.data
    });
  }
});

// IMAGE UPLOAD ENDPOINT
app.post('/api/locations/:locationId/upload-image', ensureAuthenticated, upload.single('image'), (req, res) => {
  const userId = req.user.id;
  const { locationId } = req.params;
  
  const location = userLocations[userId]?.find(loc => loc.id === locationId);
  if (!location) {
    return res.status(404).json({ 
      success: false, 
      error: 'Location not found' 
    });
  }
  
  if (!req.file) {
    return res.status(400).json({ 
      success: false, 
      error: 'No image file uploaded' 
    });
  }
  
  const imageUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
  
  res.json({
    success: true,
    imageUrl: imageUrl,
    filename: req.file.filename
  });
});

// CUSTOM FIELDS ENDPOINTS

app.get('/api/locations/:locationId/custom-fields', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { locationId } = req.params;
  
  const location = userLocations[userId]?.find(loc => loc.id === locationId);
  if (!location) {
    return res.status(404).json({
      success: false,
      error: 'Location not found'
    });
  }
  
  try {
    const client = createGHLClient(location.token);
    const response = await client.get(`/locations/${location.locationId}/customFields`);
    
    location.lastUsed = new Date().toISOString();
    
    res.json({
      success: true,
      customFields: response.data.customFields || response.data || [],
      count: (response.data.customFields || response.data || []).length
    });
  } catch (error) {
    console.error('Failed to fetch custom fields:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.message || error.message
    });
  }
});

app.post('/api/locations/:locationId/custom-fields', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { locationId } = req.params;
  
  const location = userLocations[userId]?.find(loc => loc.id === locationId);
  if (!location) {
    return res.status(404).json({
      success: false,
      error: 'Location not found'
    });
  }
  
  const { name, dataType, placeholder, position, model } = req.body;
  
  if (!name || !dataType) {
    return res.status(400).json({
      success: false,
      error: 'Name and dataType are required fields'
    });
  }
  
  const allowedDataTypes = ['TEXT', 'TEXTBOX_LIST', 'NUMBER', 'PHONE', 'MONETARYAMOUNT', 
                            'CHECKBOX', 'DROPDOWN', 'RADIO', 'DATE'];
  if (!allowedDataTypes.includes(dataType)) {
    return res.status(400).json({
      success: false,
      error: `Invalid dataType. Must be one of: ${allowedDataTypes.join(', ')}`
    });
  }
  
  try {
    const client = createGHLClient(location.token);
    const payload = {
      name,
      dataType,
      placeholder: placeholder || '',
      position: position || 0,
      model: model || 'contact'
    };
    
    const response = await client.post(`/locations/${location.locationId}/customFields`, payload);
    
    location.lastUsed = new Date().toISOString();
    
    res.json({
      success: true,
      customField: response.data.customField,
      message: 'Custom field created successfully'
    });
  } catch (error) {
    console.error('Failed to create custom field:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.message || error.message
    });
  }
});

app.put('/api/locations/:locationId/custom-fields/:fieldId', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { locationId, fieldId } = req.params;
  
  const location = userLocations[userId]?.find(loc => loc.id === locationId);
  if (!location) {
    return res.status(404).json({
      success: false,
      error: 'Location not found'
    });
  }
  
  try {
    const client = createGHLClient(location.token);
    const response = await client.put(
      `/locations/${location.locationId}/customFields/${fieldId}`,
      req.body
    );
    
    location.lastUsed = new Date().toISOString();
    
    res.json({
      success: true,
      customField: response.data.customField,
      message: 'Custom field updated successfully'
    });
  } catch (error) {
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.message || error.message
    });
  }
});

app.delete('/api/locations/:locationId/custom-fields/:fieldId', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { locationId, fieldId } = req.params;
  
  const location = userLocations[userId]?.find(loc => loc.id === locationId);
  if (!location) {
    return res.status(404).json({
      success: false,
      error: 'Location not found'
    });
  }
  
  try {
    const client = createGHLClient(location.token);
    await client.delete(`/locations/${location.locationId}/customFields/${fieldId}`);
    
    location.lastUsed = new Date().toISOString();
    
    res.json({
      success: true,
      message: 'Custom field deleted successfully'
    });
  } catch (error) {
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.message || error.message
    });
  }
});

// CLONE/COPY ENDPOINTS

// Clone custom fields from one location to another
app.post('/api/locations/:sourceId/clone-fields', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { sourceId } = req.params;
  const { targetLocationIds, fieldIds } = req.body;
  
  if (!targetLocationIds || !Array.isArray(targetLocationIds) || targetLocationIds.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Target location IDs are required'
    });
  }
  
  const sourceLocation = userLocations[userId]?.find(loc => loc.id === sourceId);
  if (!sourceLocation) {
    return res.status(404).json({
      success: false,
      error: 'Source location not found'
    });
  }
  
  try {
    // Get fields from source location
    const sourceClient = createGHLClient(sourceLocation.token);
    const sourceResponse = await sourceClient.get(`/locations/${sourceLocation.locationId}/customFields`);
    let fieldsToClone = sourceResponse.data.customFields || [];
    
    // Filter to specific fields if provided
    if (fieldIds && fieldIds.length > 0) {
      fieldsToClone = fieldsToClone.filter(f => fieldIds.includes(f.id));
    }
    
    const results = {
      success: 0,
      failed: 0,
      details: [],
      locationResults: {}
    };
    
    // Clone to each target location
    for (const targetId of targetLocationIds) {
      const targetLocation = userLocations[userId]?.find(loc => loc.id === targetId);
      if (!targetLocation) {
        results.failed++;
        results.details.push({
          locationId: targetId,
          locationName: 'Unknown Location',
          error: 'Target location not found',
          itemName: 'N/A'
        });
        continue;
      }
      
      // Initialize results for this location
      if (!results.locationResults[targetId]) {
        results.locationResults[targetId] = {
          locationId: targetId,
          locationName: targetLocation.name,
          success: 0,
          failed: 0,
          errors: []
        };
      }
      
      const targetClient = createGHLClient(targetLocation.token);
      
      for (const field of fieldsToClone) {
        try {
          const payload = {
            name: field.name,
            dataType: field.dataType,
            placeholder: field.placeholder || '',
            position: field.position || 0,
            model: field.model || 'contact'
          };
          
          await targetClient.post(`/locations/${targetLocation.locationId}/customFields`, payload);
          results.success++;
          results.locationResults[targetId].success++;
        } catch (error) {
          results.failed++;
          results.locationResults[targetId].failed++;
          
          const errorDetail = {
            locationId: targetId,
            locationName: targetLocation.name,
            itemName: field.name,
            itemType: 'field',
            error: error.response?.data?.message || error.message
          };
          
          results.details.push(errorDetail);
          results.locationResults[targetId].errors.push(errorDetail);
        }
      }
    }
    
    res.json({
      success: true,
      results
    });
    
  } catch (error) {
    console.error('Clone fields error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Clone custom values from one location to another
app.post('/api/locations/:sourceId/clone-values', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { sourceId } = req.params;
  const { targetLocationIds, valueIds } = req.body;
  
  if (!targetLocationIds || !Array.isArray(targetLocationIds) || targetLocationIds.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Target location IDs are required'
    });
  }
  
  const sourceLocation = userLocations[userId]?.find(loc => loc.id === sourceId);
  if (!sourceLocation) {
    return res.status(404).json({
      success: false,
      error: 'Source location not found'
    });
  }
  
  try {
    // Get values from source location
    const sourceClient = createGHLClient(sourceLocation.token);
    const sourceResponse = await sourceClient.get(`/locations/${sourceLocation.locationId}/customValues`);
    let valuesToClone = sourceResponse.data.customValues || [];
    
    // Filter to specific values if provided
    if (valueIds && valueIds.length > 0) {
      valuesToClone = valuesToClone.filter(v => valueIds.includes(v.id));
    }
    
    const results = {
      success: 0,
      failed: 0,
      details: [],
      locationResults: {}
    };
    
    // Clone to each target location
    for (const targetId of targetLocationIds) {
      const targetLocation = userLocations[userId]?.find(loc => loc.id === targetId);
      if (!targetLocation) {
        results.failed++;
        results.details.push({
          locationId: targetId,
          locationName: 'Unknown Location',
          error: 'Target location not found',
          itemName: 'N/A'
        });
        continue;
      }
      
      // Initialize results for this location
      if (!results.locationResults[targetId]) {
        results.locationResults[targetId] = {
          locationId: targetId,
          locationName: targetLocation.name,
          success: 0,
          failed: 0,
          errors: []
        };
      }
      
      const targetClient = createGHLClient(targetLocation.token);
      
      for (const value of valuesToClone) {
        try {
          const payload = {
            name: value.name,
            value: value.value
          };
          
          await targetClient.post(`/locations/${targetLocation.locationId}/customValues`, payload);
          results.success++;
          results.locationResults[targetId].success++;
        } catch (error) {
          results.failed++;
          results.locationResults[targetId].failed++;
          
          const errorDetail = {
            locationId: targetId,
            locationName: targetLocation.name,
            itemName: value.name,
            itemType: 'value',
            error: error.response?.data?.message || error.message
          };
          
          results.details.push(errorDetail);
          results.locationResults[targetId].errors.push(errorDetail);
        }
      }
    }
    
    res.json({
      success: true,
      results
    });
    
  } catch (error) {
    console.error('Clone values error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// CUSTOM VALUES ENDPOINTS

async function syncCustomValues(locationId, ghlToken) {
  try {
    const client = createGHLClient(ghlToken);
    const response = await client.get(`/locations/${locationId}/customValues`);
    
    const rawValues = response.data.customValues || [];
    
    const cleanedValues = rawValues.map(item => ({
      id: item.id,
      location_id: locationId,
      name: item.name || '',
      value: item.value || '',
      field_key: item.fieldKey || '',
      document_type: item.documentType || 'field',
      parent_id: item.parentId || null,
      synced_at: new Date().toISOString()
    }));
    
    const { data, error } = await supabase
      .from('custom_values')
      .upsert(cleanedValues, {
        onConflict: 'id'
      });
    
    if (error) {
      console.error('Failed to sync to Supabase:', error);
      return { success: false, error };
    }
    
    return { success: true, data: cleanedValues };
  } catch (error) {
    console.error('Sync error:', error);
    return { success: false, error };
  }
}

app.get('/api/locations/:locationId/custom-values', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { locationId } = req.params;
  const { forceSync } = req.query;
  
  const location = userLocations[userId]?.find(loc => loc.id === locationId);
  if (!location) {
    return res.status(404).json({
      success: false,
      error: 'Location not found'
    });
  }
  
  try {
    const { data: supabaseValues, error: supabaseError } = await supabase
      .from('custom_values')
      .select('*')
      .eq('location_id', location.locationId)
      .order('name', { ascending: true });
    
    if (forceSync || !supabaseValues || supabaseValues.length === 0) {
      console.log('Syncing from GoHighLevel...');
      const syncResult = await syncCustomValues(location.locationId, location.token);
      
      if (syncResult.success) {
        res.json({
          success: true,
          customValues: syncResult.data.map(v => ({
            id: v.id,
            name: v.name,
            value: v.value || '',
            fieldKey: v.field_key
          })),
          count: syncResult.data.length,
          source: 'ghl_sync'
        });
      } else {
        if (supabaseValues && supabaseValues.length > 0) {
          res.json({
            success: true,
            customValues: supabaseValues.map(v => ({
              id: v.id,
              name: v.name,
              value: v.value || '',
              fieldKey: v.field_key
            })),
            count: supabaseValues.length,
            source: 'supabase_cache'
          });
        } else {
          throw new Error('Failed to sync and no cached data available');
        }
      }
    } else {
      res.json({
        success: true,
        customValues: supabaseValues.map(v => ({
          id: v.id,
          name: v.name,
          value: v.value || '',
          fieldKey: v.field_key
        })),
        count: supabaseValues.length,
        source: 'supabase'
      });
    }
    
    location.lastUsed = new Date().toISOString();
    
  } catch (error) {
    console.error('Failed to fetch custom values:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch custom values'
    });
  }
});

app.post('/api/locations/:locationId/custom-values', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { locationId } = req.params;
  
  const location = userLocations[userId]?.find(loc => loc.id === locationId);
  if (!location) {
    return res.status(404).json({
      success: false,
      error: 'Location not found'
    });
  }
  
  const { name, value } = req.body;
  
  if (!name || !value) {
    return res.status(400).json({
      success: false,
      error: 'Name and value are required fields'
    });
  }
  
  try {
    const client = createGHLClient(location.token);
    const payload = { name, value };
    
    const response = await client.post(`/locations/${location.locationId}/customValues`, payload);
    const createdValue = response.data.customValue;
    
    const { data: supabaseData, error: supabaseError } = await supabase
      .from('custom_values')
      .upsert({
        id: createdValue.id,
        location_id: location.locationId,
        name: createdValue.name || name,
        value: createdValue.value || value,
        field_key: createdValue.fieldKey || '',
        document_type: 'field',
        synced_at: new Date().toISOString()
      });
    
    if (supabaseError) {
      console.error('Failed to save to Supabase:', supabaseError);
    }
    
    location.lastUsed = new Date().toISOString();
    
    res.json({
      success: true,
      customValue: {
        id: createdValue.id,
        name: createdValue.name || name,
        value: createdValue.value || value
      },
      message: 'Custom value created successfully'
    });
  } catch (error) {
    console.error('Failed to create custom value:', error);
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.message || error.message
    });
  }
});

app.put('/api/locations/:locationId/custom-values/:valueId', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { locationId, valueId } = req.params;
  
  const location = userLocations[userId]?.find(loc => loc.id === locationId);
  if (!location) {
    return res.status(404).json({
      success: false,
      error: 'Location not found'
    });
  }
  
  try {
    const client = createGHLClient(location.token);
    const response = await client.put(
      `/locations/${location.locationId}/customValues/${valueId}`,
      req.body
    );
    
    const { error: supabaseError } = await supabase
      .from('custom_values')
      .update({
        name: req.body.name,
        value: req.body.value,
        synced_at: new Date().toISOString()
      })
      .eq('id', valueId);
    
    if (supabaseError) {
      console.error('Failed to update Supabase:', supabaseError);
    }
    
    location.lastUsed = new Date().toISOString();
    
    res.json({
      success: true,
      customValue: response.data.customValue,
      message: 'Custom value updated successfully'
    });
  } catch (error) {
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.message || error.message
    });
  }
});

app.delete('/api/locations/:locationId/custom-values/:valueId', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { locationId, valueId } = req.params;
  
  const location = userLocations[userId]?.find(loc => loc.id === locationId);
  if (!location) {
    return res.status(404).json({
      success: false,
      error: 'Location not found'
    });
  }
  
  try {
    const client = createGHLClient(location.token);
    await client.delete(`/locations/${location.locationId}/customValues/${valueId}`);
    
    const { error: supabaseError } = await supabase
      .from('custom_values')
      .delete()
      .eq('id', valueId);
    
    if (supabaseError) {
      console.error('Failed to delete from Supabase:', supabaseError);
    }
    
    location.lastUsed = new Date().toISOString();
    
    res.json({
      success: true,
      message: 'Custom value deleted successfully'
    });
  } catch (error) {
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.message || error.message
    });
  }
});

app.post('/api/locations/:locationId/sync-values', ensureAuthenticated, async (req, res) => {
  const userId = req.user.id;
  const { locationId } = req.params;
  
  const location = userLocations[userId]?.find(loc => loc.id === locationId);
  if (!location) {
    return res.status(404).json({
      success: false,
      error: 'Location not found'
    });
  }
  
  try {
    const syncResult = await syncCustomValues(location.locationId, location.token);
    
    if (syncResult.success) {
      res.json({
        success: true,
        message: 'Values synced successfully',
        count: syncResult.data.length
      });
    } else {
      throw new Error(syncResult.error);
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Sync failed: ' + error.message
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    supabase: supabase ? 'connected' : 'not configured'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Multi-Location LeadConnector Server Started');
  console.log('- Google OAuth:', process.env.GOOGLE_CLIENT_ID ? 'Configured ✓' : 'Not configured ✗');
  console.log('- Session Secret:', process.env.SESSION_SECRET ? 'Custom ✓' : 'Using default ⚠');
  console.log('- Supabase:', process.env.SUPABASE_URL ? 'Connected ✓' : 'Not configured ✗');
  console.log('- Uploads Directory:', uploadsDir);
  console.log('');
  console.log(`Application available at http://localhost:${PORT}`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  process.exit(0);
});