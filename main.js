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

const COLLAPSED = { width: 308, height: 106 };
const EXPANDED = { width: 560, height: 660 };
const MIN_VISIBLE = 60;

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
    if (x >= a.x - MIN_VISIBLE && x <= a.x + a.width - MIN_VISIBLE && y >= a.y - 10 && y <= a.y + a.height - MIN_VISIBLE) {
      return { x, y, ok: true };
    }
  }
  const a = screen.getPrimaryDisplay().workArea;
  return { x: a.x + a.width - COLLAPSED.width - 24, y: a.y + 120, ok: false };
}

function createWindow() {
  const target = isExpanded ? EXPANDED : COLLAPSED;
  let pos = { x: config.x, y: config.y, ok: true };
  if (config.x === null || config.y === null) {
    const a = screen.getPrimaryDisplay().workArea;
    pos = { x: a.x + a.width - target.width - 24, y: a.y + 120, ok: true };
  }
  pos = clampToDisplay(pos.x, pos.y);

  win = new BrowserWindow({
    width: target.width,
    height: target.height,
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
    win.show();
    win.setOpacity(config.opacity);
    // 收起状态下窗口有大量透明区域，鼠标穿透交给渲染进程按卡片形状判定
    pushState();
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
    const img = await win.webContents.capturePage();
    fs.writeFileSync(process.env.CCUF_SHOT, img.toPNG());
    console.log('shot ->', process.env.CCUF_SHOT);
  } catch (e) {
    console.error('截图失败', e.message);
  }
  app.quit();
}

function applyShape(expanded, animate = true) {
  if (!win) return;
  isExpanded = expanded;
  config.expanded = expanded;
  saveConfig();

  const [w, h] = win.getSize();
  const target = expanded ? EXPANDED : COLLAPSED;
  // 展开时往左/往上撑开，避免卡片跑出屏幕
  const [x, y] = win.getPosition();
  const nx = Math.max(screen.getPrimaryDisplay().workArea.x, x - (target.width - w));
  const ny = Math.max(screen.getPrimaryDisplay().workArea.y, y);
  win.setPosition(nx, ny);

  if (!animate) {
    win.setSize(target.width, target.height);
    pushState();
    return;
  }
  animateBounds(win, { x: nx, y: ny, width: target.width, height: target.height }, 190);
  pushState();
}

function animateBounds(w, target, duration) {
  const start = w.getBounds();
  const t0 = Date.now();
  if (w.__animTimer) clearInterval(w.__animTimer);
  w.__animTimer = setInterval(() => {
    if (!w || w.isDestroyed()) {
      clearInterval(w.__animTimer);
      return;
    }
    const p = Math.min(1, (Date.now() - t0) / duration);
    const e = 1 - Math.pow(1 - p, 3);
    const lerp = (a, b) => Math.round(a + (b - a) * e);
    w.setBounds({
      x: lerp(start.x, target.x),
      y: lerp(start.y, target.y),
      width: lerp(start.width, target.width),
      height: lerp(start.height, target.height),
    });
    if (p >= 1) {
      clearInterval(w.__animTimer);
      w.__animTimer = null;
    }
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
  if (win && moved) {
    const [x, y] = win.getPosition();
    config.x = x;
    config.y = y;
    saveConfig();
  }
  if (!moved) applyShape(!isExpanded);
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
