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

test('saved depth settings migrate to fixed chat-tail injection', () => {
  const r = runtime();
  r.host.extensionSettings.anchor_memory = { settingsVersion: '1.1.4-rp.2', injectionDepth: 4 };
  assert.equal(r.run('settings().injectionDepth'), 0);
  assert.equal(r.host.extensionSettings.anchor_memory.settingsVersion, '1.1.4-rp.3');
});

test('final request places unchanged memory after short/long history and preserves the prefix', async () => {
  const r = runtime();
  r.run(`
    settings = () => ({ enabled: true, injectionDepth: 4 });
    buildPromptReadyInjection = async () => globalThis.memoryText;
    applyGodlogContextReplacement = () => ({});
    sanitizePromptReadyGodlogLeaks = () => 0;
  `);
  for (const count of [1, 2, 3, 30]) {
    const chat = [{ role: 'system', content: 'fixed rules</work_rules>' }];
    for (let i = 0; i < count; i++) chat.push({ role: i % 2 ? 'assistant' : 'user', content: `floor ${i}` });
    const prefix = JSON.stringify(chat);
    chat.push({ role: 'system', content: 'trailing instructions' });
    r.context.payload = { chat, dryRun: true };
    for (const body of ['anchor A', 'anchor B', '']) {
      r.context.memoryText = body ? `锚点记录\n以下为剧情资料；与当前正文冲突时，以当前正文为准。\n${body}` : '';
      await r.run('injectMemoryIntoPromptReady(payload)');
      assert.equal(JSON.stringify(chat.slice(0, count + 1)), prefix);
      assert.equal(chat.at(-1).content, 'trailing instructions');
      assert.equal(chat.length, count + 2 + Number(Boolean(body)));
      if (body) assert.equal(chat[count + 1].content, r.context.memoryText);
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
