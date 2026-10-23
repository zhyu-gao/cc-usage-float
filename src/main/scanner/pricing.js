'use strict';
/**
 * 定价表与成本计算
 *
 * 对应 cc-switch:
 *   src-tauri/src/proxy/usage/calculator.rs   -> computeCost()
 *   src-tauri/src/services/model_pricing.rs   -> 定价表加载 / 归一化
 *
 * 与上游一致的两条关键语义：
 *  1) Codex / OpenAI 风格的 input_tokens 里已经包含 cached 与 cache_write，
 *     计费前必须扣掉，否则缓存命中的部分会被按输入价重复计费。
 *  2) Claude / Anthropic 的 input_tokens 不含缓存，直接用。
 */

const fs = require('fs');
const path = require('path');

/** 这些 app 的 input_tokens 包含 cache_read / cache_write（镜像上游 CACHE_INCLUSIVE_APP_TYPES） */
const CACHE_INCLUSIVE_APPS = new Set(['codex', 'gemini', 'grokbuild']);

const EFFORT_SUFFIXES = ['-xhigh', '-high', '-medium', '-low', '-minimal', '-none'];

function loadPricingTable(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const models = raw.models || {};
  return {
    models,
    usdToCny: Number(raw.usdToCny) || 7.2,
    currency: raw.currency || 'USD',
  };
}

/**
 * 归一化模型名（镜像上游 normalize_codex_model）：
 * 小写 -> 剥离 provider/ 前缀 -> 剥离 -YYYY-MM-DD 与 -YYYYMMDD 后缀
 */
function normalizeModel(raw) {
  if (!raw) return '';
  let name = String(raw).trim().toLowerCase();
  const slash = name.lastIndexOf('/');
  if (slash >= 0) name = name.slice(slash + 1);
  if (name.length > 11 && /-\d{4}-\d{2}-\d{2}$/.test(name)) name = name.slice(0, -11);
  if (name.length > 9 && /-\d{8}$/.test(name)) name = name.slice(0, -9);
  return name;
}

/** 查价：精确 -> 去 effort 后缀 -> 去版本锚点（:free 之类）-> 前缀匹配 */
function findPricing(models, modelId) {
  const name = normalizeModel(modelId);
  if (!name) return null;
  if (models[name]) return { key: name, ...models[name] };

  for (const suf of EFFORT_SUFFIXES) {
    if (name.endsWith(suf) && models[name.slice(0, -suf.length)]) {
      return { key: name.slice(0, -suf.length), ...models[name.slice(0, -suf.length)] };
    }
  }
  const colon = name.indexOf(':');
  if (colon > 0) {
    const base = name.slice(0, colon);
    if (models[base]) return { key: base, ...models[base] };
  }
  // 最长前缀匹配：gpt-5.1-codex-2026-01 -> gpt-5.1-codex
  let best = null;
  for (const key of Object.keys(models)) {
    if (name.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  if (best) return { key: best, ...models[best] };
  return null;
}

/**
 * 计算单次请求成本
 * @param {{input:number, output:number, cached:number, cacheWrite:number}} usage 内部统一用 cached 表示缓存命中
 * @returns {{input:number, output:number, cacheRead:number, cacheWrite:number, total:number}}
 */
function computeCost(appType, usage, pricing) {
  if (!pricing) {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, unpriced: true };
  }
  const M = 1_000_000;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const cacheRead = num(usage.cached);
  const cacheWrite = num(usage.cacheWrite);
  const inclusive = CACHE_INCLUSIVE_APPS.has(appType);
  const billableInput = inclusive
    ? Math.max(0, num(usage.input) - cacheRead - cacheWrite)
    : num(usage.input);

  const inputCost = (billableInput * pricing.input) / M;
  const outputCost = (num(usage.output) * pricing.output) / M;
  const cacheReadCost = (cacheRead * pricing.cacheRead) / M;
  const cacheWriteCost = (cacheWrite * pricing.cacheWrite) / M;

  return {
    input: inputCost,
    output: outputCost,
    cacheRead: cacheReadCost,
    cacheWrite: cacheWriteCost,
    total: inputCost + outputCost + cacheReadCost + cacheWriteCost,
    unpriced: false,
  };
}

module.exports = {
  CACHE_INCLUSIVE_APPS,
  loadPricingTable,
  normalizeModel,
  findPricing,
  computeCost,
};
