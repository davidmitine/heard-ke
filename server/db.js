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
      `CREATE TABLE IF NOT EXISTS post_reports (
        post_id INTEGER NOT NULL,
        client_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        PRIMARY KEY (post_id, client_id)
      )`,
      `CREATE TABLE IF NOT EXISTS locker (
        code TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        text TEXT,
        attachment_base64 TEXT,
        attachment_content_type TEXT,
        ts INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS guide_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        section TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        url TEXT,
        position INTEGER NOT NULL DEFAULT 0,
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

  // ---- migration: Google Calendar sync tracking on events ----
  const eventCols = await tableColumns('events');
  if (!eventCols.includes('gcal_uid')) {
    // NULL for manually-created events; set for events synced in from Google
    // Calendar, so we know which ones to keep in sync (and which are safe to
    // edit/delete by hand). SQLite allows multiple NULLs under UNIQUE.
    await exec(`ALTER TABLE events ADD COLUMN gcal_uid TEXT`);
    await exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_events_gcal_uid ON events(gcal_uid)`);
  }

  const guideCount = (await get('SELECT COUNT(*) AS n FROM guide_items')).n;
  if (guideCount === 0) {
    const now = Date.now();
    const row = (section, title, body, url, position) => ({
      sql: 'INSERT INTO guide_items (section, title, body, url, position, ts) VALUES (?, ?, ?, ?, ?, ?)',
      args: [section, title, body, url, position, now]
    });
    await client.batch(
      [
        row(
          'advice',
          'Stress creeping up on you?',
          "Notice where you feel it in your body before it takes over: jaw, chest, shoulders. A few slow breaths (in for 4, hold for 4, out for 6) tells your body it's safe faster than trying to think your way out of it.",
          null,
          0
        ),
        row(
          'advice',
          "Angry and don't know where to put it?",
          'Anger is usually a cover for something softer: hurt, fear, feeling disrespected. Move first (walk, lift, hit a bag), then decide what to say. Almost nothing said in the first five minutes of anger holds up an hour later.',
          null,
          1
        ),
        row(
          'advice',
          'Not sleeping well?',
          "A racing mind at night is often the day's undealt-with stuff surfacing. Writing it down (even just a list, even in the Write tab) before bed can get it out of your head so it stops running in loops.",
          null,
          2
        ),
        row(
          'advice',
          'Struggling in a relationship?',
          "Most fights aren't about the dishes or being late. They're about feeling unseen. Try naming the feeling under the complaint out loud. It's uncomfortable, and it works better than arguing the surface issue.",
          null,
          3
        ),
        row(
          'advice',
          'When it feels like too much',
          "You don't have to have the words figured out. Call or text someone (a friend, a helpline, anyone) before you're sure what you'll say. The reaching out matters more than the script.",
          null,
          4
        ),
        row(
          'contact',
          'Heard.ke',
          'not urgent, but want someone to help point you toward support? Email us, any time. info@heard.co.ke',
          null,
          0
        ),
        row(
          'contact',
          'Kenya Red Cross Emergency Line',
          'for urgent medical or safety emergencies. 1199',
          null,
          1
        ),
        row(
          'contact',
          'National Police / Ambulance',
          'if you or someone else is in immediate danger. 999 or 112',
          null,
          2
        ),
        row('book', "Man's Search for Meaning", 'Viktor Frankl', null, 0),
        row('book', 'The Body Keeps the Score', 'Bessel van der Kolk', null, 1),
        row('book', 'No More Mr Nice Guy', 'Robert Glover', null, 2),
        row('book', 'Atlas of the Heart', 'Brené Brown', null, 3),
        row(
          'music',
          'Calming instrumental',
          'for winding down',
          'https://open.spotify.com/search/calming%20instrumental',
          0
        ),
        row(
          'music',
          'Lo-fi focus',
          'for getting things done',
          'https://open.spotify.com/search/lofi%20focus',
          1
        ),
        row(
          'music',
          'Afrobeat, chilled',
          'for lifting the mood',
          'https://open.spotify.com/search/afrobeat%20chill',
          2
        )
      ],
      'write'
    );
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
