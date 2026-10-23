const db = require('../config/db');
const { normalizeRef } = require('./helpers');
const { FEEDBACK_TYPES } = require('./constants');

const PER_PAGE = 15;

function positiveInt(value) {
    return /^\d+$/.test(String(value || '')) && Number(value) > 0
        ? Number(value)
        : null;
}

function validDate(value) {
    const date = String(value || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '';
    const parsed = new Date(`${date}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date
        ? date
        : '';
}

// Reads search/filter values from the URL query string.
function parseFilters(query = {}) {
    const q = String(query.q || '').trim().slice(0, 100);
    const rawDept = String(query.department || '');
    const requestedStatusName = String(query.status_name || '').trim().slice(0, 50);
    const statusName = /^all statuses$/i.test(requestedStatusName)
        ? ''
        : requestedStatusName;
    const requestedType = String(query.feedback_type || '');

    return {
        q,
        statusId: positiveInt(query.status),
        statusName,
        feedbackType: FEEDBACK_TYPES.includes(requestedType) ? requestedType : '',
        categoryId: positiveInt(query.category),
        dateFrom: validDate(query.date_from),
        dateTo: validDate(query.date_to),
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
    } else if (options.statusName) {
        clauses.push(
            'EXISTS (SELECT 1 FROM statuses status_filter WHERE status_filter.id = f.status_id AND status_filter.status_name = ?)'
        );
        params.push(options.statusName);
    }

    if (options.scopeStatusName) {
        clauses.push(
            'EXISTS (SELECT 1 FROM statuses scope_status WHERE scope_status.id = f.status_id AND scope_status.status_name = ?)'
        );
        params.push(options.scopeStatusName);
    }

    if (options.scopeUnassigned) {
        clauses.push('f.assigned_department_id IS NULL');
    }

    if (options.requireAssignedDepartment) {
        clauses.push('f.assigned_department_id IS NOT NULL');
    }

    if (options.excludeStatusNames && options.excludeStatusNames.length) {
        const placeholders = options.excludeStatusNames.map(() => '?').join(', ');
        clauses.push(
            `NOT EXISTS (
                SELECT 1 FROM statuses excluded_status
                WHERE excluded_status.id = f.status_id
                  AND excluded_status.status_name IN (${placeholders})
            )`
        );
        params.push(...options.excludeStatusNames);
    }

    if (options.categoryId) {
        clauses.push('f.category_id = ?');
        params.push(options.categoryId);
    }

    if (options.feedbackType) {
        clauses.push('f.feedback_type = ?');
        params.push(options.feedbackType);
    }

    if (options.dateFrom) {
        clauses.push('f.created_at >= ?');
        params.push(options.dateFrom);
    }

    if (options.dateTo) {
        clauses.push('f.created_at < DATE_ADD(?, INTERVAL 1 DAY)');
        params.push(options.dateTo);
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
            f.description,
            f.feedback_type,
            f.created_at,
            f.is_anonymous,
            f.assigned_department_id,
            (
                SELECT ah.changed_at
                FROM feedback_assignment_history ah
                WHERE ah.feedback_id = f.id
                  AND ah.new_department_id = f.assigned_department_id
                ORDER BY ah.changed_at DESC, ah.id DESC
                LIMIT 1
            ) AS assigned_at,
            c.category_name,
            s.status_name,
            d.department_name,
            CASE
                WHEN f.is_anonymous = 1 THEN NULL
                ELSE COALESCE(NULLIF(f.submitter_name, ''), submitter.full_name)
            END AS submitter_name,
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
                JOIN users note_author
                  ON note_author.id = fh.changed_by
                 AND note_author.department_id = f.assigned_department_id
                WHERE fh.feedback_id = f.id
                  AND fh.remarks IS NOT NULL
                  AND TRIM(fh.remarks) != ''
                ORDER BY fh.changed_at DESC, fh.id DESC
                LIMIT 1
            ) AS latest_remarks,
            (
                SELECT MAX(fh.changed_at)
                FROM feedback_history fh
                JOIN statuses forwarded_status ON forwarded_status.id = fh.new_status_id
                WHERE fh.feedback_id = f.id
                  AND forwarded_status.status_name = 'Awaiting Admin Review'
            ) AS date_forwarded,
            (
                SELECT fh.remarks
                FROM feedback_history fh
                JOIN users resolution_author
                  ON resolution_author.id = fh.changed_by
                 AND resolution_author.role = 'admin'
                JOIN statuses resolved_status
                  ON resolved_status.id = fh.new_status_id
                 AND resolved_status.status_name = 'Resolved'
                WHERE fh.feedback_id = f.id
                  AND fh.new_status_id = f.status_id
                  AND fh.remarks IS NOT NULL
                  AND TRIM(fh.remarks) != ''
                ORDER BY fh.changed_at DESC, fh.id DESC
                LIMIT 1
            ) AS admin_response
        FROM feedback f
        JOIN categories c ON f.category_id = c.id
        JOIN statuses s ON f.status_id = s.id
        LEFT JOIN departments d ON f.assigned_department_id = d.id
        LEFT JOIN users submitter ON submitter.id = f.submitted_by
        ${where.sql}
        ORDER BY f.created_at DESC, f.id DESC
        LIMIT ? OFFSET ?`,
        [...where.params, perPage, (page - 1) * perPage]
    );

    return { rows, total, page, pages, perPage };
}

async function feedbackTypeStatusCounts(departmentId) {
    const [rows] = await db.query(
        `SELECT f.feedback_type, s.status_name, COUNT(*) AS total
         FROM feedback f
         JOIN statuses s ON s.id = f.status_id
         WHERE f.assigned_department_id = ?
         GROUP BY f.feedback_type, s.status_name`,
        [departmentId]
    );

    return rows.map(row => ({
        feedback_type: row.feedback_type,
        status_name: row.status_name,
        total: Number(row.total) || 0
    }));
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
    feedbackTypeStatusCounts,
    categoryCounts,
    lookups
};
