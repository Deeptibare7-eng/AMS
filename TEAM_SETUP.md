# IT-AMS — Team Setup (Windows + VS Code)

Follow these steps once. Afterwards you only press **F5** in VS Code to run the app.

Everything is in the repository: the code and the shared database copy (`database-dump/it_hams_v3.sql`).
After these steps you see the same data and pages as the project owner.

## 1. Install the tools (one time)
| Tool | Where | Note |
|---|---|---|
| Node.js 22 LTS (20.19 or newer) | https://nodejs.org | Default options |
| PostgreSQL 16 or newer | https://www.postgresql.org/download/windows/ | Remember the password you set for the `postgres` user |
| Git | https://git-scm.com | Default options |
| VS Code | https://code.visualstudio.com | |

## 2. Get the code
In VS Code: **Ctrl+Shift+P → Git: Clone**, paste the repository URL, and choose a folder. When it asks, open the folder.

## 3. Create your `.env` file
In the project folder, copy `.env.example` to a new file named `.env`. Then change these lines:
```
DB_USER=postgres
DB_PASS=<the postgres password you chose when installing PostgreSQL>
SESSION_SECRET=<any long random text>
```
Leave `DB_NAME=it_hams_v3`, `APP_PORT=3002` and `APP_URL=http://localhost:3002` as they are.

## 4. Install packages and load the database
Open **Terminal → New Terminal** in VS Code (PowerShell) and run:
```powershell
npm install
powershell -ExecutionPolicy Bypass -File tools\restore-database.ps1
```
Loading takes about a minute and ends with `Database 'it_hams_v3' restored: 26736 assets`.
A line such as `invalid command \restrict` or `unrecognized configuration parameter "transaction_timeout"`
near the start is harmless (the copy was made with a newer PostgreSQL).

## 5. Run the app
Press **F5** (Run and Debug → "Run IT-HAMS"). The browser opens at http://localhost:3002.

Log in with the admin email and password shared by the project owner.

## Getting newer data or code later
- **New code or data:** VS Code Source Control → **Pull**, then `npm install`, then run step 4's
  `restore-database.ps1` line again (type `yes` to replace your copy). Restart with **Shift+F5**, then **F5**.

Each person has their own local copy. Changes you make in your app (allocations, imports) are not seen by others.

## Problems?
| Message | Fix |
|---|---|
| `Could not connect to PostgreSQL` | Check `DB_USER` / `DB_PASS` in `.env`, and that the PostgreSQL service is running (Windows Services → postgresql-x64-NN) |
| `Could not create database` | Use `DB_USER=postgres` (it may create databases) |
| `psql.exe not found` | PostgreSQL is not installed in the default folder; reinstall with default options |
| `port 3002 already in use` | The app is already running. Stop it (Shift+F5), or change `APP_PORT` and `APP_URL` in `.env` |
| Page has no styling | Run `npm run build:css`, then refresh |

## For the project owner: refreshing the shared database copy
```powershell
powershell -ExecutionPolicy Bypass -File tools\share-database.ps1
git add database-dump/it_hams_v3.sql
git commit -m "Refresh shared database copy"
git push
```
The copy contains company data (employees, devices). Keep the repository private.
