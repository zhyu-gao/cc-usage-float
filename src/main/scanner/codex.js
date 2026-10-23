'use strict';
/**
 * Codex 会话日志（~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl）解析
 *
 * 逻辑移植自 cc-switch `src-tauri/src/services/session_usage_codex.rs`，
 * 保留了三件决定数字准不准的事：
 *   1. 优先用 `last_token_usage`（Codex 自己算好的单次请求用量），
 *      只有它缺失时才用 `total_token_usage` 的高水位差分；
 *   2. 同签名重复快照（限额刷新时重发的）不重复计数；
 *   3. fork / 子代理会话会把父会话的历史重放一遍，必须按签名匹配前缀剔掉，
 *      否则同一批 token 会被算两次。
 *
 * 简化掉的部分（不影响单机日常使用）：
 *   - 实时增量游标：每次全量重扫单文件（有 mtime 缓存兜底），不落 SQLite；
 *   - 续写页（paginated）跨文件基线恢复：按文件内高水位处理。
 */

const fs = require('fs');
const path = require('path');
const { normalizeModel } = require('./pricing');

const SAME_FLUSH_SLACK_MS = 100;
const HEAD_BYTES = 512;

// ---------------------------------------------------------------- 工具

function parseTsMs(str) {
  if (!str) return null;
  const t = Date.parse(str);
  return Number.isFinite(t) ? t : null;
}

/** 等价于 Rust head_str：取 `"key":"value"` 里的 value（要求是字符串） */
function headField(seg, key) {
  const marker = `"${key}":"`;
  const at = seg.indexOf(marker);
  if (at < 0) return null;
  const start = at + marker.length;
  const end = seg.indexOf('"', start);
  if (end < 0) return null;
  return seg.slice(start, end);
}

const COUNTER_KEYS = [
  'input_tokens',
  'cached_input_tokens',
  'cache_read_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
  'total_tokens',
];

