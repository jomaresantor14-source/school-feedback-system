ALTER TABLE feedback_history
ADD COLUMN visible_to_submitter TINYINT(1) NOT NULL DEFAULT 1;
