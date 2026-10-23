# IT-HAMS AI layer: runbook

For admins running the app. Background: [ARCHITECTURE.md](ARCHITECTURE.md).

## Install the AI tables

```bash
node bin/hams-cli.js migrate
```

`ai.sql` (M1) and `ai_m2.sql` (M2) add only new `ai_*` tables, an `ai` module (switched off) and three
permissions (`ai.view`, `ai.approve`, `ai.manage`). No existing table or row changes. **Take a backup
first** (Settings > Backup & Restore) on a database with real data. Until this has run, Settings > AI says
"AI tables are not installed" and nothing AI-related runs.

## Undo (rollback)

Roll back the newest migration first:

```bash
node bin/hams-cli.js migrate:rollback ai_m2.sql   # data-health tables
node bin/hams-cli.js migrate:rollback ai.sql      # everything else AI
```

Each runs its `database/<name>.down.sql` in one transaction and deletes its `migrations` row.
- `ai_m2.sql` drops the data-health runs, issues and per-asset scores.
- `ai.sql` drops the snapshots, events, recommendations, feedback and models, and removes the module,
  permissions, grants and AI settings.

Everything else stays as it was. The AI history is lost, so take a backup first if you want to keep it.

## Switch AI on or off

Settings > **AI** (needs `settings.manage`):

1. **AI master switch.** Off means nothing AI-related runs and AI Approvals is hidden. The same switch
   appears as "AI Insights" on Settings > Feature Modules.
2. **Each capability's own switch.** It takes effect only while the master switch is on:
   - **Feature snapshots & history** (M1)
   - **Data health** (M2): the nightly scan, Data Health page, asset-page and dashboard cards, and category
     fixes in AI Approvals
   - **Intake suggestions** (M2): suggestions and duplicate warnings on Register Asset
   - **Smart search** (M3): ranked, typo-tolerant search with synonyms on Hardware and in Ctrl+K
   - **Refresh risk** (M4): chance of retirement in 6/12/24 months on asset pages, and a dashboard map
   - **Unusual assets** (M4): findings on Alerts, reviewed as real issue or expected
   - **Cost forecast & refresh plan** (M5): replacement cost forecast on the dashboard, and Refresh Planning
   - **Licence compliance** (M5): licence and software checks on Alerts (dormant until licence data exists)

   The first time Intake or Data health is switched on, the intake model is trained and a first scan runs,
   in the background (about a minute on ~27,000 assets). The first time Smart search is switched on, its index
   is built (a few seconds). The result appears on Settings > AI.

Every switch change is written to the audit log (`AI_FLAG_CHANGED`, `AI_MASTER_SWITCHED`).

## Feature snapshots

- **When it runs:**
  - daily at 01:30, while the capability is on (Asia/Kolkata unless Settings > Automations sets another
    time zone),
  - 30 s after an Import Data / Import Center import,
  - when you press **Run snapshot now** on Settings > AI.
- **The first run is the baseline:** every asset is recorded, and no lifecycle events. From the second
  run on, changes appear as events (retired, assigned, site changed, …).
- **Check a run:** the last run (time, rows written, events, duration, errors) shows on Settings > AI.
  Log lines are `[Scheduler] ai_snapshot …` and `[AI] …` in `storage/logs/hams.log`.
- **Cost:** about 4–5 s per run for ~27,000 assets, in the background. Storage is about 6 MB per monthly
  full copy plus the changed rows.
- **To stop it:** switch the capability off. Rows already recorded stay until rollback.

## AI Approvals

- **Where:** sidebar > AI Approvals (`/ai/approvals`). It is visible only while AI is on and you have `ai.view`.
- **Who can decide (`ai.approve`):** super admins and IT admins everywhere; asset managers within their
  role's locations; Location SPOCs for their own sites.
- **Accept** applies the proposed change through the normal screens' rules. **Reject** records the
  decision as a training label. Every decision is in the audit log. A recommendation whose change can no
  longer be applied is marked **failed**, with the reason.
