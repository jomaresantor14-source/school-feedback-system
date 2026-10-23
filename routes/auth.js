const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const router = express.Router();
const db = require('../config/db');
const { requireAdmin, loginLockedFor, recordFailedLogin, clearFailedLogins } = require('../middleware/auth');
const { DEPT_ROLES, ASSIGNABLE_ROLES } = require('../lib/constants');
const { roleLabel } = require('../lib/helpers');

const PRIMARY_ADMIN_ID = 1;

function isProtectedAdmin(account) {
    return Number(account.id) === PRIMARY_ADMIN_ID;
}

function readStaffForm(body, { requirePassword = false } = {}) {
    const fullName = String(body.full_name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const role = String(body.role || '');
    const departmentInput = String(body.department_id || '');
    const values = { full_name: fullName, email, role, department_id: departmentInput };

    if (!fullName || !email || (requirePassword && !password) || !role) {
        return { error: 'Complete all required fields.', values };
    }

    if (fullName.length > 150 || email.length > 150) {
        return { error: 'Name or email is too long.', values };
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return { error: 'Enter a valid email address.', values };
    }

    if (requirePassword && password.length < 12) {
        return { error: 'Password must contain at least 12 characters.', values };
    }

    if (!ASSIGNABLE_ROLES.includes(role)) {
        return { error: 'Select a valid staff role.', values };
    }

    let departmentId = null;

    if (departmentInput) {
        if (!/^\d+$/.test(departmentInput) || Number(departmentInput) < 1) {
            return { error: 'Select a valid department.', values };
        }
        departmentId = Number(departmentInput);
    }

    if (DEPT_ROLES.includes(role) && !departmentId) {
        return {
            error: 'This role needs a department so the person can see their inbox.',
            values
        };
    }

    return { values, fullName, email, password, role, departmentId };
}

function accountActionError(code, message) {
    return Object.assign(new Error(message), { code });
}

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

async function renderStaffPage(
    res,
    { error = null, success = null, values = {}, editAccount = null } = {},
    status = 200
) {
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
        values: Object.keys(values).length ? values : (editAccount || {}),
        editAccount,
        primaryAdminId: PRIMARY_ADMIN_ID
    });
}

router.get('/create-staff', requireAdmin, async (req, res) => {
    const editId = String(req.query.edit || '');
    if (!editId) {
        return renderStaffPage(res);
    }

    if (!/^\d+$/.test(editId) || Number(editId) < 1) {
        return res.status(404).render('error', {
            code: 404,
            title: 'Not found',
            message: 'That account could not be found.'
        });
    }

    const [accounts] = await db.query(
        'SELECT id, full_name, email, role, department_id FROM users WHERE id = ? LIMIT 1',
        [Number(editId)]
    );

    if (!accounts.length) {
        return res.status(404).render('error', {
            code: 404,
            title: 'Not found',
            message: 'That account could not be found.'
        });
    }

    await renderStaffPage(res, { editAccount: accounts[0] });
});

