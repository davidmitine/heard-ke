# Heard.ke server

Backend for the anonymous Wall, Events/RSVP, and "send it to myself" email features.

## Database (Turso)
Data is stored in [Turso](https://turso.tech), a hosted SQLite-compatible database, via
`@libsql/client`. This replaced a local SQLite file that lived on Render's disk, which
reset on every redeploy/restart — wall posts and RSVP contact info would vanish.

Env vars:
- `TURSO_DATABASE_URL` — from your Turso database, looks like `libsql://your-db-name-yourusername.turso.io`
- `TURSO_AUTH_TOKEN` — an auth token for that database

Without both set, the server falls back to a local file (`heard.db`) — fine for local
development, but back to the same reset-on-restart problem if deployed without these set.
Schema creation and migrations run automatically on startup either way.

## Meetups sync (Google Calendar)
Optional. The organizer can manage meetups directly in a Google Calendar instead of (or
alongside) the admin dashboard's manual form. It's a one-way sync — Google Calendar to
our `events` table — refreshed every 10 minutes and on-demand via a "Sync Google
Calendar" button in `admin.html`. Requires no OAuth: it reads the calendar's public
iCal feed.

Env var:
- `GOOGLE_CALENDAR_ICS_URL` — the calendar's public iCal URL (Google Calendar →
  calendar settings → "Integrate calendar" → "Public URL to this calendar"). The
  calendar must have "Make available to public" → "See all event details" turned on.

Events synced from Google Calendar are tagged internally (`gcal_uid`) and shown with a
"Google Calendar" badge in the admin dashboard — Edit/Delete are disabled for them there
since Google Calendar is the source of truth; edit or delete the event in Google
Calendar itself and it'll sync in on the next refresh. Manually-added events (via the
admin "+ Add a meetup" form) are untouched by sync and keep working exactly as before,
side by side with synced ones. Recurring events (weekly, etc.) are expanded into
individual occurrences up to 180 days out. RSVPs work identically on synced and manual
events; nothing about the public site or RSVP flow changes.

If `GOOGLE_CALENDAR_ICS_URL` isn't set, this feature is simply inactive — the admin
dashboard says so, and everything else works as before.

## Email sending (Resend)
Set these env vars to enable "send it to myself" emails:
- `RESEND_API_KEY` — from resend.com
- `MAIL_FROM` — sender address, e.g. `Heard.ke <noreply@heard.co.ke>` (requires verifying
  your domain in Resend). Without a verified domain, Resend's default
  `onboarding@resend.dev` sender only delivers to the email address you signed up with.
If `RESEND_API_KEY` isn't set, the endpoint returns 503 and the frontend falls back to
a local download automatically.

## Wall moderation
Every wall post is held for review and only appears publicly once approved on `admin.html`.

Env vars:
- `ADMIN_KEY` — required to use the review page. Set a long random string. The reviewer
  enters it once on `admin.html`; it is stored in that browser only. Without it, the
  admin API returns 503 and nothing can be reviewed (so posts stay pending forever).
- `OPENAI_API_KEY` — optional. Enables pre-screening via OpenAI's free moderation
  endpoint (`omni-moderation-latest`). Outward harm (hate, threats, violence, sexual)
  is auto-rejected so the reviewer never has to read it. All self-harm and distress
  content is deliberately allowed through to the pending queue, flagged for careful
  review. If unset, every post simply goes to pending (still safe — nothing is public
  without approval), just without pre-sorting.
- `MODERATOR_EMAIL` — where review alerts are sent (defaults to davidmitine@gmail.com).
  Requires `RESEND_API_KEY` to be set for alerts to send.
- `ADMIN_URL` — link included in alert emails (defaults to https://www.heard.co.ke/admin.html).

Community reports: a public post pulled back to pending after 2 reports, and the
reviewer is alerted.

## Run locally
```
cd server
npm install
npm start
```
Server listens on port 4000 by default (set `PORT` to change).
Set `CLIENT_ORIGIN` to your deployed frontend URL for CORS in production.

## Deploy
Deploy this folder to Render.com (or Railway) as a Node web service.
Build command: `npm install`. Start command: `npm start`.
Set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` so data survives redeploys.

After deploying, update `API_BASE` in `index.html` to the server's public URL.
