const db = require('../config/db');
const { normalizeRef } = require('./helpers');

const PER_PAGE = 15;

function positiveInt(value) {
    return /^\d+$/.test(String(value || '')) && Number(value) > 0
        ? Number(value)
        : null;
}

// Reads search/filter values from the URL query string.
function parseFilters(query = {}) {
    const q = String(query.q || '').trim().slice(0, 100);
    const rawDept = String(query.department || '');

    return {
        q,
        statusId: positiveInt(query.status),
        categoryId: positiveInt(query.category),
        department: rawDept === 'unassigned' ? 'unassigned' : positiveInt(rawDept),
        page: positiveInt(query.page) || 1
    };
}

// "!" is the LIKE escape character so the same SQL works on any database.
function escapeLike(value) {
    return value.replace(/[!%_]/g, '!$&');
}

function buildWhere(options = {}) {
    const clauses = [];
    const params = [];

    if (options.departmentId) {
        clauses.push('f.assigned_department_id = ?');
        params.push(options.departmentId);
    }

    if (options.submittedBy) {
        clauses.push('f.submitted_by = ?');
        params.push(options.submittedBy);
    }

    if (options.statusId) {
        clauses.push('f.status_id = ?');
        params.push(options.statusId);
    }

    if (options.categoryId) {
        clauses.push('f.category_id = ?');
        params.push(options.categoryId);
    }

    if (options.department === 'unassigned') {
        clauses.push('f.assigned_department_id IS NULL');
    } else if (options.department) {
        clauses.push('f.assigned_department_id = ?');
        params.push(options.department);
    }

    if (options.q) {
        const text = `%${escapeLike(options.q)}%`;
        const code = `%${escapeLike(normalizeRef(options.q) || options.q)}%`;

        clauses.push(
            `(f.subject LIKE ? ESCAPE '!' OR f.description LIKE ? ESCAPE '!' OR f.reference_code LIKE ? ESCAPE '!')`
        );
        params.push(text, text, code);
    }

    return {
        sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
        params
    };
}

// Returns one page of feedback plus paging details.
async function listFeedback(options = {}) {
    const perPage = options.perPage || PER_PAGE;
    const where = buildWhere(options);

    const [countRows] = await db.query(
        `SELECT COUNT(*) AS total FROM feedback f ${where.sql}`,
        where.params
    );

    const total = Number(countRows[0].total) || 0;
    const pages = Math.max(1, Math.ceil(total / perPage));
    const page = Math.min(options.page || 1, pages);

    const [rows] = await db.query(
        `SELECT
            f.id,
            f.reference_code,
            f.subject,
            f.created_at,
            f.is_anonymous,
            f.assigned_department_id,
            c.category_name,
            s.status_name,
            d.department_name
        FROM feedback f
        JOIN categories c ON f.category_id = c.id
        JOIN statuses s ON f.status_id = s.id
        LEFT JOIN departments d ON f.assigned_department_id = d.id
        ${where.sql}
        ORDER BY f.created_at DESC, f.id DESC
        LIMIT ? OFFSET ?`,
        [...where.params, perPage, (page - 1) * perPage]
    );

    return { rows, total, page, pages, perPage };
}

// Extra join condition used by the statistics queries.
function scopeJoin(scope = {}) {
    if (scope.departmentId) {
        return { sql: 'AND f.assigned_department_id = ?', params: [scope.departmentId] };
    }
    if (scope.submittedBy) {
        return { sql: 'AND f.submitted_by = ?', params: [scope.submittedBy] };
    }
    return { sql: '', params: [] };
}

// Number of submissions in each status (all statuses are listed, even with 0).
async function statusCounts(scope = {}) {
    const join = scopeJoin(scope);

    const [rows] = await db.query(
        `SELECT s.id, s.status_name, COUNT(f.id) AS total
         FROM statuses s
         LEFT JOIN feedback f ON f.status_id = s.id ${join.sql}
         GROUP BY s.id, s.status_name
         ORDER BY s.id`,
        join.params
    );

    return rows.map(row => ({
        id: row.id,
        status_name: row.status_name,
        total: Number(row.total) || 0
    }));
}

// Number of submissions in each category, most common first.
async function categoryCounts(scope = {}) {
    const join = scopeJoin(scope);

    const [rows] = await db.query(
        `SELECT c.id, c.category_name, COUNT(f.id) AS total
         FROM categories c
         LEFT JOIN feedback f ON f.category_id = c.id ${join.sql}
         GROUP BY c.id, c.category_name
         ORDER BY total DESC, c.category_name ASC`,
        join.params
    );

    return rows.map(row => ({
        id: row.id,
        category_name: row.category_name,
        total: Number(row.total) || 0
    }));
}

async function lookups() {
    const [[categories], [statuses], [departments]] = await Promise.all([
        db.query('SELECT id, category_name FROM categories ORDER BY category_name ASC'),
        db.query('SELECT id, status_name FROM statuses ORDER BY id ASC'),
        db.query('SELECT id, department_name FROM departments ORDER BY department_name ASC')
    ]);

    return { categories, statuses, departments };
}

module.exports = {
    PER_PAGE,
    parseFilters,
    listFeedback,
    statusCounts,
    categoryCounts,
    lookups
};
