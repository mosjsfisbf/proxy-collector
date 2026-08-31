const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 8080;
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || "";
const MAX_PROXIES = Math.max(1, Math.min(100, Number(process.env.MAX_PROXIES) || 25));
const CYCLE_REST_MS = Number(process.env.CYCLE_REST_MS) || 60 * 1000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const CURRENT_FILE = path.join(DATA_DIR, "current.json");

const IR = "IR";
const GEO_BATCH_ENDPOINT = "http://ip-api.com/batch";
const GLOBAL_SCAN_CAP = 600;

const TEXT_SOURCES = [
  { url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt", name: "thespeedx" },
  { url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt", name: "monosans" },
  { url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies_anonymous/http.txt", name: "monosans-anon" },
  { url: "https://raw.githubusercontent.com/ebrasha/abdal-proxy-hub/main/http-proxy-list-by-EbraSha.txt", name: "abdal" },
  { url: "https://raw.githubusercontent.com/ebrasha/abdal-proxy-hub/main/https-proxy-list-by-EbraSha.txt", name: "abdal" },
  { url: "https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt", name: "clarketm" },
  { url: "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt", name: "shiftytr" },
  { url: "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/https.txt", name: "shiftytr" },
  { url: "https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt", name: "roosterkid" },
  { url: "https://raw.githubusercontent.com/mmpx12/proxy-list/master/http.txt", name: "mmpx12" },
  { url: "https://raw.githubusercontent.com/mmpx12/proxy-list/master/https.txt", name: "mmpx12" },
  { url: "https://raw.githubusercontent.com/proxy4parsing/proxy-list/main/http.txt", name: "proxy4parsing" },
];

const IRAN_FEED_SOURCES = [
  { url: "https://raw.githubusercontent.com/nimadn/iran-proxy-feed/main/docs/iran-http-plain.txt", name: "iran-feed" },
  { url: "https://raw.githubusercontent.com/nimadn/iran-proxy-feed/main/docs/iran-https-plain.txt", name: "iran-feed" },
];

function geonodeUrls() {
  return [1, 2, 3, 4].map(
    (page) =>
      "https://proxylist.geonode.com/api/proxy-list?limit=100&page=" +
      page +
      "&sort_by=lastChecked&sort_type=desc&country=IR"
  );
}

function normalize(host, port, country, source) {
  if (!host || !Number.isInteger(port)) return null;
  const octets = host.split(".");
  if (octets.length !== 4) return null;
  for (const oct of octets) {
    const n = Number(oct);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
  }
  if (port < 1 || port > 65535) return null;
  return { host, port, country, source };
}

function extractHostPort(line) {
  const m = line.trim().match(/(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})(?!\d)/);
  if (!m) return null;
  return normalize(m[1], Number(m[2]), "", "") ? { host: m[1], port: Number(m[2]) } : null;
}

function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function fetchText(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    clearTimeout(t);
    return null;
  }
}

async function collectFromText(url) {
  const text = await fetchText(url);
  if (text === null) return [];
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const p = extractHostPort(line);
    if (p) out.push(p);
  }
  return out;
}

async function collectFromIranFeed(url) {
  const text = await fetchText(url);
  if (text === null) return [];
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const hash = trimmed.indexOf("#");
    const target = hash >= 0 ? trimmed.slice(0, hash) : trimmed;
    const p = extractHostPort(target);
    if (p) out.push({ host: p.host, port: p.port, country: IR, source: "iran-feed" });
  }
  return out;
}

async function collectFromGeonode(url) {
  const text = await fetchText(url);
  if (text === null) return [];
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const out = [];
  for (const row of data.data || []) {
    const country = String(row.country ?? "").toUpperCase() || IR;
    const p = normalize(String(row.ip ?? ""), Number(row.port), country, "geonode");
    if (p) out.push(p);
  }
  return out;
}

async function countrySingle(ip) {
  const urls = ["https://ipwho.is/" + ip, "https://ipapi.co/" + ip + "/json/"];
  for (const url of urls) {
    try {
      const text = await fetchText(url);
      if (text === null) continue;
      const d = JSON.parse(text);
      const c = String(d.country_code ?? d.country ?? "").toUpperCase();
      if (c) return c;
    } catch {}
  }
  return null;
}

