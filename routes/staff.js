const express = require('express');
const bcrypt = require('bcrypt');
const router = express.Router();

const db = require('../config/db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { DEPT_ROLES } = require('../lib/constants');
const {
    listFeedback,
    statusCounts,
    feedbackTypeStatusCounts,
    categoryCounts,
    lookups
} = require('../lib/feedbackQueries');

const REPORT_ROLES = ['admin', 'institutional_management', ...DEPT_ROLES];

// Which submissions this person works with.
function scopeFor(user) {
    if (user.role === 'admin' || user.role === 'institutional_management') {
        return { label: 'All feedback', all: true };
    }

    if (DEPT_ROLES.includes(user.role)) {
        return {
            label: 'Your department',
            departmentId: user.department_id || -1
        };
    }

    return { label: 'Your submissions', submittedBy: user.id };
}

router.get('/dashboard', requireLogin, async (req, res) => {
    const [accounts] = await db.query(
        `SELECT u.id, u.full_name, u.email, u.role, u.department_id, d.department_name
         FROM users u
         LEFT JOIN departments d ON u.department_id = d.id
         WHERE u.id = ?
         LIMIT 1`,
        [req.session.user.id]
    );

    if (accounts.length === 0) {
        return req.session.destroy(() => res.redirect('/auth/login'));
    }

    const me = accounts[0];
    const departmentWorkflowShortcuts =
        (me.role === 'guidance_staff' && me.department_name === 'Guidance Office') ||
        (me.role === 'it_staff' && me.department_name === 'IT Department') ||
        (me.role === 'department_head' && me.department_name === 'Facilities Department');

    // Keep the session in step with the database (role or department changes).
    req.session.user = {
        id: me.id,
        full_name: me.full_name,
        email: me.email,
        role: me.role,
        department_id: me.department_id
    };
    res.locals.user = req.session.user;

    const scope = scopeFor(req.session.user);
    // The list shown under the numbers depends on the role.
    let attention = { title: 'Latest submissions', rows: [], link: null };
    const listOptions = { perPage: 6 };
    let departmentFeedback = null;
    let facultyConcerns = { rows: [], total: 0 };
    let facultySuggestions = { rows: [], total: 0 };
    let submittedToAdmin = { rows: [], total: 0 };
    let recentAssignments = [];
    let recentStatusUpdates = [];
    let recentActivity = [];

    if (me.role === 'admin') {
        attention.title = 'Recent activity';
        attention.link = { href: '/feedback/admin', text: 'View all feedback' };
        const [activity] = await db.query(
            `SELECT activity.feedback_id AS id, activity.subject,
                    activity.reference_code, activity.activity,
                    activity.activity_at, activity.actor
             FROM (
                SELECT
                    f.id AS feedback_id,
                    f.subject,
                    f.reference_code,
                    CASE
                        WHEN fh.old_status_id IS NULL THEN CONCAT('Submitted as ', new_status.status_name)
                        ELSE CONCAT('Status changed: ', old_status.status_name, ' → ', new_status.status_name)
                    END AS activity,
                    fh.changed_at AS activity_at,
                    COALESCE(actor.full_name, 'Submitter') AS actor
                FROM feedback_history fh
                JOIN feedback f ON f.id = fh.feedback_id
                LEFT JOIN statuses old_status ON old_status.id = fh.old_status_id
                JOIN statuses new_status ON new_status.id = fh.new_status_id
                LEFT JOIN users actor ON actor.id = fh.changed_by

                UNION ALL

                SELECT
                    f.id AS feedback_id,
                    f.subject,
                    f.reference_code,
                    CONCAT('Assigned to ', new_department.department_name) AS activity,
                    ah.changed_at AS activity_at,
                    COALESCE(actor.full_name, 'Administrator') AS actor
                FROM feedback_assignment_history ah
                JOIN feedback f ON f.id = ah.feedback_id
                JOIN departments new_department ON new_department.id = ah.new_department_id
                LEFT JOIN users actor ON actor.id = ah.changed_by
             ) activity
             ORDER BY activity.activity_at DESC, activity.feedback_id DESC
             LIMIT 8`
        );
        recentActivity = activity;
    } else if (DEPT_ROLES.includes(me.role)) {
        const page = Number(req.query.page) > 0 ? Number(req.query.page) : 1;
        departmentFeedback = await listFeedback({
            departmentId: scope.departmentId,
            page,
            perPage: 15
        });

        if (me.role === 'faculty' && me.department_id) {
            [facultyConcerns, facultySuggestions, submittedToAdmin] =
                await Promise.all([
                    listFeedback({
                        departmentId: me.department_id,
                        feedbackType: 'Concern',
                        perPage: 15
                    }),
                    listFeedback({
                        departmentId: me.department_id,
                        feedbackType: 'Suggestion',
                        perPage: 15
                    }),
                    listFeedback({
                        departmentId: me.department_id,
                        statusName: 'Awaiting Admin Review',
                        perPage: 15
                    })
                ]);

            const [[assignments], [updates]] = await Promise.all([
                db.query(
                    `SELECT f.id, f.subject, f.reference_code, f.feedback_type,
                            ah.changed_at, d.department_name
                     FROM feedback_assignment_history ah
                     JOIN feedback f ON f.id = ah.feedback_id
                     JOIN departments d ON d.id = ah.new_department_id
                     WHERE ah.new_department_id = ?
                       AND f.assigned_department_id = ?
                     ORDER BY ah.changed_at DESC, ah.id DESC
                     LIMIT 5`,
                    [me.department_id, me.department_id]
                ),
                db.query(
                    `SELECT f.id, f.subject, f.reference_code, fh.changed_at,
                            os.status_name AS old_status, ns.status_name AS new_status,
                            fh.remarks
                     FROM feedback_history fh
                     JOIN feedback f ON f.id = fh.feedback_id
                     LEFT JOIN statuses os ON os.id = fh.old_status_id
                     JOIN statuses ns ON ns.id = fh.new_status_id
                     LEFT JOIN users changed_by ON changed_by.id = fh.changed_by
                     WHERE f.assigned_department_id = ?
                       AND (changed_by.role = 'admin' OR changed_by.department_id = ? OR changed_by.id IS NULL)
                     ORDER BY fh.changed_at DESC, fh.id DESC
                     LIMIT 5`,
                    [me.department_id, me.department_id]
                )
            ]);
            recentAssignments = assignments;
            recentStatusUpdates = updates;
        }
    } else if (me.role === 'institutional_management') {
        attention.title = 'Latest submissions';
        attention.link = { href: '/feedback/management', text: 'Open overview' };
    } else {
        attention.title = 'Your latest submissions';
        attention.link = { href: '/feedback/my-submissions', text: 'See all of yours' };
        listOptions.submittedBy = me.id;
    }

    const statScope = scope.all ? {} : scope;
    const [counts, list, typedCounts] = await Promise.all([
        statusCounts(statScope),
        departmentFeedback || me.role === 'admin'
            ? Promise.resolve(null)
            : listFeedback(listOptions),
        me.role === 'faculty' && me.department_id
            ? feedbackTypeStatusCounts(me.department_id)
            : Promise.resolve([])
    ]);

    if (list) attention.rows = list.rows;

    const countOf = name => (counts.find(c => c.status_name === name) || {}).total || 0;
    const total = counts.reduce((sum, c) => sum + c.total, 0);
    const departmentPageUrl = page => page > 1 ? `/staff/dashboard?page=${page}` : '/staff/dashboard';

    res.render('staff-dashboard', {
        me: { ...me, department_name: me.department_name },
        scopeLabel: scope.label,
        departmentDashboard: DEPT_ROLES.includes(me.role),
        departmentWorkflowShortcuts,
        departmentFeedback,
        departmentPageUrl,
        facultyConcerns: facultyConcerns.rows,
        facultyConcernsTotal: facultyConcerns.total,
        facultySuggestions: facultySuggestions.rows,
        facultySuggestionsTotal: facultySuggestions.total,
        submittedToAdmin: submittedToAdmin.rows,
        submittedToAdminTotal: submittedToAdmin.total,
        recentAssignments,
        recentStatusUpdates,
        recentActivity,
        pendingConcernCount: typedCounts
            .filter(row => row.feedback_type === 'Concern' && ['Pending', 'Assigned'].includes(row.status_name))
            .reduce((sum, row) => sum + row.total, 0),
        facultyInProgressCount: countOf('In Progress'),
        facultyResolvedCount: countOf('Resolved'),
        cards: {
            total,
            pendingAssigned: countOf('Pending') + countOf('Assigned'),
            underReview: countOf('Under Review'),
            inProgress: countOf('In Progress'),
            awaitingAdminReview: countOf('Awaiting Admin Review'),
            inProgress: countOf('In Progress'),
            resolved: countOf('Resolved'),
            pending: countOf('Pending'),
            active:
                countOf('Assigned') +
                countOf('Under Review') +
                countOf('In Progress') +
                countOf('Awaiting Admin Review')
        },
        attention,
        noDepartment: DEPT_ROLES.includes(me.role) && !me.department_id
    });
});

async function loadFacultyProfile(userId) {
    const [[profile]] = await db.query(
        `SELECT u.full_name, u.email, u.role, u.department_id, u.created_at,
                d.department_name
         FROM users u
         LEFT JOIN departments d ON d.id = u.department_id
         WHERE u.id = ?
         LIMIT 1`,
        [userId]
    );

    return profile;
}

async function renderFacultyProfile(req, res, { editMode = false, error = null, values = {} } = {}, status = 200) {
    const profile = await loadFacultyProfile(req.session.user.id);

    if (!profile) {
        return res.status(404).render('error', {
            code: 404,
            title: 'Profile not found',
            message: 'Your account could not be found.'
        });
    }

    if (profile.role !== 'faculty') {
        return res.status(403).render('error', {
            code: 403,
            title: 'Access denied',
            message: 'This profile page is available to faculty accounts only.'
        });
    }

    req.session.user = {
        ...req.session.user,
        full_name: profile.full_name,
        email: profile.email,
        role: profile.role,
        department_id: profile.department_id
    };
    res.locals.user = req.session.user;

    return res.status(status).render('staff-profile', {
        profile,
        editMode,
        error,
        values: { full_name: profile.full_name, ...values }
    });
}

router.get('/profile', requireRole('faculty'), async (req, res) => {
    await renderFacultyProfile(req, res, {
        editMode: req.query.edit === '1'
    });
});

router.post('/profile', requireRole('faculty'), async (req, res) => {
    const fullName = String((req.body && req.body.full_name) || '').trim();

    if (!fullName || fullName.length > 150) {
        return renderFacultyProfile(req, res, {
            editMode: true,
            error: 'Enter your name using no more than 150 characters.',
            values: { full_name: fullName }
        }, 400);
    }

    const [result] = await db.query(
        'UPDATE users SET full_name = ? WHERE id = ? AND role = ?',
        [fullName, req.session.user.id, 'faculty']
    );

    if (result.affectedRows !== 1) {
        const [[account]] = await db.query(
            'SELECT full_name FROM users WHERE id = ? AND role = ? LIMIT 1',
            [req.session.user.id, 'faculty']
        );
        if (!account || account.full_name !== fullName) {
            return res.status(404).render('error', {
                code: 404,
                title: 'Profile not found',
                message: 'Your faculty account could not be updated. Please sign in again or contact an administrator.'
            });
        }
    }

    req.session.user.full_name = fullName;
    req.session.flash = { type: 'success', message: 'Your profile name was updated.' };
    return res.redirect('/staff/profile');
});

router.post('/profile/password', requireRole('faculty'), async (req, res) => {
    const currentPassword = String((req.body && req.body.current_password) || '');
    const newPassword = String((req.body && req.body.new_password) || '');
    const confirmPassword = String((req.body && req.body.confirm_password) || '');

    const showPasswordError = (message, status = 400) =>
        renderFacultyProfile(req, res, { error: message }, status);

    if (!currentPassword || !newPassword || !confirmPassword) {
        return showPasswordError('Complete all password fields.');
    }

    if (newPassword.length < 12) {
        return showPasswordError('Your new password must contain at least 12 characters.');
    }

    if (Buffer.byteLength(newPassword, 'utf8') > 72) {
        return showPasswordError('Your new password must be no longer than 72 bytes.');
    }

    if (newPassword !== confirmPassword) {
        return showPasswordError('The new password and confirmation do not match.');
    }

    const [[account]] = await db.query(
        'SELECT password_hash FROM users WHERE id = ? AND role = ? LIMIT 1',
        [req.session.user.id, 'faculty']
    );

    if (!account) {
        return res.status(404).render('error', {
            code: 404,
            title: 'Account not found',
            message: 'Your faculty account could not be found. Please sign in again or contact an administrator.'
        });
    }

    if (!(await bcrypt.compare(currentPassword, account.password_hash))) {
        return showPasswordError('Your current password is incorrect.', 400);
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await db.query(
        'UPDATE users SET password_hash = ? WHERE id = ? AND role = ?',
        [passwordHash, req.session.user.id, 'faculty']
    );

    req.session.flash = { type: 'success', message: 'Your password was changed successfully.' };
    return res.redirect('/staff/profile');
});

router.get('/reports', requireRole(...REPORT_ROLES), async (req, res) => {
    const user = req.session.user;
    const isDeptStaff = DEPT_ROLES.includes(user.role);

    if (isDeptStaff && !user.department_id) {
        return res.status(403).render('error', {
            code: 403,
            title: 'No department assigned',
            message: 'Your account has no department yet. Ask an administrator to assign one.'
        });
    }

    const scope = isDeptStaff ? { departmentId: user.department_id } : {};

    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const weekClause = isDeptStaff ? 'AND assigned_department_id = ?' : '';
    const weekParams = isDeptStaff ? [weekAgo, user.department_id] : [weekAgo];

    const [statuses, categories, [weekRows], [unassignedRows], [deptRows]] = await Promise.all([
        statusCounts(scope),
        categoryCounts(scope),
        db.query(
            `SELECT COUNT(*) AS total FROM feedback WHERE created_at >= ? ${weekClause}`,
            weekParams
        ),
        isDeptStaff
            ? Promise.resolve([[{ total: 0 }]])
            : db.query('SELECT COUNT(*) AS total FROM feedback WHERE assigned_department_id IS NULL'),
        isDeptStaff
            ? Promise.resolve([[]])
            : db.query(
                `SELECT
                    d.department_name,
                    COUNT(f.id) AS total,
                    SUM(CASE WHEN s.status_name = 'Resolved' THEN 1 ELSE 0 END) AS resolved,
                    SUM(CASE WHEN s.status_name = 'Pending' THEN 1 ELSE 0 END) AS pending
                 FROM departments d
                 LEFT JOIN feedback f ON f.assigned_department_id = d.id
                 LEFT JOIN statuses s ON f.status_id = s.id
                 GROUP BY d.id, d.department_name
                 ORDER BY d.department_name ASC`
            )
    ]);

    const countOf = name => (statuses.find(s => s.status_name === name) || {}).total || 0;
    const total = statuses.reduce((sum, s) => sum + s.total, 0);
    const resolved = countOf('Resolved');

    res.render('reports', {
        scopeLabel: isDeptStaff ? 'Your department' : 'Whole school',
        total,
        pending: countOf('Pending'),
        resolved,
        resolutionRate: total ? Math.round((resolved / total) * 100) : 0,
        thisWeek: Number(weekRows[0].total) || 0,
        unassigned: Number(unassignedRows[0].total) || 0,
        statuses,
        categories,
        showDepartments: !isDeptStaff,
        departments: deptRows.map(row => ({
            department_name: row.department_name,
            total: Number(row.total) || 0,
            resolved: Number(row.resolved) || 0,
            pending: Number(row.pending) || 0
        }))
    });
});

module.exports = router;