- **What arrives there (M2, from the data-health scan):**
  - "Move N assets of model X at location Y from category A to B", proposed only when the model's other
    assets and the category classifier agree;
  - "Change catalog model X from category A to B".
- **Accepting needs** the same permission as doing it by hand: `assets.edit`, or `inventory.edit` for the
  catalog.
- **A fix that no longer applies** is marked **expired** at the next scan.

## Data health

- **Where:** sidebar > Data Health (`/ai/data-health`, needs `assets.view` and `ai.view`).
  - The scores, the issues with their counts (click one to see the assets and why), scores by location
    and by module, and catalog findings.
  - Users limited to some locations see only those. Module and catalog figures are for users who see all
    locations.
- **When the scan runs:** daily at 02:00, 90 s after an import, or **Run now** on Settings > AI or on the page.
- **Cost:** about 6–8 s for ~18,000 active assets, with the heavy part in a background thread.
- **What scores mean:** 100 minus 30 per high issue, 15 per medium and 5 per low (times the confidence).
  Good is 90+, Fair 70–89, Poor below 70. Retired assets aren't scored. The rules are in
  [MODELS.md](MODELS.md) §6.

## Intake suggestions

- **On Register Asset**, once a name or model number is typed:
  - suggestions for category, manufacturer, catalog model, warranty term, supplier and cost, each with a
    confidence and a reason;
  - a warning when the serial (written differently), FAMS barcode or host name is already on another asset.
- **Nothing is filled in** until **Use** is clicked.
- **Retraining** happens on Sundays at 03:00, or with **Run now** on "Train intake model". A new version
  replaces the active one only if it scores at least as well on held-out data.

## Smart search

- **Where:** the Hardware search box and Ctrl+K, while Smart search is on.
- **What it finds:** any detail of an asset, not only its name, tag or serial: host name, FAMS barcode, CTID,
  model, maker, category, status, location (Asset Location and the site in Machine Name), Machine Name, specs
  (processor, RAM, OS), supplier, client / project, notes and order numbers.
- **It forgives:**
  - typing mistakes ("lattitude", "lenvo", a swapped serial character);
  - synonyms ("lappy" = laptop, "BLR" = Bangalore, "L&T" / "TX" = Powai, "spare" = in stock, "win11");
  - an unfinished last word ("lati…").
- **More words narrow the result.** If no asset has all of them, the closest are shown and the page says so.
  A word no asset has is left out, with a note.
- **Nothing is lost:** anything the box found before (name, tag or serial containing the text) is still found.
- **The banner** above the list says what the search understood. Each row shows a match percentage and why it
  matched.
- **Ctrl+K** shows up to 8 assets (↑ ↓ to pick, Enter to open), plus a link to all results in Hardware.
- **Location scope:** users limited to some locations only see assets there, as on the Hardware list. The
  Excel export contains the same assets as the list.
- **The index:**
  - It is kept in memory and rebuilt nightly at 02:30 (job "Rebuild search index"), 15 s after an import,
    or with **Run now**.
  - Edits made in the app show up within seconds; other changes within 30 s.
  - The card on Settings > AI shows its size and when it was built.
  - Until it is ready (right after a restart), the box works the old way.
- **Measured on this database** (read-only):

  ```bash
  node bin/hams-cli.js ai:eval search
  ```

## Refresh risk

- **Where:**
  - a "Refresh risk & findings" card on each asset page;
  - "Refresh risk: next 12 months" on the dashboard: expected retirements by Asset Location and age; hover a
    cell for details.
- **What it says:**
  - the chance the asset is retired in the next 6, 12 and 24 months (low under 20%, medium 20–50%, high 50%+);
  - a confidence;
  - the reasons: its age against the age by which half of its category is retired, and machine traits such
    as 8 GB RAM.
  - It is an estimate learnt from which assets of each age have been retired. The register has no retirement
    dates. **Nothing is changed and nothing is ordered.**
- **Not scored:**
  - retired assets;
  - client-provided assets (replacing them is up to the client);
  - categories with too little history (VMs).
