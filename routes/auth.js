const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const router = express.Router();
const db = require('../config/db');
const { requireAdmin, loginLockedFor, recordFailedLogin, clearFailedLogins } = require('../middleware/auth');
const { DEPT_ROLES, ASSIGNABLE_ROLES } = require('../lib/constants');
const { roleLabel } = require('../lib/helpers');

// Display the login page
router.get('/login', (req, res) => {
    if (req.session.user) {
        return res.redirect('/staff/dashboard');
    }

    res.render('login', { error: null, email: '' });
});

// Process the login form
router.post('/login', async (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');

    const fail = (status, error) =>
        res.status(status).render('login', { error, email });

    if (!email || !password) {
        return fail(400, 'Enter your email and password.');
    }

    const waitMinutes = loginLockedFor(req, email);
    if (waitMinutes > 0) {
        return fail(
            429,
            `Too many failed attempts. Try again in ${waitMinutes} minute${waitMinutes === 1 ? '' : 's'}.`
        );
    }

    const [results] = await db.query(
        `SELECT id, full_name, email, password_hash, role, department_id
         FROM users
         WHERE email = ?
         LIMIT 1`,
        [email]
    );

    const account = results[0];
    const passwordMatches = account
        ? await bcrypt.compare(password, account.password_hash)
        : false;

    if (!passwordMatches) {
        recordFailedLogin(req, email);
        return fail(401, 'Invalid email or password.');
    }

    clearFailedLogins(req, email);

    // A fresh session after login prevents session fixation.
    req.session.regenerate((regenErr) => {
        if (regenErr) {
            console.error(regenErr);
            return fail(500, 'Could not start your session. Please try again.');
        }

        req.session.user = {
            id: account.id,
            full_name: account.full_name,
            email: account.email,
            role: account.role,
            department_id: account.department_id
        };
        req.session.csrfToken = crypto.randomBytes(24).toString('hex');

        req.session.save((saveErr) => {
            if (saveErr) {
                console.error(saveErr);
                return fail(500, 'Could not start your session. Please try again.');
            }

            res.redirect('/staff/dashboard');
        });
    });
});

// Log out (support both direct browser access and forms)
router.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error(err);
        }

        res.clearCookie('connect.sid');
        res.redirect('/auth/login');
    });
});

router.post('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error(err);
        }

        res.clearCookie('connect.sid');
        res.redirect('/auth/login');
    });
});

// ---- Staff account management (admin only) ----

async function renderStaffPage(res, { error = null, success = null, values = {} } = {}, status = 200) {
    const [[departments], [staff]] = await Promise.all([
        db.query('SELECT id, department_name FROM departments ORDER BY department_name ASC'),
        db.query(
            `SELECT u.id, u.full_name, u.email, u.role, u.created_at, d.department_name
             FROM users u
             LEFT JOIN departments d ON u.department_id = d.id
             ORDER BY u.created_at DESC, u.id DESC`
        )
    ]);

    res.status(status).render('create-staff', {
        departments,
        staff,
        roles: ASSIGNABLE_ROLES.map(value => ({ value, label: roleLabel(value) })),
        error,
        success,
        values
    });
}

router.get('/create-staff', requireAdmin, async (req, res) => {
    await renderStaffPage(res);
});

router.post('/create-staff', requireAdmin, async (req, res) => {
    const body = req.body || {};
    const fullName = String(body.full_name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const role = String(body.role || '');
    const departmentInput = String(body.department_id || '');

    const values = { full_name: fullName, email, role, department_id: departmentInput };
    const showError = (error, status = 400) =>
        renderStaffPage(res, { error, values }, status);

    if (!fullName || !email || !password || !role) {
        return showError('Complete all required fields.');
    }

    if (fullName.length > 150 || email.length > 150) {
        return showError('Name or email is too long.');
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return showError('Enter a valid email address.');
    }

    if (password.length < 12) {
        return showError('Password must contain at least 12 characters.');
    }

    if (!ASSIGNABLE_ROLES.includes(role)) {
        return showError('Select a valid staff role.');
    }

    let departmentId = null;

    if (departmentInput) {
        if (!/^\d+$/.test(departmentInput) || Number(departmentInput) < 1) {
            return showError('Select a valid department.');
        }
        departmentId = Number(departmentInput);
    }

    if (DEPT_ROLES.includes(role) && !departmentId) {
        return showError('This role needs a department so the person can see their inbox.');
    }

    const passwordHash = await bcrypt.hash(password, 12);

    try {
        await db.query(
            `INSERT INTO users (full_name, email, password_hash, role, department_id)
             VALUES (?, ?, ?, ?, ?)`,
            [fullName, email, passwordHash, role, departmentId]
        );
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return showError('That email address is already registered.', 409);
        }

        if (err.code === 'ER_NO_REFERENCED_ROW_2') {
            return showError('The selected department does not exist.');
        }

        throw err;
    }

    await renderStaffPage(res, {
        success: `Account created for ${fullName}.`
    });
});

module.exports = router;
