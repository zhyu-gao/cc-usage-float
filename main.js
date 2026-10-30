'use strict';
/**
 * Electron 主进程
 *
 * 窗口形态：
 *   - 收起：只有金额的小胶囊（COLLAPSED）
 *   - 展开：指标 + 趋势 + 明细（EXPANDED）
 * 点击切换，拖动移动，位置/范围/主题持久化到 userData/config.json。
 */

const { app, BrowserWindow, ipcMain, screen, Menu, globalShortcut, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { buildSnapshot, defaultPricingFile } = require('./src/main/scanner');
const { loadPricingTable } = require('./src/main/scanner/pricing');

const COLLAPSED = { width: 272, height: 106 };
const EXPANDED = { width: 560, height: 660 };
// 贴边后的固定胶囊形态，相当于 iPhone 刘海 / 灵动岛的收起态。
// 左右贴边时比收起态窄，贴顶时留出两侧弧形肩部的空间。
const MINI = { width: 220, height: 80 };
const MIN_VISIBLE = 60;

// ---------------------------------------------------------------- 贴边
// EDGE_INSET 与渲染层 body 的 padding 对齐：贴边时把窗口多送出这一点，
// 卡片描边正好压在工作区边界上，否则会留一条透明的 12px 缝。
const EDGE_INSET = 12;
const SNAP_DISTANCE = 32; // 松手时距边缘多少像素内吸附

// 透明窗口 + 部分显卡驱动 / 受限会话会让 Chromium 的 GPU 进程崩溃
// （exit_code=0xC0000005 → "GPU process isn't usable"）。悬浮窗渲染量极小，
// 默认走软件渲染；需要硬件加速时设 CCUF_GPU=1。
// 若启动即退出，再设 CCUF_NO_SANDBOX=1（等价 --no-sandbox）绕开 GPU 沙箱。
if (process.env.CCUF_GPU !== '1') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
}
if (process.env.CCUF_NO_SANDBOX === '1') {
  app.commandLine.appendSwitch('no-sandbox');
}

let win = null;
let config = null;
let refreshTimer = null;
let lastSnapshot = new Map(); // preset -> snapshot
let usdToCny = 7.2;
let isExpanded = false;
let mini = false;
let dragState = null;

// ---------------------------------------------------------------- 配置

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function defaultConfig() {
  return {
    x: null,
    y: null,
    range: 'today',
    theme: 'light',
    opacity: 1,
    alwaysOnTop: true,
    refreshSeconds: 30,
    extraRoots: { codex: [], claude: [] },
    expanded: false,
    // 贴边：edge 记录吸附到哪一侧，null 表示自由悬浮
    edge: null,
    snapEnabled: true,
    // 刘海 / 灵动岛式的胶囊收起，默认开启；关掉就回到普通悬浮窗
    autoHide: true,
  };
}

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return { ...defaultConfig(), ...raw, extraRoots: { ...defaultConfig().extraRoots, ...(raw.extraRoots || {}) } };
  } catch {
    return defaultConfig();
  }
}

function saveConfig() {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {
    console.error('保存配置失败', e.message);
  }
}

// ---------------------------------------------------------------- 开机自启动

/**
 * Windows 上最终落到 HKCU\Software\Microsoft\Windows\CurrentVersion\Run，
 * 值为 `"<path>" <args...>`。
 *
 * 开发模式（npm start）下 process.execPath 是 node_modules 里的 electron.exe，
 * 必须把工程目录作为参数带上，否则开机时只会拉起一个空的 Electron 壳。
 * 打包后 execPath 就是产品 exe，不需要额外参数。
 */
function loginItemOptions() {
  if (app.isPackaged) return { path: process.execPath, args: [] };
  const args = [app.getAppPath()];
  // 与 start-compat.bat 对齐：受限会话下需要绕开 GPU 沙箱，否则开机拉起即退出
  if (process.env.CCUF_NO_SANDBOX === '1') args.push('--no-sandbox', '--disable-gpu');
  return { path: process.execPath, args };
}

