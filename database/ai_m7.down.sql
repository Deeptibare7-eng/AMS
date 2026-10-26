-- Rollback of ai_m7.sql (node bin/hams-cli.js migrate:rollback ai_m7.sql). Touches nothing else:
-- its two tables, its column, and the settings of its capability and job.
DELETE FROM settings_history WHERE setting_id IN (
  SELECT id FROM settings
   WHERE (group_key = 'ai' AND setting_key = 'agents')
      OR (group_key = 'scheduler_state' AND setting_key = 'ai_agents_review')
      OR (group_key = 'automation' AND setting_key = 'job_ai_agents_review'));
DELETE FROM settings
 WHERE (group_key = 'ai' AND setting_key = 'agents')
    OR (group_key = 'scheduler_state' AND setting_key = 'ai_agents_review')
    OR (group_key = 'automation' AND setting_key = 'job_ai_agents_review');

DROP INDEX IF EXISTS idx_ai_rec_run;
ALTER TABLE ai_recommendations DROP COLUMN IF EXISTS needs_review;
DROP TABLE IF EXISTS ai_run_steps;
DROP TABLE IF EXISTS ai_runs;
