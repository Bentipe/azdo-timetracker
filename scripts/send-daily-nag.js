'use strict';

/**
 * Daily "you forgot to log hours" Slack nagger for Azure DevOps Time Tracker.
 *
 * Once per weekday morning, finds every user on the Notification Settings
 * roster who logged ZERO hours for the previous working day and sends each of
 * them a private Slack DM. Reads time entries from the same Azure DevOps
 * Extension Data REST API used by send-weekly-summary.js.
 *
 * Required environment variables:
 *   AZDO_SERVER_URL   e.g. http://devops.company.com/DefaultCollection
 *   AZDO_PAT          Personal Access Token (needs vso.extension.data scope)
 *   SLACK_BOT_TOKEN   Slack bot token (xoxb-…) with scopes:
 *                       chat:write, users:read, users:read.email, im:write
 *
 * Optional environment variables:
 *   AZDO_PUBLISHER       Extension publisher  (default: miguelnicolas)
 *   AZDO_EXTENSION_ID    Extension id        (default: timetracker-extension)
 *   TIMETRACKER_URL      Link added to the message (e.g. the My Time hub URL)
 *   HOLIDAYS             CSV of YYYY-MM-DD dates to treat as non-working
 *   EXCLUDE_EMAILS       CSV of emails to never nag (case-insensitive)
 *   OVERRIDE_TARGET_DATE YYYY-MM-DD — check this exact day instead of computing
 *   DRY_RUN              true = compute + log only, no Slack calls (default: false)
 */

const https = require('https');
const http  = require('http');
const { WebClient } = require('@slack/web-api');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const AZDO_SERVER_URL   = (process.env.AZDO_SERVER_URL || '').replace(/\/$/, '');
const AZDO_PAT          = process.env.AZDO_PAT || '';
// Strip unresolved Azure Pipelines variable syntax "$(VAR)" so JS defaults kick in
const AZDO_PUBLISHER    = ((process.env.AZDO_PUBLISHER    || '').replace(/^\$\(.*\)$/, '')) || 'miguelnicolas';
const AZDO_EXTENSION_ID = ((process.env.AZDO_EXTENSION_ID || '').replace(/^\$\(.*\)$/, '')) || 'timetracker-extension';
const SLACK_BOT_TOKEN   = process.env.SLACK_BOT_TOKEN || '';
const TIMETRACKER_URL   = (process.env.TIMETRACKER_URL || '').trim();
const DRY_RUN           = process.env.DRY_RUN === 'true';

const OVERRIDE_TARGET_DATE = /^\d{4}-\d{2}-\d{2}$/.test((process.env.OVERRIDE_TARGET_DATE || '').trim())
  ? process.env.OVERRIDE_TARGET_DATE.trim()
  : '';

const HOLIDAYS = new Set(
  (process.env.HOLIDAYS || '')
    .split(',')
    .map(s => s.trim())
    .filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s))
);

const EXCLUDE_EMAILS = new Set(
  (process.env.EXCLUDE_EMAILS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
);

const REQUIRED_VARS = ['AZDO_SERVER_URL', 'AZDO_PAT', 'SLACK_BOT_TOKEN'];

// ---------------------------------------------------------------------------
// Date helpers  (toDateStr / formatDisplayDate copied from send-weekly-summary.js)
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
 * The day to check: yesterday, but if that lands on a weekend, walk back to
 * the previous Friday. So a Monday run targets the prior Friday.
 * OVERRIDE_TARGET_DATE short-circuits this for testing.
 */
function getTargetWorkingDay(now = new Date()) {
  if (OVERRIDE_TARGET_DATE) return OVERRIDE_TARGET_DATE;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - 1); // yesterday
  while (d.getDay() === 0 || d.getDay() === 6) { // 0=Sun, 6=Sat
    d.setDate(d.getDate() - 1);
  }
  return toDateStr(d);
}

function getMonthKey(dateStr) {
  // "2026-05-15" -> "timetracker_2026_05"
  const [y, m] = dateStr.split('-');
  return `timetracker_${y}_${m}`;
}

// ---------------------------------------------------------------------------
// Azure DevOps Extension Data REST API
// (authHeader / extDataBase / fetchJson / fetchDocument copied verbatim from
//  send-weekly-summary.js — same store, same response wrappers)
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
// Message
// ---------------------------------------------------------------------------

