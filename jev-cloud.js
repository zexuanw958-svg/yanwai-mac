'use strict';
// Jev cloud route: Jev judges and ranks; an optional OpenAI-compatible model
// drafts the three candidates. Question wording is ported from the upstream
// Android client (jev-chat/jev-chat-jarvis, JevQuestions.kt, MIT), where it
// passed the authors' calibration. Pure Node; fetch is injected for tests.

const JUDGE_PRESETS = {
  bocha: { label: '博查 Jev（限时免费）', url: 'https://jev.bocha.cn/v1/systemone', model: 'bocha-jev-v1', keyHint: 'open.bocha.cn' },
  openrouter: { label: 'OpenRouter', url: 'https://openrouter.ai/api/alpha/decisions', model: 'typesafe/jev-1.13', keyHint: 'openrouter.ai' },
  typesafe: { label: 'TypeSafe 官方', url: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest', keyHint: 'console.typesafe.ai' },
  custom: { label: '自定义', url: '', model: '', keyHint: '' },
};
const REPLY_PRESETS = {
  template: { label: '不用生成模型（固定模板）', url: '', model: '' },
  deepseek: { label: 'DeepSeek 官方', url: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat' },
  openrouter: { label: 'OpenRouter', url: 'https://openrouter.ai/api/v1/chat/completions', model: 'deepseek/deepseek-chat-v3.1' },
  custom: { label: '自定义（OpenAI 兼容）', url: '', model: '' },
};

const RELATIONSHIPS = {
  work: '对方是我的同事或工作伙伴',
  life: '对方是我的朋友或家人',
  romance: '对方是我的伴侣或暧昧对象',
};

const BACKGROUND_NOTE = ' Facts given in background are provided context, not off-topic.';

const INTENTS = {
  confirm_you_care: ['在确认你是否在乎', "They are testing whether you remember, pay attention, or still care. Signals: 'did you forget again', 'then say it', 'you better', sarcastic 'busy person', asking you to prove you know a past conversation. If they mainly want a new deliverable or a yes on a time, do not use this."],
  vent_anger: ['在表达不满，想先被理解', 'They are angry or hurt and mainly want the feeling acknowledged. They are blaming or raising the temperature; a specific plan is not the main point yet.'],
  request_action: ['想要你给出具体行动或答复', 'They want a concrete action, time, deliverable, or commitment from you now, and this is a real ask, not a loyalty test.'],
  seek_explanation: ['想要一个解释', 'They want a factual explanation of why something happened. They asked why or what is going on, not mainly for an apology or a new plan.'],
  casual_chat: ['轻松闲聊，没有特别要求', 'Light talk, banter, sharing, teasing with a laugh, or friendly logistics with no emotional test and no conflict. A friend suggesting a meal time can be this if the thread is warm.'],
  close_topic: ['想收尾，这件事过去了', "Peaceful wrap-up only: they accepted an apology, confirmed a happy plan, said thanks, or clearly signaled they need nothing more. Not a breakup, not 'don't contact me', not sarcastic 'I'm used to it'."],
};
const ACTIONS = {
  check_history: ['先翻翻之前聊过什么，再表态', 'Look up prior chat or facts before taking a position. Use when they ask you to repeat, recall, or prove you remember something specific.'],
  apologize: ['先真诚道歉', 'Lead with a sincere apology for a real mistake or hurt already identified. Not for an unnamed forgotten thing when you should first find out what it was.'],
  give_commitment: ['给出具体承诺或时间', 'Give a concrete promise, deadline, or arrangement they asked for in a conflict or work-pressure setting.'],
  explain: ['把事情解释清楚', 'Explain what happened or why, without leading with apology or a new plan.'],
  acknowledge: ['先回应感受，让对方觉得被听见', 'Show you heard them and care, without new facts, an apology, or a plan. Use for light chat or when they mainly need to feel seen.'],
  say_less: ['少说一点，别火上浇油', 'Keep it short or add nothing. Extra words would over-explain, reopen a closed topic, or pour fuel on an ultimatum that told you not to talk.'],
  make_plan: ['直接提出安排（时间、地点、事情）', 'Propose or confirm logistics (time, place, task) for a non-conflict request such as a meal or a meeting.'],
};
// Used only when no drafting model is configured; labelled as templates in the UI.
const TEMPLATES = {
  check_history: ['我先翻一下我们之前聊的，确认好了马上回你。', '你说的是哪一次？我怕记混了，想先确认一下。', '给我一分钟，我把前面的内容对一下。'],
  apologize: ['这次是我没做好，对不起。', '让你不舒服了，是我的问题，我认真改。', '抱歉，我知道这让你挺失望的。'],
  give_commitment: ['我今天之内给你一个确定的时间。', '这件事我来负责，明天中午前给你结果。', '我先把能确定的部分发你，剩下的晚上补齐。'],
  explain: ['我说一下具体情况，你看看。', '事情是这样的，我按顺序讲。', '我先把经过讲清楚，有不对的你指出来。'],
  acknowledge: ['我看到了，你说，我在听。', '听起来这事让你挺累的。', '嗯，我懂你的意思。'],
  say_less: ['好，我知道了。', '嗯，我记下了。', '收到。'],
  make_plan: ['这次我来安排，定好了发你。', '你看哪个时间方便？剩下的我来弄。', '我先订好，你只管来就行。'],
};

// Used when Jev itself is unsure; the first suggestion becomes a question back.
const CLARIFY_TEMPLATES = ['怎么啦，是有什么事吗？', '你是想说什么呀？我怕理解偏了。', '嗯？你具体指的是哪件事？'];

// "Unsure" = the top intent is weak or barely ahead of the runner-up. Jev's
// probabilities are calibrated, so a close race is real ambiguity, not noise.
const UNSURE_TOP = 0.5, UNSURE_MARGIN = 0.2;
function assessCertainty(probabilities, labels) {
  const ranked = Object.entries(probabilities || {}).filter(([, value]) => typeof value === 'number')
    .sort((a, b) => b[1] - a[1]);
  if (ranked.length < 2) return { uncertain: false };
  const [[firstKey, first], [secondKey, second]] = ranked;
  const uncertain = first < UNSURE_TOP || first - second < UNSURE_MARGIN;
  return uncertain
    ? { uncertain, contenders: [labels[firstKey] || firstKey, labels[secondKey] || secondKey], top: first, margin: first - second }
    : { uncertain, top: first, margin: first - second };
}

// Draft check: Jev reads the conversation plus the reply I am about to send.
const DRAFT_FLAGS = {
  upsets: { label: '可能让对方更不舒服', bad: true, instructions: 'If I send my_draft as my next message, would the other person likely feel more upset, hurt, or annoyed than now? Judge from the whole conversation.' },
  misses_need: { label: '没接住对方真正想要的', bad: false, instructions: "Does my_draft respond to what the other person actually wants in their latest message (their real need, not just the literal words)?" },
  over_promise: { label: '承诺过头或说了没把握的事', bad: true, instructions: 'Does my_draft promise a specific result, time, or fact that the conversation does not show I can actually deliver or know?' },
  cold: { label: '听起来敷衍、冷淡或阴阳怪气', bad: true, instructions: 'Does my_draft sound dismissive, cold, perfunctory, or sarcastic toward the other person?' },
};
const FIT_LEVELS = ['很可能适得其反', '不太合适', '还行，但可以更好', '挺合适', '非常合适'];

const questionText = text => text + BACKGROUND_NOTE;
function choice(instructions, table) {
  return { type: 'choice', instructions: questionText(instructions),
    criteria: Object.fromEntries(Object.entries(table).map(([key, [, description]]) => [key, description])) };
}

function judgeQuestions() {
  return {
    true_intent: choice("What is the other person's true intent in the latest message, given the full conversation? Prefer tone and context over surface wording. If they are checking whether you remember something or still care, choose confirm_you_care even if the words look like a request to 'say it' or to do something. If they already accepted and closed the matter peacefully, choose close_topic. Ending the relationship, deleting you, or 'don't talk to me' is vent_anger, never close_topic.", INTENTS),
    best_action: choice('What type of next action is best? Do not decide whether to send a message immediately. Ignore timing. Choose only the action type. If they asked you to recall a specific past message or event and you have not shown that you actually remember it, choose check_history - do not apologize or invent a plan instead.', ACTIONS),
  };
}

function rankQuestion(candidates) {
  if (candidates.length !== 3) throw new Error('需要正好三条候选回复。');
  return { best_reply: { type: 'choice', instructions: questionText("Which candidate reply is the most appropriate next message, given the conversation and the other person's true need? Prefer a reply that matches the best action type. Penalize dismissive, over-promising, or off-topic replies. If the facts are not yet confirmed, prefer the candidate that looks them up instead of faking memory or a vague apology."),
    criteria: { reply_a: candidates[0], reply_b: candidates[1], reply_c: candidates[2] } } };
}

// "我：…" lines are mine; any other "称呼：…" line is the other person. Lines
// without a speaker continue the previous message.
function parseMessages(text) {
  const messages = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(/^([^：:]{1,12})[：:]\s*(.*)$/);
    if (match) {
      const from = /^(我|自己|me)$/i.test(match[1].trim()) ? 'me' : 'other';
      messages.push({ from, text: match[2].trim() || line });
    } else if (messages.length) messages.at(-1).text += '\n' + line;
    else messages.push({ from: 'other', text: line });
  }
  return messages.slice(-10);
}

function buildState(text, scenario) {
  const messages = parseMessages(text);
  if (!messages.length) throw new Error('先放入一段聊天文字。');
  return { chat: { relationship: (RELATIONSHIPS[scenario] || '对方和我的关系未说明') + '；from=me 的是我发的，from=other 的是对方发的',
    messages, latest_from: messages.at(-1).from } };
}

function resolveJudge(config) {
  const preset = JUDGE_PRESETS[config.judgeProvider];
  if (!preset) throw new Error('请选择 Jev 接口。');
  const url = (config.judgeProvider === 'custom' ? config.judgeUrl : preset.url || '').trim();
  const model = (config.judgeModel || preset.model || '').trim();
  if (!/^https:\/\//.test(url)) throw new Error('Jev 接口地址需要以 https:// 开头。');
  if (!model) throw new Error('请填写 Jev 模型名。');
  if (!config.judgeKey) throw new Error('还没有填 Jev 的 API Key。');
  return { url, model, key: config.judgeKey };
}

function resolveReply(config) {
  if (config.replyProvider === 'template' || !REPLY_PRESETS[config.replyProvider]) return null;
  const preset = REPLY_PRESETS[config.replyProvider];
  const url = (config.replyProvider === 'custom' ? config.replyUrl : preset.url || '').trim();
  const model = (config.replyModel || preset.model || '').trim();
  // One OpenRouter key can serve both routes, as in the upstream app.
  const key = config.replyKey || (config.replyProvider === 'openrouter' && config.judgeProvider === 'openrouter' ? config.judgeKey : '');
  if (!/^https:\/\//.test(url)) throw new Error('回复模型地址需要以 https:// 开头。');
  if (!model) throw new Error('请填写回复模型名。');
  if (!key) throw new Error('还没有填回复模型的 API Key。');
  return { url, model, key };
}

class CloudError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

function friendlyStatus(route, status) {
  if (status === 401 || status === 403) return `${route}的 Key 无效或没有权限，请检查设置。`;
  if (status === 402) return `${route}账户余额不足，需要充值或换一个渠道。`;
  if (status === 429) return `${route}请求太频繁，稍等几秒再试。`;
  if (status === 413 || status === 422 || status === 400) return `${route}拒绝了这次请求（HTTP ${status}），对话可能太长或格式不对。`;
  if (status >= 500) return `${route}服务暂时不可用（HTTP ${status}），稍后再试。`;
  return `${route}请求失败（HTTP ${status}）。`;
}

async function postJSON(fetchImpl, { url, key, body, route, signal, timeoutMs = 30000 }) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const response = await fetchImpl(url, { method: 'POST', signal: controller.signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'Yanwai Mac' },
      body: JSON.stringify(body) });
    const raw = await response.text();
    if (!response.ok) throw new CloudError(friendlyStatus(route, response.status), response.status);
    try { return JSON.parse(raw); } catch { throw new CloudError(`${route}返回的不是有效 JSON。`); }
  } catch (error) {
    if (error instanceof CloudError) throw error;
    if (controller.signal.aborted) throw new CloudError(signal?.aborted ? '这次分析已取消。' : `${route}响应超时。`);
    throw new CloudError(`连不上${route}，请检查网络。`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

function validDistribution(value, keys) {
  if (!value || typeof value !== 'object') return null;
  const out = {};
  for (const key of keys) {
    const number = value[key];
    out[key] = typeof number === 'number' && Number.isFinite(number) ? number : null;
  }
  return out;
}

async function judge(fetchImpl, judgeRoute, state, questions, signal) {
  const value = await postJSON(fetchImpl, { url: judgeRoute.url, key: judgeRoute.key, route: 'Jev 接口', signal,
    body: { model: judgeRoute.model, state, questions } });
  if (!value || typeof value.answers !== 'object' || !value.answers) throw new CloudError('Jev 接口返回格式不对。');
  return value.answers;
}

function parseReplies(content) {
  const start = content.indexOf('['), end = content.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try {
      const list = JSON.parse(content.slice(start, end + 1));
      if (Array.isArray(list)) {
        const replies = list.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim().slice(0, 200));
        if (replies.length >= 3) return replies.slice(0, 3);
      }
    } catch { /* fall through */ }
  }
  const lines = content.split('\n').map(line => line.trim().replace(/^[-*\d.、)\s"“]+|["”]+$/g, '').trim()).filter(Boolean);
  if (lines.length >= 3) return lines.slice(0, 3).map(line => line.slice(0, 200));
  throw new CloudError('回复模型没有给出三条候选。');
}

