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
    assert.equal(r.host.extensionSettings.anchor_memory.settingsVersion, '1.1.4-rp.5');
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
  r.context.messages = [{ role: 'system' }, { role: 'assistant', tool_calls: [{}] }, { role: 'tool' }, { role: 'system' }];
  assert.equal(r.run('resolvePromptInsertIndex(messages)'), 3);
  assert.equal(r.run("resolvePromptInsertIndex([{ role: 'system' }])"), 1);
  assert.equal(r.run('resolvePromptInsertIndex([])'), 0);
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
