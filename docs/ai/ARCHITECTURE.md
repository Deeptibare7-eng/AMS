# IT-HAMS AI layer: architecture

Status: **M2 data health + intake** (2026-10-23), on top of M1 foundation (2026-10-22). This file describes
what exists now. Later milestones add the models, agents and orchestrator listed in
[EXISTING_SYSTEM_AUDIT.md](EXISTING_SYSTEM_AUDIT.md) §F. Models and measured results: [MODELS.md](MODELS.md).

## Rules the code follows

- **In-house only.** Every algorithm is our own JavaScript. There is no LLM, no ML library, no API key
  and no network call. Text goes through `adapters/languageProvider.js`, whose only provider is
  `TemplateProvider`, which is offline and deterministic.
- **Off by default.** A capability runs only when three things are true: the `ai_*` tables exist, the
  `ai` module is active (the master switch), and its own switch (settings group `ai`) is `'1'`. With the
  default (all off), the app behaves exactly as before. The smoke test checks this page by page.
- **Recommend, never act.** AI code can read data and write only to `ai_*` tables. A change to real data
  happens only when a person accepts a recommendation. It then runs through the existing service, so
  location scope, validation, stock ledger, audit log and events apply unchanged.
- **Additive and reversible.** The schema lives in `database/ai.sql`. `database/ai.down.sql` removes it
  (`node bin/hams-cli.js migrate:rollback ai.sql`).

## Package layout (`src/ai/`)

