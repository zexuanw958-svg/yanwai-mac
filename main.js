'use strict';
const { app, BrowserWindow, ipcMain, screen, clipboard, globalShortcut, session, Tray, Menu, nativeImage, shell, safeStorage, systemPreferences, desktopCapturer } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { execFileSync, spawn } = require('node:child_process');
const { InputSources, readLines } = require('./input-sources');
const { fillReply } = require('./fill-policy');
const { boundsFor, RequestGate, validateText, examples, demoResult } = require('./panel-policy');
const jevCloud = require('./jev-cloud');
const { CloudSettings, electronCrypto } = require('./cloud-settings');

const smoke = process.argv.includes('--smoke');
const smokeDir = process.env.YANWAI_SMOKE_DIR || path.join(__dirname, 'smoke-output');
const renderer = path.join(__dirname, 'renderer', 'index.html');
const rendererURL = pathToFileURL(renderer).href;
const gate = new RequestGate();
let window, tray, request, targetObserver, externalTarget = null, currentResult = null, filling = false, fillProcess = null;
let resultSequence = 0, cloudSettings = null, cloudAbort = null, draftAbort = null;
const BACKENDS = ['demo', 'local', 'jev'];
const state = { mode: smoke ? 'expanded' : 'collapsed', placement: 'right', following: false, source: 'manual', sourceStatus: { state: 'idle', detail: '手动放入对话，不会自动读取。' }, backend: 'demo', localEndpoint: 'http://127.0.0.1:7147', shortcut: 'CommandOrControl+Shift+J' };
let nativeDisplays = new Map();

app.setName('言外 Mac');
// An unexpected main-process error must never leave a blocking system dialog on screen:
// log it, stop following sources, and tell the panel instead.
process.on('uncaughtException', error => {
  console.error('[yanwai] uncaught', error);
  try { sources?.stop(); state.source = 'manual'; state.following = false; state.sourceStatus = { state: 'idle', detail: '刚才出了点意外，已停止自动读取。请重新选择对话来源。' }; emitState(); } catch (_) { /* best effort */ }
});
process.on('unhandledRejection', error => console.error('[yanwai] unhandled rejection', error));
if (smoke) app.setPath('userData', path.join(smokeDir, 'temporary-profile'));
if (!app.requestSingleInstanceLock()) app.quit();

