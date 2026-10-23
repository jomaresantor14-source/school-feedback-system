ALTER TABLE feedback_assignment_history
    ADD COLUMN IF NOT EXISTS remarks TEXT NULL AFTER new_department_id;

INSERT INTO statuses (status_name)
SELECT 'Returned for Further Action'
WHERE NOT EXISTS (
    SELECT 1 FROM statuses WHERE status_name = 'Returned for Further Action'
);
