// St. James Plantation calendar feed
// Logs into theclubsatstjames.com with a member login (env STJ_USER / STJ_PASS),
// discovers calendar items, reads each item's public .ics file, and serves
// GET /events.json  -> { ok, updated, events:[{id,title,start,end,type,course,url}] }
import express from 'express';
import webpush from 'web-push';
import fs from 'fs';

const BASE = 'https://www.theclubsatstjames.com';
const USER = process.env.STJ_USER, PASS = process.env.STJ_PASS;
// separate login for the Daily Course Conditions page (falls back to the calendar login if not set)
const COND_USER = process.env.STJ_COND_USER || USER, COND_PASS = process.env.STJ_COND_PASS || PASS;
const COND_LOGIN = process.env.STJ_COND_LOGIN_URL || `${BASE}/club/scripts/login/login.asp`;
const COND_PAGE  = process.env.STJ_COND_PAGE_URL  || `${BASE}/member-home/daily-course-conditions`;
const DAYS_AHEAD = +(process.env.DAYS_AHEAD || 60);
const REFRESH_MIN = +(process.env.REFRESH_MINUTES || 360);
const PORT = process.env.PORT || 10000;
const UA = 'Mozilla/5.0 (family weather app; contact owner)';

let cache = { ok:false, updated:null, error:'not loaded yet', events:[] };

// ================= push notifications =================
const VAPID_PUBLIC = process.env.VAPID_PUBLIC, VAPID_PRIVATE = process.env.VAPID_PRIVATE, VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:skywatch@example.com';
const PUSH_OK = !!(VAPID_PUBLIC && VAPID_PRIVATE);
if (PUSH_OK) webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
const SUBS_FILE = '/tmp/skywatch-subs.json';
let subs = []; try { subs = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')); } catch(e) {}
const saveSubs = () => { try { fs.writeFileSync(SUBS_FILE, JSON.stringify(subs)); } catch(e) {} };
const seen = new Map();   // endpoint -> { alertIds:Set, rainUntil, lxUntil, storms:Set }
const state = ep => { if (!seen.has(ep)) seen.set(ep, { alertIds:new Set(), rainUntil:0, lxUntil:0, storms:new Set() }); return seen.get(ep); };
async function send(sub, payload) {
  try { await webpush.sendNotification(sub.subscription, JSON.stringify(payload)); return true; }
  catch(e) { if (e.statusCode === 404 || e.statusCode === 410) { subs = subs.filter(s => s.subscription.endpoint !== sub.subscription.endpoint); saveSubs(); } else console.error('push failed', e.statusCode || e.message); return false; }
}
const fmtTime = iso => new Date(iso).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit', timeZone:'America/New_York' });
async function jget(url, headers={}) { const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers } }); if (!r.ok) throw new Error(url+' '+r.status); return r.json(); }

