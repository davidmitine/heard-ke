const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const ical = require('node-ical');
const db = require('./db');

const app = express();
// Render (and Cloudflare in front of it) terminate TLS and forward the real
// client IP in X-Forwarded-For. Trust exactly one proxy hop so express-rate-limit
// keys off the visitor's IP, not the proxy's — otherwise every visitor shares a
// single rate-limit bucket. Kept at 1 (not `true`) so clients can't spoof XFF.
app.set('trust proxy', 1);
app.disable('x-powered-by'); // don't advertise the framework
const PORT = process.env.PORT || 4000;
// comma-separated list, e.g. "https://www.heard.co.ke,https://heard-ke.netlify.app"
const ALLOWED_ORIGINS = (process.env.CLIENT_ORIGIN || '*')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (
        ALLOWED_ORIGINS.includes('*') ||
        !origin ||
        ALLOWED_ORIGINS.includes(origin)
      ) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    }
  })
);

// same phrase list the client already uses to trigger the support nudge
const HEAVY_RE = /\b(kill myself|end it|no point|can't go on|cant go on|suicide|give up|worthless)\b/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const postLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });
const reportLimiter = rateLimit({ windowMs: 60 * 1000, max: 15 });
const rsvpLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 });
const emailLimiter = rateLimit({ windowMs: 60 * 1000, max: 5 });
const lockerWriteLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });
const lockerReadLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });
// Brute-force guard on the admin key: only failed auth (401) counts toward the
// limit, so a legit reviewer with the right key is never throttled, but someone
// guessing keys gets locked out after a handful of misses per 15 minutes.
const adminAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (req, res) => res.statusCode !== 401,
  message: { error: 'too many attempts, please try again later' }
});
app.use('/api/admin', adminAuthLimiter);

const smallJson = express.json({ limit: '20kb' });
const wallJson = express.json({ limit: '200kb' }); // generous room for long posts
const emailJson = express.json({ limit: '15mb' });
const MAX_POST_LENGTH = 20000; // ~8-10 typed pages — a real ceiling, not a real limit
const lockerJson = express.json({ limit: '15mb' });

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L to avoid ambiguity
function generateLockerCode() {
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

function serializePost(row) {
  return { id: row.id, text: row.text, ts: row.ts, flagged: !!row.flagged };
}
function serializeAdminPost(row) {
  return {
    id: row.id,
    text: row.text,
    ts: row.ts,
    flagged: !!row.flagged,
    reports: row.reports,
    status: row.status,
    ai: row.ai_result ? JSON.parse(row.ai_result) : []
  };
}

// ---------- moderation ----------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ADMIN_KEY = process.env.ADMIN_KEY;
const MODERATOR_EMAIL = process.env.MODERATOR_EMAIL || 'davidmitine@gmail.com';
const ADMIN_URL = process.env.ADMIN_URL || 'https://www.heard.co.ke/admin.html';

// Outward harm and abuse -> auto-reject so the owner never has to read it.
// Every self-harm category is deliberately excluded: a man in crisis must reach
// the review queue and see the helpline, never be silently dropped.
const AUTO_REJECT = new Set([
  'hate', 'hate/threatening',
  'harassment/threatening',
  'violence', 'violence/graphic',
  'sexual', 'sexual/minors',
  'illicit/violent'
]);

async function moderateText(text) {
  if (!OPENAI_API_KEY) return { checked: false, categories: [], autoReject: false };
  try {
    const r = await fetch('https://api.openai.com/v1/moderations', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model: 'omni-moderation-latest', input: text })
    });
    if (!r.ok) {
      console.error('openai moderation error', r.status, await r.text());
      return { checked: false, categories: [], autoReject: false };
    }
    const data = await r.json();
    const cats = data?.results?.[0]?.categories || {};
    const fired = Object.keys(cats).filter((k) => cats[k]);
    const autoReject = fired.some((c) => AUTO_REJECT.has(c));
    return { checked: true, categories: fired, autoReject };
  } catch (e) {
    console.error('openai moderation exception', e);
    return { checked: false, categories: [], autoReject: false };
  }
}

