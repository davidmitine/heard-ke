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
