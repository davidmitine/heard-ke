const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 4000;
const ORIGIN = process.env.CLIENT_ORIGIN || '*';

app.use(cors({ origin: ORIGIN }));
app.use(express.json({ limit: '20kb' }));

// same phrase list the client already uses to trigger the Befrienders nudge
const HEAVY_RE = /\b(kill myself|end it|no point|can't go on|cant go on|suicide|give up|worthless)\b/i;

const postLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });
const rsvpLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 });

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

app.post('/api/wall', postLimiter, (req, res) => {
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

app.post('/api/events/:id/rsvp', rsvpLimiter, (req, res) => {
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

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Heard.ke server listening on port ${PORT}`);
});