router.post('/create-staff', requireAdmin, async (req, res) => {
    const body = req.body || {};
    const action = String(body.account_action || 'create');

    if (action === 'delete') {
        const accountIdInput = String(body.account_id || '');
        if (!/^\d+$/.test(accountIdInput) || Number(accountIdInput) < 1) {
            return renderStaffPage(res, { error: 'Select a valid account to delete.' }, 400);
        }

        const accountId = Number(accountIdInput);
        if (accountId === Number(req.session.user.id)) {
            return renderStaffPage(res, {
                error: 'You cannot delete the account you are currently signed in with.'
            }, 403);
        }

        try {
            await db.withTransaction(async connection => {
                const [accounts] = await connection.query(
                    'SELECT id, role FROM users WHERE id = ? FOR UPDATE',
                    [accountId]
                );

                if (!accounts.length) {
                    throw accountActionError('ACCOUNT_NOT_FOUND', 'That account no longer exists.');
                }

                if (isProtectedAdmin(accounts[0])) {
                    throw accountActionError(
                        'ACCOUNT_PROTECTED',
                        'The primary System Administrator account is protected from deletion.'
                    );
                }

                const [references] = await connection.query(
                    `SELECT
                        (SELECT COUNT(*) FROM feedback WHERE submitted_by = ?) AS submissions,
                        (SELECT COUNT(*) FROM feedback_history WHERE changed_by = ?) AS feedback_changes,
                        (SELECT COUNT(*) FROM feedback_assignment_history WHERE changed_by = ?) AS assignment_changes`,
                    [accountId, accountId, accountId]
                );

                const referenceCounts = references[0];
                if (
                    Number(referenceCounts.submissions) ||
                    Number(referenceCounts.feedback_changes) ||
                    Number(referenceCounts.assignment_changes)
                ) {
                    throw accountActionError(
                        'ACCOUNT_HAS_HISTORY',
                        'This account is linked to feedback or feedback history. It was not deleted so that records and attribution remain intact.'
                    );
                }

                await connection.query('DELETE FROM users WHERE id = ?', [accountId]);
            });
        } catch (err) {
            const status = {
                ACCOUNT_NOT_FOUND: 404,
                ACCOUNT_PROTECTED: 403,
                ACCOUNT_HAS_HISTORY: 409
            }[err.code];
            if (!status) throw err;
            return renderStaffPage(res, { error: err.message }, status);
        }

        return renderStaffPage(res, { success: 'Account deleted.' });
    }

    if (action === 'edit') {
        const accountIdInput = String(body.account_id || '');
        if (!/^\d+$/.test(accountIdInput) || Number(accountIdInput) < 1) {
            return renderStaffPage(res, { error: 'Select a valid account to edit.' }, 400);
        }

        const accountId = Number(accountIdInput);
        const [accounts] = await db.query(
            'SELECT id, full_name, email, role, department_id FROM users WHERE id = ? LIMIT 1',
            [accountId]
        );

        if (!accounts.length) {
            return renderStaffPage(res, { error: 'That account no longer exists.' }, 404);
        }

        const editAccount = accounts[0];
        if (isProtectedAdmin(editAccount)) {
            return renderStaffPage(res, {
                error: 'The primary System Administrator account is protected from modification.'
            }, 403);
        }

        const form = readStaffForm(body);
        const showError = (error, status = 400) =>
            renderStaffPage(res, { error, values: form.values, editAccount }, status);

        if (form.error) {
            return showError(form.error);
        }

        try {
            const [result] = await db.query(
                `UPDATE users
                 SET full_name = ?, email = ?, role = ?, department_id = ?
                 WHERE id = ? AND id <> ?`,
                [
                    form.fullName,
                    form.email,
                    form.role,
                    form.departmentId,
                    accountId,
                    PRIMARY_ADMIN_ID
                ]
            );

            if (!result.affectedRows) {
                const [currentAccounts] = await db.query(
                    'SELECT id, role FROM users WHERE id = ? LIMIT 1',
                    [accountId]
                );

                if (!currentAccounts.length) {
                    return showError('That account no longer exists.', 404);
                }

                if (isProtectedAdmin(currentAccounts[0])) {
                    return showError(
                        'The primary System Administrator account is protected from modification.',
                        403
                    );
                }
            }
        } catch (err) {
            if (err.code === 'ER_DUP_ENTRY') {
                return showError('That email address is already registered.', 409);
            }

            if (err.code === 'ER_NO_REFERENCED_ROW_2') {
                return showError('The selected department does not exist.');
            }

            throw err;
        }

        return renderStaffPage(res, { success: `Account updated for ${form.fullName}.` });
    }

    if (action !== 'create') {
        return renderStaffPage(res, { error: 'Choose a valid account action.' }, 400);
    }

    const form = readStaffForm(body, { requirePassword: true });
    const showError = (error, status = 400) =>
        renderStaffPage(res, { error, values: form.values }, status);

    if (form.error) {
        return showError(form.error);
    }

    const passwordHash = await bcrypt.hash(form.password, 12);

    try {
        await db.query(
            `INSERT INTO users (full_name, email, password_hash, role, department_id)
             VALUES (?, ?, ?, ?, ?)`,
            [form.fullName, form.email, passwordHash, form.role, form.departmentId]
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
        success: `Account created for ${form.fullName}.`
    });
});

module.exports = router;
