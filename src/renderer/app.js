'use strict';

const card = document.getElementById('card');
const els = {
  scope: document.getElementById('scope'),
  amount: document.getElementById('amount'),
  meta: document.getElementById('meta'),
  delta: document.getElementById('delta'),
  mCost: document.getElementById('m-cost'),
  mReq: document.getElementById('m-req'),
  mTokens: document.getElementById('m-tokens'),
  mHit: document.getElementById('m-hit'),
  bars: document.getElementById('bars'),
  chartTitle: document.getElementById('chart-title'),
  chartSub: document.getElementById('chart-sub'),
  tableSub: document.getElementById('table-sub'),
  rows: document.getElementById('rows'),
  empty: document.getElementById('empty'),
  footSources: document.getElementById('foot-sources'),
  footUpdated: document.getElementById('foot-updated'),
  ranges: document.getElementById('ranges'),
  btnCurrency: document.getElementById('btn-currency'),
  btnRefresh: document.getElementById('btn-refresh'),
  btnMenu: document.getElementById('btn-menu'),
};

let state = null;
let currency = localStorage.getItem('ccuf-currency') || 'USD';
let rate = 7.2;

const RANGE_LABEL = { today: '今日', '7d': '近 7 天', '30d': '近 30 天', all: '全部' };

// ---------------------------------------------------------------- 格式化

function compact(n) {
  const v = Math.abs(n);
  if (v >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (v >= 1e4) return Math.round(n / 1e3) + 'K';
  if (v >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}

function money(usd, digits = 2) {
  if (currency === 'CNY') return '¥' + (usd * rate).toFixed(digits);
  return '$' + usd.toFixed(digits);
}

/** 主数字：超过千元去掉小数，字符太长时缩字号，避免撑破小胶囊 */
function setAmount(el, usd) {
  const digits = usd >= 1000 ? 0 : 2;
  const text = money(usd, digits);
  el.textContent = text;
  el.classList.toggle('long', text.length > 6);
  el.classList.toggle('xlong', text.length > 8);
}

function pct(v) {
  return (v * 100).toFixed(1) + '%';
}

function dur(ms) {
  if (ms === null || ms === undefined) return '—';
  const s = ms / 1000;
  if (s < 1) return Math.round(ms) + 'ms';
  if (s < 60) return s.toFixed(1) + 's';
  return Math.floor(s / 60) + 'm' + Math.round(s % 60) + 's';
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function ago(ts) {
  const d = Math.max(0, Date.now() - ts) / 1000;
  if (d < 60) return Math.round(d) + ' 秒前';
  if (d < 3600) return Math.round(d / 60) + ' 分钟前';
  return Math.round(d / 3600) + ' 小时前';
}

// ---------------------------------------------------------------- 渲染

function render(next) {
  state = next;
  card.classList.toggle('expanded', !!next.expanded);
  card.dataset.theme = next.theme || 'light';

  const s = next.snapshot;
  if (!s) return;
  if (next.pricingRate) rate = next.pricingRate;

  const sum = s.summary;
  els.scope.textContent = RANGE_LABEL[next.range] || '今日';
  setAmount(els.amount, sum.cost);
  els.meta.textContent = `${sum.requests} 次 · ${compact(sum.tokens)} tokens`;
  els.delta.textContent = sum.requests ? `缓存命中 ${pct(sum.hitRate)}` : '暂无请求';

  if (!next.expanded) return;

  els.mCost.textContent = money(sum.cost, sum.cost >= 1000 ? 0 : 2);
  els.mReq.textContent = String(sum.requests);
  els.mTokens.textContent = compact(sum.tokens);
  els.mHit.textContent = sum.requests ? pct(sum.hitRate) : '—';

  for (const btn of els.ranges.querySelectorAll('[data-range]')) {
    btn.classList.toggle('active', btn.dataset.range === next.range);
  }
  els.btnCurrency.textContent = currency === 'CNY' ? '¥ CNY' : '$ USD';

  renderBars(s);
  renderTable(s);
  els.footUpdated.textContent = '更新于 ' + ago(s.generatedAt);
  els.footSources.textContent = `日志 codex ${s.sources.codexFiles} · claude ${s.sources.claudeFiles}`;
}

function renderBars(s) {
  const buckets = s.buckets || [];
  const max = Math.max(1e-9, ...buckets.map((b) => b.cost));
  els.chartTitle.textContent = s.range.bucket === 'hour' ? '按小时花费' : '按天花费';
  const total = s.summary.cost;
  els.chartSub.textContent = total ? `${money(total, 2)} 合计` : '';

  els.bars.innerHTML = buckets
    .map((b) => {
      const h = b.cost > 0 ? Math.max(3, Math.round((b.cost / max) * 54)) : 2;
      const cls = b.cost > 0 ? 'bar' : 'bar zero';
      const tip = `${b.label} · ${money(b.cost, 4)} · ${b.requests} 次 · ${compact(b.tokens)} tokens`;
      return `<div class="${cls}" style="height:${h}px" title="${esc(tip)}"></div>`;
    })
    .join('');

  // 轴标签：小时桶给 0/6/12/18，天桶给首中尾
  const labels = document.createElement('div');
  labels.className = 'bar-labels';
  if (s.range.bucket === 'hour') {
    labels.innerHTML = '<span>00</span><span>06</span><span>12</span><span>18</span><span>24</span>';
  } else if (buckets.length) {
    const first = buckets[0].label;
    const mid = buckets[Math.floor(buckets.length / 2)].label;
    const last = buckets[buckets.length - 1].label;
    labels.innerHTML = `<span>${esc(first)}</span><span>${esc(mid)}</span><span>${esc(last)}</span>`;
  }
  const old = els.bars.nextElementSibling;
  if (old && old.classList.contains('bar-labels')) old.remove();
  els.bars.after(labels);
}

function renderTable(s) {
  const rows = s.detail || [];
  els.tableSub.textContent = rows.length ? `${s.summary.requests} 条` : '';
  els.empty.hidden = rows.length > 0;

  els.rows.innerHTML = rows
    .slice(0, 200)
    .map((r) => {
      const appTag = r.appType === 'claude' ? '<span class="tag">CC</span>' : '';
      const ttft = r.ttftMs ? '≈' + dur(r.ttftMs) : '—';
      return (
        `<tr title="${esc(r.project || '')} · 耗时 ${dur(r.latencyMs)} · ${
          r.speed ? r.speed.toFixed(1) + ' tokens/s' : '速度未知'
        } · 缓存写 ${r.cacheWrite}">` +
        `<td class="c-time">${esc(r.time)}</td>` +
        `<td class="c-model">${esc(r.model)}${appTag}</td>` +
        `<td class="c-num">${r.input.toLocaleString()}</td>` +
        `<td class="c-num">${r.output.toLocaleString()}</td>` +
        `<td class="c-num">${compact(r.cacheRead)}</td>` +
        `<td class="c-num">${r.priced ? money(r.cost, 4) : '<span title="该模型没有定价">—</span>'}</td>` +
        `<td class="c-num">${ttft}</td>` +
        `<td class="c-num">${r.speed ? r.speed.toFixed(0) + '/s' : '—'}</td>` +
        '</tr>'
      );
    })
    .join('');
}

// ---------------------------------------------------------------- 交互

// 点击 = 展开/收起；拖动 = 移动窗口（由主进程判断位移）
let down = false;

card.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (e.target.closest('button')) return;
  down = true;
  window.api.dragStart({ mx: e.screenX, my: e.screenY });
});

function endDrag() {
  if (!down) return;
  down = false;
  window.api.dragEnd();
}

window.addEventListener('mouseup', endDrag);
// 窗口失焦时兜底（正常拖动时窗口跟着光标走，不会触发 mouseleave）
window.addEventListener('blur', endDrag);

card.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.api.showMenu();
});