async function draft(fetchImpl, replyRoute, { text, relationship, intent, action, certainty }, signal) {
  const unsure = certainty?.uncertain;
  const system = '你是中文即时通讯回复助手。只输出一个 JSON 数组，含且仅含 3 条候选回复文本，三条策略要有区别（例如：一条稳妥承接、一条给具体行动或承诺、一条简短低姿态）。' +
    (unsure ? '这次对方的意思不明确：第 1 条必须是一句自然的追问，帮我弄清对方到底想要什么，不能像审问，也不要先下结论。' : '') +
    '每条不超过 40 字，口语、自然、像真人在聊天软件里发消息。不要编造对话里没有的事实。不要解释，直接输出 JSON 数组。';
  const judgement = unsure
    ? `判断参考：对方的意思拿不准，可能是「${certainty.contenders[0]}」，也可能是「${certainty.contenders[1]}」。`
    : `判断参考：对方${intent}；建议${action}。`;
  const user = `关系：${relationship}\n${judgement}\n\n最近对话：\n${text}\n\n请给出 3 条候选回复。`;
  const value = await postJSON(fetchImpl, { url: replyRoute.url, key: replyRoute.key, route: '回复模型', signal,
    body: { model: replyRoute.model, temperature: 0.8, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] } });
  const content = value?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new CloudError('回复模型返回格式不对。');
  return parseReplies(content);
}