async function geoCountries(ips) {
  const map = new Map();
  const chunks = [];
  for (let i = 0; i < ips.length; i += 100) chunks.push(ips.slice(i, i + 100));

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    let viaBatch = false;
    try {
      const res = await fetch(GEO_BATCH_ENDPOINT + "?fields=status,countryCode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(chunk),
      });
      if (!res.ok) throw new Error("http " + res.status);
      const arr = await res.json();
      arr.forEach((d, i) => {
        if (d && d.status === "success" && d.countryCode) {
          map.set(chunk[i], d.countryCode.toUpperCase());
        }
      });
      viaBatch = true;
    } catch {
      for (let k = 0; k < chunk.length && k < 15; k++) {
        const c = await countrySingle(chunk[k]);
        if (c) map.set(chunk[k], c);
      }
    }
    if (ci < chunks.length - 1 && viaBatch) await delay(250);
  }
  return map;
}

async function collect() {
  const out = [];
  const seen = new Set();

  for (const url of geonodeUrls()) {
    const rows = await collectFromGeonode(url);
    for (const p of rows) {
      const key = p.host + ":" + p.port;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
  }

  for (const src of IRAN_FEED_SOURCES) {
    for (const p of await collectFromIranFeed(src.url)) {
      const key = p.host + ":" + p.port;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
  }

  const raw = [];
  for (const src of TEXT_SOURCES) {
    for (const p of await collectFromText(src.url)) {
      const key = p.host + ":" + p.port;
      if (seen.has(key)) continue;
      seen.add(key);
      raw.push({ host: p.host, port: p.port, source: src.name });
    }
  }

  const unique = new Map();
  for (const p of raw) unique.set(p.host + ":" + p.port, p);
  const candidates = Array.from(unique.values()).slice(0, GLOBAL_SCAN_CAP);
  const countryByIp = await geoCountries(candidates.map((p) => p.host));

  for (const p of candidates) {
    if (countryByIp.get(p.host) === IR) {
      const key = p.host + ":" + p.port;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ host: p.host, port: p.port, country: IR, source: p.source });
    }
  }

  return out;
}

async function pingProxy(p, timeoutMs = 3500) {
  const addr = "http://" + p.host + ":" + p.port;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(addr, {
      method: "GET",
      signal: ctrl.signal,
      headers: { "user-agent": "proxy-collector/2.0" },
    });
    clearTimeout(t);
    if (res.status >= 100 && res.status < 600) {
      return { ...p, latency: Date.now() - start };
    }
  } catch {
    clearTimeout(t);
  }
  return { ...p, latency: undefined };
}

function loadState() {
  try {
    if (fs.existsSync(CURRENT_FILE)) {
      return JSON.parse(fs.readFileSync(CURRENT_FILE, "utf8"));
    }
  } catch {}
  return { proxies: [], last_refresh: "", last_dropped: 0 };
}

function saveState(state) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CURRENT_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error("saveState failed:", e.message);
  }
}

let state = loadState();

async function putCurrent() {
  const proxies = await collect();
  const checked = [];
  const BATCH = 30;
  for (let i = 0; i < proxies.length; i += BATCH) {
    const slice = proxies.slice(i, i + BATCH);
    const part = await Promise.all(slice.map((p) => pingProxy(p)));
    checked.push(...part);
  }
  const alive = checked.filter((p) => p.latency !== undefined && p.latency !== null);
  alive.sort((a, b) => a.latency - b.latency);
  const dropped = proxies.length - alive.length;

  if (proxies.length === 0 && state.proxies.length > 0) {
    state.last_refresh = new Date().toISOString() + " (scan failed — kept last good)";
    saveState(state);
    return { alive: 0, dropped };
  }

  state.proxies = alive.slice(0, MAX_PROXIES);
  state.last_refresh = new Date().toISOString();
  state.last_dropped = dropped;
  saveState(state);
  return { alive: state.proxies.length, dropped };
}

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function createSessionToken(secret) {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = "pc." + exp;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return payload + "." + sig;
}

function verifySessionToken(secret, token) {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "pc") return false;
  const exp = parseInt(parts[1], 10);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  const sigHex = parts[2];
  if (sigHex.length !== 64 || !/^[0-9a-f]{64}$/.test(sigHex)) return false;
  const expected = crypto.createHmac("sha256", secret).update("pc." + parts[1]).digest();
  let actual;
  try {
    actual = Buffer.from(sigHex, "hex");
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function isAuthed(req) {
  if (!PANEL_PASSWORD) return true;
  const cookies = req.headers.cookie || "";
  for (const part of cookies.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === "pc_auth") {
      if (verifySessionToken(PANEL_PASSWORD, part.slice(idx + 1).trim())) return true;
    }
  }
  const urlKey = req.query ? req.query.key : undefined;
  if (urlKey && String(urlKey) === PANEL_PASSWORD) return true;
  return false;
}

