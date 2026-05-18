# Azure DevOps Time Tracker Extension

A lightweight time tracking extension for Azure DevOps that runs directly in your browser. Log time against work items and generate reports - no backend server required.

## Screenshots

### Time Entry on Work Items
![Time Entry Form](publicimages/reportingtask.png)
*Log hours directly from any work item's "Time Tracking" tab*

### Time Reports Hub
![Time Reports](publicimages/timereport.png)
*View and filter all time entries with summary statistics and CSV export*

## Features

### Time Entry (Work Item Form)
- Log hours spent on any work item (Tasks, Bugs, User Stories, Features, etc.)
- Add date and optional description (max 100 characters)
- View all time entries for the current work item
- Delete your own entries
- Gentle reminder when closing work items without logged time
- **Smart Property Inheritance**: Automatically inherits missing properties from parent work items

### Property Inheritance

When logging time on a Task or Bug, the extension automatically inherits missing properties from the parent hierarchy:

| Property | Inheritance Chain |
|----------|-------------------|
| Tags | Task/Bug → User Story/Feature → Epic |
| Project | Task/Bug → User Story/Feature → Epic |
| Client | Task/Bug → User Story/Feature → Epic |
| Epic | Automatically resolved from hierarchy |

This means you only need to set Tags, Project, and Client on your User Stories or Epics - all child work items will inherit these values automatically.

### My Time (Hub + Dashboard Widget)

A personal landing view for each user — their own hours and active work, not the cross-user reporting in Time Reports.

- **Boards > My Time** hub: hours today / this week / this month, a Mon–Sun week strip (zero-hour weekdays gently flagged), a "What you're working on" table that merges work items assigned to you with anything you've logged time to recently, plus inline **quick-log** (log hours against any of those items without opening the work item), and your 10 most recent entries with delete.
- **My Time dashboard widget** (2×2): hours this week / today and a count of assigned work items with no time logged this week. Clicking it opens the My Time hub.

> **One-time setup for the widget:** Azure DevOps does not let an extension place a widget automatically, and an extension cannot be set as a project's landing page. To surface this on project entry, a project admin adds it once: **Overview > Dashboards > Edit > Add a widget > "My Time"**. After that it shows for everyone viewing that dashboard.

### Weekly Email Summaries

Sends each team member a weekly email with their day-by-day hour breakdown and total. Managers can be CC'd per person.

- Configured via **Boards > Notification Settings** (Project Administrators only)
- Delivered by an Azure DevOps pipeline on a configurable schedule
- Zero-hour days are highlighted; days with no entries show as —
- Users who have never logged hours are not emailed

### Daily Slack Reminders

Sends a **private Slack DM** each weekday morning to anyone on the Notification Settings roster who logged **zero hours** for the previous working day — a gentle daily nudge so management doesn't have to chase people.

- Delivered by an Azure DevOps pipeline (weekdays only; the Monday run checks the prior Friday)
- Users are matched to Slack automatically by email — no extra mapping to maintain
- Private DM only — no public call-outs
- See **Daily Slack Reminders — Setup** below

### Time Reports (Hub)
- Filter by date range, user, epic, project, client, and tags
- Summary cards showing total hours, entries, users, and work items
- Multiple views:
  - **All Entries**: Detailed list with Date, User, Work Item, Parent (User Story/Feature), Epic, Tags, Hours, and Description
  - **By User**: Hours aggregated per team member
  - **By Epic**: Hours aggregated per epic
  - **By Project**: Hours aggregated per project
  - **By Client**: Hours aggregated per client
  - **By Tag**: Hours aggregated per tag
  - **Monthly Report**: Matrix view showing hours per user per User Story - automatically aggregates tasks/bugs under their parent User Story (great for invoicing)
- **Export Options**:
  - **CSV Export**: Export current view data for external processing/invoicing
  - **Backup JSON**: Full backup of all time entries with metadata

## Installation

