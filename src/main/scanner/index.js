'use strict';
/**
 * 扫描调度 + 聚合
 *
 * 职责边界：只做「找到日志文件 -> 解析（带 mtime 缓存）-> 按时间窗口聚合」，
 * 不碰任何 UI。渲染进程拿到的就是一份可以直接画的快照。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseCodexFile, resolveForkedEvents } = require('./codex');
const { parseClaudeFile } = require('./claude');
const { loadPricingTable, findPricing, computeCost, normalizeModel } = require('./pricing');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------- 文件发现

function walk(dir,filter, out, depth = 0) {
  if (depth > 6) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, filter, out, depth + 1);
    else if (e.isFile() && filter(e.name)) out.push(full);
  }
}

function isRolloutFile(name) {
  return name.endsWith('.jsonl') && name.startsWith('rollout-') && !name.includes('.zst');
}

function isClaudeSessionFile(name) {
  return name.endsWith('.jsonl');
}

function defaultRoots() {
  const home = os.homedir();
  return {
    codex: [path.join(home, '.codex', 'sessions')],
    claude: [path.join(home, '.claude', 'projects')],
  };
}

function collectFiles(roots, filter) {
  const out = [];
  for (const root of roots) {
    if (!root) continue;
    if (!fs.existsSync(root)) continue;
    walk(root, filter, out);
  }
  return out;
}

// ---------------------------------------------------------------- 解析缓存

const fileCache = new Map(); // path -> { mtimeMs, size, value }

function cachedParse(file, parser) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const hit = fileCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.value;
  const value = parser(file);
  if (value) fileCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value;
}

// ---------------------------------------------------------------- 时间窗口

function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

function resolveWindow(preset, now = Date.now()) {
  const todayStart = startOfDay(new Date(now));
  switch (preset) {
    case 'today':
      return { start: todayStart, end: now, bucket: 'hour' };
    case '7d':
      return { start: todayStart - 6 * DAY, end: now, bucket: 'day' };
    case '30d':
      return { start: todayStart - 29 * DAY, end: now, bucket: 'day' };
    case 'all':
    default:
      return { start: 0, end: now, bucket: 'day' };
  }
}

// ---------------------------------------------------------------- 聚合

function emptySummary() {
  return {
    cost: 0,
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    tokens: 0,
  };
}

function finalizeSummary(s) {
  const cacheable = s.input + s.cacheWrite + s.cacheRead;
  return {
    ...s,
    tokens: s.input + s.output + s.cacheWrite + s.cacheRead,
    hitRate: cacheable > 0 ? s.cacheRead / cacheable : 0,
    avgCost: s.requests > 0 ? s.cost / s.requests : 0,
  };
}

function buildSnapshot(options = {}) {
  const now = options.now || Date.now();
  const preset = options.range || 'today';
  const extraRoots = options.extraRoots || {};
  const pricingTable = options.pricingTable || loadPricingTable(defaultPricingFile());
  const window = resolveWindow(preset, now);

  const roots = defaultRoots();
  for (const key of ['codex', 'claude']) {
    if (Array.isArray(extraRoots[key])) roots[key] = roots[key].concat(extraRoots[key]);
  }

  // ---- codex
  const codexFiles = collectFiles(roots.codex, isRolloutFile);
  const parsedCodex = [];
  for (const file of codexFiles) {
    const p = cachedParse(file, parseCodexFile);
    if (p && p.events && p.events.length) parsedCodex.push(p);
  }
  const codexEvents = resolveForkedEvents(parsedCodex);

  // ---- claude
  const claudeFiles = collectFiles(roots.claude, isClaudeSessionFile);
  const claudeEvents = [];
  for (const file of claudeFiles) {
    const evts = cachedParse(file, parseClaudeFile);
    if (evts && evts.length) claudeEvents.push(...evts);
  }

  const raw = [];
  for (const e of codexEvents) raw.push({ ...e, appType: 'codex' });
  for (const e of claudeEvents) raw.push({ ...e, appType: 'claude' });

  // ---- 计价
  const unpriced = new Set();
  const rows = [];
  for (const e of raw) {
    if (e.ts === null || e.ts === undefined) continue;
    if (e.ts < window.start || e.ts > window.end) continue;
    const model = e.model || 'unknown';
    const pricing = findPricing(pricingTable.models, model);
    if (!pricing) unpriced.add(model);

    let cost;
    if (e.cacheWrite1h) {
      // Claude 1h 缓存写入按 1.6 倍价（上游 calculator.rs 的口径）
      const base = computeCost(e.appType, { ...e.delta, cacheWrite: e.delta.cacheWrite - e.cacheWrite1h }, pricing);
      const extra = (e.cacheWrite1h * 1.6 * (pricing ? pricing.cacheWrite : 0)) / 1_000_000;
      cost = { ...base, total: base.total + extra };
    } else {
      cost = computeCost(e.appType, e.delta, pricing);
    }

    const freshInput = e.appType === 'codex' || e.appType === 'gemini'
      ? Math.max(0, e.delta.input - e.delta.cached - e.delta.cacheWrite)
      : e.delta.input;

    const genMs = e.timing ? Math.max(1, (e.timing.latencyMs || 0) - (e.timing.firstTokenMs || 0)) : null;
    const speed = genMs && e.delta.output >= 100 ? (e.delta.output / genMs) * 1000 : null;

    rows.push({
      ts: e.ts,
      appType: e.appType,
      model,
      input: freshInput,
      output: e.delta.output,
      cacheRead: e.delta.cached,
      cacheWrite: e.delta.cacheWrite,
      tokens: freshInput + e.delta.output + e.delta.cached + e.delta.cacheWrite,
      cost: cost.total,
      priced: !!pricing,
      latencyMs: e.timing ? e.timing.latencyMs : null,
      ttftMs: e.timing ? e.timing.firstTokenMs : null,
      speed,
      project: e.project || null,
    });
  }

  rows.sort((a, b) => a.ts - b.ts);

  // ---- 汇总
  const summary = emptySummary();
  const byModel = new Map();
  const byApp = new Map();
  for (const r of rows) {
    summary.cost += r.cost;
    summary.requests += 1;
    summary.input += r.input;
    summary.output += r.output;
    summary.cacheRead += r.cacheRead;
    summary.cacheWrite += r.cacheWrite;

    const m = byModel.get(r.model) || { model: r.model, requests: 0, cost: 0, tokens: 0, input: 0, output: 0, cacheRead: 0 };
    m.requests += 1;
    m.cost += r.cost;
    m.tokens += r.tokens;
    m.input += r.input;
    m.output += r.output;
    m.cacheRead += r.cacheRead;
    byModel.set(r.model, m);

    const a = byApp.get(r.appType) || { appType: r.appType, requests: 0, cost: 0, tokens: 0 };
    a.requests += 1;
    a.cost += r.cost;
    a.tokens += r.tokens;
    byApp.set(r.appType, a);
  }

  // ---- 时间桶
  const buckets = [];
  if (window.bucket === 'hour') {
    const base = startOfDay(new Date(now));
    for (let h = 0; h < 24; h++) {
      buckets.push({ ts: base + h * HOUR, label: `${String(h).padStart(2, '0')}:00`, cost: 0, tokens: 0, requests: 0 });
    }
    for (const r of rows) {
      const idx = Math.floor((r.ts - base) / HOUR);
      if (idx >= 0 && idx < 24) {
        const b = buckets[idx];
        b.cost += r.cost;
        b.tokens += r.tokens;
        b.requests += 1;
      }
    }
  } else {
    const start = window.start === 0
      ? startOfDay(new Date(rows.length ? rows[0].ts : now))
      : startOfDay(new Date(window.start));
    const days = Math.max(1, Math.ceil((startOfDay(new Date(now)) - start) / DAY) + 1);
    const index = new Map();
    for (let i = 0; i < days; i++) {
      const ts = start + i * DAY;
      const d = new Date(ts);
      const b = { ts, label: `${d.getMonth() + 1}/${d.getDate()}`, cost: 0, tokens: 0, requests: 0 };
      buckets.push(b);
      index.set(ts, b);
    }
    for (const r of rows) {
      const b = index.get(startOfDay(new Date(r.ts)));
      if (b) {
        b.cost += r.cost;
        b.tokens += r.tokens;
        b.requests += 1;
      }
    }
  }

  // ---- 明细（倒序，最多 300 条够悬浮窗滚动了）
  const detail = rows
    .slice()
    .reverse()
    .slice(0, 300)
    .map((r) => {
      const d = new Date(r.ts);
      return {
        ts: r.ts,
        time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`,
        date: `${d.getMonth() + 1}/${d.getDate()}`,
        appType: r.appType,
        model: r.model,
        input: r.input,
        output: r.output,
        cacheRead: r.cacheRead,
        cacheWrite: r.cacheWrite,
        tokens: r.tokens,
        cost: r.cost,
        priced: r.priced,
        ttftMs: r.ttftMs,
        speed: r.speed,
        latencyMs: r.latencyMs,
        project: r.project,
      };
    });

  return {
    generatedAt: Date.now(),
    range: { preset, start: window.start, end: window.end, bucket: window.bucket },
    summary: finalizeSummary(summary),
    models: [...byModel.values()].sort((a, b) => b.cost - a.cost),
    apps: [...byApp.values()].sort((a, b) => b.cost - a.cost),
    buckets,
    detail,
    unpricedModels: [...unpriced],
    sources: {
      codexFiles: codexFiles.length,
      claudeFiles: claudeFiles.length,
      codexRequests: codexEvents.length,
      claudeRequests: claudeEvents.length,
      rows: rows.length,
    },
  };
}

function defaultPricingFile() {
  return path.join(__dirname, '..', '..', '..', 'data', 'pricing.json');
}

module.exports = {
  buildSnapshot,
  defaultRoots,
  defaultPricingFile,
  resolveWindow,
  startOfDay,
  normalizeModel,
};
