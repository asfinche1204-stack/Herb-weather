// St. James Plantation calendar feed
// Logs into theclubsatstjames.com with a member login (env STJ_USER / STJ_PASS),
// discovers calendar items, reads each item's public .ics file, and serves
// GET /events.json  -> { ok, updated, events:[{id,title,start,end,type,course,url}] }
import express from 'express';

const BASE = 'https://www.theclubsatstjames.com';
const USER = process.env.STJ_USER, PASS = process.env.STJ_PASS;
const DAYS_AHEAD = +(process.env.DAYS_AHEAD || 60);
const REFRESH_MIN = +(process.env.REFRESH_MINUTES || 360);
const PORT = process.env.PORT || 10000;
const UA = 'Mozilla/5.0 (family weather app; contact owner)';

let cache = { ok:false, updated:null, error:'not loaded yet', events:[] };

// ---- tiny cookie jar ----
const jar = new Map();
const cookieHeader = () => [...jar].map(([k,v]) => `${k}=${v}`).join('; ');
function storeCookies(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  for (const c of raw) { const [kv] = c.split(';'); const i = kv.indexOf('='); if (i>0) jar.set(kv.slice(0,i).trim(), kv.slice(i+1).trim()); }
}
async function get(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Cookie: cookieHeader() }, redirect: 'manual' });
  storeCookies(r);
  if ([301,302,303].includes(r.status)) return get(new URL(r.headers.get('location'), url).href);
  return { status: r.status, text: await r.text(), url };
}

// ---- login: read the form, fill it, post it ----
async function login() {
  jar.clear();
  const page = await get(`${BASE}/club/scripts/login/login.asp`);
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
  if (!userField || !passField) throw new Error('Could not find login form fields');
  fields.set(userField, USER); fields.set(passField, PASS);
  const r = await fetch(new URL(action, page.url).href, {
    method: 'POST', redirect: 'manual',
    headers: { 'User-Agent': UA, Cookie: cookieHeader(), 'Content-Type': 'application/x-www-form-urlencoded', Referer: page.url },
    body: fields.toString()
  });
  storeCookies(r);
  // verify: a listing page must now contain event links
  const test = await get(dailyUrl(new Date()));
  if (!/view_club_calendarItem\.asp\?CID=/i.test(test.text) && /login\.asp/i.test(test.url)) throw new Error('Login did not stick (check STJ_USER / STJ_PASS)');
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
function classify(title) {
  const t = title.toLowerCase();
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
  const { type, course } = classify(title);
  return { id, title, start, end, category, type, course, url: `${BASE}/club/scripts/calendar/view_club_calendarItem.asp?CID=${id}` };
}

async function refresh() {
  try {
    if (!USER || !PASS) throw new Error('Set STJ_USER and STJ_PASS environment variables');
    await login();
    const ids = await discover();
    const items = [];
    for (const id of ids) { try { const it = await readItem(id); if (it) items.push(it); } catch(e){} }
    const golf = items.filter(i => /golf/i.test(i.category) || i.type !== 'event' || /golf|club\b|mga|lga|member.guest|scramble|tee/i.test(i.title));
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
app.get('/refresh', async (req,res) => { await refresh(); res.json({ ok:cache.ok, events:cache.events.length, error:cache.error }); });
app.get('/', (req,res) => res.send(`St. James calendar feed. ${cache.ok?cache.events.length+' events':'status: '+cache.error}. See /events.json`));
app.listen(PORT, () => { console.log('listening on '+PORT); refresh(); setInterval(refresh, REFRESH_MIN*60*1000); });
