-- Rollback of ai_m8.sql (node bin/hams-cli.js migrate:rollback ai_m8.sql). Touches nothing else:
-- its table, the drift job's state and the model pins.
DELETE FROM settings_history WHERE setting_id IN (
  SELECT id FROM settings
   WHERE (group_key = 'ai' AND setting_key LIKE 'pin\_%')
      OR (group_key = 'scheduler_state' AND setting_key = 'ai_drift')
      OR (group_key = 'automation' AND setting_key = 'job_ai_drift'));
DELETE FROM settings
 WHERE (group_key = 'ai' AND setting_key LIKE 'pin\_%')
    OR (group_key = 'scheduler_state' AND setting_key = 'ai_drift')
    OR (group_key = 'automation' AND setting_key = 'job_ai_drift');

DROP TABLE IF EXISTS ai_drift;