### Prerequisites
- Node.js and npm installed
- Azure DevOps organization
- Publisher account on [Visual Studio Marketplace](https://marketplace.visualstudio.com/manage/publishers)

### Steps

1. **Install the TFX CLI**
   ```bash
   npm install -g tfx-cli
   ```

2. **Update the manifest**
   
   Edit `vss-extension.json` and replace `YOUR_PUBLISHER_ID` with your actual publisher ID.

3. **Add an icon**
   
   Place a 128x128 PNG icon at `static/icon.png`

4. **Package the extension**
   ```bash
   tfx extension create --manifest-globs vss-extension.json
   ```

5. **Upload to your organization**
   - Go to your Azure DevOps organization settings
   - Navigate to Extensions > Browse marketplace > Manage extensions
   - Upload the generated `.vsix` file
   - Or publish to the marketplace: `tfx extension publish --manifest-globs vss-extension.json`

## Usage

### Logging Time
1. Open any work item (User Story, Bug, Task, etc.)
2. Click on the "Time Tracking" tab
3. Enter hours, select date, add optional description
4. Click "Log Time"

### Viewing Reports
1. Go to Boards > Time Reports
2. Set your date range and filters
3. Switch between different views (All Entries, By User, By Epic, By Tag)
4. Click "Export CSV" to download the data

## Weekly Email Summaries — Setup

The email feature runs as a scheduled Azure DevOps pipeline. It reads time data and notification config directly from the Extension Data service — no extra backend required.

### 1. Configure recipients (Notification Settings)

1. Go to **Boards > Notification Settings** (only visible to Project Administrators)
2. For each user, toggle **Send Email** on or off
3. Add manager email(s) in the **CC** field (comma-separated for multiple)
4. Set the **Send on** day and **At** time (informational — see step 2 for the actual schedule)
5. Click **Save**

### 2. Create the pipeline

The pipeline needs to live in a repository that is hosted in **your** Azure DevOps instance.
Two options depending on where this extension repo is hosted:

**Option A — Extension repo is in your Azure DevOps** (simplest)
1. Go to **Pipelines → New pipeline**
2. Choose **Azure Repos Git** → select this repository
3. Choose **Existing Azure Pipelines YAML file** → `/pipelines/weekly-summary.yml`
4. Click **Save** (do not run yet)

**Option B — Extension repo is hosted elsewhere** (GitHub, different server, etc.)
Use the self-contained single-file version that embeds the script inside the YAML:
1. Create a new empty repository in your Azure DevOps (e.g. `timetracker-pipeline`)
2. Copy **only** `pipelines/weekly-summary-standalone.yml` into it as `pipeline.yml`
3. Go to **Pipelines → New pipeline** → select that new repo → choose the file
4. Click **Save** (do not run yet)

> When the script logic changes in a future extension update, copy the new `weekly-summary-standalone.yml` over and commit. The schedule, variables, and parameters stay the same — only the embedded script changes.

### 3. Set pipeline variables

In the pipeline **Variables** tab, add the following. Mark secrets as **Secret**.

| Variable | Example | Secret |
|----------|---------|--------|
| `AZDO_SERVER_URL` | `http://devops.company.com/DefaultCollection` | |
| `AZDO_PAT` | _(Personal Access Token — `vso.extension.data` scope)_ | ✓ |
| `SMTP_HOST` | `mail-relay.company.com` | |
| `SMTP_FROM` | `timetracker@company.com` | |
| `SMTP_PORT` | `25` _(optional, default 25)_ | |
| `SMTP_SECURE` | `false` _(optional, `true` for TLS)_ | |
| `SMTP_USER` | _(optional, only if SMTP requires auth)_ | |
| `SMTP_PASS` | _(optional)_ | ✓ |

> **Creating the PAT:**
> 1. Go to **User settings → Personal Access Tokens → New Token**
> 2. Click **Show all scopes**, then find **Extensions** and tick **Extension Data → Read**
>    — "Extension Data" is the storage service; "Extensions" (without Data) is for marketplace management and is not needed
> 3. If you cannot find it, select **Full access** as a fallback
> 4. Make sure the selected organization/collection matches your `AZDO_SERVER_URL`
> 5. Copy the generated token into the `AZDO_PAT` pipeline variable and mark it as **Secret**

### 4. Configure the schedule

The send day and time are configured entirely from the **Notification Settings** page — no YAML edits needed. The pipeline runs hourly; the script checks the configured day + time and exits immediately if it is not the right moment.

The settings page shows the time in your **local browser timezone** and displays the equivalent UTC value for reference.

### Testing

Run the pipeline manually (**Run pipeline → Advanced**) with these parameters:

| Parameter | Value |
|-----------|-------|
| `override_week_start` | Any past Monday, e.g. `2026-05-06` |
| `dry_run` | `true` — logs output without sending any emails |

## Daily Slack Reminders — Setup

Like the weekly email, this runs as a scheduled Azure DevOps pipeline that reads time data and the Notification Settings roster directly from the Extension Data service — no extra backend required. It DMs anyone with zero hours for the previous working day.

> **Prerequisite:** the user must exist on the **Boards > Notification Settings** roster, and their Azure DevOps email must match their Slack account email (auto-lookup uses `users.lookupByEmail`). The "Send Email" toggle does **not** affect Slack — the daily reminder considers the whole roster (use `EXCLUDE_EMAILS` to opt someone out).

### 1. Create a Slack app

1. Go to <https://api.slack.com/apps> → **Create New App** → **From scratch**
2. Name it (e.g. *Time Tracker Reminder*) and pick your workspace
3. Open **OAuth & Permissions** → under **Bot Token Scopes** add:
   `chat:write`, `users:read`, `users:read.email`, `im:write`
4. Click **Install to Workspace** and authorize
5. Copy the **Bot User OAuth Token** (`xoxb-…`) — this is `SLACK_BOT_TOKEN`

### 2. Create the pipeline

Same as the weekly summary, but choose **Existing Azure Pipelines YAML file** → `/pipelines/daily-nag.yml`. Click **Save** (do not run yet).

### 3. Set pipeline variables

In the pipeline **Variables** tab, add the following. Mark secrets as **Secret**. (`AZDO_SERVER_URL` / `AZDO_PAT` are the same as the weekly summary — the PAT needs the `vso.extension.data` scope.)

| Variable | Example | Secret |
|----------|---------|--------|
| `AZDO_SERVER_URL` | `http://devops.company.com/DefaultCollection` | |
| `AZDO_PAT` | _(Personal Access Token — `vso.extension.data` scope)_ | ✓ |
| `SLACK_BOT_TOKEN` | `xoxb-…` | ✓ |
| `TIMETRACKER_URL` | `https://devops.company.com/.../_apis/.../My Time` _(optional link in the message)_ | |
| `HOLIDAYS` | `2026-12-25,2026-12-26` _(optional, CSV of non-working days)_ | |
| `EXCLUDE_EMAILS` | `contractor@company.com` _(optional, CSV — never nag these)_ | |

### 4. Configure the schedule

The schedule lives in `pipelines/daily-nag.yml` (`cron: "0 7 * * 1-5"` — **07:00 UTC, Mon–Fri**). Edit the hour to your team's working morning expressed in UTC. No weekend runs; the Monday run automatically targets the previous Friday.

### Testing

Run the pipeline manually (**Run pipeline → Advanced**) with these parameters:

| Parameter | Value |
|-----------|-------|
| `override_target_date` | Any past working day, e.g. `2026-05-15` |
| `dry_run` | `true` — logs who would be DMed without sending anything |

## Optional: Custom Fields for Project/Client Tracking

The extension can optionally use custom fields to track **Project** and **Client** for each time entry. This is useful for agencies or teams working on multiple projects/clients.

### Setting Up Custom Fields (Optional)

If you want project/client tracking:

1. Go to **Organization Settings** > **Process**
2. Select your process (e.g., Agile, Scrum)
3. Click on a work item type (e.g., User Story)
4. Add two new fields:
   - **Name**: `Project` | **Type**: Text | **Reference name**: `Custom.Project`
   - **Name**: `Client` | **Type**: Text | **Reference name**: `Custom.Client`

If these fields don't exist, the extension will still work - entries will simply show "(No Project)" and "(No Client)".

## Data Storage

Time entries are stored using Azure DevOps Extension Data Service with **collection-scoped storage**. This means:
- All time entries are visible to all team members
- The Scrum Master (or anyone) can export all team data
- Data persists across sessions
- Data is tied to your Azure DevOps organization/collection
- Data is partitioned by month for performance

## Limitations

- Hierarchy support works for standard Azure DevOps hierarchy (Epic → Feature → User Story → Task/Bug)
- Property inheritance only applies to new time entries (existing entries won't be retroactively updated)
- Users can only delete their own time entries
- Custom.Project and Custom.Client fields must use exact reference names if you want project/client tracking
- Maximum of 3 levels of hierarchy traversal (work item → parent → grandparent)

## Development

To build the `.vsix` locally:
```bash
# Install dependencies (if adding any)
npm install

# Production package
npm run build

# Dev package
npm run build:dev

# Dev package, auto-incrementing the version
npm run build:dev:inc
```

### Publishing to the Marketplace

Publishing (and sharing with private orgs) is automated through `tfx extension publish`. It is driven by two environment variables so nothing secret or org-specific is committed:

| Variable | What it is |
|----------|------------|
| `TFX_MARKETPLACE_TOKEN` | A Personal Access Token from the **`miguelnicolas`** publisher's Azure DevOps org, scope **Marketplace → Manage**. |
| `TFX_SHARE_WITH` | Space-separated Azure DevOps org slug(s) to share the (private) extension with, e.g. `"contoso fabrikam"`. Omit/unset to publish without sharing. |

```bash
export TFX_MARKETPLACE_TOKEN="xxxxxxxxxxxx"
export TFX_SHARE_WITH="yourorg"            # space-separated for multiple

npm run publish          # production extension, publish + share
npm run publish:dev      # dev (Preview) extension
npm run publish:dev:inc  # dev extension, auto-incrementing the version
```

The `--share-with` flag is only added when `TFX_SHARE_WITH` is set, so the same scripts work for public extensions too (just leave it unset).

## File Structure

```
azdo-timetracker/
├── vss-extension.json           # Extension manifest (production)
├── vss-extension.dev.json       # Extension manifest (development)
├── README.md
├── src/
│   ├── time-entry.html          # Work item form page
│   ├── time-core.js             # Shared storage + entry-inheritance logic
│   ├── my-time.html             # My Time hub — personal hours & quick-log
│   ├── my-time-widget.html      # My Time dashboard widget
│   ├── time-report.html         # Reports hub
│   └── notification-settings.html  # Admin page — email notification config
├── scripts/
│   ├── package.json             # Dependencies for the pipeline scripts
│   ├── send-weekly-summary.js  # Pipeline script — reads config, sends emails
│   └── send-daily-nag.js       # Pipeline script — DMs users missing yesterday's hours
├── pipelines/
│   ├── weekly-summary.yml           # Scheduled pipeline — use when repo is in your DevOps
│   ├── weekly-summary-standalone.yml  # Self-contained version — use when repo is elsewhere
│   └── daily-nag.yml                # Scheduled pipeline — daily Slack missing-hours reminder
└── static/
    └── icon.png                 # Extension icon
```

## License

MIT License - see [LICENSE](LICENSE) file for details.

This software is provided "as is", without warranty of any kind. Use at your own risk.
