'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jev = require('../jev-cloud');
const { CloudSettings } = require('../cloud-settings');

const response = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
function fakeFetch(handlers) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body, headers: options.headers });
    return handlers(url, body, calls.length);
  };
  return { fetchImpl, calls };
}
const judgeAnswer = {
  true_intent: { type: 'choice', choice: 'request_action', confidence: 0.4,
    probabilities: { confirm_you_care: 0.1, vent_anger: 0.2, request_action: 0.6, seek_explanation: 0, casual_chat: 0.1, close_topic: 0 } },
  best_action: { type: 'choice', choice: 'make_plan', probabilities: {}, confidence: 0.5 },
};

test('parses speaker lines, continuation lines and mine vs theirs', () => {
  assert.deepEqual(jev.parseMessages('女朋友：周末吃什么\n你是不是又等我来安排？\n我: 我来吧'), [
    { from: 'other', text: '周末吃什么\n你是不是又等我来安排？' }, { from: 'me', text: '我来吧' }]);
  assert.equal(jev.buildState('对方：在吗', 'romance').chat.latest_from, 'other');
  assert.match(jev.buildState('对方：在吗', 'work').chat.relationship, /同事/);
});

test('resolves presets and refuses missing keys or non-https urls', () => {
  assert.throws(() => jev.resolveJudge({ judgeProvider: 'bocha', judgeKey: '' }), /API Key/);
  assert.deepEqual(jev.resolveJudge({ judgeProvider: 'bocha', judgeKey: 'k' }), { url: 'https://jev.bocha.cn/v1/systemone', model: 'bocha-jev-v1', key: 'k' });
  assert.throws(() => jev.resolveJudge({ judgeProvider: 'custom', judgeUrl: 'http://x', judgeModel: 'm', judgeKey: 'k' }), /https/);
  assert.equal(jev.resolveReply({ replyProvider: 'template' }), null);
  // One OpenRouter key serves both routes, as upstream does.
  assert.equal(jev.resolveReply({ replyProvider: 'openrouter', judgeProvider: 'openrouter', judgeKey: 'or' }).key, 'or');
  assert.throws(() => jev.resolveReply({ replyProvider: 'deepseek', judgeProvider: 'openrouter', judgeKey: 'or' }), /回复模型的 API Key/);
});