function setSecurityHeaders(res, contentType) {
  res.setHeader("content-type", contentType);
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
}

const PANEL_HTML = `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>پنل مدیریت پراکسی</title>
<style>
  :root { --bg:#0b0f14; --card:#11161d; --line:#1f2730; --fg:#e6edf3; --mut:#8b98a5; --acc:#3b82f6; --ok:#22c55e; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:Vazirmatn, system-ui, sans-serif; background:var(--bg); color:var(--fg); }
  .wrap { max-width:760px; margin:0 auto; padding:24px 16px; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:var(--mut); font-size:13px; margin-bottom:20px; }
  .stats { display:flex; flex-wrap:wrap; gap:12px; margin-bottom:20px; }
  .stat { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px 16px; flex:1 1 130px; }
  .stat .k { color:var(--mut); font-size:12px; }
  .stat .v { font-size:22px; font-weight:700; margin-top:4px; }
  .btn { background:var(--acc); color:#fff; border:0; border-radius:10px; padding:10px 18px; cursor:pointer; font:inherit; font-size:14px; }
  .btn:disabled { opacity:.6; cursor:not-allowed; }
  table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line); border-radius:12px; overflow:hidden; }
  th, td { text-align:right; padding:10px 14px; border-bottom:1px solid var(--line); font-size:14px; }
  th { color:var(--mut); font-weight:600; background:#0f141b; }
  tr:last-child td { border-bottom:0; }
  .mono { direction:ltr; text-align:left; font-family:Consolas, monospace; }
  .badge { color:var(--ok); }
  .box { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px; text-align:center; }
  input { background:#0f141b; border:1px solid var(--line); color:var(--fg); border-radius:10px; padding:10px 14px; font:inherit; width:100%; }
  .err { color:#f87171; font-size:13px; margin-top:8px; display:none; }
  .hidden { display:none; }
</style>
</head>
<body>
<div class="wrap">
  <div id="login" class="box hidden">
    <h1>ورود به پنل</h1>
    <p class="sub">گذرواژه را وارد کنید</p>
    <input type="password" id="pw" placeholder="گذرواژه">
    <div style="height:12px"></div>
    <button class="btn" onclick="doLogin()">ورود</button>
    <p class="err" id="loginErr">گذرواژه نادرست است</p>
  </div>

  <div id="app" class="hidden">
    <h1>پنل مدیریت پراکسی</h1>
    <p class="sub">فقط پراکسی‌های ایرانی — تازه‌سازی مداوم</p>
    <div class="stats">
      <div class="stat"><div class="k">تعداد پایش‌شده</div><div class="v" id="count">—</div></div>
      <div class="stat"><div class="k">حذف شده (مرده)</div><div class="v" id="dropped">—</div></div>
      <div class="stat"><div class="k">هدف</div><div class="v" id="max">—</div></div>
      <div class="stat"><div class="k">آخرین نوسازی</div><div class="v" style="font-size:15px" id="last">—</div></div>
    </div>
    <div style="display:flex;gap:10px;margin-bottom:20px;align-items:center">
      <button class="btn" id="refreshBtn" onclick="doRefresh()">نوسازی اکنون</button>
      <button class="btn" onclick="doLogout()" style="background:var(--muted, #6b7280); color:#fff">خروج</button>
      <span class="sub" id="msg"></span>
    </div>
    <table>
      <thead><tr><th>#</th><th class="mono">نشانی</th><th>درگاه</th><th>پینگ</th><th>کشور</th><th>منبع</th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
  </div>
</div>
<script>
function fmtDate(s) {
  if (!s) return "—";
  var d = new Date(s);
  return d.toLocaleString("fa-IR", { hour12: false });
}
function load() {
  fetch("/admin/data", { credentials: "same-origin" }).then(function (r) {
    if (r.status === 401) { document.getElementById("login").classList.remove("hidden"); document.getElementById("app").classList.add("hidden"); return; }
    return r.json();
  }).then(function (d) {
    if (!d) return;
    document.getElementById("login").classList.add("hidden");
    document.getElementById("app").classList.remove("hidden");
    document.getElementById("count").textContent = d.count;
    document.getElementById("max").textContent = d.max;
    document.getElementById("dropped").textContent = (d.dropped !== undefined && d.dropped !== null) ? d.dropped : "—";
    document.getElementById("last").textContent = fmtDate(d.last_refresh);
    var rows = "";
    for (var i = 0; i < d.proxies.length; i++) {
      var p = d.proxies[i];
      var ping = (p.latency === undefined || p.latency === null) ? "—" : (p.latency + " ms");
      rows += "<tr><td>" + (i + 1) + "</td><td class='mono'>" + p.host + "</td><td class='mono'>" + p.port + "</td><td>" + ping + "</td><td class='badge'>" + p.country + "</td><td>" + p.source + "</td></tr>";
    }
    document.getElementById("rows").innerHTML = rows;
  }).catch(function () {
    document.getElementById("login").classList.remove("hidden");
    document.getElementById("app").classList.add("hidden");
  });
}
function doLogin() {
  var pw = document.getElementById("pw").value;
  fetch("/login", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "password=" + encodeURIComponent(pw) })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d && d.ok) { load(); }
      else { document.getElementById("loginErr").style.display = "block"; }
    });
}
function doLogout() {
  fetch("/logout", { method: "POST", credentials: "same-origin" }).then(function () {
    document.getElementById("app").classList.add("hidden");
    document.getElementById("login").classList.remove("hidden");
    document.getElementById("pw").value = "";
    document.getElementById("loginErr").style.display = "none";
  });
}
function doRefresh() {
  var btn = document.getElementById("refreshBtn");
  btn.disabled = true;
  document.getElementById("msg").textContent = "در حال نوسازی…";
  fetch("/refresh", { method: "POST", credentials: "same-origin" })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      document.getElementById("msg").textContent = "پایان یافت (" + (d && d.ok ? "موفق" : "خطا") + ")";
      btn.disabled = false;
      load();
    })
    .catch(function () { btn.disabled = false; document.getElementById("msg").textContent = "خطا"; });
}
load();
setInterval(load, 30000);
</script>
</body>
</html>`;