async function analyze({ text, scenario, config, fetchImpl = fetch, signal, now = () => Date.now() }) {
  const started = now();
  const judgeRoute = resolveJudge(config);
  const replyRoute = resolveReply(config);
  const state = buildState(text, scenario);
  const answers = await judge(fetchImpl, judgeRoute, state, judgeQuestions(), signal);
  const intentKey = INTENTS[answers.true_intent?.choice] ? answers.true_intent.choice : null;
  const actionKey = ACTIONS[answers.best_action?.choice] ? answers.best_action.choice : null;
  if (!intentKey || !actionKey) throw new CloudError('Jev 没有给出可用的判断。');
  const intent = INTENTS[intentKey][0], action = ACTIONS[actionKey][0];
  const intentLabels = Object.fromEntries(Object.entries(INTENTS).map(([key, [label]]) => [key, label]));
  const intentProbabilities = validDistribution(answers.true_intent.probabilities, Object.keys(INTENTS));
  const certainty = assessCertainty(intentProbabilities, intentLabels);
  let candidates, replySource;
  if (replyRoute) {
    candidates = await draft(fetchImpl, replyRoute, { text, relationship: state.chat.relationship, intent, action, certainty }, signal);
    replySource = '模型生成 · Jev 排序';
  } else {
    candidates = certainty.uncertain ? [...CLARIFY_TEMPLATES] : [...TEMPLATES[actionKey]];
    replySource = '固定模板 · Jev 排序';
  }
  const ranking = await judge(fetchImpl, judgeRoute, state, rankQuestion(candidates), signal);
  const probabilities = ranking.best_reply?.probabilities || {};
  const keys = ['reply_a', 'reply_b', 'reply_c'];
  const scored = candidates.map((reply, index) => ({ reply, score: Number(probabilities[keys[index]]) || 0 }));
  // When unsure, the drafted question back stays first; the rest follow Jev's order.
  const ranked = certainty.uncertain && replyRoute
    ? [scored[0], ...scored.slice(1).sort((a, b) => b.score - a.score)]
    : [...scored].sort((a, b) => b.score - a.score);
  return {
    kind: 'jev',
    intent, action,
    intentProbabilities, intentLabels,
    certainty,
    replies: ranked.map(item => item.reply),
    replyProbabilities: ranked.map(item => item.score),
    replySource,
    latencyMs: Math.max(0, now() - started),
    contextTrimmed: parseMessages(text).length < text.split(/\r?\n/).filter(line => /^[^：:]{1,12}[：:]/.test(line.trim())).length,
  };
}

