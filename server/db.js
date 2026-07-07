const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'heard.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    ts INTEGER NOT NULL,
    flagged INTEGER NOT NULL DEFAULT 0,
    reports INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    location TEXT NOT NULL,
    datetime INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rsvps (
    event_id INTEGER NOT NULL,
    client_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    PRIMARY KEY (event_id, client_id)
  );

  CREATE TABLE IF NOT EXISTS locker (
    code TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    text TEXT,
    attachment_base64 TEXT,
    attachment_content_type TEXT,
    ts INTEGER NOT NULL
  );
`);

// ---- migration: moderation queue columns on posts ----
const postCols = db.prepare('PRAGMA table_info(posts)').all().map((c) => c.name);
if (!postCols.includes('status')) {
  // status: 'pending' (awaiting review) | 'approved' (public) | 'rejected'
  db.exec(`ALTER TABLE posts ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'`);
  // any posts that existed before moderation were already public, so keep them visible
  db.exec(`UPDATE posts SET status = 'approved' WHERE hidden = 0`);
  db.exec(`UPDATE posts SET status = 'rejected' WHERE hidden = 1`);
}
if (!postCols.includes('ai_result')) {
  // JSON string of the moderation categories that fired, or null if not checked
  db.exec(`ALTER TABLE posts ADD COLUMN ai_result TEXT`);
}

const eventCount = db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
if (eventCount === 0) {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const seed = db.prepare(
    'INSERT INTO events (title, description, location, datetime) VALUES (?, ?, ?, ?)'
  );
  const insertMany = db.transaction((rows) => {
    for (const r of rows) seed.run(r.title, r.description, r.location, r.datetime);
  });
  insertMany([
    {
      title: 'Saturday morning run',
      description: 'Easy 5k, no pace pressure. Coffee after for anyone who wants to stick around.',
      location: 'Karura Forest, Nairobi',
      datetime: now + 6 * day
    },
    {
      title: 'Fire & football night',
      description: 'Watch the match, sit by the fire, talk if you feel like it — or don\'t.',
      location: "Ngong Road grounds",
      datetime: now + 10 * day
    },
    {
      title: 'Games night',
      description: 'Cards, board games, low-key hangout. Bring a friend or come alone.',
      location: 'Westlands community hall',
      datetime: now + 14 * day
    }
  ]);
}

module.exports = db;