async function notifyModerator(post) {
  if (!RESEND_API_KEY) return;
  const tag = post.flagged
    ? ' [self-harm flagged]'
    : post.reported
    ? ' [community reported]'
    : '';
  const preview = escapeHtml(String(post.text).slice(0, 500)).replace(/\n/g, '<br>');
  const payload = {
    from: MAIL_FROM,
    to: [MODERATOR_EMAIL],
    subject: `Heard.ke: a wall post needs review${tag}`,
    html:
      `<p>A post is waiting for your review${post.reported ? ' (readers reported it)' : ''}.</p>` +
      `<blockquote style="border-left:3px solid #e6a95c;padding-left:12px;color:#333">${preview}</blockquote>` +
      (post.flagged
        ? '<p style="color:#b23a22"><strong>This post mentions self-harm. Please review with care.</strong></p>'
        : '') +
      `<p><a href="${ADMIN_URL}">Open the review page</a></p>`
  };
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  if (!r.ok) console.error('moderator alert failed', r.status, await r.text());
}

function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) return res.status(503).json({ error: 'admin not configured' });
  const key = req.get('x-admin-key') || req.query.key;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// ---------- wall ----------
app.get('/api/wall', async (req, res) => {
  const since = Number(req.query.since) || 0;
  const limit = Math.min(Number(req.query.limit) || 30, 100);
  const rows = await db.all(
    "SELECT * FROM posts WHERE status = 'approved' AND ts > ? ORDER BY ts DESC LIMIT ?",
    [since, limit]
  );
  res.json(rows.map(serializePost));
});

app.post('/api/wall', postLimiter, wallJson, async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text || text.length > MAX_POST_LENGTH) {
    return res
      .status(400)
      .json({ error: `text must be 1-${MAX_POST_LENGTH} characters` });
  }
  const selfHarmPhrase = HEAVY_RE.test(text);
  const mod = await moderateText(text);
  const flagged =
    selfHarmPhrase || mod.categories.some((c) => c.startsWith('self-harm')) ? 1 : 0;
  const status = mod.autoReject ? 'rejected' : 'pending';
  const ts = Date.now();
  const aiResult = mod.checked ? JSON.stringify(mod.categories) : null;
  const info = await db.run(
    'INSERT INTO posts (text, ts, flagged, status, ai_result) VALUES (?, ?, ?, ?, ?)',
    [text, ts, flagged, status, aiResult]
  );

  // Only ping the moderator for things that need a human decision.
  if (status === 'pending') {
    notifyModerator({ text, flagged }).catch((e) =>
      console.error('moderator alert', e)
    );
  }

  // Same warm response whether pending or auto-rejected, so the filter can't be
  // gamed and nobody in distress is told their words were turned away.
  res.status(201).json({
    id: info.lastInsertRowid,
    held: true,
    flagged: !!flagged,
    helpline: flagged
      ? { name: 'Heard.ke', email: 'info@heard.co.ke' }
      : null
  });
});

// Distinct reporters needed before a live post is pulled back for re-review.
const REPORTS_TO_HIDE = 2;

app.post('/api/wall/:id/report', reportLimiter, smallJson, async (req, res) => {
  const id = Number(req.params.id);
  const clientId = String(req.body?.clientId || '').trim();
  if (!clientId || clientId.length > 100) {
    return res.status(400).json({ error: 'clientId required' });
  }
  const row = await db.get('SELECT * FROM posts WHERE id = ?', [id]);
  if (!row) return res.status(404).json({ error: 'not found' });

  // One report per client per post. The PK makes repeat reports from the same
  // client no-ops, so a single actor can't inflate the count and take a post
  // down on their own — REPORTS_TO_HIDE distinct devices are required.
  await db.run(
    'INSERT OR IGNORE INTO post_reports (post_id, client_id, ts) VALUES (?, ?, ?)',
    [id, clientId, Date.now()]
  );
  const countRow = await db.get(
    'SELECT COUNT(*) AS n FROM post_reports WHERE post_id = ?',
    [id]
  );
  const reports = countRow.n;

  let status = row.status;
  if (reports >= REPORTS_TO_HIDE && status === 'approved') {
    status = 'pending'; // pull it off the wall and back into your queue
    notifyModerator({ text: row.text, flagged: row.flagged, reported: true }).catch(
      (e) => console.error('moderator alert', e)
    );
  }
  await db.run('UPDATE posts SET reports = ?, status = ? WHERE id = ?', [
    reports,
    status,
    id
  ]);
  res.json({ ok: true });
});