async function checkAlerts(sub, st) {
  const j = await jget(`https://api.weather.gov/alerts/active?status=actual&point=${sub.lat.toFixed(4)},${sub.lon.toFixed(4)}`, { Accept:'application/geo+json' });
  for (const f of j.features || []) {
    const p = f.properties; if (st.alertIds.has(p.id)) continue; st.alertIds.add(p.id);
    if (st.alertIds.size > 200) st.alertIds = new Set([...st.alertIds].slice(-100));
    if (!st.primed) continue;   // don't replay alerts that were already active when notifications were turned on
    await send(sub, { title: `${p.event} \u2014 ${sub.name}`, body: (p.headline || '').slice(0, 180) || `Until ${p.ends ? fmtTime(p.ends) : 'further notice'}`, tag: 'alert-'+p.id, url:'./' });
  }
  st.primed = true;
}
async function checkRain(sub, st) {
  if (Date.now() < st.rainUntil) return;
  const j = await jget(`https://api.open-meteo.com/v1/forecast?latitude=${sub.lat}&longitude=${sub.lon}&minutely_15=precipitation&forecast_minutely_15=8&timezone=auto&precipitation_unit=inch`);
  const p = j.minutely_15 && j.minutely_15.precipitation || [];
  const now = p[0] || 0, soon = p.slice(1, 3).reduce((a,b) => a+b, 0);
  if (now < 0.005 && soon >= 0.02) {
    const heavy = soon >= 0.15;
    await send(sub, { title: `${heavy ? 'Heavy rain' : 'Rain'} starting soon \u2014 ${sub.name}`, body: `About ${soon.toFixed(2)}" expected in the next 30 minutes.`, tag:'rain', url:'./' });
    st.rainUntil = Date.now() + 90*60000;   // one heads-up per hour and a half
  }
}
// ---- lightning: keep a rolling 15 minutes of Blitzortung strikes in memory (same community feed the app uses) ----
const LX_HOSTS = ['wss://ws1.blitzortung.org:3000','wss://ws7.blitzortung.org:3000','wss://ws8.blitzortung.org:3000'];
let lxStrikes = [], lxSock = null, lxHost = 0;
function lxDecode(b) { const e = {}, d = b.split(''); let c = d[0], f = c; const g = [c]; let h = 256, o = 256, a; for (let i = 1; i < d.length; i++) { a = d[i].charCodeAt(0); a = h > a ? d[i] : (e[a] ? e[a] : f + c); g.push(a); c = a.charAt(0); e[o] = f + c; o++; f = a; } return g.join(''); }
function lxConnect() {
  if (typeof WebSocket === 'undefined' || lxSock) return;
  try {
    lxSock = new WebSocket(LX_HOSTS[lxHost++ % LX_HOSTS.length]);
    lxSock.onopen = () => lxSock.send(JSON.stringify({ a:111 }));
    lxSock.onmessage = ev => { try { const j = JSON.parse(lxDecode(String(ev.data))); if (typeof j.lat === 'number' && j.lat > 20 && j.lat < 50 && j.lon > -100 && j.lon < -60) { lxStrikes.push({ lat:j.lat, lon:j.lon, t: j.time ? j.time/1e6 : Date.now() }); if (lxStrikes.length > 50000) lxStrikes.splice(0, 20000); } } catch(e) {} };
    lxSock.onclose = () => { lxSock = null; setTimeout(lxConnect, 15000); };
    lxSock.onerror = () => { try { lxSock.close(); } catch(e) {} };
  } catch(e) { lxSock = null; setTimeout(lxConnect, 30000); }
}
const miles = (a,b,c,d) => { const R=3958.8, toR=x=>x*Math.PI/180, dl=toR(c-a), dg=toR(d-b); const s=Math.sin(dl/2)**2+Math.cos(toR(a))*Math.cos(toR(c))*Math.sin(dg/2)**2; return 2*R*Math.asin(Math.sqrt(s)); };
async function checkLightning(sub, st) {
  if (Date.now() < st.lxUntil) return;
  const cutoff = Date.now() - 10*60000; lxStrikes = lxStrikes.filter(x => x.t > Date.now() - 15*60000);
  let count = 0, nearest = Infinity;
  for (const x of lxStrikes) { if (x.t < cutoff) continue; const d = miles(sub.lat, sub.lon, x.lat, x.lon); if (d <= 15) { count++; if (d < nearest) nearest = d; } }
  if (count >= 2) {
    await send(sub, { title: `Lightning nearby \u2014 ${sub.name}`, body: `${count} strikes within 15 miles in the last 10 minutes. Nearest ${nearest < 1 ? 'under 1' : Math.round(nearest)} mi.`, tag:'lightning', url:'./' });
    st.lxUntil = Date.now() + 45*60000;
  }
}
let stormsSeen = new Set(), stormsPrimed = false;
async function checkTropics(list) {
  let storms = [];
  try { const j = await jget('https://www.nhc.noaa.gov/CurrentStorms.json'); storms = (j.activeStorms || []).filter(s => (s.id||'').toLowerCase().startsWith('al')); } catch(e) { return; }
  const fresh = storms.filter(s => !stormsSeen.has(s.id)); storms.forEach(s => stormsSeen.add(s.id));
  if (!stormsPrimed) { stormsPrimed = true; return; }
  for (const s of fresh) for (const sub of list) await send(sub, { title: `${s.classification==='HU'?'Hurricane':s.classification==='TS'?'Tropical Storm':'Tropical system'} ${s.name}`, body: `Now active in the Atlantic \u2014 open Skywatch to see distance and the cone.`, tag:'storm-'+s.id, url:'./' });
}
async function pushLoop() {
  if (!PUSH_OK || !subs.length) return;
  const tropicsSubs = subs.filter(s => s.prefs && s.prefs.tropics);
  for (const sub of subs) {
    const st = state(sub.subscription.endpoint);
    try { if (sub.prefs.alerts) await checkAlerts(sub, st); } catch(e) { console.error('alerts', e.message); }
    try { if (sub.prefs.rain) await checkRain(sub, st); } catch(e) { console.error('rain', e.message); }
    try { if (sub.prefs.lightning) await checkLightning(sub, st); } catch(e) { console.error('lightning', e.message); }
  }
  if (tropicsSubs.length) await checkTropics(tropicsSubs);
}