function parseCumulative(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (!COUNTER_KEYS.some((k) => k in obj)) return null;
  const n = (k) => {
    const v = obj[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };
  return {
    input: n('input_tokens'),
    cached: 'cached_input_tokens' in obj ? n('cached_input_tokens') : n('cache_read_input_tokens'),
    cacheWrite: n('cache_write_input_tokens'),
    output: n('output_tokens'),
  };
}

function countersSig(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const n = (k) => (typeof obj[k] === 'number' ? obj[k] : 0);
  return [n('input_tokens'), n('cached_input_tokens') || n('cache_read_input_tokens'), n('output_tokens')].join('/');
}

/** 等价于 Rust parse_token_signature：total + last 两份计数器指纹 */
function parseTokenSignature(info) {
  const total = countersSig(info.total_token_usage);
  const last = countersSig(info.last_token_usage);
  if (total === null && last === null) return null;
  return `${total || '-'}|${last || '-'}`;
}

const isZero = (c) => !c || (c.input === 0 && c.cached === 0 && c.cacheWrite === 0 && c.output === 0);

function computeDelta(prev, cur) {
  if (!prev) return { ...cur };
  return {
    input: Math.max(0, cur.input - prev.input),
    cached: Math.max(0, cur.cached - prev.cached),
    cacheWrite: Math.max(0, cur.cacheWrite - prev.cacheWrite),
    output: Math.max(0, cur.output - prev.output),
  };
}

function updateHighWater(hw, cur) {
  hw.input = Math.max(hw.input, cur.input);
  hw.cached = Math.max(hw.cached, cur.cached);
  hw.cacheWrite = Math.max(hw.cacheWrite, cur.cacheWrite);
  hw.output = Math.max(hw.output, cur.output);
}

// ---------------------------------------------------------------- 计时

/** 每行分类：只做字符串前缀判断，避免对每个大行都 JSON.parse */
function classifyLine(line) {
  const head = line.length > HEAD_BYTES ? line.slice(0, HEAD_BYTES) : line;
  const payloadAt = head.indexOf('"payload":{');
  const envelope = payloadAt >= 0 ? head.slice(0, payloadAt) : head;
  const payload = payloadAt >= 0 ? head.slice(payloadAt) : '';
  const type = headField(envelope, 'type');
  if (!type) return null;

  let kind = null;
  if (type === 'turn_context') {
    kind = 'boundary';
  } else if (type === 'token_usage_record') {
    kind = 'usageRecord';
  } else if (type === 'response_item') {
    const itemType = headField(payload, 'type');
    if (!itemType) return null;
    if (itemType === 'message') kind = headField(payload, 'role') === 'assistant' ? 'modelOutput' : 'boundary';
    else if (itemType === 'reasoning') kind = 'modelOutput';
    else if (itemType.endsWith('_output')) kind = 'toolOutput';
    else if (itemType.endsWith('_call')) kind = 'modelOutput';
    else return null;
  } else if (type === 'event_msg') {
    const sub = headField(payload, 'type');
    if (sub === 'task_started' || sub === 'turn_aborted') kind = 'turnReset';
    else if (sub === 'item_completed') {
      const itemAt = payload.indexOf('"item":{');
      if (itemAt < 0) return null;
      const itemType = headField(payload.slice(itemAt), 'type');
      if (itemType !== 'Reasoning' && itemType !== 'AgentMessage') return null;
      try {
        const v = JSON.parse(line);
        const started = v && v.payload && v.payload.started_at_ms;
        if (typeof started !== 'number') return null;
        const ms = parseTsMs(headField(envelope, 'timestamp'));
        return ms === null ? null : { ms, kind: 'outputItemStarted', startedAt: started };
      } catch {
        return null;
      }
    } else return null;
  } else return null;

  const ms = parseTsMs(headField(envelope, 'timestamp'));
  return ms === null ? null : { ms, kind };
}

/**
 * Codex 日志没有请求级计时，靠事件顺序推：
 * 起点 = 这次请求第一个输出项之前最近的边界行；终点 = token_count / 最后输出项。
 */
class RequestTimer {
  constructor() {
    this.lastBoundaryMs = null;
    this.lastTokenCountMs = null;
    this.requestStartMs = null;
    this.lastModelOutputMs = null;
    this.toolOutputAfterModelOutputMs = null;
    this.usageRecord = null;
    this.firstOutputMs = null;
  }

  observe(line) {
    const r = classifyLine(line);
    if (!r) return;
    switch (r.kind) {
      case 'boundary':
        this.lastBoundaryMs = Math.max(this.lastBoundaryMs ?? -Infinity, r.ms);
        break;
      case 'toolOutput':
        this.lastBoundaryMs = Math.max(this.lastBoundaryMs ?? -Infinity, r.ms);
        if (this.lastModelOutputMs !== null) this.toolOutputAfterModelOutputMs = r.ms;
        break;
      case 'modelOutput': {
        // 2025 年旧布局会把上一次响应的输出项补写在它的 token_count 之后，忽略
        if (
          this.requestStartMs === null &&
          this.lastTokenCountMs !== null &&
          r.ms - this.lastTokenCountMs <= SAME_FLUSH_SLACK_MS
        ) {
          return;
        }
        if (this.requestStartMs === null) this.requestStartMs = this.lastBoundaryMs;
        this.lastModelOutputMs = r.ms;
        this.toolOutputAfterModelOutputMs = null;
        break;
      }
      case 'usageRecord': {
        try {
          const v = JSON.parse(line);
          const usage = parseCumulative(v && v.payload && v.payload.usage);
          this.usageRecord = usage ? { ms: r.ms, usage } : null;
        } catch {
          this.usageRecord = null;
        }
        break;
      }
      case 'turnReset':
        this.lastBoundaryMs = Math.max(this.lastBoundaryMs ?? -Infinity, r.ms);
        this.requestStartMs = null;
        this.lastModelOutputMs = null;
        this.toolOutputAfterModelOutputMs = null;
        this.firstOutputMs = null;
        break;
      case 'outputItemStarted':
        this.firstOutputMs =
          this.firstOutputMs === null ? r.startedAt : Math.min(this.firstOutputMs, r.startedAt);
        break;
      default:
        break;
    }
  }

  /** 结算一次请求的耗时 / 首字，并把它作为下一次请求的起点 */
  finishRequest(tokenCountMs, last) {
    const startMs = this.requestStartMs ?? this.lastBoundaryMs;
    const firstOutputMs = this.firstOutputMs;

    let recordEndMs = null;
    if (this.usageRecord) {
      const u = this.usageRecord.usage;
      const matches = !last || (u.input === last.input && u.cached === last.cached && u.output === last.output);
      if (matches) recordEndMs = this.usageRecord.ms;
    }

    let waitedForTools = false;
    if (this.toolOutputAfterModelOutputMs !== null) {
      waitedForTools =
        tokenCountMs !== null &&
        tokenCountMs - this.toolOutputAfterModelOutputMs <= SAME_FLUSH_SLACK_MS;
      if (tokenCountMs === null) waitedForTools = true;
    }

    let endMs = recordEndMs;
    if (endMs === null) endMs = waitedForTools ? this.lastModelOutputMs : tokenCountMs;

    this.lastBoundaryMs = Math.max(this.lastBoundaryMs ?? -Infinity, tokenCountMs ?? -Infinity);
    this.lastTokenCountMs = tokenCountMs;
    this.requestStartMs = null;
    this.lastModelOutputMs = null;
    this.toolOutputAfterModelOutputMs = null;
    this.usageRecord = null;
    this.firstOutputMs = null;

    if (startMs === null || startMs === undefined || endMs === null || endMs === undefined) return null;
    const latencyMs = endMs - startMs;
    if (!(latencyMs > 0) || latencyMs > 6 * 3600 * 1000) return null;

    let firstTokenMs = null;
    if (firstOutputMs !== null) {
      const ttft = firstOutputMs - startMs;
      if (ttft > 0 && ttft <= latencyMs) firstTokenMs = ttft;
    }
    return { latencyMs, firstTokenMs };
  }
}

// ---------------------------------------------------------------- 单文件解析

function parseCodexFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  const lines = text.split('\n');
  const events = [];
  const recordEvents = [];

  let model = '';
  let highWater = null;
  let prevSig = null;
  const sigBySource = new Map();
  let pendingUsage = null;
  let threadId = null;
  let parentId = null;
  let rootTimestamp = null;
  let metaSeen = false;
  const timer = new RequestTimer();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.length < 8) continue;

    timer.observe(line);

    const hasEventMsg = line.includes('"event_msg"');
    const hasTurnCtx = line.includes('"turn_context"');
    const hasMeta = line.includes('"session_meta"');
    const hasRecord = line.includes('"token_usage_record"');
    if (!hasEventMsg && !hasTurnCtx && !hasMeta && !hasRecord) continue;
    if (hasEventMsg && !line.includes('"token_count"') && !line.includes('"thread_settings_applied"')) continue;

    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const type = value.type;
    if (!type) continue;

    if (type === 'session_meta' && !metaSeen) {
      metaSeen = true;
      rootTimestamp = value.timestamp || null;
      const payload = value.payload || {};
      threadId = payload.id || payload.thread_id || payload.threadId || null;
      const forkedFrom = payload.forked_from_id || null;
      const spawnedFrom =
        payload.source && payload.source.subagent && payload.source.subagent.thread_spawn
          ? payload.source.subagent.thread_spawn.parent_thread_id || null
          : null;
      parentId = forkedFrom || spawnedFrom || null;
      if (parentId && forkedFrom && spawnedFrom && forkedFrom !== spawnedFrom) parentId = null;
      continue;
    }

    if (type === 'turn_context') {
      const payload = value.payload || {};
      const m = payload.model || (payload.info && payload.info.model);
      if (typeof m === 'string' && m.trim()) model = normalizeModel(m);
      continue;
    }

    if (type === 'event_msg') {
      const payload = value.payload;
      if (!payload) continue;
      if (payload.type === 'thread_settings_applied') {
        const m = payload.thread_settings && payload.thread_settings.model;
        if (typeof m === 'string' && m.trim()) model = normalizeModel(m);
        continue;
      }
      if (payload.type !== 'token_count') continue;

      const info = payload.info;
      if (!info || typeof info !== 'object') continue;
      const signature = parseTokenSignature(info);
      if (signature === null) continue;
      const infoModel = info.model || info.model_name || payload.model;
      if (typeof infoModel === 'string' && infoModel.trim()) model = normalizeModel(infoModel);

      const total = parseCumulative(info.total_token_usage);
      const last = parseCumulative(info.last_token_usage);

      if (pendingUsage) {
        const covered = last && last.input === pendingUsage.usage.input && last.cached === pendingUsage.usage.cached && last.output === pendingUsage.usage.output;
        if (!covered && last && isZero(last)) {
          const d = { ...pendingUsage.usage };
          if (!isZero(d)) {
            recordEvents.push({
              sig: `rec:${d.input}/${d.cached}/${d.output}`,
              delta: { ...d },
              model: pendingUsage.model,
              timestamp: pendingUsage.timestamp,
              ts: pendingUsage.ts,
              timing: null,
            });
          }
        }
        pendingUsage = null;
      }

      if (!total && !last) continue;

      const source = (payload.rate_limits && payload.rate_limits.limit_id) || null;
      const duplicate = total
        ? sigBySource.get(source) === signature || prevSig === signature
        : false;
      if (total) sigBySource.set(source, signature);
      prevSig = signature;

      let delta;
      if (duplicate) {
        delta = { input: 0, cached: 0, cacheWrite: 0, output: 0 };
      } else if (last) {
        delta = { ...last };
      } else {
        delta = computeDelta(highWater, total);
      }
      if (total) {
        if (highWater) updateHighWater(highWater, total);
        else highWater = { ...total };
      }

      // 缓存读写都是 input 的子集，夹紧防止脏日志把成本算歪
      const cached = Math.min(delta.cached, delta.input);
      const cacheWrite = Math.min(delta.cacheWrite, delta.input - cached);
      delta = { ...delta, cached, cacheWrite };

      const zero = isZero(delta);
      const ts = parseTsMs(value.timestamp);
      const timing = zero ? null : timer.finishRequest(ts, last);

      if (!zero) {
        events.push({
          sig: signature,
          delta,
          model,
          timestamp: value.timestamp || null,
          ts,
          timing,
        });
      }
      continue;
    }

    if (type === 'token_usage_record') {
      const payload = value.payload;
      if (!payload) continue;
      const usage = parseCumulative(payload.usage);
      if (!usage || isZero(usage)) continue;
      pendingUsage = {
        usage,
        ts: parseTsMs(value.timestamp),
        timestamp: value.timestamp || null,
        model,
      };
    }
  }

  return {
    path: filePath,
    threadId,
    parentId,
    rootTimestamp,
    events: events.concat(recordEvents),
  };
}

