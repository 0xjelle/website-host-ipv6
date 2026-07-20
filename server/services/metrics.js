// In-memory metrics: system samples (CPU load vs cores, memory) every 15s
// for the last hour, and per-site request counters in per-minute buckets
// for the last 2 hours. Feeds the dashboard charts; nothing is persisted.
const os = require('os');

const SYS_INTERVAL_MS = 15_000;
const SYS_KEEP = 240;          // 240 × 15s = 1 hour
const TRAFFIC_KEEP_MIN = 120;  // 2 hours of per-minute buckets

const sysSamples = [];         // [{t, loadPct, memPct}]
const trafficBuckets = [];     // [{t: epochMinute, counts: {siteId: n}}]
const byteBuckets = [];        // [{t: epochMinute, bytes: {siteId: n}}]
let bytesTotalAll = 0;
const bytesTotalBySite = {};   // cumulative bytes served, per site

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

// Record bytes served for a site (response body size).
function bytes(siteId, n) {
  if (!n) return;
  bytesTotalAll += n;
  bytesTotalBySite[siteId] = (bytesTotalBySite[siteId] || 0) + n;
  const minute = Math.floor(Date.now() / 60_000);
  let bucket = byteBuckets[byteBuckets.length - 1];
  if (!bucket || bucket.t !== minute) {
    bucket = { t: minute, bytes: {} };
    byteBuckets.push(bucket);
    if (byteBuckets.length > TRAFFIC_KEEP_MIN) byteBuckets.splice(0, byteBuckets.length - TRAFFIC_KEEP_MIN);
  }
  bucket.bytes[siteId] = (bucket.bytes[siteId] || 0) + n;
}

// Total bytes served + a current transfer rate (bytes/sec over the last
// completed minute), scoped to siteIds (or all when null).
function bandwidth(siteIds) {
  const wanted = siteIds === null ? null : new Set(siteIds.map(Number));
  const sumBucket = (t) => {
    const b = byteBuckets.find(x => x.t === t);
    let s = 0;
    if (b) for (const [id, n] of Object.entries(b.bytes)) if (!wanted || wanted.has(Number(id))) s += n;
    return s;
  };
  let total = 0;
  if (wanted === null) total = bytesTotalAll;
  else for (const id of wanted) total += bytesTotalBySite[id] || 0;
  const now = Math.floor(Date.now() / 60_000);
  return { total, rateBps: Math.round(sumBucket(now - 1) / 60), thisMinute: sumBucket(now) };
}

// Per-minute byte series for a chart.
function bandwidthSeries(siteIds, minutes = 60) {
  const wanted = siteIds === null ? null : new Set(siteIds.map(Number));
  const now = Math.floor(Date.now() / 60_000);
  const byMinute = new Map(byteBuckets.map(b => [b.t, b]));
  const out = [];
  for (let m = now - minutes + 1; m <= now; m++) {
    const bucket = byMinute.get(m);
    let n = 0;
    if (bucket) for (const [id, v] of Object.entries(bucket.bytes)) if (!wanted || wanted.has(Number(id))) n += v;
    out.push({ t: m * 60_000, n });
  }
  return out;
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

// Per-site series for a multi-line "traffic per website" chart. metric is
// 'req' (requests/min from trafficBuckets) or 'bytes' (from byteBuckets).
function perSiteSeries(siteIds, metric = 'req', minutes = 60) {
  const wanted = siteIds === null ? null : new Set(siteIds.map(Number));
  const buckets = metric === 'bytes' ? byteBuckets : trafficBuckets;
  const field = metric === 'bytes' ? 'bytes' : 'counts';
  const now = Math.floor(Date.now() / 60_000);
  const byMinute = new Map(buckets.map(b => [b.t, b]));
  // which site ids actually have data in-window (and are wanted)
  const ids = new Set();
  for (const b of buckets) if (b.t > now - minutes) for (const id of Object.keys(b[field])) {
    if (!wanted || wanted.has(Number(id))) ids.add(Number(id));
  }
  const out = {};
  for (const id of ids) {
    const series = [];
    for (let mm = now - minutes + 1; mm <= now; mm++) {
      const bucket = byMinute.get(mm);
      series.push({ t: mm * 60_000, n: bucket ? (bucket[field][id] || 0) : 0 });
    }
    out[id] = series;
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

module.exports = { start, hit, bytes, bandwidth, bandwidthSeries, trafficSeries, perSiteSeries, systemSeries };