test('judge, draft, then rank: recommended reply is the highest Jev probability', async () => {
  const { fetchImpl, calls } = fakeFetch((url, body, n) => {
    if (n === 1) return response(200, { answers: judgeAnswer });
    if (n === 2) return response(200, { choices: [{ message: { content: '["A 回复","B 回复","C 回复"]' } }] });
    return response(200, { answers: { best_reply: { type: 'choice', choice: 'reply_b', probabilities: { reply_a: 0.2, reply_b: 0.7, reply_c: 0.1 } } } });
  });
  const result = await jev.analyze({ text: '女朋友：周末吃什么，你是不是又等我来安排？', scenario: 'romance', fetchImpl,
    config: { judgeProvider: 'bocha', judgeKey: 'jk', replyProvider: 'deepseek', replyKey: 'rk' } });
  assert.equal(calls[0].url, 'https://jev.bocha.cn/v1/systemone');
  assert.equal(calls[0].body.model, 'bocha-jev-v1');
  assert.deepEqual(Object.keys(calls[0].body.questions), ['true_intent', 'best_action']);
  assert.equal(calls[0].headers.Authorization, 'Bearer jk');
  assert.equal(calls[1].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(calls[1].headers.Authorization, 'Bearer rk');
  assert.match(calls[1].body.messages[1].content, /想要你给出具体行动或答复/);
  assert.deepEqual(calls[2].body.questions.best_reply.criteria, { reply_a: 'A 回复', reply_b: 'B 回复', reply_c: 'C 回复' });
  assert.deepEqual(result.replies, ['B 回复', 'A 回复', 'C 回复']);
  assert.equal(result.kind, 'jev');
  assert.equal(result.intent, '想要你给出具体行动或答复');
  assert.equal(result.action, '直接提出安排（时间、地点、事情）');
  assert.equal(result.replySource, '模型生成 · Jev 排序');
  assert.equal(result.intentProbabilities.request_action, 0.6);
  assert.equal(Object.keys(result.intentLabels).length, 6);
});

test('without a drafting model, templates are ranked by Jev and labelled', async () => {
  const { fetchImpl, calls } = fakeFetch((url, body, n) => n === 1 ? response(200, { answers: judgeAnswer })
    : response(200, { answers: { best_reply: { probabilities: { reply_a: 0.1, reply_b: 0.3, reply_c: 0.6 } } } }));
  const result = await jev.analyze({ text: '对方：几点见？', scenario: 'life', fetchImpl,
    config: { judgeProvider: 'typesafe', judgeKey: 'k', replyProvider: 'template' } });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(result.replySource, '固定模板 · Jev 排序');
  assert.equal(result.replies[0], jev.TEMPLATES.make_plan[2]);
});

test('HTTP errors become plain-language messages and never echo the key', async () => {
  for (const [status, pattern] of [[401, /Key 无效/], [402, /余额不足/], [429, /太频繁/], [503, /暂时不可用/]]) {
    const { fetchImpl } = fakeFetch(() => response(status, { error: 'secret-key-abc' }));
    await assert.rejects(jev.analyze({ text: '对方：在吗', fetchImpl, config: { judgeProvider: 'bocha', judgeKey: 'secret-key-abc', replyProvider: 'template' } }),
      error => pattern.test(error.message) && !error.message.includes('secret'));
  }
});

test('unknown judge choices are rejected rather than guessed', async () => {
  const { fetchImpl } = fakeFetch(() => response(200, { answers: { true_intent: { choice: 'x' }, best_action: { choice: 'y' } } }));
  await assert.rejects(jev.analyze({ text: '对方：在吗', fetchImpl, config: { judgeProvider: 'bocha', judgeKey: 'k', replyProvider: 'template' } }), /可用的判断/);
});

test('an aborted request reports cancellation', async () => {
  const controller = new AbortController();
  const fetchImpl = (url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const pending = jev.analyze({ text: '对方：在吗', fetchImpl, signal: controller.signal, config: { judgeProvider: 'bocha', judgeKey: 'k', replyProvider: 'template' } });
  controller.abort();
  await assert.rejects(pending, /已取消/);
});

test('reply parsing accepts a JSON array or numbered lines', () => {
  assert.deepEqual(jev.parseReplies('好的：\n["一","二","三","四"]'), ['一', '二', '三']);
  assert.deepEqual(jev.parseReplies('1. 一\n2. 二\n3. 三'), ['一', '二', '三']);
  assert.throws(() => jev.parseReplies('只有一条'), /三条/);
});

test('settings encrypt keys at rest and never expose them to the renderer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yanwai-cloud-'));
  const file = path.join(dir, 'cloud-settings.json');
  const crypto = { available: () => true, encrypt: text => Buffer.from('enc:' + text), decrypt: buffer => buffer.toString().slice(4) };
  const settings = new CloudSettings({ file, crypto });
  assert.equal(settings.publicView().judgeProvider, 'bocha');
  const view = settings.update({ judgeProvider: 'openrouter', judgeKey: ' sk-or-123 ', replyProvider: 'openrouter' });
  assert.equal(view.hasJudgeKey, true);
  assert.ok(!JSON.stringify(view).includes('sk-or-123'));
  const disk = fs.readFileSync(file, 'utf8');
  assert.ok(!disk.includes('sk-or-123'));
  assert.equal((fs.statSync(file).mode & 0o777), 0o600);
  const reloaded = new CloudSettings({ file, crypto });
  assert.equal(reloaded.config().judgeKey, 'sk-or-123');
  // Blank keeps the saved key; explicit clear removes it.
  reloaded.update({ judgeKey: '' });
  assert.equal(reloaded.config().judgeKey, 'sk-or-123');
  reloaded.update({ clearJudgeKey: true });
  assert.equal(reloaded.config().judgeKey, '');
  assert.throws(() => reloaded.update({ judgeProvider: 'evil' }), /未知/);
  assert.throws(() => reloaded.update({ judgeKey: 'has space' }), /格式/);
  assert.throws(() => new CloudSettings({ file, crypto: { ...crypto, available: () => false } }).update({ judgeKey: 'x' }), /钥匙串/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('certainty: weak or close top intents count as unsure', () => {
  const labels = { a: '甲', b: '乙', c: '丙' };
  assert.equal(jev.assessCertainty({ a: 0.92, b: 0.05, c: 0.03 }, labels).uncertain, false);
  assert.deepEqual(jev.assessCertainty({ a: 0.54, b: 0.46, c: 0 }, labels).contenders, ['甲', '乙']);
  assert.equal(jev.assessCertainty({ a: 0.45, b: 0.2, c: 0.35 }, labels).uncertain, true);
  assert.equal(jev.assessCertainty({ a: 0.6, b: 0.39, c: 0.01 }, labels).uncertain, false);
});

test('unsure analysis asks the drafter for a question first and keeps it first', async () => {
  const unsure = { ...judgeAnswer, true_intent: { choice: 'casual_chat', probabilities: { confirm_you_care: 0, vent_anger: 0.3, request_action: 0, seek_explanation: 0, casual_chat: 0.36, close_topic: 0.34 } } };
  const { fetchImpl, calls } = fakeFetch((url, body, n) => n === 1 ? response(200, { answers: unsure })
    : n === 2 ? response(200, { choices: [{ message: { content: '["怎么啦？","好呀","嗯嗯"]' } }] })
    : response(200, { answers: { best_reply: { probabilities: { reply_a: 0.1, reply_b: 0.2, reply_c: 0.7 } } } }));
  const result = await jev.analyze({ text: '对方：哦', fetchImpl, config: { judgeProvider: 'bocha', judgeKey: 'k', replyProvider: 'deepseek', replyKey: 'r' } });
  assert.match(calls[1].body.messages[0].content, /第 1 条必须是一句自然的追问/);
  assert.match(calls[1].body.messages[1].content, /拿不准/);
  assert.equal(result.certainty.uncertain, true);
  assert.deepEqual(result.replies, ['怎么啦？', '嗯嗯', '好呀']);
  // Template mode swaps in question-back templates.
  const templ = fakeFetch((url, body, n) => n === 1 ? response(200, { answers: unsure }) : response(200, { answers: { best_reply: { probabilities: {} } } }));
  const plain = await jev.analyze({ text: '对方：哦', fetchImpl: templ.fetchImpl, config: { judgeProvider: 'bocha', judgeKey: 'k', replyProvider: 'template' } });
  assert.ok(jev.CLARIFY_TEMPLATES.includes(plain.replies[0]));
});

test('draft check sends my draft in state, flags risks and rewrites only when needed', async () => {
  const bad = { fit: { type: 'score', score: 0.9 }, upsets: { noul: 0.74 }, misses_need: { noul: 0.28 }, over_promise: { noul: 0.1 }, cold: { noul: 0.68 } };
  const { fetchImpl, calls } = fakeFetch((url, body, n) => n === 1 ? response(200, { answers: bad })
    : response(200, { choices: [{ message: { content: '“这次我来定，晚上发你”' } }] }));
  const result = await jev.checkDraft({ text: '女朋友：周末吃什么？', draft: ' 随便，你定吧 ', scenario: 'romance', fetchImpl,
    config: { judgeProvider: 'bocha', judgeKey: 'k', replyProvider: 'deepseek', replyKey: 'r' } });
  assert.equal(calls[0].body.state.my_draft, '随便，你定吧');
  assert.deepEqual(Object.keys(calls[0].body.questions), ['fit', 'upsets', 'misses_need', 'over_promise', 'cold']);
  assert.deepEqual(result.flags.map(flag => flag.key), ['upsets', 'misses_need', 'cold']);
  assert.equal(result.levelLabel, '不太合适');
  assert.equal(result.verdict, '建议先别发，改一改。');
  assert.equal(result.suggestion, '这次我来定，晚上发你');

  const good = { fit: { score: 3.2 }, upsets: { noul: 0.1 }, misses_need: { noul: 0.9 }, over_promise: { noul: 0.2 }, cold: { noul: 0.05 } };
  const second = fakeFetch(() => response(200, { answers: good }));
  const ok = await jev.checkDraft({ text: '女朋友：周末吃什么？', draft: '这次我来安排', fetchImpl: second.fetchImpl,
    config: { judgeProvider: 'bocha', judgeKey: 'k', replyProvider: 'deepseek', replyKey: 'r' } });
  assert.equal(second.calls.length, 1);
  assert.equal(ok.verdict, '可以发。');
  assert.equal(ok.suggestion, null);
  await assert.rejects(jev.checkDraft({ text: '对方：在吗', draft: '  ', fetchImpl, config: { judgeProvider: 'bocha', judgeKey: 'k' } }), /打算发/);
});
