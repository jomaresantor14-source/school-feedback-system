const express = require('express');
const crypto = require('crypto');

const router = express.Router();
const db = require('../config/db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { DEPT_ROLES } = require('../lib/constants');
const { normalizeRef, parseId, safeReturn } = require('../lib/helpers');
const { parseFilters, listFeedback, lookups } = require('../lib/feedbackQueries');

const SUBJECT_MAX = 200;
const DESCRIPTION_MAX = 5000;
const REMARKS_MAX = 1000;

const MANAGE_ROLES = ['admin', 'institutional_management', ...DEPT_ROLES];

function notFound(res, message = 'That feedback record could not be found.') {
    return res.status(404).render('error', {
        code: 404,
        title: 'Not found',
        message
    });
}

function flash(req, type, message) {
    req.session.flash = { type, message };
}

// ---------------------------------------------------------------
// Public: submit feedback
// ---------------------------------------------------------------

async function renderSubmitForm(res, { error = null, values = {} } = {}, status = 200) {
    const [categories] = await db.query(
        'SELECT id, category_name FROM categories ORDER BY id ASC'
    );

    // CHANGED: this form is for students and guests, so nothing is prefilled,
    // even when a staff member is logged in.
    const prefill = {
        submitter_name: '',
        submitter_email: '',
        ...values
    };

    res.status(status).render('submit-feedback', {
        categories,
        error,
        values: prefill,
        limits: { subject: SUBJECT_MAX, description: DESCRIPTION_MAX }
    });
}

router.get('/submit', async (req, res) => {
    await renderSubmitForm(res);
});

router.post('/submit', async (req, res) => {
    const body = req.body || {};
    const isAnonymous = body.is_anonymous === '1';

    const values = {
        is_anonymous: isAnonymous,
        submitter_name: String(body.submitter_name || '').trim(),
        submitter_email: String(body.submitter_email || '').trim(),
        category_id: String(body.category_id || ''),
        subject: String(body.subject || '').trim(),
        description: String(body.description || '').trim()
    };

    const showError = (message) =>
        renderSubmitForm(res, { error: message, values }, 400);

    if (!values.category_id || !values.subject || !values.description) {
        return showError('Choose a category and complete the subject and details.');
    }

    if (values.subject.length > SUBJECT_MAX) {
        return showError(`Subject must be ${SUBJECT_MAX} characters or fewer.`);
    }

    if (values.description.length > DESCRIPTION_MAX) {
        return showError(`Details must be ${DESCRIPTION_MAX} characters or fewer.`);
    }

    if (values.submitter_name.length > 150) {
        return showError('Name must be 150 characters or fewer.');
    }

    if (
        !isAnonymous &&
        values.submitter_email &&
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.submitter_email)
    ) {
        return showError('Enter a valid email address, or leave it blank.');
    }

    const categoryId = parseId(values.category_id);
    const [categoryRows] = categoryId
        ? await db.query('SELECT id FROM categories WHERE id = ?', [categoryId])
        : [[]];

    if (categoryRows.length === 0) {
        return showError('Choose a category from the list.');
    }

    const [statusRows] = await db.query(
        'SELECT id FROM statuses WHERE status_name = ?',
        ['Pending']
    );

    if (statusRows.length === 0) {
        throw new Error('The "Pending" status is missing from the statuses table.');
    }

    // Anonymous submissions keep no personal details and are not linked to an account.
    const name = isAnonymous ? null : (values.submitter_name || null);
    const email = isAnonymous ? null : (values.submitter_email || null);
    const submittedBy =
        !isAnonymous && req.session.user ? req.session.user.id : null;

    let referenceCode = null;

    // Try again in the very unlikely case two codes collide.
    for (let attempt = 0; attempt < 5 && !referenceCode; attempt += 1) {
        const candidate = crypto.randomBytes(8).toString('hex').toUpperCase();

        try {
            await db.query(
                `INSERT INTO feedback
                    (reference_code, submitter_name, submitter_email, is_anonymous,
                     category_id, subject, description, status_id, submitted_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    candidate,
                    name,
                    email,
                    isAnonymous ? 1 : 0,
                    categoryId,
                    values.subject,
                    values.description,
                    statusRows[0].id,
                    submittedBy
                ]
            );
            referenceCode = candidate;
        } catch (err) {
            if (err.code !== 'ER_DUP_ENTRY') throw err;
        }
    }

    if (!referenceCode) {
        throw new Error('Could not generate a unique reference code.');
    }

    // Redirecting means a page refresh cannot send the same feedback twice.
    req.session.lastReference = referenceCode;
    req.session.save((err) => {
        if (err) {
            console.error(err);
            return res.status(500).render('error', {
                code: 500,
                title: 'Feedback saved',
                message: `Your feedback was saved. Keep this reference code: ${referenceCode}`
            });
        }

        res.redirect('/feedback/submitted');
    });
});

router.get('/submitted', (req, res) => {
    const referenceCode = req.session.lastReference;

    if (!referenceCode) {
        return res.redirect('/feedback/submit');
    }

    res.render('feedback-success', { reference_code: referenceCode });
});

// ---------------------------------------------------------------
// Public: track a submission
// ---------------------------------------------------------------

router.get('/track', async (req, res) => {
    const raw = String(req.query.code || '').trim();

    if (!raw) {
        return res.render('track-feedback', {
            code: '',
            searched: false,
            feedback: null,
            history: [],
            steps: []
        });
    }

    const code = normalizeRef(raw);

    const [results] = await db.query(
        `SELECT
            f.reference_code,
            f.subject,
            f.description,
            f.created_at,
            f.status_id,
            c.category_name,
            s.status_name,
            d.department_name
         FROM feedback f
         JOIN categories c ON f.category_id = c.id
         JOIN statuses s ON f.status_id = s.id
         LEFT JOIN departments d ON f.assigned_department_id = d.id
         WHERE f.reference_code = ?
         LIMIT 1`,
        [code]
    );

    if (results.length === 0) {
        return res.render('track-feedback', {
            code: raw,
            searched: true,
            feedback: null,
            history: [],
            steps: []
        });
    }

    const feedback = results[0];

    const [[history], [steps]] = await Promise.all([
        db.query(
            `SELECT
                fh.id,
                fh.old_status_id,
                fh.new_status_id,
                fh.remarks,
                fh.changed_at,
                ns.status_name AS new_status
             FROM feedback_history fh
             JOIN statuses ns ON fh.new_status_id = ns.id
             JOIN feedback f ON fh.feedback_id = f.id
             WHERE f.reference_code = ?
             ORDER BY fh.changed_at ASC, fh.id ASC`,
            [code]
        ),
        db.query('SELECT id, status_name FROM statuses ORDER BY id ASC')
    ]);

    res.render('track-feedback', {
        code: raw,
        searched: true,
        feedback,
        history,
        steps
    });
});

// Older bookmarks and forms may still post here.
router.post('/track', (req, res) => {
    const code = String((req.body && req.body.reference_code) || '').trim();
    res.redirect(`/feedback/track?code=${encodeURIComponent(code)}`);
});

// ---------------------------------------------------------------
// Lists for staff
// ---------------------------------------------------------------

async function renderList(req, res, config) {
    const filters = parseFilters(req.query);
    const options = { ...filters };

    if (config.mode === 'department') {
        const departmentId = req.session.user.department_id;

        if (!departmentId) {
            return res.status(403).render('error', {
                code: 403,
                title: 'No department assigned',
                message: 'Your account has no department yet. Ask an administrator to assign one.'
            });
        }

        options.departmentId = departmentId;
        options.department = null;
    }

    if (config.mode === 'mine') {
        options.submittedBy = req.session.user.id;
        options.department = null;
    }

    const [result, lists] = await Promise.all([
        listFeedback(options),
        lookups()
    ]);

    const pageUrl = (page) => {
        const params = new URLSearchParams();
        if (filters.q) params.set('q', filters.q);
        if (filters.statusId) params.set('status', filters.statusId);
        if (filters.categoryId) params.set('category', filters.categoryId);
        if (filters.department && config.mode !== 'department') {
            params.set('department', filters.department);
        }
        if (page > 1) params.set('page', page);
        const query = params.toString();
        return query ? `${config.basePath}?${query}` : config.basePath;
    };

    const filtersActive = Boolean(
        filters.q ||
        filters.statusId ||
        filters.categoryId ||
        (filters.department && config.mode !== 'department')
    );

    res.render(config.view || 'feedback-list', {
        ...config,
        ...result,
        ...lists,
        filters,
        filtersActive,
        pageUrl
    });
}

router.get('/admin', requireRole('admin'), (req, res) =>
    renderList(req, res, {
        mode: 'admin',
        basePath: '/feedback/admin',
        pageTitle: 'All feedback',
        intro: 'Every submission in the system. Assign each one to the department that should handle it.',
        canAssign: true,
        showDepartmentFilter: true
    })
);

router.get('/management', requireRole('institutional_management', 'admin'), (req, res) =>
    renderList(req, res, {
        mode: 'management',
        basePath: '/feedback/management',
        pageTitle: 'School overview',
        intro: 'A read-only view of every submission and where it stands.',
        canAssign: false,
        showDepartmentFilter: true
    })
);

router.get('/department-inbox', requireRole(...DEPT_ROLES), (req, res) =>
    renderList(req, res, {
        mode: 'department',
        basePath: '/feedback/department-inbox',
        pageTitle: 'Department inbox',
        intro: 'Feedback assigned to your department. Open one to update its status or leave a note.',
        canAssign: false,
        showDepartmentFilter: false
    })
);

router.get('/my-submissions', requireLogin, (req, res) =>
    renderList(req, res, {
        mode: 'mine',
        view: 'my-submissions',
        basePath: '/feedback/my-submissions',
        pageTitle: 'My submissions',
        intro: 'Feedback you sent while logged in. Anonymous submissions are not listed here, so keep their reference codes.',
        canAssign: false,
        showDepartmentFilter: false
    })
);

// ---------------------------------------------------------------
// Feedback details
// ---------------------------------------------------------------

function isDeptStaff(user) {
    return DEPT_ROLES.includes(user.role);
}

function ownsFeedback(user, feedback) {
    return (
        user.role === 'admin' ||
        user.role === 'institutional_management' ||
        (isDeptStaff(user) &&
            feedback.assigned_department_id !== null &&
            Number(feedback.assigned_department_id) === Number(user.department_id))
    );
}

function backLinkFor(user) {
    if (user.role === 'admin') return { href: '/feedback/admin', text: 'All feedback' };
    if (user.role === 'institutional_management') return { href: '/feedback/management', text: 'School overview' };
    return { href: '/feedback/department-inbox', text: 'Department inbox' };
}

router.get('/view/:id', requireRole(...MANAGE_ROLES), async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return notFound(res);

    const user = req.session.user;

    const [rows] = await db.query(
        `SELECT
            f.id,
            f.reference_code,
            f.subject,
            f.description,
            f.created_at,
            f.is_anonymous,
            f.submitter_name,
            f.submitter_email,
            f.status_id,
            f.assigned_department_id,
            c.category_name,
            s.status_name,
            d.department_name,
            u.full_name AS account_name,
            u.email AS account_email
         FROM feedback f
         JOIN categories c ON f.category_id = c.id
         JOIN statuses s ON f.status_id = s.id
         LEFT JOIN departments d ON f.assigned_department_id = d.id
         LEFT JOIN users u ON f.submitted_by = u.id
         WHERE f.id = ?
         LIMIT 1`,
        [id]
    );

    if (rows.length === 0 || !ownsFeedback(user, rows[0])) {
        return notFound(
            res,
            'That feedback record does not exist or is not assigned to your department.'
        );
    }

    const feedback = rows[0];

    const [[statusHistory], [assignments], lists] = await Promise.all([
        db.query(
            `SELECT
                fh.id,
                fh.old_status_id,
                fh.new_status_id,
                fh.remarks,
                fh.changed_at,
                os.status_name AS old_status,
                ns.status_name AS new_status,
                u.full_name AS changed_by
             FROM feedback_history fh
             LEFT JOIN statuses os ON fh.old_status_id = os.id
             JOIN statuses ns ON fh.new_status_id = ns.id
             LEFT JOIN users u ON fh.changed_by = u.id
             WHERE fh.feedback_id = ?`,
            [id]
        ),
        db.query(
            `SELECT
                ah.id,
                ah.changed_at,
                od.department_name AS old_department,
                nd.department_name AS new_department,
                u.full_name AS changed_by
             FROM feedback_assignment_history ah
             LEFT JOIN departments od ON ah.old_department_id = od.id
             JOIN departments nd ON ah.new_department_id = nd.id
             LEFT JOIN users u ON ah.changed_by = u.id
             WHERE ah.feedback_id = ?`,
            [id]
        ),
        lookups()
    ]);

    // One timeline: submission, department assignments, status changes and notes
    const events = [
        {
            kind: 'submitted',
            at: feedback.created_at,
            order: 0,
            title: 'Feedback submitted',
            by: null,
            remarks: null,
            status: 'Pending'
        }
    ];

    statusHistory.forEach(item => {
        const isNote = item.old_status_id === item.new_status_id;

        events.push({
            kind: isNote ? 'note' : 'status',
            at: item.changed_at,
            order: item.id,
            title: isNote
                ? `Note added (${item.new_status})`
                : `${item.old_status || 'New'} → ${item.new_status}`,
            by: item.changed_by || 'Staff member',
            remarks: item.remarks,
            status: item.new_status
        });
    });

    assignments.forEach(item => {
        events.push({
            kind: 'assignment',
            at: item.changed_at,
            order: item.id,
            title: item.old_department
                ? `Reassigned from ${item.old_department} to ${item.new_department}`
                : `Assigned to ${item.new_department}`,
            by: item.changed_by || 'Administrator',
            remarks: null,
            status: null
        });
    });

    events.sort((a, b) =>
        (new Date(b.at).getTime() - new Date(a.at).getTime()) || (b.order - a.order)
    );

    let submitter = 'Anonymous';
    let submitterEmail = null;

    if (!feedback.is_anonymous) {
        submitter =
            feedback.submitter_name ||
            feedback.account_name ||
            feedback.submitter_email ||
            'Name not provided';
        submitterEmail = feedback.submitter_email || feedback.account_email || null;
    }

    res.render('feedback-detail', {
        feedback,
        submitter,
        submitterEmail,
        events,
        statuses: lists.statuses,
        departments: lists.departments,
        canUpdate: user.role === 'admin' || isDeptStaff(user),
        canAssign: user.role === 'admin',
        back: backLinkFor(user)
    });
});

// Change the status and/or leave a note
router.post('/view/:id/status', requireRole('admin', ...DEPT_ROLES), async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return notFound(res);

    const user = req.session.user;
    const body = req.body || {};
    const newStatusId = parseId(body.status_id);
    const remarks = String(body.remarks || '').trim().slice(0, REMARKS_MAX) || null;
    const detailUrl = `/feedback/view/${id}`;

    if (!newStatusId) {
        flash(req, 'error', 'Choose a status.');
        return res.redirect(detailUrl);
    }

    const outcome = await db.withTransaction(async (conn) => {
        const [rows] = await conn.query(
            `SELECT f.id, f.status_id, f.assigned_department_id, s.status_name
             FROM feedback f
             JOIN statuses s ON s.id = f.status_id
             WHERE f.id = ?
             LIMIT 1`,
            [id]
        );

        if (rows.length === 0 || !ownsFeedback(user, rows[0])) {
            return { type: 'missing' };
        }

        const feedback = rows[0];
        const oldStatusId = feedback.status_id;
        const oldStatus = feedback.status_name;

        const [statusRows] = await conn.query(
            'SELECT id, status_name FROM statuses WHERE id = ? LIMIT 1',
            [newStatusId]
        );

        if (statusRows.length === 0) {
            return { type: 'invalid' };
        }

        const newStatus = statusRows[0].status_name;
        const isAdmin = user.role === 'admin';
        const isDepartmentStaff = DEPT_ROLES.includes(user.role);

        if (
            isDepartmentStaff &&
            (
                !feedback.assigned_department_id ||
                Number(feedback.assigned_department_id) !== Number(user.department_id)
            )
        ) {
            return { type: 'forbidden' };
        }

        if (isDepartmentStaff && newStatus === 'Resolved') {
            return { type: 'forbidden_resolved' };
        }

        if (isAdmin && newStatus === 'Resolved' && oldStatus !== 'Awaiting Admin Review') {
            return { type: 'must_review_first' };
        }

        if (
            isDepartmentStaff &&
            !['Under Review', 'In Progress', 'Awaiting Admin Review'].includes(newStatus)
        ) {
            return { type: 'invalid_transition' };
        }

        if (oldStatusId === newStatusId && !remarks) {
            return { type: 'unchanged' };
        }

        if (oldStatusId !== newStatusId) {
            await conn.query(
                'UPDATE feedback SET status_id = ? WHERE id = ?',
                [newStatusId, id]
            );
        }

        await conn.query(
            `INSERT INTO feedback_history
                (feedback_id, changed_by, old_status_id, new_status_id, remarks)
             VALUES (?, ?, ?, ?, ?)`,
            [id, user.id, oldStatusId, newStatusId, remarks]
        );

        return {
            type: oldStatusId === newStatusId ? 'note' : 'changed',
            statusName: newStatus
        };
    });

    switch (outcome.type) {
        case 'missing':
            return notFound(res);
        case 'forbidden':
        case 'forbidden_resolved':
            flash(req, 'error', 'You are not allowed to make that status change.');
            break;
        case 'must_review_first':
            flash(req, 'error', 'The department must submit this case for final review before it can be resolved.');
            break;
        case 'invalid_transition':
            flash(req, 'error', 'Choose a status allowed for your department role.');
            break;
        case 'invalid':
            flash(req, 'error', 'That status does not exist.');
            break;
        case 'unchanged':
            flash(req, 'info', 'Nothing to save. Change the status or add a note.');
            break;
        case 'note':
            flash(req, 'success', 'Note added.');
            break;
        default:
            flash(req, 'success', `Status updated to ${outcome.statusName}.`);
    }

    res.redirect(detailUrl);
});

// Assign (or reassign) a department. Admin only.
router.post('/view/:id/assign', requireRole('admin'), async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return notFound(res);

    const user = req.session.user;
    const departmentId = parseId((req.body || {}).department_id);
    const fallback = `/feedback/view/${id}`;
    const returnTo = safeReturn((req.body || {}).return_to, fallback);

    if (!departmentId) {
        flash(req, 'error', 'Choose a department.');
        return res.redirect(returnTo);
    }

    const outcome = await db.withTransaction(async (conn) => {
        const [rows] = await conn.query(
            'SELECT assigned_department_id FROM feedback WHERE id = ?',
            [id]
        );

        if (rows.length === 0) {
            return { type: 'missing' };
        }

        const [departmentRows] = await conn.query(
            'SELECT id, department_name FROM departments WHERE id = ?',
            [departmentId]
        );

        if (departmentRows.length === 0) {
            return { type: 'invalid' };
        }

        const oldDepartmentId = rows[0].assigned_department_id;

        if (oldDepartmentId !== null && Number(oldDepartmentId) === departmentId) {
            return { type: 'unchanged', name: departmentRows[0].department_name };
        }

        const [pendingRows] = await conn.query(
            `SELECT id FROM statuses
             WHERE status_name = 'Pending'
             LIMIT 1`
        );

        const [assignedRows] = await conn.query(
            `SELECT id FROM statuses
             WHERE status_name = 'Assigned'
             LIMIT 1`
        );

        if (assignedRows.length === 0) {
            throw new Error('Assigned status is missing from the statuses table.');
        }

        await conn.query(
            `UPDATE feedback
             SET assigned_department_id = ?,
                 status_id = CASE
                     WHEN status_id = ? THEN ?
                     ELSE status_id
                 END
             WHERE id = ?`,
            [
                departmentId,
                pendingRows.length ? pendingRows[0].id : -1,
                assignedRows[0].id,
                id
            ]
        );

        await conn.query(
            `INSERT INTO feedback_assignment_history
                (feedback_id, changed_by, old_department_id, new_department_id)
             VALUES (?, ?, ?, ?)`,
            [id, user.id, oldDepartmentId, departmentId]
        );

        return { type: 'assigned', name: departmentRows[0].department_name };
    });

    if (outcome.type === 'missing') return notFound(res);

    if (outcome.type === 'invalid') {
        flash(req, 'error', 'That department does not exist.');
    } else if (outcome.type === 'unchanged') {
        flash(req, 'info', `Already assigned to ${outcome.name}.`);
    } else {
        flash(req, 'success', `Assigned to ${outcome.name}.`);
    }

    res.redirect(returnTo);
});

// ---------------------------------------------------------------
// Old addresses from earlier versions still work
// ---------------------------------------------------------------

router.get('/admin/:id/edit', requireRole('admin'), (req, res) =>
    res.redirect(`/feedback/view/${parseId(req.params.id) || ''}`)
);

router.get('/department-inbox/:id/history', requireRole(...MANAGE_ROLES), (req, res) =>
    res.redirect(`/feedback/view/${parseId(req.params.id) || ''}`)
);

module.exports = router;