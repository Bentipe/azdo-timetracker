'use strict';

/**
 * Weekly hour summary mailer for Azure DevOps Time Tracker.
 *
 * Reads notification config and time entries from the Azure DevOps Extension
 * Data REST API, then sends one HTML email per enabled user via SMTP.
 *
 * Required environment variables:
 *   AZDO_SERVER_URL   e.g. http://devops.company.com/DefaultCollection
 *   AZDO_PAT          Personal Access Token (needs vso.extension.data scope)
 *   SMTP_HOST         SMTP relay hostname
 *   SMTP_FROM         From address, e.g. timetracker@company.com
 *
 * Optional environment variables:
 *   AZDO_PUBLISHER    Extension publisher  (default: miguelnicolas)
 *   AZDO_EXTENSION_ID Extension id        (default: timetracker-extension)
 *   SMTP_PORT         SMTP port            (default: 25)
 *   SMTP_SECURE       true for TLS         (default: false)
 *   SMTP_USER         SMTP auth username   (default: none)
 *   SMTP_PASS         SMTP auth password   (default: none)
 *   DRY_RUN           true = log only, no emails sent (default: false)
 */

const https     = require('https');
const http      = require('http');
const nodemailer = require('nodemailer');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const AZDO_SERVER_URL  = (process.env.AZDO_SERVER_URL  || '').replace(/\/$/, '');
const AZDO_PAT         = process.env.AZDO_PAT          || '';
// Strip unresolved Azure Pipelines variable syntax "$(VAR)" so JS defaults kick in
const AZDO_PUBLISHER   = ((process.env.AZDO_PUBLISHER    || '').replace(/^\$\(.*\)$/, '')) || 'miguelnicolas';
const AZDO_EXTENSION_ID = ((process.env.AZDO_EXTENSION_ID || '').replace(/^\$\(.*\)$/, '')) || 'timetracker-extension';
const SMTP_HOST        = process.env.SMTP_HOST         || '';
const SMTP_PORT        = parseInt(process.env.SMTP_PORT || '25', 10);
const SMTP_FROM        = process.env.SMTP_FROM         || '';
const SMTP_SECURE      = process.env.SMTP_SECURE === 'true';
const SMTP_USER        = process.env.SMTP_USER         || null;
const SMTP_PASS        = process.env.SMTP_PASS         || null;
const DRY_RUN             = process.env.DRY_RUN === 'true';
const OVERRIDE_WEEK_START = /^\d{4}-\d{2}-\d{2}$/.test((process.env.OVERRIDE_WEEK_START || '').trim()) ? process.env.OVERRIDE_WEEK_START.trim() : '';

const REQUIRED_VARS = ['AZDO_SERVER_URL', 'AZDO_PAT', 'SMTP_HOST', 'SMTP_FROM'];

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatDisplayDate(dateStr) {
  // "2026-05-04" -> "Mon 4 May 2026"
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * Returns the Monday–Sunday range of the previous week.
 * When called on a Monday, "last week" = the 7 days that just ended yesterday.
 */
function getLastWeekRange() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const day = now.getDay(); // 0=Sun … 6=Sat
  const daysToLastMonday = (day === 0 ? 6 : day - 1) + 7; // always go back a full week
  const monday = new Date(now);
  monday.setDate(now.getDate() - daysToLastMonday);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { start: monday, end: sunday };
}