- **When it runs:** daily at 03:30 (job "Refresh risk scores"), and once when switched on. The curves are
  retrained weekly or with **Run now**. A retrained version replaces the active one only if it predicts
  held-out assets about as well.
- **Users limited to some locations** see their locations only.
- **Measured on this database** (read-only): `node bin/hams-cli.js ai:eval lifecycle`.

## Unusual assets

- **Where:** an "Unusual assets" section at the top of Alerts. A flagged asset also shows it on its page.
- **What it lists:**
  - active assets that look unusual next to the other assets of their model (cost, RAM, processor, purchase
    date, warranty), held by someone with many devices, or 10+ years old and still active;
  - each finding with up to 3 plain reasons;
  - the same finding repeated over several assets (for example one holder's 17 VMs) as one group.
- **Review** (needs `ai.approve`, within your locations): **Real issue** or **Expected**.
  - This only records your answer and an audit line. **The asset is not changed**; fix it on its page if
    needed.
  - A reviewed finding stays hidden until the asset changes.
  - The section shows how many reviewed findings were real, which measures the detector.
- **When it runs:** daily at 04:00 (job "Find unusual assets"), and once when switched on.
- **Measured on this database** (read-only): `node bin/hams-cli.js ai:eval anomaly`.

## Cost forecast and Refresh Planning

- **Dashboard, "Cost forecast":**
  - what replacing the assets expected to be retired will cost in the next 12 and 24 months, quarter by
    quarter (dashed bars);
  - past purchase-order spend (solid bars) and its long-run pace;
  - hover a bar for its amount.
  - On this register past spend comes in waves and can't be forecast quarter by quarter (the card says so),
    so plan from the need.
- **Refresh Planning** (sidebar):
  - Enter a budget, horizon, location and category. Replacement costs are pre-filled with recent medians,
    with their basis; change them if you know better.
  - The AI picks which in-use assets to replace first (spare stock is optional and counts half), each with
    why.
  - **Excel** exports the whole plan. **Send for approval** (needs `ai.manage`) puts it in AI Approvals.
    Accepting records the sign-off. **Nothing is ever bought or changed.**
- **Needs refresh-risk scores.** They are computed nightly (03:30) even if Refresh risk itself is off, and
  once when Cost forecast is switched on.
- **The forecast job** (04:30) refreshes the figures and records the spend model in Settings > AI > Models.
- **Measured on this database** (read-only): `node bin/hams-cli.js ai:eval cost`.

## Licence compliance

- **Where:** a "Licence compliance" section on Alerts (needs `licenses.view`).
- **What it checks (10 rules):**
  - seats in use above seats bought;
  - expired or terminated licences still assigned;
  - ended subscriptions still allocated;
  - licences in use expiring within 60 days;
  - renewals within 30 days;
  - seats held by suspended or archived users, or by retired assets;
  - duplicate licence keys;
  - software allocated to leavers;
  - many unused seats (with their value);
  - available seats that don't add up.
- **Today there are no licence or software records,** so the section says it is waiting for data. It starts
  checking on its own once licences are added or software is imported.
- **Nothing is changed.** Each finding links to the licence's history page.

## Models

- **Where:** Settings > AI > Models lists every trained version (status, when, and its test numbers: held-out
  accuracy and macro-F1 for the intake model, MRR@10 and time to rank for smart search).
- **Rolling back** a model version (registry `rollback`) has no button yet; M8 adds activate and rollback
  buttons.
- **To measure the AI on the current data** (read-only, prints a report):

  ```bash
  node bin/hams-cli.js ai:eval            # time split at 2024-01-01
  ```

## Tests

```bash
npm run test:db          # once: creates the empty test database it_hams_test (schema + seed, no company data)
npm run test:db -- --reset   # after a schema change: drop and recreate it
npm test                 # all tests (heartbeat + smoke pages + AI); database tests skip if it_hams_test is missing
```

The test database is on the same PostgreSQL server and login as `.env`. The tests refuse any database
name that doesn't end in `_test`, so they never touch `it_hams_v3`. The rollback test creates and drops its
own `it_hams_migration_test`.
