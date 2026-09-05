# St. James calendar feed

Private worker that reads The Clubs at St. James calendar with a member login and
publishes golf closures, aeration, and events as JSON for the Skywatch weather app.

## Deploy on Render (Web Service, not Static Site)
1. Put this folder in a GitHub repo (its own repo, or a subfolder with Root Directory set to `stjames-calendar`).
2. New → Web Service → connect the repo. Runtime: Node. Build: `npm install`. Start: `npm start`.
3. Environment variables:
   - `STJ_USER` — Dad's member username
   - `STJ_PASS` — Dad's member password
   - `DAYS_AHEAD` — optional, default 60
   - `REFRESH_MINUTES` — optional, default 360
4. Deploy. Open `https://<service>.onrender.com/events.json` and confirm `"ok": true`.
5. In the weather app's `index.html`, set `STJ_FEED` to that URL.

The free plan sleeps after inactivity; the first load after a sleep takes ~30 s, and the
weather app simply shows the last saved list until the feed answers.

This uses Dad's own membership to read his own club calendar, at a handful of requests
every few hours. Keep the service private and don't share the URL publicly.
