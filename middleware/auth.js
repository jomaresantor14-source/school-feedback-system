const crypto = require('crypto');

function renderDenied(res, status, title, message) {
    return res.status(status).render('error', {
        code: status,
        title,
        message
    });
}

function requireLogin(req, res, next) {
    if (!req.session.user) {
        return res.redirect('/auth/login');
    }

    next();
}

// Allows only the listed roles. Example: requireRole('admin', 'it_staff')
function requireRole(...roles) {
    return (req, res, next) => {
        const user = req.session.user;

        if (!user) {
            return res.redirect('/auth/login');
        }

        if (!roles.includes(user.role)) {
            return renderDenied(
                res,
                403,
                'Access denied',
                'Your account does not have permission to open this page.'
            );
        }

        next();
    };
}

const requireAdmin = requireRole('admin');

// Protects every form that logged-in staff submit.
// The token is created at login and must come back with each POST.
function verifyCsrf(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        return next();
    }

    // Visitors who are not logged in have nothing to protect.
    if (!req.session || !req.session.user) {
        return next();
    }

    const sent = String((req.body && req.body._csrf) || '');
    const expected = String(req.session.csrfToken || '');

    const valid =
        sent.length > 0 &&
        sent.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected));

    if (!valid) {
        return renderDenied(
            res,
            403,
            'Session check failed',
            'Your form could not be verified. Go back, refresh the page, and try again.'
        );
    }

    next();
}

// Slows down password guessing: 5 wrong attempts locks that email + device for 15 minutes.
const attempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;

function attemptKey(req, email) {
    return `${req.ip}|${String(email || '').toLowerCase()}`;
}

function loginLockedFor(req, email) {
    const entry = attempts.get(attemptKey(req, email));

    if (!entry) return 0;

    if (Date.now() - entry.first > LOCK_MS) {
        attempts.delete(attemptKey(req, email));
        return 0;
    }

    if (entry.count >= MAX_ATTEMPTS) {
        return Math.ceil((LOCK_MS - (Date.now() - entry.first)) / 60000);
    }

    return 0;
}

function recordFailedLogin(req, email) {
    const key = attemptKey(req, email);
    const entry = attempts.get(key);

    if (!entry || Date.now() - entry.first > LOCK_MS) {
        attempts.set(key, { count: 1, first: Date.now() });
    } else {
        entry.count += 1;
    }
}

function clearFailedLogins(req, email) {
    attempts.delete(attemptKey(req, email));
}

module.exports = {
    requireLogin,
    requireRole,
    requireAdmin,
    verifyCsrf,
    loginLockedFor,
    recordFailedLogin,
    clearFailedLogins
};