function firstNameOf(userName) {
  const n = String(userName || '').trim();
  if (!n) return 'there';
  return n.split(/\s+/)[0];
}

function buildMessage(user, targetDate) {
  const when = formatDisplayDate(targetDate);
  let msg = `:wave: Hi ${firstNameOf(user.userName)}, you have *no hours logged* ` +
            `for *${when}* in Azure DevOps Time Tracker. ` +
            `Please update it when you have a moment.`;
  if (TIMETRACKER_URL) msg += `\n<${TIMETRACKER_URL}|Open Time Tracker>`;
  return msg;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const missing = REQUIRED_VARS.filter(v => !process.env[v]);
  if (missing.length) {
    console.error('Missing required environment variables:', missing.join(', '));
    process.exit(1);
  }

  if (DRY_RUN) console.log('[DRY RUN] No Slack messages will be sent.');

  const targetDate = getTargetWorkingDay();
  console.log(`Target working day: ${targetDate} (${formatDisplayDate(targetDate)})`);

  if (HOLIDAYS.has(targetDate)) {
    console.log(`${targetDate} is in HOLIDAYS — nothing to do.`);
    return;
  }

  // Roster = everyone configured in Notification Settings. We deliberately do
  // NOT derive it from time entries: users who never log any hours have no
  // entries at all, yet they are exactly who we need to nag.
  const config = await fetchDocument('notification-config', true);
  const roster = ((config && config.users) || []).filter(
    u => u && u.userEmail && !EXCLUDE_EMAILS.has(String(u.userEmail).toLowerCase())
  );
  console.log(`[DEBUG] config.users count: ${(config && config.users || []).length}`);

  if (!roster.length) {
    console.log('No users on the Notification Settings roster (after exclusions). Nothing to do.');
    return;
  }
  console.log(`${roster.length} user(s) on the roster.`);

  // Load the month document covering the target day and total hours per user.
  const monthKey = getMonthKey(targetDate);
  const entries = await fetchDocument(monthKey);
  const dayEntries = Array.isArray(entries) ? entries.filter(e => e.date === targetDate) : [];
  console.log(`Loaded ${Array.isArray(entries) ? entries.length : 0} entries from ${monthKey}; ` +
              `${dayEntries.length} on ${targetDate}.`);

  const hoursByUser = {};
  dayEntries.forEach(e => {
    hoursByUser[e.userId] = (hoursByUser[e.userId] || 0) + (Number(e.hours) || 0);
  });

  const delinquent = roster.filter(u => (hoursByUser[u.userId] || 0) === 0);
  console.log(`${delinquent.length} user(s) logged 0 h on ${targetDate}.`);

  if (!delinquent.length) {
    console.log('Everyone logged hours. Nothing to send.');
    return;
  }

  const slack = DRY_RUN ? null : new WebClient(SLACK_BOT_TOKEN);
  let sent = 0, skipped = 0, failed = 0;

  for (const user of delinquent) {
    const message = buildMessage(user, targetDate);

    if (DRY_RUN) {
      console.log(`[DRY RUN] → ${user.userName} <${user.userEmail}>`);
      console.log(`           ${message.replace(/\n/g, '\n           ')}`);
      sent++;
      continue;
    }

    try {
      const lookup = await slack.users.lookupByEmail({ email: user.userEmail });
      const slackId = lookup && lookup.user && lookup.user.id;
      if (!slackId) {
        console.warn(`Skip → no Slack user for ${user.userEmail}`);
        skipped++;
        continue;
      }
      await slack.chat.postMessage({ channel: slackId, text: message });
      console.log(`Sent  → ${user.userName} <${user.userEmail}> (${slackId})`);
      sent++;
    } catch (err) {
      const code = err && err.data && err.data.error;
      if (code === 'users_not_found') {
        console.warn(`Skip → no Slack account for ${user.userEmail} (users_not_found)`);
        skipped++;
      } else {
        console.error(`Failed → ${user.userEmail}: ${code || err.message}`);
        failed++;
      }
    }
  }

  console.log(`Done. Sent: ${sent}, Skipped: ${skipped}, Failed: ${failed}.`);
  if (failed > 0) process.exit(1);
}

if (require.main === module) {
  const globalTimeout = setTimeout(() => {
    console.error('Fatal: script timed out after 10 minutes.');
    process.exit(1);
  }, 600000);
  globalTimeout.unref();

  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { getTargetWorkingDay, getMonthKey, firstNameOf, formatDisplayDate };