| Path | What it does |
|---|---|
| `index.js` | `start()`: registers the event listeners and the `ai_snapshot` scheduler job. No DB work at boot. Called by `src/server.js` and `src/routes/ai.js` (idempotent). |
| `flags.js` | Capability list, `isOn(key)`, master switch, Settings > AI overview. |
| `events.js` | `on(events, capability, handler)`: subscribes to the app's event bus. A handler runs in the background, only while its capability is on, and its errors are logged and swallowed. |
| `features/assetFeatures.js` | The per-asset feature definitions, in SQL (category, model, maker, supplier, location, stock site, status/label, retired + reason, holder, purchase date/cost, warranty end, RAM, OS family, OS end-of-life, deleted) plus a feature hash. |
| `features/snapshots.js` | The snapshot job (see below). |
| `features/liveEvents.js` | Records lifecycle events with their exact time when they happen in the app, and runs a change snapshot 30 s after an import. |
| `governance/approvals.js` | The AI Approvals inbox: `registerHandler`, `propose`, `list`, `decide`. |
| `governance/registry.js` | Model registry: `save`, `activate`, `rollback`, `loadActive`, `list`; M8: pins (`pin`, `unpin`, `pinned`), `autoActivate` (training jobs: not while a version is pinned), `annotate`. |
| `governance/models.js` (M8) | What can be done with each model (purpose, rollback or not and why, retrain, what to refresh after a version change); the Settings > AI > Models overview and actions. |
| `governance/drift.js`, `driftSpecs.js`, `driftCheck.js` (M8) | PSI, KS, profiles and comparison (pure); the features measured per model and their loader (shared with training); the daily check (job `ai_drift`): store, audit, retrain. |
| `governance/feedback.js` (M8) | The feedback loop in numbers for Settings > AI. |
| `models/baseModel.js` | The contract every model implements. |
| `models/naiveBayes.js`, `models/logisticRegression.js` | Multinomial Naive Bayes; softmax logistic regression (hashed TF-IDF, AdaGrad). Both with temperature calibration and explanations. |
| `models/text/` | `tokenize.js` (normalising, words, character n-grams, asset features), `similarity.js` (Levenshtein, Damerau/OSA, Jaro, Jaro-Winkler), `minhash.js` (MinHash + LSH). |
| `intake/` | `classifier.js` (category/manufacturer heads + catalog model matching), `modelMatcher.js` (TF-IDF cosine + Platt scaling), `defaults.js` (warranty/supplier/cost from the same model), `suggest.js` (cached, for the form), `training.js` (train → registry → activate), `data.js` (training rows). |
| `quality/` | `rules.js` (data-health rules and score), `duplicates.js` (FAMS / host name / serial), `categoryCheck.js` (out-of-fold category check), `catalog.js` (spelling variants, model categories, supplier groups), `dataHealth.js` (the scan), `fixes.js` (AI Approvals handlers + proposals), `insights.js` (asset card, dashboard card, Data Health page). |
| `search/` (M3) | `analyzer.js` (one set of text rules for index and query: CTID parts, model numbers, identifiers, units, plurals, stop words), `synonyms.js` (domain dictionary: sites, categories, states, makers, OS), `bm25.js` (`SearchIndex`: BM25F over 15 fields, prefix / typo / synonym expansion, AND with fallback, literal match, overlay for live changes, explanations), `docs.js` (asset documents from the register, change mark), `build.js` (worker task), `service.js` (the index in the web process: build, freshness, search, banner, explanations), `training.js` (nightly rebuild → measure → registry). |
| `features/assetRows.js` (M4) | One read of every asset for refresh risk and anomalies: the M1 feature columns plus names, processor text and the client-provided flag; `ageYears`. |
| `models/weibullRisk.js`, `models/isolationForest.js` (M4) | Current-status Weibull (cloglog IRLS, piecewise shape, sign-constrained covariates, isotonic baseline, Brier/AUC/calibration); Isolation Forest (seeded, counterfactual explanations). |
| `lifecycle/` (M4) | `risk.js` (who is modelled, covariates, training with held-out evaluation in a worker, plain reasons), `run.js` (job ai_lifecycle, asset card, dashboard map). |
| `anomaly/` (M4) | `detect.js` (peer statistics, features, scoring and reasons in a worker, corrupted-copy test), `run.js` (job ai_anomaly, Alerts list grouped and scoped, reviews, asset card). |
| `models/holtWinters.js`, `models/knapsack.js` (M5) | Holt-Winters (damped trend, season form and weights by grid search, 80% band, rolling backtest vs simple rules); 0/1 knapsack (greedy + bucketed dynamic programme that never exceeds the budget). |
| `cost/` (M5) | `forecast.js` (replacement need by quarter from refresh-risk scores × replacement cost per category; PO spend series; spend pace and backtest; money formatting; job ai_cost_forecast), `plan.js` (Refresh Planning: candidates, knapsack, totals, Excel rows, proposal + the sign-off-only approval handler `plan.refresh`). |
| `compliance/rules.js` (M5) | Ten licence / software rules, run on request; dormant (and says so) without licence or software records. |
| `nl/` (M6) | `vocab.js` (categories, makers, model numbers, places with site codes, holders: read from the register, cached 10 min), `entities.js` (rules: dates, RAM, OS, holder, statuses, issues, dictionary matches, typos, change requests; masked text), `seed.js` (seed questions in placeholder form, versioned), `testset.js` (hand-written test questions), `intent.js` (`IntentClassifier`: Naive Bayes vs logistic regression by cross-validation, unknown-word penalty), `query.js` (slots → whitelisted Hardware filters + chips). |
| `agents/` (M6, M7) | `agent.js` (what every agent declares: goal, tool whitelist, input/output, thresholds, escalation), `assistant.js` (AssistantAgent: understand, answer, gate, chips, misses); M7: `intake.js`, `dataQuality.js`, `maintenance.js`, `anomaly.js`, `lifecycleCost.js`, `compliance.js`, `report.js` (one agent per module, each with read-only tools over the services above), `index.js` (the list, for Settings). |
| `orchestrator/` (M7) | `index.js` (event routing with debounce and a rate limit, `run(flow)`, the resolve step, `ask`), `flows.js` (the task graphs), `dag.js` (runner: dependencies, side-by-side steps, timeouts, retries), `blackboard.js` (shared context of a run), `resolve.js` (confidence-weighted conflict resolution), `weights.js` (agents' track records), `handlers.js` (`agents.set_field`, `agents.replace_instead`), `trace.js` (`ai_runs` / `ai_run_steps`). |
| `eval/` | `metrics.js` (accuracy, P/R/F1, top-k, log loss, calibration), `intakeEval.js` (time split), `searchEval.js` (labelled queries generated from the register; old search vs smart search), `riskEval.js` (refresh risk vs baselines and the cross-section; anomalies on corrupted copies + top findings), `costEval.js` (need by quarter, spend backtest, plans at several budgets, compliance status), `nlEval.js` (intent and entity scores on the test set, SQL-safety fuzz), `agentsEval.js` (asset reviews and resolution on the real register, read-only), `run.js` (`hams-cli ai:eval`). |
| `worker.js` | Runs training, the out-of-fold check, the search-index build, refresh-risk training and anomaly scoring in a worker thread. |
| `adapters/languageProvider.js` | `LanguageProvider` interface + `TemplateProvider`. |

All eight milestones are in place. Possible next steps: an LLM adapter behind `adapters/languageProvider.js` (off by default), drift on more models once they are kept between runs, and a depreciation policy for book-value forecasts (Phase 0, Q2).

## How it plugs into the existing app

| Hook | Where | Change |
|---|---|---|
| Event bus | `src/services/automationService.js` | `bus` (EventEmitter) + `publish(event, meta, build)`. `fire()` also publishes; `assetEvent()` passes `{ asset_id, ...extra }` as meta. Automation rules work as before. |
| Import finished | `assetRegisterSync.applySync`, `importExportService.executeImport` | `publish('import.applied', …)`. Bulk imports fire no per-asset events. |
| Maintenance | `operationsService.createMaintenance / updateMaintenance` | `publish('maintenance.logged', { maintenance_id, asset_id, action })` |
| Licences | `inventoryService` (create/update/delete), `inventoryWorkflowService` (assign/return) | `publish('license.changed', { license_id, action })` |
| Scheduler | `schedulerService.register(job)`, optional `job.enabled()` | AI jobs use group `ai` (not shown on the Automations page; shown on Settings > AI). Saving the Automations page skips them. |
| Routes | `src/app.js` → `src/routes/ai.js` | `/settings/ai` (needs `settings.manage`), `/ai/approvals` (needs `ai.view` + module `ai`); M3: `GET /api/ai/search?q=` (Ctrl+K, needs `assets.view`; 404 `{off:true}` while off), `GET /ai/search/open?id=&q=&r=` (records the opened result, redirects to the asset); M4: `GET /api/ai/assets/:id/risk`, `GET /api/ai/lifecycle/summary`, `GET /api/ai/anomalies` (all `assets.view`, scoped), `POST /ai/anomalies/review` (`ai.approve`, scoped; a label only); M5: `GET /api/ai/cost/forecast` (`assets.view`, scoped need), `GET /ai/planning` + `/ai/planning/export` (`assets.view` + `ai.view`, scoped), `POST /ai/planning/propose` (`ai.manage`), `GET /api/ai/compliance` (`licenses.view`, scoped); M6: `GET /api/ai/ask?q=` (`assets.view`, scoped answer; 404 `{off:true}` while off), `POST /ai/ask/miss` ("Not what I meant", CSRF); M7: `GET /ai/runs` + `/ai/runs/:id` (`ai.manage`, scoped traces), `POST /ai/runs/briefing` (`ai.manage`), `POST /ai/assets/:id/review` (`ai.view` + `assets.view`, scoped), `GET /api/ai/assets/:id/agents` (the asset card), `POST /ai/approvals/bulk` (`ai.approve`, each item checked); M8 (all `settings.manage`): `POST /settings/ai/models/:name/retrain`, `/rollback`, `/activate`, `/unpin`, `GET /settings/ai/drift`, `POST /settings/ai/nl/teach` |
| UI | `views/settings/_sidebar.ejs`, `views/layouts/main.ejs` | "AI" settings link; "AI Approvals" sidebar link only while AI is on; "Data Health" link while Data health is on. |
| View locals | `src/middleware/viewLocals.js` | `aiOn`: the set of capabilities that are on (empty while AI is off), for the optional cards. |
| Cards in existing pages (M2) | `views/assets/create.ejs`, `views/assets/show.ejs`, `views/home.ejs` | One `include` each, only when the capability is on: intake suggestions on Register Asset, AI Insights on the asset page, Data health on the dashboard. They load their data after the page, so the page never waits on the AI. |
| Smart search (M3) | `src/services/assetService.js` (`buildFilters`, `fetch`, `exportRows`) | When `filters.search_ids` is given (only smart search sets it), the search condition is `a.id = ANY(ids)` instead of the name / tag / serial `ILIKE`, and the list and export follow the ids' order (read from the ranked list itself). Without it, nothing changes. |
| | `src/routes/assets.js` (Hardware list and Excel export) | `aiSearch.forFilters(filters)`: the ranked ids while Smart search is on and its index is ready, else the old match. Passes `smartSearch` (banner + why per row) to the view. |
| | `views/assets/index.ejs`, `views/layouts/main.ejs` | Wider placeholder, the "Smart search" banner and a match line per row (`ai/_search_banner`, `ai/_search_why`); asset results in the Ctrl+K palette (`ai/_palette_search`), only with the capability on and `assets.view`. |
| Refresh risk + unusual assets (M4) | `views/assets/show.ejs`, `views/home.ejs`, `views/operations/alerts.ejs` | One `include` each, only with the capability on: the "Refresh risk & findings" card (`ai/_asset_risk`), the dashboard map (`ai/_dashboard_lifecycle`, needs `assets.view`) and the "Unusual assets" section on Alerts (`ai/_alerts_anomalies`, needs `assets.view`). They load their data after the page. |
| Cost + compliance (M5) | `views/home.ejs`, `views/operations/alerts.ejs`, `views/layouts/main.ejs` | One `include` each, only with the capability on: the dashboard "Cost forecast" card (`ai/_dashboard_cost`), the "Licence compliance" section on Alerts (`ai/_alerts_compliance`, needs `licenses.view`), and a "Refresh Planning" sidebar link (`ai.view` + `assets.view`) to the new page `ai/planning`. |
| Questions (M6) | `src/services/assetService.js` (`buildFilters`, `listOrder`) | New optional Hardware filters, each a parameter and ignored unless given: `near_site` / `near_location` (a place: Machine Name sites or Asset Locations), `holder`, `warranty_from/to`, `bought_from/to`, `ram_min/max` (from the RAM field), `os` (from the OEM OS field), `ai` (`refresh_high` / `unusual`, from `ai_predictions`), `dq` (an issue code, from `ai_dq_issues`), `sort` (oldest, newest, cost, risk). |
| | `src/routes/assets.js` | `?ask=` redirects to what the question was understood as (a plain search while off). The new keys are validated with the others. `aiAsk.gate()` drops them while Questions is off, and drops an AI set while the capability that makes it is off. Passes `askBanner` (question + removable chips) and adds the question's filters to the sentence above the list. |
| | `views/assets/index.ejs`, `views/layouts/main.ejs` | A Search / Ask switch on the Hardware box and the "You asked" banner (`ai/_ask_banner`); Ask mode in Ctrl+K (`ai/_palette_ask`; the search results step aside while asking). Hidden fields now keep multi-value filters. |
| Agents (M7) | `views/assets/show.ejs`, `views/layouts/main.ejs` | One `include` (`ai/_asset_agents`: the last review, findings, open recommendations, Review now) and an "AI Runs" sidebar link (`ai.manage`), only with Agents working together on. |
| | `src/ai/index.js` | The data-health scan after an import steps aside while the agents are on (their import review runs it). |
| CLI | `bin/hams-cli.js` | `ai.sql`, `ai_m2.sql`, `ai_m7.sql` in the migrate list; `migrate:rollback <file>`; `ai:eval [cutoff|search|lifecycle|anomaly|cost|nl|agents]` (read-only measurement). |
| Seed | `database/seed.sql` | AI permission grants for new databases. |
| Bug fix (M2) | `src/services/assetService.js` `updateAsset` | Keeps the register fields (custom_fields_data) a form doesn't send. The Edit page and the REST API used to wipe them, and with them the stock site. |

Events on the bus: `asset.created`, `asset.updated`, `asset.status_changed`, `asset.deleted`, `asset.checked_out`,
`asset.checked_in`, `user.deactivated`, `request.created`, `request.approved`, `warranty.expiring`, `low_stock`
(all existing), plus the AI-only `import.applied`, `maintenance.logged`, `license.changed`. A listener receives
`{ event, meta, payload() }`. `payload()` builds the full payload once, on demand.

## Data model (`database/ai.sql`)

| Table | Contents |
|---|---|
| `ai_feature_snapshots` | One row per asset per snapshot date, with the feature columns + `feature_hash`. `kind`: `full` (first run of a month) or `change`. No FK to `assets`, so history survives the archive purge. |
| `ai_asset_events` | `retired`, `unretired`, `assigned`, `unassigned`, `status_changed`, `site_changed`, `location_changed`, `deleted`. `precision`: `exact` (seen live) or `snapshot` (happened between `window_start` and `occurred_at`). |
| `ai_models` | Registry: name, version, status (`candidate`/`active`/`retired`), params, metrics, training window. One active version per name. |
| `ai_recommendations` | Inbox: type, agent, target, location/site (for scoping), title, why (plain-language reasons), proposed change, confidence 0–1, status, decision. One open row per `dedupe_key`. |
| `ai_feedback` | One label per decision (`accepted`/`rejected`), with what was predicted and what happened. This is the feedback loop's training data. |
| `modules` row `ai` (off), permissions `ai.view` / `ai.approve` / `ai.manage` | Grants: super/IT admin all three; asset manager and Location SPOC view + approve. |
| `ai_dq_runs` (M2, `ai_m2.sql`) | One row per data-health scan: fleet score, issue counts, by location, by module, catalog findings. Gives the trend. |
| `ai_dq_issues` (M2) | The latest scan's issues: asset, code, severity, confidence, plain-language detail. Replaced on each scan. |
| `ai_predictions` (M2) | The latest per-asset output by capability (`data_quality`: score 0–100, grade, top factors). |
| `ai_runs` (M7, `ai_m7.sql`) | One row per orchestrator run: flow, trigger, target, location (for scoping), user, status (`running`/`done`/`partial`/`failed`), summary, the task graph (nodes, levels, agents left out) and the blackboard at the end (claims, findings, decisions; trimmed). Kept 30 days, longer while a recommendation from it is open. |
| `ai_run_steps` (M7) | One row per step: node, agent, dependencies, status, attempts, the tools called (with time), output (trimmed), error, timing. |
| `ai_recommendations.needs_review` (M7) | True when the agents disagreed or were unsure. |
| `ai_drift` (M8, `ai_m8.sql`) | One row per drift check of a model: version, status, max PSI, per-feature PSI / KS / what moved, when the reference was taken, row counts, what was done (retrain started, pinned, reference recorded). |
| settings `ai.pin_<model>` (M8) | The pinned version of a model, if any. |

M3 adds no table. The search index lives in memory and is rebuilt from the register. Its settings and
measured numbers go into `ai_models` (`search_bm25`). A Ctrl+K result that is opened is kept in
`ai_feedback`: capability `search`, label `accepted`, `predicted = { q, rank }`, target = the asset. These are
real labelled queries for measuring the ranking later.

## Jobs (Settings > AI; not on the Automations page)

| Job | When | Capability |
|---|---|---|
| `ai_snapshot` | daily 01:30, and 30 s after an import | snapshots |
| `ai_dq_scan` | daily 02:00, 90 s after an import (run by the agents' import review while they are on), and the first time Data health is switched on | data_quality |
| `ai_train_intake` | Sundays 03:00, and the first time Intake or Data health is switched on (when no model exists) | intake or data_quality |
| `ai_search_index` | daily 02:30, and the first time Smart search is switched on | search |
| `ai_lifecycle` | daily 03:30 (scores; retrains when the active version is 7+ days old or on Run now), and the first time Refresh risk or Cost forecast is switched on | lifecycle or cost |
| `ai_cost_forecast` | daily 04:30, and after the first scoring when Cost forecast is switched on | cost |
| `ai_anomaly` | daily 04:00, and the first time Unusual assets is switched on | anomaly |
| `ai_agents_review` | daily 05:00 (the briefing; also removes traces older than 30 days), and Run the briefing now | agents |
| `ai_drift` | daily 05:30 (needs `ai_m8.sql`), and Check now | intake, data_quality, lifecycle or cost |

"Run now" on Settings > AI runs the scan and the training in the background; the result appears on the page.

## Smart search (M3)

**The index.**
- It is built in a worker thread (about 2.3 s for 26,736 assets) and copied to the web process as flat
  typed arrays: about 14 MB of postings, about 38 MB of heap in all.
- It is built:
  - when Smart search is switched on;
  - on the first Hardware visit after a restart;
  - nightly;
  - 15 s after an import.
- Until it is ready, searches use the old name / tag / serial match, so a page never waits for it.

**Freshness between builds.**
- Before answering, the service re-reads the assets changed since the last look. It does this at most every
  30 s, or at once after an asset event from the app.
- "Changed" means `updated_at` (set by the table trigger) of the asset or of its holder's user record, with a
  2-minute overlap for long transactions.
- Each changed asset is re-indexed into a small overlay and its old version is marked dead. An asset whose
  content hash hasn't changed is skipped.
- More than 3,000 changes trigger a full rebuild instead.

**A query.**
- Analyse the text: words, CTID parts, units, plurals; stop words dropped.
- Expand each word into exact, synonym, completion and typo forms.
- Score with BM25F. A word and its synonyms share one document frequency.
- Keep the assets that match every word; if none does, keep those matching the most words, and say so.
- Add every asset whose name, tag or serial contains the text literally (the old search).
- Sort by score, newest first on ties.
- The route passes the ranked ids to `assetService`, which applies the user's location scope and every other
  filter in SQL. The list, cards, export and Ctrl+K therefore all agree.

**What it shows.** The banner lists:
- typos read as ("lattitude" read as Latitude);
- synonyms used ("powai" also finds L&T, TX);
- words left out;
- the fallback.

Each row shows a match percentage (the average strength of the best form of each word: exact 1, synonym
0.9, completion 0.5–0.9, typo 0.75 / 0.55) and why, in the register's own spelling.

## Refresh risk and unusual assets (M4)

No new table. Both write their latest per-asset output to `ai_predictions` (capability `lifecycle` /
`anomaly`) and their versions to `ai_models`. Neither changes an asset.

**Refresh risk** (`lifecycle_weibull`). The method and the measured numbers are in MODELS.md §8.
- The job reads every asset once (`features/assetRows.js`). Training runs in a worker on 80% of assets, is
  measured on the other 20% against the baselines, then refitted on everything.
- **Saving a version:** each new version is saved; it is activated unless its held-out Brier score is more
  than 0.005 worse than the active one's. Retraining is weekly; scoring is daily.
- **The asset card** computes from the active version on request, so new and edited assets are covered. The
  dashboard map aggregates `ai_predictions` by Asset Location × age band within the user's location scope.

**Unusual assets** (`anomaly_iforest`). The method is in MODELS.md §9.
- The worker scores all active assets in about 0.4 s and returns the flagged ones with their reasons.
- **Saving a version:** the settings and the corrupted-copy detection are saved as a version only when the
  settings change, as for search.
- **The Alerts section:**
  - lists flagged assets within the user's location scope;
  - groups the same model / holder / reasons;
  - hides an asset already reviewed while its M1 feature hash is unchanged.
- **Real issue / Expected** (`ai.approve`, scoped) writes one `ai_feedback` row per asset and an audit line
  (`AI_ANOMALY_REVIEWED`). These labels give the precision on this register.

## Cost forecast, refresh plan and licence compliance (M5)

No new table, and nothing written outside `ai_*`. The methods and numbers are in MODELS.md §10.

**Cost forecast.**
- **Built from refresh-risk scores.** Since M5, those store cumulative risk at the end of each of the next 8
  quarters (`factors.risk_q`); older rows are interpolated from 6/12/24 months. Scoring also runs when only
  Cost forecast is on, because the job `ai_lifecycle` is enabled for either capability.
- **The forecast** is computed on request from `ai_predictions`, `assets` (replacement costs) and
  `procurement_records` (spend), cached 10 minutes per location scope. Scoring clears the cache.
- **The nightly job** records the spend model (Holt-Winters choice and backtest) as a registry version when
  its choice changes.
- **Users limited to some locations** see their locations' need. Spend history is company-wide (purchase
  orders have no location).

**Refresh Planning** (`/ai/planning`).
- It builds the plan on request (a GET with the budget, horizon and filters, so a plan is a link), within
  the user's location scope.
- **Excel** uses the existing `sendWorkbook`.
- **Send for approval** (`ai.manage`) creates an `ai_recommendations` row of type `plan.refresh`. It has a
  location only when the plan is filtered to one, so a fleet-wide plan is decided by all-location approvers.
- **Accepting** is a sign-off: the handler only returns a summary, and the decision, feedback and audit
  lines are written by the approvals framework. Nothing is purchased or changed.

**Licence compliance.**
- `compliance/rules.js` runs 10 rules on request over `licenses`, `license_assignments`, `software_assets`
  and `users`.
- **Scope:** licences by location for restricted users; software findings (no location column) only for
  users who see every location.
- **Dormant:** while there are no licence or software records it returns `dormant` and the list of checks.

## Questions in plain language (M6)

No new table. It writes only the intent model (`ai_models`, name `nl_intent`) and the questions it couldn't
answer well (`ai_feedback`, capability `nl`, target type `question`). The method and numbers are in
MODELS.md §11.

**The flow** (`agents/assistant.js`, `ask()`):
1. Entities and masked text.
2. Intent and confidence (`understand()`, pure: the evaluation runs exactly this).
3. By intent:
   - **change:** refused, with a link to the asset or page where a person does it;
   - **navigate:** the page;
   - **who:** the asset, within the user's locations;
   - **cost:** the cost forecast;
   - **unknown:** smart search, and the question is kept;
   - **otherwise:** filters → `gate()` → count + five examples → a templated answer, the chips, a link to
     the Hardware list, the confidence and why.

**AssistantAgent** (`agents/agent.js` contract):
- **Goal:** answer questions about the assets in plain language, within the asker's locations.
- **Tools (whitelist, all read-only and existing services):**
  - `count` (`assetService.count` with the location scope);
  - `sample` (`assetService.page`);
  - `asset` (`getAsset`, scoped);
  - `cost` (the forecast);
  - `search` (smart search).

  Free text goes through smart search exactly as the Hardware list does it. A tool not on the list throws.
- **Thresholds:** act at 50%; between 30% and 50% it answers but marks the answer unsure and keeps the
  question; below 30% it lists what was named, or falls back to search.
- **Escalation:** changes are never made here. The answer points to the page (or AI Approvals) where a
  person makes them.

**Model:** trained on the first question (about 0.1 s) and saved to the registry. It is loaded from there
while the seed set's version (`SEED_VERSION`) is unchanged; a new seed version trains a new model version.

**Misses:** fallbacks and unsure answers are recorded as `ignored`, "Not what I meant" as `rejected`.
Settings > AI lists the latest 15 so they can be added to `nl/seed.js`.

## Agents and the orchestrator (M7)

The method and numbers are in MODELS.md §12. The capability "Agents working together" (`agents`) needs
`ai_m7.sql`. Until it is applied, the capability shows "Needs database update" and can't be switched on.

**Agents** (`agents/`, contract `agents/agent.js`):
- One per module, each with a goal, a whitelist of read-only tools over the existing services and the AI
  capabilities above, inputs and outputs, thresholds and escalation (Settings > AI lists them).
- An agent works only while the capability it builds on is on. The others are left out of a run, and the
  trace says why.
- No agent can write. The only way anything changes is a person accepting in AI Approvals, through the
  existing services.

**Flows** (`orchestrator/flows.js`, run by `orchestrator.run(flow, input, { trigger, user })`):

| Flow | Started by | Task graph |
|---|---|---|
| `asset.review` | `asset.created` / `asset.updated` / `asset.status_changed` (3 s after the asset's last change; at most 60 a minute), Review now | intake ∥ quality ∥ unusual ∥ risk → resolve |
| `maintenance.review` | `maintenance.logged` | risk → risk_view ∥ repairs → resolve |
| `licence.review` | `license.changed` | licences |
| `import.review` | `import.applied` (90 s later) | quality_scan → (risk_scores → cost_forecast) ∥ unusual_scan → summaries → briefing |
| `fleet.review` | job `ai_agents_review` (05:00), Run the briefing now | health ∥ risk ∥ cost ∥ unusual ∥ licences → briefing |
| `ask` | Ask in Ctrl+K and on Hardware | assistant |

- **Runner** (`dag.js`):
  - A node runs when its dependencies are done; independent ones run side by side, up to 3.
  - Per-step timeout (20 s; 15 min for scans) and one retry with back-off, except for errors marked not
    retryable and for timeouts.
  - A node whose dependency failed is skipped, unless it is marked to always run (the resolve and briefing
    steps).
- **The existing job runner:** the import review's scans go through `schedulerService.runNow` (the same lock,
  status and Settings > AI row as their nightly jobs), so a scan already running is not run twice.
- **Blackboard** (`blackboard.js`): named results (`risk`, `health`, `briefing`, …), claims, findings,
  decisions, proposals. Stored with the run.
- **Resolve step:**
  - Weighs the claims (`resolve.js`, weights from `weights.js`) and proposes the outcomes in AI Approvals
    (`handlers.js`): `agents.set_field` (category or maker, `assets.edit`, through
    `assetService.updateAsset`) or `agents.replace_instead` (a sign-off that changes nothing).
  - A field already covered by an open recommendation (for example a data-health group fix) is not proposed
    again.
- **Trace** (`trace.js`): every run and every step, including skipped and failed ones. Visible on AI Runs to
  `ai.manage` users, within their locations (runs without a location only to users who see all of them).

**Events:** the orchestrator subscribes through `events.on(..., 'agents', ...)`, so nothing reaches it while
the capability is off. A handler only schedules work and never slows the action that fired the event.

## Snapshots

- **Full run:** the first run in a calendar month writes every asset. **Change run:** any other run writes
  only assets whose feature hash differs from their latest row. A second run on the same day updates that
  day's row, so history has one row per asset per day at most.
- **Events from differences:** comparing an asset's latest row with now yields `snapshot` events. One is
  skipped if the same event was already recorded live (`exact`) since that row was written. The very first
  run is a baseline and records no events.
- **Only an asset's own attributes are stored.** Derived values (age, devices per holder) are computed as
  of a date when needed, so one asset's change never rewrites other assets' rows.
- **OS end-of-life is a dated list** (as of 2026-10: Windows ≤10, Server ≤2012, macOS ≤13, CentOS, Ubuntu
  before 22.04). It is in `features/assetFeatures.js` and must be reviewed as products reach end of support.
- **Measured on this PC with 26,736 synthetic test assets:**
  - A run takes about 4–5 s, as a background job.
  - One full snapshot is about 6 MB, so monthly full copies plus changes come to about 75–100 MB a year.
  - The feature query alone is about 0.5 s on the real register (read-only check).
  - Publishing an event on a user action costs about 0.14 µs.

## Approvals

A recommendation type is registered once, with a handler:

```js
approvals.registerHandler('dq.fix_category', {
  label: 'Fix category', capability: 'data_quality',
  apply: async (rec, user) => { await assetService.updateAsset(rec.target_id, {...}, user); return { ... }; }
});
```

- A handler declares the `permission` the same change needs by hand (`assets.edit`, `inventory.edit`).
  Services don't check permissions (routes do), so `decide()` checks it before applying.
- M2 handlers: `dq.fix_category` (move a group of assets to the category their model and their names agree
  on, through `assetService.updateAsset`) and `catalog.fix_model_category` (fix an Asset Models entry,
  through `catalogService.update`). Keys starting with `_` in `proposed` are for the handler and are not shown.
- `propose()` refuses a recommendation without at least one plain-language reason or with a confidence
  outside 0–1. It returns `null` while the capability is off.
- M7 (`orchestrator/handlers.js`): `agents.set_field` (with `_options` when agents disagree; the approver may pick
  one) and `agents.replace_instead` (sign-off only).
- **Inbox** (`list(user, { view, page, filters })`):
  - Filters: agent (its own recommendations and the orchestrator's it backed), kind, closer look
    (`needs_review`), minimum confidence, Asset Location, text in the title, order.
  - Facets with counts for the menus.
- **Bulk:** `decideMany(ids, ...)` runs `decide` per item (permission, scope and "already decided" each
  time). The page reports what was applied and what was refused.
- **Picking another option:** `decide(..., { choice })` passes the choice to the handler. A choice other than
  the proposed value is recorded as status and label `edited` (`AI_RECOMMENDATION_EDITED`), with the chosen
  option's agents, and updates the agents' weights.
- `decide(id, 'accept'|'reject', user, note)`:
  1. Checks `ai.approve` and scope.
  2. Claims the row (`pending` → `applying`), so it can't be applied twice.
  3. Runs the handler, then marks the row `accepted`. If the handler throws, it marks it `failed`.
  4. Writes `ai_feedback` and an `activity_logs` entry (`AI_RECOMMENDATION_ACCEPTED`/`REJECTED`/`FAILED`).
- Accepting is refused while the capability is off; rejecting is always allowed.
- **Scope** (same rule as the Location Workspace):
  - Super admins see everything.
  - Staff with `assets.view` see their role's location scope (all locations when none is set).
  - Location SPOCs without `assets.view` see only their own sites.

## Governance (M8)

- **The registry:**
  - Every model version keeps its parameters, test numbers and training details. Since M8 that includes the
    profile of the data it learnt from.
  - Training jobs activate a new version with `autoActivate`, only if it scores at least as well **and** no
    version is pinned.
  - A version activated or rolled back to by a person is pinned (`AI_MODEL_PINNED`) until they unpin it.
- **Drift:** the job `ai_drift` runs after the night's jobs. MODELS.md §13 has the method.
- **The feedback loop:**
  - `approvals.propose` holds back a rejected change (same dedupe key and same change).
  - The drift check retrains intake after 20 category decisions.
  - `assistant.teach` adds taught questions to the classifier's training.
  - The agents' weights follow decisions.
- **Audit:**
  - `AI_MODEL_ACTIVATED`, `AI_MODEL_ROLLED_BACK`, `AI_MODEL_PINNED` / `UNPINNED`, `AI_MODEL_KEPT_CANDIDATE`.
  - `AI_RETRAIN_REQUESTED`, `AI_DRIFT_DETECTED`, `AI_NL_TAUGHT`.
  - Together with the recommendation decisions, flag changes and anomaly reviews already logged: every AI
    decision and every human override is in `activity_logs`.

## Model contract

Every model extends `models/baseModel.js`:

- `train`, `predict` (returns `{ value, confidence }`), `explain` (top factors as `{ factor, text, weight }`)
  and `evaluate`.
- `toJSON`/`fromJSON` for persistence.
- `save()`/`load()` through the registry. A saved version starts as `candidate` and is used only once activated.

## Tests

| File | Covers |
|---|---|
| `tests/smoke-pages.test.js` | 67 existing pages and redirects, plus Settings > AI, for a super admin with AI off, on, and on with every capability: same statuses as before the AI layer (recorded from the unmodified code); AI Approvals and Data Health only when on; cards, sidebar links and the Ctrl+K asset results only with their capability; a Hardware search in all three modes. |
| `tests/ai-foundation.test.js` | Unit: template provider, model contract, feature SQL, event bus. DB: off by default (incl. no events captured), switch logic + audit, snapshot baseline/change/events, live events + no double recording, maintenance/licence hooks, approvals (scope, accept/reject/failed, duplicates, capability off, feedback, audit), registry versions/rollback, scheduled job. |
| `tests/ai-migration.test.js` | On a throwaway database: migrate → rollback `ai_m8.sql` → `ai_m7.sql` → `ai_m2.sql` → `ai.sql` → migrate. Each rollback removes exactly what its migration added. |
| `tests/ai-algorithms.test.js` | Edit distances, Jaro/Jaro-Winkler (published values), MinHash/LSH, tokeniser, metrics, Naive Bayes (hand-computed probabilities), logistic regression, temperature scaling. |
| `tests/ai-quality.test.js` | FAMS/host-name parsing, spelling variants (and non-variants), rules and score on a small register, cost outliers, catalog matcher + Platt, intake classifier. |
| `tests/ai-m2.test.js` | Off by default; training + registry; suggestions and defaults; duplicate warnings; scan issues and proposals; asset/dashboard/Data Health pages; accepting fixes through the real services (incl. permission refusal and kept register fields); expiry of stale fixes; switching off. |
| `tests/asset-edit.test.js` | Regression for the Edit-form bug: register fields and stock site survive an edit. |
| `tests/ai-cost.test.js` | Unit: Holt-Winters finds a seasonal pattern and beats the simple rules on it, and calls waves not forecastable; knapsack beats greedy where it should and never exceeds the budget (300 random cases); the need adds up; money formatting. DB: off = no card / page / section; forecast with Cost on and Refresh risk off; scoped need; Refresh Planning (budget, scope, stock option, Excel, proposing needs `ai.manage`, duplicate refused, sign-off changes no asset, audit); cost job and registry; compliance dormant, then all 10 rules on synthetic licences, scoped; Settings; switching off. |
| `tests/ai-risk.test.js` | Unit: cloglog derivatives; a known Weibull shape, scale and effect recovered from current-status data; piecewise shape vs one shape on a refresh step; sign constraint; probability metrics; Isolation Forest constant and planted outliers; the detector's reasons and no false flags on an ordinary fleet; what isn't scored. DB: off = no card/map/section and 404s; training, registry, weekly retrain rule; asset card; dashboard map and its scope; Alerts list, scope, review (label + audit, asset untouched, hidden while unchanged, permission); Settings > AI; switching off. |
| `tests/ai-governance.test.js` | Unit: PSI and KS on known values; profiles (same data stable, shifted significant, new categories named, worst first); the "same change" comparison; the model catalog. DB: rollback, pins, activate, unpin, permissions and audit through Settings; retraining while pinned keeps a candidate; Retrain now; drift stable → significant → retrain → stable again; pinned → not retrained; reference taken for an older version; 20 decisions → retrain; rejected recommendations held back unless changed; feedback numbers (acceptance, real-click MRR, unusual-asset precision, overrides); teaching the question classifier; the drift report and its permissions; checks off with their capabilities. |
| `tests/ai-agents.test.js` | Unit: task graph (order, side-by-side steps, retries, not retrying, timeouts, skipped dependents, always, cycles), blackboard, conflict resolution (agree, alone, weak, disagree, confirm, strong dissent, weights), weights, every agent's contract and tool whitelist, agent logic with stubbed tools (intake, repairs, risk, briefing). DB: off by default; asset reviews (agree → recommend, disagree → closer look with options, confirm → nothing, covered → skipped), task graph and omitted agents in the trace; events (debounce, rate limit, the real update hook); retries and partial runs; inbox filters, facets, scope, picking another option (edited, weights), bulk; repair-or-replace sign-off; licence check; questions traced; daily briefing through the job runner and pruning; import review through the job runner; trace pages, Review now, the asset card, permissions; switching off. |
| `tests/ai-nl.test.js` | Unit (fake vocabulary, fixed today): questions → filters (dates, RAM, OS, holder, L&T, typos, issues, future retirement, missing data); change requests refused, lone tags, unknown; the test set (intent and entities) and the model contract; SQL-safety fuzz; the agent tool whitelist. DB: off = no Ask, `?ask=` is a plain search, question filters ignored; on = count / find / who / how-to answers with why and confidence; change refused and nothing changed; fallback kept; injection harmless; Hardware redirect, banner and removable chips; every new filter, bad values ignored, AI sets gated; location scope; Ctrl+K include, "Not what I meant", Settings misses; model saved once; switching off. |
| `tests/ai-search.test.js` | Unit: analyzer, bounded edit distance, index (identifiers, typos, synonyms, completion, AND, fallback, dropped words, literal match), explanations, live changes, evaluation, saved settings, the eval generator. DB: off = old search; on = ranked list, banner, why, filters kept, export = list; Ctrl+K hits within the user's locations; click labels; changes reach the index without a rebuild; nightly job versions; switching off. |

Database tests use `it_hams_test` (created by `npm run test:db`, schema + seed only). The helper refuses any
database whose name doesn't end in `_test`. It must be required before any `src/` module. `unavailable()`
throws if the connection is to any other database, so a wrong require order fails instead of writing elsewhere.