// ---------- admin (moderation dashboard, protected by ADMIN_KEY) ----------
app.get('/api/admin/wall', requireAdmin, async (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status)
    ? req.query.status
    : 'pending';
  const rows = await db.all(
    'SELECT * FROM posts WHERE status = ? ORDER BY ts DESC LIMIT 200',
    [status]
  );
  const countRows = await db.all('SELECT status, COUNT(*) AS n FROM posts GROUP BY status');
  const counts = countRows.reduce((acc, r) => ((acc[r.status] = r.n), acc), {});
  res.json({ posts: rows.map(serializeAdminPost), counts });
});

app.post('/api/admin/wall/:id/:action', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const action = req.params.action;
  const row = await db.get('SELECT id FROM posts WHERE id = ?', [id]);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (action === 'approve') {
    await db.run("UPDATE posts SET status = 'approved' WHERE id = ?", [id]);
  } else if (action === 'reject') {
    await db.run("UPDATE posts SET status = 'rejected' WHERE id = ?", [id]);
  } else if (action === 'delete') {
    await db.run('DELETE FROM posts WHERE id = ?', [id]);
  } else {
    return res.status(400).json({ error: 'unknown action' });
  }
  res.json({ ok: true });
});

// ---------- events ----------
app.get('/api/events', async (req, res) => {
  const rows = await db.all(
    `SELECT e.*, (SELECT COUNT(*) FROM rsvps r WHERE r.event_id = e.id) AS rsvp_count
     FROM events e WHERE e.datetime > ? ORDER BY e.datetime ASC`,
    [Date.now()]
  );
  res.json(rows);
});

const PHONE_RE = /^\+?[0-9\s-]{7,20}$/;

app.post('/api/events/:id/rsvp', rsvpLimiter, smallJson, async (req, res) => {
  const eventId = Number(req.params.id);
  const clientId = String(req.body?.clientId || '').trim();
  const phone = String(req.body?.phone || '').trim();
  const email = String(req.body?.email || '').trim();

  if (!clientId || clientId.length > 100) {
    return res.status(400).json({ error: 'clientId required' });
  }
  if (!phone || !PHONE_RE.test(phone)) {
    return res.status(400).json({ error: 'a valid phone number is required' });
  }
  if (email && !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'that email address does not look right' });
  }
  const event = await db.get('SELECT id FROM events WHERE id = ?', [eventId]);
  if (!event) return res.status(404).json({ error: 'event not found' });

  await db.run(
    `INSERT INTO rsvps (event_id, client_id, ts, phone, email) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(event_id, client_id) DO UPDATE SET phone = excluded.phone, email = excluded.email`,
    [eventId, clientId, Date.now(), phone, email || null]
  );

  const countRow = await db.get('SELECT COUNT(*) AS n FROM rsvps WHERE event_id = ?', [
    eventId
  ]);
  res.json({ ok: true, rsvp_count: countRow.n });
});

// ---------- Google Calendar sync (one-way: Calendar -> our events table) ----------
// The organizer manages meetups in a Google Calendar; we pull it in periodically
// via its public iCal feed (no OAuth needed) so both the admin dashboard and the
// public site stay in sync automatically. Manually-added events (gcal_uid IS NULL)
// are never touched by this.
const GOOGLE_CALENDAR_ICS_URL = process.env.GOOGLE_CALENDAR_ICS_URL;
const SYNC_WINDOW_DAYS = 180;
let lastSync = { at: null, ok: null, count: 0, error: null };