els.btnMenu.addEventListener('click', () => window.api.showMenu());

els.btnRefresh.addEventListener('click', async () => {
  els.btnRefresh.classList.add('spin');
  await window.api.refresh();
  setTimeout(() => els.btnRefresh.classList.remove('spin'), 450);
});

els.ranges.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-range]');
  if (!btn) return;
  window.api.setRange(btn.dataset.range);
});

els.btnCurrency.addEventListener('click', () => {
  currency = currency === 'CNY' ? 'USD' : 'CNY';
  localStorage.setItem('ccuf-currency', currency);
  if (state) render(state);
});

// 滚轮切时间范围（收起态也能用），Esc 收起
const RANGE_ORDER = ['today', '7d', '30d', 'all'];
card.addEventListener(
  'wheel',
  (e) => {
    if (!state) return;
    // 明细表和范围条自己的滚动不抢
    if (e.target.closest('.table-wrap, .ranges')) return;
    const i = RANGE_ORDER.indexOf(state.range);
    const next = RANGE_ORDER[Math.min(RANGE_ORDER.length - 1, Math.max(0, i + (e.deltaY > 0 ? 1 : -1)))];
    if (next && next !== state.range) window.api.setRange(next);
  },
  { passive: true }
);

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state && state.expanded) window.api.toggle();
});

// 双击标题区切主题，方便对比浅色 / 深色
document.querySelector('.head').addEventListener('dblclick', () => {
  const nextTheme = card.dataset.theme === 'dark' ? 'light' : 'dark';
  window.api.setTheme(nextTheme);
  card.dataset.theme = nextTheme;
});

// ---------------------------------------------------------------- 启动

window.api.getInitialState().then(async (init) => {
  render(init);
  try {
    const cfg = await window.api.getUsage(init.range);
    if (cfg) render({ ...init, snapshot: cfg });
  } catch (e) {
    console.error(e);
  }
});

window.api.onState((next) => render(next));
