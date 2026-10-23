ALTER TABLE feedback
    ADD COLUMN IF NOT EXISTS feedback_type
        ENUM('Feedback', 'Concern', 'Suggestion')
        NOT NULL DEFAULT 'Feedback'
        AFTER category_id;