function occurrenceFields(ev, start) {
  const title = String(ev.summary || 'Meetup').trim().slice(0, 200) || 'Meetup';
  const description = String(ev.description || 'See Google Calendar for details').trim().slice(0, 2000);
  const location = String(ev.location || 'Location on Google Calendar').trim().slice(0, 200);
  return { title, description, location, datetime: start.getTime() };
}

async function syncGoogleCalendar() {
  if (!GOOGLE_CALENDAR_ICS_URL) return { ok: false, count: 0, error: 'not configured' };
  const now = new Date();
  const windowEnd = new Date(now.getTime() + SYNC_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const data = await ical.async.fromURL(GOOGLE_CALENDAR_ICS_URL);
  const events = Object.values(data).filter((e) => e.type === 'VEVENT');

  const seen = new Map(); // gcal_uid -> fields
  for (const ev of events) {
    if (!ev.uid || !ev.start) continue;

    if (ev.rrule) {
      let occurrences = [];
      try {
        occurrences = ev.rrule.between(now, windowEnd, true);
      } catch (e) {
        console.error('rrule expansion failed for', ev.uid, e);
      }
      for (const start of occurrences) {
        const key = `${ev.uid}::${start.toISOString()}`;
        seen.set(key, occurrenceFields(ev, start));
      }
      // per-instance overrides (moved/edited single occurrences of a series)
      if (ev.recurrences) {
        for (const override of Object.values(ev.recurrences)) {
          if (!override.start || override.start < now || override.start > windowEnd) continue;
          const key = `${ev.uid}::${override.start.toISOString()}`;
          seen.set(key, occurrenceFields(override, override.start));
        }
      }
    } else {
      if (ev.start < now || ev.start > windowEnd) continue;
      seen.set(ev.uid, occurrenceFields(ev, ev.start));
    }
  }

  for (const [gcalUid, fields] of seen) {
    await db.run(
      `INSERT INTO events (title, description, location, datetime, gcal_uid) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(gcal_uid) DO UPDATE SET title = excluded.title, description = excluded.description,
         location = excluded.location, datetime = excluded.datetime`,
      [fields.title, fields.description, fields.location, fields.datetime, gcalUid]
    );
  }

  // drop previously-synced events that no longer appear in the feed (deleted/moved in Calendar)
  const priorSynced = await db.all(
    'SELECT id, gcal_uid FROM events WHERE gcal_uid IS NOT NULL'
  );
  for (const row of priorSynced) {
    if (!seen.has(row.gcal_uid)) {
      await db.run('DELETE FROM rsvps WHERE event_id = ?', [row.id]);
      await db.run('DELETE FROM events WHERE id = ?', [row.id]);
    }
  }

  return { ok: true, count: seen.size, error: null };
}

async function runSync() {
  try {
    const result = await syncGoogleCalendar();
    lastSync = { at: Date.now(), ok: result.ok, count: result.count, error: result.error };
  } catch (e) {
    console.error('google calendar sync failed', e);
    lastSync = { at: Date.now(), ok: false, count: 0, error: e.message };
  }
}

// ---------- admin: events (create/edit/delete meetups) ----------
function validEventFields(body) {
  const title = String(body?.title || '').trim();
  const description = String(body?.description || '').trim();
  const location = String(body?.location || '').trim();
  const datetime = Number(body?.datetime);
  if (!title || title.length > 200) return null;
  if (!description || description.length > 2000) return null;
  if (!location || location.length > 200) return null;
  if (!Number.isFinite(datetime) || datetime <= 0) return null;
  return { title, description, location, datetime };
}

app.get('/api/admin/events', requireAdmin, async (req, res) => {
  const rows = await db.all(
    `SELECT e.*, (SELECT COUNT(*) FROM rsvps r WHERE r.event_id = e.id) AS rsvp_count
     FROM events e ORDER BY e.datetime ASC`
  );
  res.json({
    events: rows.map((r) => ({ ...r, synced: !!r.gcal_uid })),
    sync: {
      enabled: !!GOOGLE_CALENDAR_ICS_URL,
      lastSyncedAt: lastSync.at,
      lastSyncOk: lastSync.ok,
      lastSyncError: lastSync.error
    }
  });
});

app.post('/api/admin/events/sync', requireAdmin, async (req, res) => {
  if (!GOOGLE_CALENDAR_ICS_URL) {
    return res.status(503).json({ error: 'Google Calendar sync is not configured' });
  }
  await runSync();
  if (!lastSync.ok) {
    return res.status(502).json({ error: lastSync.error || 'sync failed' });
  }
  res.json({ ok: true, count: lastSync.count });
});

app.post('/api/admin/events', requireAdmin, smallJson, async (req, res) => {
  const fields = validEventFields(req.body);
  if (!fields) return res.status(400).json({ error: 'invalid event fields' });
  const info = await db.run(
    'INSERT INTO events (title, description, location, datetime) VALUES (?, ?, ?, ?)',
    [fields.title, fields.description, fields.location, fields.datetime]
  );
  res.status(201).json({ id: info.lastInsertRowid });
});

app.post('/api/admin/events/:id/update', requireAdmin, smallJson, async (req, res) => {
  const id = Number(req.params.id);
  const existing = await db.get('SELECT id, gcal_uid FROM events WHERE id = ?', [id]);
  if (!existing) return res.status(404).json({ error: 'not found' });
  if (existing.gcal_uid) {
    return res
      .status(400)
      .json({ error: 'this event is managed in Google Calendar — edit it there' });
  }
  const fields = validEventFields(req.body);
  if (!fields) return res.status(400).json({ error: 'invalid event fields' });
  await db.run(
    'UPDATE events SET title = ?, description = ?, location = ?, datetime = ? WHERE id = ?',
    [fields.title, fields.description, fields.location, fields.datetime, id]
  );
  res.json({ ok: true });
});

app.post('/api/admin/events/:id/delete', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const existing = await db.get('SELECT id, gcal_uid FROM events WHERE id = ?', [id]);
  if (!existing) return res.status(404).json({ error: 'not found' });
  if (existing.gcal_uid) {
    return res
      .status(400)
      .json({ error: 'this event is managed in Google Calendar — delete it there' });
  }
  await db.run('DELETE FROM rsvps WHERE event_id = ?', [id]);
  await db.run('DELETE FROM events WHERE id = ?', [id]);
  res.json({ ok: true });
});

