-- Rollback of ai_m2.sql (node bin/hams-cli.js migrate:rollback ai_m2.sql). Touches nothing else.
DROP TABLE IF EXISTS ai_predictions;
DROP TABLE IF EXISTS ai_dq_issues;
DROP TABLE IF EXISTS ai_dq_runs;
