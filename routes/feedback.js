const express = require('express');
const crypto = require('crypto');

const router = express.Router();
const db = require('../config/db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { DEPT_ROLES, FEEDBACK_TYPES } = require('../lib/constants');
const { normalizeRef, parseId, safeReturn, roleLabel } = require('../lib/helpers');
const { parseFilters, listFeedback, lookups } = require('../lib/feedbackQueries');

const SUBJECT_MAX = 200;
const DESCRIPTION_MAX = 5000;
const REMARKS_MAX = 1000;

const MANAGE_ROLES = ['admin', 'institutional_management', ...DEPT_ROLES];
const TRACKING_STEPS = ['Received', 'Under review', 'In progress', 'Resolved'];

function trackingStepIndex(statusName) {
    switch (statusName) {
        case 'Pending':
        case 'Assigned':
            return 0;
        case 'Under Review':
            return 1;
        case 'In Progress':
        case 'Awaiting Admin Review':
        case 'Returned for Further Action':
            return 2;
        case 'Resolved':
            return 3;
        default:
            return 2;
    }
}

function formatElapsed(milliseconds) {
    const minutes = Math.max(0, Math.floor(milliseconds / 60000));
    if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;

    const days = Math.floor(hours / 24);
    return `${days} ${days === 1 ? 'day' : 'days'}`;
}

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
        feedback_type: 'Feedback',
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
        feedback_type: String(body.feedback_type || 'Feedback'),
        subject: String(body.subject || '').trim(),
        description: String(body.description || '').trim()
    };

    const showError = (message) =>
        renderSubmitForm(res, { error: message, values }, 400);

    if (
        !values.category_id ||
        !FEEDBACK_TYPES.includes(values.feedback_type) ||
        !values.subject ||
        !values.description
    ) {
        return showError('Choose a type and category, then complete the subject and details.');
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
            await db.withTransaction(async conn => {
                const [insert] = await conn.query(
                    `INSERT INTO feedback
                        (reference_code, submitter_name, submitter_email, is_anonymous,
                         category_id, feedback_type, subject, description, status_id,
                         assigned_department_id, submitted_by)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
                    [
                        candidate,
                        name,
                        email,
                        isAnonymous ? 1 : 0,
                        categoryId,
                        values.feedback_type,
                        values.subject,
                        values.description,
                        statusRows[0].id,
                        submittedBy
                    ]
                );
                await conn.query(
                    `INSERT INTO feedback_history
                        (feedback_id, changed_by, old_status_id, new_status_id, remarks)
                     VALUES (?, ?, NULL, ?, NULL)`,
                    [insert.insertId, submittedBy, statusRows[0].id]
                );
            });
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
            updates: [],
            steps: TRACKING_STEPS,
            currentStepIndex: 0,
            response: null,
            resolvedIn: null
        });
    }

    const code = normalizeRef(raw);

    const [results] = await db.query(
        `SELECT
            f.reference_code,
            f.subject,
            f.description,
            f.feedback_type,
            f.created_at,
            GREATEST(
                f.created_at,
                COALESCE((SELECT MAX(fh.changed_at) FROM feedback_history fh WHERE fh.feedback_id = f.id), f.created_at),
                COALESCE((SELECT MAX(ah.changed_at) FROM feedback_assignment_history ah WHERE ah.feedback_id = f.id), f.created_at)
            ) AS last_updated_at,
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
            updates: [],
            steps: TRACKING_STEPS,
            currentStepIndex: 0,
            response: null,
            resolvedIn: null
        });
    }

    const feedback = results[0];

    const [history] = await db.query(
        `SELECT
                CASE WHEN fh.visible_to_submitter = 1 THEN fh.remarks ELSE NULL END AS public_remarks,
                fh.changed_at,
                os.status_name AS old_status,
                changed_by.role AS actor_role,
                ns.status_name AS new_status
             FROM feedback_history fh
             LEFT JOIN statuses os ON os.id = fh.old_status_id
             JOIN statuses ns ON fh.new_status_id = ns.id
             JOIN feedback f ON fh.feedback_id = f.id
             LEFT JOIN users changed_by ON changed_by.id = fh.changed_by
             WHERE f.reference_code = ?
               AND (
                   fh.old_status_id IS NULL OR fh.old_status_id <> fh.new_status_id OR
                   (fh.visible_to_submitter = 1 AND fh.remarks IS NOT NULL AND TRIM(fh.remarks) != '')
               )
             ORDER BY fh.changed_at ASC, fh.id ASC`,
        [code]
    );

    const updates = [{
        changed_at: feedback.created_at,
        type: 'status',
        label: TRACKING_STEPS[0],
        status_name: 'Pending'
    }];
    const publicResponses = [];
    let previousStepIndex = trackingStepIndex(history[0] && history[0].old_status || 'Pending');

    history.forEach(item => {
        if (item.old_status && item.old_status !== item.new_status) {
            const nextStepIndex = trackingStepIndex(item.new_status);
            if (nextStepIndex !== previousStepIndex) {
                updates.push({
                    changed_at: item.changed_at,
                    type: 'status',
                    label: TRACKING_STEPS[nextStepIndex],
                    status_name: item.new_status
                });
            }
            previousStepIndex = nextStepIndex;
        }

        if (item.public_remarks && item.public_remarks.trim()) {
            updates.push({
                changed_at: item.changed_at,
                type: 'note',
                label: 'Public note',
                remarks: item.public_remarks,
                status_name: item.new_status
            });
            publicResponses.push({
                message: item.public_remarks,
                changed_at: item.changed_at,
                sender_role: item.actor_role ? roleLabel(item.actor_role).toLowerCase() : 'staff member'
            });
        }
    });

    const resolvedEvent = history.find(item => item.new_status === 'Resolved');
    const resolvedIn = feedback.status_name === 'Resolved' && resolvedEvent
        ? formatElapsed(new Date(resolvedEvent.changed_at) - new Date(feedback.created_at))
        : null;

    res.render('track-feedback', {
        code: raw,
        searched: true,
        feedback,
        updates,
        steps: TRACKING_STEPS,
        currentStepIndex: trackingStepIndex(feedback.status_name),
        response: publicResponses.length ? publicResponses[publicResponses.length - 1] : null,
        resolvedIn
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
    const options = { ...filters, ...(config.defaultOptions || {}) };
    options.scopeStatusName = config.defaultOptions && config.defaultOptions.statusName;
    options.scopeUnassigned = Boolean(
        config.defaultOptions && config.defaultOptions.department === 'unassigned'
    );
    options.requireAssignmentAction = Boolean(config.requireAssignmentAction);
    options.excludeStatusNames = config.excludeStatusNames || [];
    options.requireAssignedDepartment = Boolean(config.requireAssignedDepartment);

    const lists = await lookups();

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

    const result = await listFeedback(options);
    const displayFilters = { ...filters };

    if (filters.statusName) {
        const selectedStatus = lists.statuses.find(
            status => status.status_name === filters.statusName
        );
        displayFilters.statusId = selectedStatus ? Number(selectedStatus.id) : null;
    } else if (!filters.statusId && config.defaultOptions && config.defaultOptions.statusName) {
        const selectedStatus = lists.statuses.find(
            status => status.status_name === config.defaultOptions.statusName
        );
        displayFilters.statusName = config.defaultOptions.statusName;
        displayFilters.statusId = selectedStatus ? Number(selectedStatus.id) : null;
    }

    const pageUrl = (page) => {
        const params = new URLSearchParams();
        if (filters.q) params.set('q', filters.q);
        if (filters.statusName) params.set('status_name', filters.statusName);
        else if (filters.statusId) params.set('status', filters.statusId);
        if (filters.categoryId) {
            params.set('category', filters.categoryId);
        }
        if (filters.feedbackType) params.set('feedback_type', filters.feedbackType);
        if (filters.dateFrom) params.set('date_from', filters.dateFrom);
        if (filters.dateTo) params.set('date_to', filters.dateTo);
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
        filters.statusName ||
        filters.categoryId ||
        filters.feedbackType ||
        filters.dateFrom ||
        filters.dateTo ||
        (filters.department && config.mode !== 'department')
    );

    res.render(config.view || 'feedback-list', {
        ...config,
        ...result,
        ...lists,
        filters: displayFilters,
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
        showDepartmentFilter: true,
        showFeedbackTypeFilter: true,
        showDateFilter: true
    })
);

router.get('/pending', requireRole('admin'), (req, res) =>
    renderList(req, res, {
        mode: 'admin',
        basePath: '/feedback/pending',
        pageTitle: 'Pending Feedback',
        intro: 'New submissions for administrator review before department assignment.',
        defaultOptions: { statusName: 'Pending' },
        canAssign: false,
        showDepartmentFilter: true,
        showFeedbackTypeFilter: true,
        showDateFilter: true
    })
);

router.get('/unassigned', requireRole('admin'), (req, res) =>
    res.redirect('/feedback/assign')
);

router.get('/assign', requireRole('admin'), (req, res) =>
    renderList(req, res, {
        mode: 'admin',
        basePath: '/feedback/assign',
        pageTitle: 'Department Assignment',
        intro: 'Assign unassigned submissions or confirm existing assignments that are still marked Pending.',
        requireAssignmentAction: true,
        excludeStatusNames: ['Resolved', 'Awaiting Admin Review'],
        canAssign: true,
        showDepartmentFilter: false,
        showFeedbackTypeFilter: true,
        showDateFilter: true
    })
);

router.get('/in-progress', requireRole('admin'), (req, res) =>
    renderList(req, res, {
        mode: 'admin',
        basePath: '/feedback/in-progress',
        pageTitle: 'In Progress',
        intro: 'Submissions currently being handled by their assigned departments.',
        defaultOptions: { statusName: 'In Progress' },
        requireAssignedDepartment: true,
        canAssign: false,
        showDepartmentFilter: true,
        showFeedbackTypeFilter: true,
        showDateFilter: true,
        showLastUpdated: true
    })
);

router.get('/review', requireRole('admin'), (req, res) =>
    renderList(req, res, {
        mode: 'admin',
        basePath: '/feedback/review',
        pageTitle: 'Admin Review',
        intro: 'Department action reports waiting for an administrator decision.',
        defaultOptions: { statusName: 'Awaiting Admin Review' },
        canAssign: false,
        showDepartmentFilter: false,
        showFeedbackTypeFilter: true,
        showDateFilter: true,
        showActionReport: true
    })
);

router.get('/resolutions', requireRole('admin'), (req, res) =>
    renderList(req, res, {
        mode: 'admin',
        basePath: '/feedback/resolutions',
        pageTitle: 'Resolved Feedback',
        intro: 'Feedback resolved by an administrator, including final responses.',
        defaultOptions: { statusName: 'Resolved' },
        canAssign: false,
        showDepartmentFilter: false,
        showFeedbackTypeFilter: true,
        showDateFilter: true,
        showResolvedDetails: true
    })
);

router.get('/management', requireRole('institutional_management', 'admin'), (req, res) =>
    renderList(req, res, {
        mode: 'management',
        basePath: '/feedback/management',
        pageTitle: 'School overview',
        intro: 'A read-only view of every submission and where it stands.',
        canAssign: false,
        showDepartmentFilter: true,
        showFeedbackTypeFilter: true,
        showDateFilter: true
    })
);

router.get('/department-inbox', requireRole(...DEPT_ROLES), (req, res) => {
    const filters = parseFilters(req.query);
    const awaitingAdminReview = filters.statusName === 'Awaiting Admin Review';
    const typeTitle = filters.feedbackType === 'Concern'
        ? 'Faculty Concerns'
        : filters.feedbackType === 'Suggestion'
            ? 'Faculty Suggestions'
            : null;
    const pageTitle = typeTitle ||
        (awaitingAdminReview
            ? 'Submitted to Admin'
            : filters.statusName || (req.session.user.role === 'faculty' ? 'Assigned Feedback' : 'Inbox'));
    const intro = filters.feedbackType === 'Concern'
        ? 'Concern submissions assigned to your department.'
        : filters.feedbackType === 'Suggestion'
            ? 'Suggestion submissions assigned to your department.'
            : awaitingAdminReview
                ? 'Department action reports currently awaiting administrator review.'
                : 'Feedback assigned to your department. Open one to update its status or leave a note.';

    return renderList(req, res, {
        mode: 'department',
        basePath: '/feedback/department-inbox',
        pageTitle,
        intro,
        canAssign: false,
        showDepartmentFilter: false,
        showFeedbackTypeFilter: true
    });
});

router.get('/department-history', requireRole(...DEPT_ROLES), async (req, res) => {
    const departmentId = req.session.user.department_id;

    if (!departmentId) {
        return res.status(403).render('error', {
            code: 403,
            title: 'No department assigned',
            message: 'Your account has no department yet. Ask an administrator to assign one.'
        });
    }

    const [rows] = await db.query(
        `SELECT
            f.id,
            f.reference_code,
            f.subject,
            f.created_at,
            f.feedback_type,
            s.status_name AS current_status,
            (
                SELECT old_status.status_name
                FROM feedback_history fh
                LEFT JOIN statuses old_status ON old_status.id = fh.old_status_id
                WHERE fh.feedback_id = f.id
                  AND fh.old_status_id IS NOT NULL
                  AND fh.old_status_id <> fh.new_status_id
                ORDER BY fh.changed_at DESC, fh.id DESC
                LIMIT 1
            ) AS previous_status,
            GREATEST(
                COALESCE(
                    (SELECT MAX(fh.changed_at) FROM feedback_history fh WHERE fh.feedback_id = f.id),
                    f.created_at
                ),
                COALESCE(
                    (SELECT MAX(ah.changed_at) FROM feedback_assignment_history ah WHERE ah.feedback_id = f.id),
                    f.created_at
                )
            ) AS last_updated_at,
            (
                SELECT fh.remarks
                FROM feedback_history fh
                JOIN users changed_by ON changed_by.id = fh.changed_by
                WHERE fh.feedback_id = f.id
                  AND changed_by.role IN (${DEPT_ROLES.map(() => '?').join(', ')})
                  AND changed_by.department_id = ?
                  AND fh.remarks IS NOT NULL
                  AND TRIM(fh.remarks) != ''
                ORDER BY fh.changed_at DESC, fh.id DESC
                LIMIT 1
            ) AS department_remarks,
            (
                SELECT fh.remarks
                FROM feedback_history fh
                JOIN users changed_by ON changed_by.id = fh.changed_by
                JOIN statuses new_status ON new_status.id = fh.new_status_id
                WHERE fh.feedback_id = f.id
                  AND changed_by.role = 'admin'
                  AND f.status_id = fh.new_status_id
                  AND new_status.status_name = 'Resolved'
                  AND fh.remarks IS NOT NULL
                  AND TRIM(fh.remarks) != ''
                ORDER BY fh.changed_at DESC, fh.id DESC
                LIMIT 1
            ) AS admin_response
         FROM feedback f
         JOIN statuses s ON s.id = f.status_id
         WHERE f.assigned_department_id = ?
         ORDER BY last_updated_at DESC, f.id DESC`,
        [...DEPT_ROLES, departmentId, departmentId]
    );

    const historyByFeedback = new Map();
    if (rows.length) {
        const ids = rows.map(row => row.id);
        const [[statusEvents], [assignmentEvents]] = await Promise.all([
            db.query(
                `SELECT
                    fh.feedback_id,
                    fh.changed_at,
                    fh.remarks,
                    fh.visible_to_submitter,
                    os.status_name AS old_status,
                    ns.status_name AS new_status,
                    u.full_name AS changed_by,
                    u.role AS changed_by_role,
                    u.department_id AS changed_by_department
                 FROM feedback_history fh
                 LEFT JOIN statuses os ON os.id = fh.old_status_id
                 JOIN statuses ns ON ns.id = fh.new_status_id
                 LEFT JOIN users u ON u.id = fh.changed_by
                 WHERE fh.feedback_id IN (?)
                   AND (u.role = 'admin' OR u.department_id = ? OR u.id IS NULL)
                 ORDER BY fh.changed_at DESC, fh.id DESC`,
                [ids, departmentId]
            ),
            db.query(
                `SELECT
                    ah.feedback_id,
                    ah.changed_at,
                    od.department_name AS old_department,
                    nd.department_name AS new_department,
                    u.full_name AS changed_by,
                    ah.remarks
                 FROM feedback_assignment_history ah
                 LEFT JOIN departments od ON od.id = ah.old_department_id
                 JOIN departments nd ON nd.id = ah.new_department_id
                 LEFT JOIN users u ON u.id = ah.changed_by
                 WHERE ah.feedback_id IN (?)
                   AND (ah.old_department_id = ? OR ah.new_department_id = ?)
                 ORDER BY ah.changed_at DESC, ah.id DESC`,
                [ids, departmentId, departmentId]
            )
        ]);

        for (const row of rows) {
            historyByFeedback.set(row.id, [{
                at: row.created_at,
                type: 'Submission',
                summary: 'Submission received as Pending',
                by: 'Submitter',
                remarks: null
            }]);
        }
        statusEvents.forEach(event => {
            historyByFeedback.get(event.feedback_id).push({
                at: event.changed_at,
                type: event.old_status === event.new_status ? 'Note' : 'Status',
                summary: event.old_status
                    ? `${event.old_status} → ${event.new_status}`
                    : `Submitted as ${event.new_status}`,
                by: event.changed_by || 'System',
                remarks: event.remarks,
                visible_to_submitter: Number(event.visible_to_submitter) === 1
            });
        });
        assignmentEvents.forEach(event => {
            historyByFeedback.get(event.feedback_id).push({
                at: event.changed_at,
                type: 'Assignment',
                summary: event.old_department
                    ? `Reassigned from ${event.old_department} to ${event.new_department}`
                    : `Assigned to ${event.new_department}`,
                by: event.changed_by || 'Administrator',
                remarks: event.remarks,
                visible_to_submitter: false
            });
        });
        historyByFeedback.forEach(events =>
            events.sort((a, b) => new Date(b.at) - new Date(a.at))
        );
    }

    res.render('department-history', {
        rows,
        historyByFeedback: Object.fromEntries(historyByFeedback)
    });
});

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
            f.feedback_type,
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
                fh.visible_to_submitter,
                fh.changed_at,
                os.status_name AS old_status,
                ns.status_name AS new_status,
                u.full_name AS changed_by
             FROM feedback_history fh
             LEFT JOIN statuses os ON fh.old_status_id = os.id
             JOIN statuses ns ON fh.new_status_id = ns.id
             LEFT JOIN users u ON fh.changed_by = u.id
             WHERE fh.feedback_id = ?
               AND (? = 0 OR u.role = 'admin' OR u.department_id = ?)`,
            [
                id,
                isDeptStaff(user) ? 1 : 0,
                user.department_id || -1
            ]
        ),
        db.query(
            `SELECT
                ah.id,
                ah.changed_at,
                od.department_name AS old_department,
                nd.department_name AS new_department,
                u.full_name AS changed_by,
                ah.remarks
             FROM feedback_assignment_history ah
             LEFT JOIN departments od ON ah.old_department_id = od.id
             JOIN departments nd ON ah.new_department_id = nd.id
             LEFT JOIN users u ON ah.changed_by = u.id
             WHERE ah.feedback_id = ?
               AND (? = 0 OR ah.old_department_id = ? OR ah.new_department_id = ?)`,
            [
                id,
                isDeptStaff(user) ? 1 : 0,
                user.department_id || -1,
                user.department_id || -1
            ]
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
            status: item.new_status,
            visible_to_submitter: Number(item.visible_to_submitter) === 1
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
            remarks: item.remarks,
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
    const visibleToSubmitter = String(body.visibility_option_present || '') === '1'
        ? String(body.visible_to_submitter || '') === '1'
        : true;
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
             LIMIT 1
             FOR UPDATE`,
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

        if (isDepartmentStaff) {
            const transitions = {
                Pending: user.role === 'faculty' ? [] : ['Under Review'],
                Assigned: ['Under Review'],
                'Under Review': ['In Progress'],
                'In Progress': [],
                'Returned for Further Action': ['Under Review']
            };
            const allowed = transitions[oldStatus] || [];
            if (newStatus !== oldStatus && !allowed.includes(newStatus)) {
                return { type: 'invalid_transition' };
            }
            if (oldStatus === 'Awaiting Admin Review') {
                return { type: 'awaiting_review' };
            }
        } else if (isAdmin) {
            return { type: 'use_review_action' };
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
                (feedback_id, changed_by, old_status_id, new_status_id, remarks, visible_to_submitter)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [id, user.id, oldStatusId, newStatusId, remarks, visibleToSubmitter ? 1 : 0]
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
        case 'awaiting_review':
            flash(req, 'error', 'This action report is with the administrator and cannot be changed until it is returned.');
            break;
        case 'use_review_action':
            flash(req, 'error', 'Use the Admin Review actions to approve or return this department report.');
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

router.post('/view/:id/report', requireRole(...DEPT_ROLES), async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return notFound(res);

    const user = req.session.user;
    const remarks = String((req.body || {}).remarks || '').trim();
    if (!remarks || remarks.length > REMARKS_MAX) {
        flash(req, 'error', 'Enter the department action taken and findings (up to 1,000 characters).');
        return res.redirect(`/feedback/view/${id}`);
    }

    const outcome = await db.withTransaction(async conn => {
        const [rows] = await conn.query(
            `SELECT f.status_id, f.assigned_department_id, s.status_name
             FROM feedback f
             JOIN statuses s ON s.id = f.status_id
             WHERE f.id = ?
             LIMIT 1
             FOR UPDATE`,
            [id]
        );
        if (!rows.length || !ownsFeedback(user, rows[0])) return { type: 'missing' };
        if (Number(rows[0].assigned_department_id) !== Number(user.department_id)) return { type: 'forbidden' };
        if (rows[0].status_name !== 'In Progress') {
            return { type: rows[0].status_name === 'Awaiting Admin Review' ? 'already_submitted' : 'invalid_status' };
        }

        const [[status]] = await conn.query(
            'SELECT id FROM statuses WHERE status_name = ? LIMIT 1',
            ['Awaiting Admin Review']
        );
        if (!status) throw new Error('Awaiting Admin Review status is missing from the statuses table.');

        await conn.query('UPDATE feedback SET status_id = ? WHERE id = ?', [status.id, id]);
        await conn.query(
            `INSERT INTO feedback_history
                (feedback_id, changed_by, old_status_id, new_status_id, remarks, visible_to_submitter)
             VALUES (?, ?, ?, ?, ?, 0)`,
            [id, user.id, rows[0].status_id, status.id, remarks]
        );
        return { type: 'submitted' };
    });

    if (outcome.type === 'missing') return notFound(res);
    if (outcome.type === 'forbidden') {
        flash(req, 'error', 'You may submit reports only for feedback assigned to your department.');
    } else if (outcome.type === 'already_submitted') {
        flash(req, 'info', 'This action report is already awaiting Admin review.');
    } else if (outcome.type === 'invalid_status') {
        flash(req, 'error', 'Move the feedback to In Progress before submitting an action report.');
    } else {
        flash(req, 'success', 'Your action report was submitted to the Admin for review.');
    }
    return res.redirect(`/feedback/view/${id}`);
});

router.post('/view/:id/review', requireRole('admin'), async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return notFound(res);

    const decision = String((req.body || {}).decision || '');
    const remarks = String((req.body || {}).remarks || '').trim();
    if (!['resolve', 'return'].includes(decision)) {
        flash(req, 'error', 'Choose whether to resolve or return this action report.');
        return res.redirect(`/feedback/view/${id}`);
    }
    if (!remarks || remarks.length > REMARKS_MAX) {
        flash(req, 'error', 'Enter review remarks (up to 1,000 characters).');
        return res.redirect(`/feedback/view/${id}`);
    }

    const user = req.session.user;
    const outcome = await db.withTransaction(async conn => {
        const [rows] = await conn.query(
            `SELECT f.status_id, f.assigned_department_id, s.status_name
             FROM feedback f
             JOIN statuses s ON s.id = f.status_id
             WHERE f.id = ?
             LIMIT 1
             FOR UPDATE`,
            [id]
        );
        if (!rows.length) return { type: 'missing' };
        if (rows[0].status_name !== 'Awaiting Admin Review') return { type: 'not_awaiting' };

        const targetStatusName = decision === 'resolve'
            ? 'Resolved'
            : 'Returned for Further Action';
        const [[targetStatus]] = await conn.query(
            'SELECT id FROM statuses WHERE status_name = ? LIMIT 1',
            [targetStatusName]
        );
        if (!targetStatus) throw new Error(`The "${targetStatusName}" status is missing from the statuses table.`);

        await conn.query('UPDATE feedback SET status_id = ? WHERE id = ?', [targetStatus.id, id]);
        await conn.query(
            `INSERT INTO feedback_history
                (feedback_id, changed_by, old_status_id, new_status_id, remarks, visible_to_submitter)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [id, user.id, rows[0].status_id, targetStatus.id, remarks, decision === 'resolve' ? 1 : 0]
        );
        return { type: decision };
    });

    if (outcome.type === 'missing') return notFound(res);
    if (outcome.type === 'not_awaiting') {
        flash(req, 'error', 'Only reports awaiting Admin review can be decided.');
    } else if (outcome.type === 'return') {
        flash(req, 'success', 'The report was returned to its department for further action.');
    } else {
        flash(req, 'success', 'The report was approved and the feedback was marked Resolved.');
    }
    return res.redirect(`/feedback/view/${id}`);
});

// Assign (or reassign) a department. Admin only.
router.post('/view/:id/assign', requireRole('admin'), async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return notFound(res);

    const user = req.session.user;
    const departmentId = parseId((req.body || {}).department_id);
    const assignmentRemarks = String((req.body || {}).assignment_remarks || '').trim();
    const fallback = `/feedback/view/${id}`;
    const returnTo = safeReturn((req.body || {}).return_to, fallback);

    if (!departmentId) {
        flash(req, 'error', 'Choose a department.');
        return res.redirect(returnTo);
    }
    if (assignmentRemarks.length > REMARKS_MAX) {
        flash(req, 'error', `Assignment remarks must be ${REMARKS_MAX} characters or fewer.`);
        return res.redirect(returnTo);
    }

    const outcome = await db.withTransaction(async (conn) => {
        const [rows] = await conn.query(
            `SELECT f.assigned_department_id, f.status_id, s.status_name
             FROM feedback f
             JOIN statuses s ON s.id = f.status_id
             WHERE f.id = ?
             LIMIT 1
             FOR UPDATE`,
            [id]
        );

        if (rows.length === 0) {
            return { type: 'missing' };
        }
        if (rows[0].status_name === 'Resolved') return { type: 'closed' };
        if (rows[0].status_name === 'Awaiting Admin Review') return { type: 'awaiting_review' };

        const [departmentRows] = await conn.query(
            'SELECT id, department_name FROM departments WHERE id = ? LIMIT 1',
            [departmentId]
        );

        if (departmentRows.length === 0) {
            return { type: 'invalid' };
        }

        const oldDepartmentId = rows[0].assigned_department_id;
        const isPending = rows[0].status_name === 'Pending';

        if (
            oldDepartmentId !== null &&
            Number(oldDepartmentId) === departmentId &&
            !isPending
        ) {
            return { type: 'unchanged', name: departmentRows[0].department_name };
        }

        let pendingStatus = null;
        let assignedStatus = null;

        if (isPending) {
            const [statusRows] = await conn.query(
                'SELECT id, status_name FROM statuses WHERE status_name IN (?, ?)',
                ['Pending', 'Assigned']
            );
            pendingStatus = statusRows.find(status => status.status_name === 'Pending');
            assignedStatus = statusRows.find(status => status.status_name === 'Assigned');

            if (!pendingStatus || !assignedStatus) {
                throw new Error('Pending or Assigned status is missing from the statuses table.');
            }
        }

        const [update] = await conn.query(
            `UPDATE feedback
             SET assigned_department_id = ?,
                 status_id = ?
             WHERE id = ?`,
            [departmentId, isPending ? assignedStatus.id : rows[0].status_id, id]
        );

        if (!update.affectedRows) {
            throw new Error('The feedback assignment did not update a record.');
        }

        if (isPending) {
            await conn.query(
                `INSERT INTO feedback_history
                    (feedback_id, changed_by, old_status_id, new_status_id, remarks, visible_to_submitter)
                 VALUES (?, ?, ?, ?, ?, 0)`,
                [
                    id,
                    user.id,
                    pendingStatus.id,
                    assignedStatus.id,
                    oldDepartmentId !== null && Number(oldDepartmentId) === departmentId
                        ? assignmentRemarks || null
                        : null
                ]
            );
        }

        if (oldDepartmentId === null || Number(oldDepartmentId) !== departmentId) {
            await conn.query(
                `INSERT INTO feedback_assignment_history
                    (feedback_id, changed_by, old_department_id, new_department_id, remarks)
                 VALUES (?, ?, ?, ?, ?)`,
                [id, user.id, oldDepartmentId, departmentId, assignmentRemarks || null]
            );
        }

        return {
            type: isPending && oldDepartmentId !== null && Number(oldDepartmentId) === departmentId
                ? 'confirmed'
                : 'assigned',
            name: departmentRows[0].department_name
        };
    });

    if (outcome.type === 'missing') return notFound(res);

    if (outcome.type === 'closed') {
        flash(req, 'error', 'Resolved feedback cannot be reassigned.');
    } else if (outcome.type === 'awaiting_review') {
        flash(req, 'error', 'A report awaiting review cannot be reassigned.');
    } else if (outcome.type === 'invalid') {
        flash(req, 'error', 'That department does not exist.');
    } else if (outcome.type === 'unchanged') {
        flash(req, 'info', `Already assigned to ${outcome.name}.`);
    } else if (outcome.type === 'confirmed') {
        flash(req, 'success', `Assignment to ${outcome.name} was confirmed. The feedback is now Assigned.`);
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