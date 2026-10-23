'use strict';
/**
 * Claude Code 会话日志（~/.claude/projects/<cwd>/<session>.jsonl）解析
 *
 * 与 Codex 的差别：
 *   - 一行一条消息，assistant 消息直接带 message.usage，无需差分（input_tokens 已不含缓存）；
 *   - 同一条消息可能被重复写入（流式落盘 / sidechain），按 message.id 去重；
 *   - 缓存写入区分 5m / 1h 两档，1h 写入按定价表的 1.6 倍计（与上游 calculator.rs 一致）。
 */

const fs = require('fs');
const path = require('path');
const { normalizeModel } = require('./pricing');

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function parseClaudeFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }

  const events = [];
  const seen = new Set();
  for (const line of text.split('\n')) {
    if (!line || line.length < 10 || !line.includes('"usage"')) continue;
    let v;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    if (v.type !== 'assistant') continue;
    const msg = v.message;
    if (!msg || !msg.usage) continue;

    const model = typeof msg.model === 'string' ? msg.model : '';
    if (model === '<synthetic>') continue;

    const u = msg.usage;
    const input = num(u.input_tokens);
    const output = num(u.output_tokens);
    const cacheRead = num(u.cache_read_input_tokens);
    const cacheWrite = num(u.cache_creation_input_tokens);
    if (input + output + cacheRead + cacheWrite === 0) continue;

    const dedupeKey = msg.id || v.uuid || `${v.timestamp}:${input}:${output}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const oneHour = u.cache_creation && typeof u.cache_creation.ephemeral_1h_input_tokens === 'number'
      ? u.cache_creation.ephemeral_1h_input_tokens
      : 0;

    events.push({
      sig: `${dedupeKey}`,
      delta: { input, cached: cacheRead, cacheWrite, output },
      cacheWrite1h: Math.min(oneHour, cacheWrite),
      model: normalizeModel(model),
      timestamp: v.timestamp || null,
      ts: v.timestamp ? Date.parse(v.timestamp) : null,
      timing: null,
      appType: 'claude',
      project: v.cwd || null,
    });
  }
  return events;
}

function parseClaudeDirectory(files) {
  const all = [];
  for (const f of files) all.push(...parseClaudeFile(f));
  return all;
}

module.exports = { parseClaudeFile, parseClaudeDirectory };