let conditions = { ok:false, updated:null, error:'not loaded yet', text:'', lines:[] };

// ---- daily course conditions page (members only) ----
const DINING = /\b(aces|pantry|grill|grille|restaurant|bar\b|bistro|cafe|dining|lunch|dinner|brunch|breakfast|happy hour|pool|tennis|pickleball|fitness|wellness|spa|service|kitchen|patio|tavern|lounge|market)\b/i;
function htmlToLines(html) {
  let h = html.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<!--[\s\S]*?-->/g,' ')
              .replace(/<(header|footer)\b[\s\S]*?<\/\1>/gi,' ');
  h = h.replace(/<br\s*\/?>/gi,'\n').replace(/<\/(p|div|li|tr|h[1-6]|td|th|section|article|ul|table|a|span)>/gi,'\n').replace(/<[^>]*>/g,' ')
       .replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&#39;|&rsquo;|&lsquo;/g,"'").replace(/&quot;|&ldquo;|&rdquo;/g,'"').replace(/&#\d+;|&[a-z]+;/gi,' ');
  const all = h.split('\n').map(l => l.replace(/\s+/g,' ').trim()).filter(l => l && !/^[\W_]+$/.test(l));
  // start at the page's own "Course Conditions" heading (the LAST short line saying so, after the menu copies)
  let start = -1; all.forEach((l,i) => { if (/^(daily )?course conditions$/i.test(l)) start = i; });
  if (start < 0) all.forEach((l,i) => { if (/pin placement/i.test(l) && start < 0) start = i - 1; });
  if (start < 0) start = 0;
  let end = all.findIndex((l,i) => i > start && /privacy policy|all rights reserved|©|powered by|back to top|site map|log out|logout|contact us$/i.test(l));
  if (end < 0) end = all.length;
  let lines = all.slice(start, end).filter((l,i,a) => l !== a[i-1]);
  // drop menu-looking leftovers right after the heading (short single words with no punctuation, before the first real line)
  const firstReal = lines.findIndex((l,i) => i > 0 && /[#:\-–]|\d/.test(l));
  if (firstReal > 1) lines = [lines[0]].concat(lines.slice(firstReal - 1));
  return { lines, all };
}
async function refreshConditions() {
  try {
    if (!condJar.size) await loginConditions();
    let r = await get(COND_PAGE, condJar);
    if (/login/i.test(r.url) || /type=["']?password/i.test(r.text)) { await loginConditions(); r = await get(COND_PAGE, condJar); }
    if (/type=["']?password/i.test(r.text)) throw new Error('got the login page instead of conditions — login not accepted');
    const { lines, all } = htmlToLines(r.text);
    if (!lines.length) throw new Error('page had no readable text');
    conditions = { ok:true, updated:new Date().toISOString(), lines, text: lines.join('\n'), _all: all.slice(0, 400) };
    console.log(`conditions: ${lines.length} lines`);
  } catch(e) { conditions = { ...conditions, ok:false, error:e.message, updated:new Date().toISOString() }; console.error('conditions failed:', e.message); }
}

// ---- tiny cookie jars (one per login) ----
const jar = new Map(), condJar = new Map();
const cookieHeader = (j=jar) => [...j].map(([k,v]) => `${k}=${v}`).join('; ');
function storeCookies(res, j=jar) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  for (const c of raw) { const [kv] = c.split(';'); const i = kv.indexOf('='); if (i>0) j.set(kv.slice(0,i).trim(), kv.slice(i+1).trim()); }
}
async function get(url, j=jar) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Cookie: cookieHeader(j) }, redirect: 'manual' });
  storeCookies(r, j);
  if ([301,302,303].includes(r.status)) return get(new URL(r.headers.get('location'), url).href, j);
  return { status: r.status, text: await r.text(), url };
}

