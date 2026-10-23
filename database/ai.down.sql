-- Rollback of ai.sql (run by: node bin/hams-cli.js migrate:rollback ai.sql).
-- Removes everything ai.sql added and the AI settings; no other table or row is touched.

DELETE FROM role_permissions WHERE permission_id IN (SELECT id FROM permissions WHERE module = 'ai');
DELETE FROM permissions WHERE module = 'ai';
DELETE FROM modules WHERE name = 'ai';

DELETE FROM settings_history WHERE setting_id IN (
  SELECT id FROM settings
   WHERE group_key = 'ai'
      OR (group_key = 'scheduler_state' AND setting_key LIKE 'ai\_%')
      OR (group_key = 'automation' AND setting_key LIKE 'job\_ai\_%'));
DELETE FROM settings
 WHERE group_key = 'ai'
    OR (group_key = 'scheduler_state' AND setting_key LIKE 'ai\_%')
    OR (group_key = 'automation' AND setting_key LIKE 'job\_ai\_%');

DROP TABLE IF EXISTS ai_feedback;
DROP TABLE IF EXISTS ai_recommendations;
DROP TABLE IF EXISTS ai_models;
DROP TABLE IF EXISTS ai_asset_events;
DROP TABLE IF EXISTS ai_feature_snapshots;