function getMonthKeysForRange(start, end) {
  const keys = [];
  const cur = new Date(start.getFullYear(), start.getMonth(), 1);
  const endMon = new Date(end.getFullYear(), end.getMonth(), 1);
  while (cur <= endMon) {
    const y = cur.getFullYear();
    const m = String(cur.getMonth() + 1).padStart(2, '0');
    keys.push(`timetracker_${y}_${m}`);
    cur.setMonth(cur.getMonth() + 1);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Azure DevOps Extension Data REST API
// ---------------------------------------------------------------------------

function authHeader() {
  return 'Basic ' + Buffer.from(':' + AZDO_PAT).toString('base64');
}

function extDataBase() {
  return `${AZDO_SERVER_URL}/_apis/ExtensionManagement/InstalledExtensions` +
         `/${AZDO_PUBLISHER}/${AZDO_EXTENSION_ID}/Data/Scopes/Default/Current`;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        Authorization: authHeader(),
        Accept: 'application/json',
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 404) { resolve(null); return; }
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}: ${body.slice(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse error for ${url}: ${e.message}`)); }
      });
    });
    req.on('error', reject);
  });
}

/**
 * Fetches a single Extension Data document.
 * The VSS SDK setValue() stores plain objects spread into the document,
 * and arrays/primitives wrapped in a __val__ property.
 */
async function fetchDocument(collectionName, debug) {
  // VSS SDK getValue/setValue always uses the $settings built-in collection
  const url = `${extDataBase()}/Collections/%24settings/Documents/${collectionName}?api-version=5.0-preview.1`;
  if (debug) console.log(`[DEBUG] fetchDocument URL: ${url}`);
  const doc = await fetchJson(url);
  if (debug) console.log(`[DEBUG] fetchDocument raw response: ${JSON.stringify(doc)}`);
  if (!doc) return null;

  // Arrays/primitives stored via setValue are wrapped in __val__
  if ('__val__' in doc) return doc.__val__;

  // DevOps Server 2022 REST API wraps the payload in a "value" key
  if ('value' in doc) return doc.value;

  // Fallback: plain objects spread into the document — strip metadata keys
  const result = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k !== 'id' && k !== '__etag' && k !== '__vso_document_version__') {
      result[k] = v;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function buildTotalCell(total, target) {
  const { color, label } = targetStatus(total, target);
  const totalStr = total.toFixed(1);
  if (!target || target <= 0) {
    return `<span style="font-weight:600;font-size:16px;color:${color}">${totalStr}</span>`;
  }
  const pct = Math.round((total / target) * 100);
  return `<span style="font-weight:600;font-size:16px;color:${color}">${totalStr}&thinsp;/&thinsp;${target}</span>` +
         `<br><span style="font-size:11px;color:${color}">${pct}% &mdash; ${label}</span>`;
}

function targetStatus(total, target) {
  if (!target || target <= 0) return { color: '#0078d4', label: null };
  const pct = total / target;
  if (pct < 0.50) return { color: '#d13438', label: 'Poor' };
  if (pct < 0.75) return { color: '#ca5010', label: 'Medium' };
  if (pct < 1.00) return { color: '#986f0b', label: 'OK (not Good)' };
  return { color: '#107c10', label: 'Good' };
}

function buildEmailHtml(user, days, startStr, endStr) {
  const total  = days.reduce((sum, d) => sum + d.hours, 0);
  const target = user.targetHours || 0;

  const rows = days.map(d => {
    const bg    = d.hours === 0 ? '#fff4ce' : '#ffffff';
    const hoursCell = d.hours > 0
      ? `<strong>${d.hours.toFixed(1)}</strong>`
      : `<span style="color:#797775">—</span>`;
    return `
      <tr style="background:${bg}">
        <td style="padding:8px 14px;border-bottom:1px solid #edebe9">${d.dayName}</td>
        <td style="padding:8px 14px;border-bottom:1px solid #edebe9;color:#605e5c">${formatDisplayDate(d.date)}</td>
        <td style="padding:8px 14px;border-bottom:1px solid #edebe9;text-align:right">${hoursCell}</td>
      </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#faf9f8;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;font-size:14px;color:#323130">
  <div style="max-width:600px;margin:32px auto;background:white;border-radius:4px;box-shadow:0 1px 4px rgba(0,0,0,0.12);overflow:hidden">

    <div style="background:#0078d4;padding:20px 28px">
      <h2 style="margin:0;color:white;font-weight:600;font-size:18px">Weekly Hours Summary</h2>
      <p style="margin:4px 0 0 0;color:#deecf9;font-size:13px">${startStr} &ndash; ${endStr}</p>
    </div>

    <div style="padding:24px 28px">
      <p style="margin:0 0 20px 0">Hi <strong>${escHtml(user.userName)}</strong>,</p>
      <p style="margin:0 0 20px 0;color:#605e5c">
        Here is your time logging summary for last week:
      </p>

      <table style="width:100%;border-collapse:collapse;border:1px solid #edebe9;border-radius:4px;overflow:hidden">
        <thead>
          <tr style="background:#f3f2f1">
            <th style="padding:9px 14px;text-align:left;font-size:12px;font-weight:600;color:#605e5c;border-bottom:2px solid #edebe9">Day</th>
            <th style="padding:9px 14px;text-align:left;font-size:12px;font-weight:600;color:#605e5c;border-bottom:2px solid #edebe9">Date</th>
            <th style="padding:9px 14px;text-align:right;font-size:12px;font-weight:600;color:#605e5c;border-bottom:2px solid #edebe9">Hours</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr style="background:#f3f2f1">
            <td colspan="2" style="padding:9px 14px;font-weight:600">Total</td>
            <td style="padding:9px 14px;text-align:right">${buildTotalCell(total, target)}</td>
          </tr>
        </tfoot>
      </table>

      <p style="margin:24px 0 0 0;font-size:12px;color:#a19f9d;border-top:1px solid #edebe9;padding-top:16px">
        This is an automated weekly reminder from Time Tracker.
        Please keep your hours up to date in Azure DevOps.
      </p>
    </div>
  </div>
</body>
</html>`;
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Validate required env vars
  const missing = REQUIRED_VARS.filter(v => !process.env[v]);
  if (missing.length) {
    console.error('Missing required environment variables:', missing.join(', '));
    process.exit(1);
  }

  if (DRY_RUN) console.log('[DRY RUN] No emails will be sent.');

  let { start, end } = getLastWeekRange();

  if (OVERRIDE_WEEK_START) {
    // Allow testing with any specific week: set override_week_start to a Monday (YYYY-MM-DD)
    start = new Date(OVERRIDE_WEEK_START + 'T00:00:00');
    if (isNaN(start.getTime())) {
      console.error(`Invalid OVERRIDE_WEEK_START date: "${OVERRIDE_WEEK_START}". Use YYYY-MM-DD format.`);
      process.exit(1);
    }
    end = new Date(start);
    end.setDate(start.getDate() + 6);
    console.log(`[OVERRIDE] Using specified week instead of last week.`);
  }

  const startStr = toDateStr(start);
  const endStr   = toDateStr(end);
  console.log(`Processing week: ${startStr} → ${endStr}`);

  // Load notification config
  const config = await fetchDocument('notification-config', true);
  console.log(`[DEBUG] config.users: ${JSON.stringify((config && config.users) || null)}`);
  console.log(`[DEBUG] config.schedule: ${JSON.stringify((config && config.schedule) || null)}`);

  // Schedule check — the pipeline runs hourly; the script decides whether it's send time.
  // Skipped when OVERRIDE_WEEK_START is set (manual test run).
  if (!OVERRIDE_WEEK_START) {
    const sched = config && config.schedule;
    if (sched && sched.utcDay !== undefined && sched.utcHour !== undefined) {
      const now     = new Date();
      const curDay  = now.getUTCDay();
      const curHour = now.getUTCHours();
      if (curDay !== sched.utcDay || curHour !== sched.utcHour) {
        console.log(`Not send time. Configured: ${DAY_NAMES[sched.utcDay]} ${String(sched.utcHour).padStart(2,'0')}:00 UTC | Now: ${DAY_NAMES[curDay]} ${String(curHour).padStart(2,'0')}:00 UTC. Nothing to do.`);
        return;
      }
      console.log('Schedule matched — proceeding.');
    }
  }

  const enabledUsers = ((config && config.users) || []).filter(u => u.emailEnabled);

  if (!enabledUsers.length) {
    console.log('No users have email notifications enabled. Nothing to send.');
    return;
  }
  console.log(`${enabledUsers.length} user(s) with notifications enabled.`);

  // Load time entries for the relevant month(s)
  const monthKeys = getMonthKeysForRange(start, end);
  let allEntries = [];
  for (const key of monthKeys) {
    const entries = await fetchDocument(key);
    if (Array.isArray(entries)) {
      allEntries = allEntries.concat(entries);
    }
  }
  console.log(`Loaded ${allEntries.length} total entries across ${monthKeys.length} month(s).`);

  // Filter to the exact week
  const weekEntries = allEntries.filter(e => e.date >= startStr && e.date <= endStr);
  console.log(`${weekEntries.length} entries fall within the week range.`);

  // Group by userId
  const byUser = {};
  weekEntries.forEach(e => {
    if (!byUser[e.userId]) byUser[e.userId] = [];
    byUser[e.userId].push(e);
  });

  // Set up SMTP transport (30 s timeouts, IPv4 only — IPv6 may be unreachable on pipeline agents)
  const transportOptions = {
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    family: 4,
    connectionTimeout: 60000,
    greetingTimeout:   60000,
    socketTimeout:     120000,
  };
  if (SMTP_USER) transportOptions.auth = { user: SMTP_USER, pass: SMTP_PASS };
  const transporter = nodemailer.createTransport(transportOptions);

  // Pre-build all mail objects so the retry loop only deals with transport errors.
  const mails = enabledUsers.map(user => {
    const entries = byUser[user.userId] || [];
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const dateStr = toDateStr(d);
      const dayEntries = entries.filter(e => e.date === dateStr);
      const hours = dayEntries.reduce((sum, e) => sum + (Number(e.hours) || 0), 0);
      days.push({ dayName: DAY_NAMES[d.getDay()], date: dateStr, hours });
    }
    const total  = days.reduce((s, d) => s + d.hours, 0);
    const ccList = (user.cc || '').split(',').map(s => s.trim()).filter(Boolean);
    return {
      user, total,
      mailOptions: {
        from:    SMTP_FROM,
        to:      user.userEmail,
        cc:      ccList.length ? ccList.join(', ') : undefined,
        subject: `Weekly Hours Summary: ${startStr} – ${endStr}`,
        html:    buildEmailHtml(user, days, startStr, endStr),
      }
    };
  });

  if (DRY_RUN) {
    for (const { user, total, mailOptions } of mails) {
      console.log(`[DRY RUN] → ${mailOptions.to}${mailOptions.cc ? '  CC: ' + mailOptions.cc : ''}  |  Total: ${total.toFixed(1)} h`);
    }
    console.log(`Done (dry run). Would send: ${mails.length}.`);
    return;
  }

  const MAX_ROUNDS    = 12;
  const RETRY_DELAY   = 5 * 60 * 1000; // 5 minutes
  let sent = 0, failed = 0;
  let pending = [...mails];

  for (let round = 1; round <= MAX_ROUNDS && pending.length > 0; round++) {
    if (round > 1) {
      console.log(`Retrying ${pending.length} failed email(s) — round ${round}/${MAX_ROUNDS}, waiting 5 min…`);
      await new Promise(r => setTimeout(r, RETRY_DELAY));
    }
    const stillFailed = [];
    for (const item of pending) {
      try {
        await transporter.sendMail(item.mailOptions);
        console.log(`Sent  → ${item.mailOptions.to}${item.mailOptions.cc ? '  CC: ' + item.mailOptions.cc : ''}`);
        sent++;
      } catch (err) {
        console.warn(`Round ${round} failed → ${item.mailOptions.to}: ${err.message}`);
        stillFailed.push(item);
      }
    }
    pending = stillFailed;
  }

  failed = pending.length;
  for (const item of pending) {
    console.error(`Giving up → ${item.mailOptions.to} after ${MAX_ROUNDS} rounds.`);
  }

  console.log(`Done. Sent: ${sent}, Failed: ${failed}.`);
  if (failed > 0) process.exit(1);
}

const globalTimeout = setTimeout(() => {
  console.error('Fatal: script timed out after 65 minutes.');
  process.exit(1);
}, 65 * 60 * 1000);
globalTimeout.unref();

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
