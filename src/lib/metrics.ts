// Stage 13.5 — minimal Prometheus metrics (no external deps). Tracks HTTP request
// counts/durations + process gauges, and renders the text exposition format at /metrics.
const reqTotal = new Map<string, number>();       // key: method|route|status
const durBuckets = new Map<string, number[]>();    // key: method|route → durations(ms)
let inflight = 0;

// Collapse dynamic path segments so cardinality stays bounded (ids → :id).
function normalize(url: string): string {
  const path = url.split('?')[0];
  return path
    .replace(/\/c[a-z0-9]{20,}/gi, '/:id')                 // cuid-like ids
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{20,}/gi, '/:id')     // uuids
    .replace(/\/\d+/g, '/:n');                             // numeric ids
}

export function requestStart(): void { inflight++; }
export function requestEnd(method: string, url: string, status: number, ms: number): void {
  inflight = Math.max(0, inflight - 1);
  const route = normalize(url);
  const k = `${method}|${route}|${status}`;
  reqTotal.set(k, (reqTotal.get(k) ?? 0) + 1);
  const dk = `${method}|${route}`;
  const arr = durBuckets.get(dk) ?? [];
  arr.push(ms); if (arr.length > 500) arr.shift();
  durBuckets.set(dk, arr);
}

function esc(s: string): string { return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[i];
}

export function renderMetrics(): string {
  const mem = process.memoryUsage();
  const lines: string[] = [];
  lines.push('# HELP ttr_http_requests_total Total HTTP requests by method, route and status.');
  lines.push('# TYPE ttr_http_requests_total counter');
  for (const [k, v] of reqTotal) {
    const [method, route, status] = k.split('|');
    lines.push(`ttr_http_requests_total{method="${esc(method)}",route="${esc(route)}",status="${status}"} ${v}`);
  }
  lines.push('# HELP ttr_http_request_duration_ms Request duration quantiles (ms) by route.');
  lines.push('# TYPE ttr_http_request_duration_ms summary');
  for (const [dk, arr] of durBuckets) {
    const [method, route] = dk.split('|');
    const sorted = [...arr].sort((a, b) => a - b);
    for (const q of [0.5, 0.9, 0.99]) {
      lines.push(`ttr_http_request_duration_ms{method="${esc(method)}",route="${esc(route)}",quantile="${q}"} ${quantile(sorted, q).toFixed(1)}`);
    }
  }
  lines.push('# HELP ttr_http_inflight_requests In-flight HTTP requests.');
  lines.push('# TYPE ttr_http_inflight_requests gauge');
  lines.push(`ttr_http_inflight_requests ${inflight}`);
  lines.push('# HELP ttr_process_resident_memory_bytes Resident memory.');
  lines.push('# TYPE ttr_process_resident_memory_bytes gauge');
  lines.push(`ttr_process_resident_memory_bytes ${mem.rss}`);
  lines.push('# HELP ttr_process_heap_used_bytes Heap used.');
  lines.push('# TYPE ttr_process_heap_used_bytes gauge');
  lines.push(`ttr_process_heap_used_bytes ${mem.heapUsed}`);
  lines.push('# HELP ttr_process_uptime_seconds Process uptime.');
  lines.push('# TYPE ttr_process_uptime_seconds gauge');
  lines.push(`ttr_process_uptime_seconds ${process.uptime().toFixed(0)}`);
  return lines.join('\n') + '\n';
}