/** 以系统登录项为准，不在 config.json 里另存一份，避免两边不一致 */
function autoLaunchEnabled() {
  try {
    return !!app.getLoginItemSettings(loginItemOptions()).openAtLogin;
  } catch (e) {
    console.error('读取自启动状态失败', e.message);
    return false;
  }
}

/** 返回写入后回读的真实状态，供调用方判断是否生效 */
function setAutoLaunch(enabled) {
  const opts = { ...loginItemOptions(), openAtLogin: !!enabled };
  if (process.platform === 'darwin') opts.openAsHidden = true;
  try {
    app.setLoginItemSettings(opts);
  } catch (e) {
    console.error('设置自启动失败', e.message);
    return !enabled;
  }
  return autoLaunchEnabled();
}

// ---------------------------------------------------------------- 窗口

function clampToDisplay(x, y) {
  const displays = screen.getAllDisplays();
  for (const d of displays) {
    const a = d.workArea;
    // 贴顶时窗口 y 一定是 area.y - EDGE_INSET（负值），别把它当成"跑到屏幕外"再踢回默认位置
    if (
      x >= a.x - MIN_VISIBLE &&
      x <= a.x + a.width - MIN_VISIBLE &&
      y >= a.y - EDGE_INSET - 2 &&
      y <= a.y + a.height - MIN_VISIBLE
    ) {
      return { x, y, ok: true };
    }
  }
  const a = screen.getPrimaryDisplay().workArea;
  return { x: a.x + a.width - COLLAPSED.width - 24, y: a.y + 120, ok: false };
}

/** 窗口所在显示器的工作区（多屏时按窗口位置取，不能用 primaryDisplay） */
function workAreaOf(bounds) {
  const d = screen.getDisplayMatching(bounds) || screen.getPrimaryDisplay();
  return d.workArea;
}

function clampY(y, height, area) {
  const max = Math.max(area.y, area.y + area.height - height);
  return Math.max(area.y, Math.min(max, y));
}

/** 贴边窗口的 x：卡片外侧边缘压在工作区边界上 */
function edgeX(edge, width, area) {
  if (edge === 'left') return area.x - EDGE_INSET;
  if (edge === 'right') return area.x + area.width - width + EDGE_INSET;
  return null;
}

function createWindow() {
  const target = isExpanded ? EXPANDED : COLLAPSED;
  // 贴顶时窗口比卡片矮 12px（顶部内边距由 CSS 去掉），窗口顶边就是工作区顶边
  const winHeight = config.edge === 'top' ? target.height - EDGE_INSET : target.height;
  let pos;
  if (config.edge) {
    // 贴边态位置由工作区推导，避免换了分辨率/显示器后停在屏幕外
    const area = config.x === null || config.y === null
      ? screen.getPrimaryDisplay().workArea
      : workAreaOf({ x: config.x, y: config.y, width: 1, height: 1 });
    const anchoredX = edgeX(config.edge, target.width, area);
    const x = anchoredX === null
      ? config.x === null
        ? area.x + area.width - target.width - 24
        : config.x
      : anchoredX;
    const y = config.edge === 'top'
      ? area.y
      : config.y === null
      ? area.y + 120
      : config.y;
    pos = { x: Math.round(x), y: Math.round(clampY(y, winHeight, area)), ok: true };
  } else if (config.x === null || config.y === null) {
    const a = screen.getPrimaryDisplay().workArea;
    pos = { x: a.x + a.width - target.width - 24, y: a.y + 120, ok: true };
  } else {
    pos = { x: config.x, y: config.y, ok: true };
  }
  pos = clampToDisplay(pos.x, pos.y);

  win = new BrowserWindow({
    width: target.width,
    height: winHeight,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: config.alwaysOnTop,
    show: false,
    title: '用量悬浮窗',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (config.alwaysOnTop) win.setAlwaysOnTop(true, 'floating');
  win.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    // 启动时若已在吸附范围内就直接吸上去（默认位置距右边 24px），省得第一次还要手动贴
    if (!config.edge && config.snapEnabled && snapToEdge(false)) saveConfig();
    applyShape(false, false);
    win.setOpacity(config.opacity);
    win.show();
    refreshAll();
    if (process.env.CCUF_SHOT) captureAndQuit();
  });

  win.on('closed', () => {
    win = null;
  });
}

