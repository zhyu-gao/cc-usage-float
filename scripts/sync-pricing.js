'use strict';
/**
 * 从 models.dev 同步定价表 -> data/pricing.json
 *
 * 用法：node scripts/sync-pricing.js
 *
 * 规则：
 *  - 同名模型按 provider 优先级取官方价（openai / anthropic / google / xai ...）；
 *  - 只取基础档（context < 200k 的第一档），大上下文阶梯价不参与，与 cc-switch 口径一致；
 *  - 手工在 pricing.json 的 overrides 里写的模型优先级最高，重跑不会被覆盖。
 */

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data', 'pricing.json');
const PROVIDER_PRIORITY = [
  'openai',
  'anthropic',
  'google',
  'xai',
  'deepseek',
  'qwen',
  'moonshotai',
  'zhipuai',
  'minimax',
  'mistral',
  'groq',
];

function providerRank(id) {
  const i = PROVIDER_PRIORITY.indexOf(id);
  return i < 0 ? PROVIDER_PRIORITY.length : i;
}

async function main() {
  const res = await fetch('https://models.dev/api.json');
  if (!res.ok) throw new Error('models.dev ' + res.status);
  const api = await res.json();

  const existing = fs.existsSync(DATA) ? JSON.parse(fs.readFileSync(DATA, 'utf8')) : {};
  const overrides = existing.overrides || {};

  const picked = new Map();
  const providers = Object.entries(api).sort((a, b) => providerRank(a[0]) - providerRank(b[0]));

  for (const [pid, prov] of providers) {
    const models = prov.models || {};
    for (const [id, m] of Object.entries(models)) {
      const c = m.cost;
      if (!c || typeof c.input !== 'number') continue;
      const key = String(id).toLowerCase();
      const entry = {
        name: m.name || key,
        input: c.input,
        output: typeof c.output === 'number' ? c.output : 0,
        cacheRead: typeof c.cache_read === 'number' ? c.cache_read : 0,
        cacheWrite: typeof c.cache_write === 'number' ? c.cache_write : 0,
        provider: pid,
      };
      const prev = picked.get(key);
      if (!prev) picked.set(key, entry);
      else if (prev.input === 0 && entry.input > 0) picked.set(key, entry);
    }
  }

  // 里层用 effort 后缀区分档位、外层没有的，补一个无后缀别名
  for (const [key, v] of [...picked]) {
    for (const suf of ['-xhigh', '-high', '-medium', '-low', '-minimal']) {
      if (key.endsWith(suf)) {
        const base = key.slice(0, -suf.length);
        if (!picked.has(base)) picked.set(base, { ...v, name: v.name.replace(new RegExp(suf + '$', 'i'), '') });
        break;
      }
    }
  }

  for (const [key, v] of Object.entries(overrides)) picked.set(key.toLowerCase(), v);

  const models = {};
  for (const key of [...picked.keys()].sort()) models[key] = picked.get(key);

  const out = {
    _comment:
      '单位 USD / 100万 tokens。input=新增输入 output=输出 cacheRead=缓存命中 cacheWrite=缓存写入。' +
      '由 scripts/sync-pricing.js 从 models.dev 生成；overrides 里的条目重跑不会丢，可自行改价。',
    updatedAt: new Date().toISOString(),
    currency: 'USD',
    usdToCny: existing.usdToCny || 7.2,
    overrides,
    models,
  };

  fs.writeFileSync(DATA, JSON.stringify(out, null, 1), 'utf8');
  console.log(`pricing.json 写入 ${Object.keys(models).length} 个模型`);
  for (const probe of ['gpt-6.1-sol', 'gpt-5.1-codex', 'claude-sonnet-4-5']) {
    if (models[probe]) console.log('  ', probe, JSON.stringify(models[probe]));
  }
}

main().catch((e) => {
  console.error('同步失败:', e.message);
  process.exit(1);
});