// attendee contact info for a meetup — only ever visible here, never on the public site
app.get('/api/admin/events/:id/rsvps', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const rows = await db.all(
    'SELECT phone, email, ts FROM rsvps WHERE event_id = ? ORDER BY ts ASC',
    [id]
  );
  res.json({ rsvps: rows });
});

// ---------- guide (Advice / Talk to someone / Books / Music — all admin-editable) ----------
const GUIDE_SECTIONS = ['advice', 'contact', 'book', 'music'];

function validGuideFields(body) {
  const section = String(body?.section || '').trim();
  const title = String(body?.title || '').trim();
  const itemBody = String(body?.body || '').trim();
  let url = body?.url ? String(body.url).trim() : null;
  if (!GUIDE_SECTIONS.includes(section)) return null;
  if (!title || title.length > 200) return null;
  if (!itemBody || itemBody.length > 3000) return null;
  if (url) {
    if (!/^https?:\/\//i.test(url) || url.length > 500) return null;
  } else {
    url = null;
  }
  return { section, title, body: itemBody, url };
}

app.get('/api/guide', async (req, res) => {
  const rows = await db.all(
    'SELECT id, section, title, body, url FROM guide_items ORDER BY section ASC, position ASC'
  );
  res.json({ items: rows });
});

app.get('/api/admin/guide', requireAdmin, async (req, res) => {
  const rows = await db.all(
    'SELECT * FROM guide_items ORDER BY section ASC, position ASC'
  );
  res.json({ items: rows });
});

app.post('/api/admin/guide', requireAdmin, smallJson, async (req, res) => {
  const fields = validGuideFields(req.body);
  if (!fields) return res.status(400).json({ error: 'invalid guide item fields' });
  const maxRow = await db.get(
    'SELECT MAX(position) AS n FROM guide_items WHERE section = ?',
    [fields.section]
  );
  const position = (maxRow.n ?? -1) + 1;
  const info = await db.run(
    'INSERT INTO guide_items (section, title, body, url, position, ts) VALUES (?, ?, ?, ?, ?, ?)',
    [fields.section, fields.title, fields.body, fields.url, position, Date.now()]
  );
  res.status(201).json({ id: info.lastInsertRowid });
});

app.post('/api/admin/guide/:id/update', requireAdmin, smallJson, async (req, res) => {
  const id = Number(req.params.id);
  const existing = await db.get('SELECT * FROM guide_items WHERE id = ?', [id]);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const fields = validGuideFields(req.body);
  if (!fields) return res.status(400).json({ error: 'invalid guide item fields' });

  let position = existing.position;
  if (fields.section !== existing.section) {
    const maxRow = await db.get(
      'SELECT MAX(position) AS n FROM guide_items WHERE section = ?',
      [fields.section]
    );
    position = (maxRow.n ?? -1) + 1;
  }
  await db.run(
    'UPDATE guide_items SET section = ?, title = ?, body = ?, url = ?, position = ? WHERE id = ?',
    [fields.section, fields.title, fields.body, fields.url, position, id]
  );
  res.json({ ok: true });
});

app.post('/api/admin/guide/:id/delete', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const info = await db.run('DELETE FROM guide_items WHERE id = ?', [id]);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

app.post('/api/admin/guide/:id/move', requireAdmin, smallJson, async (req, res) => {
  const id = Number(req.params.id);
  const direction = req.body?.direction === 'up' ? 'up' : 'down';
  const item = await db.get('SELECT * FROM guide_items WHERE id = ?', [id]);
  if (!item) return res.status(404).json({ error: 'not found' });

  const neighbor = await db.get(
    direction === 'up'
      ? 'SELECT * FROM guide_items WHERE section = ? AND position < ? ORDER BY position DESC LIMIT 1'
      : 'SELECT * FROM guide_items WHERE section = ? AND position > ? ORDER BY position ASC LIMIT 1',
    [item.section, item.position]
  );
  if (!neighbor) return res.json({ ok: true }); // already at the edge, nothing to do

  await db.run('UPDATE guide_items SET position = ? WHERE id = ?', [
    neighbor.position,
    item.id
  ]);
  await db.run('UPDATE guide_items SET position = ? WHERE id = ?', [
    item.position,
    neighbor.id
  ]);
  res.json({ ok: true });
});

// ---------- send to self (email) ----------
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const MAIL_FROM = process.env.MAIL_FROM || 'Heard.ke <onboarding@resend.dev>';

// Abuse controls for the email relay. This endpoint sends from our verified
// domain to an arbitrary address, so without a gate it's a spam/phishing cannon
// that would burn the domain's deliverability. Two layers:
//   1. Cloudflare Turnstile — proves a real browser, blocks scripted abuse.
//   2. A hard global daily cap — bounds the damage even if the gate is beaten.
// Both degrade gracefully: if TURNSTILE_SECRET_KEY is unset the check is skipped
// (so the site keeps working until the widget is wired up), while the daily cap
// is always enforced.
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY;
// Parsed so that MAX_EMAILS_PER_DAY=0 means "0" (send disabled), not the default.
const _maxEmails = Number(process.env.MAX_EMAILS_PER_DAY);
const MAX_EMAILS_PER_DAY = Number.isFinite(_maxEmails) && _maxEmails >= 0 ? _maxEmails : 200;

async function verifyTurnstile(token, ip) {
  if (!TURNSTILE_SECRET_KEY) return { ok: true }; // not configured yet — skip
  if (!token) return { ok: false };
  try {
    const params = new URLSearchParams();
    params.append('secret', TURNSTILE_SECRET_KEY);
    params.append('response', token);
    if (ip) params.append('remoteip', ip);
    const r = await fetch(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      { method: 'POST', body: params }
    );
    const data = await r.json();
    return { ok: !!data.success };
  } catch (e) {
    console.error('turnstile verify error', e);
    return { ok: false };
  }
}

function utcDayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}
// Per-UTC-day counters backing the email and locker daily caps. `table` is a
// fixed internal constant ('email_quota' / 'locker_quota'), never user input.
async function quotaUsedToday(table) {
  const row = await db.get(`SELECT count FROM ${table} WHERE day = ?`, [utcDayKey()]);
  return row ? row.count : 0;
}
async function bumpQuota(table) {
  await db.run(
    `INSERT INTO ${table} (day, count) VALUES (?, 1)
     ON CONFLICT(day) DO UPDATE SET count = count + 1`,
    [utcDayKey()]
  );
}

app.post('/api/send-email', emailLimiter, emailJson, async (req, res) => {
  if (!RESEND_API_KEY) {
    return res.status(503).json({ error: 'email sending is not configured yet' });
  }
  const to = String(req.body?.to || '').trim();
  const type = String(req.body?.type || '').trim();
  const text = req.body?.text ? String(req.body.text) : '';
  const attachment = req.body?.attachment; // { filename, base64, contentType }

  if (!EMAIL_RE.test(to)) {
    return res.status(400).json({ error: 'a valid email address is required' });
  }
  if (!['text', 'audio', 'draw'].includes(type)) {
    return res.status(400).json({ error: 'invalid type' });
  }
  if (text.length > MAX_POST_LENGTH) {
    return res.status(400).json({ error: 'text too long' });
  }

  // Bot gate, then the hard daily ceiling — both before we touch Resend.
  const ts = await verifyTurnstile(req.body?.turnstileToken, req.ip);
  if (!ts.ok) {
    return res.status(403).json({ error: 'could not verify you are human, please try again' });
  }
  if ((await quotaUsedToday('email_quota')) >= MAX_EMAILS_PER_DAY) {
    return res
      .status(429)
      .json({ error: 'the daily email limit was reached, please try again tomorrow' });
  }

  const subjects = {
    text: 'What you wrote on Heard.ke',
    audio: 'What you said on Heard.ke',
    draw: 'What you drew on Heard.ke'
  };
  const bodies = {
    text: text ? `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>` : '<p>(see attachment)</p>',
    audio: '<p>Your voice recording from Heard.ke is attached.</p>',
    draw: '<p>Your drawing from Heard.ke is attached.</p>'
  };

  const payload = {
    from: MAIL_FROM,
    to: [to],
    subject: subjects[type],
    html: `${bodies[type]}<p style="color:#888;font-size:12px">Sent privately from Heard.ke — nobody else received this.</p>`
  };
  if (attachment?.base64 && attachment?.filename) {
    payload.attachments = [
      { filename: attachment.filename, content: attachment.base64 }
    ];
  }

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    if (!r.ok) {
      const detail = await r.text();
      console.error('resend error', r.status, detail);
      return res.status(502).json({ error: 'failed to send email' });
    }
    await bumpQuota('email_quota'); // only count sends that actually went out
    res.json({ ok: true });
  } catch (e) {
    console.error('send-email error', e);
    res.status(502).json({ error: 'failed to send email' });
  }
});

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

