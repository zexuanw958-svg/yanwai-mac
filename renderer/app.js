'use strict';

(() => {
  // Matches panel-policy.js fixtures; no dependency on its optional state.examples extension.
  // Editing or pasting always clears demo eligibility.
  let EXAMPLES = Object.freeze({
    work: '同事：方案今天能给我吗？明早要和客户过一遍。\n我：还在调整，应该来得及。\n同事：具体几点呢？我得留时间看。',
    romance: '女朋友：周末吃什么，你是不是又等我来安排？',
    life: '朋友：你到了吗？\n我：刚出门，路上有点堵。\n朋友：我已经等了二十分钟了。',
  });
  const $ = (id) => document.getElementById(id);
  const ui = Object.fromEntries([
    'expandButton', 'collapseButton', 'quitButton', 'placeTop', 'placeRight',
    'backendDemo', 'backendLocal', 'backendJev', 'exampleWork', 'exampleLife', 'exampleRomance', 'chatInput',
    'scenarioSelect', 'inputSource', 'characterCount', 'pasteButton', 'modeHint',
    'analyzeButton', 'analyzeLabel', 'feedback', 'sourceSelect', 'switchToClipboard', 'sourceManual', 'sourceClipboard', 'sourceWechat', 'sourceStatus', 'sourcePermission', 'fillPermission', 'topStatus',
    'statusDot', 'localConnection', 'healthText', 'checkConnection', 'suggestionPane',
    'resultBadge', 'analysisResult', 'resultPlaceholder', 'placeholderTitle',
    'placeholderText', 'intentText', 'intentDistribution', 'distributionNote', 'actionText', 'replySource', 'replyList',
    'replyTemplate', 'resultDetail', 'trimmedNote', 'announcement', 'footerText',
    'cloudSettings', 'cloudSummary', 'judgeProvider', 'judgeUrl', 'judgeModel', 'judgeKey',
    'replyProvider', 'replyUrl', 'replyModel', 'replyKey', 'keyHint', 'saveCloud', 'testCloud', 'cloudStatus',
    'uncertainNote', 'draftCheck', 'draftInput', 'draftPaste', 'draftButton', 'draftResult', 'draftLevel', 'draftVerdict',
    'draftMeterBar', 'draftFlags', 'draftSuggestion', 'draftSuggestionText', 'draftCopy',
    'permissionGuide', 'guideTitle', 'guideDismiss', 'guideScreen', 'guideAx', 'screenState', 'axState',
    'screenGrant', 'axGrant', 'guideHint', 'guideRelaunch',
  ].map((id) => [id, $(id)]));
  const api = window.yanwai;
  let state = { mode: 'expanded', placement: 'top', following: false, source: 'manual', backend: 'demo' };
  let ready = false;
  let disposed = false;
  let changingState = false;
  let busy = false;
  let activeExample = 'work';
  let inputOrigin = 'example';
  let analysisVersion = 0;
  let interactionVersion = 0;
  let stateEventVersion = 0;
  let healthVersion = 0;
  let checkingHealth = false;
  let localReady = false;
  let clipboardTimer;
  let deferredClipboardVersion = null;
  let inputRevision = null;
  let lastAutomatic = false;
  let fillInFlight = false;
  let replyButtons = [];
  let cloud = null;
  let cloudBusy = false;
  let draftBusy = false;
  let draftVersion = 0;
  let permissions = null;
  let permissionTimer;
  let guideDismissed = false;
  let screenRequested = false;
  let axRequested = false;
  const unsubscribers = [];
  const BACKENDS = { demo: 'backendDemo', local: 'backendLocal', jev: 'backendJev' };
  const SOURCES = { manual: 'sourceManual', clipboard: 'sourceClipboard', wechat: 'sourceWechat' };
  const LABELS = { demo: '模拟数据', local: '本地分析', jev: 'Jev 云端' };
  // Electron wraps handler errors as "Error invoking remote method …: Error: <message>".
  const reason = (error, fallback) => {
    const text = String(error?.message || '');
    const index = text.lastIndexOf('Error: ');
    const message = (index >= 0 ? text.slice(index + 7) : text).trim();
    return message && !/Error invoking remote method/.test(message) ? message : fallback;
  };

  function feedback(message = '', error = false) {
    ui.feedback.textContent = message;
    ui.feedback.classList.toggle('is-error', error);
  }

  function isDemoExample() {
    return Boolean(activeExample && ui.scenarioSelect.value === activeExample &&
      ui.chatInput.value === EXAMPLES[activeExample]);
  }

  function renderControls() {
    document.body.dataset.mode = state.mode;
    document.body.dataset.placement = state.placement;
    document.body.dataset.backend = state.backend;
    const locked = !ready || changingState;
    for (const id of ['expandButton', 'collapseButton', 'placeTop', 'placeRight',
      'backendDemo', 'backendLocal', 'backendJev', 'exampleWork', 'exampleLife', 'exampleRomance', 'sourceSelect', 'sourceManual', 'sourceClipboard', 'sourceWechat']) {
      ui[id].disabled = locked;
    }
    ui.quitButton.disabled = !ready;
    ui.chatInput.disabled = !ready;
    ui.chatInput.readOnly = state.source !== 'manual';
    ui.scenarioSelect.disabled = !ready;
    ui.pasteButton.disabled = !ready;
    ui.placeTop.setAttribute('aria-pressed', String(state.placement === 'top'));
    ui.placeRight.setAttribute('aria-pressed', String(state.placement === 'right'));
    for (const [backend, id] of Object.entries(BACKENDS)) ui[id].setAttribute('aria-pressed', String(state.backend === backend));
    ui.cloudSettings.hidden = state.backend !== 'jev';
    ui.draftCheck.hidden = state.backend !== 'jev';
    ui.draftInput.disabled = !ready;
    ui.draftPaste.disabled = !ready || draftBusy;
    ui.draftButton.disabled = locked || draftBusy || !ui.chatInput.value.trim() || !ui.draftInput.value.trim();
    ui.draftButton.textContent = draftBusy ? '正在看…' : '帮我看看';
    renderCloud(locked);
    ui.exampleWork.setAttribute('aria-pressed', String(isDemoExample() && activeExample === 'work'));
    ui.exampleLife.setAttribute('aria-pressed', String(isDemoExample() && activeExample === 'life'));
    ui.exampleRomance.setAttribute('aria-pressed', String(isDemoExample() && activeExample === 'romance'));
    ui.sourceSelect.value = state.source;
    for (const [source, id] of Object.entries(SOURCES)) ui[id].setAttribute('aria-pressed', String(state.source === source));
    ui.sourceStatus.textContent = state.sourceStatus?.detail || '手动放入对话，不会自动读取。';
    ui.sourcePermission.hidden = state.source !== 'wechat' || state.sourceStatus?.state !== 'no-permission';
    ui.switchToClipboard.hidden = state.source !== 'wechat' || state.sourceStatus?.state !== 'blocked';
    renderPermissions();
    for (const button of replyButtons) button.disabled = locked || busy || fillInFlight;
    ui.inputSource.textContent = inputOrigin === 'example' ? '模拟数据' : inputOrigin === 'screenshot' ? '来自截图' : inputOrigin === 'clipboard' ? '来自复制' : inputOrigin === 'wechat' ? '来自微信' : '你的对话';
    ui.characterCount.textContent = `${ui.chatInput.value.length.toLocaleString('zh-CN')} 字`;
    ui.localConnection.hidden = state.backend !== 'local';
    ui.localConnection.classList.toggle('is-ready', localReady);
    ui.healthText.textContent = checkingHealth ? '正在检查连接…' : localReady ? '本地模型已连接' : '本地模型尚未连接';
    ui.checkConnection.disabled = locked || checkingHealth;
    ui.checkConnection.textContent = checkingHealth ? '检查中…' : '检查连接';
    const cloudReady = Boolean(cloud?.hasJudgeKey);
    ui.topStatus.textContent = state.backend === 'demo' ? '示例体验' : state.backend === 'jev'
      ? (cloudReady ? 'Jev 云端' : '等待设置 Key') : localReady ? '本地已连接' : '等待本地连接';
    ui.statusDot.classList.toggle('is-offline', (state.backend === 'local' && !localReady) || (state.backend === 'jev' && !cloudReady));
    ui.modeHint.textContent = state.backend === 'demo'
      ? '模拟数据。自己的对话请选「Jev 云端」或「本地模型」。'
      : state.backend === 'jev'
        ? (cloud?.replyProvider === 'template' ? 'Jev 判断意图并排序，候选表达使用固定模板。' : 'Jev 判断意图并排序，候选表达由回复模型生成。')
        : '判断由本地模型完成，候选表达使用固定模板。';
    ui.footerText.textContent = state.backend === 'jev' ? '对话会发给你选的云端服务 · 本机不保存对话历史' : '本机处理入口 · 不保存对话历史';
    ui.analyzeButton.disabled = locked || busy || !ui.chatInput.value.trim() ||
      (state.backend === 'demo' && !isDemoExample());
    ui.analyzeLabel.textContent = busy ? (state.backend === 'demo' ? '正在打开示例…' : '正在分析…') : '分析这段';
  }

  function showPlaceholder(title, description) {
    ui.analysisResult.hidden = true;
    ui.resultPlaceholder.hidden = false;
    ui.placeholderTitle.textContent = title;
    ui.placeholderText.textContent = description;
    ui.resultBadge.textContent = LABELS[state.backend];
  }

  function invalidate() {
    analysisVersion += 1;
    clearTimeout(clipboardTimer);
    deferredClipboardVersion = null;
    busy = false;
    ui.suggestionPane.setAttribute('aria-busy', 'false');
    replyButtons = [];
    ui.replyList.replaceChildren();
    ui.intentText.textContent = '';
    ui.intentDistribution.replaceChildren();
    ui.distributionNote.textContent = '';
    ui.actionText.textContent = '';
    ui.uncertainNote.hidden = true;
    clearDraftResult();
    if (state.backend === 'demo' && !isDemoExample()) {
      showPlaceholder('自己的对话，交给 Jev', '选择「Jev 云端」并填好 Key，再分析这段话。');
    } else {
      showPlaceholder('留一点空间，理解这句话', '准备好对话后，点击「分析这段」。');
    }
    feedback();
    renderControls();
  }

  function validateState(value) {
    if (!value || !['expanded', 'collapsed'].includes(value.mode) ||
      !['top', 'right'].includes(value.placement) ||
      !Object.hasOwn(BACKENDS, value.backend) || typeof value.following !== 'boolean' || !['manual', 'clipboard', 'wechat'].includes(value.source)) {
      throw new Error('Invalid state');
    }
    return value;
  }

  function applyState(next) {
    validateState(next);
    const previous = state;
    state = { ...next };
    if (previous.source !== state.source && state.source !== 'manual') {
      ui.chatInput.value = ''; activeExample = null; inputOrigin = state.source; inputRevision = null;
    }
    // Back to manual with nothing carried over: the badge must not keep saying "来自微信".
    if (previous.source !== state.source && state.source === 'manual' && !ui.chatInput.value.trim() && inputOrigin !== 'example') inputOrigin = 'manual';
    if (previous.backend !== state.backend) {
      healthVersion += 1;
      checkingHealth = false;
      localReady = false;
    }
    if (previous.backend !== state.backend || previous.source !== state.source || (previous.mode !== state.mode && busy)) invalidate();
    if (state.source === 'wechat' && (previous.source !== 'wechat' || state.sourceStatus?.state === 'no-permission') && !screenGranted()) showGuide();
    if (previous.mode === 'collapsed' && state.mode === 'expanded') void refreshPermissions();
    if (previous.source !== state.source) {
      clearTimeout(clipboardTimer);
      deferredClipboardVersion = null;
      lastAutomatic = false;
    }
    renderControls();
    if (previous.mode !== state.mode) {
      (state.mode === 'collapsed' ? ui.expandButton : ui.collapseButton).focus({ preventScroll: true });
    }
    if (previous.backend !== state.backend && state.backend === 'local') void checkHealth();
    if (previous.mode === 'collapsed' && state.mode === 'expanded' && lastAutomatic) scheduleAutomatic();
  }

  async function changeState(method, value) {
    if (!ready || changingState || disposed) return false;
    const focusedBefore = document.activeElement;
    changingState = true;
    renderControls();
    const observed = stateEventVersion;
    try {
      const next = validateState(await api[method](value));
      if (disposed) return false;
      // An event delivered after this call began is newer than its returned snapshot.
      if (observed === stateEventVersion) applyState(next);
      return state[{ setMode: 'mode', setPlacement: 'placement', setBackend: 'backend', setSource: 'source' }[method]] === value;
    } catch {
      if (!disposed) {
        feedback('这次设置没有完成，请再试一次。', true);
        ui.announcement.textContent = '设置失败，请重试。';
      }
      return false;
    } finally {
      changingState = false;
      if (!disposed) {
        renderControls();
        if (method === 'setMode') {
          (state.mode === 'collapsed' ? ui.expandButton : ui.collapseButton).focus({ preventScroll: true });
        } else if (state.mode === 'expanded' && focusedBefore && document.activeElement === document.body) {
          focusedBefore.focus({ preventScroll: true });
        }
        if (deferredClipboardVersion === analysisVersion && state.source !== 'manual' && state.backend !== 'demo') {
          deferredClipboardVersion = null;
          void analyze();
        }
      }
    }
  }

  async function checkHealth() {
    if (!ready || disposed || state.backend !== 'local') return false;
    const version = ++healthVersion;
    checkingHealth = true;
    renderControls();
    try {
      const health = await api.getLocalHealth();
      if (disposed || version !== healthVersion || state.backend !== 'local') return false;
      if (!health || typeof health.ready !== 'boolean') throw new Error('Invalid health');
      localReady = health.ready;
      if (!health.ready) feedback('本地模型尚未连接。启动本地服务后，再检查连接。');
      else feedback('连接好了，可以分析这段对话。');
      return health.ready;
    } catch {
      if (!disposed && version === healthVersion) {
        localReady = false;
        feedback('暂时无法检查本地连接，请稍后重试。', true);
      }
      return false;
    } finally {
      if (!disposed && version === healthVersion) {
        checkingHealth = false;
        renderControls();
      }
    }
  }

  function validResult(result, backend) {
    return result && result.kind === backend &&
      typeof result.intent === 'string' && result.intent.trim() &&
      typeof result.action === 'string' && result.action.trim() &&
      Array.isArray(result.replies) && result.replies.length > 0 &&
      result.replies.every((reply) => typeof reply === 'string' && reply.trim()) &&
      result.replySource === ({ demo: '示例回复', local: '本地表达模板' }[backend] ?? result.replySource) &&
      (backend !== 'jev' || ['模型生成 · Jev 排序', '固定模板 · Jev 排序'].includes(result.replySource)) &&
      typeof result.contextTrimmed === 'boolean' &&
      (result.latencyMs === null || (Number.isFinite(result.latencyMs) && result.latencyMs >= 0));
  }

  function renderResult(result, version) {
    ui.intentText.textContent = result.intent;
    const unsure = result.certainty?.uncertain && Array.isArray(result.certainty.contenders);
    ui.uncertainNote.hidden = !unsure;
    ui.uncertainNote.textContent = unsure
      ? `这句我也拿不准：可能是「${result.certainty.contenders[0]}」，也可能是「${result.certainty.contenders[1]}」，两边概率很接近。先问一句更稳，第一条就是追问。`
      : '';
    const distribution = window.formatDistribution(result.intentProbabilities,
      Object.keys(result.intentLabels || {}));
    ui.intentDistribution.replaceChildren();
    for (const row of distribution.rows) {
      const item = document.createElement('div');
      item.className = 'probability-row';
      const label = document.createElement('span');
      label.className = 'probability-label';
      label.textContent = result.intentLabels?.[row.key] || row.key;
      const percent = document.createElement('strong');
      percent.textContent = row.percent;
      const track = document.createElement('span');
      track.className = 'probability-track'; track.setAttribute('aria-hidden', 'true');
      const bar = document.createElement('span');
      bar.className = 'probability-bar'; bar.style.width = `${row.raw * 100}%`;
      track.append(bar);
      item.append(label, track, percent);
      ui.intentDistribution.append(item);
    }
    ui.distributionNote.textContent = distribution.note;
    ui.actionText.textContent = result.action;
    ui.replySource.textContent = result.replySource;
    ui.replyList.replaceChildren();
    replyButtons = [];
    result.replies.forEach((reply, index) => {
      const card = ui.replyTemplate.content.firstElementChild.cloneNode(true);
      card.classList.toggle('is-recommended', index === 0);
      card.querySelector('.reply-number').textContent = index === 0 ? (result.certainty?.uncertain ? '01 / 先问一句' : '01 / 最推荐') : `表达 ${String(index + 1).padStart(2, '0')}`;
      card.querySelector('.reply-text').textContent = reply;
      const copyButton = card.querySelector('.copy-button');
      copyButton.setAttribute('aria-label', `复制候选表达 ${index + 1}`);
      copyButton.addEventListener('click', async () => {
        if (version !== analysisVersion || disposed) return;
        copyButton.disabled = true;
        try {
          await api.copyReply(reply);
          if (version !== analysisVersion || disposed) return;
          copyButton.querySelector('span').textContent = '已复制';
          copyButton.querySelector('use').setAttribute('href', '#icon-check');
          ui.announcement.textContent = `已复制候选表达 ${index + 1}。`;
        } catch {
          if (version === analysisVersion && !disposed) feedback('没能复制成功，请再点一次「复制」。', true);
        } finally {
          if (version === analysisVersion && !disposed) copyButton.disabled = false;
        }
      });
      const fillButton = card.querySelector('.fill-button');
      fillButton.setAttribute('aria-label', `填入候选表达 ${index + 1}，不会发送`);
      fillButton.classList.toggle('is-primary', index === 0);
      replyButtons.push(fillButton);
      fillButton.addEventListener('click', async () => {
        if (version !== analysisVersion || disposed || changingState || busy || fillInFlight) return;
        fillInFlight = true; renderControls();
        try {
          const outcome = await api.fillReply({ token: result.fillToken, index });
          if (version !== analysisVersion || disposed) return;
          if (!outcome || typeof outcome.message !== 'string') throw new Error('Invalid fill result');
          feedback(outcome.message, !outcome.filled && !outcome.copied);
          ui.fillPermission.hidden = outcome.permission !== 'accessibility';
          if (outcome.permission === 'accessibility') showGuide();
          ui.announcement.textContent = outcome.message;
        } catch {
          // Do not claim a copy happened when the IPC result is unknown.
          if (version === analysisVersion && !disposed) feedback('填入未完成，请点「复制」后手动粘贴。', true);
        } finally {
          fillInFlight = false;
          if (!disposed) renderControls();
        }
      });
      ui.replyList.append(card);
    });
    ui.resultBadge.textContent = LABELS[result.kind];
    const latency = result.latencyMs === null ? '' : ` · ${(result.latencyMs / 1000).toFixed(1)} 秒`;
    ui.resultDetail.textContent = result.kind === 'demo'
      ? '模拟数据 · 不代表对方的真实想法'
      : result.kind === 'jev' ? `Jev 云端${latency} · 概率是模型的判断，不是对方的真实想法`
        : `本地分析${latency} · 表达使用固定模板`;
    ui.trimmedNote.hidden = !result.contextTrimmed;
    ui.resultPlaceholder.hidden = true;
    ui.analysisResult.hidden = false;
    ui.announcement.textContent = result.kind === 'demo' ? '模拟示例已展开。' : '分析完成，候选表达可复制。';
  }

  async function analyze() {
    if (!ready || disposed || changingState || (state.mode === 'collapsed' && state.backend !== 'demo')) return;
    const text = ui.chatInput.value.trim();
    const scenario = ui.scenarioSelect.value;
    const backend = state.backend;
    if (!text) return feedback('先放入几句聊天，再来看看怎么接。');
    if (backend === 'demo' && !isDemoExample()) {
      return feedback('这不是模拟示例。请选择「本地模型」分析自己的对话。');
    }
    invalidate();
    const version = analysisVersion;
    const isCurrent = () => !disposed && version === analysisVersion &&
      state.backend === backend && ui.scenarioSelect.value === scenario &&
      ui.chatInput.value.trim() === text && (state.mode === 'expanded' || backend === 'demo');
    busy = true;
    ui.suggestionPane.setAttribute('aria-busy', 'true');
    showPlaceholder(backend === 'demo' ? '正在打开这段示例' : '正在梳理这段对话',
      backend === 'demo' ? '这里展示的是模拟数据。' : '给理解留一点时间。');
    renderControls();
    try {
      if (backend === 'local' && !localReady) {
        const connected = await checkHealth();
        if (!isCurrent()) return;
        if (!connected) {
          showPlaceholder('本地模型尚未连接', '启动本地服务后，点击「检查连接」。');
          return;
        }
      }
      const result = await api.analyze({ text, scenario, backend, revision: inputRevision });
      if (!isCurrent()) return;
      if (!validResult(result, backend)) {
        showPlaceholder('这次没有拿到完整建议', '返回内容与当前模式不一致，请重新分析。');
        feedback('分析结果不完整或模式不匹配，请重试。', true);
        return;
      }
      renderResult(result, version);
      lastAutomatic = false;
      feedback();
    } catch (error) {
      if (isCurrent()) {
        if (backend === 'local') localReady = false;
        showPlaceholder(backend === 'demo' ? '示例暂时没有打开' : '这次分析没有完成',
          backend === 'demo' ? '请再选一次示例。' : backend === 'jev' ? '看看下方提示，改好设置后重试。' : '请检查本地连接后重试。');
        feedback(backend === 'demo' ? '示例暂时不可用，请重试。' : backend === 'jev'
          ? reason(error, 'Jev 云端分析未完成，请检查网络和 Key 后再试。') : '本地分析未完成，请检查连接后再试。', true);
        if (backend === 'jev' && /Key|设置|接口地址|模型名/.test(ui.feedback.textContent)) ui.cloudSettings.open = true;
      }
    } finally {
      if (isCurrent()) {
        busy = false;
        ui.suggestionPane.setAttribute('aria-busy', 'false');
        renderControls();
      }
    }
  }

  function fillOptions(select, presets, value) {
    if (select.options.length !== Object.keys(presets).length) {
      select.replaceChildren(...Object.entries(presets).map(([key, preset]) => {
        const option = document.createElement('option');
        option.value = key; option.textContent = preset.label;
        return option;
      }));
    }
    select.value = value;
  }

  function renderCloud(locked) {
    if (!cloud) {
      ui.cloudSummary.textContent = '设置暂不可用';
      return;
    }
    const editing = ui.cloudSettings.contains(document.activeElement);
    if (!editing) {
      fillOptions(ui.judgeProvider, cloud.judgePresets, cloud.judgeProvider);
      fillOptions(ui.replyProvider, cloud.replyPresets, cloud.replyProvider);
      ui.judgeUrl.value = cloud.judgeUrl; ui.judgeModel.value = cloud.judgeModel;
      ui.replyUrl.value = cloud.replyUrl; ui.replyModel.value = cloud.replyModel;
    }
    const judge = ui.judgeProvider.value, reply = ui.replyProvider.value;
    for (const element of ui.cloudSettings.querySelectorAll('.custom-only')) {
      element.hidden = (element.dataset.route === 'judge' ? judge : reply) !== 'custom';
    }
    for (const element of ui.cloudSettings.querySelectorAll('.reply-only')) element.hidden = reply === 'template';
    ui.judgeModel.placeholder = cloud.judgePresets[judge]?.model || '模型名';
    ui.replyModel.placeholder = cloud.replyPresets[reply]?.model || '模型名';
    ui.judgeKey.placeholder = cloud.hasJudgeKey ? '已保存（留空不改）' : '粘贴 Key';
    ui.replyKey.placeholder = cloud.hasReplyKey ? '已保存（留空不改）'
      : reply === 'openrouter' && judge === 'openrouter' ? '留空则沿用上面的 OpenRouter Key' : '粘贴 Key';
    const hint = cloud.judgePresets[judge]?.keyHint;
    ui.keyHint.textContent = judge === 'bocha' ? 'Key 在博查开放平台 open.bocha.cn 申请，目前限时免费。'
      : hint ? `Key 在 ${hint} 获取。` : '填写完整的 /v1/systemone 接口地址。';
    ui.cloudSummary.textContent = cloud.hasJudgeKey ? `${cloud.judgePresets[cloud.judgeProvider].label.replace(/（.*）/, '')} · 已保存` : '未设置 Key';
    ui.cloudSummary.classList.toggle('is-ready', cloud.hasJudgeKey);
    for (const id of ['judgeProvider', 'judgeUrl', 'judgeModel', 'judgeKey', 'replyProvider', 'replyUrl', 'replyModel', 'replyKey', 'saveCloud', 'testCloud']) {
      ui[id].disabled = locked || cloudBusy;
    }
  }

  function cloudStatus(message, error = false) {
    ui.cloudStatus.textContent = message;
    ui.cloudStatus.classList.toggle('is-error', error);
  }

  async function saveCloud() {
    if (!ready || cloudBusy) return false;
    cloudBusy = true; renderControls();
    try {
      cloud = await api.saveCloud({
        judgeProvider: ui.judgeProvider.value, judgeUrl: ui.judgeUrl.value, judgeModel: ui.judgeModel.value, judgeKey: ui.judgeKey.value,
        replyProvider: ui.replyProvider.value, replyUrl: ui.replyUrl.value, replyModel: ui.replyModel.value, replyKey: ui.replyKey.value,
      });
      ui.judgeKey.value = ''; ui.replyKey.value = '';
      cloudStatus('已保存。');
      return true;
    } catch (error) {
      cloudStatus(reason(error, '没能保存，请再试一次。'), true);
      return false;
    } finally {
      cloudBusy = false;
      if (document.activeElement && ui.cloudSettings.contains(document.activeElement)) document.activeElement.blur();
      renderControls();
    }
  }

  async function testCloud() {
    if (!await saveCloud()) return;
    cloudBusy = true; cloudStatus('正在测试连接…'); renderControls();
    try {
      const outcome = await api.testCloud();
      cloudStatus(outcome?.message || '测试没有结果。', !outcome?.ok);
    } catch (error) {
      cloudStatus(reason(error, '测试没有完成，请稍后重试。'), true);
    } finally {
      cloudBusy = false; renderControls();
    }
  }

  function clearDraftResult() {
    draftVersion += 1;
    draftBusy = false;
    ui.draftResult.hidden = true;
    ui.draftFlags.replaceChildren();
    ui.draftSuggestion.hidden = true;
  }

  function renderDraft(result) {
    const tone = result.level >= 3 && !result.flags.length ? 'good' : result.level >= 2 ? 'warn' : 'bad';
    ui.draftResult.dataset.tone = tone;
    ui.draftLevel.textContent = result.levelLabel;
    ui.draftVerdict.textContent = result.verdict;
    ui.draftMeterBar.style.width = `${Math.max(4, Math.min(100, (result.score / result.maxLevel) * 100))}%`;
    ui.draftFlags.replaceChildren(...result.flags.map((flag) => {
      const item = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = flag.label;
      const value = document.createElement('strong');
      value.textContent = `${Math.round(flag.probability * 100)}%`;
      item.append(label, value);
      return item;
    }));
    ui.draftSuggestionText.textContent = result.suggestion || '';
    ui.draftCopy.querySelector('span').textContent = '复制';
    ui.draftSuggestion.hidden = !result.suggestion;
    ui.draftResult.hidden = false;
    ui.announcement.textContent = `${result.levelLabel}。${result.verdict}`;
  }

  function validDraftResult(result) {
    return result && result.kind === 'draft-check' && typeof result.levelLabel === 'string' &&
      typeof result.verdict === 'string' && Number.isFinite(result.score) && Number.isFinite(result.maxLevel) &&
      Array.isArray(result.flags) && result.flags.every((flag) => typeof flag.label === 'string' && Number.isFinite(flag.probability)) &&
      (result.suggestion === null || typeof result.suggestion === 'string');
  }

  async function checkDraft() {
    const text = ui.chatInput.value.trim(), draft = ui.draftInput.value.trim();
    if (!ready || disposed || state.backend !== 'jev' || draftBusy) return;
    if (!text) return feedback('先放入对方说的话，再检查你的回复。');
    if (!draft) return feedback('先写下你打算发的那句话。');
    clearDraftResult();
    const version = draftVersion;
    draftBusy = true; renderControls();
    try {
      const result = await api.checkDraft({ text, draft, scenario: ui.scenarioSelect.value });
      if (disposed || version !== draftVersion) return;
      if (!validDraftResult(result)) throw new Error('Invalid draft result');
      renderDraft(result);
      feedback();
    } catch (error) {
      if (!disposed && version === draftVersion) {
        feedback(reason(error, '这次没看成，请检查网络和 Key 后再试。'), true);
        if (/Key|设置/.test(ui.feedback.textContent)) ui.cloudSettings.open = true;
      }
    } finally {
      if (!disposed && version === draftVersion) { draftBusy = false; renderControls(); }
    }
  }

  function screenGranted() { return permissions?.screen === 'granted'; }
  function needsGuide() {
    return Boolean(permissions) && (!screenGranted() || !permissions.accessibility || screenRequested);
  }

  function renderPermissions() {
    if (!permissions) { ui.permissionGuide.hidden = true; return; }
    const show = ready && needsGuide() && !guideDismissed;
    ui.permissionGuide.hidden = !show;
    const screenOn = screenGranted(), axOn = permissions.accessibility;
    ui.guideScreen.classList.toggle('is-granted', screenOn && !screenRequested);
    ui.guideAx.classList.toggle('is-granted', axOn);
    ui.screenState.textContent = screenOn ? (screenRequested ? '重启后生效' : '已开启 ✓') : screenRequested ? '等你打开开关…' : '未开启';
    ui.axState.textContent = axOn ? '已开启 ✓' : axRequested ? '等你打开开关…' : '未开启';
    ui.screenGrant.textContent = screenRequested ? '再打开一次' : '去打开';
    ui.axGrant.textContent = axRequested ? '再打开一次' : '去打开';
    ui.screenGrant.disabled = ui.axGrant.disabled = !ready;
    const pending = [!screenOn || screenRequested ? '屏幕录制' : null, !axOn ? '辅助功能' : null].filter(Boolean);
    ui.guideTitle.textContent = pending.length ? `还差${pending.length === 2 ? '两' : '一'}步：打开${pending.join('和')}` : '权限都开好了';
    ui.guideHint.textContent = screenRequested || axRequested
      ? `系统设置已经打开：在列表里找到「${permissions.host}」，把右边的开关打开。没看到的话点列表下面的「+」，把它加进去。`
      : '点「去打开」，言外会帮你跳到系统设置的对应页面。以后从启动台或聚焦搜索「言外」打开；平时收在刘海里，⌘⇧J 呼出。';
    ui.guideRelaunch.hidden = !screenRequested;
    ui.permissionGuide.classList.toggle('is-done', !pending.length);
  }

  async function refreshPermissions() {
    clearTimeout(permissionTimer);
    try {
      const next = await api.getPermissions();
      if (disposed) return;
      if (next && ['granted', 'denied', 'not-determined', 'restricted', 'unknown'].includes(next.screen) && typeof next.accessibility === 'boolean') {
        const wasAx = permissions?.accessibility;
        permissions = { screen: next.screen, accessibility: next.accessibility, host: typeof next.host === 'string' ? next.host : '言外' };
        if (!wasAx && permissions.accessibility && axRequested) { axRequested = false; ui.announcement.textContent = '辅助功能已开启。'; }
      }
    } catch { /* keep the last known status */ }
    renderPermissions();
    // Keep polling while the guide is on screen so the switch shows up as ✓ right away.
    if (!disposed && !ui.permissionGuide.hidden && state.mode === 'expanded') permissionTimer = setTimeout(() => void refreshPermissions(), 2000);
  }

  function showGuide() {
    guideDismissed = false;
    void refreshPermissions();
  }

  async function requestPermission(kind) {
    if (!ready) return;
    if (kind === 'screen') screenRequested = true; else axRequested = true;
    guideDismissed = false;
    renderPermissions();
    try {
      const next = await api.requestPermission(kind);
      if (!disposed && next) permissions = { ...permissions, ...next };
    } catch {
      feedback('没能打开系统设置，请手动打开：系统设置 → 隐私与安全性。', true);
    }
    void refreshPermissions();
  }

  async function chooseExample(scenario) {
    if (!ready || changingState || disposed) return;
    if (state.source !== 'manual' && !await changeState('setSource', 'manual')) return;
    lastAutomatic = false;
    const interaction = ++interactionVersion;
    ui.chatInput.value = EXAMPLES[scenario];
    ui.scenarioSelect.value = scenario;
    activeExample = scenario;
    inputOrigin = 'example';
    invalidate();
    if (state.backend !== 'demo' && !await changeState('setBackend', 'demo')) return;
    if (interaction === interactionVersion && isDemoExample()) await analyze();
  }

  function scheduleAutomatic() {
    if (!lastAutomatic || state.source === 'manual' || state.backend === 'demo') return;
    const version = analysisVersion;
    clearTimeout(clipboardTimer);
    if (state.mode === 'collapsed') return;
    clipboardTimer = setTimeout(() => {
      if (version !== analysisVersion || !lastAutomatic || state.source === 'manual' || state.backend === 'demo') return;
      if (changingState) deferredClipboardVersion = version;
      else void analyze();
    }, 700);
  }
  function acceptInput(event, automatic) {
    interactionVersion += 1;
    ui.chatInput.value = event.text;
    activeExample = null;
    inputOrigin = event.via === 'screenshot' ? 'screenshot' : event.source;
    inputRevision = event.revision ?? null;
    invalidate();
    lastAutomatic = automatic && event.autoAnalyze !== false;
    if (!event.text.trim()) return feedback(event.source === 'wechat' ? '等待微信中的对话。' : '剪贴板里还没有文字。');
    if (state.backend === 'demo') feedback('文字已放入。选择「Jev 云端」或「本地模型」后即可分析。');
    else if (lastAutomatic) scheduleAutomatic();
    else feedback(event.source === 'wechat' ? '对话已更新，可以重新分析。' : '文字已放入，可以分析了。');
  }

  ui.chatInput.addEventListener('input', () => {
    interactionVersion += 1;
    activeExample = null;
    inputOrigin = 'manual';
    lastAutomatic = false;
    invalidate();
  });
  ui.scenarioSelect.addEventListener('change', () => {
    interactionVersion += 1;
    activeExample = null;
    invalidate();
  });
  ui.exampleWork.addEventListener('click', () => void chooseExample('work'));
  ui.exampleLife.addEventListener('click', () => void chooseExample('life'));
  ui.exampleRomance.addEventListener('click', () => void chooseExample('romance'));
  ui.analyzeButton.addEventListener('click', () => void analyze());
  ui.saveCloud.addEventListener('click', () => void saveCloud());
  ui.draftButton.addEventListener('click', () => void checkDraft());
  ui.draftInput.addEventListener('input', () => { clearDraftResult(); renderControls(); });
  ui.draftPaste.addEventListener('click', async () => {
    try {
      const clipboard = await api.readClipboard();
      if (disposed || typeof clipboard?.text !== 'string') return;
      ui.draftInput.value = clipboard.text.slice(0, 600);
      clearDraftResult(); renderControls();
    } catch { feedback('没能读取剪贴板，可以直接在框里粘贴。', true); }
  });
  ui.draftCopy.addEventListener('click', async () => {
    try { await api.copyReply(ui.draftSuggestionText.textContent); ui.announcement.textContent = '已复制改好的回复。'; ui.draftCopy.querySelector('span').textContent = '已复制'; }
    catch { feedback('没能复制成功，请再点一次。', true); }
  });
  ui.testCloud.addEventListener('click', () => void testCloud());
  for (const id of ['judgeProvider', 'replyProvider']) ui[id].addEventListener('change', () => {
    ui[id === 'judgeProvider' ? 'judgeModel' : 'replyModel'].value = '';
    renderControls();
  });
  ui.checkConnection.addEventListener('click', () => void checkHealth());
  ui.expandButton.addEventListener('click', () => void changeState('setMode', 'expanded'));
  ui.collapseButton.addEventListener('click', () => {
    interactionVersion += 1;
    if (busy) invalidate();
    void changeState('setMode', 'collapsed');
  });
  ui.placeTop.addEventListener('click', () => void changeState('setPlacement', 'top'));
  ui.placeRight.addEventListener('click', () => void changeState('setPlacement', 'right'));
  ui.sourceSelect.addEventListener('change', () => void changeState('setSource', ui.sourceSelect.value));
  ui.switchToClipboard.addEventListener('click', () => void changeState('setSource', 'clipboard'));
  for (const [source, id] of Object.entries(SOURCES)) {
    ui[id].addEventListener('click', () => { if (state.source !== source) void changeState('setSource', source); });
  }
  for (const [id, kind] of [['sourcePermission', 'screen'], ['fillPermission', 'accessibility'], ['screenGrant', 'screen'], ['axGrant', 'accessibility']]) {
    ui[id].addEventListener('click', () => void requestPermission(kind));
  }
  ui.guideDismiss.addEventListener('click', () => { guideDismissed = true; clearTimeout(permissionTimer); renderPermissions(); });
  ui.guideRelaunch.addEventListener('click', async () => {
    try { await api.relaunch(); } catch { feedback('没能自动重启，请退出言外后重新打开。', true); }
  });
  for (const [backend, id] of Object.entries(BACKENDS)) {
    ui[id].addEventListener('click', () => {
      if (state.backend === backend) return;
      interactionVersion += 1;
      invalidate();
      void changeState('setBackend', backend);
    });
  }
  ui.pasteButton.addEventListener('click', async () => {
    if (state.source !== 'manual' && !await changeState('setSource', 'manual')) return;
    const interaction = ++interactionVersion;
    try {
      const clipboard = await api.readClipboard();
      if (disposed || interaction !== interactionVersion) return;
      if (!clipboard || typeof clipboard.text !== 'string') throw new Error('Invalid clipboard');
      acceptInput({ text: clipboard.text, source: 'clipboard' }, false);
    } catch {
      if (!disposed && interaction === interactionVersion) feedback('没能读取剪贴板。可以直接在输入框中粘贴。', true);
    }
  });
  ui.quitButton.addEventListener('click', async () => {
    try { await api.quit(); }
    catch { feedback('暂时无法退出，请再试一次。', true); }
  });

  function subscribe(method, callback) {
    // Subscription methods normally return a function; accept a Promise of it as well.
    Promise.resolve(api[method](callback)).then((unsubscribe) => {
      if (typeof unsubscribe !== 'function') throw new Error('Invalid subscription');
      if (disposed) unsubscribe();
      else unsubscribers.push(unsubscribe);
    }).catch(() => {
      if (!disposed) feedback('状态同步暂时不可用，请重新打开面板。', true);
    });
  }

  async function initialize() {
    ui.chatInput.value = EXAMPLES.work;
    renderControls();
    const methods = ['getState', 'setMode', 'setPlacement', 'setSource', 'setBackend', 'fillReply', 'openPermission',
      'readClipboard', 'copyReply', 'quit', 'analyze', 'getLocalHealth', 'getCloud', 'saveCloud', 'testCloud', 'checkDraft', 'getPermissions', 'requestPermission', 'relaunch', 'onState', 'onText'];
    if (!api || methods.some((method) => typeof api[method] !== 'function')) {
      showPlaceholder('等待言外连接', '从言外桌面窗口打开，即可体验模拟示例。');
      feedback('桌面连接暂时不可用，请重新打开言外。', true);
      return;
    }
    try {
      subscribe('onState', (next) => {
        if (disposed) return;
        stateEventVersion += 1;
        try { applyState(next); }
        catch { feedback('暂时无法同步窗口状态，请重试。', true); }
      });
      if (typeof api.onGuide === 'function') subscribe('onGuide', () => { if (!disposed) showGuide(); });
      subscribe('onText', (event) => {
        if (!disposed && ready && event && ['clipboard', 'wechat'].includes(event.source) && state.source === event.source && typeof event.text === 'string') {
          acceptInput(event, true);
        }
      });
      const observed = stateEventVersion;
      const initialPayload = await api.getState();
      if (initialPayload.examples && typeof initialPayload.examples.work?.text === 'string' && typeof initialPayload.examples.life?.text === 'string') {
        EXAMPLES = Object.freeze({ ...EXAMPLES, ...Object.fromEntries(Object.entries(initialPayload.examples)
          .filter(([, value]) => typeof value?.text === 'string').map(([key, value]) => [key, value.text])) });
      }
      const initialState = validateState(initialPayload);
      if (disposed) return;
      if (observed === stateEventVersion) applyState(initialState);
      try { cloud = await api.getCloud(); } catch { cloud = null; }
      ready = true;
      renderControls();
      void refreshPermissions();
      if (state.backend === 'demo') await chooseExample('work');
      else {
        // A configured user starts on their own conversation, not a fixture.
        ui.chatInput.value = ''; activeExample = null; inputOrigin = 'manual';
        invalidate();
      }
    } catch {
      showPlaceholder('暂时没有连接上言外', '请重新打开面板，再试一次。');
      feedback('无法读取窗口状态，请重新打开言外。', true);
    }
  }

  window.addEventListener('beforeunload', () => {
    disposed = true;
    analysisVersion += 1;
    healthVersion += 1;
    clearTimeout(clipboardTimer);
    clearTimeout(permissionTimer);
    for (const unsubscribe of unsubscribers) {
      try { unsubscribe(); } catch { /* The window is already closing. */ }
    }
  });
  void initialize();
})();