const PERMISSION_URLS = { screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture', accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility' };
// macOS attributes the helpers' permissions to this app. Screen recording only
// takes effect after a relaunch, so "granted" here may still need a restart.
function permissionStatus() {
  const host = app.isPackaged ? '言外' : 'Electron';
  if (smoke) return { screen: 'denied', accessibility: false, host };
  return { screen: systemPreferences.getMediaAccessStatus('screen'), accessibility: systemPreferences.isTrustedAccessibilityClient(false), host };
}
let steppedAside = false;
function stepAside() {
  if (!window || window.isDestroyed()) return;
  steppedAside = true;
  state.placement = 'right'; position();
  window.setAlwaysOnTop(false);
  emitState();
}
function restoreOnTop() {
  if (!steppedAside || !window || window.isDestroyed()) return;
  steppedAside = false;
  window.setAlwaysOnTop(true, 'screen-saver');
}
function publicState() { return { ...state, examples }; }
function emitState() { window?.webContents.send('state:changed', publicState()); refreshMenu(); return publicState(); }
function refreshNativeDisplays() {
  try {
    const entries = JSON.parse(execFileSync(path.join(__dirname, 'native', 'notch-metrics'), { encoding: 'utf8', timeout: 2000 }));
    nativeDisplays = new Map(entries.map(item => [item.id, item.notch]));
  } catch (_) { nativeDisplays = new Map(); }
}
function withNotch(display) { return { ...display, notch: nativeDisplays.get(display.id) }; }
function currentDisplay() { return withNotch(window ? screen.getDisplayMatching(window.getBounds()) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())); }
// Where the user dragged the expanded panel, per display, persisted across launches.
let prefs = { placement: 'right', origins: {} }, prefsFile = null, positioning = false;
function loadPrefs() {
  prefsFile = path.join(app.getPath('userData'), 'ui-prefs.json');
  try {
    const value = JSON.parse(fs.readFileSync(prefsFile, 'utf8'));
    if (['top', 'right'].includes(value.placement)) prefs.placement = value.placement;
    if (value.origins && typeof value.origins === 'object') prefs.origins = value.origins;
  } catch (_) { /* first launch */ }
  state.placement = prefs.placement;
}
function savePrefs() {
  if (!prefsFile || smoke) return;
  try { fs.writeFileSync(prefsFile, JSON.stringify(prefs)); } catch (_) { /* best effort */ }
}
function position() {
  if (!window || window.isDestroyed()) return;
  window.setHasShadow(state.mode === 'expanded');
  const display = currentDisplay();
  const bounds = boundsFor(display, state.mode, state.placement);
  const origin = state.mode === 'expanded' && prefs.origins[`${display.id}:${state.placement}`];
  if (origin && Number.isFinite(origin.x) && Number.isFinite(origin.y)) {
    const area = display.workArea;
    bounds.x = Math.round(Math.min(Math.max(origin.x, area.x), area.x + area.width - bounds.width));
    bounds.y = Math.round(Math.min(Math.max(origin.y, area.y), area.y + area.height - bounds.height));
  }
  positioning = true;
  window.setBounds(bounds, false);
  setTimeout(() => { positioning = false; }, 50);
}
function rememberDrag() {
  if (positioning || state.mode !== 'expanded' || !window || window.isDestroyed()) return;
  const { x, y } = window.getBounds();
  prefs.origins[`${currentDisplay().id}:${state.placement}`] = { x, y };
  savePrefs();
}
function invalidate() { fillProcess?.kill('SIGTERM'); currentResult = null; gate.invalidate(); if (request) request.destroy(); request = null; cloudAbort?.abort(); cloudAbort = null; draftAbort?.abort(); draftAbort = null; }
function setMode(mode) {
  if (!['expanded', 'collapsed'].includes(mode)) throw new Error('Invalid panel mode');
  restoreOnTop();
  state.mode = mode; position();
  if (mode === 'expanded') { window.showInactive(); }
  return emitState();
}

const nativePath = name => path.join(__dirname, 'native', name);
const sources = new InputSources({
  spawnWatch: () => spawn(nativePath('watch-chat'), [], { stdio: ['pipe', 'pipe', 'ignore'] }),
  spawnPasteboard: smoke ? null : () => spawn(nativePath('watch-chat'), ['--pasteboard'], { stdio: ['pipe', 'pipe', 'ignore'] }),
  readClipboard: async () => smoke ? '' : String((await clipboard.readText()) ?? ''),
  onInvalidate: invalidate,
  onText: value => window?.webContents.send('input:text', value),
  onStatus: value => { state.sourceStatus = value; emitState(); },
});
function setSource(source) {
  if (!['manual', 'clipboard', 'wechat'].includes(source)) throw new Error('Invalid source');
  if (smoke && source !== 'manual') throw new Error('测试模式不读取真实内容。');
  state.source = source; state.following = source === 'clipboard';
  sources.setSource(source);
  // Manual entry remains keyboard-accessible; followed inputs do not activate Yanwai.
  window.setFocusable(source === 'manual');
  return emitState();
}
function copyText(text) {
  if (!smoke) { sources.copied(text); clipboard.writeText(text); }
}
function observeTarget() {
  targetObserver = spawn(nativePath('fill-text'), ['--track-frontmost'], { stdio: ['pipe', 'pipe', 'ignore'] });
  readLines(targetObserver.stdout, value => {
    if (Number.isInteger(value.pid) && value.pid !== process.pid && value.bundleID &&
        !['com.github.Electron.helper', 'com.zexuan.yanwai.mac'].includes(value.bundleID)) externalTarget = value;
  });
  targetObserver.on('error', () => { externalTarget = null; });
  targetObserver.on('exit', () => { externalTarget = null; });
}
function nativeFill(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(nativePath('fill-text'), ['--write'], { stdio: ['pipe', 'pipe', 'ignore'] });
    fillProcess = child;
    let answer;
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('填入超时。')); }, 7000);
    readLines(child.stdout, value => { answer = value; });
    child.on('error', error => { if (fillProcess === child) fillProcess = null; clearTimeout(timer); reject(error); });
    child.on('exit', () => { if (fillProcess === child) fillProcess = null; clearTimeout(timer); answer ? resolve(answer) : reject(new Error('填入工具未返回结果。')); });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}