// ---------- locker (keep on this site, no account — retrieval by code only) ----------
// This endpoint accepts unauthenticated writes and stores them (audio/drawings
// as base64 blobs) in the shared database, so it needs the same abuse controls
// as the email relay plus limits on what a single write can stash: a bot gate,
// a hard daily write cap, an attachment size ceiling, and a content-type
// allowlist. Without these it's a cheap way to fill the (free-tier) database.
const MAX_LOCKER_WRITES_PER_DAY =
  Number.isFinite(Number(process.env.MAX_LOCKER_WRITES_PER_DAY)) &&
  Number(process.env.MAX_LOCKER_WRITES_PER_DAY) >= 0
    ? Number(process.env.MAX_LOCKER_WRITES_PER_DAY)
    : 200;
const MAX_ATTACHMENT_MB =
  Number(process.env.MAX_ATTACHMENT_MB) > 0 ? Number(process.env.MAX_ATTACHMENT_MB) : 10;
const MAX_ATTACHMENT_BYTES = MAX_ATTACHMENT_MB * 1024 * 1024;
// Only the media types the frontend actually produces (recorder + canvas PNG).
const LOCKER_CONTENT_TYPES = new Set([
  'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/wav', 'audio/mpeg',
  'image/png', 'image/jpeg', 'image/webp'
]);

