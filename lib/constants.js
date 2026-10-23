// Roles whose members work inside a department inbox.
const DEPT_ROLES = [
    'administrative_staff',
    'department_head',
    'guidance_staff',
    'it_staff',
    'student_services_staff',
    'faculty'
];

const FEEDBACK_TYPES = ['Feedback', 'Concern', 'Suggestion'];

const ROLE_LABELS = {
    admin: 'Administrator',
    administrative_staff: 'Administrative Staff',
    department_head: 'Department Head',
    guidance_staff: 'Guidance Staff',
    it_staff: 'IT Staff',
    student_services_staff: 'Student Services Staff',
    faculty: 'Faculty',
    institutional_management: 'Institutional Management'
};

// Roles an administrator can give to a new account.
const ASSIGNABLE_ROLES = [
    'administrative_staff',
    'department_head',
    'guidance_staff',
    'it_staff',
    'student_services_staff',
    'faculty',
    'institutional_management'
];

module.exports = { DEPT_ROLES, FEEDBACK_TYPES, ROLE_LABELS, ASSIGNABLE_ROLES };
