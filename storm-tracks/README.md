# Storm tracks worker

Reads the National Weather Service storm-tracking (STI), tornado vortex signature (TVS)
and mesocyclone (MD) products from NOAA's public radar server and serves them as JSON
for the Skywatch radar map. No login or API key.

## Deploy on Render (Web Service)
1. Put this folder in the repo (e.g. `storm-tracks/`).
2. New → Web Service → same repo.
   - Root Directory: `storm-tracks`
   - Runtime: Python
   - Build Command: `pip install -r requirements.txt`
   - Start Command: `gunicorn app:app --bind 0.0.0.0:$PORT --workers 1 --threads 4`
3. Deploy, then open `https://<service>.onrender.com/cells.json?site=LTX` and confirm `"ok": true`.
4. In `index.html`, set `STORM_FEED` to `https://<service>.onrender.com`.

Results are cached for two minutes per radar site. Sites supported: LTX, MHX, RAX, CLX, AKQ, CAE, GSP, FCX.
