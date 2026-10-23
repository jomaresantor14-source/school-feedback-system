const express = require('express');
const router = express.Router();

const db = require('../config/db');
const { requireLogin, requireRole } = require('../middleware/auth');
const { DEPT_ROLES } = require('../lib/constants');
const {
    listFeedback,
    statusCounts,
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
    const { categories, statuses } = await lookups();

    // The list shown under the numbers depends on the role.
    let attention = { title: 'Latest submissions', rows: [], link: null };
    const listOptions = { perPage: 6 };
    let departmentFeedback = null;
    let facultyConcerns = { rows: [], total: 0 };
    let facultySuggestions = { rows: [], total: 0 };
    let submittedToAdmin = { rows: [], total: 0 };

    if (me.role === 'admin') {
        attention.title = 'Waiting for a department';
        attention.link = { href: '/feedback/admin?department=unassigned', text: 'See all unassigned' };
        listOptions.department = 'unassigned';
    } else if (DEPT_ROLES.includes(me.role)) {
        const page = Number(req.query.page) > 0 ? Number(req.query.page) : 1;
        departmentFeedback = await listFeedback({
            departmentId: scope.departmentId,
            page,
            perPage: 15
        });

        if (me.role === 'faculty' && me.department_id) {
            const concernCategory = categories.find(category =>
                /faculty.*concern|concern.*faculty/i.test(category.category_name)
            );
            const suggestionCategory = categories.find(category =>
                /faculty.*suggestion|suggestion.*faculty/i.test(category.category_name)
            );

            [facultyConcerns, facultySuggestions, submittedToAdmin] =
                await Promise.all([
                    concernCategory
                        ? listFeedback({
                            departmentId: me.department_id,
                            categoryId: concernCategory.id,
                            perPage: 15
                        })
                        : Promise.resolve(facultyConcerns),
                    suggestionCategory
                        ? listFeedback({
                            departmentId: me.department_id,
                            categoryId: suggestionCategory.id,
                            perPage: 15
                        })
                        : Promise.resolve(facultySuggestions),
                    listFeedback({
                        departmentId: me.department_id,
                        statusName: 'Awaiting Admin Review',
                        perPage: 15
                    })
                ]);
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
    const [counts, list] = await Promise.all([
        statusCounts(statScope),
        departmentFeedback ? Promise.resolve(null) : listFeedback(listOptions)
    ]);

    if (list) attention.rows = list.rows;

    const countOf = name => (counts.find(c => c.status_name === name) || {}).total || 0;
    const total = counts.reduce((sum, c) => sum + c.total, 0);
    const departmentPageUrl = page => page > 1 ? `/staff/dashboard?page=${page}` : '/staff/dashboard';

    res.render('staff-dashboard', {
        me: { ...me, department_name: me.department_name },
        scopeLabel: scope.label,
        departmentDashboard: DEPT_ROLES.includes(me.role),
        departmentFeedback,
        departmentPageUrl,
        facultyConcerns: facultyConcerns.rows,
        facultyConcernsTotal: facultyConcerns.total,
        facultySuggestions: facultySuggestions.rows,
        facultySuggestionsTotal: facultySuggestions.total,
        submittedToAdmin: submittedToAdmin.rows,
        submittedToAdminTotal: submittedToAdmin.total,
        cards: {
            total,
            pendingAssigned: countOf('Pending') + countOf('Assigned'),
            underReview: countOf('Under Review'),
            inProgress: countOf('In Progress'),
            awaitingAdminReview: countOf('Awaiting Admin Review'),
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

router.get('/profile', requireLogin, async (req, res) => {
    const [[profile]] = await db.query(
        `SELECT u.full_name, u.email, u.role, d.department_name
         FROM users u
         LEFT JOIN departments d ON d.id = u.department_id
         WHERE u.id = ?
         LIMIT 1`,
        [req.session.user.id]
    );

    if (!profile) {
        return res.status(404).render('error', {
            code: 404,
            title: 'Profile not found',
            message: 'Your account could not be found.'
        });
    }

    res.render('staff-profile', { profile });
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
