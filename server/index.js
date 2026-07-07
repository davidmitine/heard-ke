const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const db = require('./db');

const app = express();
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

// same phrase list the client already uses to trigger the Befrienders nudge
const HEAVY_RE = /\b(kill myself|end it|no point|can't go on|cant go on|suicide|give up|worthless)\b/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const postLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });
const rsvpLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 });
const emailLimiter = rateLimit({ windowMs: 60 * 1000, max: 5 });
const lockerWriteLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });
const lockerReadLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });

const smallJson = express.json({ limit: '20kb' });
const emailJson = express.json({ limit: '15mb' });
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
app.get('/api/wall', (req, res) => {
  const since = Number(req.query.since) || 0;
  const limit = Math.min(Number(req.query.limit) || 30, 100);
  const rows = db
    .prepare(
      "SELECT * FROM posts WHERE status = 'approved' AND ts > ? ORDER BY ts DESC LIMIT ?"
    )
    .all(since, limit);
  res.json(rows.map(serializePost));
});

app.post('/api/wall', postLimiter, smallJson, async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text || text.length > 2000) {
    return res.status(400).json({ error: 'text must be 1-2000 characters' });
  }
  const selfHarmPhrase = HEAVY_RE.test(text);
  const mod = await moderateText(text);
  const flagged =
    selfHarmPhrase || mod.categories.some((c) => c.startsWith('self-harm')) ? 1 : 0;
  const status = mod.autoReject ? 'rejected' : 'pending';
  const ts = Date.now();
  const aiResult = mod.checked ? JSON.stringify(mod.categories) : null;
  const info = db
    .prepare(
      'INSERT INTO posts (text, ts, flagged, status, ai_result) VALUES (?, ?, ?, ?, ?)'
    )
    .run(text, ts, flagged, status, aiResult);

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
      ? { name: 'Befrienders Kenya', phone: '+254722178177' }
      : null
  });
});

app.post('/api/wall/:id/report', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const reports = row.reports + 1;
  let status = row.status;
  if (reports >= 2 && status === 'approved') {
    status = 'pending'; // pull it off the wall and back into your queue
    notifyModerator({ text: row.text, flagged: row.flagged, reported: true }).catch(
      (e) => console.error('moderator alert', e)
    );
  }
  db.prepare('UPDATE posts SET reports = ?, status = ? WHERE id = ?').run(
    reports,
    status,
    id
  );
  res.json({ ok: true });
});

// ---------- admin (moderation dashboard, protected by ADMIN_KEY) ----------
app.get('/api/admin/wall', requireAdmin, (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status)
    ? req.query.status
    : 'pending';
  const rows = db
    .prepare('SELECT * FROM posts WHERE status = ? ORDER BY ts DESC LIMIT 200')
    .all(status);
  const counts = db
    .prepare('SELECT status, COUNT(*) AS n FROM posts GROUP BY status')
    .all()
    .reduce((acc, r) => ((acc[r.status] = r.n), acc), {});
  res.json({ posts: rows.map(serializeAdminPost), counts });
});

app.post('/api/admin/wall/:id/:action', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const action = req.params.action;
  const row = db.prepare('SELECT id FROM posts WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (action === 'approve') {
    db.prepare("UPDATE posts SET status = 'approved' WHERE id = ?").run(id);
  } else if (action === 'reject') {
    db.prepare("UPDATE posts SET status = 'rejected' WHERE id = ?").run(id);
  } else if (action === 'delete') {
    db.prepare('DELETE FROM posts WHERE id = ?').run(id);
  } else {
    return res.status(400).json({ error: 'unknown action' });
  }
  res.json({ ok: true });
});

// ---------- events ----------
app.get('/api/events', (req, res) => {
  const rows = db
    .prepare(
      `SELECT e.*, (SELECT COUNT(*) FROM rsvps r WHERE r.event_id = e.id) AS rsvp_count
       FROM events e WHERE e.datetime > ? ORDER BY e.datetime ASC`
    )
    .all(Date.now());
  res.json(rows);
});

app.post('/api/events/:id/rsvp', rsvpLimiter, smallJson, (req, res) => {
  const eventId = Number(req.params.id);
  const clientId = String(req.body?.clientId || '').trim();
  if (!clientId || clientId.length > 100) {
    return res.status(400).json({ error: 'clientId required' });
  }
  const event = db.prepare('SELECT id FROM events WHERE id = ?').get(eventId);
  if (!event) return res.status(404).json({ error: 'event not found' });

  db.prepare(
    'INSERT OR IGNORE INTO rsvps (event_id, client_id, ts) VALUES (?, ?, ?)'
  ).run(eventId, clientId, Date.now());

  const rsvp_count = db
    .prepare('SELECT COUNT(*) AS n FROM rsvps WHERE event_id = ?')
    .get(eventId).n;
  res.json({ ok: true, rsvp_count });
});

// ---------- send to self (email) ----------
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const MAIL_FROM = process.env.MAIL_FROM || 'Heard.ke <onboarding@resend.dev>';

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
  if (text.length > 5000) {
    return res.status(400).json({ error: 'text too long' });
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
app.post('/api/locker', lockerWriteLimiter, lockerJson, (req, res) => {
  const type = String(req.body?.type || '').trim();
  const text = req.body?.text ? String(req.body.text) : null;
  const attachment = req.body?.attachment; // { base64, contentType }

  if (!['text', 'audio', 'draw'].includes(type)) {
    return res.status(400).json({ error: 'invalid type' });
  }
  if (type === 'text' && (!text || text.length > 5000)) {
    return res.status(400).json({ error: 'text required (max 5000 chars)' });
  }
  if (type !== 'text' && !attachment?.base64) {
    return res.status(400).json({ error: 'attachment required' });
  }

  let code;
  do {
    code = generateLockerCode();
  } while (db.prepare('SELECT 1 FROM locker WHERE code = ?').get(code));

  db.prepare(
    `INSERT INTO locker (code, type, text, attachment_base64, attachment_content_type, ts)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    code,
    type,
    text,
    attachment?.base64 || null,
    attachment?.contentType || null,
    Date.now()
  );

  res.status(201).json({ code });
});

app.get('/api/locker/:code', lockerReadLimiter, (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const row = db.prepare('SELECT * FROM locker WHERE code = ?').get(code);
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

app.listen(PORT, () => {
  console.log(`Heard.ke server listening on port ${PORT}`);
});
