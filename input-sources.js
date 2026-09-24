'use strict';
// Source lifetime and native JSONL parsing are independent of Electron for offline tests.
const { createHash } = require('node:crypto');
function readLines(stream, onValue, onInvalid = () => {}) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    pending += chunk;
    if (pending.length > 256 * 1024) { pending = ''; onInvalid(); return; }
    let end;
    while ((end = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      try { onValue(JSON.parse(line)); } catch { onInvalid(); }
    }
  });
}
const fingerprint = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
class InputSources {
  constructor({ spawnWatch, spawnPasteboard = null, readClipboard, onText, onStatus, onInvalidate, schedule = setInterval, cancel = clearInterval, now = Date.now }) {
    Object.assign(this, { spawnWatch, spawnPasteboard, readClipboard, onText, onStatus, onInvalidate, schedule, cancel, now });
    this.source = 'manual'; this.generation = 0; this.revision = 0;
    this.process = null; this.timer = null; this.lastClipboard = ''; this.frame = null; this.rows = [];
  }
  invalidate() { this.revision++; this.onInvalidate(); }
  setSource(source) {
    if (!['manual', 'clipboard', 'wechat'].includes(source)) throw new Error('Invalid input source');
    if (source === this.source) return;
    this.stop(); this.source = source;
    const generation = this.generation;
    if (source === 'clipboard') {
      // Electron 44's clipboard.readText() is async; accept either a string or a Promise.
      const read = async () => { try { const value = await this.readClipboard(); return typeof value === 'string' ? value : ''; } catch { return ''; } };
      let baseline = null, reading = false;
      read().then(value => { if (generation === this.generation) { this.lastClipboard = value; baseline = true; } });
      this.timer = this.schedule(async () => {
        if (this.source !== 'clipboard' || generation !== this.generation || !baseline || reading) return;
        reading = true;
        try {
          const text = await read();
          if (this.source !== 'clipboard' || generation !== this.generation || text === this.lastClipboard) return;
          this.lastClipboard = text;
          // A screenshot replaces the text with nothing; the image side reports it instead.
          if (!text.trim()) return;
          this.invalidate();
          this.onText({ text: text.slice(0, 8000), source: 'clipboard', revision: this.revision, autoAnalyze: true });
        } finally { reading = false; }
      }, 650);
      this.watchScreenshots(generation);
      this.onStatus({ state: 'idle', detail: this.process
        ? '已开启。在微信里复制对方的话，或用微信截图（⌃⌘A）框住聊天，言外会自动读出来。'
        : '跟随复制已开启。复制的新文字会出现在这里。' });
    } else if (source === 'wechat') {
      this.onStatus({ state: 'idle', detail: '正在查找微信聊天窗口…' });
      try {
        const child = this.spawnWatch(); this.process = child;
        readLines(child.stdout, value => { if (generation === this.generation) this.consume(value); }, () => {
          if (generation === this.generation) this.unavailable({ state: 'idle', detail: '读取微信的内容不完整，正在重试。' });
        });
        const failed = () => {
          if (generation !== this.generation) return;
          this.process = null;
          this.unavailable({ state: 'idle', detail: '跟随微信已停止，请切回手动后重新开启。' });
        };
        child.on('error', failed); child.on('exit', failed);
      } catch { this.unavailable({ state: 'idle', detail: '跟随微信未能启动，请重新构建原生工具后再试。' }); }
    } else this.onStatus({ state: 'idle', detail: '手动放入对话，不会自动读取。' });
  }
  // WeChat's own screenshot tool is not blocked by its screen-capture protection; its image
  // lands on the pasteboard and a native helper OCRs it locally.
  watchScreenshots(generation) {
    if (!this.spawnPasteboard) return;
    try {
      const child = this.spawnPasteboard(); this.process = child;
      readLines(child.stdout, value => { if (generation === this.generation) this.consumeScreenshot(value); });
      const failed = () => { if (generation === this.generation && this.process === child) this.process = null; };
      child.on('error', failed); child.on('exit', failed);
    } catch { this.process = null; }
  }
  consumeScreenshot(value) {
    if (value?.kind === 'status' && ['reading', 'idle'].includes(value.state) && typeof value.detail === 'string') {
      return this.onStatus({ state: value.state, detail: value.detail.slice(0, 250) });
    }
    if (value?.kind !== 'screenshot' || !Array.isArray(value.messages)) return;
    const rows = value.messages.filter(row => ['them', 'me'].includes(row?.from) && typeof row.text === 'string' && row.text.trim())
      .map(row => ({ from: row.from, text: row.text.slice(0, 2000) })).slice(-5);
    if (!rows.length) return;
    this.invalidate();
    this.onStatus({ state: 'idle', detail: `已读出截图里的 ${rows.length} 条消息。截图只在本机识别，不保存。` });
    this.onText({ source: 'clipboard', via: 'screenshot', revision: this.revision, autoAnalyze: true,
      text: rows.map(row => `${row.from === 'them' ? '对方' : '我'}：${row.text}`).join('\n').slice(-8000) });
  }
  stop() {
    this.generation++;
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    if (this.process) { this.process.stdin?.end(); this.process.kill('SIGTERM'); }
    this.process = null; this.frame = null; this.rows = []; this.source = 'manual';
    this.invalidate();
  }
  copied(text) { this.lastClipboard = text; }
  unavailable(status) {
    if (this.frame) {
      this.frame = null; this.invalidate();
      this.onText({ source: 'wechat', text: '', revision: this.revision, autoAnalyze: false });
    }
    this.rows = []; this.onStatus(status);
  }
  consume(value) {
    if (value?.kind === 'message') {
      if (['them', 'me', 'unknown'].includes(value.from) && typeof value.text === 'string' && value.text.length <= 8000) {
        this.rows.push(value); if (this.rows.length > 20) this.rows.shift();
      }
      return;
    }
    if (value?.kind !== 'status' || !['no-window', 'no-permission', 'idle', 'watching', 'blocked'].includes(value.state)) return;
    const status = { state: value.state, detail: typeof value.detail === 'string' ? value.detail.slice(0, 250) : '等待微信窗口。' };
    if (value.state !== 'watching') return this.unavailable(status);
    if (typeof value.session !== 'string' || typeof value.signature !== 'string' || !value.title ||
        !Number.isInteger(value.pid) || !Number.isInteger(value.windowID)) return;
    if (this.frame?.signature === value.signature && this.frame.session === value.session) {
      this.frame.seenAt = this.now(); this.rows = []; this.onStatus(status); return;
    }
    const rows = this.rows; this.rows = [];
    if (rows.length !== value.count || rows.some(row => row.signature !== value.signature || row.session !== value.session)) {
      return this.unavailable({ state: 'idle', detail: '正在重新确认微信对话…' });
    }
    const all = rows.map(({ from, text }) => ({ from, text }));
    const previous = this.frame;
    const key = fingerprint(all);
    // Text is the identity; OCR box jitter does not create a new message.
    if (previous?.session === value.session && previous.key === key) { previous.seenAt = this.now(); return; }
    this.frame = { session: value.session, signature: value.signature, title: value.title,
      pid: value.pid, windowID: value.windowID, seenAt: this.now(), key, messages: all };
    this.invalidate(); this.onStatus(status);
    const context = all.filter(row => row.from !== 'unknown').slice(-5);
    const latest = all.at(-1);
    let newIncoming = latest?.from === 'them';
    if (previous?.session === value.session) {
      // A backwards scroll or disappearing bubble is not an incoming message.
      const old = previous.messages;
      let overlap = 0;
      for (let count = Math.min(old.length, all.length); count > 0; count--) {
        if (JSON.stringify(old.slice(-count)) === JSON.stringify(all.slice(0, count))) { overlap = count; break; }
      }
      newIncoming = newIncoming && overlap > 0 && all.length > overlap;
    }
    this.onText({ source: 'wechat', text: context.map(row => `${row.from === 'them' ? '对方' : '我'}：${row.text}`).join('\n').slice(-8000),
      title: value.title, revision: this.revision, autoAnalyze: Boolean(newIncoming) });
  }
  binding() {
    return { source: this.source, revision: this.revision, wechat: this.source === 'wechat' && this.frame ? { ...this.frame } : null };
  }
  accepts(binding) {
    return binding && binding.source === this.source && binding.revision === this.revision &&
      (this.source !== 'wechat' || Boolean(this.frame && binding.wechat?.signature === this.frame.signature &&
        this.now() - this.frame.seenAt < 4000));
  }
}
module.exports = { InputSources, readLines };
