# Storm cell tracks for Skywatch
# Reads the free NWS Level III products from NOAA's public radar server and serves
#   GET /cells.json?site=LTX  -> storm cells with motion + forecast positions, TVS and mesocyclone detections
import io, math, re, time, threading
from datetime import datetime, timezone
import requests
from flask import Flask, jsonify, request
from metpy.io import Level3File

BASE = 'https://tgftp.nws.noaa.gov/SL.us008001/DF.of/DC.radar'
PRODUCTS = {'sti': 'DS.58sti', 'tvs': 'DS.61tvs', 'md': 'DS.141md'}
SITES = {  # radar site -> lat, lon (needed to turn azimuth/range into map positions)
    'LTX': (33.989, -78.429), 'MHX': (34.776, -76.876), 'RAX': (35.665, -78.490),
    'CLX': (32.655, -81.042), 'AKQ': (36.984, -77.007), 'CAE': (33.949, -81.118),
    'GSP': (34.883, -82.220), 'FCX': (37.024, -80.274)
}
CACHE, LOCK, TTL = {}, threading.Lock(), 120

def offset(lat, lon, az_deg, range_nm):
    """Great-circle point at azimuth/range from the radar."""
    R = 3440.065  # earth radius in nautical miles
    d = range_nm / R; az = math.radians(az_deg)
    la1, lo1 = math.radians(lat), math.radians(lon)
    la2 = math.asin(math.sin(la1)*math.cos(d) + math.cos(la1)*math.sin(d)*math.cos(az))
    lo2 = lo1 + math.atan2(math.sin(az)*math.sin(d)*math.cos(la1), math.cos(d) - math.sin(la1)*math.sin(la2))
    return round(math.degrees(la2), 4), round(math.degrees(lo2), 4)

def fetch_product(site, key):
    url = f"{BASE}/{PRODUCTS[key]}/SI.k{site.lower()}/sn.last"
    r = requests.get(url, timeout=15, headers={'User-Agent': 'skywatch storm tracks (family weather app)'})
    r.raise_for_status()
    return Level3File(io.BytesIO(r.content))

def tab_text(f):
    """All tabular-block text lines from a Level III product."""
    lines = []
    for page in getattr(f, 'tab_pages', []) or []:   # MetPy stores each page as one string
        lines.extend(str(page).split('\n'))
    return lines

AZRAN = r'(\d{1,3})/\s*(\d{1,3})'

def parse_sti(f, lat0, lon0):
    cells = {}
    in_forecast = False
    for ln in tab_text(f):
        up = ln.upper()
        # only read rows under the FORECAST POSITIONS table; ignore the past-positions / attributes pages
        if 'FORECAST' in up and 'POSITION' in up: in_forecast = True; continue
        if ('PAST' in up and 'POSITION' in up) or 'ATTRIBUTE' in up or 'AVERAGE' in up: in_forecast = False; continue
        if not in_forecast: continue
        m = re.match(r'\s*([A-Z]\d)\s+' + AZRAN + r'\s+(NEW|NO DATA|(\d{1,3})/\s*(\d{1,3}))\s*(.*)$', ln)
        if not m: continue
        sid = m.group(1); az, rng = int(m.group(2)), int(m.group(3))
        if rng == 0: continue
        la, lo = offset(lat0, lon0, az, rng)
        c = cells.setdefault(sid, {'id': sid, 'lat': la, 'lon': lo, 'az': az, 'rng_nm': rng, 'dir': None, 'spd_kt': None, 'fcst': []})
        if m.group(5):
            c['dir'] = int(m.group(5)); c['spd_kt'] = int(m.group(6))
        prev = (la, lo)
        for i, (a, r_) in enumerate(re.findall(AZRAN, m.group(7) or '')[:4]):
            a, r_ = int(a), int(r_)
            if r_ < 3: continue                      # sitting on the radar = a parse slip
            fla, flo = offset(lat0, lon0, a, r_)
            step = math.hypot((fla - prev[0]) * 60, (flo - prev[1]) * 60 * math.cos(math.radians(la)))
            if step > 25: break                      # >100 kt between 15-min points isn't a storm, it's bad data
            c['fcst'].append({'min': (i+1)*15, 'lat': fla, 'lon': flo}); prev = (fla, flo)
    return list(cells.values())

def parse_points(f, lat0, lon0, kind):
    out = []
    for ln in tab_text(f):
        # TVS:  "TVS  A0   231/ 33 ..."   MD: "  1   A0   231/ 33 ..." — grab id + first az/ran on lines that have both
        m = re.search(r'\b([A-Z]\d)\b.*?' + AZRAN, ln)
        if not m: continue
        if kind == 'tvs' and not re.search(r'\bE?TVS\b', ln): continue
        az, rng = int(m.group(2)), int(m.group(3))
        if rng == 0 and az == 0: continue
        la, lo = offset(lat0, lon0, az, rng)
        out.append({'id': m.group(1), 'lat': la, 'lon': lo, 'kind': kind})
    return out

def build(site):
    lat0, lon0 = SITES[site]
    res = {'ok': True, 'site': site, 'updated': datetime.now(timezone.utc).isoformat(), 'cells': [], 'tvs': [], 'meso': [], 'notes': []}
    try:
        f = fetch_product(site, 'sti'); res['cells'] = parse_sti(f, lat0, lon0)
        res['scan_time'] = f.metadata.get('vol_time', None) and f.metadata['vol_time'].isoformat()
    except Exception as e: res['notes'].append(f'sti: {e}')
    try: res['tvs'] = parse_points(fetch_product(site, 'tvs'), lat0, lon0, 'tvs')
    except Exception as e: res['notes'].append(f'tvs: {e}')
    try: res['meso'] = parse_points(fetch_product(site, 'md'), lat0, lon0, 'meso')
    except Exception as e: res['notes'].append(f'md: {e}')
    flagged = {p['id'] for p in res['tvs']} ; mesos = {p['id'] for p in res['meso']}
    for c in res['cells']:
        c['tvs'] = c['id'] in flagged; c['meso'] = c['id'] in mesos
    return res

app = Flask(__name__)

@app.after_request
def cors(resp):
    resp.headers['Access-Control-Allow-Origin'] = '*'; resp.headers['Cache-Control'] = 'no-cache'; return resp

@app.get('/cells.json')
def cells():
    site = (request.args.get('site') or 'LTX').upper()
    if site not in SITES: return jsonify({'ok': False, 'error': f'unknown site {site}', 'sites': sorted(SITES)}), 400
    with LOCK:
        hit = CACHE.get(site)
        if hit and time.time() - hit['t'] < TTL: return jsonify(hit['data'])
        data = build(site); CACHE[site] = {'t': time.time(), 'data': data}
    return jsonify(data)

@app.get('/raw.json')
def raw():
    """The product's tabular text, for checking the parser against what the radar actually sent."""
    site = (request.args.get('site') or 'LTX').upper(); key = request.args.get('product', 'sti')
    if site not in SITES or key not in PRODUCTS: return jsonify({'ok': False}), 400
    try: return jsonify({'ok': True, 'lines': tab_text(fetch_product(site, key))})
    except Exception as e: return jsonify({'ok': False, 'error': str(e)}), 502

@app.get('/')
def home():
    return 'Skywatch storm tracks. Try /cells.json?site=LTX'

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=10000)
