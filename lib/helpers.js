const { ROLE_LABELS } = require('./constants');

function roleLabel(role) {
    return ROLE_LABELS[role] || String(role || '').replace(/_/g, ' ');
}

// "9b5f-485a 7549 2ee0" -> "9B5F485A75492EE0"
function normalizeRef(input) {
    return String(input || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
}

// "9B5F485A75492EE0" -> "9B5F-485A-7549-2EE0"
function formatRef(code) {
    return String(code || '').replace(/(.{4})(?=.)/g, '$1-');
}

function fmtDate(value, withTime = true) {
    if (!value) return '—';

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';

    const options = {
        timeZone: 'Asia/Manila',
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    };

    if (withTime) {
        options.hour = 'numeric';
        options.minute = '2-digit';
    }

    return date.toLocaleString('en-PH', options);
}

// Maps a status name to a CSS class used for its colour.
function statusClass(name) {
    switch (name) {
        case 'Pending': return 'pending';
        case 'Assigned': return 'pending';
        case 'Under Review': return 'review';
        case 'Awaiting Admin Review': return 'review';
        case 'Returned for Further Action': return 'review';
        case 'In Progress': return 'progress';
        case 'Resolved': return 'resolved';
        default: return 'pending';
    }
}

function firstName(fullName) {
    return String(fullName || '').trim().split(/\s+/)[0] || '';
}

function initials(fullName) {
    return String(fullName || '')
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map(part => part[0] || '')
        .join('')
        .toUpperCase() || '?';
}

function parseId(value) {
    return /^\d+$/.test(String(value || '')) ? Number(value) : null;
}

// Only allow redirects back to pages inside this site.
function safeReturn(target, fallback) {
    if (
        typeof target === 'string' &&
        target.startsWith('/') &&
        !target.startsWith('//') &&
        !target.includes('\\')
    ) {
        return target;
    }
    return fallback;
}

module.exports = {
    roleLabel,
    normalizeRef,
    formatRef,
    fmtDate,
    statusClass,
    firstName,
    initials,
    parseId,
    safeReturn
};