/** 仅用于本次开发自检：把窗口内容抓成 PNG 后退出 */
async function captureAndQuit() {
  const delay = Number(process.env.CCUF_SHOT_DELAY || 1800);
  await new Promise((r) => setTimeout(r, delay));
  if (process.env.CCUF_SHOT_EXPAND === '1') {
    applyShape(true, false);
    await new Promise((r) => setTimeout(r, 600));
  }
  try {
    const b = win.getBounds();
    console.log('bounds', JSON.stringify(b), 'edge', config.edge, 'mini', mini);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(process.env.CCUF_SHOT, img.toPNG());
    console.log('shot ->', process.env.CCUF_SHOT);
  } catch (e) {
    console.error('截图失败', e.message);
  }
  app.quit();
}

/** 目标形态：贴边时锚定外侧边缘，展开不会把卡片推出屏幕。 */
function clampX(x, width, area) {
  return Math.max(area.x - EDGE_INSET, Math.min(area.x + area.width - width + EDGE_INSET, x));
}

function targetSize(expanded, small) {
  if (expanded) return EXPANDED;
  if (small && config.edge === 'top') return { ...MINI, width: 428, height: 68 };
  return small ? MINI : COLLAPSED;
}

/**
 * 三态尺寸（EXPANDED / COLLAPSED / MINI）+ 贴边锚定：
 * 贴左锚左、贴右锚右、贴顶锚上并在水平方向保持中心；
 * 自由悬浮时按窗口中心在屏幕哪一侧决定往哪边生长。
 */
function shapeBounds(expanded, small, from) {
  const target = targetSize(expanded, small);
  const b = from || win.getBounds();
  const area = workAreaOf(b);
  let x;
  const anchored = edgeX(config.edge, target.width, area);
  if (anchored !== null) {
    x = anchored;
  } else if (config.edge === 'top') {
    x = b.x + b.width / 2 - target.width / 2;
  } else {
    const growLeft = b.x + b.width / 2 > area.x + area.width / 2;
    x = growLeft ? b.x - (target.width - b.width) : b.x;
  }
  const topDocked = config.edge === 'top';
  // 贴顶时窗口顶部对齐工作区顶边，再由 CSS 把卡片上内边距去掉让它贴住屏幕。
  // 不能像左右贴边那样把窗口推出屏幕 12px —— 副屏与主屏有垂直偏移时，
  // 推出去的那 12px 会落在虚拟桌面的无显示区，露出一条黑带。
  const height = topDocked ? target.height - EDGE_INSET : target.height;
  const y = topDocked ? area.y : clampY(b.y, height, area);
  return {
    x: Math.round(clampX(x, target.width, area)),
    y: Math.round(y),
    width: target.width,
    height,
  };
}

function applyShape(expanded, animate = true) {
  if (!win) return;
  isExpanded = expanded;
  config.expanded = expanded;
  mini = Boolean(config.edge && config.autoHide && !expanded);
  saveConfig();

  // 展开 / 收起时打断进行中的动画，避免两个 setBounds 抢同一个窗口
  if (win.__animTimer) {
    clearInterval(win.__animTimer);
    win.__animTimer = null;
  }
  const target = shapeBounds(expanded, mini);
  if (!animate) win.setBounds(target);
  else animateBounds(win, target, 220, easeOutBack);
  pushState();
}

/** 松手吸附：返回贴上的边，未吸附返回 null */
function snapToEdge(animate = true) {
  if (!config.snapEnabled || !win) return null;
  const b = win.getBounds();
  const area = workAreaOf(b);
  const d = {
    left: b.x - area.x,
    right: area.x + area.width - (b.x + b.width),
    top: b.y - area.y,
  };
  let edge = null;
  let best = SNAP_DISTANCE + 1;
  for (const name of ['left', 'right', 'top']) {
    if (d[name] <= SNAP_DISTANCE && d[name] < best) {
      best = d[name];
      edge = name;
    }
  }
  if (!edge) return null;

  config.edge = edge;
  mini = Boolean(config.autoHide && !isExpanded);
  const target = shapeBounds(isExpanded, mini);
  config.x = target.x;
  config.y = target.y;
  if (animate) animateBounds(win, target, 180, easeOutBack);
  else win.setBounds(target);
  return edge;
}

