'use strict';
// Adapted from xiaopu-ai/TO-DO-Panel's multi-display panel geometry.
// MIT; see vendor/to-do-panel/LICENSE and THIRD_PARTY_NOTICES.md.
const upstream = require('./vendor/to-do-panel/platform');

function boundsFor(display, mode, placement = 'top') {
  const area = display.workArea;
  const margin = 12;
  const collapsed = mode === 'collapsed';
  const notch = display.notch;
  if (collapsed) {
    // Exactly overlap the cutout. Placement controls only the expanded panel;
    // collapsing from the right also returns to the physical notch.
    if (notch && notch.width > 0 && notch.height > 0) return {
      x: Math.round(display.bounds.x + notch.offsetX),
      y: display.bounds.y,
      width: Math.round(notch.width), height: Math.round(notch.height),
    };
    const original = upstream.panelBounds('darwin', display, false);
    return { ...original, height: Math.max(1, area.y - display.bounds.y || 24) };
  }
  const width = Math.max(1, Math.min(placement === 'right' ? 430 : 860, area.width - margin * 2));
  const top = placement === 'right' ? area.y + margin : display.bounds.y;
  const height = Math.max(1, Math.min(placement === 'right' ? 740 : 650, area.y + area.height - top - margin));
  const base = upstream.panelBounds('darwin', display, !collapsed);
  const centered = Math.round(base.x + base.width / 2 - width / 2);
  return {
    x: placement === 'right' ? area.x + area.width - width - margin :
      Math.max(area.x + margin, Math.min(centered, area.x + area.width - width - margin)),
    y: top, width, height,
  };
}

class RequestGate {
  constructor() { this.version = 0; }
  invalidate() { return ++this.version; }
  accepts(version) { return version === this.version; }
}

function validateText(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('先放入一段聊天文字。');
  if (value.length > 8000) throw new Error('这段太长了，请保留最近几句（最多 8000 字）。');
  return value.trim();
}

const examples = {
  work: {
    text: '同事：方案今天能给我吗？明早要和客户过一遍。\n我：还在调整，应该来得及。\n同事：具体几点呢？我得留时间看。',
    intent: '希望得到明确的交付安排', action: '先确认可交付的时间，再回应对方。',
    replies: ['我先核对一下剩余工作，给你一个能做到的时间。', '你最晚几点需要？我按你审核的时间安排。', '我可以先把已完成的部分发你，你先看关键结论。'],
  },
  life: {
    text: '朋友：你到了吗？\n我：刚出门，路上有点堵。\n朋友：我已经等了二十分钟了。',
    intent: '可能在表达等待带来的不满', action: '先承认让对方久等，再核实到达时间。',
    replies: ['抱歉，让你等了。我先确认一下还要多久，马上告诉你。', '是我没安排好出门时间。你先找个地方坐一下好吗？', '如果耽误你后面的安排，我们也可以改时间，按你方便来。'],
  },
  romance: {
    text: '女朋友：周末吃什么，你是不是又等我来安排？',
    intent: '希望你主动安排', action: '主动给出餐厅和时间，把安排落到实处。',
    intentProbabilities: { '希望你主动安排': 0.72, '对一直自己操心有些不满': 0.20, '单纯确认吃什么': 0.08 },
    replies: ['这次我来安排，今晚把餐厅和时间发你，你负责来吃。', '火锅还是日料？你选一个，剩下的我来安排。', '你挑想吃的，我负责找店和订位。'],
  },
};

function demoResult(scenario) {
  const fixture = examples[scenario];
  if (!fixture) throw new Error('请选择一个示例。');
  return { kind: 'demo', intentProbabilities: fixture.intentProbabilities ? { ...fixture.intentProbabilities } : null, intent: fixture.intent, action: fixture.action, replies: [...fixture.replies], replySource: '示例回复', latencyMs: null, contextTrimmed: false };
}

module.exports = { boundsFor, RequestGate, validateText, examples, demoResult };
