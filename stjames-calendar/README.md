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
   - `STJ_COND_USER` / `STJ_COND_PASS` — login for the Daily Course Conditions page, if it differs from the calendar login
   - `STJ_COND_LOGIN_URL` — optional; the login page for that system if it isn't the main club login
   - `STJ_COND_PAGE_URL` — optional; the conditions page address if it isn't /member-home/daily-course-conditions
4. Deploy. Open `https://<service>.onrender.com/events.json` and confirm `"ok": true`.
5. In the weather app's `index.html`, set `STJ_FEED` to that URL.

The free plan sleeps after inactivity; the first load after a sleep takes ~30 s, and the
weather app simply shows the last saved list until the feed answers.

This uses Dad's own membership to read his own club calendar, at a handful of requests
every few hours. Keep the service private and don't share the URL publicly.


`/conditions.json` serves the Daily Course Conditions text; `/conditions-login-check` shows whether that login worked.


## Push notifications
The same service watches each subscribed location every 3 minutes and sends push notifications for
NWS alerts, rain starting within 30 minutes, lightning nearby (optional lightning proxy), and new Atlantic storms.

Add these environment variables (generated once for this app):
- `VAPID_PUBLIC` = `BM9CTwMVcgQBUJhXzlA5P7gCwDGwJO2i7zJXXFVEONpvuqDbUd1fg6pRYxdTkyHKuH-rciCI5tq2o0_kmzzOmzI`
- `VAPID_PRIVATE` = `7uXpEbPpWnHtYLjVOvAcCW8Be9tf_6khmWNtgk5LTYc`
- `VAPID_SUBJECT` = `mailto:your@email.com` (any contact address)

The public key is already embedded in index.html. Subscriptions are kept in memory and re-sent by the app
each time it opens, so a redeploy doesn't lose anyone for long. `/push/status` shows the subscriber count.
