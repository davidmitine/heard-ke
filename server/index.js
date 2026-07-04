const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 4000;
const ORIGIN = process.env.CLIENT_ORIGIN || '*';

app.use(cors({ origin: ORIGIN }));

// same phrase list the client already uses to trigger the Befrienders nudge
const HEAVY_RE = /\b(kill myself|end it|no point|can't go on|cant go on|suicide|give up|worthless)\b/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const postLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });
const rsvpLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 });
const emailLimiter = rateLimit({ windowMs: 60 * 1000, max: 5 });

const smallJson = express.json({ limit: '20kb' });
const emailJson = express.json({ limit: '15mb' });

function serializePost(row) {
  return { id: row.id, text: row.text, ts: row.ts, flagged: !!row.flagged };
}

// ---------- wall ----------
app.get('/api/wall', (req, res) => {
  const since = Number(req.query.since) || 0;
  const limit = Math.min(Number(req.query.limit) || 30, 100);
  const rows = db
    .prepare(
      'SELECT * FROM posts WHERE hidden = 0 AND ts > ? ORDER BY ts DESC LIMIT ?'
    )
    .all(since, limit);
  res.json(rows.map(serializePost));
});

app.post('/api/wall', postLimiter, smallJson, (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text || text.length > 2000) {
    return res.status(400).json({ error: 'text must be 1-2000 characters' });
  }
  const flagged = HEAVY_RE.test(text) ? 1 : 0;
  const ts = Date.now();
  const info = db
    .prepare('INSERT INTO posts (text, ts, flagged) VALUES (?, ?, ?)')
    .run(text, ts, flagged);
  res.status(201).json({
    id: info.lastInsertRowid,
    text,
    ts,
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
  const hidden = reports >= 3 ? 1 : row.hidden;
  db.prepare('UPDATE posts SET reports = ?, hidden = ? WHERE id = ?').run(
    reports,
    hidden,
    id
  );
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

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Heard.ke server listening on port ${PORT}`);
});
