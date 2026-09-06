// St. James Plantation calendar feed
// Logs into theclubsatstjames.com with a member login (env STJ_USER / STJ_PASS),
// discovers calendar items, reads each item's public .ics file, and serves
// GET /events.json  -> { ok, updated, events:[{id,title,start,end,type,course,url}] }
import express from 'express';

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
app.use((req,res,next) => { res.set('Access-Control-Allow-Origin','*'); res.set('Cache-Control','no-cache'); next(); });
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
});