async function checkDraft({ text, draft: mine, scenario, config, fetchImpl = fetch, signal, now = () => Date.now() }) {
  const started = now();
  if (typeof mine !== 'string' || !mine.trim()) throw new CloudError('先写下你打算发的那句话。');
  if (mine.length > 600) throw new CloudError('这句太长了，请控制在 600 字以内。');
  const judgeRoute = resolveJudge(config);
  const replyRoute = resolveReply(config);
  const state = { ...buildState(text, scenario), my_draft: mine.trim() };
  const questions = {
    fit: { type: 'score', instructions: questionText('How well does my_draft work as my next message in this conversation, considering what the other person really needs and the tone of the thread?'),
      criteria: ['Likely to backfire or make things worse', 'Weak: misses the point or sets the wrong tone', 'Acceptable but could clearly be better', 'Good fit', 'Excellent fit'] },
    ...Object.fromEntries(Object.entries(DRAFT_FLAGS).map(([key, flag]) => [key, { type: 'noul', instructions: questionText(flag.instructions) }])),
  };
  const answers = await judge(fetchImpl, judgeRoute, state, questions, signal);
  const score = Number(answers.fit?.score);
  if (!Number.isFinite(score)) throw new CloudError('Jev 没有给出可用的评分。');
  const level = Math.max(0, Math.min(FIT_LEVELS.length - 1, Math.round(score)));
  const flags = [];
  for (const [key, flag] of Object.entries(DRAFT_FLAGS)) {
    const value = Number(answers[key]?.noul);
    if (!Number.isFinite(value)) continue;
    // misses_need is phrased positively: a low "yes" is the problem.
    const risk = flag.bad ? value : 1 - value;
    if (risk >= 0.5) flags.push({ key, label: flag.label, probability: risk });
  }
  flags.sort((a, b) => b.probability - a.probability);
  let suggestion = null, suggestionSource = null;
  if (replyRoute && (level <= 2 || flags.length)) {
    const system = '你是中文即时通讯回复助手。用户写了一句准备发出的回复，请针对指出的问题改一版更合适的：保留用户想表达的立场和说话风格，但如果原句的做法本身就是问题（比如敷衍、推给对方），就换一种做法。只输出改好的那一句，不超过 40 字，不要解释，不要引号，不要编造对话里没有的事实。';
    const user = `关系：${state.chat.relationship}\n最近对话：\n${text}\n\n我打算发：${mine.trim()}\n问题：${flags.map(item => item.label).join('、') || '整体不够合适'}\n\n请改一版。`;
    const value = await postJSON(fetchImpl, { url: replyRoute.url, key: replyRoute.key, route: '回复模型', signal,
      body: { model: replyRoute.model, temperature: 0.6, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] } });
    const content = value?.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.trim()) {
      suggestion = content.trim().split('\n')[0].replace(/^["“「]+|["”」]+$/g, '').slice(0, 200);
      suggestionSource = '模型改写';
    }
  }
  return {
    kind: 'draft-check',
    score, level, levelLabel: FIT_LEVELS[level], maxLevel: FIT_LEVELS.length - 1,
    flags, suggestion, suggestionSource,
    verdict: level >= 3 && !flags.length ? '可以发。' : level >= 2 && flags.length <= 1 ? '能发，但可以再改改。' : '建议先别发，改一改。',
    latencyMs: Math.max(0, now() - started),
  };
}

