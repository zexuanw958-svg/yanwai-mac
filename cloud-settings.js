'use strict';
// Cloud route settings. API keys are encrypted with Electron safeStorage
// (macOS Keychain) before touching disk and are never sent to the renderer.
const fs = require('node:fs');
const path = require('node:path');
const { JUDGE_PRESETS, REPLY_PRESETS } = require('./jev-cloud');

const DEFAULTS = { judgeProvider: 'bocha', judgeUrl: '', judgeModel: '', replyProvider: 'template', replyUrl: '', replyModel: '' };
const TEXT_FIELDS = ['judgeUrl', 'judgeModel', 'replyUrl', 'replyModel'];

class CloudSettings {
  constructor({ file, crypto }) {
    this.file = file; this.crypto = crypto;
    this.values = { ...DEFAULTS }; this.secrets = { judgeKey: '', replyKey: '' };
    this.load();
  }
  load() {
    let stored;
    try { stored = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return; }
    if (!stored || typeof stored !== 'object') return;
    if (JUDGE_PRESETS[stored.judgeProvider]) this.values.judgeProvider = stored.judgeProvider;
    if (REPLY_PRESETS[stored.replyProvider]) this.values.replyProvider = stored.replyProvider;
    for (const field of TEXT_FIELDS) if (typeof stored[field] === 'string') this.values[field] = stored[field].slice(0, 300);
    for (const field of ['judgeKey', 'replyKey']) {
      if (typeof stored[field] !== 'string' || !stored[field]) continue;
      try { this.secrets[field] = this.crypto.decrypt(Buffer.from(stored[field], 'base64')); } catch { this.secrets[field] = ''; }
    }
  }
  save() {
    const record = { ...this.values };
    for (const field of ['judgeKey', 'replyKey']) {
      if (this.secrets[field]) record[field] = this.crypto.encrypt(this.secrets[field]).toString('base64');
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(record, null, 2), { mode: 0o600 });
  }
  // Full config for the main process only.
  config() { return { ...this.values, ...this.secrets }; }
  // What the renderer may see: no key material, only whether one is stored.
  publicView() {
    return { ...this.values, hasJudgeKey: Boolean(this.secrets.judgeKey), hasReplyKey: Boolean(this.secrets.replyKey),
      encryption: this.crypto.available(),
      judgePresets: Object.fromEntries(Object.entries(JUDGE_PRESETS).map(([key, value]) => [key, { label: value.label, model: value.model, keyHint: value.keyHint }])),
      replyPresets: Object.fromEntries(Object.entries(REPLY_PRESETS).map(([key, value]) => [key, { label: value.label, model: value.model }])) };
  }
  // A blank key field keeps the stored key; clearJudgeKey/clearReplyKey remove it.
  update(input) {
    if (!input || typeof input !== 'object') throw new Error('设置内容无效。');
    if (!this.crypto.available()) throw new Error('这台 Mac 的钥匙串暂时不可用，无法安全保存 Key。');
    const next = { ...this.values }, secrets = { ...this.secrets };
    if (input.judgeProvider !== undefined) {
      if (!JUDGE_PRESETS[input.judgeProvider]) throw new Error('未知的 Jev 接口。');
      next.judgeProvider = input.judgeProvider;
    }
    if (input.replyProvider !== undefined) {
      if (!REPLY_PRESETS[input.replyProvider]) throw new Error('未知的回复模型。');
      next.replyProvider = input.replyProvider;
    }
    for (const field of TEXT_FIELDS) {
      if (input[field] === undefined) continue;
      if (typeof input[field] !== 'string' || input[field].length > 300) throw new Error('设置内容过长。');
      next[field] = input[field].trim();
    }
    for (const [field, clear] of [['judgeKey', 'clearJudgeKey'], ['replyKey', 'clearReplyKey']]) {
      if (input[clear] === true) secrets[field] = '';
      if (typeof input[field] === 'string' && input[field].trim()) {
        const key = input[field].trim();
        if (key.length > 400 || /\s/.test(key)) throw new Error('Key 格式不对，请只粘贴 Key 本身。');
        secrets[field] = key;
      }
    }
    this.values = next; this.secrets = secrets;
    this.save();
    return this.publicView();
  }
}

function electronCrypto(safeStorage) {
  return {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: text => safeStorage.encryptString(text),
    decrypt: buffer => safeStorage.decryptString(buffer),
  };
}

module.exports = { CloudSettings, electronCrypto, DEFAULTS };