/** 菜单里手动贴边；top 走刘海位（水平居中） */
function dock(edge) {
  if (!win) return;
  config.edge = edge;
  mini = Boolean(config.autoHide && !isExpanded);
  if (win.__animTimer) {
    clearInterval(win.__animTimer);
    win.__animTimer = null;
  }
  let target = shapeBounds(isExpanded, mini);
  if (edge === 'top') {
    const area = workAreaOf(target);
    target = { ...target, x: Math.round(area.x + (area.width - target.width) / 2) };
  }
  config.x = target.x;
  config.y = target.y;
  saveConfig();
  animateBounds(win, target, 220, easeOutBack);
  pushState();
}

/** 分辨率 / 显示器变化后重新贴合，避免窗口停在屏幕外 */
function reflowEdge() {
  if (!win || win.isDestroyed() || !config.edge) return;
  if (win.__animTimer) {
    clearInterval(win.__animTimer);
    win.__animTimer = null;
  }
  const target = shapeBounds(isExpanded, mini);
  win.setBounds(target);
  if (!mini) {
    config.x = target.x;
    config.y = target.y;
    saveConfig();
  }
}

/** 灵动岛式的轻微过冲：先冲过目标再回弹，比纯 easeOut 更有"弹"的手感 */
function easeOutBack(p) {
  const s = 1.1;
  const q = p - 1;
  return 1 + (s + 1) * q * q * q + s * q * q;
}

function animateBounds(w, target, duration, easing) {
  const start = w.getBounds();
  const t0 = Date.now();
  if (w.__animTimer) clearInterval(w.__animTimer);
  w.__animTimer = setInterval(() => {
    if (!w || w.isDestroyed()) {
      clearInterval(w.__animTimer);
      return;
    }
    const p = Math.min(1, (Date.now() - t0) / duration);
    if (p >= 1) {
      clearInterval(w.__animTimer);
      w.__animTimer = null;
      // 收尾直接落到整数值，避免过冲曲线留下 1px 抖动
      w.setBounds(target);
      return;
    }
    const e = easing ? easing(p) : 1 - Math.pow(1 - p, 3);
    const lerp = (a, b) => Math.round(a + (b - a) * e);
    w.setBounds({
      x: lerp(start.x, target.x),
      y: lerp(start.y, target.y),
      width: lerp(start.width, target.width),
      height: lerp(start.height, target.height),
    });
  }, 16);
}

// ---------------------------------------------------------------- 数据

function pricingTable() {
  try {
    const t = loadPricingTable(defaultPricingFile());
    if (t.usdToCny) usdToCny = t.usdToCny;
    return t;
  } catch (e) {
    console.error('定价表读取失败', e.message);
    return { models: {}, usdToCny, currency: 'USD' };
  }
}

function getSnapshot(preset, force) {
  if (!force && lastSnapshot.has(preset)) return lastSnapshot.get(preset);
  const snap = buildSnapshot({ range: preset, extraRoots: config.extraRoots, pricingTable: pricingTable() });
  lastSnapshot.set(preset, snap);
  return snap;
}

function refreshAll() {
  lastSnapshot.clear();
  const main = getSnapshot(config.range, true);
  // 收起态也需要「今日」，展开后切范围要快，这里顺带预热
  getSnapshot('today', true);
  pushState(main);
}

function pushState(snapshot) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('state', {
    expanded: isExpanded,
    range: config.range,
    theme: config.theme,
    opacity: config.opacity,
    alwaysOnTop: config.alwaysOnTop,
    refreshSeconds: config.refreshSeconds,
    pricingRate: usdToCny,
    edge: config.edge,
    mini,
    snapshot: snapshot || getSnapshot(config.range, true),
  });
}

function scheduleRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  const ms = Math.max(5, config.refreshSeconds) * 1000;
  refreshTimer = setInterval(() => {
    lastSnapshot.clear();
    pushState(getSnapshot(config.range, true));
  }, ms);
}

// ---------------------------------------------------------------- IPC

