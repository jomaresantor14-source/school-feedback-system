require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');

const db = require('./config/db');
const helpers = require('./lib/helpers');
const { icon } = require('./lib/icons');
const { DEPT_ROLES } = require('./lib/constants');
const { verifyCsrf } = require('./middleware/auth');

const feedbackRoutes = require('./routes/feedback');
const authRoutes = require('./routes/auth');
const staffRoutes = require('./routes/staff');

const app = express();

app.disable('x-powered-by');
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Helpers that every page can use
app.locals.fmtDate = helpers.fmtDate;
app.locals.formatRef = helpers.formatRef;
app.locals.roleLabel = helpers.roleLabel;
app.locals.statusClass = helpers.statusClass;
app.locals.firstName = helpers.firstName;
app.locals.initials = helpers.initials;
app.locals.icon = icon;
app.locals.DEPT_ROLES = DEPT_ROLES;

if (
    !process.env.SESSION_SECRET ||
    process.env.SESSION_SECRET === 'replace_this_with_a_long_random_secret'
) {
    console.warn(
        'Warning: set a long random SESSION_SECRET in your .env file before using this site for real.'
    );
}

// Basic browser security headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
});

app.use(session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 2
    }
}));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Values every page needs: who is logged in, one-time messages, form token
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.csrfToken = req.session.csrfToken || '';
    res.locals.currentUrl = req.originalUrl;
    res.locals.flash = req.session.flash || null;

    if (req.session.flash) {
        delete req.session.flash;
    }

    next();
});

app.use(verifyCsrf);

app.use('/feedback', feedbackRoutes);
app.use('/auth', authRoutes);
app.use('/staff', staffRoutes);

app.get('/', async (req, res) => {
    let stats = null;
    let categories = [];

    try {
        const [totals] = await db.query(
            `SELECT
                COUNT(f.id) AS total,
                SUM(CASE WHEN s.status_name = 'Resolved' THEN 1 ELSE 0 END) AS resolved
             FROM feedback f
             JOIN statuses s ON f.status_id = s.id`
        );
        const [cats] = await db.query(
            'SELECT category_name FROM categories ORDER BY id ASC'
        );

        stats = {
            total: Number(totals[0].total) || 0,
            resolved: Number(totals[0].resolved) || 0
        };
        categories = cats;
    } catch (err) {
        // The home page should still open if the database is unavailable.
        console.error('Could not load home page statistics:', err.message);
    }

    res.render('index', { stats, categories });
});

app.use((req, res) => {
    res.status(404).render('error', {
        code: 404,
        title: 'Page not found',
        message: 'The page you are looking for does not exist or has moved.'
    });
});

// Any error thrown in a route ends up here
app.use((err, req, res, next) => {
    console.error(err);

    if (res.headersSent) {
        return next(err);
    }

    res.status(500).render('error', {
        code: 500,
        title: 'Something went wrong',
        message: 'We could not complete your request. Please try again in a moment.'
    });
});

const PORT = process.env.PORT || 3000;

if (require.main === module) {
    db.checkConnection();

    app.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}`);
    });
}

module.exports = app;
