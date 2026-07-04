# Heard.ke server

Backend for the anonymous Wall and Events/RSVP features.

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