const app = express();
app.use(express.urlencoded({ extended: false }));

app.get("/list", (req, res) => {
  setSecurityHeaders(res, "application/json");
  res.send(JSON.stringify(state.proxies));
});

app.post("/login", (req, res) => {
  const password = req.body.password || "";
  if (PANEL_PASSWORD && password === PANEL_PASSWORD) {
    const token = createSessionToken(PANEL_PASSWORD);
    res.setHeader(
      "set-cookie",
      "pc_auth=" + token + "; Path=/; Max-Age=" + Math.floor(SESSION_TTL_MS / 1000) + "; HttpOnly; Secure; SameSite=Strict"
    );
    res.setHeader("content-type", "application/json");
    return res.send(JSON.stringify({ ok: true }));
  }
  setSecurityHeaders(res, "application/json");
  res.status(401).send(JSON.stringify({ ok: false }));
});

app.all("/logout", (req, res) => {
  res.setHeader("set-cookie", "pc_auth=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict");
  res.setHeader("content-type", "application/json");
  res.send(JSON.stringify({ ok: true }));
});

app.post("/refresh", async (req, res) => {
  if (!isAuthed(req)) return res.status(401).json({ ok: false });
  try {
    const result = await putCurrent();
    res.json({ ok: true, alive: result.alive, dropped: result.dropped });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

app.get("/admin/data", (req, res) => {
  if (!isAuthed(req)) return res.status(401).json({ ok: false });
  setSecurityHeaders(res, "application/json");
  res.send(
    JSON.stringify({
      count: state.proxies.length,
      max: MAX_PROXIES,
      last_refresh: state.last_refresh || "",
      dropped: state.last_dropped || 0,
      proxies: state.proxies,
    })
  );
});

app.get(["/", "/admin"], (req, res) => {
  setSecurityHeaders(res, "text/html; charset=utf-8");
  res.setHeader("content-security-policy", "default-src 'self' 'unsafe-inline'; img-src 'self' data:;");
  res.send(PANEL_HTML);
});

app.use((req, res) => {
  setSecurityHeaders(res, "application/json");
  res.status(404).send(JSON.stringify({ ok: false }));
});

app.listen(PORT, () => {
  console.log("proxy-collector (railway) listening on port " + PORT);
  console.log("data dir: " + DATA_DIR);
});

async function loop() {
  while (true) {
    try {
      console.log("refresh cycle started:", new Date().toISOString());
      const r = await putCurrent();
      console.log("refresh done: alive=" + r.alive + " dropped=" + r.dropped);
    } catch (e) {
      console.error("refresh failed:", e.message);
    }
    await delay(CYCLE_REST_MS);
  }
}

loop();
