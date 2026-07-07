# Heard.ke server

Backend for the anonymous Wall, Events/RSVP, and "send it to myself" email features.

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

Note: because the SQLite DB is on an ephemeral disk on free hosting tiers, the review
queue and moderation history can reset on redeploy/restart. Attach a persistent disk
(or move to a hosted database) before this matters.

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
Uses a local SQLite file (`heard.db`) — fine for early traffic, but note that
most free hosting tiers use ephemeral disks, so the DB may reset on redeploy/restart
unless you attach a persistent volume.

After deploying, update `API_BASE` in `index.html` to the server's public URL.
