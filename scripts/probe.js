'use strict';
/** 命令行探针：不启动界面，直接看扫描结果，用于校验解析是否与 cc-switch 对得上 */

const { buildSnapshot } = require('../src/main/scanner');

function money(n) {
  return '$' + n.toFixed(4);
}
function compact(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return String(n);
}

for (const range of ['today', '7d', '30d', 'all']) {
  const t0 = Date.now();
  const snap = buildSnapshot({ range });
  const s = snap.summary;
  console.log(
    `\n[${range}] cost=${money(s.cost)} requests=${s.requests} tokens=${compact(s.tokens)} ` +
      `in=${compact(s.input)} out=${compact(s.output)} cacheR=${compact(s.cacheRead)} ` +
      `hitRate=${(s.hitRate * 100).toFixed(1)}%  (${Date.now() - t0}ms)`
  );
  console.log(
    `  files: codex=${snap.sources.codexFiles} claude=${snap.sources.claudeFiles} ` +
      `events: codex=${snap.sources.codexRequests} claude=${snap.sources.claudeRequests}`
  );
  if (snap.unpricedModels.length) console.log('  未定价模型:', snap.unpricedModels.join(', '));
}

const all = buildSnapshot({ range: '30d' });
console.log('\n--- 按模型 ---');
for (const m of all.models.slice(0, 8)) {
  console.log(`${m.model.padEnd(28)} req=${String(m.requests).padStart(4)} cost=${money(m.cost)} tokens=${compact(m.tokens)}`);
}
console.log('\n--- 按天 ---');
for (const b of all.buckets.slice(-8)) {
  console.log(`${b.label.padEnd(6)} req=${String(b.requests).padStart(4)} cost=${money(b.cost)} tokens=${compact(b.tokens)}`);
}
console.log('\n--- 最近 8 条明细（今日）---');
const today = buildSnapshot({ range: 'today' });
for (const d of today.detail.slice(0, 8)) {
  console.log(
    `${d.time} ${d.model.padEnd(24)} in=${String(d.input).padStart(6)} out=${String(d.output).padStart(5)} ` +
      `cache=${compact(d.cacheRead).padStart(6)} cost=${money(d.cost)} ttft=${d.ttftMs ? (d.ttftMs / 1000).toFixed(1) + 's' : '-'} ` +
      `speed=${d.speed ? d.speed.toFixed(1) + 't/s' : '-'}`
  );
}
if (!today.detail.length) {
  console.log('(今日无请求，改用 30d 里最近的明细)');
  for (const d of all.detail.slice(0, 8)) {
    console.log(
      `${d.date} ${d.time} ${d.model.padEnd(24)} in=${String(d.input).padStart(6)} out=${String(d.output).padStart(5)} ` +
        `cache=${compact(d.cacheRead).padStart(6)} cost=${money(d.cost)} ttft=${d.ttftMs ? (d.ttftMs / 1000).toFixed(1) + 's' : '-'}`
    );
  }
}
