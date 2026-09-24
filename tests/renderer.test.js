const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { examples, demoResult } = require('../panel-policy');
const { formatDistribution } = require('../renderer/probabilities');

// Minimal DOM test double for async rendering behavior, not a visual/layout test.
class Element {
  constructor() {
    this.textContent = ''; this.value = ''; this.children = []; this.hidden = false;
    this.disabled = false; this.dataset = {}; this.handlers = {}; this.attributes = {};
    this.style = {}; this.classes = new Set();
    this.classList = { toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name) };
  }
  addEventListener(name, callback) { this.handlers[name] = callback; }
  setAttribute(name, value) { this.attributes[name] = value; }
  focus() {}
  replaceChildren(...items) { this.children = items; }
  append(...items) { this.children.push(...items); }
  emit(name) { return this.handlers[name]?.(); }
  querySelectorAll() { return []; }
  contains() { return false; }
  get options() { return this.children; }
  querySelector() { if (!this.inner) this.inner = new Element(); return this.inner; }
}
const cloudView = { judgeProvider: 'bocha', judgeUrl: '', judgeModel: '', replyProvider: 'template', replyUrl: '', replyModel: '',
  hasJudgeKey: true, hasReplyKey: false, encryption: true,
  judgePresets: { bocha: { label: '博查 Jev（限时免费）', model: 'bocha-jev-v1', keyHint: 'open.bocha.cn' } },
  replyPresets: { template: { label: '不用生成模型（固定模板）', model: '' } } };