function base64DecodedBytes(b64) {
  const len = b64.length;
  if (len === 0) return 0;
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((len * 3) / 4) - pad;
}

// Returns { ok, error?, baseType? }. baseType is the allowlisted content type
// with any ";codecs=..." suffix stripped — that's what we persist and later
// reflect into a data: URI, so it must be sanitised here.
function validAttachment(type, attachment) {
  if (!attachment || typeof attachment.base64 !== 'string' || !attachment.base64) {
    return { ok: false, error: 'attachment required' };
  }
  const baseType = String(attachment.contentType || '').split(';')[0].trim().toLowerCase();
  if (!LOCKER_CONTENT_TYPES.has(baseType)) {
    return { ok: false, error: 'unsupported attachment type' };
  }
  const expectedPrefix = type === 'audio' ? 'audio/' : 'image/';
  if (!baseType.startsWith(expectedPrefix)) {
    return { ok: false, error: 'attachment type does not match content' };
  }
  if (base64DecodedBytes(attachment.base64) > MAX_ATTACHMENT_BYTES) {
    return { ok: false, error: `attachment too large (max ${MAX_ATTACHMENT_MB}MB)` };
  }
  return { ok: true, baseType };
}

app.post('/api/locker', lockerWriteLimiter, lockerJson, async (req, res) => {
  const type = String(req.body?.type || '').trim();
  const text = req.body?.text ? String(req.body.text) : null;
  const attachment = req.body?.attachment; // { base64, contentType }

  if (!['text', 'audio', 'draw'].includes(type)) {
    return res.status(400).json({ error: 'invalid type' });
  }
  if (type === 'text' && (!text || text.length > MAX_POST_LENGTH)) {
    return res
      .status(400)
      .json({ error: `text required (max ${MAX_POST_LENGTH} chars)` });
  }
  let storedContentType = null;
  if (type !== 'text') {
    const v = validAttachment(type, attachment);
    if (!v.ok) return res.status(400).json({ error: v.error });
    storedContentType = v.baseType;
  }

  // Bot gate, then the hard daily write cap — both before we store anything.
  const ts = await verifyTurnstile(req.body?.turnstileToken, req.ip);
  if (!ts.ok) {
    return res.status(403).json({ error: 'could not verify you are human, please try again' });
  }
  if ((await quotaUsedToday('locker_quota')) >= MAX_LOCKER_WRITES_PER_DAY) {
    return res
      .status(429)
      .json({ error: 'the daily save limit was reached, please try again tomorrow' });
  }

  let code;
  do {
    code = generateLockerCode();
  } while (await db.get('SELECT 1 FROM locker WHERE code = ?', [code]));

  await db.run(
    `INSERT INTO locker (code, type, text, attachment_base64, attachment_content_type, ts)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [code, type, text, attachment?.base64 || null, storedContentType, Date.now()]
  );

  await bumpQuota('locker_quota');
  res.status(201).json({ code });
});

app.get('/api/locker/:code', lockerReadLimiter, async (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const row = await db.get('SELECT * FROM locker WHERE code = ?', [code]);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json({
    type: row.type,
    text: row.text,
    attachment: row.attachment_base64
      ? { base64: row.attachment_base64, contentType: row.attachment_content_type }
      : null
  });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

db.migrate()
  .then(async () => {
    if (GOOGLE_CALENDAR_ICS_URL) {
      await runSync(); // populate before serving traffic
      setInterval(runSync, 10 * 60 * 1000);
    }
    app.listen(PORT, () => {
      console.log(`Heard.ke server listening on port ${PORT}`);
    });
  })
  .catch((e) => {
    console.error('database migration failed, not starting server', e);
    process.exit(1);
  });