ipcMain.handle('state:get', () => ({
  expanded: isExpanded,
  range: config.range,
  theme: config.theme,
  opacity: config.opacity,
  alwaysOnTop: config.alwaysOnTop,
  pricingRate: usdToCny,
  edge: config.edge,
  mini,
  snapshot: getSnapshot(config.range),
}));

ipcMain.handle('usage:get', (_e, preset) => getSnapshot(preset, true));

ipcMain.handle('usage:refresh', () => {
  refreshAll();
  return true;
});

ipcMain.on('window:toggle', () => applyShape(!isExpanded));

ipcMain.on('window:set-expanded', (_e, v) => applyShape(!!v));

ipcMain.on('range:set', (_e, preset) => {
  config.range = preset;
  saveConfig();
  pushState(getSnapshot(preset, true));
});

ipcMain.on('theme:set', (_e, theme) => {
  config.theme = theme;
  saveConfig();
});

ipcMain.on('opacity:set', (_e, v) => {
  config.opacity = Math.min(1, Math.max(0.4, Number(v) || 1));
  saveConfig();
  if (win) win.setOpacity(config.opacity);
});

ipcMain.on('ontop:set', (_e, v) => {
  config.alwaysOnTop = !!v;
  saveConfig();
  if (win) win.setAlwaysOnTop(config.alwaysOnTop, 'floating');
});

ipcMain.on('refresh-interval:set', (_e, sec) => {
  config.refreshSeconds = Number(sec) || 30;
  saveConfig();
  scheduleRefresh();
});

// ---- 拖动：主进程轮询光标，比逐帧回传 mousemove 更稳
ipcMain.on('drag:start', (_e, { mx, my }) => {
  if (!win) return;
  // 打断进行中的动画即可；胶囊态保持原尺寸拖动，避免按下瞬间先"闪大"一下
  if (win.__animTimer) {
    clearInterval(win.__animTimer);
    win.__animTimer = null;
  }
  const [wx, wy] = win.getPosition();
  const cursor = screen.getCursorScreenPoint();
  dragState = {
    dx: cursor.x - wx,
    dy: cursor.y - wy,
    startX: cursor.x,
    startY: cursor.y,
    moved: false,
    startedAt: Date.now(),
    timer: setInterval(() => {
      if (!win || win.isDestroyed() || !dragState) return;
      // 兜底：正常拖动最多十几秒，超过 20 秒说明 mouseup 丢了
      if (Date.now() - dragState.startedAt > 20000) {
        clearInterval(dragState.timer);
        dragState = null;
        return;
      }
      const c = screen.getCursorScreenPoint();
      if (Math.abs(c.x - dragState.startX) > 3 || Math.abs(c.y - dragState.startY) > 3) dragState.moved = true;
      if (dragState.moved) win.setPosition(c.x - dragState.dx, c.y - dragState.dy);
    }, 12),
  };
  void mx;
  void my;
});

ipcMain.on('drag:end', () => {
  if (!dragState) return;
  clearInterval(dragState.timer);
  const moved = dragState.moved;
  dragState = null;
  if (!win) return;
  if (moved) {
    // 松手先按原位置记一份，没吸上边就是自由悬浮
    config.edge = null;
    if (!snapToEdge()) {
      // 胶囊被拖离边缘：恢复收起态尺寸，否则会停在 168×56 却仍按 mini 管理
      const b = win.getBounds();
      mini = false;
      const target = { x: b.x, y: b.y, width: COLLAPSED.width, height: COLLAPSED.height };
      win.setBounds(target);
      config.x = target.x;
      config.y = target.y;
    }
    saveConfig();
    pushState();
  } else {
    applyShape(!isExpanded);
  }
});