async function testConnection({ config, fetchImpl = fetch, signal }) {
  const judgeRoute = resolveJudge(config);
  await judge(fetchImpl, judgeRoute, { chat: { messages: [{ from: 'other', text: '明天几点见？' }], latest_from: 'other' } },
    { is_question: { type: 'noul', instructions: 'The latest message asks a question.' } }, signal);
  const replyRoute = resolveReply(config);
  if (replyRoute) {
    const value = await postJSON(fetchImpl, { url: replyRoute.url, key: replyRoute.key, route: '回复模型', signal,
      body: { model: replyRoute.model, temperature: 0, max_tokens: 8, messages: [{ role: 'user', content: '请只回复两个字：收到' }] } });
    if (typeof value?.choices?.[0]?.message?.content !== 'string') throw new CloudError('回复模型返回格式不对。');
  }
  return { judge: true, reply: Boolean(replyRoute) };
}

module.exports = { JUDGE_PRESETS, REPLY_PRESETS, INTENTS, ACTIONS, TEMPLATES, parseMessages, buildState,
  judgeQuestions, rankQuestion, resolveJudge, resolveReply, parseReplies, analyze, checkDraft, testConnection, CloudError,
  assessCertainty, CLARIFY_TEMPLATES, DRAFT_FLAGS, FIT_LEVELS };
