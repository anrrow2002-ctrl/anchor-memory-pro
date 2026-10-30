import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const imports = {};
for (const [, path] of source.matchAll(/from '(\.\/core\/[^']+)'/g)) {
  Object.assign(imports, await import(new URL(`../${path}`, import.meta.url)));
}
const executable = source
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*'[^']+';/g, '')
  .replaceAll('import.meta.url', JSON.stringify(new URL('../index.js', import.meta.url).href))
  .replace('export async function onActivate', 'async function onActivate')
  .replace(/\nscheduleBootstrap\(\);\s*$/, '');

function runtime() {
  const calls = { timers: new Map(), prompts: [], warnings: [], queued: [] };
  const host = { extensionSettings: {}, chat: [], saveSettingsDebounced() {} };
  let clock = 1_000_000;
  let timerId = 0;
  class TestDate extends Date { static now() { return clock; } }
  const context = vm.createContext({
    ...imports, console, window: {}, AbortController, URL,
    Date: TestDate,
    SillyTavern: { getContext: () => host },
    toastr: { warning: (...args) => calls.warnings.push(args) },
    setTimeout(fn, delay) { calls.timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout(id) { calls.timers.delete(id); },
  });
  vm.runInContext(executable, context, { filename: 'index.js' });
  return {
    context, host, calls,
    run: code => vm.runInContext(code, context),
    advance: ms => { clock += ms; },
  };
}

function withRow() {
  const r = runtime();
  r.run(`
    globalThis.row = { key: 'ai-1', index: 1, role: 'assistant', rawHash: 'hash-1' };
    latestAssistantRow = () => row;
    observeLatestAssistantRow = () => row;
    rowByStableKey = () => row;
    chatRows = () => [row];
    settings = () => ({ enabled: true });
    queueMemoryJob = source => globalThis.queued.push(source);
    globalThis.queued = [];
  `);
  return r;
}

test('saved depth settings, including rp.3 tail settings, migrate to depth four', () => {
  for (const [version, depth] of [['1.1.4-rp.2', 4], ['1.1.4-rp.3', 0]]) {
    const r = runtime();
    r.host.extensionSettings.anchor_memory = { settingsVersion: version, injectionDepth: depth };
    assert.equal(r.run('settings().injectionDepth'), 4);
    assert.equal(r.host.extensionSettings.anchor_memory.settingsVersion, '1.1.4-rp.6');
  }
  assert.equal(runtime().run('settings().injectionDepth'), 4);
});

test('final request uses depth four, preserves content/order and never joins the system prefix', async () => {
  const r = runtime();
  r.run(`
    settings = () => ({ enabled: true, injectionDepth: 4 });
    buildPromptReadyInjection = async () => globalThis.memoryText;
    applyGodlogContextReplacement = () => ({});
    sanitizePromptReadyGodlogLeaks = () => 0;
  `);
  for (const count of [1, 2, 3, 4, 5, 6, 30]) {
    const chat = [{ role: 'system', content: 'fixed rules</work_rules>' }];
    for (let i = 0; i < count; i++) chat.push({ role: i % 2 ? 'assistant' : 'user', content: `floor ${i}` });
    chat.push({ role: 'system', content: 'trailing instructions' });
    r.host.chat = chat.slice(1, -1).map(message => ({ mes: message.content, is_user: message.role === 'user' }));
    const original = JSON.stringify(chat);
    const slot = Math.max(2, count - 4 + 1);
    const prefix = JSON.stringify(chat.slice(0, slot));
    r.context.payload = { chat, dryRun: true };
    for (const body of ['anchor A', 'anchor B', '']) {
      r.context.memoryText = body ? `锚点记录\n以下为剧情资料；与当前正文冲突时，以当前正文为准。\n${body}` : '';
      await r.run('injectMemoryIntoPromptReady(payload)');
      assert.equal(JSON.stringify(chat.slice(0, slot)), prefix);
      assert.equal(chat.at(-1).content, 'trailing instructions');
      assert.equal(chat.length, count + 2 + Number(Boolean(body)));
      if (body) {
        assert.equal(chat[slot].content, r.context.memoryText);
        assert.equal(JSON.stringify(chat.filter((_, index) => index !== slot)), original);
        if (count > 4) assert.equal(chat.slice(slot + 1).filter(m => ['user', 'assistant'].includes(m.role)).length, 4);
      } else assert.equal(JSON.stringify(chat), original);
    }
  }
});

test('tool results stay together and system-only requests append memory', () => {
  const r = runtime();
  r.host.chat = [{ mes: 'I need to query both synthetic tools.', is_user: false }];
  r.context.messages = [{ role: 'system' }, { role: 'assistant', content: r.host.chat[0].mes, tool_calls: [{ id: 'one' }, { id: 'two' }] }, { role: 'tool', tool_call_id: 'one' }, { role: 'tool', tool_call_id: 'two' }, { role: 'system' }];
  assert.equal(r.run('resolvePromptInsertIndex(messages)'), 4);
  assert.equal(r.run("resolvePromptInsertIndex([{ role: 'system' }])"), 1);
  assert.equal(r.run('resolvePromptInsertIndex([])'), 0);
});

function syntheticHistory(count, offset = 0) {
  return Array.from({ length: count }, (_, index) => ({
    role: (index + offset) % 2 ? 'assistant' : 'user',
    content: `Real source floor ${index + offset}: the traveler records a distinct synthetic observation for this turn.`,
  }));
}

function setSourceHistory(r, history) {
  r.host.chat = history.map(message => ({ mes: message.content, is_user: message.role === 'user' }));
}

function presetRequest(history) {
  const before = [
    { role: 'system', content: 'fixed leading rules' },
    { role: 'assistant', content: 'preset assistant acknowledgement; this is not a real floor' },
    { role: 'system', content: `STATIC_START\n${'unchanged character and writing rules\n'.repeat(350)}STATIC_END` },
    { role: 'system', content: '[Start Test chat]' },
  ];
  const after = [
    { role: 'system', content: 'fixed trailing instructions' },
    { role: 'assistant', content: 'preset assistant prefill; this is not a real floor' },
    { role: 'user', content: 'preset user instruction; this is not a real floor' },
  ];
  return { before, after, chat: [...before, ...history, ...after] };
}

function configureChatBoundary(r) {
  r.host.chatCompletionSettings = { new_chat_prompt: '[Start {{char}} chat]' };
  r.host.substituteParams = text => String(text).replaceAll('{{char}}', 'Test');
}

function insertionIndex(r, messages) {
  r.context.messages = messages;
  return r.run('resolvePromptInsertIndex(messages)');
}

test('D4 ignores front and trailing preset roles in short and long real histories', () => {
  for (const count of [1, 2, 3, 4, 5, 8, 30]) {
    const r = runtime();
    const history = syntheticHistory(count);
    setSourceHistory(r, history);
    configureChatBoundary(r);
    const fixture = presetRequest(history);
    const expected = fixture.before.length + Math.max(1, count - 4);
    const actual = insertionIndex(r, fixture.chat);
    assert.equal(actual, expected, `real history length ${count}`);
    assert.equal(JSON.stringify(fixture.chat.slice(0, fixture.before.length)), JSON.stringify(fixture.before));
    assert.equal(fixture.chat.slice(actual).filter(message => history.includes(message)).length, Math.min(4, count - 1));
  }
});

test('D4 follows only source rows surviving pruning and excludes repeated example floors', () => {
  const r = runtime();
  const allHistory = syntheticHistory(10);
  setSourceHistory(r, allHistory);
  configureChatBoundary(r);
  const surviving = allHistory.slice(-2);
  const fixture = presetRequest(surviving);
  fixture.chat.splice(1, 0, { ...surviving[0] }, { ...surviving[1] });
  assert.equal(insertionIndex(r, fixture.chat), fixture.before.length + 2 + 1);
});

test('D4 recognizes a substituted group-chat boundary before duplicate real-floor examples', () => {
  const r = runtime();
  const history = syntheticHistory(5);
  setSourceHistory(r, history);
  r.host.chatCompletionSettings = { new_group_chat_prompt: '[Start {{char}} group chat]' };
  r.host.substituteParams = text => String(text).replaceAll('{{char}}', 'Test');
  const fixture = presetRequest(history);
  fixture.chat[fixture.before.length - 1] = { role: 'system', content: '[Start Test group chat]' };
  fixture.chat.splice(1, 0, ...history.map(message => ({ ...message })));
  assert.equal(insertionIndex(r, fixture.chat), fixture.before.length + history.length + 1);
});

test('D4 matches real history before a trailing last-user macro duplicate', () => {
  const r = runtime();
  const history = syntheticHistory(7);
  setSourceHistory(r, history);
  configureChatBoundary(r);
  const fixture = presetRequest(history);
  fixture.chat[fixture.chat.length - 1] = { ...history.at(-1) };
  assert.equal(insertionIndex(r, fixture.chat), fixture.before.length + 3);
});

test('D4 chooses a wrapped real user before an exact trailing macro duplicate', () => {
  const r = runtime();
  const history = syntheticHistory(1);
  setSourceHistory(r, history);
  configureChatBoundary(r);
  const fixture = presetRequest([{ ...history[0], content: `<user_input>\n${history[0].content}\n</user_input>` }]);
  fixture.chat[fixture.chat.length - 1] = { ...history[0] };
  assert.equal(insertionIndex(r, fixture.chat), fixture.before.length + 1);
});

test('D4 supports wrapped and multipart text without counting wrapper instructions as floors', () => {
  const r = runtime();
  const history = syntheticHistory(6);
  setSourceHistory(r, history);
  configureChatBoundary(r);
  const wrapped = history.map((message, index) => ({
    role: message.role,
    content: index % 2
      ? [{ type: 'text', text: '<reply>\n' }, { type: 'text', text: message.content }, { type: 'text', text: '\n</reply>' }]
      : `<input>\n${message.content}\n</input>`,
  }));
  const fixture = presetRequest(wrapped);
  assert.equal(insertionIndex(r, fixture.chat), fixture.before.length + 2);
});

test('history boundary detection does not reroll random or variable-writing macros', () => {
  const r = runtime();
  const history = syntheticHistory(1);
  setSourceHistory(r, history);
  r.host.chatCompletionSettings = {
    new_chat_prompt: '[{{random::first::second}}]',
    new_group_chat_prompt: '{{setvar::marker::changed}}',
  };
  let substitutions = 0;
  r.host.substituteParams = () => { substitutions++; throw new Error('must not rerun dynamic macros'); };
  const fixture = presetRequest(history);
  assert.equal(insertionIndex(r, fixture.chat), fixture.before.length + 1);
  assert.equal(substitutions, 0);
});

test('unmatched source histories safely append after all static and preset messages', () => {
  const r = runtime();
  setSourceHistory(r, syntheticHistory(4));
  const messages = [
    { role: 'system', content: 'fixed leading rules' },
    { role: 'assistant', content: 'only a preset, no real source text' },
    { role: 'system', content: 'a long static block that must never follow dynamic memory' },
    { role: 'user', content: 'another preset, not a real user floor' },
    { role: 'system', content: 'trailing static instructions' },
  ];
  assert.equal(insertionIndex(r, messages), messages.length);
  assert.equal(insertionIndex(r, messages.slice(0, 3)), 3);
  assert.equal(insertionIndex(r, [{ role: 'system', content: 'system-only request' }]), 1);
});

// The ordinary-text part of ST's strict converter merges same-role neighbors, converts
// mid-prompt system to user, inserts its required first-user placeholder, then merges again.
function strictTextRequest(messages) {
  const merge = input => input.reduce((result, message) => {
    const next = { role: message.role, content: String(message.content || '') };
    if (result.at(-1)?.role === next.role) result.at(-1).content += `\n\n${next.content}`;
    else result.push(next);
    return result;
  }, []);
  const converted = merge(messages).map((message, index) => ({
    ...message, role: index > 0 && message.role === 'system' ? 'user' : message.role,
  }));
  if (converted[0]?.role === 'system' && converted[1]?.role !== 'user') {
    converted.splice(1, 0, { role: 'user', content: '[Start a new chat]' });
  } else if (converted.length && !['system', 'user'].includes(converted[0].role)) {
    converted.unshift({ role: 'user', content: '[Start a new chat]' });
  }
  return merge(converted);
}

test('D4 keeps both memory revisions after the static prefix even after strict processing', async () => {
  for (const count of [1, 2, 8]) {
    const r = runtime();
    const history = syntheticHistory(count);
    setSourceHistory(r, history);
    configureChatBoundary(r);
    r.run(`
      settings = () => ({ enabled: true, injectionDepth: 4 });
      buildPromptReadyInjection = async () => globalThis.memoryText;
      applyGodlogContextReplacement = () => ({});
      sanitizePromptReadyGodlogLeaks = () => 0;
    `);
    const fixture = presetRequest(history);
    const initial = JSON.stringify(fixture.chat);
    const prefixes = [];
    r.context.payload = { chat: fixture.chat, dryRun: true };
    for (const revision of ['MEMORY_STATE_A', 'MEMORY_STATE_B']) {
      r.context.memoryText = `锚点记录\n以下为剧情资料；与当前正文冲突时，以当前正文为准。\n${revision}`;
      await r.run('injectMemoryIntoPromptReady(payload)');
      const memoryIndex = fixture.chat.findIndex(message => message.content === r.context.memoryText);
      assert.equal(memoryIndex, fixture.before.length + Math.max(1, count - 4));
      assert.equal(JSON.stringify(fixture.chat.filter((_, index) => index !== memoryIndex)), initial);
      const outgoing = strictTextRequest(fixture.chat).map(message => `[${message.role}]\n${message.content}`).join('\n\n');
      const boundary = outgoing.indexOf('[Start Test chat]') + '[Start Test chat]'.length;
      assert.ok(outgoing.indexOf('STATIC_END') < outgoing.indexOf('锚点记录'));
      assert.ok(outgoing.indexOf('锚点记录') >= boundary);
      prefixes.push(outgoing.slice(0, boundary));
    }
    assert.equal(prefixes[0], prefixes[1]);
  }
});

test('extension-prompt fallback uses depth zero without changing memory text', async () => {
  const r = runtime();
  r.host.setExtensionPrompt = (...args) => r.calls.prompts.push(args);
  r.run(`settings = () => ({ enabled: true, injectionDepth: 4 }); memoryData = () => ({}); buildPromptReadyInjection = async () => 'unchanged memory';`);
  await r.run('injectMemory([])');
  assert.equal(r.calls.prompts[0][1], 'unchanged memory');
  assert.equal(r.calls.prompts[0][2], 1);
  assert.equal(r.calls.prompts[0][3], 0);
});

test('slow generation stays locked beyond 30 seconds and long token gaps', () => {
  const r = withRow();
  r.run('state.generationLifecycleActive = true; state.generationStartedAt = Date.now();');
  r.advance(240_000);
  assert.equal(r.run('generationIsActiveForGodlog(row)'), true);
  assert.equal(r.run('isRowSettledForGodlog(row)'), false);
  r.run("scheduleMemoryAfterSettle('rendered', row)");
  assert.equal(r.calls.timers.size, 0);
  assert.equal(r.run('queued.length'), 0);
  assert.equal(r.run("generationIsActiveForGodlog({ key: 'older' })"), false);
});

test('host boolean/function and live script state detect generation', () => {
  const r = runtime();
  r.host.isGenerating = true;
  assert.equal(r.run('isGenerationActive()'), true);
  r.host.isGenerating = () => true;
  assert.equal(r.run('isGenerationActive()'), true);
  delete r.host.isGenerating;
  r.run('legacyScriptModule = { isGenerating: () => true };');
  assert.equal(r.run('isGenerationActive()'), true);
});

test('completion/stop releases the row and schedules exactly one settled job', () => {
  for (const reason of ['AI生成结束', 'AI生成停止']) {
    const r = withRow();
    r.run(`state.generationLifecycleActive = true; syncGodlogsWithChat = () => {}; invalidateRuntimeCaches = () => {}; scheduleGodlogPanelRender = () => {};`);
    r.context.reason = reason;
    r.run('onGenerationFinished(reason)');
    assert.equal(r.run('generationIsActiveForGodlog(row)'), false);
    assert.equal(r.calls.timers.size, 1);
    const timer = [...r.calls.timers.values()][0];
    timer.fn();
    assert.equal(r.run('queued.length'), 1);
  }
});

test('unfinished row cannot become anchor material even with an old ready summary', () => {
  const r = withRow();
  r.run(`state.generationLifecycleActive = true; godlogForRow = () => ({ status: 'ready', body: 'old summary' }); isGodlogReady = () => true;`);
  assert.equal(r.run('anchorMaterialForRow({}, row)'), null);
});

test('unfinished/settling rows do not warn; completed failures warn once across source revisions', () => {
  const r = withRow();
  r.run(`
    globalThis.item = { status: 'failed', retryCount: 3, error: 'old error' };
    godlogForRow = () => item; isGodlogReady = () => false;
    secondaryConfigured = () => true;
    state.generationLifecycleActive = true;
  `);
  r.run('maybeWarnMissingGodlogs({})');
  assert.equal(r.calls.warnings.length, 0);
  r.run('state.generationLifecycleActive = false; noteRowRevision(row, true);');
  r.run('maybeWarnMissingGodlogs({})');
  assert.equal(r.calls.warnings.length, 0);
  r.advance(3000);
  r.run('maybeWarnMissingGodlogs({})');
  assert.equal(r.calls.warnings.length, 1);
  r.run("row.rawHash = 'hash-2'; maybeWarnMissingGodlogs({});");
  assert.equal(r.calls.warnings.length, 1);
});

test('committed messages recover a missed end event only when the host is explicitly idle', () => {
  for (const hostState of [false, true, undefined]) {
    const r = withRow();
    if (hostState !== undefined) r.host.isGenerating = hostState;
    r.run(`state.generationLifecycleActive = true; invalidateRuntimeCaches = () => {};`);
    r.run("onMessageReceived(1, 'normal')");
    assert.equal(r.run('state.generationLifecycleActive'), hostState !== false);
    assert.equal(r.calls.timers.size, hostState === false ? 1 : 0);
  }
});

test('quiet and impersonation callbacks do not release visible generation', () => {
  const r = withRow();
  r.host.isGenerating = false;
  r.run('state.generationLifecycleActive = true;');
  r.run("onMessageReceived(1, 'quiet'); onMessageReceived(1, 'impersonate');");
  assert.equal(r.run('state.generationLifecycleActive'), true);
  assert.equal(r.calls.timers.size, 0);
});

test('Chat Completion injects once at depth four after system squashing, with no early copy', async () => {
  const r = runtime();
  r.host.mainApi = 'openai';
  r.host.setExtensionPrompt = (...args) => r.calls.prompts.push(args);
  r.run(`
    event_types = { CHAT_COMPLETION_PROMPT_READY: 'prompt-ready' };
    settings = () => ({ enabled: true, injectionDepth: 4 });
    globalThis.data = { processing: {} };
    memoryData = () => data;
    buildPromptReadyInjection = async () => '锚点记录\\n以下为剧情资料；与当前正文冲突时，以当前正文为准。\\nunchanged memory';
    applyGodlogContextReplacement = () => ({});
    sanitizePromptReadyGodlogLeaks = () => 0;
    markDynamicRecallInjected = () => {};
    rememberPromptInjectionForNextMessage = () => ({ refs: [] });
    pendingGodlogRows = () => [];
    saveMemory = () => {};
    refreshCommittedRecallUi = () => {};
  `);
  await r.run('injectMemory([])');
  assert.equal(r.calls.prompts[0][1], '');
  const chat = [{ role: 'system', content: 'already squashed static rules</work_rules>' }];
  for (let i = 0; i < 6; i++) chat.push({ role: i % 2 ? 'user' : 'assistant', content: `floor ${i}` });
  chat.push({ role: 'system', content: 'trailing rules' });
  r.host.chat = chat.slice(1, -1).map(message => ({ mes: message.content, is_user: message.role === 'user' }));
  r.context.payload = { chat, dryRun: false };
  await r.run('injectMemoryIntoPromptReady(payload)');
  assert.equal(chat[0].content, 'already squashed static rules</work_rules>');
  assert.equal(chat[3].content, '锚点记录\n以下为剧情资料；与当前正文冲突时，以当前正文为准。\nunchanged memory');
  assert.equal(chat.filter(m => m.content.startsWith('锚点记录')).length, 1);
  assert.equal(chat.at(-1).content, 'trailing rules');
});

test('a live visible stream wins over an idle host flag and an early end event', () => {
  const r = withRow();
  r.host.isGenerating = false;
  r.host.streamingProcessor = { type: 'normal', isFinished: false, isStopped: false };
  r.run(`state.generationLifecycleActive = true; syncGodlogsWithChat = () => {}; invalidateRuntimeCaches = () => {}; scheduleGodlogPanelRender = () => {};`);
  r.run("onGenerationFinished('premature end'); onMessageReceived(1, 'normal');");
  assert.equal(r.run('generationIsActiveForGodlog(row)'), true);
  assert.equal(r.run('state.finalizedRowHashes.has(row.key)'), false);
  assert.equal(r.calls.timers.size, 0);
  r.host.streamingProcessor.isFinished = true;
  r.run("onGenerationFinished('actual end')");
  assert.equal(r.run('generationIsActiveForGodlog(row)'), false);
  assert.equal(r.calls.timers.size, 1);
});

test('quiet streams do not block a completed visible message', () => {
  const r = runtime();
  r.host.isGenerating = false;
  r.host.streamingProcessor = { type: 'quiet', isFinished: false, isStopped: false };
  assert.equal(r.run('hostGenerationState()'), false);
});

test('unfinished rows never enter the running-task registry, including manual reruns', async () => {
  for (const force of [false, true]) {
    const r = withRow();
    r.run(`
      hasPersistentChatContext = () => true;
      state.generationLifecycleActive = true;
      globalThis.started = 0;
      generateGodlogForRowUnlocked = async () => { started++; return false; };
      scheduleGodlogPanelRender = () => {};
    `);
    r.context.force = force;
    const task = r.run('generateGodlogForRow(row, force)');
    assert.equal(r.run('state.summaryTasks.size'), 0);
    assert.equal(r.run('started'), 0);
    await task;
    assert.equal(r.run('state.forcedSummaryReruns.has(row.key)'), force);
    assert.equal(r.calls.timers.size, 0);
  }
});

function panelRuntime() {
  const r = withRow();
  const dom = { inserted: 0, removed: 0 };
  const panel = { dataset: {}, classList: { contains: () => false }, remove() { dom.removed++; } };
  const text = { insertAdjacentHTML() { dom.inserted++; } };
  const element = { querySelector(selector) { return selector === '.mes_text' ? text : panel; } };
  r.context.document = { querySelector: () => element };
  r.host.chat = [null, { mes: 'AI response', is_user: false }];
  r.run(`
    stripGodlogFromMessageRecord = () => false;
    sanitizeLeakedGodlogDom = () => false;
    renderInjectionBadgeForIndex = () => true;
    globalThis.item = { key: row.key, status: 'pending', retryScheduledAt: Date.now() + 60000, error: 'old timeout' };
    godlogForRow = () => item;
    globalThis.prepared = { data: {}, rowsByIndex: new Map([[row.index, row]]) };
    messageGodlogSummary = () => 'summary running'; messageGodlogBody = () => 'old timeout';
    godlogStatusLabel = () => 'pending'; rememberMessageGodlogCard = () => false;
  `);
  return { ...r, dom };
}

test('existing pending/failed/ready summary cards stay hidden until the source completes', () => {
  for (const status of ['pending', 'failed', 'ready', 'stale']) {
    const r = panelRuntime();
    r.context.status = status;
    r.run(`item.status = status; state.generationLifecycleActive = true; state.forcedSummaryReruns.add(row.key);`);
    assert.equal(r.run('renderGodlogPanelForIndex(row.index, prepared)'), true);
    assert.equal(r.dom.inserted, 0);
    assert.equal(r.dom.removed, 1);
  }
});

test('summary card also waits for source settling, then appears after completion', () => {
  const r = panelRuntime();
  r.run('noteRowRevision(row, true);');
  r.run('renderGodlogPanelForIndex(row.index, prepared)');
  assert.equal(r.dom.inserted, 0);
  r.advance(3000);
  r.run('markRowFinalizedForGodlog(row); renderGodlogPanelForIndex(row.index, prepared);');
  assert.equal(r.dom.inserted, 1);
});

test('a deferred manual request starts once only after the visible response finishes', async () => {
  const r = withRow();
  r.run(`
    hasPersistentChatContext = () => true;
    state.generationLifecycleActive = true;
    globalThis.started = 0;
    generateGodlogForRowUnlocked = async () => { started++; return true; };
    scheduleGodlogPanelRender = () => {};
    syncGodlogsWithChat = () => {};
    invalidateRuntimeCaches = () => {};
  `);
  await r.run('generateGodlogForRow(row, true)');
  assert.equal(r.run('started'), 0);
  assert.equal(r.run('state.summaryTasks.size'), 0);
  r.run("onGenerationFinished('正文完成'); onGenerationFinished('重复结束通知');");
  assert.equal(r.calls.timers.size, 1);
  [...r.calls.timers.values()][0].fn();
  await Promise.resolve();
  assert.equal(r.run('started'), 1);
  assert.equal(r.run('state.forcedSummaryReruns.has(row.key)'), false);
});