function replyCard() {
  const card = new Element();
  const elements = Object.fromEntries(['.reply-number','.reply-text','.copy-button','.fill-button','span','use'].map(key => [key, new Element()]));
  card.querySelector = key => elements[key];
  elements['.copy-button'].querySelector = key => elements[key];
  return card;
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function renderer(permissionsOverride = {}) {
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  get('replyTemplate').content = { firstElementChild: { cloneNode: replyCard } };
  const document = { body: new Element(), getElementById: get, createElement: () => new Element() };
  document.activeElement = document.body;
  const state = { mode: 'expanded', placement: 'top', backend: 'demo', following: false, source: 'manual', examples };
  const pending = []; const fills = []; const timers = new Set(); let stateListener, textListener;
  const perm = { screen: 'granted', accessibility: true, host: 'Electron', ...permissionsOverride }; const requested = []; const relaunched = [];
  const update = (key, value) => { state[key] = value; stateListener?.({...state}); return {...state}; };
  const api = {
    getState: async () => ({...state}), setMode: async value => update('mode', value),
    setPlacement: async value => update('placement', value), setBackend: async value => update('backend', value),
    setSource: async value => update('source', value),
    fillReply: payload => new Promise(resolve => fills.push({payload,resolve})), openPermission: async () => {}, readClipboard: async () => ({text: ''}),
    copyReply: async () => ({copied: true}), quit: async () => {}, getLocalHealth: async () => ({ready: true}),
    getCloud: async () => ({...cloudView}), saveCloud: async () => ({...cloudView}), testCloud: async () => ({ ok: true, message: 'ok' }),
    checkDraft: payload => new Promise(resolve => pending.push({payload, resolve, draft: true})),
    getPermissions: async () => ({...perm}), requestPermission: async kind => { requested.push(kind); return {...perm}; }, relaunch: async () => { relaunched.push(true); },
    onState: fn => { stateListener = fn; return () => {}; }, onText: fn => { textListener = fn; return () => {}; },
    analyze: payload => payload.backend === 'demo' ? Promise.resolve(demoResult(payload.scenario)) :
      new Promise(resolve => pending.push({payload, resolve})),
  };
  const window = { yanwai: api, formatDistribution, addEventListener: () => {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../renderer/app.js'), 'utf8'), {window,document,setTimeout: fn => {timers.add(fn); return fn;},clearTimeout: fn => timers.delete(fn)});
  await tick();
  return { get, pending, fills, api, perm, requested, relaunched, async source(value) { get('sourceSelect').value=value; get('sourceSelect').emit('change'); await tick(); },
    async text(value) { textListener(value); await tick(); }, async flush() { const batch=[...timers]; timers.clear(); for (const fn of batch) fn(); await tick(); },
    async click(id) { get(id).emit('click'); await tick(); },
    async input(value) { get('chatInput').value = value; get('chatInput').emit('input'); await tick(); } };
}
const local = (intent, probabilities) => ({kind:'local',intent,action:'先确认安排',replies:['回复一','回复二','回复三'],
  replySource:'本地表达模板',latencyMs:1,contextTrimmed:false,intentProbabilities:probabilities});

test('renderer shows three romance replies, one recommendation and clears fixtures on input edits', async () => {
  const r = await renderer();
  await r.click('exampleRomance');
  assert.equal(r.get('analysisResult').hidden, false);
  assert.deepEqual(r.get('intentDistribution').children.map(row => row.children[2].textContent), ['72%','20%','8%']);
  assert.deepEqual(r.get('replyList').children.map(card => card.querySelector('.reply-text').textContent), examples.romance.replies);
  assert.equal(r.get('replyList').children.filter(card => card.classes.has('is-recommended')).length, 1);
  assert.equal(r.get('replyList').children[0].querySelector('.reply-number').textContent, '01 / 最推荐');
  await r.input(examples.romance.text + ' 我自己修改了');
  assert.equal(r.get('analysisResult').hidden, true);
  assert.equal(r.get('analyzeButton').disabled, true);
  assert.equal(r.get('intentDistribution').children.length, 0);
  assert.equal(r.get('replyList').children.length, 0);
});
test('old async results cannot repopulate a new input; latest result retains its own full distribution', async () => {
  const r = await renderer();
  await r.click('backendLocal'); await r.input('会话A'); await r.click('analyzeButton');
  await r.input('会话B'); await r.click('analyzeButton');
  assert.equal(r.pending.length, 2);
  r.pending[0].resolve(local('旧会话', {old:1})); await tick();
  assert.equal(r.get('analysisResult').hidden, true);
  r.pending[1].resolve(local('最新会话', {a:.7,b:.2,c:.09,d:.01})); await tick();
  assert.equal(r.get('intentText').textContent, '最新会话');
  assert.equal(r.get('intentDistribution').children.length, 4);
  assert.equal(r.get('replyList').children.length, 3);
  assert.equal(r.get('analyzeButton').disabled, false);
});
test('a local result without probabilities never borrows demo numbers; mode changes reject pending results', async () => {
  const r = await renderer();
  await r.click('exampleRomance'); await r.click('backendLocal'); await r.input('自己的对话');
  await r.click('analyzeButton'); r.pending[0].resolve(local('本地判断')); await tick();
  assert.equal(r.get('intentDistribution').children.length, 0);
  assert.equal(r.get('distributionNote').textContent, '暂无意图概率分布');
  assert.equal(r.get('replySource').textContent, '本地表达模板');
  await r.click('analyzeButton'); await r.click('exampleRomance');
  r.pending[1].resolve(local('过期判断', {old:1})); await tick();
  assert.equal(r.get('intentText').textContent, examples.romance.intent);
  assert.deepEqual(r.get('intentDistribution').children.map(row => row.children[2].textContent), ['72%','20%','8%']);
});

test('wechat never auto-analyzes demo input; local latest wins even while collapsed and own/unknown messages only invalidate', async () => {
  const r=await renderer(); await r.source('wechat');
  await r.text({source:'wechat',text:'对方：新的消息',revision:1,autoAnalyze:true});await r.flush();
  assert.equal(r.pending.length,0);assert.equal(r.get('analysisResult').hidden,true);assert.equal(r.get('inputSource').textContent,'来自微信');
  assert.equal(r.get('analyzeButton').disabled,true);
  await r.click('backendLocal');
  await r.text({source:'wechat',text:'对方：消息A',revision:2,autoAnalyze:true});await r.flush();
  assert.equal(r.pending.length,1);
  await r.text({source:'wechat',text:'对方：消息B',revision:3,autoAnalyze:true});await r.flush();
  assert.equal(r.pending.length,2);r.pending[0].resolve(local('过期'));await tick();assert.equal(r.get('analysisResult').hidden,true);
  r.pending[1].resolve(local('消息B',{a:.72,b:.28}));await tick();assert.equal(r.get('intentText').textContent,'消息B');
  assert.equal(r.get('intentDistribution').children[0].children[1].children[0].style.width,'72%');
  await r.click('collapseButton');await r.text({source:'wechat',text:'对方：消息C',revision:4,autoAnalyze:true});await r.flush();
  assert.equal(r.pending.length,2);await r.click('expandButton');await r.flush();assert.equal(r.pending.length,3);
  assert.equal(r.pending[2].payload.revision,4);
  await r.text({source:'wechat',text:'对方：消息C\n我：已回复',revision:5,autoAnalyze:false});await r.flush();
  r.pending[2].resolve(local('未发前的建议'));await tick();assert.equal(r.get('analysisResult').hidden,true);
});
test('fill buttons lock during IPC, show fallback permission hint and stale callbacks cannot refill a new conversation', async () => {
  const r=await renderer();const card=r.get('replyList').children[0],button=card.querySelector('.fill-button');
  assert.equal(button.disabled,false);assert.equal(button.classes.has('is-primary'),true);
  button.emit('click');await tick();assert.equal(button.disabled,true);assert.equal(r.fills.length,1);
  assert.equal(r.get('replyList').children[1].querySelector('.fill-button').disabled,true);
  r.fills[0].resolve({filled:false,copied:true,permission:'accessibility',message:'已复制，请手动粘贴。直接填入需要辅助功能权限。'});await tick();
  assert.equal(button.disabled,false);assert.equal(r.get('fillPermission').hidden,false);assert.match(r.get('feedback').textContent,/已复制，请手动粘贴/);
  await r.input('新会话');button.emit('click');await tick();assert.equal(r.fills.length,1);
  await r.click('exampleRomance');const current=r.get('replyList').children[0].querySelector('.fill-button');current.emit('click');await tick();
  await r.source('wechat');r.fills[1].resolve({filled:true,message:'已填入'});await tick();assert.notEqual(r.get('feedback').textContent,'已填入');
});
test('turning off following cancels pending input analysis and ignores late worker events', async () => {
  const r=await renderer();await r.click('backendLocal');await r.source('clipboard');
  await r.text({source:'clipboard',text:'来自复制',revision:1,autoAnalyze:true});await r.source('manual');await r.flush();assert.equal(r.pending.length,0);
  await r.text({source:'wechat',text:'过期内容',revision:2,autoAnalyze:true});assert.notEqual(r.get('chatInput').value,'过期内容');
});

test('collapsing an active automatic request retries the latest conversation on reopen', async () => {
  const r=await renderer();await r.click('backendLocal');await r.source('wechat');
  await r.text({source:'wechat',text:'对方：收起时还在分析',revision:9,autoAnalyze:true});await r.flush();
  assert.equal(r.pending.length,1);await r.click('collapseButton');
  r.pending[0].resolve(local('收起前的结果'));await tick();assert.equal(r.get('analysisResult').hidden,true);
  await r.click('expandButton');await r.flush();assert.equal(r.pending.length,2);assert.equal(r.pending[1].payload.revision,9);
  r.pending[1].resolve(local('重开后的最新结果'));await tick();assert.equal(r.get('intentText').textContent,'重开后的最新结果');
});

test('Jev cloud backend renders its own label, recommended reply and plain error reasons', async () => {
  const r = await renderer();
  await r.click('backendJev');
  assert.equal(r.get('cloudSettings').hidden, false);
  assert.equal(r.get('backendJev').attributes['aria-pressed'], 'true');
  await r.input('对方：周末吃什么，你是不是又等我来安排？'); await r.click('analyzeButton');
  assert.equal(r.pending.length, 1);
  assert.equal(r.pending[0].payload.backend, 'jev');
  r.pending[0].resolve({ kind: 'jev', intent: '想要你给出具体行动或答复', action: '直接提出安排（时间、地点、事情）',
    replies: ['B 回复', 'A 回复', 'C 回复'], replySource: '固定模板 · Jev 排序', latencyMs: 2100, contextTrimmed: false,
    intentProbabilities: { request_action: 0.6, vent_anger: 0.4 }, intentLabels: { request_action: '想要行动', vent_anger: '不满' } });
  await tick();
  assert.equal(r.get('analysisResult').hidden, false);
  assert.equal(r.get('resultBadge').textContent, 'Jev 云端');
  assert.match(r.get('resultDetail').textContent, /2\.1 秒/);
  assert.equal(r.get('replyList').children[0].querySelector('.reply-text').textContent, 'B 回复');
  assert.deepEqual(r.get('intentDistribution').children.map(row => row.children[2].textContent), ['60%', '40%']);

  // A mislabelled source is rejected instead of rendered.
  await r.input('对方：在吗'); await r.click('analyzeButton');
  r.pending[1].resolve({ kind: 'jev', intent: 'x', action: 'y', replies: ['a'], replySource: '本地表达模板', latencyMs: 1, contextTrimmed: false });
  await tick();
  assert.equal(r.get('analysisResult').hidden, true);

  r.api.analyze = async () => { throw new Error("Error invoking remote method 'model:analyze': Error: 还没有填 Jev 的 API Key。"); };
  await r.input('对方：在吗？'); await r.click('analyzeButton');
  assert.equal(r.get('feedback').textContent, '还没有填 Jev 的 API Key。');
  assert.equal(r.get('cloudSettings').open, true);
});

test('unsure Jev results say so and lead with a question back', async () => {
  const r = await renderer();
  await r.click('backendJev');
  await r.input('对方：哦'); await r.click('analyzeButton');
  r.pending[0].resolve({ kind: 'jev', intent: '轻松闲聊，没有特别要求', action: '先回应感受', replies: ['怎么啦？', 'B', 'C'],
    replySource: '模型生成 · Jev 排序', latencyMs: 1, contextTrimmed: false,
    certainty: { uncertain: true, contenders: ['轻松闲聊', '在表达不满'], top: 0.36, margin: 0.08 } });
  await tick();
  assert.equal(r.get('uncertainNote').hidden, false);
  assert.match(r.get('uncertainNote').textContent, /拿不准.*轻松闲聊.*在表达不满/);
  assert.equal(r.get('replyList').children[0].querySelector('.reply-number').textContent, '01 / 先问一句');
  await r.input('对方：好的'); assert.equal(r.get('uncertainNote').hidden, true);
});

test('draft check shows verdict, flags and a rewrite; chat edits clear stale verdicts', async () => {
  const r = await renderer();
  assert.equal(r.get('draftCheck').hidden, true);
  await r.click('backendJev');
  assert.equal(r.get('draftCheck').hidden, false);
  await r.input('女朋友：周末吃什么？');
  assert.equal(r.get('draftButton').disabled, true);
  r.get('draftInput').value = '随便，你定吧'; r.get('draftInput').emit('input'); await tick();
  assert.equal(r.get('draftButton').disabled, false);
  await r.click('draftButton');
  const call = r.pending.find(item => item.draft);
  assert.deepEqual({ text: call.payload.text, draft: call.payload.draft }, { text: '女朋友：周末吃什么？', draft: '随便，你定吧' });
  assert.equal(r.get('draftButton').textContent, '正在看…');
  call.resolve({ kind: 'draft-check', score: 0.9, level: 1, levelLabel: '不太合适', maxLevel: 4, verdict: '建议先别发，改一改。',
    flags: [{ key: 'cold', label: '听起来敷衍', probability: 0.68 }], suggestion: '这次我来定，晚上发你', suggestionSource: '模型改写', latencyMs: 1 });
  await tick();
  assert.equal(r.get('draftResult').hidden, false);
  assert.equal(r.get('draftResult').dataset.tone, 'bad');
  assert.equal(r.get('draftLevel').textContent, '不太合适');
  assert.equal(r.get('draftFlags').children.length, 1);
  assert.equal(r.get('draftSuggestionText').textContent, '这次我来定，晚上发你');
  assert.equal(r.get('draftSuggestion').hidden, false);
  await r.input('女朋友：算了不吃了');
  assert.equal(r.get('draftResult').hidden, true);
  assert.equal(r.get('draftInput').value, '随便，你定吧');
});

test('permission guide leads the user: shows missing steps, opens settings, turns green, offers a relaunch', async () => {
  const r = await renderer({ screen: 'denied', accessibility: false });
  assert.equal(r.get('permissionGuide').hidden, false);
  assert.equal(r.get('guideTitle').textContent, '还差两步：打开屏幕录制和辅助功能');
  await r.click('axGrant');
  assert.deepEqual(r.requested, ['accessibility']);
  assert.match(r.get('guideHint').textContent, /找到「Electron」/);
  assert.equal(r.get('axState').textContent, '等你打开开关…');
  r.perm.accessibility = true; await r.flush();
  assert.equal(r.get('axState').textContent, '已开启 ✓');
  assert.equal(r.get('guideAx').classes.has('is-granted'), true);
  await r.click('screenGrant');
  assert.deepEqual(r.requested, ['accessibility', 'screen']);
  assert.equal(r.get('guideRelaunch').hidden, false);
  r.perm.screen = 'granted'; await r.flush();
  assert.equal(r.get('screenState').textContent, '重启后生效');
  await r.click('guideRelaunch');
  assert.equal(r.relaunched.length, 1);
});

test('dismissed guide comes back when the user picks WeChat without screen recording', async () => {
  const r = await renderer({ screen: 'denied', accessibility: true });
  assert.equal(r.get('guideTitle').textContent, '还差一步：打开屏幕录制');
  await r.click('guideDismiss');
  assert.equal(r.get('permissionGuide').hidden, true);
  await r.source('wechat');
  assert.equal(r.get('permissionGuide').hidden, false);
});

test('no guide when both permissions are already on', async () => {
  const r = await renderer();
  assert.equal(r.get('permissionGuide').hidden, true);
});

test('source buttons switch the conversation source and show which one is on', async () => {
  const r = await renderer();
  await r.click('sourceWechat');
  assert.equal(r.get('sourceWechat').attributes['aria-pressed'], 'true');
  assert.equal(r.get('sourceManual').attributes['aria-pressed'], 'false');
  await r.click('sourceManual');
  assert.equal(r.get('sourceManual').attributes['aria-pressed'], 'true');
});

test('switching back to manual clears a stale "来自微信" badge', async () => {
  const r = await renderer();
  await r.click('sourceWechat');
  assert.equal(r.get('inputSource').textContent, '来自微信');
  await r.click('sourceManual');
  assert.equal(r.get('inputSource').textContent, '你的对话');
});
test('a screenshot read through copy-or-screenshot is labelled as coming from a screenshot', async () => {
  const r=await renderer();await r.click('backendLocal');await r.source('clipboard');
  await r.text({source:'clipboard',via:'screenshot',text:'对方：忙吗',revision:1,autoAnalyze:true});
  assert.equal(r.get('chatInput').value,'对方：忙吗');assert.equal(r.get('inputSource').textContent,'来自截图');
  await r.text({source:'clipboard',text:'复制的话',revision:2,autoAnalyze:true});assert.equal(r.get('inputSource').textContent,'来自复制');
});
