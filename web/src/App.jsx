import { useEffect, useState } from 'react';

const POLL_MS = 2000;

const fmtBytes = (b, d = 1) => {
  if (b == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i ? d : 0)} ${u[i]}`;
};
const fmtRate = (b) => `${fmtBytes(b)}/s`;
const fmtUptime = (s) => {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return [d && `${d}d`, (d || h) && `${h}h`, `${m}m`].filter(Boolean).join(' ');
};
const level = (pct) => (pct >= 90 ? 'crit' : pct >= 75 ? 'warn' : 'ok');

function Sparkline({ values, max = 100, className = '' }) {
  if (values.length < 2) return <svg className={`spark ${className}`} />;
  const top = Math.max(max, ...values) || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${30 - (v / top) * 28 - 1}`).join(' ');
  return (
    <svg className={`spark ${className}`} viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={`0,30 ${pts} 100,30`} className="spark-fill" />
      <polyline points={pts} className="spark-line" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Meter({ pct }) {
  return (
    <div className="meter" role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className={`meter-fill ${level(pct)}`} style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  );
}

function Card({ title, value, sub, children, wide }) {
  return (
    <section className={`card ${wide ? 'wide' : ''}`}>
      <h2>{title}</h2>
      {value != null && <div className="value">{value}</div>}
      {sub && <div className="sub">{sub}</div>}
      {children}
    </section>
  );
}

export default function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [lastOk, setLastOk] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch('/api/stats', { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (alive) { setData(j); setError(null); setLastOk(new Date()); }
      } catch (e) {
        if (alive) setError(e.message);
      }
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (!data?.stats) {
    return <main className="loading">{error ? `Can't reach the server: ${error}` : 'Collecting first sample…'}</main>;
  }

  const { info, health, stats, history } = data;
  const memPct = (stats.memory.used / stats.memory.total) * 100;
  const diskPct = stats.disk ? (stats.disk.used / stats.disk.total) * 100 : 0;
  const status = error ? 'offline' : health.status;

  return (
    <main>
      <header>
        <div>
          <h1>{info.hostname}</h1>
          <p className="muted">{info.os} · kernel {info.kernel}</p>
        </div>
        <div className={`status ${status}`}>
          <span className="dot" />
          {status === 'healthy' ? 'Healthy' : status === 'offline' ? 'Unreachable' : 'Degraded'}
        </div>
      </header>

      {(health.issues.length > 0 || error) && (
        <div className="issues">{error ? `Last update failed (${error}). Showing data from ${lastOk?.toLocaleTimeString()}.` : health.issues.join(' · ')}</div>
      )}

      <div className="grid">
        <Card title="CPU" value={`${stats.cpu.total.toFixed(1)}%`} sub={`${info.cores} cores`}>
          <Sparkline values={history.map((h) => h.cpu)} className="cpu" />
          <div className="cores">
            {stats.cpu.perCore.map((p, i) => (
              <div key={i} className="core" title={`Core ${i}: ${p.toFixed(0)}%`}>
                <div className={`core-fill ${level(p)}`} style={{ height: `${p}%` }} />
              </div>
            ))}
          </div>
        </Card>

        <Card title="Memory" value={`${memPct.toFixed(1)}%`} sub={`${fmtBytes(stats.memory.used)} of ${fmtBytes(stats.memory.total)}`}>
          <Sparkline values={history.map((h) => h.mem)} className="mem" />
          <Meter pct={memPct} />
          <div className="kv"><span>Cache/buffers</span><span>{fmtBytes(stats.memory.cached)}</span></div>
          <div className="kv"><span>Swap</span><span>{fmtBytes(stats.memory.swapUsed)} / {fmtBytes(stats.memory.swapTotal)}</span></div>
        </Card>

        <Card title="Disk (/)" value={stats.disk ? `${diskPct.toFixed(1)}%` : '—'} sub={stats.disk && `${fmtBytes(stats.disk.used)} of ${fmtBytes(stats.disk.total)}`}>
          <Meter pct={diskPct} />
          <div className="kv"><span>Free</span><span>{fmtBytes(stats.disk?.free)}</span></div>
        </Card>

        <Card title="Network" value={`↓ ${fmtRate(stats.network.rxRate)}`} sub={`↑ ${fmtRate(stats.network.txRate)}`}>
          <Sparkline values={history.map((h) => h.rx + h.tx)} max={1} className="net" />
          <div className="kv"><span>Received since boot</span><span>{fmtBytes(stats.network.rxTotal)}</span></div>
          <div className="kv"><span>Sent since boot</span><span>{fmtBytes(stats.network.txTotal)}</span></div>
        </Card>

        <Card title="Load average" value={stats.load[0].toFixed(2)} sub="1 min">
          <div className="kv"><span>5 min</span><span>{stats.load[1].toFixed(2)}</span></div>
          <div className="kv"><span>15 min</span><span>{stats.load[2].toFixed(2)}</span></div>
          <div className="kv"><span>Per core (1 min)</span><span>{(stats.load[0] / info.cores).toFixed(2)}</span></div>
        </Card>

        <Card title="Uptime" value={fmtUptime(stats.uptime)} sub={`since ${new Date(stats.time - stats.uptime * 1000).toLocaleString()}`}>
          {stats.temperatures.map((t) => (
            <div className="kv" key={t.label}><span>{t.label}</span><span className={t.celsius > 85 ? 'hot' : ''}>{t.celsius.toFixed(0)}°C</span></div>
          ))}
        </Card>

        <Card title="System" wide>
          <div className="kv"><span>Hostname</span><span>{info.hostname}</span></div>
          <div className="kv"><span>Operating system</span><span>{info.os}</span></div>
          <div className="kv"><span>Kernel</span><span>{info.kernel}</span></div>
          <div className="kv"><span>Architecture</span><span>{info.arch}</span></div>
          <div className="kv"><span>CPU</span><span>{info.cpuModel}</span></div>
        </Card>
      </div>

      <footer className="muted">Updates every {POLL_MS / 1000}s · last update {lastOk?.toLocaleTimeString()}</footer>
    </main>
  );
}
