// Tiny dependency-free API + static server. Reads host metrics from read-only mounts.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PROC = process.env.HOST_PROC || '/host/proc';
const SYS = process.env.HOST_SYS || '/host/sys';
const ROOT = process.env.HOST_ROOT || '/host/root';
const STATIC = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;
const SAMPLE_MS = 2000;
const HISTORY = 90;

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

function cpuTimes() {
  return read(`${PROC}/stat`).split('\n').filter((l) => /^cpu\d*\s/.test(l)).map((l) => {
    const v = l.trim().split(/\s+/).slice(1).map(Number);
    const idle = v[3] + (v[4] || 0);
    const total = v.slice(0, 8).reduce((a, b) => a + b, 0);
    return { idle, total };
  });
}

function meminfo() {
  const m = {};
  for (const l of read(`${PROC}/meminfo`).split('\n')) {
    const [k, v] = l.split(':');
    if (v) m[k] = parseInt(v, 10) * 1024;
  }
  return {
    total: m.MemTotal, available: m.MemAvailable, used: m.MemTotal - m.MemAvailable,
    cached: (m.Cached || 0) + (m.Buffers || 0),
    swapTotal: m.SwapTotal || 0, swapUsed: (m.SwapTotal || 0) - (m.SwapFree || 0),
  };
}

function netTotals() {
  // /proc/1/net is the host's network namespace (/proc/net would be the container's).
  let rx = 0, tx = 0;
  for (const l of read(`${PROC}/1/net/dev`).split('\n').slice(2)) {
    const [name, rest] = l.split(':');
    if (!rest) continue;
    const n = name.trim();
    if (n === 'lo' || /^(veth|br-|docker)/.test(n)) continue;
    const f = rest.trim().split(/\s+/).map(Number);
    rx += f[0]; tx += f[8];
  }
  return { rx, tx };
}

function disk() {
  try {
    const s = fs.statfsSync(ROOT);
    const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
    return { total, free, used: total - s.bfree * s.bsize };
  } catch { return null; }
}

function temperature() {
  const temps = [];
  for (const z of fs.readdirSync(`${SYS}/class/thermal`, { withFileTypes: true }).map((d) => d.name).filter((n) => n.startsWith('thermal_zone'))) {
    const t = parseInt(read(`${SYS}/class/thermal/${z}/temp`), 10);
    if (!Number.isNaN(t)) temps.push({ label: read(`${SYS}/class/thermal/${z}/type`).trim() || z, celsius: t / 1000 });
  }
  return temps;
}

function staticInfo() {
  const os = Object.fromEntries(read('/host/os-release').split('\n').filter(Boolean).map((l) => {
    const i = l.indexOf('=');
    return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')];
  }));
  const cpuinfo = read(`${PROC}/cpuinfo`);
  return {
    hostname: read(`${ROOT}/etc/hostname`).trim() || read(`${PROC}/sys/kernel/hostname`).trim(),
    os: os.PRETTY_NAME || 'Linux',
    kernel: read(`${PROC}/sys/kernel/osrelease`).trim(),
    arch: process.arch,
    cpuModel: (cpuinfo.match(/model name\s*:\s*(.+)/) || [])[1] || 'Unknown CPU',
    cores: (cpuinfo.match(/^processor\s*:/gm) || []).length,
  };
}

const info = staticInfo();
let prevCpu = cpuTimes(), prevNet = netTotals(), prevAt = Date.now();
let latest = null;
const history = [];

function sample() {
  const now = Date.now(), dt = (now - prevAt) / 1000;
  const cpu = cpuTimes(), net = netTotals();
  const usage = cpu.map((c, i) => {
    const p = prevCpu[i] || c, dTotal = c.total - p.total;
    return dTotal > 0 ? Math.max(0, Math.min(100, (1 - (c.idle - p.idle) / dTotal) * 100)) : 0;
  });
  const mem = meminfo();
  const [l1, l5, l15] = read(`${PROC}/loadavg`).split(' ').map(Number);
  latest = {
    time: now,
    uptime: parseFloat(read(`${PROC}/uptime`)) || 0,
    cpu: { total: usage[0] || 0, perCore: usage.slice(1) },
    load: [l1, l5, l15],
    memory: mem,
    disk: disk(),
    network: { rxRate: Math.max(0, (net.rx - prevNet.rx) / dt), txRate: Math.max(0, (net.tx - prevNet.tx) / dt), rxTotal: net.rx, txTotal: net.tx },
    temperatures: temperature(),
  };
  history.push({ t: now, cpu: latest.cpu.total, mem: (mem.used / mem.total) * 100, rx: latest.network.rxRate, tx: latest.network.txRate });
  if (history.length > HISTORY) history.shift();
  prevCpu = cpu; prevNet = net; prevAt = now;
}
setTimeout(sample, 500);
setInterval(sample, SAMPLE_MS);

function health(s) {
  if (!s) return { status: 'starting', issues: [] };
  const issues = [];
  const memPct = (s.memory.used / s.memory.total) * 100;
  const diskPct = s.disk ? (s.disk.used / s.disk.total) * 100 : 0;
  if (s.cpu.total > 90) issues.push(`CPU at ${s.cpu.total.toFixed(0)}%`);
  if (memPct > 90) issues.push(`Memory at ${memPct.toFixed(0)}%`);
  if (diskPct > 90) issues.push(`Disk at ${diskPct.toFixed(0)}%`);
  if (s.load[0] > info.cores * 1.5) issues.push(`Load ${s.load[0].toFixed(2)} on ${info.cores} cores`);
  const hot = s.temperatures.find((t) => t.celsius > 85);
  if (hot) issues.push(`${hot.label} at ${hot.celsius.toFixed(0)}°C`);
  return { status: issues.length ? 'degraded' : 'healthy', issues };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ info, health: health(latest), stats: latest, history }));
  }
  if (url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
  let file = path.normalize(path.join(STATIC, url.pathname));
  if (!file.startsWith(STATIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(STATIC, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`server-dashboard listening on :${PORT}`));