// ---------------------------------------------------------------- fork 重放剔除

/** 子会话按顺序在父会话签名序列里找匹配，返回重放前缀长度 */
function matchingReplayPrefix(childEvents, parentSigs) {
  let offset = 0;
  let matched = 0;
  for (const ev of childEvents) {
    let found = -1;
    for (let j = offset; j < parentSigs.length; j++) {
      if (parentSigs[j] === ev.sig) {
        found = j;
        break;
      }
    }
    if (found < 0) break;
    offset = found + 1;
    matched++;
  }
  return matched;
}

/**
 * 两遍处理：先解析得到每个线程的事件，再按 fork 关系剔除重放前缀。
 * @param {Array} parsed parseCodexFile() 结果的数组（可带缓存）
 * @returns {Array} 去重后的全部事件
 */
function resolveForkedEvents(parsed) {
  const byThread = new Map();
  for (const p of parsed) if (p.threadId) byThread.set(p.threadId.toLowerCase(), p);

  const resolved = new Map(); // path -> events（已剔除重放）
  const resolving = new Set();

  function resolve(p) {
    if (resolved.has(p.path)) return resolved.get(p.path);
    if (resolving.has(p.path)) return p.events;
    resolving.add(p.path);

    let events = p.events;
    if (p.parentId) {
      const parent = byThread.get(String(p.parentId).toLowerCase());
      if (parent && parent.path !== p.path) {
        const parentEvents = resolve(parent);
        const parentSigs = parentEvents.map((e) => e.sig);
        const prefix = matchingReplayPrefix(events, parentSigs);
        if (prefix > 0) events = events.slice(prefix);
      }
    }
    resolving.delete(p.path);
    resolved.set(p.path, events);
    return events;
  }

  const all = [];
  for (const p of parsed) all.push(...resolve(p));
  return all;
}

module.exports = { parseCodexFile, resolveForkedEvents, classifyLine, RequestTimer };
