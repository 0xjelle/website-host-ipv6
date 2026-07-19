// In-memory metrics: system samples (CPU load vs cores, memory) every 15s
// for the last hour, and per-site request counters in per-minute buckets
// for the last 2 hours. Feeds the dashboard charts; nothing is persisted.
const os = require('os');

const SYS_INTERVAL_MS = 15_000;
const SYS_KEEP = 240;          // 240 × 15s = 1 hour
const TRAFFIC_KEEP_MIN = 120;  // 2 hours of per-minute buckets

const sysSamples = [];         // [{t, loadPct, memPct}]
const trafficBuckets = [];     // [{t: epochMinute, counts: {siteId: n}}]

function sampleSystem() {
  const loadPct = Math.min(100, Math.round(os.loadavg()[0] / os.cpus().length * 100));
  const memPct = Math.round((os.totalmem() - os.freemem()) / os.totalmem() * 100);
  sysSamples.push({ t: Date.now(), loadPct, memPct });
  if (sysSamples.length > SYS_KEEP) sysSamples.splice(0, sysSamples.length - SYS_KEEP);
}

function hit(siteId) {
  const minute = Math.floor(Date.now() / 60_000);
  let bucket = trafficBuckets[trafficBuckets.length - 1];
  if (!bucket || bucket.t !== minute) {
    bucket = { t: minute, counts: {} };
    trafficBuckets.push(bucket);
    if (trafficBuckets.length > TRAFFIC_KEEP_MIN) trafficBuckets.splice(0, trafficBuckets.length - TRAFFIC_KEEP_MIN);
  }
  bucket.counts[siteId] = (bucket.counts[siteId] || 0) + 1;
}

// Continuous per-minute series for the last `minutes`, summed over siteIds
// (or over all sites when siteIds is null). Gaps become zeros so the chart
// has a point per minute.
function trafficSeries(siteIds, minutes = 60) {
  const wanted = siteIds === null ? null : new Set(siteIds.map(Number));
  const now = Math.floor(Date.now() / 60_000);
  const byMinute = new Map(trafficBuckets.map(b => [b.t, b]));
  const out = [];
  for (let m = now - minutes + 1; m <= now; m++) {
    const bucket = byMinute.get(m);
    let n = 0;
    if (bucket) {
      for (const [id, count] of Object.entries(bucket.counts)) {
        if (!wanted || wanted.has(Number(id))) n += count;
      }
    }
    out.push({ t: m * 60_000, n });
  }
  return out;
}

function systemSeries() {
  return sysSamples.slice();
}

function start() {
  sampleSystem();
  setInterval(sampleSystem, SYS_INTERVAL_MS).unref();
}

module.exports = { start, hit, trafficSeries, systemSeries };