// ---- login: read the form, fill it, post it ----
let loginDiag = {}, condDiag = {};
async function login() { return loginWith(jar, `${BASE}/club/scripts/login/login.asp`, USER, PASS, `${BASE}/member-home`, d => loginDiag = d); }
async function loginConditions() { return loginWith(condJar, COND_LOGIN, COND_USER, COND_PASS, COND_PAGE, d => condDiag = d); }
async function loginWith(j, loginUrl, user, pass, verifyUrl, saveDiag) {
  j.clear(); const diag = { at: new Date().toISOString(), loginUrl }; saveDiag(diag);
  const USERv = user, PASSv = pass;
  const page = await get(loginUrl, j);
  const formMatch = page.text.match(/<form[^>]*>[\s\S]*?<\/form>/gi) || [];
  const form = formMatch.find(f => /type=["']?password/i.test(f)) || '';
  const action = (form.match(/action=["']([^"']+)/i) || [,'/club/scripts/login/login.asp'])[1];
  const fields = new URLSearchParams();
  let userField = null, passField = null;
  for (const inp of form.match(/<input[^>]*>/gi) || []) {
    const name = (inp.match(/name=["']([^"']+)/i) || [])[1]; if (!name) continue;
    const type = ((inp.match(/type=["']([^"']+)/i) || [])[1] || 'text').toLowerCase();
    const value = (inp.match(/value=["']([^"']*)/i) || [,''])[1];
    if (type === 'password') { passField = name; continue; }
    if (type === 'text' || type === 'email') { if (!userField) { userField = name; continue; } }
    if (type === 'submit' || type === 'button' || type === 'image') continue;
    if (type === 'checkbox' && !/checked/i.test(inp)) continue;
    fields.set(name, value);
  }
  diag.formFound = !!form; diag.action = action; diag.userField = userField; diag.passField = passField; diag.otherFields = [...fields.keys()];
  diag.inputs = (form.match(/<input[^>]*>/gi) || []).map(i => i.replace(/value=["'][^"']*["']/i, 'value=…').slice(0, 160));
  if (!userField || !passField) throw new Error('Could not find login form fields');
  fields.set(userField, USERv); fields.set(passField, PASSv);
  const r = await fetch(new URL(action, page.url).href, {
    method: 'POST', redirect: 'manual',
    headers: { 'User-Agent': UA, Cookie: cookieHeader(j), 'Content-Type': 'application/x-www-form-urlencoded', Referer: page.url },
    body: fields.toString()
  });
  storeCookies(r, j);
  diag.postStatus = r.status; diag.postLocation = r.headers.get('location'); diag.cookies = [...j.keys()];
  // verify against a members-only page: it must NOT show the login form
  const test = await get(verifyUrl, j);
  const looksLoggedIn = /log\s*out|logout|sign\s*out/i.test(test.text) && !/type=["']?password/i.test(test.text);
  diag.verifyUrl = test.url; diag.loggedIn = looksLoggedIn;
  if (!looksLoggedIn) throw new Error('Login did not stick (check the username/password; see /login-check or /conditions-login-check)');
}
const mdy = d => `${d.getMonth()+1}/${d.getDate()}/${d.getFullYear()}`;
const dailyUrl = d => `${BASE}/club/scripts/calendar/daily.asp?GRP=0&d=${mdy(d)}&s=1`;

// ---- discover item IDs over the window ----
async function discover() {
  const ids = new Set();
  // try month views first (fewer requests), fall back to day-by-day
  const months = new Set();
  for (let i=0;i<=DAYS_AHEAD;i+=28) { const d = new Date(); d.setDate(d.getDate()+i); months.add(`${d.getMonth()+1}/1/${d.getFullYear()}`); }
  let monthWorked = false;
  for (const m of months) {
    for (const path of ['calendar.asp','month.asp','monthly.asp']) {
      try {
        const r = await get(`${BASE}/club/scripts/calendar/${path}?GRP=0&d=${m}`);
        const found = [...r.text.matchAll(/CID=(\d+)/g)].map(x => x[1]);
        if (found.length) { found.forEach(id => ids.add(id)); monthWorked = true; break; }
      } catch(e){}
    }
  }
  if (!monthWorked) {
    for (let i=0;i<=DAYS_AHEAD;i++) {
      const d = new Date(); d.setDate(d.getDate()+i);
      try { const r = await get(dailyUrl(d)); [...r.text.matchAll(/CID=(\d+)/g)].forEach(x => ids.add(x[1])); } catch(e){}
    }
  }
  return [...ids];
}

// ---- read each item's public ICS ----
const COURSES = ['Founders','Members','Players','Reserve'];
function classify(title, category='') {
  const t = title.toLowerCase();
  if (DINING.test(t) && !/golf/i.test(category)) return { type: 'event', course: '' };
  const type = /aerat|aerif|verticut|topdress|sand/.test(t) ? 'aeration'
    : /closed|closure|cart path|no carts/.test(t) ? 'closure'
    : /maint|overseed|sprig|fertil|spray/.test(t) ? 'maint'
    : /open/.test(t) ? 'open' : 'event';
  const course = COURSES.find(c => t.includes(c.toLowerCase())) || '';
  return { type, course };
}
async function readItem(id) {
  const r = await fetch(`${BASE}/club/scripts/calendar/Calendar_outlook.asp?CID=${id}&type=ICS`, { headers: { 'User-Agent': UA } });
  if (!r.ok) return null;
  const txt = (await r.text()).replace(/\r?\n[ \t]/g, '');
  const pick = k => { const m = txt.match(new RegExp(`^${k}[^:]*:(.*)$`, 'mi')); return m ? m[1].trim() : ''; };
  const dt = v => { const m = v.match(/(\d{4})(\d{2})(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : ''; };
  const title = pick('SUMMARY').replace(/=0D=0A/g,' ').replace(/\\,/g, ',');
  const desc = pick('DESCRIPTION');
  const category = (desc.match(/Category:\s*([^\\\n]+)/i) || [,''])[1].trim();
  const start = dt(pick('DTSTART')); let end = dt(pick('DTEND')) || start;
  // all-day items end at midnight of the next day; pull back one day
  if (/T0[0-4]0000Z/.test(pick('DTEND')) && end > start) { const e = new Date(end+'T12:00'); e.setDate(e.getDate()-1); end = e.toISOString().slice(0,10); }
  if (!title || !start) return null;
  const { type, course } = classify(title, category);
  return { id, title, start, end, category, type, course, url: `${BASE}/club/scripts/calendar/view_club_calendarItem.asp?CID=${id}` };
}

async function refresh() {
  try {
    if (!USER || !PASS) throw new Error('Set STJ_USER and STJ_PASS environment variables');
    try { await login(); } catch(e) { console.error('login:', e.message); }
    const ids = await discover();
    const items = [];
    for (const id of ids) { try { const it = await readItem(id); if (it) items.push(it); } catch(e){} }
    const golf = items.filter(i => /golf/i.test(i.category) || (!DINING.test(i.title) && (i.type !== 'event' || /golf|mga|lga|wga|member.guest|scramble|tee|shotgun|tournament|invitational/i.test(i.title))));
    golf.sort((a,b) => a.start.localeCompare(b.start));
    cache = { ok:true, updated:new Date().toISOString(), scanned: ids.length, events: golf };
    console.log(`refreshed: ${ids.length} items scanned, ${golf.length} golf items kept`);
  } catch(e) {
    cache = { ...cache, ok:false, error: e.message, updated: new Date().toISOString() };
    console.error('refresh failed:', e.message);
  }
}

const app = express();
app.use((req,res,next) => { res.set('Access-Control-Allow-Origin','*'); res.set('Access-Control-Allow-Headers','Content-Type'); res.set('Access-Control-Allow-Methods','GET,POST,OPTIONS'); res.set('Cache-Control','no-cache'); if (req.method==='OPTIONS') return res.sendStatus(204); next(); });
app.use(express.json({ limit:'64kb' }));
app.get('/push/status', (req,res) => res.json({ ok:PUSH_OK, subscribers: subs.length, publicKey: VAPID_PUBLIC || null }));
app.post('/push/subscribe', (req,res) => {
  if (!PUSH_OK) return res.status(503).json({ ok:false, error:'VAPID keys not set' });
  const b = req.body || {}; if (!b.subscription || !b.subscription.endpoint || typeof b.lat !== 'number') return res.status(400).json({ ok:false });
  const rec = { subscription:b.subscription, lat:b.lat, lon:b.lon, name:(b.name||'your location').slice(0,80), prefs:{ alerts:!!(b.prefs||{}).alerts, rain:!!(b.prefs||{}).rain, lightning:!!(b.prefs||{}).lightning, tropics:!!(b.prefs||{}).tropics }, edition:b.edition||'', updated:new Date().toISOString() };
  const i = subs.findIndex(s => s.subscription.endpoint === b.subscription.endpoint);
  if (i >= 0) { if (!b.keep) { const old = seen.get(b.subscription.endpoint); if (old && (subs[i].lat !== rec.lat || subs[i].lon !== rec.lon)) { old.alertIds.clear(); old.primed = false; } } subs[i] = rec; } else subs.push(rec);
  saveSubs(); res.json({ ok:true, subscribers: subs.length });
});
app.post('/push/unsubscribe', (req,res) => { const ep = (req.body||{}).endpoint; subs = subs.filter(s => s.subscription.endpoint !== ep); seen.delete(ep); saveSubs(); res.json({ ok:true }); });
app.post('/push/test', async (req,res) => { const sub = subs.find(s => s.subscription.endpoint === (req.body||{}).endpoint); if (!sub) return res.status(404).json({ ok:false }); const ok = await send(sub, { title:'Skywatch test', body:`Notifications are working for ${sub.name}.`, tag:'test', url:'./' }); res.json({ ok }); });
app.get('/events.json', (req,res) => res.json(cache));
app.get('/conditions.json', (req,res) => { const { _all, ...pub } = conditions; res.json(pub); });
app.get('/login-check', async (req,res) => { try { await login(); } catch(e) { loginDiag.error = e.message; } res.json(loginDiag); });
app.get('/conditions-login-check', async (req,res) => { try { await loginConditions(); } catch(e) { condDiag.error = e.message; } res.json(condDiag); });
app.get('/conditions-raw.json', (req,res) => res.json({ ok:conditions.ok, all:conditions._all || [] }));   // every text line on the page, for tuning the trim
app.get('/refresh-conditions', async (req,res) => { await refreshConditions(); res.json({ ok:conditions.ok, lines:conditions.lines.length, error:conditions.error }); });
app.get('/refresh', async (req,res) => { await refresh(); res.json({ ok:cache.ok, events:cache.events.length, error:cache.error }); });
app.get('/', (req,res) => res.send(`St. James calendar feed. ${cache.ok?cache.events.length+' events':'status: '+cache.error}. See /events.json`));
app.listen(PORT, () => {
  console.log('listening on '+PORT);
  refresh().then(refreshConditions);
  setInterval(refresh, REFRESH_MIN*60*1000);
  setInterval(refreshConditions, 2*60*60*1000);   // course conditions change each morning; check every 2 hours
  if (PUSH_OK) { lxConnect(); pushLoop(); setInterval(pushLoop, 3*60*1000); console.log('push watcher on'); } else console.log('push watcher off (set VAPID_PUBLIC / VAPID_PRIVATE)');
});
