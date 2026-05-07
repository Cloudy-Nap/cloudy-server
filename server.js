require('dotenv').config();

const express = require('express');
const cors = require('cors');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const orderRoutes = require('./routes/orders');
const laptopRoutes = require('./routes/laptops');
const printerRoutes = require('./routes/printers');
const scannerRoutes = require('./routes/scanners');
const productRoutes = require('./routes/products');
const catalogRoutes = require('./routes/catalog');
const cmsAuthRoutes = require('./routes/cmsAuth');
const activitiesRoutes = require('./routes/activities');
const { publicRouter: categoryDiscountsPublic, cmsRouter: categoryDiscountsCms } = require('./routes/categoryDiscounts');
const catalogDealsRoutes = require('./routes/catalogDeals');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/laptops', laptopRoutes);
app.use('/api/printers', printerRoutes);
app.use('/api/scanners', scannerRoutes);
app.use('/api/catalog', catalogRoutes);
app.use('/api/products', productRoutes);
app.use('/api/discounts', categoryDiscountsPublic);
// Register before `/api/cms` catch-all style routes
app.use('/api/cms/activities', activitiesRoutes);
app.use('/api/cms/discounts', categoryDiscountsCms);
app.use('/api/cms/deals', catalogDealsRoutes);
app.use('/api/cms', cmsAuthRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Server is running' });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

