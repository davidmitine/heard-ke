const { createClient } = require('@libsql/client');
const path = require('path');

// TURSO_DATABASE_URL/TURSO_AUTH_TOKEN point at a hosted Turso database in
// production. Locally, with neither set, this falls back to a plain file on
// disk (libSQL speaks the same protocol either way), so the app runs the
// same way whether or not Turso credentials are present.
const url = process.env.TURSO_DATABASE_URL || `file:${path.join(__dirname, 'heard.db')}`;
const authToken = process.env.TURSO_AUTH_TOKEN;

const client = createClient(authToken ? { url, authToken } : { url });

async function run(sql, args = []) {
  const result = await client.execute({ sql, args });
  return {
    lastInsertRowid: Number(result.lastInsertRowid ?? 0),
    changes: result.rowsAffected
  };
}
async function get(sql, args = []) {
  const result = await client.execute({ sql, args });
  return result.rows[0];
}
async function all(sql, args = []) {
  const result = await client.execute({ sql, args });
  return result.rows;
}
async function exec(sql) {
  await client.execute(sql);
}
async function tableColumns(table) {
  const result = await client.execute(`PRAGMA table_info(${table})`);
  return result.rows.map((r) => r.name);
}

async function migrate() {
  await client.batch(
    [
      `CREATE TABLE IF NOT EXISTS posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        ts INTEGER NOT NULL,
        flagged INTEGER NOT NULL DEFAULT 0,
        reports INTEGER NOT NULL DEFAULT 0,
        hidden INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        location TEXT NOT NULL,
        datetime INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS rsvps (
        event_id INTEGER NOT NULL,
        client_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        PRIMARY KEY (event_id, client_id)
      )`,
      `CREATE TABLE IF NOT EXISTS locker (
        code TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        text TEXT,
        attachment_base64 TEXT,
        attachment_content_type TEXT,
        ts INTEGER NOT NULL
      )`
    ],
    'write'
  );

  // ---- migration: moderation queue columns on posts ----
  const postCols = await tableColumns('posts');
  if (!postCols.includes('status')) {
    // status: 'pending' (awaiting review) | 'approved' (public) | 'rejected'
    await exec(`ALTER TABLE posts ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'`);
    // any posts that existed before moderation were already public, so keep them visible
    await exec(`UPDATE posts SET status = 'approved' WHERE hidden = 0`);
    await exec(`UPDATE posts SET status = 'rejected' WHERE hidden = 1`);
  }
  if (!postCols.includes('ai_result')) {
    // JSON string of the moderation categories that fired, or null if not checked
    await exec(`ALTER TABLE posts ADD COLUMN ai_result TEXT`);
  }

  // ---- migration: contact info on rsvps, so the organizer can follow up ----
  const rsvpCols = await tableColumns('rsvps');
  if (!rsvpCols.includes('phone')) {
    await exec(`ALTER TABLE rsvps ADD COLUMN phone TEXT`);
  }
  if (!rsvpCols.includes('email')) {
    await exec(`ALTER TABLE rsvps ADD COLUMN email TEXT`);
  }

  const eventCount = (await get('SELECT COUNT(*) AS n FROM events')).n;
  if (eventCount === 0) {
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    await client.batch(
      [
        {
          sql: 'INSERT INTO events (title, description, location, datetime) VALUES (?, ?, ?, ?)',
          args: [
            'Saturday morning run',
            'Easy 5k, no pace pressure. Coffee after for anyone who wants to stick around.',
            'Karura Forest, Nairobi',
            now + 6 * day
          ]
        },
        {
          sql: 'INSERT INTO events (title, description, location, datetime) VALUES (?, ?, ?, ?)',
          args: [
            'Fire & football night',
            "Watch the match, sit by the fire, talk if you feel like it — or don't.",
            'Ngong Road grounds',
            now + 10 * day
          ]
        },
        {
          sql: 'INSERT INTO events (title, description, location, datetime) VALUES (?, ?, ?, ?)',
          args: [
            'Games night',
            'Cards, board games, low-key hangout. Bring a friend or come alone.',
            'Westlands community hall',
            now + 14 * day
          ]
        }
      ],
      'write'
    );
  }
}

module.exports = { get, all, run, exec, migrate };