ipcMain.on('menu:show', () => {
  if (!win) return;
  const menu = Menu.buildFromTemplate([
    { label: isExpanded ? '收起' : '展开', click: () => applyShape(!isExpanded) },
    {
      label: '窗口置顶',
      type: 'checkbox',
      checked: config.alwaysOnTop,
      click: (item) => {
        config.alwaysOnTop = item.checked;
        saveConfig();
        if (win) win.setAlwaysOnTop(config.alwaysOnTop, 'floating');
        pushState();
      },
    },
    {
      label: '开机自启动',
      type: 'checkbox',
      checked: autoLaunchEnabled(),
      click: (item) => {
        const actual = setAutoLaunch(item.checked);
        // 系统写入被拦下时勾选状态不可信，明确告知，别让用户以为设上了
        if (actual !== item.checked) {
          dialog.showMessageBox({
            type: 'warning',
            title: '开机自启动',
            message: item.checked ? '设置开机自启动失败' : '取消开机自启动失败',
            detail: '系统未接受登录项修改，可能被安全软件拦截。可在「任务管理器 → 启动应用」中手动调整。',
            buttons: ['好'],
          });
        }
      },
    },
    { type: 'separator' },
    {
      label: '贴边',
      submenu: [
        {
          label: '磁吸屏幕边缘',
          type: 'checkbox',
          checked: config.snapEnabled,
          click: (item) => {
            config.snapEnabled = item.checked;
            saveConfig();
          },
        },
        {
          label: '贴边后缩成胶囊',
          type: 'checkbox',
          checked: config.autoHide,
          click: (item) => {
            config.autoHide = item.checked;
            applyShape(isExpanded);
          },
        },
        { type: 'separator' },
        {
          label: '贴到顶部（刘海位）',
          type: 'radio',
          checked: config.edge === 'top',
          click: () => dock('top'),
        },
        {
          label: '贴到左边缘',
          type: 'radio',
          checked: config.edge === 'left',
          click: () => dock('left'),
        },
        {
          label: '贴到右边缘',
          type: 'radio',
          checked: config.edge === 'right',
          click: () => dock('right'),
        },
        {
          label: '取消贴边',
          type: 'radio',
          checked: !config.edge,
          click: () => {
            config.edge = null;
            applyShape(isExpanded);
          },
        },
      ],
    },
    {
      label: '刷新间隔',
      submenu: [10, 30, 60, 300].map((s) => ({
        label: s < 60 ? `${s} 秒` : `${s / 60} 分钟`,
        type: 'radio',
        checked: config.refreshSeconds === s,
        click: () => {
          config.refreshSeconds = s;
          saveConfig();
          scheduleRefresh();
          pushState();
        },
      })),
    },
    {
      label: '透明度',
      submenu: [1, 0.9, 0.8, 0.7].map((o) => ({
        label: `${Math.round(o * 100)}%`,
        type: 'radio',
        checked: Math.abs(config.opacity - o) < 0.01,
        click: () => {
          config.opacity = o;
          saveConfig();
          if (win) win.setOpacity(o);
          pushState();
        },
      })),
    },
    { type: 'separator' },
    { label: '立即刷新', click: () => { refreshAll(); } },
    { label: '打开定价文件…', click: () => shell.openPath(defaultPricingFile()) },
    { label: '重新同步定价…', click: () => runPricingSync() },
    { label: '打开配置目录', click: () => shell.openPath(app.getPath('userData')) },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
  menu.popup({ window: win });
});

async function runPricingSync() {
  const script = path.join(__dirname, 'scripts', 'sync-pricing.js');
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d.toString()));
  child.stderr.on('data', (d) => (out += d.toString()));
  child.on('close', (code) => {
    refreshAll();
    dialog.showMessageBox({
      type: code === 0 ? 'info' : 'error',
      title: '定价同步',
      message: code === 0 ? '定价表已更新' : '定价同步失败',
      detail: out.slice(-800) || `exit ${code}`,
      buttons: ['好'],
    });
  });
}

// ---------------------------------------------------------------- 生命周期

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    config = loadConfig();
    isExpanded = false; // 每次启动都从收起态开始，别一上来糊住桌面
    app.setAppUserModelId('io.ccusage.float');
    createWindow();
    scheduleRefresh();

    for (const evt of ['display-metrics-changed', 'display-added', 'display-removed']) {
      screen.on(evt, reflowEdge);
    }

    globalShortcut.register('Control+Alt+U', () => {
      if (!win) return;
      if (win.isVisible()) win.hide();
      else {
        win.show();
        win.focus();
      }
    });
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
