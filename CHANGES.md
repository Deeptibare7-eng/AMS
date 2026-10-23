# IT-AMS v2 — bug-fix release

A copy of `IT-AMS-main` with the same screens, features and stack. Only bug fixes
were made. Every file not listed below is byte-for-byte identical to the original.

## Running it

| | Original | v2 |
|---|---|---|
| URL | http://localhost:3000 | http://localhost:3001 |
| Database | `it_hams` | `it_hams_v2` |
| Config | none (code defaults) | `.env` |

```bash
npm install
node bin/hams-cli.js migrate
node bin/hams-cli.js seed
npm start
```

Both apps can run at the same time. Login: `admin@hams.inc` / `password` (change it after first login).

## Security fixes

| Area | Problem | Fix | Files |
|---|---|---|---|
| MFA login | Someone with only the password could replace the victim's 2FA secret through `/login/mfa/setup` and log in | Enrolment only for users with no secret, and only with the secret the server generated | `routes/auth.js` |
| Data Transfer import | `filepath` came from the browser, so any server file could be read or deleted | Only files in the app's temp folder are accepted | `routes/platform.js` |
| Data Transfer users | Export included password hashes and 2FA secrets; import could set `role=super_admin` | Hidden credential columns; role/status/etc. can't be imported; imported users get a random password | `services/dataTransferService.js` |
| Role assignment | Users with "personnel.manage" could make themselves super admin (user edit, LDAP screen, CSV import) | One guard on every path: only super admins grant admin roles; the last super admin can't be demoted | `services/authorizationService.js`, `services/userService.js`, `services/importExportService.js`, `routes/admin.js` |
| Avatar upload | The browser-reported type was trusted, so an `.html` file could be uploaded and run scripts | File content is checked (PNG/JPG only); filename is generated | `routes/auth.js` |
| Procurement upload | HTML/SVG/JS files were served from the site | Those types are refused | `services/procurementService.js` |
| API tokens | A read-only token could create, edit or delete assets and configure monitors; every API call also created a browser login cookie | Each method and path needs its own permission; API calls don't create sessions | `middleware/apiToken.js`, `app.js` |
| Script injection (XSS) | Imported names were written raw into page scripts and `@click` attributes | Data in scripts is escaped (`safeJson`); attribute data is HTML-escaped | `core/helpers.js` + 12 views |
| CSRF | Agent key rotation, heartbeat config and alert resolve had no CSRF check | Token added | `routes/agents-ui.js`, `routes/heartbeat-ui.js`, 2 views |
| Barcode lookup / catalog API | Any employee could see cost, notes and assignee, or create catalog records | Full details only with `assets.view` (or for the asset's own holder); catalog create needs `inventory.create` | `routes/operations.js`, `routes/assets.js` |
| Location scope | Users limited to one site could edit, move or delete assets at other sites | Checked against the asset's current location for edit, delete, checkout, checkin and bulk actions | `services/assetService.js` |
| Password change | `min:8` compared numbers, so `"1234"` passed | `min_length:8` | `routes/auth.js` |
| Logout | Only `user_id` was cleared | The whole session is replaced | `routes/auth.js` |

## Functional fixes

| Problem | Fix | Files |
|---|---|---|
| "Select all" checkboxes did nothing (the JSON broke the HTML attribute) on Assets, Inventory, Stock, Departments and Catalog | Output is escaped correctly | views |
| Heartbeat detail page crashed (`last_check` doesn't exist), errors always showed "✓ OK", and Back/Cancel went to a 404 | Correct column names; links go to the asset | `views/heartbeat/detail.ejs` |
| Agent-reported machines were also pinged, so they flapped DOWN/UP and flooded alerts | Agents are excluded from probing; "agent" kept as a method | `services/heartbeat/heartbeatService.js` |
| Saving one SSO form (SAML) switched off LDAP and OIDC | Only the submitted form's checkboxes are reset | `views/settings/identity.ejs`, `routes/admin.js` |
| Saving backup settings went to a 404 | Redirects to `/settings/backups` | `routes/admin.js` |
| Database restore always failed | Backups use `--clean`; restore runs through `psql` | `services/backupService.js` |
| One bad row in a Data Transfer import silently rolled back the whole import | One savepoint per row | `services/dataTransferService.js` |
| Software import dropped columns (Sr., Ed/Ver, PO #, FAMS No., Market/Client/User Name), and the template's `Qty (0-10)` column was ignored | Header matching handles punctuation and hints; new columns stored | `services/softwareImportService.js` |
| Stock rollback could double-reverse, push stock negative, or undo stock for open assignments | Atomic delete-and-reverse; assignment movements refused | `services/stockMovementService.js` |
| Editing an inventory item could overwrite a concurrent assignment, or set the total below what is assigned | Available quantity computed in SQL; validation added | `services/inventoryService.js` |
| Approved or rejected requests could be reviewed again | Only pending requests can be reviewed | `services/requestService.js` |
| Two new joinees could be drafted the same laptop | Already-drafted laptops are excluded | `services/newJoineeService.js` |
| Asset timeline was sorted by weekday name and matched unrelated IDs (`#1` matched `#12`) | Sorted by date; whole-number ID match | `services/timelineService.js` |
| Re-enrolling an agent or adding an asset with an archived serial gave a raw error | Duplicate checks include archived rows; agents restore their old asset | `services/agentService.js`, `services/assetService.js`, `services/importExportService.js`, `services/userService.js` |
| Concurrent agent enrolments could clash on asset tags; the seed could too | Tag allocation is locked and skips used tags | `services/agentService.js`, `bin/hams-cli.js` |
| Simultaneous price saves gave a 500 | `ON CONFLICT` upsert | `services/licenseBudgetService.js` |
| GET `/login`, OIDC/SAML and LDAP actions could hang or crash the server on a DB error | Errors go to the error page | `routes/auth.js`, `routes/admin.js` |
| MFA and reset-password forms shared one rate-limit bucket per IP, locking out office users | Rate limits are per user/token and cleared on success | `middleware/rateLimit.js`, `routes/auth.js` |
| Asset list page 2 dropped the filters | All filters kept in pagination | `routes/assets.js` |
| Resolving an alert from a form returned raw JSON | JSON only for AJAX callers | `routes/heartbeat-ui.js` |
| `tools/import-synthetic.js` was hard-wired to port 3000 | Uses `APP_URL` from `.env` | `tools/import-synthetic.js` |

## Real asset data (Asset Data .csv)

The demo data was replaced with the company export using `tools/import-asset-data.js`.
Run it again whenever there is a newer export (it replaces the data each time):

```bash
node tools/import-asset-data.js "C:\Users\40211\OneDrive - CitiusTech\Asset Data .csv"
```

| Source column(s) | Where it goes in the app |
|---|---|
| Asset Type = Computing / Network / Servers | Hardware assets (16,735) |
| Asset Type = Accessories | Accessories module, one record per unit (8,903) |
| Employee Name, Email ID, CTID, Work Location | Users (7,136 employees; can't sign in until an admin sets a password) |
| Asset Status = Allocated | Assigned to that employee (8,964 hardware + 4,874 accessories) |
| Asset Location | Asset location (40 locations in total with Work Location) |
| Friendly Name / Manufacturer Name / Model Number / Vendor Name | Category / Manufacturer / Model / Supplier |
| PO #, Invoice No., Purchase Date, Amount | Procurement records (565 real POs), purchase date and cost |
| Warranty End Date | Warranty expiry |
| Remarks | Notes |
| Everything else (processor, RAM, OS, CTID, client, project, GRN, insured…) | Custom fields on the asset's page |

The 44 "Allocated" rows with `#N/A` as the email are stored as unassigned (the employee name is kept on the record).
The 26 duplicate service tags get a `-DUP` suffix (the original is kept on the record).
The database before the import was saved to `storage/backups/before-asset-data-import.sql`.

**Date fix found during this import:** every date showed one day early (for example 15-May-26 showed as
2026-05-14). The driver read dates as midnight India time and the pages formatted them in UTC.
Fixed in one place: `src/core/db.js`.

## Performance (after loading 25k real records)

The server answered in under 0.6 s, but the browser froze: the Users page was a 10 MB, 7,137-row page,
and every page generated its CSS in the browser and fetched its libraries from the internet.

| Change | Why | Files |
|---|---|---|
| Users and Procurement are paged (25 per page) and searchable in SQL | Users went from 10 MB and a 45+ s freeze to 78 KB and 0.8 s | `services/userService.js`, `services/procurementService.js`, `routes/admin.js`, `routes/assets.js`, 2 views |
| Type-to-search picker replaces every "all users / all assets / all items" dropdown | Lists of 7,000–16,000 options were heavy, and several were silently capped at the first 1,000, so most people/assets couldn't be picked | `routes/pickers.js`, `views/components/picker.ejs`, 7 views |
| Tailwind CSS built once (`npm run build:css` → `public/css/app.css`) instead of the in-browser Play CDN | The CDN script regenerated CSS on every page and re-scanned big tables | `tailwind.config.js`, `src/styles/tailwind.css`, layout + login pages |
| Alpine, Lucide and ApexCharts served locally at pinned versions | No internet fetch per click; versions can't change under you (`@latest`) | `app.js`, `package.json` |
| Icons drawn once per page instead of twice | `createIcons()` ran on both DOMContentLoaded and load | `views/layouts/main.ejs` |
| New Joinees only loads laptops/headsets for the joinees' locations | It shipped every in-stock laptop (828 KB) | `services/newJoineeService.js`, `routes/newJoinees.js` |
| Avatars drawn locally (initials SVG) instead of ui-avatars.com | Every page view sent employees' real names to a third-party site; also 25 extra requests per page | `core/helpers.js` (`avatarUrl`), 5 views, CSP |

If you edit a view and add new CSS classes, rebuild the stylesheet: `npm run build:css` (also runs automatically
with `npm start` and the VS Code "Run IT-HAMS" launch).

## Notes

- **Demo data:** this database is filled from synthetic generators (`tools/gen-synthetic.js`)
  and the sample pack. The original demo's own dataset files weren't in the project, so record counts differ.
- **Software sample file:** 476 of the 1,000 rows have a quantity of 100 or 500. The app correctly rejects
  them under its 0–10 rule, so 524 rows import. That is a data issue, not a code bug.
- **Tests:** `npm test` passes 10/10, all 54 pages return 200 after login, and the screens above were checked in a browser.

## New Joinee Excel import

New Joinees → **Import Excel** (needs the `assets.checkout` permission, the same one used by Allocate).

1. Upload `.xlsx` or `.csv` (template: **Download template** in the dialog; its "Valid values" sheet lists
   designations and every location with current laptop/headset stock).
2. Each row creates a pending directory account + new-joinee record. Re-importing updates joinees that are
   not yet allocated; a changed designation or location re-runs the recommendation.
3. Laptop + headset recommendations are drafted immediately (designation rules, joinee's location).
4. The engineer reviews/edits and clicks **Allocate**. That checks out the laptop, assigns the headset, activates
   the account, and writes the assignment, stock ledger and audit rows (visible in Hardware/Accessories).

| Column | Required | Notes |
|---|---|---|
| Employee ID (or CTID, Emp ID, Employee Code) | yes | unique; existing directory employees are skipped |
| Name | yes | |
| Designation | yes | Senior Director, AVP, Consultant, Engineer, Fresher (+ common aliases); others get the Engineer laptop |
| Location (or Work Location, Office) | yes | must match a location name exactly |
| Email | no | placeholder `<id>@pending-email.invalid` until provided |
| Employment Status | no | Employee (default) or Contractor |
| Date of Joining (or DOJ) | no | YYYY-MM-DD, DD-Mon-YYYY, DD/MM/YYYY or an Excel date; default today |

Files: `src/core/spreadsheet.js` (new), `src/services/newJoineeService.js`, `src/routes/newJoinees.js`,
`src/views/new-joinees/index.ejs`, `public/css/app.css` (rebuilt).

## Data replaced with "Asset Data.xlsx" (asset register + Intune)

Backup taken first: `storage/backups/before-asset-register-import-2026-10-04-12-57.sql`.
Loader: `tools/import-asset-register.js` (new; no application code or schema changed).

- Removed: all assets, accessories, assignments, stock ledger, procurement, catalog (models/manufacturers/suppliers/
  asset & accessory categories/locations), import history and employee accounts.
- Kept: admin account, roles, permissions, modules, settings, status labels, audit log, and the 17 New Joinees
  (re-recommended from the new stock).
- Loaded: 27,564 hardware assets + 15,018 accessories; 7,269 employees (CTID; name/email from the previous
  directory 6,745, Intune primary user 403, CTID only 121); 8,997 hardware + 6,813 accessory assignments;
  14,109 retired assets (Retired/Lost/Broken); 785 purchase orders.
- Skipped: 7,186 Intune-only rows (no Asset Type; mostly personal phones). Phone numbers and Wi-Fi IPs not imported.

## New Joinee allocation email + Location SPOCs

- **One Excel, two sheets**: New Joinees → Import Excel accepts a workbook with "New Joinee details" and
  "Location SPOC details" (found by sheet name, or by their columns). SPOC sheet columns: Location, SPOC Name,
  SPOC Email (required), Contact Number. Each location in the sheet has its SPOC list replaced. The template
  includes both sheets (SPOC sheet prefilled with saved SPOCs).
- **Allocation email**: after Allocate, the joinee gets an email (To) listing the laptop model, asset tag,
  serial, headphones (or "will be issued separately") and who to collect from. The location's SPOC(s) are in CC;
  if a location has no SPOC, the engineer who clicked Allocate is CC'd. Sent after the allocation is saved, so a mail
  problem never blocks or undoes an allocation. Every attempt is logged in `email_log` (sent/failed/skipped);
  the page shows the status with **Resend** for failed/skipped.
- **Laptop-only allocation**: Allocate needs a laptop; headphones are allocated when drafted, otherwise later.
- **SMTP**: configure Settings → Notifications (enable email, host, port, encryption, username, password, from),
  then **Send test**. The saved SMTP password is no longer echoed into the page; leave it blank to keep it.
  `SMTP_PASSWORD` in the environment overrides the stored password.
- Re-recommendation only runs when stock for a missing item exists at the joinee's location (no write on every
  page view while headphones are out of stock).
- Fixed: the Allocate confirmation broke for names with an apostrophe.

Files: `database/joinee_notifications.sql` (new: `location_spocs`, `email_log`), `bin/hams-cli.js`,
`src/services/mailService.js` (new), `src/core/spreadsheet.js`, `src/services/newJoineeService.js`,
`src/routes/newJoinees.js`, `src/views/new-joinees/index.ejs`, `src/routes/admin.js`,
`src/views/settings/notifications.ejs`, `package.json` (+ nodemailer 10), `public/css/app.css`.

## New Joinees: Remove

Each not-yet-allocated joinee has a **Remove** button (same permission as Allocate). It deletes the joinee record
and, when it is still the pending account created by the import and holds no assets, that directory account too,
so nothing about the person stays in the database (an audit entry records the removal). Allocated joinees can't be
removed; check their laptop in from Hardware first. Re-importing a file that still contains the person adds them again.
Files: `src/services/newJoineeService.js` (`removeJoinee`), `src/routes/newJoinees.js`, `src/views/new-joinees/index.ejs`.

## New Joinees: email preview

- **Preview** (allocated rows) and **Email** (drafts with a laptop) open the exact allocation email (To, CC with the
  location SPOC(s), subject, body) without sending anything, plus whether it would send now and why not
  (email disabled / SMTP not configured / no employee email).
- The CC fallback for locations without a SPOC is now the engineer who allocated (for allocated joinees) rather than
  whoever is viewing or resending.
Files: `src/services/newJoineeService.js` (`buildAllocationEmail`, `previewAllocationEmail`), `src/routes/newJoinees.js`,
`src/views/new-joinees/index.ejs`.

## Import Data (sync the Asset Data register)

New section **Asset Management → Import Data** (admins with `settings.manage`).
Upload the Asset Data workbook (.xlsx, same columns as before) → **preview** → **Apply changes**.

- Matched by **Service Tag** (duplicate tags by occurrence). Changed fields, status and allocation are updated;
  new assets, accessories, employees (by CTID), locations, categories, manufacturers, models, vendors and
  purchase orders are added. **Nothing is deleted**; records not in the file are left unchanged.
- Allocation changes are written like real check-outs/check-ins (assignment history + stock ledger).
- **Protected allocations**: an allocation or return made in the tool (New Joinee, check-out, check-in) is kept
  until a file shows the same thing (then the record is marked reconciled and the file is in charge again).
- Asset tags never change; Intune-only rows are skipped; runs in one transaction (all-or-nothing) in the
  background with progress; history of imports on the page.
- Verified: the same file again → 0 changes, 1 protected (Bhavika's laptop); a modified file → returns,
  assignments, reassignment to a new employee, retirement, field/location change and a new asset all applied
  correctly (inside a rolled-back transaction).

Files: `src/services/assetRegister.js` (reader), `src/services/assetRegisterSync.js` (preview/apply),
`src/routes/importData.js`, `src/views/import-data/index.ejs`, `src/app.js`, `src/views/layouts/main.ejs`.
The command-line full replace (`tools/import-asset-register.js`) is unchanged.

## Dashboard: device compliance + click-through

- **Device Compliance** (new): donut + breakdown of Intune compliance for active (not retired) hardware, from the
  Asset Data import (`Intune Compliance` detail): Compliant, Noncompliant, In Grace Period, Config Manager,
  Not Evaluated, Not enrolled in Intune; plus "% compliant of enrolled".
- **Everything is clickable**: KPI cards, Deployed/Stock/Repair, every bar/point/slice (acquisition month, category,
  department, lifecycle state, compliance, inventory stock) and audit entries open the matching filtered list.
  Lists opened from the dashboard show **← Back to Dashboard**, "Showing N assets — <filter>" and **Clear filter**.
  Counts on the dashboard equal the counts in the lists they open (verified for every link).
- "Stock" in System Resilience now means deployable stock (In Stock/Ready to Deploy), not total minus assigned
  (which counted 14k retired assets). The acquisition chart uses whole calendar months.
- New Hardware filters (also usable in URLs): `assigned`, `active`, `warranty=expiring`, `repair`, `label_type`,
  `status_label=none`, `created_month`, `category_name`, `department`, `compliance`.
Files: `src/services/platformService.js`, `src/services/assetService.js`, `src/routes/assets.js`,
`src/views/home.ejs`, `src/views/assets/index.ejs`, `src/middleware/viewLocals.js`, `src/views/layouts/main.ejs`.

## Hardware: Assign In-Stock Asset block
- New "Assign In-Stock Asset" block at the top of Hardware (shown to users with `assets.checkout`).
  Pick an in-stock asset and a user from type-to-search dropdowns, add optional notes, click Assign.
- Only unassigned assets with an in-stock status (Available / In Stock / Ready to Deploy) are offered
  (`/api/pick/instock-assets`). Assigning uses the same check-out as the asset page
  (`assetService.checkoutAsset`): status -> Deployed, assignment history, stock ledger and audit log.
- `POST /assets/quick-assign` (CSRF-protected) refuses missing users and already-assigned assets.
Files: `src/routes/pickers.js`, `src/routes/assets.js`, `src/views/assets/index.ejs`.

## Device Compliance from Intune data + Excel export icon
- New `intune_devices` table (migration `database/intune_devices.sql`), loaded from the Intune
  "DevicesWithInventory" export (13,909 devices). Devices are linked to Hardware by serial number.
  Upload a newer export on Import Data > "Intune Device Data"; each import replaces the previous snapshot
  (Hardware, users and allocations are not touched).
- Dashboard "Device Compliance" now uses this data: compliance donut, breakdown with %, compliance by
  platform, and tiles for Noncompliant, no check-in for 30+ days, not encrypted, linked to Hardware,
  computers not in the Hardware register. Every slice/row/bar/tile opens the new Intune Devices list
  (sidebar > Intune Devices) with Back to Dashboard.
- Green Excel icon at the top right of every page. Dashboard, Hardware, Intune Devices and Users download
  all records matching the current filter/drill-down; other pages download the tables shown on screen.
  Cells starting with = + - @ are written as text (no formula injection).
- Hardware export uses a narrow query (~1 s for 27k assets instead of ~10 s).
- Tailwind safelist: status-dot colours and hover borders built in templates.
Files: `database/intune_devices.sql`, `bin/hams-cli.js`, `src/services/intuneService.js`, `src/core/excelExport.js`,
`src/routes/intune.js`, `src/routes/exports.js`, `src/app.js`, `src/routes/assets.js`, `src/routes/admin.js`,
`src/routes/importData.js`, `src/services/platformService.js`, `src/services/assetService.js`,
`src/middleware/viewLocals.js`, `src/views/home.ejs`, `src/views/intune/index.ejs`,
`src/views/import-data/index.ejs`, `src/views/layouts/main.ejs`, `tailwind.config.js`, `public/css/app.css`.

## In-house AI layer, M1: foundation (2026-10-22)

The groundwork for AI features built in-house (no LLM, no API key, everything off by default). Plan and data
audit: `docs/ai/EXISTING_SYSTEM_AUDIT.md`; design: `docs/ai/ARCHITECTURE.md`; operations: `docs/ai/RUNBOOK.md`.

- **Settings > AI** (new): the AI master switch (also "AI Insights" on Feature Modules), one switch per
  capability, snapshot history and last run, model registry, and a link to the inbox. Off by default; with
  AI off every existing page behaves exactly as before (checked page by page against the old code).
- **Feature snapshots & history** (first capability): each night, and 30 s after an import, records every
  asset's AI features (changes only; a full copy on the first run of each month). It also records the
  lifecycle events the register doesn't keep (retired, assigned, unassigned, site/location/status changed,
  deleted), exactly when seen in the app or between two runs after a bulk import.
- **AI Approvals** (`/ai/approvals`, new sidebar entry while AI is on): agents propose, people accept or reject.
  Accepting applies the change through the existing service; every decision goes to the audit log and is
  kept as a training label. Scoped like the Location Workspace (SPOCs see their own sites).
- **Model registry** and the model contract (train / predict / explain / evaluate / save / load / version).
- **Hooks:** the automation event bus also feeds in-process listeners; imports, maintenance and licence
  changes now publish `import.applied`, `maintenance.logged` and `license.changed` (not rule triggers;
  automation rules are unchanged).
- **Migrations:** `database/ai.sql` (additive) and `database/ai.down.sql`; new `node bin/hams-cli.js migrate:rollback <file>`.
  Not yet applied to `it_hams_v3`.
- **Tests:** 10 → 25. New `npm run test:db` creates an empty `it_hams_test` (schema + seed, no company data).
  Added a smoke test of every main page with AI off/on, AI foundation tests, and a migrate/rollback/migrate test.
  `npm test` now runs files one at a time.

Files: `database/ai.sql`, `database/ai.down.sql`, `database/seed.sql`, `bin/hams-cli.js`, `package.json`,
`src/ai/**` (new), `src/routes/ai.js`, `src/views/settings/ai.ejs`, `src/views/ai/approvals.ejs` (new),
`src/app.js`, `src/server.js`, `src/routes/admin.js`, `src/services/automationService.js`,
`src/services/schedulerService.js`, `src/services/assetRegisterSync.js`, `src/services/importExportService.js`,
`src/services/operationsService.js`, `src/services/inventoryService.js`, `src/services/inventoryWorkflowService.js`,
`src/views/layouts/main.ejs`, `src/views/settings/_sidebar.ejs`, `public/css/app.css`, `tools/setup-test-db.js`,
`tests/**`, `docs/ai/**`.

## Fix: editing an asset wiped its register fields (2026-10-23)

Saving an asset from Hardware > Edit, or updating it through the REST API, replaced its register fields
(Machine Name, Processor, RAM, OS, PO #, FAMS, CTID, ...) with nothing, and the stock site derived from
Machine Name became empty. The Edit form never sent those fields. `assetService.updateAsset` now keeps the
fields a form doesn't send and overwrites only the ones it does. No real asset was affected: none had been
edited since the import. Regression test: `tests/asset-edit.test.js`.

## In-house AI layer, M2: data health and intake suggestions (2026-10-23)

Two new capabilities, both off until switched on under Settings > AI. Measured results: `docs/ai/MODELS.md`.

- **Data health.** Each night, and after imports, every active asset is scored 0–100, with each issue in
  plain words:
  - In Stock but returned to client or with a vendor,
  - no or shared FAMS barcode, shared host name, serial duplicated in another spelling,
  - no cost, cost far from similar assets, no supplier or purchase order, no warranty term,
  - category that looks wrong, Machine Name used for notes, duplicate catalog spellings.
  - New **Data Health** page (sidebar) with scores by location and module and the affected assets; an
    **AI Insights** card on each asset page; a **Data health** card on the dashboard.
  - On the real register the average is 83. Top issues: 7,547 not linked to a PO, 6,108 without a cost,
    6,015 without a FAMS barcode, 1,787 "In Stock" but returned to the client.
- **Fixes in AI Approvals.** Moving assets to the right category, proposed only when two independent
  signals agree, and fixing two Asset Models entries filed as VM ("Latitude E5450", "OptiPlex 7010").
  Accepting applies them through the normal asset and catalog services, with the same permission as by
  hand. Fixes that no longer apply expire.
- **Intake suggestions** on Register Asset:
  - category, manufacturer and catalog model from the name and model number (99% correct on assets bought
    since 2024 when trained on older ones), plus that model's usual warranty, supplier and cost;
  - a warning when the serial (written differently), FAMS barcode or host name is already used;
  - nothing is filled in until **Use** is clicked.
- **Algorithms, all in-house:**
  - Naive Bayes and logistic regression with temperature calibration,
  - TF-IDF catalog matching with Platt scaling,
  - Levenshtein / Damerau / Jaro-Winkler, MinHash + LSH.
  - Training runs weekly in a worker thread, through the model registry.
- **CLI:** `node bin/hams-cli.js ai:eval` measures the AI on the current data (read-only).
- **Migration:** `database/ai_m2.sql` (additive: `ai_dq_runs`, `ai_dq_issues`, `ai_predictions`) with
  `ai_m2.down.sql`. Applied to `it_hams_v3` on 2026-10-23 (with `ai.sql`), after a backup, with AI left off.
- **Tests:** 25 → 50 (algorithms, rules, intake, the full M2 flow on the test database, the edit fix, a
  smoke pass with every capability on).

Files: `database/ai_m2.sql`, `database/ai_m2.down.sql`, `bin/hams-cli.js`, `src/ai/**`, `src/routes/ai.js`,
`src/middleware/viewLocals.js`, `src/services/assetService.js`, `src/views/ai/**`, `src/views/settings/ai.ejs`,
`src/views/assets/create.ejs`, `src/views/assets/show.ejs`, `src/views/home.ejs`, `src/views/layouts/main.ejs`,
`public/css/app.css`, `tests/**`, `docs/ai/**`.

## In-house AI layer, M3: smart search (2026-10-23)

A new capability, **Smart search**, off until it is switched on under Settings > AI. When it is off, the search
box works exactly as before.

- **Hardware search box:**
  - finds assets by any detail: tag, serial, host name, FAMS barcode, CTID, model, maker, category, status,
    Asset Location, the site in Machine Name, specs (processor, RAM, OS), supplier, client / project, notes;
  - lists the best matches first;
  - forgives typing mistakes ("lattitude", "lenvo", a swapped serial character);
  - understands synonyms: "lappy" = laptop, "BLR" = Bangalore, "L&T" / "TX" = Powai, "spare" = in stock,
    "win11";
  - completes an unfinished last word.
  - Each extra word narrows the result. Everything the box found before is still found.
  - A banner says what was understood. Each row shows a match percentage and why it matched.
  - The Excel export contains the same assets, in the same order.
- **Ctrl+K** now finds assets: up to 8, with match and why, ↑ ↓ and Enter, and a link to all results.
  Opening one records the query as a search label (`ai_feedback`), for measuring on real searches later.
- **Measured on the real register:**
  - 1,100 labelled queries generated from it: MRR@10 goes from 36.4% (old search) to 97.3%, and queries with
    no result from 62.9% to 0.1%;
  - exact serial, tag, host name and FAMS searches stay at 100%;
  - ranking takes 2.4 ms at p95; the list's database part takes 38 ms at p95.
- **Algorithms, all in-house:** BM25F ranking over 15 weighted fields, a trigram index with bounded
  optimal-string-alignment distance for typos, prefix completion, and a domain synonym dictionary.
- **The index:**
  - built in a worker thread (2.3 s);
  - kept in memory (about 38 MB) and fresh within 30 s of any change;
  - rebuilt nightly (02:30) and after imports;
  - recorded in the model registry with its numbers.
- **Database:** no new table, no migration.
- **CLI:** `node bin/hams-cli.js ai:eval search` (read-only).
- **Hooks in existing code:**
  - `assetService` (an optional ranked id list for the search condition and the order);
  - the Hardware list and export route;
  - `assets/index.ejs`;
  - the Ctrl+K palette in `layouts/main.ejs`.
- **Tests:** 50 → 63. The test helper now refuses to run if a test is connected to any database other than
  the test one.

Files: `src/ai/search/**`, `src/ai/eval/searchEval.js`, `src/ai/eval/run.js`, `src/ai/flags.js`,
`src/ai/index.js`, `src/ai/worker.js`, `src/ai/models/text/similarity.js`, `src/services/assetService.js`,
`src/routes/assets.js`, `src/routes/ai.js`, `src/views/ai/_search_banner.ejs`, `src/views/ai/_search_why.ejs`,
`src/views/ai/_palette_search.ejs`, `src/views/assets/index.ejs`, `src/views/layouts/main.ejs`,
`src/views/settings/ai.ejs`, `bin/hams-cli.js`, `public/css/app.css`, `tests/ai-search.test.js`,
`tests/smoke-pages.test.js`, `tests/helpers/testDb.js`, `docs/ai/**`.

## In-house AI layer, M4: refresh risk and unusual assets (2026-10-23)

Two new capabilities, both off until switched on under Settings > AI. Neither changes an asset.

- **Refresh risk.** For every active laptop, desktop and thin client: the chance of being retired in the
  next 6, 12 and 24 months, with a confidence and the reasons.
  - Shown as a card on asset pages and as a dashboard map of expected retirements by location and age.
  - **The method:** a Weibull model fitted to "current-status" data (the register says *whether* an asset was
    retired, not *when*), with a piecewise shape for the refresh knee. Its covariates describe the machine
    (RAM, a processor too old for Windows 11, warranty term).
  - **On the real register** (20% of assets held out): laptops are predicted as well as the best age curve
    fitted to the data (Brier 0.081, AUC 0.95, calibration error 0.02); a single Weibull shape gets 0.097.
  - About 2,760 retirements are expected in the next 12 months (laptops ~2,190).
  - Thin clients are weak (two purchase batches), and their confidence says so.
- **Unusual assets.** Each night, active assets that look unusual next to the other assets of their model
  (cost, RAM, processor, purchase date, warranty), held by someone with many devices, or 10+ years old and
  still active (Isolation Forest).
  - Listed on Alerts with up to 3 plain reasons each. Repeats are grouped.
  - **Real issue / Expected** buttons record labels (no asset is changed), so the page shows how often the
    detector is right.
  - **On the real register:** 182 of 18,016 active assets flagged; corrupted test copies detected with AUC
    0.90; 23 of the top 30 groups judged worth a look in a review by the developer.
  - **Finding:** many 2022–2026 purchases are filed under 2010-era model names.
- **Algorithms, all in-house:** complementary log-log regression with IRLS (Newton), a pool-adjacent-violators
  isotonic curve as a baseline, and an Isolation Forest with counterfactual explanations.
- **Database:** no new table. Results go to `ai_predictions`, versions to `ai_models`, reviews to
  `ai_feedback`.
- **CLI:** `node bin/hams-cli.js ai:eval lifecycle` and `ai:eval anomaly` (read-only).
- **Hooks in existing code:** one include each in `assets/show.ejs`, `home.ejs` and `operations/alerts.ejs`.
- **Tests:** 63 → 79.

Files: `src/ai/models/weibullRisk.js`, `src/ai/models/isolationForest.js`, `src/ai/features/assetRows.js`,
`src/ai/lifecycle/**`, `src/ai/anomaly/**`, `src/ai/eval/riskEval.js`, `src/ai/eval/run.js`, `src/ai/flags.js`,
`src/ai/index.js`, `src/ai/worker.js`, `src/routes/ai.js`, `src/views/ai/_asset_risk.ejs`,
`src/views/ai/_dashboard_lifecycle.ejs`, `src/views/ai/_alerts_anomalies.ejs`, `src/views/assets/show.ejs`,
`src/views/home.ejs`, `src/views/operations/alerts.ejs`, `src/views/settings/ai.ejs`, `bin/hams-cli.js`,
`public/css/app.css`, `tests/ai-risk.test.js`, `tests/smoke-pages.test.js`, `docs/ai/**`.

## In-house AI layer, M5: cost forecast, refresh plan and licence compliance (2026-10-23)

Two new capabilities, both off until switched on under Settings > AI. Nothing is bought or changed by either.

- **Cost forecast** (dashboard): what replacing the assets expected to be retired will cost, quarter by
  quarter, next to past purchase-order spend.
  - On the real register: about 2,760 replacements, **≈ ₹ (figure kept out of the public copy) in the next 12 months**, against a past pace
    of ≈ ₹ (figure kept out of the public copy) a year. The large 2021–22 laptop batches are reaching refresh age.
  - **Spend timing is not forecastable from its own history:** Holt-Winters and three simple rules were all
    off by more than an average quarter in a 2023–2026 backtest, because spend comes in waves. The card says
    so and shows the need as the figure to plan with.
- **Refresh Planning** (new page):
  - Enter a budget and horizon; the AI picks which in-use assets to replace first (0/1 knapsack on the chance
    of retirement per rupee), each with why.
  - Excel export; sign-off through AI Approvals (accepting records the decision only).
  - On the real register, ₹ (figure kept out of the public copy) covers 57% of the expected retirements of in-use laptops, desktops and thin
    clients within 12 months.
- **Licence compliance** (Alerts): 10 rules (over-allocation, expired but assigned, renewals due, leavers'
  seats, unused seats, duplicate keys, …). **Dormant:** the register has no licence or software records yet;
  it starts on its own when they arrive. Tested on synthetic licences.
- **Algorithms, all in-house:**
  - Holt-Winters exponential smoothing (damped trend, grid-searched weights, rolling backtest);
  - 0/1 knapsack (greedy + dynamic programme that never exceeds the budget);
  - replacement need from the refresh-risk curves.
- **Not done:** the book-value forecast. There is no depreciation policy (Phase 0, Q2); the existing
  calculation is unchanged.
- **Database:** no new table. Refresh-risk scores now also keep quarterly risk points.
- **CLI:** `node bin/hams-cli.js ai:eval cost` (read-only).
- **Hooks in existing code:** one include each in `home.ejs` and `operations/alerts.ejs`, and a sidebar link
  in `layouts/main.ejs`.
- **Tests:** 79 → 90.

Files: `src/ai/models/holtWinters.js`, `src/ai/models/knapsack.js`, `src/ai/cost/**`, `src/ai/compliance/**`,
`src/ai/eval/costEval.js`, `src/ai/eval/run.js`, `src/ai/lifecycle/run.js`, `src/ai/flags.js`, `src/ai/index.js`,
`src/routes/ai.js`, `src/views/ai/_dashboard_cost.ejs`, `src/views/ai/planning.ejs`, `src/views/ai/_alerts_compliance.ejs`,
`src/views/home.ejs`, `src/views/operations/alerts.ejs`, `src/views/layouts/main.ejs`, `bin/hams-cli.js`,
`public/css/app.css`, `tests/ai-cost.test.js`, `tests/smoke-pages.test.js`, `docs/ai/**`.