function rememberResult(value, binding, target) {
  const token = String(++resultSequence);
  if (binding.source === 'wechat' && target?.pid !== binding.wechat?.pid) target = null;
  currentResult = { token, binding, target, replies: [...value.replies] };
  return { ...value, fillToken: token };
}

function localJSON(route, data, track = false) {
  return new Promise((resolve, reject) => {
    const body = data === undefined ? null : JSON.stringify(data);
    const req = http.request({ hostname: '127.0.0.1', port: 7147, path: route, method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}, timeout: 30000 }, response => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { raw += chunk; if (raw.length > 65536) req.destroy(new Error('本地服务返回内容过大。')); });
      response.on('end', () => {
        if (track && request === req) request = null;
        try {
          const value = JSON.parse(raw);
          if (response.statusCode !== 200) throw new Error(value.error || '本地模型请求失败。');
          resolve(value);
        } catch (error) { reject(error); }
      });
    });
    if (track) request = req;
    req.on('timeout', () => req.destroy(new Error('本地模型响应超时。')));
    req.on('error', error => reject(new Error(error.code === 'ECONNREFUSED' ? '本地模型尚未连接。先启动 Laya 本机服务，再检查连接。' : error.message)));
    if (body) req.write(body);
    req.end();
  });
}

function installBridge() {
  const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== rendererURL) throw new Error('Untrusted caller');
    return fn(...args);
  });
  handle('state:get', publicState);
  handle('panel:mode', setMode);
  handle('panel:placement', value => {
    if (!['top', 'right'].includes(value)) throw new Error('Invalid placement');
    // Choosing a preset puts the panel back at its default spot.
    delete prefs.origins[`${currentDisplay().id}:${value}`];
    prefs.placement = value; savePrefs();
    state.placement = value; position(); return emitState();
  });
  handle('input:source', setSource);
  handle('clipboard:follow', enabled => setSource(enabled ? 'clipboard' : 'manual'));
  // Guided permissions: report status, register the app in the list, then open the right pane.
  handle('permissions:status', () => {
    const status = permissionStatus();
    if (status.screen === 'granted' && status.accessibility) restoreOnTop();
    return status;
  });
  handle('permissions:request', async kind => {
    if (!['screen', 'accessibility'].includes(kind)) throw new Error('Invalid permission');
    if (smoke) return permissionStatus();
    // Step aside so System Settings is not hidden under the always-on-top panel.
    stepAside();
    if (kind === 'accessibility') systemPreferences.isTrustedAccessibilityClient(true);
    else {
      // Asking for sources makes macOS list this app under Screen Recording.
      try { await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }); } catch (_) { /* listed anyway */ }
    }
    await shell.openExternal(PERMISSION_URLS[kind]);
    return permissionStatus();
  });
  // Pass the app path explicitly: a bare relaunch of the dev runtime opens Electron's welcome page.
  handle('app:relaunch', () => { if (!smoke) { app.relaunch(app.isPackaged ? {} : { args: [app.getAppPath()] }); app.exit(0); } });
  handle('permissions:open', kind => {
    if (!PERMISSION_URLS[kind]) throw new Error('Invalid permission');
    if (!smoke) return shell.openExternal(PERMISSION_URLS[kind]);
  });
  handle('reply:fill', async payload => {
    const result = currentResult;
    if (filling || !result || result.token !== payload?.token || !Number.isInteger(payload.index) || !result.replies[payload.index])
      return { filled: false, message: '建议已变化或正在填入，请稍后重试。' };
    const text = validateText(result.replies[payload.index]);
    if (text.length > 1200) return { filled: false, message: '回复太长，请复制后自行编辑。' };
    filling = true;
    try {
      return await fillReply({ text, binding: result.binding,
        accepts: binding => result === currentResult && sources.accepts(binding) &&
          (!result.target || result.target.pid === externalTarget?.pid),
        write: () => smoke ? Promise.resolve({ filled: false, reason: 'smoke' }) :
          nativeFill({ text, target: result.target, ownerPID: process.pid, wechat: result.binding.wechat }),
        copy: copyText });
    } finally { filling = false; }
  });
  handle('clipboard:read', async () => ({ text: smoke ? '' : String((await clipboard.readText()) ?? '').slice(0, 8000) }));
  handle('clipboard:copy', value => {
    const text = validateText(value);
    if (text.length > 1200) throw new Error('回复太长。');
    copyText(text);
    return { copied: true };
  });
  handle('model:set', value => {
    if (!BACKENDS.includes(value)) throw new Error('Invalid backend');
    invalidate(); state.backend = value; return emitState();
  });
  handle('model:health', async () => {
    try { return await localJSON('/health'); }
    catch (error) { return { ready: false, message: error.message }; }
  });
  handle('cloud:get', () => cloudSettings.publicView());
  handle('cloud:save', value => cloudSettings.update(value));
  handle('cloud:test', async () => {
    if (smoke) return { ok: false, message: '测试模式不连接云端。' };
    try {
      const result = await jevCloud.testConnection({ config: cloudSettings.config() });
      return { ok: true, message: result.reply ? 'Jev 和回复模型都连通了。' : 'Jev 连通了。候选回复将使用固定模板。' };
    } catch (error) { return { ok: false, message: error.message }; }
  });
  handle('draft:check', async payload => {
    if (state.backend !== 'jev') throw new Error('「发之前看一眼」需要先切到 Jev 云端。');
    if (smoke) throw new Error('测试模式不连接云端。');
    const text = validateText(payload?.text);
    if (typeof payload?.draft !== 'string') throw new Error('先写下你打算发的那句话。');
    draftAbort?.abort();
    const controller = new AbortController(); draftAbort = controller;
    try {
      return await jevCloud.checkDraft({ text, draft: payload.draft, scenario: payload.scenario, config: cloudSettings.config(), signal: controller.signal });
    } finally { if (draftAbort === controller) draftAbort = null; }
  });
  handle('model:analyze', async payload => {
    if (!payload || !BACKENDS.includes(payload.backend) || payload.backend !== state.backend) throw new Error('分析模式已变化，请重试。');
    const text = validateText(payload.text);
    invalidate(); const version = gate.version;
    const binding = sources.binding(), target = externalTarget ? { ...externalTarget } : null;
    if (state.source === 'wechat' && payload.revision !== binding.revision) throw new Error('微信对话已变化，请等待最新内容。');
    if (payload.backend === 'demo') {
      const example = examples[payload.scenario];
      if (!example || text.replace(/\s/g, '') !== example.text.replace(/\s/g, '')) throw new Error('示例仅演示预设对话。分析自己的内容请连接本地模型。');
      return rememberResult(demoResult(payload.scenario), binding, target);
    }
    if (payload.backend === 'jev') {
      if (smoke) throw new Error('测试模式不连接云端。');
      const controller = new AbortController(); cloudAbort = controller;
      try {
        const value = await jevCloud.analyze({ text, scenario: payload.scenario, config: cloudSettings.config(), signal: controller.signal });
        if (!gate.accepts(version)) throw new Error('这次结果已过期，请查看最新对话。');
        return rememberResult(value, binding, target);
      } finally { if (cloudAbort === controller) cloudAbort = null; }
    }
    const value = await localJSON('/analyze', { text }, true);
    if (!gate.accepts(version)) throw new Error('这次结果已过期，请查看最新对话。');
    if (value.kind !== 'local' || typeof value.intent !== 'string' || !Array.isArray(value.replies)) throw new Error('本地服务返回格式不匹配。');
    return rememberResult(value, binding, target);
  });
  handle('app:quit', () => app.quit());
}

function refreshMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开言外', click: () => setMode('expanded') },
    { label: '权限设置…', click: () => { setMode('expanded'); window?.webContents.send('guide:show'); } },
    { label: '收起浮窗', click: () => setMode('collapsed') },
    { type: 'separator' },
    { label: state.source === 'manual' ? '自动跟随已关闭' : '停止自动跟随', enabled: state.source !== 'manual', click: () => setSource('manual') },
    { label: '退出言外', click: () => app.quit() },
  ]));
}

async function runSmoke() {
  const checks = [];
  const evalUI = code => window.webContents.executeJavaScript(code);
  try {
    fs.mkdirSync(smokeDir, { recursive: true });
    await new Promise(r => setTimeout(r, 450));
    const text = await evalUI('document.body.innerText');
    if (!text.includes('言外')) throw new Error('Brand is missing'); checks.push('renderer loaded');
    const initialResult = await evalUI("({hidden:document.getElementById('analysisResult').hidden, intent:document.getElementById('intentText').textContent, error:document.getElementById('feedback').textContent})");
    if (initialResult.hidden || initialResult.intent !== examples.work.intent || initialResult.error) throw new Error('Initial example failed: '+JSON.stringify(initialResult));
    checks.push('initial example and backend fixtures agree');
    const demo = await evalUI(`window.yanwai.analyze(${JSON.stringify({ backend: 'demo', scenario: 'work', text: examples.work.text })})`);
    if (demo.kind !== 'demo' || demo.replies.length !== 3) throw new Error('demo contract failed'); checks.push('demo is explicit');
    let rejected = false;
    try { await evalUI(`window.yanwai.analyze({backend:'demo',scenario:'work',text:'任意聊天不可套示例'})`); } catch (_) { rejected = true; }
    if (!rejected) throw new Error('arbitrary text accepted as demo'); checks.push('no fake arbitrary-text inference');
    fs.writeFileSync(path.join(smokeDir, 'mac-expanded.png'), (await window.webContents.capturePage()).toPNG());
    await evalUI("document.getElementById('collapseButton').click()"); await new Promise(r => setTimeout(r, 220));
    if (window.getBounds().width > 280) throw new Error('collapse failed'); checks.push('collapse geometry');
    const display = currentDisplay(), collapsedBounds = window.getBounds();
    fs.writeFileSync(path.join(smokeDir, 'actual-bounds.json'), JSON.stringify({display, collapsedBounds}, null, 2));
    if (collapsedBounds.y !== display.bounds.y) throw new Error('Collapsed notch is not flush with screen top');
    if (display.notch && (collapsedBounds.height !== Math.round(display.notch.height) || collapsedBounds.width !== Math.round(display.notch.width))) throw new Error('Notch bounds do not match hardware');
    checks.push('collapsed bounds match native screen cutout');
    fs.writeFileSync(path.join(smokeDir, 'notch-geometry.json'), JSON.stringify({ display: { id: display.id, bounds: display.bounds, workArea: display.workArea, notch: display.notch }, collapsed: collapsedBounds }, null, 2));
    fs.writeFileSync(path.join(smokeDir, 'mac-collapsed.png'), (await window.webContents.capturePage()).toPNG());
    state.placement = 'right'; await evalUI("document.getElementById('expandButton').click()"); await new Promise(r => setTimeout(r, 250));
    const retained = await evalUI("!document.getElementById('analysisResult').hidden");
    if (!retained) throw new Error('Completed analysis lost on collapse/expand');
    checks.push('completed result survives panel positioning');
    fs.writeFileSync(path.join(smokeDir, 'mac-right.png'), (await window.webContents.capturePage()).toPNG());
    checks.push('right-side layout');
    await evalUI("document.querySelector('.workspace').scrollTop = document.querySelector('.input-pane').offsetHeight");
    await new Promise(r => setTimeout(r, 120));
    fs.writeFileSync(path.join(smokeDir, 'mac-right-result.png'), (await window.webContents.capturePage()).toPNG());
    await evalUI("document.getElementById('exampleRomance').click()");
    await new Promise(r => setTimeout(r, 150));
    const romance = await evalUI(`({ percentages: [...document.querySelectorAll('.probability-row strong')].map(e => e.textContent),
      replies: [...document.querySelectorAll('.reply-text')].map(e => e.textContent),
      recommended: document.querySelector('.is-recommended .reply-number')?.textContent })`);
    if (JSON.stringify(romance.percentages) !== JSON.stringify(['72%','20%','8%']) ||
        JSON.stringify(romance.replies) !== JSON.stringify(examples.romance.replies) || romance.recommended !== '01 / 最推荐')
      throw new Error('Romance distribution/replies mismatch');
    checks.push('romance complete distribution, three replies and recommendation');
    const additions = await evalUI(`({
      fills: [...document.querySelectorAll('.fill-button')].map(b => ({disabled:b.disabled, primary:b.classList.contains('is-primary')})),
      bars: [...document.querySelectorAll('.probability-bar')].map(b => b.style.width),
      sources: [...document.querySelectorAll('.source-control button')].map(b => b.id)
    })`);
    if (JSON.stringify(additions.bars) !== JSON.stringify(['72%','20%','8%']) || additions.fills.length !== 3 ||
        additions.fills.some(b => b.disabled) || !additions.fills[0].primary || additions.fills.slice(1).some(b => b.primary) ||
        JSON.stringify(additions.sources) !== JSON.stringify(['sourceManual','sourceClipboard','sourceWechat'])) throw new Error('Fill/bar/source controls failed');
    checks.push('three exclusive source choices, probability bars and recommended fill button');
    await evalUI("document.querySelector('.fill-button').click()");
    await new Promise(r => setTimeout(r, 120));
    const fallback = await evalUI("document.getElementById('feedback').textContent");
    if (!fallback.includes('已复制，请手动粘贴')) throw new Error('Safe smoke fill fallback failed: '+fallback);
    checks.push('fill fallback feedback without native write or real clipboard');
    await evalUI("document.querySelector('.reply-card').scrollIntoView({block:'start'})");
    await new Promise(r => setTimeout(r, 120));
    fs.writeFileSync(path.join(smokeDir, 'mac-fill-button.png'), (await window.webContents.capturePage()).toPNG());

    await evalUI("document.getElementById('intentHeading').scrollIntoView({block:'start'})");
    await new Promise(r => setTimeout(r, 120));
    fs.writeFileSync(path.join(smokeDir, 'mac-romance.png'), (await window.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(smokeDir, 'mac-probability-bars.png'), (await window.webContents.capturePage()).toPNG());
    // Small viewport plus 140% browser text/UI zoom; all checks use the real renderer.
    window.setBounds({ ...window.getBounds(), width: 360, height: 560 });
    window.webContents.setZoomFactor(1.4);
    await new Promise(r => setTimeout(r, 150));
    const layout = await evalUI(`(() => {
      const w = document.querySelector('.workspace');
      const overflow = document.documentElement.scrollWidth > innerWidth || w.scrollWidth > w.clientWidth;
      document.querySelector('.reply-card:last-child').scrollIntoView({block:'end'});
      const last = document.querySelector('.reply-card:last-child').getBoundingClientRect();
      const view = w.getBoundingClientRect();
      return { overflow, scrollable: w.scrollHeight > w.clientHeight, scrolled: w.scrollTop > 0,
        lastVisible: last.bottom <= view.bottom + 1 && last.top >= view.top - 1 };
    })()`);
    if (layout.overflow || !layout.scrollable || !layout.scrolled || !layout.lastVisible) throw new Error('Small zoomed layout failed: '+JSON.stringify(layout));
    checks.push('360x560 at 140% zoom scrolls to third reply without horizontal overflow');
    await new Promise(r => setTimeout(r, 120));
    fs.writeFileSync(path.join(smokeDir, 'mac-small-font140-third-reply.png'), (await window.webContents.capturePage()).toPNG());
    await evalUI("document.getElementById('chatInput').value='自己输入的新会话';document.getElementById('chatInput').dispatchEvent(new Event('input'))");
    const cleared = await evalUI("document.getElementById('analysisResult').hidden && !document.getElementById('intentDistribution').children.length && !document.getElementById('replyList').children.length && document.getElementById('analyzeButton').disabled");
    if (!cleared) throw new Error('Editing retained fixture result');
    checks.push('new input clears fixture probabilities and replies');
    if (state.source !== 'manual' || state.following || sources.process || targetObserver) throw new Error('native observation unexpectedly active'); checks.push('clipboard, OCR and target observation off in smoke');
    window.webContents.setZoomFactor(1); window.setBounds({ ...window.getBounds(), width: 430, height: 740 });
    await evalUI("document.getElementById('backendJev').click()"); await new Promise(r => setTimeout(r, 250));
    const jevUI = await evalUI(`({ backend: document.body.dataset.backend, settings: !document.getElementById('cloudSettings').hidden,
      draft: !document.getElementById('draftCheck').hidden, providers: [...document.querySelectorAll('#judgeProvider option')].map(o => o.value) })`);
    if (jevUI.backend !== 'jev' || !jevUI.settings || !jevUI.draft || JSON.stringify(jevUI.providers) !== JSON.stringify(['bocha','openrouter','typesafe','custom']))
      throw new Error('Jev cloud controls failed: ' + JSON.stringify(jevUI));
    await evalUI("document.getElementById('cloudSettings').open = true; document.querySelector('.workspace').scrollTop = 0"); await new Promise(r => setTimeout(r, 150));
    fs.writeFileSync(path.join(smokeDir, 'mac-jev-settings.png'), (await window.webContents.capturePage()).toPNG());
    await evalUI("document.getElementById('draftCheck').scrollIntoView({block:'start'})"); await new Promise(r => setTimeout(r, 150));
    fs.writeFileSync(path.join(smokeDir, 'mac-jev-draft.png'), (await window.webContents.capturePage()).toPNG());
    checks.push('Jev cloud settings and draft check render without contacting any service');
    fs.writeFileSync(path.join(smokeDir, 'smoke.json'), JSON.stringify({ ok: true, checks, state: publicState() }, null, 2));
    app.exit(0);
  } catch (error) {
    fs.writeFileSync(path.join(smokeDir, 'smoke.json'), JSON.stringify({ ok: false, checks, error: error.stack }, null, 2));
    app.exit(1);
  }
}

app.whenReady().then(() => {
  app.dock?.hide();
  refreshNativeDisplays();
  cloudSettings = new CloudSettings({ file: path.join(app.getPath('userData'), 'cloud-settings.json'), crypto: electronCrypto(safeStorage) });
  if (process.argv.includes('--import-keys-from-env')) {
    const env = process.env;
    try {
      cloudSettings.update({ judgeProvider: env.YANWAI_JEV_PROVIDER, judgeKey: env.YANWAI_JEV_KEY,
        replyProvider: env.YANWAI_REPLY_PROVIDER, replyKey: env.YANWAI_REPLY_KEY });
      const view = cloudSettings.publicView();
      console.log(JSON.stringify({ imported: true, judgeProvider: view.judgeProvider, replyProvider: view.replyProvider, hasJudgeKey: view.hasJudgeKey, hasReplyKey: view.hasReplyKey }));
      app.exit(0);
    } catch (error) { console.log(JSON.stringify({ imported: false, error: error.message })); app.exit(1); }
    return;
  }
  if (!smoke) {
    // Open ready to use: a launch always shows the panel (⌘⇧J tucks it into the notch);
    // a saved Jev key starts in Jev mode.
    loadPrefs();
    if (cloudSettings.publicView().hasJudgeKey) state.backend = 'jev';
    state.mode = 'expanded';
  }
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  const initial = boundsFor(withNotch(screen.getDisplayNearestPoint(screen.getCursorScreenPoint())), state.mode, state.placement);
  // Transparent frame and workspace behaviour adapted from TO-DO Panel; this
  // smaller companion deliberately avoids its unrelated system/media features.
  window = new BrowserWindow({ ...initial, type: 'panel', frame: false, transparent: true, backgroundColor: '#00000000', resizable: false,
    alwaysOnTop: true, skipTaskbar: true, roundedCorners: false, hasShadow: state.mode === 'expanded', acceptFirstMouse: true, fullscreenable: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  // Match TO-DO Panel's menu-bar hit testing level; 'floating' leaves the
  // screen-top collapsed window behind the macOS menu bar.
  window.setAlwaysOnTop(true, 'screen-saver');
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.on('moved', rememberDrag);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('before-input-event', (_event, input) => { if (input.type === 'keyDown' && input.key === 'Escape') setMode('collapsed'); });
  const displaysChanged = () => { refreshNativeDisplays(); position(); };
  screen.on('display-metrics-changed', displaysChanged); screen.on('display-removed', displaysChanged); screen.on('display-added', displaysChanged);
  installBridge();
  window.once('ready-to-show', () => { window.showInactive(); emitState(); if (smoke) runSmoke(); });
  window.loadFile(renderer);
  if (!smoke) {
    observeTarget();
    const pixels = Buffer.alloc(22 * 22 * 4);
    for (let y = 3; y < 18; y++) for (let x = 3; x < 19; x++) {
      const cutCorner = (x < 5 || x > 16) && (y < 5 || y > 15);
      const line = (y === 8 && x >= 7 && x <= 15) || (y === 12 && x >= 7 && x <= 12);
      if (!cutCorner && !line) pixels[(y * 22 + x) * 4 + 3] = 255;
    }
    for (let y = 17; y < 21; y++) for (let x = 5; x < 10 - (y - 17); x++) pixels[(y * 22 + x) * 4 + 3] = 255;
    const icon = nativeImage.createFromBitmap(pixels, { width: 22, height: 22 });
    icon.setTemplateImage(true); tray = new Tray(icon); tray.setToolTip('言外 · 聊天参谋'); refreshMenu();
    tray.on('click', () => setMode(state.mode === 'expanded' ? 'collapsed' : 'expanded'));
    if (!globalShortcut.register(state.shortcut, () => setMode(state.mode === 'expanded' ? 'collapsed' : 'expanded'))) state.shortcut = '菜单栏打开';
  }
});
app.on('second-instance', () => { if (window) setMode('expanded'); });
// Opening 言外 again from Launchpad or Spotlight brings the panel out.
app.on('activate', () => { if (window) setMode('expanded'); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { sources.stop(); targetObserver?.stdin.end(); targetObserver?.kill('SIGTERM'); invalidate(); globalShortcut.unregisterAll(); });
