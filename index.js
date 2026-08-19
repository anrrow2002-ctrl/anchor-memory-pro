/**
 * Anchor Memory
 * Layered anchor summaries for long-form SillyTavern RP.
 *
 * Original implementation:
 * - chat metadata stores anchors, merges, and current codex sections;
 * - extension prompts inject memory without writing world-info entries;
 * - optional secondary API and embeddings are supported.
 */

import {
  createAbortRegistry,
  estimateTextTokens,
  clampTextByTokens,
  resolveAdaptiveMemoryBudget,
  fitMemorySections,
} from './core/runtime-controls.js';
import { rebuildTimelineState } from './core/time-engine.js';
import {
  entityKey,
  buildItemLedger,
  buildSceneLedger,
  diffRemovedEntityKeys,
} from './core/entity-ledger.js';
import {
  makeStableMessageKey,
  isCompletedSummary,
  summaryRevisionHash,
  lockCompletedSummaryToSavedSnapshot,
} from './core/summary-lifecycle.js';
import {
  normalizeOpenAiCompatibleBaseUrl,
  openAiCompatibleProviderInfo,
  providerCompatibilityHint,
} from './core/provider-compat.js';

/**
 * SillyTavern compatibility layer.
 *
 * IMPORTANT: Do not statically import named exports from SillyTavern internals here.
 * ST moves exports between releases; one missing named export prevents the entire
 * ES module from evaluating, which makes both the icon and panel disappear.
 * The official global context API is preferred, with dynamic legacy imports only
 * as a fallback for older builds.
 */
let $ = globalThis.jQuery || globalThis.$;
const toastr = globalThis.toastr;

const extension_prompt_types = Object.freeze({ NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 });
const extension_prompt_roles = Object.freeze({ SYSTEM: 0, USER: 1, ASSISTANT: 2 });

let legacyScriptModule = {};
let legacyExtensionsModule = {};
let legacyGroupModule = {};
let eventSource = null;
let event_types = {};
let fallbackExtensionSettings = {};
let warnedMissingPromptApi = false;

async function loadLegacyRuntimeFallbacks() {
  // Namespace imports never fail merely because one named export moved/vanished.
  // They are only needed on old ST builds that do not expose SillyTavern.getContext().
  if (globalThis.SillyTavern?.getContext) return;
  try { legacyScriptModule = await import('../../../../script.js'); } catch (err) {
    console.warn('[AnchorMemory] legacy script.js fallback unavailable', err);
  }
  try { legacyExtensionsModule = await import('../../../extensions.js'); } catch (err) {
    console.warn('[AnchorMemory] legacy extensions.js fallback unavailable', err);
  }
  try { legacyGroupModule = await import('../../../group-chats.js'); } catch (err) {
    console.warn('[AnchorMemory] legacy group-chats.js fallback unavailable', err);
  }
}

function getContext() {
  try {
    const ctx = globalThis.SillyTavern?.getContext?.();
    if (ctx && typeof ctx === 'object') return ctx;
  } catch (err) {
    console.warn('[AnchorMemory] SillyTavern.getContext failed', err);
  }
  try {
    const ctx = legacyExtensionsModule.getContext?.();
    if (ctx && typeof ctx === 'object') return ctx;
  } catch (err) {
    console.warn('[AnchorMemory] legacy getContext failed', err);
  }
  return {};
}

function refreshRuntimeBindings() {
  const ctx = getContext();
  eventSource = ctx.eventSource || legacyScriptModule.eventSource || eventSource;
  event_types = ctx.eventTypes || ctx.event_types || legacyScriptModule.event_types || event_types || {};
}

function extensionSettingsStore() {
  const ctx = getContext();
  const store = ctx.extensionSettings || legacyExtensionsModule.extension_settings;
  if (store && typeof store === 'object') return store;
  return fallbackExtensionSettings;
}

function getRequestHeaders(...args) {
  return getContext().getRequestHeaders?.(...args)
    ?? legacyScriptModule.getRequestHeaders?.(...args)
    ?? { 'Content-Type': 'application/json' };
}

function saveSettingsDebounced(...args) {
  return getContext().saveSettingsDebounced?.(...args)
    ?? legacyScriptModule.saveSettingsDebounced?.(...args);
}

function setExtensionPrompt(...args) {
  const fn = getContext().setExtensionPrompt || legacyScriptModule.setExtensionPrompt;
  if (typeof fn === 'function') return fn(...args);
  if (!warnedMissingPromptApi) {
    warnedMissingPromptApi = true;
    console.error('[AnchorMemory] setExtensionPrompt is unavailable; memory injection is disabled until ST finishes initializing.');
  }
  return undefined;
}

function updateMessageBlock(...args) {
  return getContext().updateMessageBlock?.(...args)
    ?? legacyScriptModule.updateMessageBlock?.(...args);
}

function saveMetadataDebounced(...args) {
  return getContext().saveMetadataDebounced?.(...args)
    ?? legacyExtensionsModule.saveMetadataDebounced?.(...args);
}
saveMetadataDebounced.flush = async () => {
  const ctx = getContext();
  if (typeof ctx.saveMetadata === 'function') return await ctx.saveMetadata();
  const legacy = legacyExtensionsModule.saveMetadataDebounced;
  if (typeof legacy?.flush === 'function') return await legacy.flush();
  return undefined;
};

function isGenerationActive() {
  const ctx = getContext();
  if (typeof ctx.isGenerating === 'function') return !!ctx.isGenerating();
  if (typeof legacyScriptModule.isGenerating === 'function') return !!legacyScriptModule.isGenerating();
  return !!legacyScriptModule.is_send_press;
}


const MODULE = 'anchor_memory';
const EXTENSION_VERSION = '1.0.5';
const DATA_KEY = 'anchorMemory';
const CORE_PROMPT_KEY = 'anchor_memory_core';
const RECALL_PROMPT_KEY = 'anchor_memory_recall';
const DATA_VERSION = 13;
const RELATIONSHIP_SCHEMA_VERSION = 2;
const RELATIONSHIP_CHECKPOINT_INTERVAL = 10;
const VECTOR_DB_NAME = 'anchor-memory-vectors';
const VECTOR_DB_VERSION = 1;
const VECTOR_STORE_NAME = 'vectors';
const MESSAGE_RENDER_MARGIN_PX = 1400;
const MESSAGE_RENDER_RECENT_COUNT = 16;
const SOURCE_HASH_SCHEMA_VERSION = 4;
const GODLOG_BLOCK_RE = /\s*(?:```[a-zA-Z0-9_-]*\s*)?<Godlog>[\s\S]*?<\/Godlog>(?:\s*```)?\s*/gi;
const GODLOG_ESCAPED_BLOCK_RE = /\s*&lt;Godlog&gt;[\s\S]*?&lt;\/Godlog&gt;\s*/gi;
const GODLOG_FIELD_XML_GROUP_RE = /\s*(?:(?:<|&lt;)(?:Nub|Title|Time|Pln|Per|Cond)(?:>|&gt;)[\s\S]*?(?:<|&lt;)\/(?:Nub|Title|Time|Pln|Per|Cond)(?:>|&gt;)\s*){3,}/gi;
const FENCED_CODE_BLOCK_RE = /\s*```[a-zA-Z0-9_-]*\s*[\s\S]*?```\s*/g;
const GODLOG_FIELD_NAMES = ['Nub', 'Title', 'Time', 'Pln', 'Per', 'Cond'];
const MISSING_GODLOG_WARNING_MIN_NEWER = 2;
const MISSING_GODLOG_WARNING_COOLDOWN = 90 * 1000;
const SECONDARY_REQUEST_TIMEOUT_MS = 120 * 1000;
const CODEX_REBUILD_CHUNK_MAX_ROWS = 10;
const CODEX_REBUILD_CHUNK_MAX_CHARS = 9000;
const CODEX_REBUILD_RETRY_BASE_MS = 15 * 1000;
const CODEX_REBUILD_RETRY_MAX_MS = 10 * 60 * 1000;
// The newest assistant floor may be rendered several times while text, inline images, or
// extension-generated content is still being appended. Never summarize it until its source
// fingerprint has remained unchanged for this long.
const GODLOG_SOURCE_SETTLE_MS = 1800;
const GODLOG_POST_GENERATION_SETTLE_MS = 900;
const GODLOG_FINAL_EVENT_GRACE_MS = 70;
const ACTIVE_SUMMARY_SOURCE_LOOKUP_GRACE_MS = 8000;
const SUMMARY_AUTO_RETRY_DELAYS_MS = [2000, 5000];
const STREAM_TAIL_PROBE_MS = 240;
const PANEL_RENDER_DEBOUNCE_MS = 120;
const RELATIONSHIP_MEMORY_CHAR_BUDGET = 3600;
const RECENT_FACTS_MEMORY_CHAR_BUDGET = 3800;
const RECENT_READY_SUMMARY_TOTAL_CHAR_BUDGET = 3300;
const MISSING_RAW_FALLBACK_TOTAL_CHAR_BUDGET = 900;
const MISSING_RAW_FALLBACK_ANCHOR_TOTAL_CHAR_BUDGET = 18000;
const DYNAMIC_RECALL_MEMORY_CHAR_BUDGET = 3200;
// Remote embedding APIs can occasionally be slow. Give the semantic side of hybrid recall a short, bounded window
// before the main request is sent, then fall back to deterministic keyword recall rather than
// allowing a late network result to arrive after the model has already started responding.
const DYNAMIC_RECALL_PROMPT_WAIT_MS = 1800;
const HIGH_FLOOR_RECALL_HINT_TURNS = 100;
const BASE_SECTION_MAX_TOKENS = 11600;
const DEFAULT_ANCHOR_INTERVAL = 15;
const DEFAULT_MERGE_ANCHOR_INTERVAL = 3;

function normalizeAnchorInterval(value) {
  return Math.max(5, Math.min(80, Math.round(Number(value) || DEFAULT_ANCHOR_INTERVAL)));
}

function normalizeMergeAnchorInterval(value) {
  return Math.max(2, Math.min(20, Math.round(Number(value) || DEFAULT_MERGE_ANCHOR_INTERVAL)));
}

const DEFAULT_GODLOG_RULES = `你是长篇角色扮演的逐回合记忆记录员。你只总结“当前回合”：通常由紧邻的用户输入与随后的 AI 回复组成；若当前是首条 AI 开场楼，则只总结该 AI 回复。Godlog 仅供插件后台使用，禁止写入可见聊天正文，禁止使用 Markdown 代码块。

内容规则：
- 只记录当前回合新增、已经发生且能由原文确认的剧情事实。角色卡、世界书和上文摘要只用于确认姓名、身份、关系与语境，禁止把其中旧事件重新写进本楼。
- 全部使用第三人称。人物尽量写姓名或明确称谓，不使用“我、你、我们”等对话视角代词；性别不确定时用姓名，禁止猜测“他/她”。
- 按真实发生顺序梳理：起因或承接背景 → 具体动作与互动 → 冲突或转折 → 本回合结果及影响。不得打乱因果，不得只写氛围或空泛评价。
- 关键对话保留 1—3 句最能推动剧情、改变关系或揭示信息的原话，并明确注明说话人。没有关键对话时不要虚构。
- 心理变化只记录原文明示的内心活动，或能由明确动作、语气直接支持的转折；不得替角色补写动机、感情或未来决定。
- 回忆、梦境、假设、计划、转述、传闻必须明确标注其性质，不得当作当前现实中已经发生的事件。
- Time 必须填写剧情内时间。原文明示完整日期和时间时，写清楚年月日及准确时间；只明确到日期或时段时不得擅自补齐更精确的钟点。可从紧邻上下文确定时可合理承接；否则写“未明”。禁止使用现实日期代替剧情时间。
- Pln 填写本回合主要发生地点；发生明确转场时按先后写“地点A → 地点B”；无法判断写“未明”。
- Per 只列本回合实际出现或被明确提及的人物姓名/称谓，去重后用中文逗号分隔；不要写人物介绍、关系说明或代词。
- Title 用 8—18 个汉字概括本回合最核心事件，不使用“本楼摘要、剧情推进、日常互动”等空标题。
- Cond 写 200—350 个汉字的高密度叙事摘要。必须让未在场的读者仅凭此段就能理解本回合发生了什么，同时禁止扩写、润色原文之外的细节、预测后续或评价角色。

输出必须严格为一个完整 XML 块。六个字段缺一不可，不要添加任何前言、解释、尾注、HTML 或代码块：
<Godlog>
<Nub>照抄任务中提供的轮次序号</Nub>
<Title>8—18字小标题</Title>
<Time>剧情内时间，写清楚年月日准确时间；无法判断写“未明”</Time>
<Pln>主要地点；转场用“地点A → 地点B”；无法判断写“未明”</Pln>
<Per>本回合出现或被明确提及的人物姓名/称谓，去重后用中文逗号分隔</Per>
<Cond>200—350字高密度叙事摘要；按因果与时间顺序写清动作、转折、结果和关键原话，不得脑补</Cond>
</Godlog>`;

const DEFAULT_ANCHOR_RULES = `锚点规则：
- 本锚点只总结本批新增的逐楼摘要，不复述旧锚点，不附加人物表、物品表或场景表。
- 全部使用第三人称，只写已经发生的剧情，不预测、不评价。
- 每个事件必须保留：剧情内时间、地点、起因、人物、详细过程、重要物品、结果/影响。
- 关键原话必须保留，并明确注明“谁说了什么”。不得只写“双方交谈”“表达态度”等模糊概括。
- 不得遗漏用户未参与但已经发生的重要 NPC 事件、伏笔和关键道具。
- 时间无法判断写“未明”；禁止套用现实日期。
- 输出不得包含 HTML、代码块、人物动态表、人物库、物品表或任何额外章节。`;

const DEFAULT_CHARACTER_RULES = `人物动态演变规则：
- 只追踪以下白名单主角：{{tracked_chars}}。禁止把{{user}}写入人物纪要；{{user}}只能出现在关系描述或出场人物交集中。
- 单角色卡自动追踪当前{{char}}；群聊自动追踪当前群组成员；单卡多主角以“追踪角色名单”设置为准。
- 全部使用第三人称、全知视角；不确定性别时用角色姓名，禁止乱写“他/她”。
- 只记录已经发生的心理位移，不写预测、概率或作者点评。
- 角色卡、世界书和既有索引中的稳定身份不能被单楼情节覆盖；单楼只更新临时状态、触发事件和真实心理变化。
- 推荐结构：初始底色 / 触发冲击 / 心理挣扎 / 当前变化 / 一句话摘要。
- 只有执念、底线、信念、行为模式、关系处理方式发生真实变化时才更新；没有变化就照抄上一版。`;

const DEFAULT_PEOPLE_RULES = `出场人物数据库规则：
- 记录除追踪白名单{{tracked_chars}}以外的重要出场人物、NPC、配角，以及他们与{{tracked_chars}}、{{user}}和彼此之间的关系。
- 按首次出场或剧情重要性整理，不凭空添加未出现人物。
- 性别、人称、身份必须来自原文、角色卡或明确上下文；不确定时写“未明”，禁止瞎判。
- “首次出场/来源”只表示本索引第一次记录到该人物，不等于剧情内初次见面；除非原文明说，禁止写“初次见面/刚认识”。
- 稳定身份和既有关系优先跟随角色卡、世界书和已有索引；当前楼只补充本楼互动、状态或冲突，不能把已知身份改成“未明”。
- 固定字段：角色名 / 身份标签 / 当前状态与核心作用 / 与{{user}}的关系 / 与{{tracked_chars}}的关系。`;

const DEFAULT_ITEM_RULES = `物品、细节与内部梗规则：
- 记录会影响剧情、关系、伏笔、象征意义或反复出现的物品、细节、内部梗和关键原话。
- 普通日用品只有在改变关系、推动剧情或成为伏笔时才记录。
- 固定字段：物品/细节/内部梗 | 绑定人物 | 核心象征意义与影响。
- 输出的是完整当前表：已有条目本楼未提及时必须保留；只有原文明示其被销毁、永久失效且不再承担伏笔时才删除。
- 同一物品的简称、全称或轻微写法变化必须合并为同一行，禁止重复建项。
- 不写未发生的用途，不替模型预测未来。`;

const GODLOG_FORMAT_HELP = `<Godlog>
<Nub>照抄任务中提供的轮次序号</Nub>
<Title>8—18字小标题</Title>
<Time>剧情内时间，写清楚年月日准确时间；无法判断写“未明”</Time>
<Pln>主要地点；转场用“地点A → 地点B”；无法判断写“未明”</Pln>
<Per>本回合出现或被明确提及的人物姓名/称谓，去重后用中文逗号分隔</Per>
<Cond>200—350字高密度叙事摘要；按因果与时间顺序写清动作、转折、结果和关键原话，不得脑补</Cond>
</Godlog>`;

const LEGACY_MERGE_RULES_099 = `全量合并规则：
- 将上一次历史锚点与本周期全部新增记忆合并为一份新的累计历史锚点。
- 只输出“历史锚点简述”，按剧情时间顺序分条。
- 不得把跨度超过一个月的事件合并为单条；跨月必须拆分。
- 每条须保留完整因果链：起因 -> 核心冲突 -> 结果/影响。
- 关键转折、重要对话原话、道具与伏笔不得删除；关键对话必须注明说话人。
- 允许删除场景氛围描写、重复性日常互动、与主线无关的过渡内容。
- 全部使用第三人称，只写已经发生的剧情，不预测、不评价。
- 输出不得包含人物动态表、人物库、物品表、场景表、HTML 或代码块。`;

const DEFAULT_MERGE_RULES = `全量合并规则：
- 将上一次历史锚点与本周期新增记忆无缝合并为一份新的累计历史锚点；只输出“历史锚点简述”。
- 极致压缩 Token：优先保留核心冲突、关系阶段转变、重要决定、关键伏笔、关键道具和会影响后续理解的原话；删除氛围铺陈、重复动作、同义对话、日常过渡与无后果细节。
- 禁止按每个场景、每顿饭、每次消息或每轮对话拆成流水账。同一剧情日内、围绕同一目标/冲突连续推进的多个场景，必须合并成一条完整事件链；只有核心矛盾、关系阶段、行动目标或剧情日期发生实质变化时才另起一条。
- 上一次历史锚点属于旧历史，应进一步压缩；本周期新增事件保留更完整的动作、关键原话与结果，但仍需合并同日连续情节，避免逐楼复述。
- 按剧情时间顺序分条。不得把跨度超过一个月的事件合并为单条；跨月必须拆分。一个月以内也不能把彼此无关的主线强行合并。
- 每条必须保留完整因果链：起因 -> 核心冲突/推进 -> 结果/影响；关键对话须注明说话人，重要伏笔与道具不得因压缩而消失。
- 全部使用第三人称，只写已经发生且有依据的剧情，不预测、不评价，不分析 {{user}} 或额外输出人物动态。
- 输出严格使用 Markdown 项目符号；不得包含人物动态表、人物库、物品表、场景表、HTML、代码块或任何额外章节。`;

const ANCHOR_FORMAT_HELP = `### 第 X 次锚点记录

**本次新增锚点：**
* **[时间] - [事件名称]：** 地点；起因；人物；详细过程；重要物品；结果/影响；核心对话原话（必须注明谁说了什么）。`;

const MERGE_FORMAT_HELP = `### 第 X 次全量合并锚点

**历史锚点简述**
* **[日期/短时间段] - [合并后的主事件名称]：** 起因 -> 连续推进/核心冲突 -> 结果/影响。关键转折、伏笔、道具与必要原话保留并注明说话人。`;

const DEFAULT_SETTINGS = {
  settingsVersion: EXTENSION_VERSION,
  enabled: true,
  anchorInterval: DEFAULT_ANCHOR_INTERVAL,
  mergeAnchorInterval: DEFAULT_MERGE_ANCHOR_INTERVAL,
  keepRecent: 3,
  injectionDepth: 4,
  autoHide: true,
  useSecondary: false,
  secondaryUrl: '',
  secondaryKey: '',
  secondaryModel: '',
  secondaryModels: [],
  // Named connection presets are global plugin settings, not chat memory. They intentionally include
  // the API key because the feature exists to avoid retyping it; config export explicitly excludes them.
  secondaryPresets: [],
  activeSecondaryPresetId: '',
  // Main-model memory is deterministic by default: cumulative merge + active 15-turn anchors + subsequent per-turn summaries.
  // Dynamic recall and state tables remain optional because they can duplicate or resurrect stale facts.
  useDynamicRecall: false,
  // Tracks whether the user explicitly changed this switch. 0.9.2 resets legacy implicit defaults to strict layering once.
  dynamicRecallExplicit: false,
  // Mentioned people are injected selectively; important items are a small current-state ledger.
  recallMentionedPeople: true,
  injectImportantItems: true,
  // Legacy compatibility only. New UI no longer uses the all-or-nothing codex switch.
  injectCodex: false,
  useEmbedding: false,
  embeddingUrl: '',
  embeddingKey: '',
  embeddingModel: 'BAAI/bge-m3',
  embeddingModels: [],
  embeddingDimensions: 256,
  embeddingDimensionsMode: 'auto',
  embeddingTopK: 4,
  adaptiveTokenBudget: true,
  memoryMaxTokens: 8000,
  memoryReserveTokens: 1400,
  skipFirstGodlog: false,
  godlogRules: DEFAULT_GODLOG_RULES,
  anchorRules: DEFAULT_ANCHOR_RULES,
  mergeRules: DEFAULT_MERGE_RULES,
  characterRules: DEFAULT_CHARACTER_RULES,
  peopleRules: DEFAULT_PEOPLE_RULES,
  itemRules: DEFAULT_ITEM_RULES,
  slots: {},
};

const state = {
  contextEpoch: 0,
  pluginToggleEpoch: 0,
  queueTimer: null,
  restoreTimer: null,
  mutationTimer: null,
  running: false,
  anchorPreparing: false,
  mergeRunning: false,
  archiveRunning: false,
  summaryRunning: false,
  activeSummaryRowKey: '',
  summaryTasks: new Map(),
  summaryRetryTimers: new Map(),
  forcedSummaryReruns: new Set(),
  codexRunning: false,
  lastRecall: '',
  lastRecentFacts: '',
  lastPromptInjection: '',
  lastRecallMeta: [],
  lastRecallQuery: null,
  lastRecentFactsMeta: [],
  selectedMemoryId: '',
  selectedGodlogId: '',
  godlogPage: 0,
  godlogPageSize: 80,
  selectedRecallMessageKey: '',
  lastInjectionRefs: [],
  jobTimer: null,
  jobRunning: false,
  pendingIntervalRecheck: false,
  codexTimer: null,
  jobSources: new Set(),
  lastMissingGodlogWarningSignature: '',
  lastMissingGodlogWarningAt: 0,
  settleTimer: null, // legacy alias; per-row timers live in settleTimers
  settleTimers: new Map(),
  latestRowKey: '',
  latestRowHash: '',
  latestRowChangedAt: 0,
  generationEndedAt: 0,
  generationLifecycleActive: false,
  generationStartedAt: 0,
  rowRevisionState: new Map(),
  finalizedRowHashes: new Map(),
  chatRowsCache: new Map(),
  chatCacheRef: null,
  chatCacheLength: -1,
  chatCacheTailSignature: '',
  godlogIndexData: null,
  godlogIndexArray: null,
  godlogIndexLength: -1,
  godlogByKey: new Map(),
  visibleRenderTimer: null,
  lazyRenderBound: false,
  messageVisibilityObserver: null,
  messageVisibilityMutationObserver: null,
  messageVisibilityHost: null,
  messageVisibilityObservedElements: new WeakSet(),
  visibleMessageIndices: new Set(),
  streamProbeTimer: null,
  lastStreamTokenAt: 0,
  panelRenderTimer: null,
  panelRenderAll: false,
  panelRenderTargets: new Set(),
  panelRenderAttempt: 0,
  messageKeySaveTimer: null,
  metadataFlushTimer: null,
  metadataFlushPromise: null,
  pendingInjectionContent: '',
  vectorDbPromise: null,
  vectorCache: new Map(),
  vectorMigrationStorageIds: new Set(),
  recallPrefetchKey: '',
  recallPrefetchPromise: null,
  recallPrefetchResult: null,
  recallPrefetchAt: 0,
  recallPrefetchStatus: null,
  // The chat metadata object is normalized once per loaded chat. Most hot paths only need a stable
  // reference and must not re-run migrations, relationship-history repair and coverage rebuilds.
  memoryMetadataRef: null,
  memoryDataRef: null,
  memoryDataReady: false,
  // Keyword tokenization of historical Godlogs is immutable until that source record changes.
  // Cache by ID + body hash so prompt-time recall does not split every old summary again.
  recallTermCache: new Map(),
  requests: createAbortRegistry(),
  lastContextSize: 0,
  lastMemoryBudget: null,
  vectorStorageUnavailable: false,
  // Guards async model-list results from overwriting a connection selected or edited later.
  secondaryConfigRevision: 0,
  navbarObserver: null,
  navbarObservedHost: null,
  navbarRepairTimer: null,
  godlogCleanupEpoch: -1,
};

function settings() {
  const extension_settings = extensionSettingsStore();
  if (!extension_settings[MODULE]) {
    extension_settings[MODULE] = { ...DEFAULT_SETTINGS };
  }
  const s = extension_settings[MODULE];
  const previousSettingsVersion = String(s.settingsVersion || '');
  const hadDynamicRecallExplicit = Object.prototype.hasOwnProperty.call(s, 'dynamicRecallExplicit');
  const hadMergeAnchorInterval = Object.prototype.hasOwnProperty.call(s, 'mergeAnchorInterval');
  const legacyMergeInterval = Number(s.mergeInterval);
  let changed = false;
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (s[key] === undefined) {
      s[key] = value;
      changed = true;
    }
  }
  const normalizedSecondaryPresets = normalizeSecondaryPresetList(s.secondaryPresets);
  if (JSON.stringify(s.secondaryPresets || []) !== JSON.stringify(normalizedSecondaryPresets)) {
    s.secondaryPresets = normalizedSecondaryPresets;
    changed = true;
  }
  if (!s.secondaryPresets.some(item => item.id === String(s.activeSecondaryPresetId || ''))) {
    if (s.activeSecondaryPresetId) changed = true;
    s.activeSecondaryPresetId = '';
  }
  const normalizedAnchorInterval = normalizeAnchorInterval(s.anchorInterval);
  if (s.anchorInterval !== normalizedAnchorInterval) {
    s.anchorInterval = normalizedAnchorInterval;
    changed = true;
  }
  // 1.0.0 changes cumulative merge cadence from "AI turns" to "completed segment anchors".
  // Preserve genuinely custom legacy ratios, but convert known stock 75/100-turn defaults to the
  // new simpler default of 3 segment anchors. A legacy 45-turn value therefore becomes 3 anchors
  // when the segment interval is 15.
  if (!hadMergeAnchorInterval) {
    const migrated = Number.isFinite(legacyMergeInterval) && legacyMergeInterval > 0
      ? ([75, 100].includes(Math.round(legacyMergeInterval))
        ? DEFAULT_MERGE_ANCHOR_INTERVAL
        : Math.max(2, Math.min(20, Math.round(legacyMergeInterval / Math.max(1, normalizedAnchorInterval)))))
      : DEFAULT_MERGE_ANCHOR_INTERVAL;
    s.mergeAnchorInterval = migrated;
    changed = true;
  }
  const normalizedMergeAnchorInterval = normalizeMergeAnchorInterval(s.mergeAnchorInterval);
  if (s.mergeAnchorInterval !== normalizedMergeAnchorInterval) {
    s.mergeAnchorInterval = normalizedMergeAnchorInterval;
    changed = true;
  }
  if (Object.prototype.hasOwnProperty.call(s, 'mergeInterval')) {
    delete s.mergeInterval;
    changed = true;
  }
  if (looksLikeLegacyGodlogRules(s.godlogRules)) {
    s.godlogRules = DEFAULT_GODLOG_RULES;
    changed = true;
  }
  if (/只写在AI回复楼下|写在AI回复楼下|```xml|Markdown\s*代码块|代码块包裹/i.test(String(s.godlogRules || ''))) {
    s.godlogRules = DEFAULT_GODLOG_RULES;
    changed = true;
  }
  // Upgrade stock historical Godlog prompts, but leave genuinely customized prompts untouched.
  if (/200-350字文学摘要，必须包含剧情推进、动作、关键对话原话、心理转折；需要仔细梳理清楚本回合的详细经过/.test(String(s.godlogRules || ''))
      || (String(s.godlogRules || '').includes('你是长篇角色扮演的逐回合记忆记录员。你只总结“当前回合”')
        && String(s.godlogRules || '').includes('<Time>剧情内时间；无法判断写“未明”</Time>')
        && String(s.godlogRules || '').includes('<Cond>200—350字高密度叙事摘要</Cond>'))) {
    s.godlogRules = DEFAULT_GODLOG_RULES;
    changed = true;
  }
  if (s.skipFirstGodlog !== false) {
    s.skipFirstGodlog = false;
    changed = true;
  }
  if (previousSettingsVersion !== DEFAULT_SETTINGS.settingsVersion) {
    // 0.9.10: the old built-in merge prompt encouraged scene-by-scene lists. Upgrade only the
    // untouched stock prompt; genuinely customized prompts remain exactly as the user wrote them.
    const storedMergeRules = String(s.mergeRules || '').trim();
    const looksLikeUntouchedLegacyMergeRules = storedMergeRules === LEGACY_MERGE_RULES_099.trim()
      || (!/同一剧情日内|连续推进的多个场景|禁止按每个场景/.test(storedMergeRules)
        && /只输出[“"]历史锚点简述[”"]/.test(storedMergeRules)
        && /不得把跨度超过一个月的事件合并为单条/.test(storedMergeRules)
        && /起因\s*[-=]>\s*核心冲突\s*[-=]>\s*结果\/影响/.test(storedMergeRules));
    if (looksLikeUntouchedLegacyMergeRules) {
      s.mergeRules = DEFAULT_MERGE_RULES;
    }
    // 0.9.1 shipped keyword dynamic recall as an implicit default. 0.9.2 restores strict layered
    // input by default. Only an explicit user choice made after this migration keeps it enabled.
    if (!hadDynamicRecallExplicit && previousSettingsVersion && previousSettingsVersion !== EXTENSION_VERSION) {
      s.useDynamicRecall = false;
      s.dynamicRecallExplicit = false;
    }
    // v0.6 anchors embedded relationship/person/item tables in every 15-turn summary and merge.
    // Migrate only prompts that clearly match that legacy structure; preserve unrelated custom prompts.
    if (/人物纪要|出场人物库|重要道具、梗/.test(String(s.anchorRules || ''))) {
      s.anchorRules = DEFAULT_ANCHOR_RULES;
    }
    if (/人物纪要|出场人物库|本次新增锚点.*详细/.test(String(s.mergeRules || ''))) {
      s.mergeRules = DEFAULT_MERGE_RULES;
    }
    // Preserve user choices across upgrades. v0.7.6 replaces the old all-or-nothing
    // codex injection with selective people recall + a separate item ledger.
    if (s.recallMentionedPeople === undefined) s.recallMentionedPeople = true;
    if (s.injectImportantItems === undefined) s.injectImportantItems = true;
    s.injectCodex = false;
    s.settingsVersion = DEFAULT_SETTINGS.settingsVersion;
    changed = true;
  }
  if (changed) saveSettingsDebounced();
  return s;
}

function saveSetting(key, value) {
  settings()[key] = value;
  saveSettingsDebounced();
}

function clearInjectedPromptState() {
  setExtensionPrompt(CORE_PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0);
  setExtensionPrompt(RECALL_PROMPT_KEY, '', extension_prompt_types.IN_PROMPT, 0);
  state.lastRecall = '';
  state.lastRecallMeta = [];
  state.lastRecallQuery = null;
  state.lastRecentFacts = '';
  state.lastRecentFactsMeta = [];
  state.lastPromptInjection = '';
  state.lastInjectionRefs = [];
  state.pendingInjectionContent = '';
}

function stopRuntimeForPluginPause(reason = 'plugin-paused') {
  state.requests.abortAll(reason);
  state.contextEpoch += 1;
  if (state.queueTimer) clearTimeout(state.queueTimer);
  if (state.jobTimer) clearTimeout(state.jobTimer);
  if (state.restoreTimer) clearTimeout(state.restoreTimer);
  if (state.mutationTimer) clearTimeout(state.mutationTimer);
  if (state.streamProbeTimer) clearTimeout(state.streamProbeTimer);
  if (state.codexTimer) clearTimeout(state.codexTimer);
  clearAllSettleTimers();
  state.queueTimer = null;
  state.jobTimer = null;
  state.restoreTimer = null;
  state.mutationTimer = null;
  state.streamProbeTimer = null;
  state.codexTimer = null;
  state.running = false;
  state.anchorPreparing = false;
  state.mergeRunning = false;
  state.archiveRunning = false;
  state.summaryRunning = false;
  state.codexRunning = false;
  state.jobRunning = false;
  state.pendingIntervalRecheck = false;
  clearAllSummaryRuntimeTasks();
  state.generationLifecycleActive = false;
  state.generationStartedAt = 0;
  state.generationEndedAt = 0;
  state.jobSources.clear();
  clearRecallPrefetch();

  if (hasPersistentChatContext()) {
    const data = memoryData();
    data.processing.busy = false;
    data.processing.summaryBusy = false;
    data.processing.codexBusy = false;
    data.processing.mergeBusy = false;
    data.processing.queueRunning = false;
    data.processing.queuePending = false;
    data.processing.queueSources = [];
    data.processing.pendingPromptInjection = null;
    saveMemory(true);
  }
}

function syncPluginEnabledUi() {
  if (!$) return;
  const enabled = !!settings().enabled;
  $('#am_enabled').prop('checked', enabled);
  $('#am_master_toggle')
    .toggleClass('am-disabled', !enabled)
    .attr('aria-pressed', String(enabled))
    .attr('title', enabled
      ? '一键暂停锚点书；记忆数据和设置都会保留'
      : '一键启动锚点书并继续使用已有记忆')
    .find('span').text(enabled ? '暂停插件' : '启动插件');
  $('#am_master_state_badge').text(enabled ? '运行中' : '已暂停');
  $('#am_extension_master_toggle')
    .toggleClass('am-disabled', !enabled)
    .text(enabled ? '暂停插件' : '启动插件');
  $('.anchor-memory-settings').toggleClass('am-plugin-disabled', !enabled);
  $('#anchor_memory_nav_button')
    .toggleClass('am-disabled', !enabled)
    .attr('title', enabled ? '锚点书（运行中）' : '锚点书（已暂停，点击打开）');
}

async function setPluginEnabled(nextEnabled, options = {}) {
  const next = !!nextEnabled;
  const s = settings();
  const previous = !!s.enabled;
  const toggleEpoch = ++state.pluginToggleEpoch;
  s.enabled = next;
  saveSettingsDebounced();
  syncPluginEnabledUi();

  if (!next) {
    stopRuntimeForPluginPause('plugin-paused');
    clearInjectedPromptState();
    if (hasPersistentChatContext()) {
      await enforceAnchorHiddenState(memoryData());
      saveMemory(true);
    }
  } else {
    invalidateRuntimeCaches('plugin resumed');
    if (hasPersistentChatContext()) {
      syncGodlogsWithChat('插件重新启动');
      await enforceAnchorHiddenState(memoryData());
      if (toggleEpoch !== state.pluginToggleEpoch || !settings().enabled) return settings().enabled;
      await injectMemory(getContext().chat || []);
      if (hasPendingMemoryWork()) queueMemoryJob('插件重新启动', 120);
    }
    scheduleGodlogPanelRender();
  }

  // Ignore stale completion from a rapid double-click; the newest requested state owns the UI and toast.
  if (toggleEpoch !== state.pluginToggleEpoch || settings().enabled !== next) return settings().enabled;
  syncPluginEnabledUi();
  safeUpdatePreview(next ? '插件已启动' : '插件已暂停');
  if (options.notify !== false && previous !== next) {
    if (next) toastr?.success?.('锚点书已启动：继续注入记忆并处理后续楼层。', 'Anchor Memory');
    else toastr?.info?.('锚点书已暂停：不会注入、隐藏旧楼或调用后台API；已有记忆和设置均已保留。', 'Anchor Memory');
  }
  return next;
}

function flushDeferredIntervalRecheck() {
  if (!state.pendingIntervalRecheck) return;
  if (state.running || state.anchorPreparing || state.mergeRunning || state.archiveRunning || state.jobRunning || state.summaryRunning || state.codexRunning) return;
  state.pendingIntervalRecheck = false;
  queueMemoryJob('运行间隔调整后重新检查', 0);
}

function applyIntervalSettingChange(key, rawValue, input = null) {
  const isAnchor = key === 'anchorInterval';
  const currentSettings = settings();
  const previous = isAnchor
    ? normalizeAnchorInterval(currentSettings.anchorInterval)
    : normalizeMergeAnchorInterval(currentSettings.mergeAnchorInterval);
  const next = isAnchor ? normalizeAnchorInterval(rawValue) : normalizeMergeAnchorInterval(rawValue);
  if (input) input.value = String(next);
  if (previous === next) return;

  saveSetting(key, next);
  safeUpdatePreview('运行间隔设置已调整');
  state.pendingIntervalRecheck = true;
  flushDeferredIntervalRecheck();
  toastr?.info?.(
    isAnchor
      ? `分段锚点间隔已从 ${previous} 个AI回合调整为 ${next} 个AI回合。新值从下一批尚未处理的逐楼摘要开始生效；已生成锚点不会被拆毁。`
      : `累计历史阈值已从 ${previous} 个分段锚点调整为 ${next} 个分段锚点。之后只按“已生成的分段锚点数量”判断自动合并，不再按AI回合数凑合并边界。`,
    'Anchor Memory',
    { timeOut: 7000, extendedTimeOut: 3000, closeButton: true, tapToDismiss: true },
  );
}

function defaultData() {
  return {
    version: DATA_VERSION,
    godlogs: [],
    anchors: [],
    merges: [],
    messageGodlogs: {},
    messageRecalls: {},
    // Per-chat tracked protagonists. Empty means automatic resolution from the current single card
    // or active group members. Multi-protagonist single cards can set an explicit list in the UI.
    trackedCharacters: [],
    codex: {
      relationship: '',
      characterMemo: '',
      peopleIndex: '',
      itemIndex: '',
      sceneIndex: '',
      currentTime: '',
      currentPlace: '',
    },
    timeline: {
      currentRaw: '未明',
      currentSourceKey: '',
      currentFloor: -1,
      warnings: [],
      history: [],
      manualOverride: null,
      updatedAt: 0,
    },
    entities: {
      items: { byKey: {}, order: [], updatedAt: 0 },
      scenes: { byKey: {}, order: [], updatedAt: 0 },
      itemTombstones: {},
      sceneTombstones: {},
    },
    // Fixed-schema relationship table. Users control the row names; the background AI may only
    // update the three relationship-state columns for those existing rows.
    relationshipTable: {
      schemaVersion: RELATIONSHIP_SCHEMA_VERSION,
      rows: [],
      history: [],
      updatedAt: 0,
      lastGoodFloor: -1,
      lastGoodKey: '',
    },
    // Last known-good index snapshot. Rebuilds are transactional: the active codex is never
    // erased before a replacement has been generated and validated successfully.
    codexBackup: null,
    // Vector payloads live in IndexedDB. Chat metadata keeps only compact signatures/IDs.
    vectorRefs: {},
    // Legacy compatibility only; v0.8 migrates these records to IndexedDB and clears this object.
    vectors: {},
    processing: {
      storageId: '',
      anchoredKeys: {},
      mergedKeys: {},
      codexKeys: {},
      codexDirty: false,
      codexDirtyReason: '',
      codexDirtyAt: 0,
      codexLastGoodAt: 0,
      codexRebuildFailures: 0,
      codexRetryAt: 0,
      codexRebuildCheckpoint: null,
      codexUnsafeFromFloor: null,
      lastCodexFloor: -1,
      relationshipDirty: false,
      relationshipDirtyReason: '',
      relationshipDirtyAt: 0,
      relationshipLastGoodAt: 0,
      relationshipRebuildFailures: 0,
      sourceHashSchema: SOURCE_HASH_SCHEMA_VERSION,
      lastAnchorFloor: -1,
      lastMergeFloor: -1,
      godlogCount: 0,
      anchorCount: 0,
      mergeCount: 0,
      busy: false,
      summaryBusy: false,
      mergeBusy: false,
      codexBusy: false,
      queuePending: false,
      queueRunning: false,
      queueSources: [],
      pendingPromptInjection: null,
      lastError: '',
    },
  };
}


function clonePlainObject(value, fallback = {}) {
  try {
    return JSON.parse(JSON.stringify(value ?? fallback));
  } catch {
    return JSON.parse(JSON.stringify(fallback));
  }
}

function relationshipDefaultRow() {
  return {
    id: 'am_relationship_char',
    name: '{{char}}',
    locked: true,
    past: '',
    development: '',
    current: '',
    createdAt: Date.now(),
    updatedAt: 0,
  };
}

function relationshipRowId(seed = '') {
  return `am_relationship_${Date.now()}_${stableHash(`${seed}_${Math.random()}`).slice(0, 7)}`;
}

function cleanRelationshipCell(value, maxChars = 600) {
  return clampText(cleanText(String(value || ''))
    .replace(/\|/g, '／')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim(), maxChars)
    .replace(/\n\.\.\.\[trimmed\]$/i, '…');
}

function relationshipNameKey(value) {
  return normalizeEntityMatchText(renderMacros(String(value || '')));
}

function normalizeRelationshipTable(value, legacyMarkdown = '') {
  const source = value && typeof value === 'object' ? value : {};
  const rows = [];
  const seenIds = new Set();
  const seenNames = new Set();
  const rawRows = Array.isArray(source.rows) ? source.rows : [];

  for (let index = 0; index < rawRows.length; index++) {
    const raw = rawRows[index] || {};
    const name = cleanRelationshipCell(raw.name || raw.character || raw['名称'] || '', 120);
    if (!name) continue;
    const nameKey = relationshipNameKey(name);
    if (!nameKey || seenNames.has(nameKey)) continue;
    let id = cleanRelationshipCell(raw.id || '', 120) || relationshipRowId(`${name}_${index}`);
    while (seenIds.has(id)) id = relationshipRowId(`${name}_${index}_${id}`);
    seenIds.add(id);
    seenNames.add(nameKey);
    rows.push({
      id,
      name,
      locked: raw.locked === true,
      past: cleanRelationshipCell(raw.past ?? raw['过去'] ?? '', 520),
      development: cleanRelationshipCell(raw.development ?? raw['发展'] ?? '', 720),
      current: cleanRelationshipCell(raw.current ?? raw['当前'] ?? '', 520),
      createdAt: Number(raw.createdAt) || Date.now(),
      updatedAt: Number(raw.updatedAt) || 0,
    });
  }

  let legacyFallback = '';
  if (rows.length === 0 && legacyMarkdown) {
    const parsedLegacyRows = parseMarkdownTable(legacyMarkdown);
    for (const raw of parsedLegacyRows) {
      const name = cleanRelationshipCell(raw['名称'] || raw['角色名'] || '', 120);
      if (!name) continue;
      const nameKey = relationshipNameKey(name);
      if (!nameKey || seenNames.has(nameKey)) continue;
      seenNames.add(nameKey);
      rows.push({
        id: relationshipRowId(name),
        name,
        locked: false,
        past: cleanRelationshipCell(raw['过去'] || '', 520),
        development: cleanRelationshipCell(raw['发展'] || '', 720),
        current: cleanRelationshipCell(raw['当前'] || '', 520),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    if (parsedLegacyRows.length === 0 && usefulCodexValue(legacyMarkdown)) {
      legacyFallback = cleanRelationshipCell(legacyMarkdown, 520);
    }
  }

  const charKey = relationshipNameKey('{{char}}');
  let charRow = rows.find(row => row.id === 'am_relationship_char' || relationshipNameKey(row.name) === charKey)
    || rows.find(row => row.locked);
  if (!charRow) {
    charRow = relationshipDefaultRow();
    rows.unshift(charRow);
  } else {
    charRow.locked = true;
    // Store the primary card row as a macro so switching/restoring a chat always resolves to the
    // current SillyTavern character name rather than a stale literal copied from another chat.
    charRow.name = '{{char}}';
    const currentIndex = rows.indexOf(charRow);
    if (currentIndex > 0) {
      rows.splice(currentIndex, 1);
      rows.unshift(charRow);
    }
  }
  for (const row of rows.slice(1)) row.locked = false;
  if (legacyFallback && !usefulCodexValue(charRow.current)) {
    charRow.current = legacyFallback;
    charRow.updatedAt = Date.now();
  }

  const validIds = new Set(rows.map(row => row.id));
  const cleanStateMap = rawMap => {
    const result = {};
    const sourceMap = rawMap && typeof rawMap === 'object' ? rawMap : {};
    for (const [id, state] of Object.entries(sourceMap)) {
      if (!validIds.has(id)) continue;
      result[id] = {
        past: cleanRelationshipCell(state?.past || '', 520),
        development: cleanRelationshipCell(state?.development || '', 720),
        current: cleanRelationshipCell(state?.current || '', 520),
      };
    }
    return result;
  };
  let history = (Array.isArray(source.history) ? source.history : [])
    .map(item => {
      const kind = item?.kind === 'delta' ? 'delta' : 'checkpoint';
      const states = kind === 'checkpoint' ? cleanStateMap(item?.states) : {};
      const changes = kind === 'delta' ? cleanStateMap(item?.changes) : {};
      return {
        kind,
        sourceKey: String(item?.sourceKey || ''),
        sourceHash: String(item?.sourceHash || ''),
        floor: Number.isFinite(Number(item?.floor)) ? Number(item.floor) : -1,
        assistantNumber: Number.isFinite(Number(item?.assistantNumber)) ? Number(item.assistantNumber) : 0,
        savedAt: Number(item?.savedAt) || 0,
        ...(kind === 'checkpoint' ? { states } : { changes }),
      };
    })
    .filter(item => item.floor >= 0 && Object.keys(item.kind === 'checkpoint' ? item.states : item.changes).length > 0)
    .sort((a, b) => a.floor - b.floor || a.savedAt - b.savedAt);
  if (history.length > 1000) {
    const targetStart = history.length - 1000;
    let checkpointStart = targetStart;
    for (let index = targetStart; index >= 0; index--) {
      if (history[index]?.kind === 'checkpoint') {
        checkpointStart = index;
        break;
      }
    }
    history = history.slice(checkpointStart);
  }

  return {
    schemaVersion: RELATIONSHIP_SCHEMA_VERSION,
    rows,
    history,
    updatedAt: Number(source.updatedAt) || 0,
    lastGoodFloor: Number.isFinite(Number(source.lastGoodFloor)) ? Number(source.lastGoodFloor) : -1,
    lastGoodKey: String(source.lastGoodKey || ''),
  };
}

function relationshipTableMarkdown(value, resolved = true) {
  const table = normalizeRelationshipTable(value);
  const lines = [
    '| 名称 | 过去 | 发展 | 当前 |',
    '| :--- | :--- | :--- | :--- |',
  ];
  for (const row of table.rows) {
    const name = resolved ? renderMacros(row.name) : row.name;
    lines.push(`| ${cleanRelationshipCell(name, 120) || '未命名'} | ${cleanRelationshipCell(row.past, 520) || '未明'} | ${cleanRelationshipCell(row.development, 720) || '未明'} | ${cleanRelationshipCell(row.current, 520) || '未明'} |`);
  }
  return lines.join('\n');
}

function relationshipHasContent(value) {
  const table = normalizeRelationshipTable(value);
  return table.rows.some(row => [row.past, row.development, row.current]
    .some(cell => usefulCodexValue(cell)));
}

function relationshipSchemaOnly(value) {
  const table = normalizeRelationshipTable(value);
  return {
    ...table,
    rows: table.rows.map(row => ({ ...row, past: '', development: '', current: '', updatedAt: 0 })),
    history: [],
    updatedAt: 0,
    lastGoodFloor: -1,
    lastGoodKey: '',
  };
}

function relationshipSnapshotStates(value) {
  const table = normalizeRelationshipTable(value);
  const states = {};
  for (const row of table.rows) {
    states[row.id] = {
      past: row.past || '',
      development: row.development || '',
      current: row.current || '',
    };
  }
  return states;
}

function relationshipStateAtFloor(value, targetFloor = Number.MAX_SAFE_INTEGER) {
  const table = normalizeRelationshipTable(value);
  const floor = Number.isFinite(Number(targetFloor)) ? Number(targetFloor) : Number.MAX_SAFE_INTEGER;
  const states = {};
  for (const entry of table.history || []) {
    if (entry.floor > floor) break;
    if (entry.kind === 'checkpoint') {
      for (const id of Object.keys(states)) delete states[id];
      Object.assign(states, clonePlainObject(entry.states || {}));
      continue;
    }
    for (const [id, next] of Object.entries(entry.changes || {})) {
      states[id] = clonePlainObject(next, { past: '', development: '', current: '' });
    }
  }
  return states;
}

function relationshipStateEquals(a, b) {
  return String(a?.past || '') === String(b?.past || '')
    && String(a?.development || '') === String(b?.development || '')
    && String(a?.current || '') === String(b?.current || '');
}

function recordRelationshipSnapshot(data, row = null) {
  if (!data?.relationshipTable || !row || !Number.isInteger(Number(row.index))) return false;
  const table = normalizeRelationshipTable(data.relationshipTable, data.codex?.relationship || '');
  const currentStates = relationshipSnapshotStates(table);
  const previousStates = relationshipStateAtFloor(table, Number(row.index) - 1);
  const changes = {};
  for (const [id, next] of Object.entries(currentStates)) {
    if (!relationshipStateEquals(previousStates[id], next)) changes[id] = next;
  }

  table.history = (table.history || []).filter(item => item.sourceKey !== String(row.key || '') && item.floor !== Number(row.index));
  const hasCheckpoint = table.history.some(item => item.kind === 'checkpoint');
  const assistantNumber = Number(row.assistantNumber || 0);
  const makeCheckpoint = !hasCheckpoint
    || assistantNumber <= 1
    || (assistantNumber > 0 && assistantNumber % RELATIONSHIP_CHECKPOINT_INTERVAL === 0);
  if (makeCheckpoint || Object.keys(changes).length > 0) {
    table.history.push({
      kind: makeCheckpoint ? 'checkpoint' : 'delta',
      sourceKey: String(row.key || ''),
      sourceHash: String(row.rawHash || ''),
      floor: Number(row.index),
      assistantNumber,
      savedAt: Date.now(),
      ...(makeCheckpoint ? { states: currentStates } : { changes }),
    });
    table.history.sort((a, b) => a.floor - b.floor || a.savedAt - b.savedAt);
    if (table.history.length > 1000) {
      const targetStart = table.history.length - 1000;
      let checkpointStart = targetStart;
      for (let index = targetStart; index >= 0; index--) {
        if (table.history[index]?.kind === 'checkpoint') {
          checkpointStart = index;
          break;
        }
      }
      table.history = table.history.slice(checkpointStart);
    }
  }
  table.lastGoodFloor = Number(row.index);
  table.lastGoodKey = String(row.key || '');
  table.updatedAt = Date.now();
  data.relationshipTable = table;
  data.codex.relationship = relationshipTableMarkdown(table, false);
  return makeCheckpoint || Object.keys(changes).length > 0;
}

function rollbackRelationshipToFloor(data, targetFloor, reason = '剧情楼层回滚') {
  if (!data) return false;
  // Keep one pre-rollback safety copy. Subsequent deleted floors in the same sync pass must not
  // overwrite it with progressively older states.
  if (!data.processing?.relationshipDirty && !data.processing?.codexDirty) {
    snapshotCodex(data, `${reason}前备份`);
  }
  const table = normalizeRelationshipTable(data.relationshipTable, data.codex?.relationship || '');
  const floor = Number.isFinite(Number(targetFloor)) ? Number(targetFloor) : -1;
  const candidates = (table.history || [])
    .filter(item => item.floor <= floor)
    .sort((a, b) => b.floor - a.floor || b.savedAt - a.savedAt);
  const snapshot = candidates[0] || null;
  const states = relationshipStateAtFloor(table, floor);
  let changed = false;
  table.rows = table.rows.map(row => {
    const state = states[row.id];
    const next = {
      ...row,
      past: state?.past || '',
      development: state?.development || '',
      current: state?.current || '',
      updatedAt: snapshot?.savedAt || 0,
    };
    if (next.past !== row.past || next.development !== row.development || next.current !== row.current) changed = true;
    return next;
  });
  table.history = (table.history || []).filter(item => item.floor <= floor);
  table.lastGoodFloor = snapshot?.floor ?? -1;
  table.lastGoodKey = snapshot?.sourceKey || '';
  table.updatedAt = Date.now();
  data.relationshipTable = table;
  data.codex.relationship = relationshipTableMarkdown(table, false);
  markRelationshipDirty(data, `${reason}；关系表已回退到第 ${Math.max(0, floor)} 楼之前的最近快照，等待按当前有效剧情复核`);
  return changed || true;
}

function markRelationshipDirty(data, reason = '人物关系来源发生变化') {
  if (!data) return false;
  if (!data.processing || typeof data.processing !== 'object') data.processing = { ...defaultData().processing };
  const nextReason = String(reason || '人物关系来源发生变化');
  const changed = !data.processing.relationshipDirty || data.processing.relationshipDirtyReason !== nextReason;
  data.processing.relationshipDirty = true;
  data.processing.relationshipDirtyReason = nextReason;
  data.processing.relationshipDirtyAt = Date.now();
  return changed;
}

function clearRelationshipDirty(data) {
  if (!data?.processing) return;
  data.processing.relationshipDirty = false;
  data.processing.relationshipDirtyReason = '';
  data.processing.relationshipDirtyAt = 0;
  data.processing.relationshipLastGoodAt = Date.now();
  data.processing.relationshipRebuildFailures = 0;
}

function relationshipSection(markdown) {
  return sectionFrom(markdown, '人物关系');
}

function applyRelationshipPatch(data, markdown, row = null, options = {}) {
  if (!data) return { found: false, matched: 0, changed: false, complete: false };
  const section = relationshipSection(markdown);
  if (!section) return { found: false, matched: 0, changed: false, complete: false };
  const incoming = parseMarkdownTable(section);
  // Work on a detached candidate. An incomplete model response must never partially overwrite the
  // active fixed table.
  const table = normalizeRelationshipTable(
    clonePlainObject(data.relationshipTable),
    data.codex?.relationship || '',
  );
  const byName = new Map();
  for (const fixed of table.rows) {
    const key = relationshipNameKey(fixed.name);
    if (key) byName.set(key, fixed);
  }
  const matchedIds = new Set();
  let unexpected = 0;
  let changed = false;
  for (const raw of incoming) {
    const name = raw['名称'] || raw['角色名'] || raw['人物'] || '';
    const fixed = byName.get(relationshipNameKey(name));
    if (!fixed || matchedIds.has(fixed.id)) {
      unexpected++;
      continue;
    }
    matchedIds.add(fixed.id);
    const nextValues = {
      past: cleanRelationshipCell(raw['过去'] || raw['初始'] || '', 520),
      development: cleanRelationshipCell(raw['发展'] || raw['过程'] || '', 720),
      current: cleanRelationshipCell(raw['当前'] || raw['现状'] || '', 520),
    };
    let rowChanged = false;
    for (const key of ['past', 'development', 'current']) {
      const next = nextValues[key];
      if (!next || /^(?:无变化|不变)$/i.test(next)) continue;
      if (options.preserveKnownOnUnknown && !usefulCodexValue(next) && usefulCodexValue(fixed[key])) continue;
      if (fixed[key] !== next) {
        fixed[key] = next;
        changed = true;
        rowChanged = true;
      }
    }
    if (rowChanged) fixed.updatedAt = Date.now();
  }
  const matched = matchedIds.size;
  const complete = matched === table.rows.length && unexpected === 0;
  if (options.requireComplete && !complete) {
    return { found: true, matched, unexpected, changed: false, complete: false };
  }
  table.updatedAt = Date.now();
  data.relationshipTable = table;
  if (!data.codex || typeof data.codex !== 'object') data.codex = { ...defaultData().codex };
  data.codex.relationship = relationshipTableMarkdown(table, false);
  if (matched > 0 && options.clearDirty !== false) clearRelationshipDirty(data);
  if (row && (changed || options.recordEvenIfUnchanged)) recordRelationshipSnapshot(data, row);
  return { found: true, matched, unexpected, changed, complete };
}

function commitRelationshipReplacement(data, candidate, row = null) {
  const fixed = normalizeRelationshipTable(data.relationshipTable, data.codex?.relationship || '');
  const nextCandidate = normalizeRelationshipTable(candidate);
  const incomingByName = new Map(nextCandidate.rows.map(item => [relationshipNameKey(item.name), item]));
  let matched = 0;
  fixed.rows = fixed.rows.map(rowItem => {
    const incoming = incomingByName.get(relationshipNameKey(rowItem.name));
    if (!incoming) return { ...rowItem, past: '', development: '', current: '', updatedAt: 0 };
    matched++;
    return {
      ...rowItem,
      past: cleanRelationshipCell(incoming.past, 520),
      development: cleanRelationshipCell(incoming.development, 720),
      current: cleanRelationshipCell(incoming.current, 520),
      updatedAt: Date.now(),
    };
  });
  if (matched !== fixed.rows.length) throw new Error('人物关系表未完整返回固定名单中的全部角色，旧关系表已保留');
  fixed.history = [];
  fixed.updatedAt = Date.now();
  data.relationshipTable = fixed;
  data.codex.relationship = relationshipTableMarkdown(fixed, false);
  clearRelationshipDirty(data);
  if (row) recordRelationshipSnapshot(data, row);
  return true;
}

function normalizedCodex(value) {
  const next = { ...defaultData().codex };
  if (value && typeof value === 'object') {
    for (const key of Object.keys(next)) {
      if (value[key] !== undefined && value[key] !== null) next[key] = String(value[key]);
    }
  }
  return next;
}

function codexHasContent(value) {
  const codex = normalizedCodex(value);
  // `relationship` mirrors the separate fixed relationship table for backward compatibility.
  // Its header-only Markdown must not make an otherwise empty codex look populated.
  return Object.entries(codex)
    .filter(([key]) => key !== 'relationship')
    .some(([, entry]) => String(entry || '').trim().length > 0);
}

function codexSignature(value, relationshipTable = null) {
  const normalizedRelationship = relationshipTable ? normalizeRelationshipTable(relationshipTable) : null;
  if (normalizedRelationship) normalizedRelationship.history = [];
  return stableHash(JSON.stringify({
    codex: normalizedCodex(value),
    relationshipTable: normalizedRelationship,
  }));
}

function snapshotCodex(data, reason = '状态索引变更前备份') {
  if (!data || (!codexHasContent(data.codex) && !relationshipHasContent(data.relationshipTable))) return false;
  const signature = codexSignature(data.codex, data.relationshipTable);
  if (data.codexBackup?.signature === signature) return false;
  data.codexBackup = {
    savedAt: Date.now(),
    reason: String(reason || '状态索引变更前备份'),
    signature,
    codex: clonePlainObject(normalizedCodex(data.codex)),
    relationshipTable: (() => { const table = normalizeRelationshipTable(data.relationshipTable, data.codex?.relationship || ''); table.history = []; return clonePlainObject(table); })(),
    codexKeys: clonePlainObject(data.processing?.codexKeys || {}),
    lastCodexFloor: Number(data.processing?.lastCodexFloor ?? -1),
  };
  return true;
}

function markCodexDirty(data, reason = '剧情来源发生变化', clearKeys = true, preserveCheckpoint = false, unsafeFromFloor = null) {
  if (!data) return false;
  // A relationship rollback already stored the pre-change snapshot. Do not replace it with
  // the rolled-back state when the wider codex is marked dirty immediately afterwards.
  if (!data.processing?.relationshipDirty) snapshotCodex(data, reason);
  if (!data.processing || typeof data.processing !== 'object') data.processing = { ...defaultData().processing };
  const changed = !data.processing.codexDirty
    || data.processing.codexDirtyReason !== String(reason || '')
    || (clearKeys && Object.keys(data.processing.codexKeys || {}).length > 0);
  data.processing.codexDirty = true;
  data.processing.codexDirtyReason = String(reason || '剧情来源发生变化');
  data.processing.codexDirtyAt = Date.now();
  if (clearKeys) data.processing.codexKeys = {};
  if (unsafeFromFloor !== null && unsafeFromFloor !== '' && Number.isFinite(Number(unsafeFromFloor))) {
    const floor = Number(unsafeFromFloor);
    const current = data.processing.codexUnsafeFromFloor;
    data.processing.codexUnsafeFromFloor = current !== null && current !== '' && Number.isFinite(Number(current))
      ? Math.min(Number(current), floor)
      : floor;
  }
  if (!preserveCheckpoint) {
    data.processing.codexRebuildCheckpoint = null;
    data.processing.codexRetryAt = 0;
  }
  // IMPORTANT: Never clear data.codex here. It remains the visible last-known-good snapshot until
  // a complete replacement is generated and validated. Prompt injection reuses it only when the
  // completed-timeline guard proves that the snapshot does not extend beyond valid summaries.
  return changed;
}

function validateCodexCandidate(candidate, sourceText = '') {
  const codex = normalizedCodex(candidate);
  const substantive = ['characterMemo', 'peopleIndex', 'itemIndex', 'sceneIndex']
    .filter(key => usefulCodexSection(codex[key])).length;
  const hasClock = !!(usefulCodexValue(codex.currentTime) || usefulCodexValue(codex.currentPlace));
  if (substantive === 0 && !hasClock) return false;
  // A model occasionally echoes only headings or an empty table. Require at least one parsed row
  // when the source contains table sections, unless time/place is the only available fact.
  if (substantive > 0) {
    const rows = ['characterMemo', 'peopleIndex', 'itemIndex', 'sceneIndex']
      .flatMap(key => parseMarkdownTable(codex[key] || ''));
    if (rows.length === 0 && !hasClock) return false;
  }
  return String(sourceText || '').trim().length > 0;
}

function commitCodexReplacement(data, candidate, materials = [], reason = '人物索引安全重建') {
  const next = normalizedCodex(candidate);
  if (!validateCodexCandidate(next, JSON.stringify(next))) {
    throw new Error('副API返回的状态索引为空或格式不完整，已保留原索引');
  }
  snapshotCodex(data, reason);
  data.codex = next;
  syncEntityLedgers(data);
  refreshTimelineFromGodlogs(data);
  data.processing.codexKeys = {};
  for (const material of materials || []) {
    const row = material?.row || material;
    const godlog = material?.godlog || null;
    const revisionHash = summaryRevisionHash(godlog, row);
    if (row?.key && revisionHash) data.processing.codexKeys[row.key] = revisionHash;
  }
  data.processing.codexDirty = false;
  data.processing.codexDirtyReason = '';
  data.processing.codexDirtyAt = 0;
  data.processing.codexLastGoodAt = Date.now();
  data.processing.codexRebuildFailures = 0;
  data.processing.codexRetryAt = 0;
  data.processing.codexRebuildCheckpoint = null;
  data.processing.codexUnsafeFromFloor = null;
  return true;
}

function restoreCodexBackup(data, notify = true) {
  const backup = data?.codexBackup;
  if (!backup?.codex || (!codexHasContent(backup.codex) && !relationshipHasContent(backup.relationshipTable))) {
    if (notify) toastr?.warning?.('当前聊天没有可恢复的人物关系/人物/物品/场景索引备份。', 'Anchor Memory');
    return false;
  }
  if (codexHasContent(data.codex) || relationshipHasContent(data.relationshipTable)) snapshotCodex(data, '恢复备份前保存当前索引');
  data.codex = normalizedCodex(backup.codex);
  if (backup.relationshipTable) data.relationshipTable = normalizeRelationshipTable(backup.relationshipTable, data.codex.relationship || '');
  else data.relationshipTable = normalizeRelationshipTable(data.relationshipTable, data.codex.relationship || '');
  data.codex.relationship = relationshipTableMarkdown(data.relationshipTable, false);
  data.processing.codexKeys = clonePlainObject(backup.codexKeys || {});
  data.processing.lastCodexFloor = Number(backup.lastCodexFloor ?? -1);
  data.processing.codexDirty = false;
  data.processing.codexDirtyReason = '';
  data.processing.codexDirtyAt = 0;
  data.processing.codexLastGoodAt = Date.now();
  data.processing.codexRebuildFailures = 0;
  data.processing.codexRetryAt = 0;
  data.processing.codexRebuildCheckpoint = null;
  data.processing.codexUnsafeFromFloor = null;
  clearRelationshipDirty(data);
  syncEntityLedgers(data);
  refreshTimelineFromGodlogs(data);
  saveMemory(true);
  updatePreview();
  if (notify) toastr?.success?.('已恢复上一次人物关系/人物/物品/场景索引备份。', 'Anchor Memory');
  return true;
}

function memoryData() {
  const ctx = getContext();
  if (!ctx.chatMetadata) return defaultData();
  if (!ctx.chatMetadata[DATA_KEY]) ctx.chatMetadata[DATA_KEY] = defaultData();
  const data = ctx.chatMetadata[DATA_KEY];
  if (state.memoryDataReady
      && state.memoryMetadataRef === ctx.chatMetadata
      && state.memoryDataRef === data
      && Number(data.version) === DATA_VERSION) {
    return data;
  }
  const priorDataVersion = Number(data.version) || 0;
  const priorSourceHashSchema = Number(data.processing?.sourceHashSchema || 0);
  let migrationTouched = priorDataVersion !== DATA_VERSION;

  if (!Array.isArray(data.godlogs)) { data.godlogs = []; migrationTouched = true; }
  if (!Array.isArray(data.anchors)) { data.anchors = []; migrationTouched = true; }
  if (!Array.isArray(data.merges)) { data.merges = []; migrationTouched = true; }
  if (!data.messageGodlogs || typeof data.messageGodlogs !== 'object') data.messageGodlogs = {};
  if (!data.messageRecalls || typeof data.messageRecalls !== 'object') data.messageRecalls = {};
  const normalizedTrackedCharacters = uniqueTrackedNames(Array.isArray(data.trackedCharacters) ? data.trackedCharacters : []);
  if (!Array.isArray(data.trackedCharacters)
      || JSON.stringify(normalizedTrackedCharacters) !== JSON.stringify(data.trackedCharacters)) {
    data.trackedCharacters = normalizedTrackedCharacters;
    migrationTouched = true;
  }
  // v0.8 migration: historical prompt records retain IDs, counts and a short preview only.
  // Full injected bodies are highly repetitive and made every metadata save progressively larger.
  for (const record of Object.values(data.messageRecalls)) {
    if (!record || typeof record !== 'object') continue;
    if (typeof record.content === 'string') {
      if (!record.contentHash) record.contentHash = stableHash(record.content);
      if (!record.contentPreview) record.contentPreview = compactInjectionPreview(record.content);
      if (!record.injectedChars) record.injectedChars = record.content.length;
      delete record.content;
      migrationTouched = true;
    }
  }
  if (!data.codex || typeof data.codex !== 'object') { data.codex = { ...defaultData().codex }; migrationTouched = true; }
  data.codex = normalizedCodex(data.codex);
  // Upgrade old tables in place and enforce the protagonist/NPC boundary on existing chats. This
  // removes previously leaked player rows immediately instead of waiting for another AI rewrite.
  const resolvedTrackedCharacters = trackedCharacterNames(data);
  if (data.codex.characterMemo && resolvedTrackedCharacters.length > 0) {
    const normalizedCharacterMemo = sanitizeCharacterMemoSection(data, data.codex.characterMemo);
    if (normalizedCharacterMemo && normalizedCharacterMemo !== data.codex.characterMemo) {
      data.codex.characterMemo = normalizedCharacterMemo;
      migrationTouched = true;
    }
  }
  if (data.codex.peopleIndex && resolvedTrackedCharacters.length > 0) {
    const normalizedPeopleIndex = sanitizePeopleIndexSection(data, data.codex.peopleIndex);
    if (normalizedPeopleIndex !== data.codex.peopleIndex) {
      data.codex.peopleIndex = normalizedPeopleIndex;
      migrationTouched = true;
    }
  }
  if (data.codex.itemIndex) {
    const normalizedItemIndex = sanitizeItemIndexSection(data, data.codex.itemIndex);
    if (normalizedItemIndex !== data.codex.itemIndex) {
      data.codex.itemIndex = normalizedItemIndex;
      migrationTouched = true;
    }
  }
  if (data.codex.sceneIndex) {
    const normalizedSceneIndex = sanitizeSceneIndexSection(data, data.codex.sceneIndex);
    if (normalizedSceneIndex !== data.codex.sceneIndex) {
      data.codex.sceneIndex = normalizedSceneIndex;
      migrationTouched = true;
    }
  }
  const hadEntities = !!(data.entities && data.entities.items && data.entities.scenes);
  const hadTimeline = !!(data.timeline && Array.isArray(data.timeline.history));
  ensureEntityState(data);
  ensureTimelineState(data);
  syncEntityLedgers(data);
  refreshTimelineFromGodlogs(data);
  if (!hadEntities || !hadTimeline) migrationTouched = true;
  const hadRelationshipTable = !!(data.relationshipTable && typeof data.relationshipTable === 'object' && Array.isArray(data.relationshipTable.rows));
  data.relationshipTable = normalizeRelationshipTable(data.relationshipTable, data.codex.relationship || '');
  data.codex.relationship = relationshipTableMarkdown(data.relationshipTable, false);
  if (!hadRelationshipTable) migrationTouched = true;
  if (data.codexBackup !== null && (!data.codexBackup || typeof data.codexBackup !== 'object')) {
    data.codexBackup = null;
    migrationTouched = true;
  }
  if (data.codexBackup?.codex) data.codexBackup.codex = normalizedCodex(data.codexBackup.codex);
  if (data.codexBackup?.relationshipTable) data.codexBackup.relationshipTable = normalizeRelationshipTable(data.codexBackup.relationshipTable, data.codexBackup.codex?.relationship || '');
  if (!data.vectorRefs || typeof data.vectorRefs !== 'object') { data.vectorRefs = {}; migrationTouched = true; }
  if (!data.vectors || typeof data.vectors !== 'object') data.vectors = {};
  if (!data.processing || typeof data.processing !== 'object') data.processing = { ...defaultData().processing };
  const processingDefaults = defaultData().processing;
  for (const [key, value] of Object.entries(processingDefaults)) {
    if (data.processing[key] === undefined) {
      data.processing[key] = Array.isArray(value) ? [...value]
        : value && typeof value === 'object' ? { ...value }
          : value;
    }
  }
  if (data.processing.pendingPromptInjection?.content) {
    const content = String(data.processing.pendingPromptInjection.content || '');
    data.processing.pendingPromptInjection.contentHash ||= stableHash(content);
    data.processing.pendingPromptInjection.contentPreview ||= compactInjectionPreview(content);
    data.processing.pendingPromptInjection.injectedChars ||= content.length;
    delete data.processing.pendingPromptInjection.content;
    migrationTouched = true;
  }
  if (!data.processing.anchoredKeys) data.processing.anchoredKeys = {};
  if (!data.processing.mergedKeys) data.processing.mergedKeys = {};
  if (!data.processing.codexKeys) data.processing.codexKeys = {};
  if (!Number.isFinite(Number(data.processing.codexRetryAt))) data.processing.codexRetryAt = 0;
  if (data.processing.codexUnsafeFromFloor !== null
      && !Number.isFinite(Number(data.processing.codexUnsafeFromFloor))) {
    data.processing.codexUnsafeFromFloor = null;
    migrationTouched = true;
  }
  if (data.processing.codexRebuildCheckpoint !== null
      && (!data.processing.codexRebuildCheckpoint || typeof data.processing.codexRebuildCheckpoint !== 'object')) {
    data.processing.codexRebuildCheckpoint = null;
    migrationTouched = true;
  }
  // 0.9.14 and earlier exposed an internal AbortController token as if it were an API error.
  // Clear that stale retry state during migration so the new staged transaction can start normally
  // and the workbench never keeps showing the misleading raw `secondary-timeout` string.
  const legacySecondaryTimeout = /secondary-timeout/i.test(`${data.processing.codexDirtyReason || ''}
${data.processing.lastError || ''}`);
  if (legacySecondaryTimeout) {
    data.processing.codexDirtyReason = '旧版人物索引整段重建超过120秒并被插件中止；等待按分段事务继续重建';
    if (/secondary-timeout/i.test(String(data.processing.lastError || ''))) data.processing.lastError = '';
    data.processing.codexRetryAt = 0;
    data.processing.codexRebuildFailures = 0;
    data.processing.codexRebuildCheckpoint = null;
    migrationTouched = true;
  }
  if (!Array.isArray(data.processing.queueSources)) data.processing.queueSources = [];
  if (!data.processing.storageId) {
    ensureVectorStorageId(data);
    migrationTouched = true;
  }
  scheduleLegacyVectorMigration(data);
  if (!hadRelationshipTable && (data.godlogs || []).some(item => item.status === 'ready' && item.body)) {
    data.processing.relationshipDirty = true;
    data.processing.relationshipDirtyReason = '升级后首次建立固定人物关系表，等待根据现有剧情自动回填';
    data.processing.relationshipDirtyAt = Date.now();
  }

  // Upgrades may change text cleaning/fingerprint details. A schema migration must rebase source
  // fingerprints in place rather than treating every historical floor as edited and destroying
  // all dependent state. Real edits after the migration are still detected normally.
  if (priorSourceHashSchema !== SOURCE_HASH_SCHEMA_VERSION && hasPersistentChatContext()) {
    const rows = chatRows(true);
    const byKey = new Map(rows.map(row => [row.key, row]));
    const keyRemap = new Map();
    for (const item of data.godlogs || []) {
      let row = byKey.get(item.key);
      if (!row && Number.isInteger(Number(item.floor))) {
        const candidate = rows.find(entry => entry.index === Number(item.floor) && entry.role === 'assistant');
        const compatibleName = !item.name || !candidate?.name || item.name === candidate.name;
        const compatibleDate = !item.sendDate || !candidate?.sendDate || item.sendDate === candidate.sendDate;
        if (candidate && compatibleName && compatibleDate) row = candidate;
      }
      if (!row) continue;
      if (item.key !== row.key) keyRemap.set(item.key, row.key);
      item.key = row.key;
      item.floor = row.index;
      item.name = row.name;
      item.sendDate = row.sendDate;
      item.rawHash = row.rawHash;
    }
    const remapKeys = values => [...new Set((values || []).map(key => keyRemap.get(key) || key).filter(Boolean))];
    for (const anchor of data.anchors || []) {
      anchor.sourceKeys = remapKeys(anchor.sourceKeys);
      anchor.coveredKeys = remapKeys(anchor.coveredKeys);
    }
    for (const merge of data.merges || []) {
      merge.sourceKeys = remapKeys(merge.sourceKeys);
      merge.cycleSourceKeys = remapKeys(merge.cycleSourceKeys);
    }
    const remapObject = source => {
      const target = {};
      for (const [key, value] of Object.entries(source || {})) target[keyRemap.get(key) || key] = value;
      return target;
    };
    data.messageGodlogs = remapObject(data.messageGodlogs);
    data.messageRecalls = remapObject(data.messageRecalls);
    data.processing.codexKeys = remapObject(data.processing.codexKeys);
    const remappedRelationship = normalizeRelationshipTable(data.relationshipTable, data.codex?.relationship || '');
    remappedRelationship.history = (remappedRelationship.history || []).map(item => ({
      ...item,
      sourceKey: keyRemap.get(item.sourceKey) || item.sourceKey,
    }));
    remappedRelationship.lastGoodKey = keyRemap.get(remappedRelationship.lastGoodKey) || remappedRelationship.lastGoodKey;
    data.relationshipTable = remappedRelationship;
    data.codex.relationship = relationshipTableMarkdown(remappedRelationship, false);
    const migratedGodlogsByKey = new Map((data.godlogs || []).map(item => [item.key, item]));
    for (const row of rows) {
      if (!data.processing.codexKeys[row.key]) continue;
      data.processing.codexKeys[row.key] = summaryRevisionHash(migratedGodlogsByKey.get(row.key), row);
    }
    data.processing.sourceHashSchema = SOURCE_HASH_SCHEMA_VERSION;
    migrationTouched = true;
  }

  // Repair already-damaged 0.7.6/0.7.7 states when a backup exists. If no backup exists but valid
  // Godlogs remain, mark the empty index for a safe background rebuild instead of silently leaving
  // the panels blank forever.
  if (!codexHasContent(data.codex) && !relationshipHasContent(data.relationshipTable)
      && data.codexBackup?.codex
      && (codexHasContent(data.codexBackup.codex) || relationshipHasContent(data.codexBackup.relationshipTable))) {
    data.codex = normalizedCodex(data.codexBackup.codex);
    if (data.codexBackup.relationshipTable) {
      data.relationshipTable = normalizeRelationshipTable(data.codexBackup.relationshipTable, data.codex.relationship || '');
      data.codex.relationship = relationshipTableMarkdown(data.relationshipTable, false);
      if (relationshipHasContent(data.relationshipTable)) clearRelationshipDirty(data);
    }
    data.processing.codexKeys = clonePlainObject(data.codexBackup.codexKeys || {});
    data.processing.codexDirty = false;
    data.processing.codexDirtyReason = '';
    data.processing.codexDirtyAt = 0;
    migrationTouched = true;
  } else if (!codexHasContent(data.codex)
    && (data.godlogs || []).some(item => item?.status === 'ready' && item?.body)
    && priorDataVersion < DATA_VERSION) {
    data.processing.codexDirty = true;
    data.processing.codexDirtyReason = '升级时检测到状态索引为空，等待安全重建';
    data.processing.codexDirtyAt = Date.now();
    migrationTouched = true;
  }

  // Remove previously invalidated records from the active arrays. Older builds kept them in-place
  // and latestAnchor/latestMerge could accidentally inject them after a reroll.
  const preFilterAnchorCount = data.anchors.length;
  const preFilterMergeCount = data.merges.length;
  data.anchors = data.anchors.filter(item => item && !item.stale && item.active !== false);
  data.merges = data.merges.filter(item => item && !item.stale && item.active !== false);
  if (data.anchors.length !== preFilterAnchorCount || data.merges.length !== preFilterMergeCount) migrationTouched = true;

  const godlogById = new Map(data.godlogs.map(item => [item.id, item]));
  for (const anchor of data.anchors) {
    if (!Array.isArray(anchor.sourceKeys) || anchor.sourceKeys.length === 0) {
      anchor.sourceKeys = (anchor.sourceGodlogIds || [])
        .map(id => godlogById.get(id)?.key)
        .filter(Boolean);
      migrationTouched = true;
    }
    if (!Array.isArray(anchor.sourceGodlogIds)) { anchor.sourceGodlogIds = []; migrationTouched = true; }
    if (!Array.isArray(anchor.coveredKeys)) { anchor.coveredKeys = [...anchor.sourceKeys]; migrationTouched = true; }
    if (!Number.isFinite(Number(anchor.batchSize)) || Number(anchor.batchSize) <= 0) {
      anchor.batchSize = Math.max(1, anchor.sourceKeys.length || anchor.sourceGodlogIds.length || DEFAULT_ANCHOR_INTERVAL);
      migrationTouched = true;
    }
    if (!Number.isFinite(Number(anchor.intervalUsed)) || Number(anchor.intervalUsed) <= 0) {
      anchor.intervalUsed = Number(anchor.batchSize) || DEFAULT_ANCHOR_INTERVAL;
      migrationTouched = true;
    }
  }

  // v0.6 merges only stored sourceAnchorIds. Convert them to cumulative sourceKeys so a single
  // changed floor can invalidate every dependent merge deterministically.
  const anchorById = new Map(data.anchors.map(item => [item.id, item]));
  let cumulative = [];
  for (const merge of data.merges) {
    let keys = Array.isArray(merge.sourceKeys) ? merge.sourceKeys.filter(Boolean) : [];
    if (keys.length === 0) {
      const fromAnchors = (merge.sourceAnchorIds || [])
        .flatMap(id => anchorById.get(id)?.sourceKeys || []);
      const fromGodlogs = (merge.sourceGodlogIds || [])
        .map(id => godlogById.get(id)?.key)
        .filter(Boolean);
      keys = [...cumulative, ...fromAnchors, ...fromGodlogs];
    }
    const normalizedKeys = [...new Set(keys)];
    if (JSON.stringify(merge.sourceKeys || []) !== JSON.stringify(normalizedKeys)) migrationTouched = true;
    merge.sourceKeys = normalizedKeys;
    if (!Array.isArray(merge.cycleSourceKeys) || merge.cycleSourceKeys.length === 0) {
      const previousKeys = new Set(cumulative);
      merge.cycleSourceKeys = normalizedKeys.filter(key => !previousKeys.has(key));
      migrationTouched = true;
    }
    if (!Number.isFinite(Number(merge.cycleSize)) || Number(merge.cycleSize) <= 0) {
      merge.cycleSize = Math.max(1, merge.cycleSourceKeys.length || normalizedKeys.length || (DEFAULT_ANCHOR_INTERVAL * DEFAULT_MERGE_ANCHOR_INTERVAL));
      migrationTouched = true;
    }
    if (!Number.isFinite(Number(merge.intervalUsed)) || Number(merge.intervalUsed) <= 0) {
      merge.intervalUsed = Number(merge.cycleSize) || (DEFAULT_ANCHOR_INTERVAL * DEFAULT_MERGE_ANCHOR_INTERVAL);
      migrationTouched = true;
    }
    if (!Number.isFinite(Number(merge.cycleAnchorCount)) || Number(merge.cycleAnchorCount) <= 0) {
      const inferredAnchorCount = Array.isArray(merge.sourceAnchorIds) && merge.sourceAnchorIds.length > 0
        ? merge.sourceAnchorIds.length
        : Math.max(1, Math.round(Number(merge.cycleSize || 0) / Math.max(1, normalizeAnchorInterval(settings().anchorInterval))));
      merge.cycleAnchorCount = inferredAnchorCount;
      migrationTouched = true;
    }
    if (!Number.isFinite(Number(merge.mergeAnchorIntervalUsed)) || Number(merge.mergeAnchorIntervalUsed) <= 0) {
      merge.mergeAnchorIntervalUsed = Number(merge.cycleAnchorCount) || DEFAULT_MERGE_ANCHOR_INTERVAL;
      migrationTouched = true;
    }
    cumulative = merge.sourceKeys;
  }

  // Repair legacy anchors that straddled an already-written cumulative merge boundary.
  // The merged portion already belongs to the cumulative history anchor, while the tail must be
  // released and regrouped from clean post-boundary summaries.
  if (cumulative.length > 0) {
    const mergedSet = new Set(cumulative);
    const before = data.anchors.length;
    data.anchors = data.anchors.filter(anchor => {
      const keys = anchor.sourceKeys || [];
      const overlap = keys.filter(key => mergedSet.has(key)).length;
      if (overlap > 0 && overlap < keys.length) {
        removeStoredVector(data, anchor.id);
        return false;
      }
      return true;
    });
    if (data.anchors.length !== before) migrationTouched = true;
  }

  data.processing.godlogCount = Math.max(0, ...data.godlogs.map(item => Number(item.number) || 0));
  if (renumberDerivedMemory(data)) migrationTouched = true;
  if (data.processing.busy && !state.running) { data.processing.busy = false; migrationTouched = true; }
  if (data.processing.summaryBusy && !state.summaryRunning) { data.processing.summaryBusy = false; migrationTouched = true; }
  if (data.processing.mergeBusy && !state.mergeRunning) { data.processing.mergeBusy = false; migrationTouched = true; }
  if (data.processing.codexBusy && !state.codexRunning) { data.processing.codexBusy = false; migrationTouched = true; }
  if (data.processing.queueRunning && !state.jobRunning) { data.processing.queueRunning = false; migrationTouched = true; }
  data.version = DATA_VERSION;
  refreshCoverageMaps(data);
  state.memoryMetadataRef = ctx.chatMetadata;
  state.memoryDataRef = data;
  state.memoryDataReady = true;
  if (migrationTouched) saveMemory(true);
  return data;
}

function hasPersistentChatContext() {
  const ctx = getContext();
  return !!(ctx && Array.isArray(ctx.chat) && ctx.chatMetadata && typeof ctx.chatMetadata === 'object');
}


function captureChatContextToken(data = null) {
  const ctx = getContext();
  return {
    chatRef: ctx?.chat || null,
    metadataRef: ctx?.chatMetadata || null,
    storageId: String(data?.processing?.storageId || ''),
  };
}

function isSameChatContext(token) {
  if (!token) return false;
  const ctx = getContext();
  if (ctx?.chat !== token.chatRef || ctx?.chatMetadata !== token.metadataRef) return false;
  if (!token.storageId) return true;
  const currentStorageId = String(ctx?.chatMetadata?.[DATA_KEY]?.processing?.storageId || '');
  return !currentStorageId || currentStorageId === token.storageId;
}

async function flushMemoryNow() {
  if (!hasPersistentChatContext()) return false;
  if (state.metadataFlushTimer) {
    clearTimeout(state.metadataFlushTimer);
    state.metadataFlushTimer = null;
  }
  if (state.metadataFlushPromise) return state.metadataFlushPromise;
  state.metadataFlushPromise = Promise.resolve()
    .then(async () => {
      if (typeof saveMetadataDebounced.flush === 'function') {
        await saveMetadataDebounced.flush();
      } else {
        saveMetadataDebounced();
      }
      return true;
    })
    .catch(err => {
      console.warn('[AnchorMemory] metadata flush failed:', err);
      return false;
    })
    .finally(() => {
      state.metadataFlushPromise = null;
    });
  return state.metadataFlushPromise;
}

function requestMetadataFlush(delay = 900) {
  if (!hasPersistentChatContext()) return false;
  if (state.metadataFlushTimer) clearTimeout(state.metadataFlushTimer);
  state.metadataFlushTimer = setTimeout(() => {
    state.metadataFlushTimer = null;
    flushMemoryNow();
  }, Math.max(120, Number(delay) || 900));
  return true;
}

function saveMemory(immediate = false) {
  // SillyTavern serializes chat metadata together with the chat save. Keep ordinary updates on its
  // built-in debounce, and coalesce "immediate" requests from multi-step memory jobs into one flush.
  if (!hasPersistentChatContext()) return false;
  saveMetadataDebounced();
  if (immediate) requestMetadataFlush();
  return true;
}

function currentCharacterName() {
  return (getContext().name2 || 'character').trim() || 'character';
}

function cleanTrackedCharacterName(value) {
  return cleanRelationshipCell(String(value || '')
    .replace(/^[-*•\d.、\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim(), 120);
}

function uniqueTrackedNames(values, userName = getContext().name1 || '') {
  const result = [];
  const seen = new Set();
  const userKey = normalizeEntityMatchText(userName);
  for (const value of values || []) {
    const name = cleanTrackedCharacterName(value);
    const key = normalizeEntityMatchText(name);
    if (!name || !key || key === userKey || seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result;
}

function parseTrackedCharacterInput(value) {
  return uniqueTrackedNames(String(value || '')
    .split(/[\n,，、;；/]+/)
    .map(item => item.trim())
    .filter(Boolean));
}

function characterRecordName(record) {
  return cleanTrackedCharacterName(
    record?.name
    || record?.data?.name
    || record?.character_name
    || record?.display_name
    || '',
  );
}

function characterRecordAvatar(record) {
  return String(record?.avatar || record?.data?.avatar || record?.filename || '').trim();
}

function characterCollections(ctx = getContext()) {
  return [ctx.characters, globalThis.characters, globalThis.SillyTavern?.characters]
    .filter(Boolean);
}

function allCharacterRecords(ctx = getContext()) {
  const result = [];
  const seen = new Set();
  for (const collection of characterCollections(ctx)) {
    const values = Array.isArray(collection) ? collection : Object.values(collection || {});
    for (const record of values) {
      if (!record || typeof record !== 'object' || seen.has(record)) continue;
      seen.add(record);
      result.push(record);
    }
  }
  return result;
}

function groupCollections(ctx = getContext()) {
  return [
    ctx.groups,
    ctx.groupChats,
    legacyGroupModule.groups,
    globalThis.groups,
    globalThis.SillyTavern?.groups,
  ].filter(Boolean);
}

function activeGroupRecord(ctx = getContext()) {
  const groupId = String(ctx.groupId ?? ctx.group_id ?? globalThis.selected_group ?? '').trim();
  if (!groupId) return null;
  for (const collection of groupCollections(ctx)) {
    const values = Array.isArray(collection) ? collection : Object.values(collection || {});
    const match = values.find(group => String(group?.id ?? group?.groupId ?? group?.group_id ?? '') === groupId);
    if (match) return match;
  }
  return ctx.group || ctx.currentGroup || null;
}

function resolveGroupMemberName(member, records) {
  if (member && typeof member === 'object') {
    const direct = characterRecordName(member);
    if (direct) return direct;
    member = member.id ?? member.chid ?? member.avatar ?? member.filename ?? '';
  }
  const numeric = Number(member);
  if (Number.isInteger(numeric) && records[numeric]) {
    const name = characterRecordName(records[numeric]);
    if (name) return name;
  }
  const raw = String(member || '').trim();
  if (!raw) return '';
  const rawKey = normalizeEntityMatchText(raw.replace(/\.[a-z0-9]+$/i, ''));
  for (const record of records) {
    const name = characterRecordName(record);
    const avatar = characterRecordAvatar(record);
    if (normalizeEntityMatchText(name) === rawKey
      || normalizeEntityMatchText(avatar) === normalizeEntityMatchText(raw)
      || normalizeEntityMatchText(avatar.replace(/\.[a-z0-9]+$/i, '')) === rawKey) return name;
  }
  return cleanTrackedCharacterName(raw.replace(/\.[a-z0-9]+$/i, ''));
}

function automaticTrackedCharacterNames(ctx = getContext()) {
  const names = [];
  const records = allCharacterRecords(ctx);
  const group = activeGroupRecord(ctx);
  if (group) {
    const members = group.members || group.memberIds || group.characters || group.chars || [];
    for (const member of Array.isArray(members) ? members : Object.values(members || {})) {
      const name = resolveGroupMemberName(member, records);
      if (name) names.push(name);
    }
  }
  const singleName = cleanTrackedCharacterName(ctx.name2 || '');
  if (names.length === 0 && singleName) names.push(singleName);
  return uniqueTrackedNames(names, ctx.name1 || '');
}

function trackedCharacterNames(data = null, ctx = getContext()) {
  const explicit = Array.isArray(data?.trackedCharacters)
    ? uniqueTrackedNames(data.trackedCharacters, ctx.name1 || '')
    : [];
  // Explicit per-chat names are authoritative for a multi-protagonist single card. In a real group
  // chat, active group members are also included so newly enabled speakers are never silently lost.
  const automatic = automaticTrackedCharacterNames(ctx);
  return uniqueTrackedNames(activeGroupRecord(ctx) ? [...explicit, ...automatic] : (explicit.length ? explicit : automatic), ctx.name1 || '');
}

function trackedCharacterLabel(data = null, ctx = getContext()) {
  const names = trackedCharacterNames(data, ctx);
  return names.length ? names.join('、') : (ctx.name2 || '{{char}}');
}

function trackedCharacterKeys(data = null, ctx = getContext()) {
  return new Set(trackedCharacterNames(data, ctx).map(normalizeEntityMatchText).filter(Boolean));
}

function isTrackedCharacterName(value, data = null, ctx = getContext()) {
  const key = normalizeEntityMatchText(value);
  if (!key) return false;
  return trackedCharacterKeys(data, ctx).has(key);
}

function renderMemoryRules(text, data = null, ctx = getContext()) {
  const tracked = trackedCharacterLabel(data, ctx);
  return renderMacros(String(text || ''), ctx)
    .replace(/\{\{\s*tracked_chars?\s*\}\}/gi, tracked)
    .replace(/\{\{\s*trackedCharacters\s*\}\}/gi, tracked);
}

function uniqueCompactLines(lines, limit = 24) {
  const seen = new Set();
  const result = [];
  for (const line of lines || []) {
    const text = cleanText(line).replace(/\s+/g, ' ').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= limit) break;
  }
  return result;
}

function objectValueAtPath(source, path) {
  let value = source;
  for (const part of path) {
    if (!value || typeof value !== 'object') return '';
    try {
      value = value[part];
    } catch {
      return '';
    }
  }
  return value;
}

function stringifyCanonValue(value, limit = 1200, seen = new WeakSet(), depth = 0) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return clampText(cleanText(value).replace(/\s+/g, ' ').trim(), limit);
  if (depth > 3) return '';
  if (Array.isArray(value)) {
    if (seen.has(value)) return '';
    seen.add(value);
    return clampText(value.slice(0, 12).map(item => stringifyCanonValue(item, Math.floor(limit / 2), seen, depth + 1)).filter(Boolean).join('；'), limit);
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return '';
    seen.add(value);
    const parts = [];
    for (const key of ['name', 'comment', 'key', 'keys', 'content', 'text', 'entry', 'description']) {
      let child;
      try {
        child = value[key];
      } catch {
        continue;
      }
      if (child === undefined) continue;
      const text = stringifyCanonValue(child, Math.floor(limit / 2), seen, depth + 1);
      if (text) parts.push(text);
    }
    return clampText(parts.join('；'), limit);
  }
  return String(value).trim();
}

function characterCardCandidates(ctx = getContext()) {
  const candidates = [];
  const charName = ctx.name2 || currentCharacterName();
  const ids = [ctx.characterId, ctx.character_id, ctx.chid, ctx.this_chid, window.this_chid]
    .map(value => Number(value))
    .filter(Number.isInteger);
  for (const list of [ctx.characters, window.characters]) {
    if (Array.isArray(list)) {
      for (const id of ids) if (list[id]) candidates.push(list[id]);
      candidates.push(...list.filter(item => item?.name === charName || item?.data?.name === charName));
    } else if (list && typeof list === 'object') {
      if (list[charName]) candidates.push(list[charName]);
      candidates.push(...Object.values(list).filter(item => item?.name === charName || item?.data?.name === charName));
    }
  }
  candidates.push(ctx.character, ctx.char, ctx.currentCharacter, ctx.thisCharacter, window.character, window.char, window.thisCharacter);
  return candidates.filter(Boolean);
}

function collectCharacterCanon(ctx = getContext()) {
  const rows = [];
  const fields = [
    ['name'],
    ['data', 'name'],
    ['description'],
    ['data', 'description'],
    ['personality'],
    ['data', 'personality'],
    ['scenario'],
    ['data', 'scenario'],
    ['creatorcomment'],
    ['data', 'creator_notes'],
    ['system_prompt'],
    ['data', 'system_prompt'],
    ['post_history_instructions'],
    ['data', 'post_history_instructions'],
    ['first_mes'],
    ['data', 'first_mes'],
    ['mes_example'],
    ['data', 'mes_example'],
  ];
  for (const card of characterCardCandidates(ctx)) {
    for (const path of fields) {
      const value = objectValueAtPath(card, path);
      const text = stringifyCanonValue(value, 1200);
      if (text) rows.push(`${path.join('.')}: ${text}`);
    }
    const book = card.character_book || card.data?.character_book;
    const entries = Array.isArray(book?.entries) ? book.entries : [];
    for (const entry of entries) {
      if (entry?.disable === true || entry?.enabled === false) continue;
      const text = stringifyCanonValue(entry, 1000);
      if (text) rows.push(`character_book: ${text}`);
    }
  }
  return uniqueCompactLines(rows, 18);
}

function looksLikeWorldInfoEntry(value) {
  if (!value || typeof value !== 'object') return false;
  return typeof value.content === 'string'
    || typeof value.comment === 'string'
    || typeof value.entry === 'string'
    || typeof value.text === 'string'
    || typeof value.key === 'string'
    || Array.isArray(value.keys);
}

function collectWorldInfoEntries(source, maxEntries = 120) {
  if (!source || typeof source !== 'object') return [];
  const entries = [];
  const queue = [source];
  const seen = new WeakSet();
  let inspected = 0;

  while (queue.length > 0 && entries.length < maxEntries && inspected < 1000) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);
    inspected++;

    if (looksLikeWorldInfoEntry(current)) {
      entries.push(current);
      continue;
    }

    if (Array.isArray(current)) {
      for (const item of current.slice(0, 240)) {
        if (item && typeof item === 'object') queue.push(item);
      }
      continue;
    }

    if (current instanceof Map) {
      for (const item of [...current.values()].slice(0, 240)) {
        if (item && typeof item === 'object') queue.push(item);
      }
      continue;
    }

    for (const key of ['entries', 'world_info', 'worldInfo', 'data', 'books', 'global', 'chat', 'character']) {
      let child;
      try {
        child = current[key];
      } catch {
        continue;
      }
      if (child && typeof child === 'object') queue.push(child);
    }

    let values = [];
    try {
      values = Object.values(current).filter(item => item && typeof item === 'object').slice(0, 120);
    } catch {
      values = [];
    }
    for (const item of values) queue.push(item);
  }

  return entries;
}

function collectWorldCanon(row, godlog = null, ctx = getContext()) {
  const query = [
    ctx.name1,
    ctx.name2,
    row?.name,
    row?.turnText,
    row?.text,
    safeGodlogMemoryText(godlog?.body || ''),
  ].filter(Boolean).join('\n');
  const terms = keywordSet(query);
  const sources = [
    ctx.worldInfo,
    ctx.world_info,
    ctx.worldInfoEntries,
    ctx.globalWorldInfo,
    ctx.chatMetadata?.worldInfo,
    ctx.chatMetadata?.world_info,
    window.worldInfo,
    window.world_info,
    window.worldInfoEntries,
    window.globalWorldInfo,
  ];
  const rows = [];
  for (const source of sources) {
    let entries = [];
    try {
      entries = collectWorldInfoEntries(source);
    } catch (err) {
      console.warn('[AnchorMemory] world info scan skipped', err);
      continue;
    }
    for (const entry of entries) {
      if (!entry || entry.disable === true || entry.enabled === false) continue;
      const text = stringifyCanonValue(entry, 1200);
      if (!text) continue;
      const own = keywordSet(text);
      let score = 0;
      for (const term of terms) if (own.has(term) || text.toLowerCase().includes(term)) score++;
      if (score > 0 || entry.constant === true) rows.push({ score, text });
    }
  }
  return uniqueCompactLines(rows.sort((a, b) => b.score - a.score).map(item => item.text), 18);
}

function collectRecentOriginalContext(row, limit = 8) {
  const chat = getContext().chat || [];
  const end = Number.isInteger(row?.index) ? row.index : chat.length;
  return chat
    .slice(Math.max(0, end - limit), end)
    .filter(message => message && !message.is_system && !message.is_hidden && message.mes)
    .map((message, offset) => {
      const floor = Math.max(0, end - limit) + offset + 1;
      const role = message.is_user ? '用户' : 'AI';
      return `第${floor}楼 ${role} ${message.name || '未命名'}：${clampText(cleanText(message.mes), 500)}`;
    })
    .filter(Boolean);
}

function buildCanonContextBlock(data, row, godlog = null, maxChars = 7200) {
  const ctx = getContext();
  const parts = [];
  let characterCanon = [];
  try {
    characterCanon = collectCharacterCanon(ctx);
  } catch (err) {
    console.warn('[AnchorMemory] character canon scan skipped', err);
  }
  if (characterCanon.length) parts.push(`## 角色卡与角色书硬设定\n${characterCanon.join('\n')}`);
  let worldCanon = [];
  try {
    worldCanon = collectWorldCanon(row, godlog, ctx);
  } catch (err) {
    console.warn('[AnchorMemory] world canon scan skipped', err);
  }
  if (worldCanon.length) parts.push(`## 世界书/设定书相关条目\n${worldCanon.join('\n')}`);
  const recentOriginal = collectRecentOriginalContext(row, 8);
  if (recentOriginal.length) parts.push(`## 当前楼之前的近几条原文\n${recentOriginal.join('\n')}`);
  if (data?.codex?.peopleIndex) parts.push(`## 已有人物关系事实\n${safeCodexText(data.codex.peopleIndex, 1800)}`);
  if (!data?.processing?.relationshipDirty && relationshipHasContent(data?.relationshipTable)) {
    parts.push(`## 固定人物与${renderMacros('{{user}}')}的关系表\n${safeCodexText(relationshipTableMarkdown(data.relationshipTable, true), 2200)}`);
  }
  if (!parts.length) return '（未读取到角色卡、世界书或上文硬设定；不确定身份和关系时必须写“未明/沿用既有设定”，不要猜。）';
  return clampText(parts.join('\n\n'), maxChars);
}

function showStatus(text) {
  $('#am_status').text(text || '');
}

function looksLikeLegacyGodlogRules(value) {
  const text = String(value || '');
  if (!text.trim()) return false;
  if (/<Nub>[\s\S]*?<\/Nub>/i.test(text) && /<Cond>[\s\S]*?<\/Cond>/i.test(text)) return false;
  return /(?:^|\n)\s*Nub\s*[:：]/i.test(text)
    || /(?:^|\n)\s*Cond\s*[:：]\s*200-?300/i.test(text)
    || /当前这一楼|逐楼记忆记录员/.test(text);
}

function hasGodlogXmlFields(text) {
  const value = String(text || '');
  const hasCond = /(?:<|&lt;)Cond(?:>|&gt;)[\s\S]*?(?:<|&lt;)\/Cond(?:>|&gt;)/i.test(value);
  const hasHeader = /(?:<|&lt;)(?:Nub|Title|Time|Pln|Per)(?:>|&gt;)[\s\S]*?(?:<|&lt;)\/(?:Nub|Title|Time|Pln|Per)(?:>|&gt;)/i.test(value);
  return hasCond && hasHeader;
}

function hasGodlogColonFields(text) {
  const value = String(text || '');
  return /(?:^|\n)\s*Nub\s*[:：]/i.test(value)
    && /(?:^|\n)\s*Cond\s*[:：]/i.test(value)
    && /(?:^|\n)\s*(?:Title|Time|Pln|Per)\s*[:：]/i.test(value);
}

function looksLikeGodlogLeakText(text) {
  const value = String(text || '');
  return /(?:<|&lt;)\/?Godlog(?:>|&gt;)/i.test(value)
    || hasGodlogColonFields(value)
    || hasGodlogXmlFields(value);
}

function stripGodlogFenceBlocks(text) {
  return String(text || '').replace(FENCED_CODE_BLOCK_RE, block => (
    looksLikeGodlogLeakText(block) ? '' : block
  ));
}

function cleanText(text) {
  return stripGodlogBlocks(text)
    .replace(GODLOG_BLOCK_RE, '')
    .replace(GODLOG_ESCAPED_BLOCK_RE, '')
    .replace(GODLOG_FIELD_XML_GROUP_RE, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .trim();
}


function normalizeAnchorBody(text, number) {
  let value = cleanText(stripGodlogFenceBlocks(String(text || '')))
    .replace(/<[^>]+>/g, '')
    .trim();
  const markerIndex = value.search(/\*\*本次新增锚点[：:]?\*\*/i);
  if (markerIndex >= 0) value = value.slice(markerIndex).replace(/^\*\*本次新增锚点[：:]?\*\*\s*/i, '');
  value = value
    .replace(/^###\s*第\s*\d+\s*次锚点记录\s*/im, '')
    .replace(/\n(?:#{1,6}|\*\*【)[\s\S]*$/m, '')
    .replace(/^\|.*\|\s*$/gm, '')
    .trim();
  return `### 第 ${number} 次锚点记录\n\n**本次新增锚点：**\n${value}`.trim();
}

function normalizeMergeBody(text, number) {
  let value = cleanText(stripGodlogFenceBlocks(String(text || '')))
    .replace(/<[^>]+>/g, '')
    .trim();
  const markerIndex = value.search(/\*\*历史锚点简述\*\*/i);
  if (markerIndex >= 0) value = value.slice(markerIndex).replace(/^\*\*历史锚点简述\*\*\s*/i, '');
  value = value
    .replace(/^###\s*第\s*\d+\s*次全量合并锚点\s*/im, '')
    .replace(/\n(?:#{1,6}|\*\*【)[\s\S]*$/m, '')
    .replace(/^\|.*\|\s*$/gm, '')
    .trim();
  return `### 第 ${number} 次全量合并锚点\n\n**历史锚点简述**\n${value}`.trim();
}

function stripGodlogBlocks(text) {
  return stripGodlogFenceBlocks(text)
    .replace(GODLOG_BLOCK_RE, '')
    .replace(GODLOG_ESCAPED_BLOCK_RE, '')
    .replace(GODLOG_FIELD_XML_GROUP_RE, '')
    .trim();
}

function sanitizeMainPromptMemoryText(text) {
  return renderMacros(stripGodlogBlocks(text)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/Anchor Memory｜旧楼层索引摘要/gi, '剧情资料｜旧楼摘要')
    .replace(/Anchor Memory｜旧楼层正文已隐藏/gi, '剧情资料｜旧楼正文已隐藏')
    .replace(/Anchor Memory｜旧用户输入已隐藏/gi, '剧情资料｜旧用户输入已隐藏')
    .replace(/\bAnchor Memory\b/gi, '剧情资料')
    .replace(/&lt;\/?(?:Godlog|Nub|Title|Time|Pln|Per|Cond)&gt;/gi, ' ')
    .replace(/<\/?(?:Godlog|Nub|Title|Time|Pln|Per|Cond)>/gi, ' ')
    .replace(/\bGodlog\b/gi, '逐楼摘要')
    .replace(/(?:^|\n)\s*(?:Nub|Title|Time|Pln|Per|Cond)\s*[:：]\s*/gi, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim());
}

function sanitizeOutboundGodlogText(text) {
  if (typeof text !== 'string' || !looksLikeGodlogLeakText(text)) return text;
  return sanitizeMainPromptMemoryText(text);
}

function sanitizeOutboundMessageGodlogLeak(message) {
  if (!message) return false;
  let changed = false;
  if (typeof message.mes === 'string') {
    const next = sanitizeOutboundGodlogText(message.mes);
    if (next !== message.mes) {
      message.mes = next;
      changed = true;
    }
  }
  if (typeof message.content === 'string') {
    const next = sanitizeOutboundGodlogText(message.content);
    if (next !== message.content) {
      message.content = next;
      changed = true;
    }
  } else if (Array.isArray(message.content)) {
    const nextContent = message.content.map(part => {
      if (typeof part === 'string') {
        const next = sanitizeOutboundGodlogText(part);
        if (next !== part) changed = true;
        return next;
      }
      if (part && typeof part.text === 'string') {
        const next = sanitizeOutboundGodlogText(part.text);
        if (next !== part.text) {
          changed = true;
          return { ...part, text: next };
        }
      }
      return part;
    });
    if (changed) message.content = nextContent;
  }
  return changed;
}

function sanitizePromptReadyGodlogLeaks(promptChat) {
  if (!Array.isArray(promptChat)) return 0;
  let changed = 0;
  for (const message of promptChat) {
    if (sanitizeOutboundMessageGodlogLeak(message)) changed++;
  }
  return changed;
}

function hasGodlogFenceBlock(text) {
  return (String(text || '').match(FENCED_CODE_BLOCK_RE) || [])
    .some(block => looksLikeGodlogLeakText(block));
}

function hasGodlogBlock(text) {
  const value = String(text || '');
  return /<Godlog>[\s\S]*?<\/Godlog>/i.test(value)
    || /&lt;Godlog&gt;[\s\S]*?&lt;\/Godlog&gt;/i.test(value)
    || hasGodlogFenceBlock(value)
    || hasGodlogXmlFields(value);
}

function stripGodlogFromMessageRecord(message) {
  if (!message) return false;
  let changed = false;
  if (hasGodlogBlock(message.mes)) {
    message.mes = stripGodlogBlocks(message.mes);
    changed = true;
  }
  if (Array.isArray(message.swipes)) {
    for (let index = 0; index < message.swipes.length; index++) {
      if (!hasGodlogBlock(message.swipes[index])) continue;
      message.swipes[index] = stripGodlogBlocks(message.swipes[index]);
      changed = true;
    }
  }
  return changed;
}

function cleanupUserGodlogBlocks() {
  const chat = getContext().chat || [];
  let changed = false;
  for (let index = 0; index < chat.length; index++) {
    const message = chat[index];
    if (!message?.is_user) continue;
    const rowChanged = stripGodlogFromMessageRecord(message);
    if (rowChanged) refreshMessageBlock(index);
    changed = rowChanged || changed;
  }
  if (changed) saveChatNow();
  return changed;
}

function normalizeGodlogBlock(body) {
  const raw = String(body || '').trim();
  if (!raw) return '';
  // Some OpenAI-compatible proxies return XML as escaped text. Decode only the structural entities
  // used by Godlog so a valid response is not mistaken for an empty/short summary.
  const text = raw
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .trim();
  const match = text.match(/<Godlog>[\s\S]*?<\/Godlog>/i);
  if (match) {
    const block = match[0].trim();
    if (/<Nub>[\s\S]*?<\/Nub>/i.test(block)) return block;
    const converted = normalizeLegacyGodlogFields(block);
    return converted || block;
  }
  const converted = normalizeLegacyGodlogFields(text);
  if (converted) return converted;
  return `<Godlog>\n${text}\n</Godlog>`;
}

function compactCharacterCount(text) {
  return Array.from(String(text || '').replace(/\s+/g, '')).length;
}

function expectedGodlogCondMin(row) {
  const sourceChars = compactCharacterCount(row?.turnText || row?.text || '');
  // Long role-play turns must honor the configured 200-character lower bound. Very short turns use
  // a proportional floor so the validator never pressures the writer to invent details merely to pad.
  if (sourceChars >= 400) return 200;
  if (sourceChars >= 240) return 150;
  return Math.max(60, Math.min(130, Math.floor(sourceChars * 0.62) || 60));
}

function validateGodlogCandidate(body, row) {
  const block = normalizeGodlogBlock(body);
  if (!block) return { ok: false, block: '', reason: '副API没有返回摘要正文', condChars: 0, minCondChars: expectedGodlogCondMin(row) };
  const missing = GODLOG_FIELD_NAMES.filter(tag => !new RegExp(String.raw`<${tag}>[\s\S]*?<\/${tag}>`, 'i').test(block));
  if (missing.length > 0) {
    return {
      ok: false,
      block,
      reason: `摘要XML缺少字段：${missing.join('、')}`,
      condChars: compactCharacterCount(godlogFieldValue(block, 'Cond')),
      minCondChars: expectedGodlogCondMin(row),
    };
  }
  const cond = godlogFieldValue(block, 'Cond');
  const condChars = compactCharacterCount(cond);
  const minCondChars = expectedGodlogCondMin(row);
  if (condChars < minCondChars) {
    return {
      ok: false,
      block,
      reason: `Cond仅${condChars}字，当前楼至少需要${minCondChars}字`,
      condChars,
      minCondChars,
    };
  }
  return { ok: true, block, reason: '', condChars, minCondChars };
}

function buildGodlogCorrectionPrompt(basePrompt, failedBody, validation) {
  return `${basePrompt}

## 上一次输出不合格，必须从头重写
问题：${validation?.reason || '格式或长度不合格'}。
上一次输出：
${clampText(String(failedBody || '（空）'), 1800)}

请重新阅读“当前回合原文”，从头输出一个完整的 <Godlog> XML 块，不要续写上一次答案，不要解释。
- 六个字段必须全部存在。
- Cond 必须不少于 ${validation?.minCondChars || 200} 字；当前楼原文足够长时应保持 200—350 字。
- 只能增加原文中已经发生的动作、转折、结果和关键原话，禁止用空话凑字数，禁止脑补。`;
}

function legacyGodlogFieldValue(text, field) {
  const fieldPattern = GODLOG_FIELD_NAMES.join('|');
  const pattern = new RegExp(`(?:^|\\n)\\s*${field}\\s*[:：]\\s*([\\s\\S]*?)(?=\\n\\s*(?:${fieldPattern})\\s*[:：]|$)`, 'i');
  const match = String(text || '').match(pattern);
  return match ? match[1].trim() : '';
}

function normalizeLegacyGodlogFields(text) {
  const inner = String(text || '')
    .replace(/^\s*<Godlog>\s*/i, '')
    .replace(/\s*<\/Godlog>\s*$/i, '')
    .trim();
  if (!/(?:^|\n)\s*Nub\s*[:：]/i.test(inner)) return '';
  const values = GODLOG_FIELD_NAMES.map(field => [field, legacyGodlogFieldValue(inner, field)]);
  if (values.filter(([, value]) => value).length < 3) return '';
  return `<Godlog>\n${values.map(([field, value]) => `<${field}>${value || '未明'}</${field}>`).join('\n')}\n</Godlog>`;
}

function replaceGodlogField(block, tag, value) {
  const text = normalizeGodlogBlock(block);
  const safeValue = String(value || '').trim();
  if (!text || !safeValue) return text;
  const pattern = new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, 'i');
  if (pattern.test(text)) return text.replace(pattern, `<${tag}>${safeValue}</${tag}>`);
  return text.replace(/<\/Godlog>\s*$/i, `<${tag}>${safeValue}</${tag}>\n</Godlog>`);
}

function plainGodlogText(body) {
  const block = normalizeGodlogBlock(body);
  if (!block) return '';
  const fields = GODLOG_FIELD_NAMES.map(tag => {
    const match = block.match(new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, 'i'));
    if (!match) return '';
    const value = match[0].replace(new RegExp(`^<${tag}>|<\\/${tag}>$`, 'gi'), '').trim();
    return value ? `${tag}: ${value}` : '';
  }).filter(Boolean);
  if (fields.length > 0) return fields.join('\n');
  return block.replace(/<\/?Godlog>/gi, '').replace(/<\/?[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function safeGodlogMemoryText(body) {
  const title = godlogFieldValue(body, 'Title');
  const time = godlogFieldValue(body, 'Time');
  const place = godlogFieldValue(body, 'Pln');
  const people = godlogFieldValue(body, 'Per');
  const content = godlogFieldValue(body, 'Cond') || plainGodlogText(body);
  const parts = [];
  if (title) parts.push(`事件：${title}`);
  if (time || place) parts.push(`时地：${[time, place].filter(Boolean).join(' / ')}`);
  if (people) parts.push(`人物：${people}`);
  if (content) parts.push(`经过：${content}`);
  return sanitizeMainPromptMemoryText(parts.join('\n'));
}

function compactGodlogMemoryText(body, maxChars = 260) {
  const title = godlogFieldValue(body, 'Title') || '未命名事件';
  const time = godlogFieldValue(body, 'Time');
  const place = godlogFieldValue(body, 'Pln');
  const content = godlogFieldValue(body, 'Cond') || plainGodlogText(body);
  const locator = [time, place].filter(Boolean).join(' / ');
  const prefix = `${locator ? `[${locator}] ` : ''}${title}：`;
  const budget = Math.max(120, Number(maxChars) || 260);
  const bodyBudget = Math.max(60, budget - prefix.length);
  const compact = `${prefix}${clampTextHeadTail(content, bodyBudget, 0.42)}`;
  return clampTextHeadTail(sanitizeMainPromptMemoryText(compact), budget, 0.42);
}

function safePromptMemoryText(kind, item, limit = 1800) {
  if (!item) return '';
  const text = kind === 'godlog'
    ? safeGodlogMemoryText(item.body || '')
    : cleanText(item.body || '')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/^\s*>?\s*(?:\uD83D\uDCD6\s*)?(?:场景|剧情|逐楼)?摘要\s*[：:·].*$/gm, '')
      .replace(/^\s*[-*]?\s*(?:场景|剧情|逐楼)?摘要\s*[：:·].*$/gm, '')
      .trim();
  return clampText(sanitizeMainPromptMemoryText(text), limit);
}

function safeCodexText(text, limit = 2200) {
  return clampText(sanitizeMainPromptMemoryText(cleanText(text)
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*>?\s*(?:\uD83D\uDCD6\s*)?(?:场景|剧情|逐楼)?摘要\s*[：:·].*$/gm, '')
    .replace(/^\s*[-*]?\s*(?:场景|剧情|逐楼)?摘要\s*[：:·].*$/gm, '')
    .trim()), limit);
}

function stableHash(input) {
  let hash = 2166136261;
  const text = String(input || '');
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function scheduleMessageKeySave() {
  if (state.messageKeySaveTimer) return;
  state.messageKeySaveTimer = setTimeout(() => {
    state.messageKeySaveTimer = null;
    saveChatNow();
  }, 800);
}

function persistentMessageIdentity(message) {
  return message?.send_date
    || message?.extra?.message_id
    || message?.message_id
    || message?.extra?.id
    || message?.id
    || message?.created_at
    || '';
}

function stableFallbackMessageKey(message, index) {
  if (!message || typeof message !== 'object') return '';
  try {
    if (!message.anchor_memory_meta || typeof message.anchor_memory_meta !== 'object') {
      message.anchor_memory_meta = {};
    }
    const meta = message.anchor_memory_meta;
    if (!meta.stableMessageKey) {
      // Always adopt a plugin-owned key, even when SillyTavern currently exposes send_date/id.
      // Those host fields may be attached or normalized after generation; preferring them made the
      // same floor suddenly look like a different row after prompt-injection metadata was saved.
      meta.stableMessageKey = makeStableMessageKey({
        persistentIdentity: persistentMessageIdentity(message),
        role: messageRole(message),
        index,
        uuid: globalThis.crypto?.randomUUID?.() || '',
      });
      scheduleMessageKeySave();
    }
    return String(meta.stableMessageKey || '');
  } catch {
    return '';
  }
}

function messageKey(message, index) {
  // A floor has one plugin-owned identity for its whole lifetime. Host IDs, send_date, prompt
  // injection bookkeeping, hidden flags and later render metadata must never re-key a completed
  // summary. Actual content revisions are tracked separately by rawHash.
  return stableFallbackMessageKey(message, index)
    || `legacy:${index}:${messageRole(message)}:${stableHash(message?.name || '')}`;
}

function memoryHideMeta(message) {
  const meta = message?.anchor_memory_meta;
  return meta && typeof meta === 'object' ? meta : null;
}

function isMemoryManagedHidden(message) {
  const meta = memoryHideMeta(message);
  return !!(
    meta?.hiddenByMemory === true
    || (Array.isArray(meta?.hiddenAnchorIds) && meta.hiddenAnchorIds.length > 0)
  );
}

function hasMemoryHideOwnership(message) {
  const meta = memoryHideMeta(message);
  if (!meta) return false;
  return isMemoryManagedHidden(message)
    || Object.prototype.hasOwnProperty.call(meta, 'wasHiddenBeforeAnchor')
    || Object.prototype.hasOwnProperty.call(meta, 'wasSystemBeforeAnchor');
}

function isNarrativeMessage(message) {
  // SillyTavern's official hide implementation may mark a hidden chat message as `is_system`.
  // Messages hidden by this extension remain narrative source material and must still be visible to
  // the memory indexer, while genuine system messages must never become role-play floors.
  return !!message && (!message.is_system || isMemoryManagedHidden(message));
}

function messageRole(message) {
  if (message?.is_user) return 'user';
  if (message?.is_system && !isMemoryManagedHidden(message)) return 'system';
  return 'assistant';
}

function turnTextForAssistant(chat, index) {
  const parts = [];
  let start = index;
  for (let i = index - 1; i >= 0; i--) {
    const message = chat[i];
    if (!message || !isNarrativeMessage(message)) continue;
    if (!message.is_user) break;
    start = i;
  }
  for (let i = start; i <= index; i++) {
    const message = chat[i];
    if (!message || !isNarrativeMessage(message) || !message.mes) continue;
    const text = cleanText(message.mes);
    if (!text) continue;
    const role = message.is_user ? '用户输入' : 'AI回复';
    // Hidden state is deliberately ignored here. Hiding is only a prompt/UI policy and must never
    // change the source fingerprint, otherwise refreshes invalidate perfectly valid summaries.
    parts.push(`【${role}｜第${i}楼｜${message.name || '未命名'}】
${text}`);
  }
  return parts.join('\n\n');
}

function invalidateMemoryDataCache() {
  state.memoryMetadataRef = null;
  state.memoryDataRef = null;
  state.memoryDataReady = false;
  state.recallTermCache.clear();
}

function invalidateRuntimeCaches(reason = '') {
  state.chatRowsCache.clear();
  state.chatCacheRef = null;
  state.chatCacheLength = -1;
  state.chatCacheTailSignature = '';
  state.godlogIndexData = null;
  state.godlogIndexArray = null;
  state.godlogIndexLength = -1;
  state.godlogByKey = new Map();
  if (reason) console.debug?.('[AnchorMemory] runtime cache invalidated:', reason);
}

function chatTailSignature(chat) {
  const last = chat?.[chat.length - 1];
  if (!last) return `${chat?.length || 0}:empty`;
  const text = String(last.mes || '');
  return [
    chat.length,
    last.send_date || last.message_id || last.id || '',
    text.length,
    stableHash(text),
    last.is_hidden ? 1 : 0,
    last.is_user ? 1 : 0,
    isMemoryManagedHidden(last) ? 1 : 0,
  ].join(':');
}

function ensureChatRowsCacheFresh(chat) {
  const signature = chatTailSignature(chat);
  if (state.chatCacheRef !== chat
      || state.chatCacheLength !== chat.length
      || state.chatCacheTailSignature !== signature) {
    state.chatRowsCache.clear();
    state.chatCacheRef = chat;
    state.chatCacheLength = chat.length;
    state.chatCacheTailSignature = signature;
  }
}

function chatRows(includeHidden = false, includeUser = false) {
  const chat = getContext().chat || [];
  ensureChatRowsCacheFresh(chat);
  const cacheKey = `${includeHidden ? 1 : 0}:${includeUser ? 1 : 0}`;
  const cached = state.chatRowsCache.get(cacheKey);
  if (cached) return cached;

  const rows = [];
  let assistantNumber = 0;
  for (let index = 0; index < chat.length; index++) {
    const message = chat[index];
    if (!message || !isNarrativeMessage(message) || !message.mes) continue;
    const role = messageRole(message);
    // Count every narrative assistant floor before display filtering so the Nub value remains stable
    // even when old messages are hidden by SillyTavern or Anchor Memory.
    if (role === 'assistant') assistantNumber++;
    if (!includeHidden && (message.is_hidden || isMemoryManagedHidden(message))) continue;
    if (!includeUser && message.is_user) continue;
    const text = cleanText(message.mes);
    if (!text) continue;
    const turnText = message.is_user ? text : turnTextForAssistant(chat, index);
    rows.push({
      index,
      key: messageKey(message, index),
      role,
      name: message.name || '',
      text,
      turnText,
      rawHash: stableHash(turnText || text),
      sendDate: message.send_date || '',
      assistantNumber: message.is_user ? 0 : assistantNumber,
    });
  }
  state.chatRowsCache.set(cacheKey, rows);
  return rows;
}

function godlogIndex(data) {
  const list = data?.godlogs || [];
  if (state.godlogIndexData !== data
      || state.godlogIndexArray !== list
      || state.godlogIndexLength !== list.length) {
    state.godlogIndexData = data;
    state.godlogIndexArray = list;
    state.godlogIndexLength = list.length;
    state.godlogByKey = new Map();
    for (const item of list) {
      if (item && !item.archived && item.key) state.godlogByKey.set(item.key, item);
    }
  }
  return state.godlogByKey;
}

function godlogForRow(data, row) {
  if (!row?.key) return null;
  return godlogIndex(data).get(row.key) || null;
}

function godlogNumberForRow(row) {
  if (!row) return 0;
  return Math.max(0, Number(row.assistantNumber) || 0);
}

function syncGodlogNumber(item, row) {
  if (!item || !row) return false;
  const number = godlogNumberForRow(row);
  if (!number) return false;
  let changed = false;
  if (Number(item.number) !== number) {
    item.number = number;
    changed = true;
  }
  if (item.body) {
    const nextBody = replaceGodlogField(item.body, 'Nub', String(number));
    if (nextBody !== item.body) {
      item.body = nextBody;
      changed = true;
    }
  }
  return changed;
}

function syncGodlogCount(data) {
  const numbers = (data.godlogs || [])
    .filter(item => !item.archived && Number.isFinite(Number(item.number)))
    .map(item => Number(item.number));
  data.processing.godlogCount = numbers.length ? Math.max(...numbers) : 0;
}

function isGodlogReady(item, row = null) {
  // Completed summaries are durable snapshots. A later prompt injection, render refresh, tool
  // payload, swipe metadata update or even a deliberate text edit must not silently turn the card
  // into “missing” and start a background rewrite. The user explicitly chooses when to replace it
  // through “重跑本楼摘要” or by editing/saving the summary.
  if (!isCompletedSummary(item)) return false;
  if (row && item.archived) return false;
  return true;
}


function isGodlogMissingOrStale(data, row) {
  const item = godlogForRow(data, row);
  if (!item) return true;
  if (item.status === 'failed') {
    const s = settings();
    return !!(secondaryConfigured(s) && (item.retryCount || 0) < 3);
  }
  if (item.status === 'orphaned') return false;
  return !isGodlogReady(item, row);
}

function upsertGodlog(data, row, patch = {}) {
  let item = godlogForRow(data, row);
  const number = godlogNumberForRow(row) || data.processing.godlogCount + 1;
  if (!item) {
    item = {
      id: `am_godlog_${Date.now()}_${row.index}_${stableHash(row.key).slice(0, 6)}`,
      kind: 'godlog',
      number,
      floor: row.index,
      key: row.key,
      role: row.role,
      name: row.name,
      sendDate: row.sendDate,
      assistantNumber: row.assistantNumber || 0,
      rawHash: row.rawHash,
      body: '',
      status: 'pending',
      retryCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      error: '',
    };
    data.godlogs.push(item);
  }
  Object.assign(item, {
    number,
    floor: row.index,
    role: row.role,
    name: row.name,
    sendDate: row.sendDate,
    assistantNumber: row.assistantNumber || item.assistantNumber || 0,
    rawHash: row.rawHash,
    updatedAt: Date.now(),
  }, patch);
  if (item.body) item.body = replaceGodlogField(item.body, 'Nub', String(item.number));
  syncGodlogCount(data);
  return item;
}

function rebuildGodlogTimelinePartition(data) {
  const rows = chatRows(true).filter(row => row.role === 'assistant');
  const readiness = rows.map(row => ({ row, godlog: godlogForRow(data, row) }));
  let lastReadyIndex = -1;
  readiness.forEach((entry, index) => {
    if (isGodlogReady(entry.godlog, entry.row)) lastReadyIndex = index;
  });
  const committedWindow = lastReadyIndex >= 0 ? readiness.slice(0, lastReadyIndex + 1) : [];
  return {
    materials: committedWindow
      .filter(({ row, godlog }) => isGodlogReady(godlog, row))
      .map(({ row, godlog }) => ({ row, godlog, mode: 'godlog' })),
    // Only a hole inside already-completed history is unsafe. Newest trailing floors that are still
    // streaming or waiting for their first summary must not freeze a rollback/rebuild of older data.
    blockedRows: committedWindow
      .filter(({ row, godlog }) => !isGodlogReady(godlog, row))
      .map(({ row }) => row),
    trailingRows: readiness
      .slice(lastReadyIndex + 1)
      .filter(({ row, godlog }) => !isGodlogReady(godlog, row))
      .map(({ row }) => row),
  };
}

function validGodlogMaterials(data) {
  return rebuildGodlogTimelinePartition(data).materials;
}

function blockedRebuildGodlogRows(data) {
  return rebuildGodlogTimelinePartition(data).blockedRows;
}

function anchorMaterialForRow(data, row, rows = chatRows(true)) {
  const godlog = godlogForRow(data, row);
  if (isGodlogReady(godlog, row)) return { row, godlog, mode: 'godlog' };
  // A failed/pending summary must not permanently freeze every later 15-turn anchor. Keep the
  // strict chronological boundary, but once the floor has left the recent raw window, use its
  // authoritative turn text as a bounded emergency material. The normal Godlog remains pending.
  if (rawFallbackEligible(row, rows)) {
    return { row, godlog: null, mode: 'raw-fallback', fallbackText: rawFallbackTextForRow(row, 8000) };
  }
  return null;
}

function pendingAnchorMaterials(data) {
  refreshCoverageMaps(data);
  const anchored = data.processing.anchoredKeys || {};
  const merged = data.processing.mergedKeys || {};
  const materials = [];
  const rows = chatRows(true).filter(item => item.role === 'assistant');
  // Preserve a chronological prefix. Missing floors inside the recent raw window still wait for
  // their normal summary; older missing floors use a bounded raw fallback so later memory cannot
  // cascade into an ever-growing unanchored tail.
  for (const row of rows) {
    if (merged[row.key] || anchored[row.key]) continue;
    const material = anchorMaterialForRow(data, row, rows);
    if (!material) break;
    materials.push(material);
  }
  return materials;
}

function readyGodlogMemoryItems(data) {
  return (data?.godlogs || [])
    .filter(item => item?.status === 'ready' && item.body && !item.stale);
}

function pendingRows(data) {
  refreshCoverageMaps(data);
  return chatRows(true)
    .filter(row => row.role === 'assistant')
    .filter(row => !data.processing.mergedKeys[row.key] && !data.processing.anchoredKeys[row.key]);
}

function pendingGodlogRows(data) {
  return chatRows(true)
    .filter(row => row.role === 'assistant')
    .filter(row => isGodlogMissingOrStale(data, row));
}

function hasPendingMemoryWork() {
  if (!hasPersistentChatContext() || !secondaryConfigured()) return false;
  const data = memoryData();
  const anchorInterval = normalizeAnchorInterval(settings().anchorInterval);
  const mergeAnchorInterval = normalizeMergeAnchorInterval(settings().mergeAnchorInterval);
  return pendingGodlogRows(data).length > 0
    || pendingAnchorMaterials(data).length >= anchorInterval
    || mergeCycleAnchors(data).length >= mergeAnchorInterval
    || !!data.processing?.codexDirty
    || !!data.processing?.relationshipDirty
    || pendingCodexRows(data).length > 0;
}

function pendingCodexRows(data) {
  if (data.processing?.codexDirty) return [];
  if (!secondaryConfigured()) return [];
  const codexKeys = data.processing?.codexKeys || {};
  return chatRows(true)
    .filter(row => row.role === 'assistant')
    .map(row => ({ row, godlog: godlogForRow(data, row) }))
    .filter(({ row, godlog }) => isGodlogReady(godlog, row) && codexKeys[row.key] !== summaryRevisionHash(godlog, row));
}

function missingGodlogRepairRows(data) {
  return chatRows(true)
    .filter(row => row.role === 'assistant')
    .filter(row => !isGodlogReady(godlogForRow(data, row), row));
}

function missingGodlogDiagnostics(data) {
  const rows = chatRows(true).filter(row => row.role === 'assistant');
  return rows
    .map((row, index) => {
      const item = godlogForRow(data, row);
      if (isGodlogReady(item, row)) return null;
      const newerAssistantCount = rows.length - index - 1;
      const hardFailed = item?.status === 'failed' || (item?.retryCount || 0) >= 3;
      const hasError = !!item?.error;
      const late = newerAssistantCount >= MISSING_GODLOG_WARNING_MIN_NEWER;
      if (!hardFailed && !hasError && !late) return null;
      return { row, item, newerAssistantCount, status: item?.status || 'missing' };
    })
    .filter(Boolean);
}

function newerAssistantCountForRow(row) {
  if (!row) return 0;
  return chatRows(true).filter(candidate => candidate.role === 'assistant' && candidate.index > row.index).length;
}

function missingGodlogUiStatus(row, data = memoryData()) {
  const item = row ? godlogForRow(data, row) : null;
  if (item?.status) return item.status;
  const hasSecondary = secondaryConfigured();
  if (!hasSecondary) return 'missing';
  if (row && (generationIsActiveForGodlog(row) || !isRowSettledForGodlog(row))) return 'pending';
  return newerAssistantCountForRow(row) >= MISSING_GODLOG_WARNING_MIN_NEWER ? 'missing' : 'pending';
}

function missingGodlogUiText(row, data = memoryData()) {
  if (row && generationIsActiveForGodlog(row)) return '正文仍在生成，摘要请求尚未发出；正文结束并稳定后会自动开始。';
  if (row && !isRowSettledForGodlog(row)) return '正文已结束，正在等待内容稳定；稳定后会自动开始摘要。';
  const status = missingGodlogUiStatus(row, data);
  if (status === 'pending') return '正文已稳定，等待后台自动生成逐楼摘要。';
  if (!secondaryConfigured()) return '尚未生成逐楼摘要；配置副API后可自动补写。';
  return '这楼已经落后仍无有效摘要；点“自动补写缺失摘要”会调用模型补写。';
}

function syntheticGodlogId(row) {
  return `am_missing_godlog_${stableHash(row?.key || row?.index || '')}`;
}

function rowFromSyntheticGodlogId(id) {
  const value = String(id || '');
  if (!value.startsWith('am_missing_godlog_')) return null;
  return chatRows(false).find(row => syntheticGodlogId(row) === value) || null;
}

function godlogListEntries(data) {
  const stored = (data.godlogs || []).map(item => ({ item, synthetic: false }));
  const storedKeys = new Set(stored.map(({ item }) => item.key));
  const missing = missingGodlogRepairRows(data)
    .filter(row => !storedKeys.has(row.key))
    .map(row => ({
      synthetic: true,
      row,
      item: {
        id: syntheticGodlogId(row),
        number: godlogNumberForRow(row),
        floor: row.index,
        key: row.key,
        role: row.role,
        name: row.name,
        sendDate: row.sendDate,
        rawHash: row.rawHash,
        body: '',
        status: missingGodlogUiStatus(row, data),
        error: missingGodlogUiText(row, data),
      },
    }));
  return [...stored, ...missing];
}

function maybeWarnMissingGodlogs(data = memoryData()) {
  if (!settings().enabled) return;
  const issues = missingGodlogDiagnostics(data);
  if (issues.length === 0) {
    state.lastMissingGodlogWarningSignature = '';
    return;
  }

  const signature = issues
    .map(({ row, item, status }) => `${row.key}:${row.rawHash}:${status}:${item?.retryCount || 0}:${item?.error || ''}`)
    .join('|');
  const now = Date.now();
  if (
    signature === state.lastMissingGodlogWarningSignature
    && now - state.lastMissingGodlogWarningAt < MISSING_GODLOG_WARNING_COOLDOWN
  ) {
    return;
  }

  state.lastMissingGodlogWarningSignature = signature;
  state.lastMissingGodlogWarningAt = now;

  const floors = issues.slice(0, 4).map(({ row }) => `第 ${row.index} 楼`).join('、');
  const suffix = issues.length > 4 ? `等 ${issues.length} 楼` : '';
  const canRetry = secondaryConfigured();
  const retryText = canRetry
    ? '插件会继续自动重试；也可在锚点书的“逐楼摘要”页点击“自动补写缺失摘要”立即重跑。'
    : '请先在锚点书中补全副API，再到“逐楼摘要”页点击“自动补写缺失摘要”。';
  const currentSettings = settings();
  const message = `${floors}${suffix} 没有生成逐楼摘要。${retryText}该楼仍会保持待补写状态；若它离开最近原文窗口，插件会临时注入受限保底原文，并允许后续锚点继续推进，避免一楼失败拖出整段记忆断层。`;

  console.warn('[AnchorMemory] missing Godlog rows detected:', issues.map(({ row, item }) => ({
    floor: row.index,
    status: item?.status || 'missing',
    error: item?.error || '',
  })));
  if (toastr?.warning) {
    toastr.warning(message, 'Anchor Memory', {
      timeOut: 14000,
      extendedTimeOut: 8000,
      closeButton: true,
      tapToDismiss: true,
    });
  } else {
    showStatus(message);
  }
}

function rawFallbackTextForRow(row, maxChars = 1800) {
  const source = sanitizeMainPromptMemoryText(row?.turnText || row?.text || '');
  if (!source) return '';
  return clampTextHeadTail(source, Math.max(320, Number(maxChars) || 1800), 0.38);
}

function rawFallbackEligible(row, rows = chatRows(true)) {
  if (!row || row.role !== 'assistant' || !(row.turnText || row.text)) return false;
  const recentKeys = new Set((rows || [])
    .filter(item => item.role === 'assistant')
    .slice(-Math.max(1, Number(settings().keepRecent) || 3))
    .map(item => item.key));
  return !recentKeys.has(row.key);
}

function formatGodlogMaterials(materials) {
  const fallbackCount = (materials || []).filter(item => item?.mode === 'raw-fallback').length;
  const fallbackBudget = fallbackCount
    ? Math.max(2400, Math.floor(MISSING_RAW_FALLBACK_ANCHOR_TOTAL_CHAR_BUDGET / fallbackCount))
    : 0;
  return (materials || [])
    .map(item => {
      const { row, godlog } = item || {};
      if (!row) return '';
      const label = `#${row.index} ${row.sendDate ? `[${row.sendDate}] ` : ''}${row.name || '未命名'}`;
      if (item.mode === 'raw-fallback') {
        const fallback = item.fallbackText || rawFallbackTextForRow(row, Math.min(8000, fallbackBudget));
        if (!fallback) return '';
        return `${label}
【逐楼摘要暂缺｜保底原文，仅用于维持本批时间线】
${fallback}`;
      }
      if (!godlog?.body) return '';
      return `${label}
${godlog.body}`;
    })
    .filter(Boolean)
    .join('\n\n---\n\n');
}

function anchorSourcePosition(anchor, rowIndex = null) {
  const positions = (anchor?.sourceKeys || [])
    .map(key => rowIndex?.get(key))
    .filter(Number.isFinite);
  if (positions.length) return Math.min(...positions);
  const floors = (anchor?.sourceFloors || []).filter(Number.isFinite);
  return floors.length ? Math.min(...floors) : Number.MAX_SAFE_INTEGER;
}

function activeAnchors(data) {
  const rowIndex = new Map(chatRows(true).map(row => [row.key, row.index]));
  return (data?.anchors || [])
    .filter(item => item && !item.stale && item.active !== false)
    .sort((a, b) => anchorSourcePosition(a, rowIndex) - anchorSourcePosition(b, rowIndex) || (a.createdAt || 0) - (b.createdAt || 0));
}

function renumberDerivedMemory(data) {
  if (!data) return false;
  let changed = false;
  const sortedAnchors = activeAnchors(data);
  if (sortedAnchors.length === (data.anchors || []).length) data.anchors = sortedAnchors;
  data.anchors.forEach((anchor, index) => {
    const number = index + 1;
    if (Number(anchor.number) !== number) {
      anchor.number = number;
      anchor.body = String(anchor.body || '').replace(/^###\s*第\s*\d+\s*次锚点记录/m, `### 第 ${number} 次锚点记录`);
      changed = true;
    }
  });
  data.merges.sort((a, b) => (Number(a.coverageCount) || Number(a.floorAt) || 0) - (Number(b.coverageCount) || Number(b.floorAt) || 0) || (a.createdAt || 0) - (b.createdAt || 0));
  data.merges.forEach((merge, index) => {
    const number = index + 1;
    if (Number(merge.number) !== number) {
      merge.number = number;
      merge.body = String(merge.body || '').replace(/^###\s*第\s*\d+\s*次全量合并锚点/m, `### 第 ${number} 次全量合并锚点`);
      changed = true;
    }
  });
  data.processing.anchorCount = data.anchors.length;
  data.processing.mergeCount = data.merges.length;
  return changed;
}

function activeMerges(data) {
  return (data?.merges || []).filter(item => item && !item.stale && item.active !== false);
}

function latestAnchor(data) {
  const list = activeAnchors(data);
  return list[list.length - 1] || null;
}

function latestMerge(data) {
  const list = activeMerges(data);
  return list[list.length - 1] || null;
}

function latestMergeKeySet(data) {
  return new Set(latestMerge(data)?.sourceKeys || []);
}

function activeAnchorsAfterMerge(data) {
  const merged = latestMergeKeySet(data);
  return activeAnchors(data).filter(anchor => {
    const keys = anchor.sourceKeys || [];
    return keys.length > 0 && keys.some(key => !merged.has(key));
  });
}

function mergeCycleAnchors(data) {
  return activeAnchorsAfterMerge(data)
    .filter(anchor => Array.isArray(anchor.sourceKeys) && anchor.sourceKeys.length > 0)
    .sort((a, b) => (Math.min(...(a.sourceFloors || [Number.MAX_SAFE_INTEGER])) - Math.min(...(b.sourceFloors || [Number.MAX_SAFE_INTEGER])))
      || (Number(a.number) || 0) - (Number(b.number) || 0));
}

function mergeCycleMaterials(data) {
  const merged = latestMergeKeySet(data);
  const rows = chatRows(true).filter(item => item.role === 'assistant');
  const anchorCovered = new Set(activeAnchorsAfterMerge(data).flatMap(anchor => anchor.sourceKeys || []));
  const result = [];
  for (const row of rows) {
    if (merged.has(row.key)) continue;
    const godlog = godlogForRow(data, row);
    if (isGodlogReady(godlog, row)) {
      result.push({ row, godlog, mode: 'godlog' });
      continue;
    }
    // Normally the missing row is already represented by a raw-fallback anchor. Retain a bounded
    // raw copy as a final guard for legacy/cross-boundary anchors or a merge that becomes due first.
    if (anchorCovered.has(row.key) || rawFallbackEligible(row, rows)) {
      result.push({
        row,
        godlog: null,
        mode: anchorCovered.has(row.key) ? 'anchor-covered' : 'raw-fallback',
        fallbackText: rawFallbackTextForRow(row, 8000),
      });
      continue;
    }
    break;
  }
  return result;
}

function clampText(text, maxChars) {
  const value = String(text || '').trim();
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[trimmed]`;
}

function clampTextHeadTail(text, maxChars, headRatio = 0.34) {
  const value = String(text || '').trim();
  const limit = Math.max(200, Number(maxChars) || 0);
  if (value.length <= limit) return value;
  const marker = '\n...[中段因上下文预算省略；保留开端与最近剧情]...\n';
  const available = Math.max(1, limit - marker.length);
  const head = Math.max(1, Math.floor(available * Math.min(0.75, Math.max(0.15, headRatio))));
  const tail = Math.max(1, available - head);
  return `${value.slice(0, head)}${marker}${value.slice(-tail)}`;
}

function buildRebuildTimelineSource(data, materials, maxChars = 42000) {
  const full = formatGodlogMaterials(materials || []);
  const limit = Math.max(4000, Number(maxChars) || 42000);
  if (full.length <= limit) return full;

  // For very long chats, keep the cumulative/15-turn compressed spine plus both the opening and
  // latest detailed Godlogs. The latest raw-window turns must be present here as summaries as well;
  // buildCoreInjection() intentionally omits them for normal prompt injection and is therefore not
  // suitable as a rebuild source by itself.
  const compact = [];
  const merge = latestMerge(data);
  if (merge?.body) compact.push(`## 累计历史锚点\n${safePromptMemoryText('merge', merge, 14000)}`);
  for (const anchor of activeAnchorsAfterMerge(data)) {
    if (anchor?.body) compact.push(`## 第 ${anchor.number} 次锚点\n${safePromptMemoryText('anchor', anchor, 6500)}`);
  }
  const compactText = compact.join('\n\n');
  if (!compactText) return clampTextHeadTail(full, limit, 0.3);
  const compactBudget = Math.min(17000, Math.floor(limit * 0.42));
  const detailBudget = Math.max(3000, limit - compactBudget - 80);
  return [
    clampTextHeadTail(compactText, compactBudget, 0.3),
    `## 开端与最近逐楼摘要\n${clampTextHeadTail(full, detailBudget, 0.3)}`,
  ].filter(Boolean).join('\n\n');
}

function codexRebuildSourceSignature(data, materials) {
  const ctx = getContext();
  return stableHash(JSON.stringify({
    tracked: trackedCharacterNames(data, ctx),
    user: ctx.name1 || '{{user}}',
    relationshipNames: normalizeRelationshipTable(data.relationshipTable).rows.map(row => row.name),
    materials: (materials || []).map(({ row, godlog }) => ({
      key: row?.key || '',
      floor: Number(row?.index ?? -1),
      revision: summaryRevisionHash(godlog, row),
    })),
  }));
}

function buildCodexRebuildChunks(materials, maxRows = CODEX_REBUILD_CHUNK_MAX_ROWS, maxChars = CODEX_REBUILD_CHUNK_MAX_CHARS) {
  const chunks = [];
  let current = [];
  let chars = 0;
  for (const material of materials || []) {
    const rendered = formatGodlogMaterials([material]);
    const size = rendered.length;
    if (current.length > 0 && (current.length >= maxRows || chars + size > maxChars)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(material);
    chars += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function normalizeCodexRebuildCheckpoint(data, materials, chunks) {
  const signature = codexRebuildSourceSignature(data, materials);
  const existing = data.processing?.codexRebuildCheckpoint;
  const validExisting = existing
    && existing.version === 1
    && existing.signature === signature
    && Number.isInteger(Number(existing.cursor))
    && Number(existing.cursor) >= 0
    && Number(existing.cursor) <= chunks.length
    && existing.candidateCodex
    && existing.candidateRelationship;
  if (validExisting) {
    return {
      ...existing,
      cursor: Number(existing.cursor),
      totalChunks: chunks.length,
      candidateCodex: normalizedCodex(existing.candidateCodex),
      candidateRelationship: normalizeRelationshipTable(existing.candidateRelationship),
    };
  }
  return {
    version: 1,
    signature,
    cursor: 0,
    totalChunks: chunks.length,
    candidateCodex: { ...defaultData().codex },
    candidateRelationship: relationshipSchemaOnly(data.relationshipTable),
    startedAt: Date.now(),
    updatedAt: Date.now(),
    lastCompletedFloor: -1,
  };
}

function codexRebuildRetryDelay(failures) {
  const exponent = Math.max(0, Math.min(6, Number(failures || 1) - 1));
  return Math.min(CODEX_REBUILD_RETRY_MAX_MS, CODEX_REBUILD_RETRY_BASE_MS * (2 ** exponent));
}

function buildCodexRebuildChunkPrompt(data, candidate, chunk, chunkIndex, chunkCount) {
  const ctx = getContext();
  const charName = trackedCharacterLabel(data, ctx);
  const trackedNames = trackedCharacterNames(data, ctx);
  const userName = ctx.name1 || '{{user}}';
  const rows = chunk.map(entry => entry.row).filter(Boolean);
  const startFloor = (rows[0]?.index ?? 0) + 1;
  const endFloor = (rows.at(-1)?.index ?? 0) + 1;
  const facts = formatGodlogMaterials(chunk);
  const currentCodex = normalizedCodex(candidate.codex);
  const currentRelationship = normalizeRelationshipTable(candidate.relationshipTable);

  return `你是长篇角色扮演的后台状态索引员。现在按时间顺序执行一次可续跑的分段重建。本次是第 ${chunkIndex + 1}/${chunkCount} 段，覆盖第 ${startFloor}-${endFloor} 楼。

任务：把“本段新增有效剧情记忆”合并进“前段已重建状态”，输出截至本段结尾的完整当前状态快照。前段已有条目本段没有提及时必须保留；只有本段事实明确证明其变化、失效或应删除时才修改。只记录已经发生且有依据的事实，不预测，不输出代码块或HTML。

人物纪要追踪白名单只有：${trackedNames.join('、') || charName}。人物纪要必须一人一行，绝对禁止出现玩家 ${userName}；出场人物库则绝对禁止出现白名单主角和玩家。

${renderMemoryRules(settings().characterRules || DEFAULT_CHARACTER_RULES, data, ctx)}

${renderMemoryRules(settings().peopleRules || DEFAULT_PEOPLE_RULES, data, ctx)}

${renderMemoryRules(settings().itemRules || DEFAULT_ITEM_RULES, data, ctx)}

【人物关系】是用户定义的固定名单：只允许填写“过去/发展/当前”三列，必须保留名称列、行数和顺序，不得新增、删除、改名或交换行。每一行均表示该人物与${userName}的关系。

输出必须严格包含且只包含以下结构：

**【人物关系】**
${relationshipTableMarkdown(currentRelationship, true)}

**当前时间：** 剧情内时间；无法判断写“未明”
**当前地点：** 地点；无法判断写“未明”

**【人物纪要】**
| 角色名 | 身份/标签 | 原始楼层 | 触发事件 | 心态转变 | 当前变化 |
| :--- | :--- | :--- | :--- | :--- | :--- |

**【出场人物库】**
| 角色名 | 身份/标签 | 当前状态与核心作用 | 与${userName}的关系 | 与${charName}的关系 |
| :--- | :--- | :--- | :--- | :--- |

**【重要道具、梗与核心细节】**
| 物品/细节/内部梗 | 绑定人物 | 核心象征意义与影响 |
| :--- | :--- | :--- |

**【场景记录】**
| 场景/地点 | 时间 | 人物 | 已发生事实 |
| :--- | :--- | :--- | :--- |

## 前段已重建状态
当前时间：${currentCodex.currentTime || '未明'}
当前地点：${currentCodex.currentPlace || '未明'}

${currentCodex.characterMemo || '**【人物纪要】**\n（暂无）'}

${currentCodex.peopleIndex || '**【出场人物库】**\n（暂无）'}

${currentCodex.itemIndex || '**【重要道具、梗与核心细节】**\n（暂无）'}

${currentCodex.sceneIndex || '**【场景记录】**\n（暂无）'}

## 本段新增有效剧情记忆
${facts}`;
}

function renderMacros(text, ctx = getContext()) {
  const charName = String(ctx?.name2 || '{{char}}');
  const userName = String(ctx?.name1 || '{{user}}');
  return String(text || '')
    .replace(/\{\{\s*char\s*\}\}/gi, charName)
    .replace(/\{\{\s*user\s*\}\}/gi, userName);
}

function renderTemplate(text) {
  return renderMacros(text);
}

function sectionFrom(markdown, title) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\*\\*【[^】]*${escaped}[^】]*】\\*\\*([\\s\\S]*?)(?=\\n\\*\\*【|$)`, 'i');
  const match = String(markdown || '').match(pattern);
  return match ? match[0].trim() : '';
}

function valueAfterLabel(markdown, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(markdown || '').match(new RegExp(`\\*\\*${escaped}[:：]\\*\\*\\s*([^\\n]+)`));
  return match ? match[1].trim() : '';
}



function usefulCodexValue(value) {
  const text = cleanText(value).trim();
  if (!text) return '';
  if (/^(?:未明|暂无|无|无变化|不变|未记录)[。.]?$/i.test(text)) return '';
  return text;
}

function usefulCodexSection(section) {
  const text = String(section || '').trim();
  if (!text) return '';
  const body = text
    .replace(/^\s*\*\*【[^】]+】\*\*\s*/i, '')
    .trim();
  if (!body || /^(?:暂无|无|无变化|不变|未记录)[。.]?$/i.test(body)) return '';
  if (parseMarkdownTable(text).length === 0 && /^(?:\|.*\|\s*)+$/m.test(body)) return '';
  return text;
}

function markdownTableOnly(headers, rows) {
  const safeCell = value => cleanText(String(value ?? ''))
    .replace(/\|/g, '／')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const header = `| ${headers.join(' | ')} |`;
  const divider = `| ${headers.map(() => ':---').join(' | ')} |`;
  const body = (rows || []).map(row => `| ${headers.map(key => safeCell(row?.[key] || '')).join(' | ')} |`);
  return [header, divider, ...body].join('\n');
}

function markdownTableSection(title, headers, rows) {
  return [`**【${title}】**`, markdownTableOnly(headers, rows)].join('\n');
}

function entityNameMatches(left, right) {
  const a = normalizeEntityMatchText(left);
  const b = normalizeEntityMatchText(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const min = Math.min(a.length, b.length);
  return min >= 3 && (a.includes(b) || b.includes(a));
}

function tableRowName(row) {
  return row?.['角色名'] || row?.['人物'] || row?.['名称'] || row?.['姓名'] || '';
}

function sanitizeCharacterMemoSection(data, incomingSection) {
  const headers = ['角色名', '身份/标签', '原始楼层', '触发事件', '心态转变', '当前变化'];
  const tracked = trackedCharacterNames(data);
  const userName = getContext().name1 || '';
  const currentRows = parseMarkdownTable(data?.codex?.characterMemo || '');
  const incomingRows = parseMarkdownTable(incomingSection || '');
  const findRow = (rows, name) => rows.find(row => entityNameMatches(tableRowName(row), name));
  const result = [];
  for (const name of tracked) {
    let row = findRow(incomingRows, name) || findRow(currentRows, name);
    if (row && entityNameMatches(tableRowName(row), userName)) row = null;
    result.push({
      '角色名': name,
      '身份/标签': row?.['身份/标签'] || row?.['身份标签'] || '未明',
      '原始楼层': row?.['原始楼层'] || row?.['首次/来源'] || '未明',
      '触发事件': row?.['触发事件'] || '暂无明确变化',
      '心态转变': row?.['心态转变'] || '暂无明确变化',
      '当前变化': row?.['当前变化'] || '暂无明确变化',
    });
  }
  if (result.length === 0) return '';
  return markdownTableSection('人物纪要', headers, result);
}

function firstTableValue(row, exactKeys = [], includes = []) {
  for (const key of exactKeys) {
    if (row?.[key]) return row[key];
  }
  const entries = Object.entries(row || {});
  for (const needle of includes) {
    const match = entries.find(([key, value]) => value && String(key).includes(needle));
    if (match) return match[1];
  }
  return '';
}

function sanitizePeopleIndexSection(data, incomingSection) {
  const ctx = getContext();
  const userName = ctx.name1 || '{{user}}';
  const trackedLabel = trackedCharacterLabel(data, ctx);
  const headers = ['角色名', '身份/标签', '当前状态与核心作用', `与${userName}的关系`, `与${trackedLabel}的关系`];
  const tracked = trackedCharacterNames(data, ctx);
  const keepNpcRow = row => {
    const name = tableRowName(row);
    if (!name || entityNameMatches(name, userName)) return false;
    return !tracked.some(charName => entityNameMatches(name, charName));
  };
  let rows = parseMarkdownTable(incomingSection || '').filter(keepNpcRow);
  if (rows.length === 0) rows = parseMarkdownTable(data?.codex?.peopleIndex || '').filter(keepNpcRow);
  if (rows.length === 0) return '';
  const normalized = rows.map(row => ({
    '角色名': tableRowName(row),
    '身份/标签': firstTableValue(row, ['身份/标签', '身份标签', '身份'], ['身份']) || '未明',
    '当前状态与核心作用': firstTableValue(row, ['当前状态与核心作用', '当前状态', '核心作用'], ['当前状态', '核心作用']) || '未明',
    [headers[3]]: firstTableValue(row,
      [headers[3], `与${userName}的关系和交集`, '与{{user}}的关系', '与{{user}}的关系和交集', '与用户的关系', '与用户的关系和交集'],
      [`与${userName}`, '与{{user}}', '与用户']) || '未明',
    [headers[4]]: firstTableValue(row,
      [headers[4], `与${ctx.name2 || '{{char}}'}的关系`, '与{{char}}的关系', '与主角的关系'],
      [`与${trackedLabel}`, `与${ctx.name2 || '{{char}}'}`, '与{{char}}', '与主角']) || '未明',
  }));
  return markdownTableSection('出场人物库', headers, normalized);
}

function sanitizeItemIndexSection(data, incomingSection) {
  const headers = ['物品/细节/内部梗', '绑定人物', '核心象征意义与影响'];
  let rows = parseMarkdownTable(incomingSection || '');
  if (rows.length === 0) rows = parseMarkdownTable(data?.codex?.itemIndex || '');
  if (rows.length === 0) return '';
  const tombstones = data?.entities?.itemTombstones || {};
  const normalized = rows.map(row => ({
    '物品/细节/内部梗': firstTableValue(row, ['物品/细节/内部梗', '物品', '细节', '内部梗'], ['物品', '细节', '内部梗']),
    '绑定人物': firstTableValue(row, ['绑定人物', '相关人物', '持有者'], ['绑定', '人物', '持有']) || '未明',
    '核心象征意义与影响': firstTableValue(row, ['核心象征意义与影响', '象征意义与影响', '核心意义', '影响'], ['象征', '意义', '影响']) || '未明',
  })).filter(row => row['物品/细节/内部梗'] && !tombstones[entityKey(row['物品/细节/内部梗'])]);
  return normalized.length ? markdownTableSection('重要道具、梗与核心细节', headers, normalized) : '';
}

function sanitizeSceneIndexSection(data, incomingSection) {
  const headers = ['场景/地点', '时间', '人物', '已发生事实'];
  let rows = parseMarkdownTable(incomingSection || '');
  if (rows.length === 0) rows = parseMarkdownTable(data?.codex?.sceneIndex || '');
  if (rows.length === 0) return '';
  const tombstones = data?.entities?.sceneTombstones || {};
  const normalized = rows.map(row => ({
    '场景/地点': firstTableValue(row, ['场景/地点', '场景', '地点', '名称'], ['场景', '地点']),
    '时间': firstTableValue(row, ['时间', '剧情时间'], ['时间']) || '未明',
    '人物': firstTableValue(row, ['人物', '出场人物'], ['人物']) || '未明',
    '已发生事实': firstTableValue(row, ['已发生事实', '事实', '事件'], ['事实', '事件']) || '未明',
  })).filter(row => row['场景/地点'] && !tombstones[entityKey(row['场景/地点'])]);
  return normalized.length ? markdownTableSection('场景记录', headers, normalized) : '';
}

function ensureEntityState(data) {
  if (!data.entities || typeof data.entities !== 'object') data.entities = {};
  if (!data.entities.items || typeof data.entities.items !== 'object') data.entities.items = { byKey: {}, order: [], updatedAt: 0 };
  if (!data.entities.scenes || typeof data.entities.scenes !== 'object') data.entities.scenes = { byKey: {}, order: [], updatedAt: 0 };
  if (!data.entities.itemTombstones || typeof data.entities.itemTombstones !== 'object') data.entities.itemTombstones = {};
  if (!data.entities.sceneTombstones || typeof data.entities.sceneTombstones !== 'object') data.entities.sceneTombstones = {};
  return data.entities;
}

function syncEntityLedgers(data, options = {}) {
  const entities = ensureEntityState(data);
  const itemRows = parseMarkdownTable(data.codex?.itemIndex || '').map(row => ({
    name: firstTableValue(row, ['物品/细节/内部梗', '物品', '细节', '内部梗'], ['物品', '细节', '内部梗']),
    boundTo: firstTableValue(row, ['绑定人物', '相关人物', '持有者'], ['绑定', '人物', '持有']),
    meaning: firstTableValue(row, ['核心象征意义与影响', '象征意义与影响', '核心意义', '影响'], ['象征', '意义', '影响']),
  })).filter(row => row.name);
  const sceneRows = parseMarkdownTable(data.codex?.sceneIndex || '').map(row => ({
    name: firstTableValue(row, ['场景/地点', '场景', '地点', '名称'], ['场景', '地点']),
    time: firstTableValue(row, ['时间', '剧情时间'], ['时间']),
    people: firstTableValue(row, ['人物', '出场人物'], ['人物']),
    facts: firstTableValue(row, ['已发生事实', '事实', '事件'], ['事实', '事件']),
  })).filter(row => row.name);

  if (options.manualItems) {
    for (const row of itemRows) delete entities.itemTombstones[entityKey(row.name)];
  }
  if (options.manualScenes) {
    for (const row of sceneRows) delete entities.sceneTombstones[entityKey(row.name)];
  }
  entities.items = buildItemLedger(itemRows, entities.items, entities.itemTombstones);
  entities.scenes = buildSceneLedger(sceneRows, entities.scenes, entities.sceneTombstones);
  return entities;
}

function markManualEntityDeletions(data, kind, beforeMarkdown, afterMarkdown) {
  const entities = ensureEntityState(data);
  const beforeRows = parseMarkdownTable(beforeMarkdown || '');
  const afterRows = parseMarkdownTable(afterMarkdown || '');
  const selector = kind === 'items'
    ? row => firstTableValue(row, ['物品/细节/内部梗', '物品', '细节', '内部梗'], ['物品', '细节', '内部梗'])
    : row => firstTableValue(row, ['场景/地点', '场景', '地点', '名称'], ['场景', '地点']);
  const removed = diffRemovedEntityKeys(beforeRows, afterRows, selector);
  const tombstones = kind === 'items' ? entities.itemTombstones : entities.sceneTombstones;
  for (const key of removed) tombstones[key] = { at: Date.now(), reason: '用户手动删除，禁止被旧摘要自动复活' };
  return removed.length;
}

function ensureTimelineState(data) {
  if (!data.timeline || typeof data.timeline !== 'object') data.timeline = clonePlainObject(defaultData().timeline);
  if (!Array.isArray(data.timeline.warnings)) data.timeline.warnings = [];
  if (!Array.isArray(data.timeline.history)) data.timeline.history = [];
  return data.timeline;
}

function refreshTimelineFromGodlogs(data) {
  const timeline = ensureTimelineState(data);
  const manual = timeline.manualOverride && typeof timeline.manualOverride === 'object' ? timeline.manualOverride : null;
  const minimumFloor = manual && Number.isFinite(Number(manual.floor)) ? Number(manual.floor) : -1;
  const entries = (data.godlogs || [])
    .filter(item => item && item.status === 'ready' && !item.stale && !item.archived && item.body)
    .filter(item => Number(item.floor ?? -1) > minimumFloor)
    .sort((a, b) => Number(a.floor ?? -1) - Number(b.floor ?? -1))
    .map(item => ({
      key: item.key || '',
      floor: Number(item.floor ?? -1),
      time: godlogFieldValue(item.body, 'Time'),
      title: godlogFieldValue(item.body, 'Title'),
      body: godlogFieldValue(item.body, 'Cond'),
    }));
  const next = rebuildTimelineState(entries, manual ? {
    currentTime: manual.currentTime || '',
    sourceKey: manual.sourceKey || '',
    floor: minimumFloor,
  } : {});
  next.manualOverride = manual;
  data.timeline = next;
  if (next.currentRaw && next.currentRaw !== '未明') data.codex.currentTime = next.currentRaw;

  if (manual?.currentPlace) {
    data.codex.currentPlace = manual.currentPlace;
  } else {
    const latestPlace = [...(data.godlogs || [])]
      .filter(item => item && item.status === 'ready' && !item.stale && !item.archived && item.body)
      .sort((a, b) => Number(b.floor ?? -1) - Number(a.floor ?? -1))
      .map(item => godlogFieldValue(item.body, 'Pln'))
      .find(value => usefulCodexValue(value));
    if (latestPlace) data.codex.currentPlace = latestPlace;
  }
  return next;
}

function refreshCodexFromPatch(data, markdown) {
  let changed = false;
  const patch = String(markdown || '').trim();
  if (!patch) return false;

  const currentTime = usefulCodexValue(valueAfterLabel(patch, '当前时间'));
  const currentPlace = usefulCodexValue(valueAfterLabel(patch, '当前地点'));
  const rawCharacterMemo = usefulCodexSection(sectionFrom(patch, '人物纪要') || sectionFrom(patch, '角色成长'));
  const rawPeopleIndex = usefulCodexSection(sectionFrom(patch, '出场人物库') || sectionFrom(patch, '人物库'));
  const characterMemo = sanitizeCharacterMemoSection(data, rawCharacterMemo);
  const peopleIndex = sanitizePeopleIndexSection(data, rawPeopleIndex);
  const itemIndex = sanitizeItemIndexSection(data, usefulCodexSection(sectionFrom(patch, '重要道具') || sectionFrom(patch, '核心细节')));
  const sceneIndex = sanitizeSceneIndexSection(data, usefulCodexSection(sectionFrom(patch, '场景记录') || sectionFrom(patch, '场景')));

  const assign = (key, value) => {
    if (!value || data.codex[key] === value) return;
    data.codex[key] = value;
    changed = true;
  };

  assign('currentTime', currentTime);
  assign('currentPlace', currentPlace);
  assign('characterMemo', characterMemo);
  assign('peopleIndex', peopleIndex);
  assign('itemIndex', itemIndex);
  assign('sceneIndex', sceneIndex);
  syncEntityLedgers(data);
  refreshTimelineFromGodlogs(data);
  return changed;
}


function hasMarkdownTableSkeleton(section) {
  const lines = String(section || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith('|') && line.endsWith('|'));
  if (lines.length < 2) return false;
  const separatorCells = lines[1].split('|').slice(1, -1).map(cell => cell.trim());
  return separatorCells.length > 0 && separatorCells.every(cell => /^:?-{3,}:?$/.test(cell));
}

function validateCodexPatchStructure(data, markdown) {
  const patch = String(markdown || '').trim();
  if (patch.length < 220) throw new Error('状态索引返回内容过短，疑似被截断；旧索引已保留');
  if (/```/.test(patch)) throw new Error('状态索引返回了代码块，格式不符合要求；旧索引已保留');
  if (!/\*\*当前时间[:：]\*\*\s*[^\n]+/.test(patch)) throw new Error('状态索引缺少“当前时间”字段；旧索引已保留');
  if (!/\*\*当前地点[:：]\*\*\s*[^\n]+/.test(patch)) throw new Error('状态索引缺少“当前地点”字段；旧索引已保留');

  const sections = [
    ['人物关系', relationshipSection(patch)],
    ['人物纪要', sectionFrom(patch, '人物纪要') || sectionFrom(patch, '角色成长')],
    ['出场人物库', sectionFrom(patch, '出场人物库') || sectionFrom(patch, '人物库')],
    ['重要道具', sectionFrom(patch, '重要道具') || sectionFrom(patch, '核心细节')],
    ['场景记录', sectionFrom(patch, '场景记录') || sectionFrom(patch, '场景')],
  ];
  for (const [label, section] of sections) {
    if (!section) throw new Error(`状态索引缺少“${label}”分区；旧索引已保留`);
    if (!hasMarkdownTableSkeleton(section)) throw new Error(`状态索引的“${label}”表格不完整；旧索引已保留`);
  }

  const expectedRows = normalizeRelationshipTable(data.relationshipTable, data.codex?.relationship || '').rows.length;
  if (parseMarkdownTable(relationshipSection(patch)).length < expectedRows) {
    throw new Error('人物关系表缺少固定名单中的角色，疑似输出被截断；旧索引已保留');
  }
  return true;
}

function baseApiUrl(url) {
  return normalizeOpenAiCompatibleBaseUrl(url);
}

function updateSecondaryProviderHint(value = settings().secondaryUrl) {
  const node = $('#am_secondary_provider_hint');
  if (!node.length) return;
  node.text(providerCompatibilityHint(value));
}

function secondaryConnectionDiagnostics(base, model, message = '') {
  const info = openAiCompatibleProviderInfo(base);
  const raw = String(message || '').trim();
  const lower = raw.toLowerCase();
  let hint = '';
  if (/401|unauthori|invalid.*key|api.?key|鉴权|密钥/.test(lower)) {
    hint = '请检查该平台的 API Key 是否属于当前地域/业务空间，并确认没有复制到多余空格。';
  } else if (/404|not.?found|model.?not.?found|不存在/.test(lower)) {
    hint = '请检查模型 ID 与 Base URL 是否属于同一平台/地域；模型名必须使用控制台或模型列表中的精确 ID。';
  } else if (/400|bad request|invalid.?request|参数|parameter/.test(lower)) {
    hint = '这是上游常见的参数/模型错误；插件已使用最小 OpenAI Chat Completions 参数集，请优先核对模型 ID、地域和额度。';
  } else if (/429|rate.?limit|quota|限流|额度/.test(lower)) {
    hint = '可能触发限流或额度不足，请稍后重试并检查平台余额/并发限制。';
  }
  const details = `${info.name}；Base URL=${info.baseUrl || base || '未识别'}；model=${String(model || '').trim() || '未填写'}`;
  return `${raw}${raw ? '；' : ''}${details}${hint ? `。${hint}` : ''}`;
}

function secondaryConfigured(value = settings()) {
  const s = value || {};
  return !!(
    s.useSecondary
    && baseApiUrl(s.secondaryUrl)
    && String(s.secondaryKey || '').trim()
    && String(s.secondaryModel || '').trim()
  );
}

function secondaryTextValue(value, depth = 0) {
  if (depth > 8 || value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return '';
  if (Array.isArray(value)) {
    return value
      .map(part => secondaryTextValue(part, depth + 1))
      .filter(Boolean)
      .join('')
      .trim();
  }
  if (typeof value === 'object') {
    // Prefer fields that are known to carry model-visible output. Do not stringify the whole object,
    // otherwise ids, usage metadata or provider errors may be mistaken for a valid summary.
    for (const key of [
      'text', 'content', 'output_text', 'response_text', 'generated_text', 'completion',
      'result', 'answer', 'reply', 'final', 'final_answer', 'value', 'parts', 'segments',
      'summary_text', 'summary',
    ]) {
      const text = secondaryTextValue(value[key], depth + 1);
      if (text) return text;
    }
  }
  return '';
}

function secondaryReasoningValue(value, depth = 0) {
  if (depth > 8 || value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return '';
  if (Array.isArray(value)) {
    return value
      .map(part => secondaryReasoningValue(part, depth + 1) || secondaryTextValue(part, depth + 1))
      .filter(Boolean)
      .join('')
      .trim();
  }
  if (typeof value === 'object') {
    for (const key of [
      'reasoning_content', 'reasoning', 'reasoning_details', 'analysis', 'thinking',
      'thinking_content', 'thought', 'thoughts', 'summary', 'summary_text', 'text', 'content',
      'parts', 'segments', 'value',
    ]) {
      const text = secondaryReasoningValue(value[key], depth + 1) || secondaryTextValue(value[key], depth + 1);
      if (text) return text;
    }
  }
  return '';
}

function secondaryValueShape(value) {
  if (value == null) return String(value);
  if (typeof value === 'string') return `string(${value.length})`;
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).slice(0, 12).join('|');
    return `object(${keys || 'empty'})`;
  }
  return typeof value;
}

function secondaryResponseRoot(parsed) {
  for (const root of [parsed, parsed?.data, parsed?.response]) {
    if (root && typeof root === 'object' && (Array.isArray(root.choices) || root.message || root.output || root.candidates)) return root;
  }
  return parsed;
}

function secondaryResponseDiagnostics(parsed) {
  const root = secondaryResponseRoot(parsed) || {};
  const choice = root?.choices?.[0] || parsed?.choices?.[0] || parsed?.data?.choices?.[0] || parsed?.response?.choices?.[0];
  const message = choice?.message || choice?.delta || root?.message;
  const usage = root?.usage || parsed?.usage || parsed?.data?.usage || parsed?.response?.usage || {};
  const completionDetails = usage?.completion_tokens_details || usage?.output_tokens_details || {};
  const completionTokens = usage?.completion_tokens ?? usage?.output_tokens ?? usage?.generated_tokens;
  const reasoningTokens = completionDetails?.reasoning_tokens ?? usage?.reasoning_tokens;
  const toolCalls = message?.tool_calls || choice?.tool_calls;
  const diagnostics = [
    `顶层字段=${secondaryResponseShape(parsed)}`,
    `choices=${Array.isArray(root?.choices) ? root.choices.length : (Array.isArray(parsed?.choices) ? parsed.choices.length : 0)}`,
    `choice字段=${choice && typeof choice === 'object' ? (Object.keys(choice).slice(0, 12).join('|') || 'empty') : secondaryValueShape(choice)}`,
    `message字段=${message && typeof message === 'object' ? (Object.keys(message).slice(0, 16).join('|') || 'empty') : secondaryValueShape(message)}`,
    `content=${secondaryValueShape(message?.content)}`,
  ];
  const reasoningShape = [
    message?.reasoning_content,
    message?.reasoning,
    message?.reasoning_details,
    message?.analysis,
    message?.thinking,
    message?.thinking_content,
    choice?.reasoning_content,
    choice?.reasoning,
  ].map(secondaryValueShape).find(shape => !['undefined', 'null'].includes(shape));
  if (reasoningShape) diagnostics.push(`reasoning=${reasoningShape}`);
  if (Array.isArray(toolCalls)) diagnostics.push(`tool_calls=${toolCalls.length}`);
  if (completionTokens != null) diagnostics.push(`completion_tokens=${completionTokens}`);
  if (reasoningTokens != null) diagnostics.push(`reasoning_tokens=${reasoningTokens}`);
  return diagnostics.join('，');
}

function secondaryEmptyResponseHint(parsed) {
  const root = secondaryResponseRoot(parsed) || {};
  const choice = root?.choices?.[0] || parsed?.choices?.[0] || parsed?.data?.choices?.[0] || parsed?.response?.choices?.[0];
  const message = choice?.message || choice?.delta || root?.message || {};
  const usage = root?.usage || parsed?.usage || parsed?.data?.usage || parsed?.response?.usage || {};
  const completionDetails = usage?.completion_tokens_details || usage?.output_tokens_details || {};
  const completionTokens = Number(usage?.completion_tokens ?? usage?.output_tokens ?? usage?.generated_tokens);
  const reasoningTokens = Number(completionDetails?.reasoning_tokens ?? usage?.reasoning_tokens);
  const hasToolCalls = Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
  if (hasToolCalls) return '模型只返回了tool_calls，但插件没有请求工具调用；请更换对话模型或关闭该模型的强制工具模式';
  if (Number.isFinite(reasoningTokens) && reasoningTokens > 0 && (!Number.isFinite(completionTokens) || completionTokens <= reasoningTokens)) {
    return 'usage显示输出几乎全部是推理token，但没有最终正文；可能是推理模型未产出final answer，或代理剥离了最终内容';
  }
  if (Number.isFinite(completionTokens) && completionTokens > 0) {
    return `usage显示模型已生成${completionTokens}个completion token，但message中没有正文；更像是供应商兼容层或酒馆代理把内容放在未兼容字段/剥离了正文`;
  }
  if (Number.isFinite(completionTokens) && completionTokens === 0) {
    return '模型正常结束但生成token为0；这是模型/供应商返回空答案，不是摘要长度校验造成的';
  }
  if (message && typeof message === 'object' && Object.keys(message).length > 0) {
    return 'API返回了message对象，但其中没有可识别的正文；需根据message字段判断是供应商格式兼容还是空答案';
  }
  return 'API返回了标准外壳，但没有message正文；可能是供应商或代理返回结构不完整';
}

function extractSecondaryError(parsed) {
  const error = parsed?.error || parsed?.response?.error || parsed?.data?.error;
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error && typeof error === 'object') {
    return String(error.message || error.detail || error.type || error.code || '').trim();
  }
  const status = String(parsed?.status || parsed?.response?.status || '').toLowerCase();
  if (['error', 'failed', 'failure'].includes(status)) {
    return String(parsed?.message || parsed?.detail || parsed?.response?.message || '副API返回失败状态').trim();
  }
  return '';
}

function extractSecondaryFinishReason(parsed) {
  return String(
    parsed?.choices?.[0]?.finish_reason
    || parsed?.data?.choices?.[0]?.finish_reason
    || parsed?.response?.choices?.[0]?.finish_reason
    || parsed?.finish_reason
    || parsed?.stop_reason
    || parsed?.candidates?.[0]?.finishReason
    || '',
  ).toLowerCase();
}

function extractSecondaryResponseText(parsed) {
  const roots = [parsed, parsed?.data, parsed?.response].filter(Boolean);
  const directCandidates = [];
  for (const root of roots) {
    const choice = root?.choices?.[0];
    directCandidates.push(
      choice?.message?.content,
      choice?.delta?.content,
      choice?.text,
      choice?.content,
      choice?.message?.parts,
      choice?.delta?.parts,
      root?.message?.content,
      root?.message?.text,
      root?.message?.parts,
      root?.message,
      root?.content,
      root?.output_text,
      root?.text,
      root?.generated_text,
      root?.result,
      root?.completion,
      root?.answer,
      root?.reply,
      typeof root === 'string' ? root : '',
    );
    // Responses API shape: output[].content[].text / output_text.
    for (const output of root?.output || []) {
      directCandidates.push(output?.content, output?.text, output?.output_text, output?.parts);
    }
  }
  for (const candidate of directCandidates) {
    const text = secondaryTextValue(candidate);
    if (text) return text;
  }

  if (Array.isArray(parsed)) {
    const arrayText = secondaryTextValue(parsed);
    if (arrayText) return arrayText;
  }

  const geminiParts = parsed?.candidates?.[0]?.content?.parts
    || parsed?.data?.candidates?.[0]?.content?.parts
    || parsed?.response?.candidates?.[0]?.content?.parts;
  const geminiText = secondaryTextValue(geminiParts);
  if (geminiText) return geminiText;

  // Some reasoning models/proxies leave message.content null and store the answer in provider-specific
  // reasoning/thinking containers. Read these only after all normal final-answer fields are empty.
  for (const root of roots) {
    const choice = root?.choices?.[0];
    for (const candidate of [
      choice?.message,
      choice?.delta,
      root?.message,
      choice?.message?.reasoning_content,
      choice?.message?.reasoning,
      choice?.message?.reasoning_details,
      choice?.message?.analysis,
      choice?.message?.thinking,
      choice?.message?.thinking_content,
      choice?.delta?.reasoning_content,
      choice?.delta?.reasoning,
      choice?.delta?.reasoning_details,
      choice?.delta?.thinking,
      choice?.reasoning_content,
      choice?.reasoning,
      choice?.reasoning_details,
      root?.reasoning_content,
      root?.reasoning,
      root?.reasoning_details,
      root?.thinking,
    ]) {
      const text = secondaryReasoningValue(candidate);
      if (text) return text;
    }
  }
  return '';
}

function parseSecondarySse(raw) {
  const chunks = [];
  let finishReason = '';
  for (const line of String(raw || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const parsed = JSON.parse(payload);
      const error = extractSecondaryError(parsed);
      if (error) throw new Error(error);
      const text = extractSecondaryResponseText(parsed);
      if (text) chunks.push(text);
      finishReason ||= extractSecondaryFinishReason(parsed);
    } catch (err) {
      if (err instanceof SyntaxError) continue;
      throw err;
    }
  }
  return { content: chunks.join('').trim(), finishReason };
}

function secondaryResponseShape(parsed) {
  if (!parsed || typeof parsed !== 'object') return typeof parsed;
  return Object.keys(parsed).slice(0, 10).join(',') || 'empty-object';
}

function secondaryAbortReason(controller, err) {
  const signalReason = controller?.signal?.reason;
  const candidates = [
    typeof signalReason === 'string' ? signalReason : signalReason?.message,
    typeof err === 'string' ? err : err?.message,
  ];
  return candidates.map(value => String(value || '').trim()).find(Boolean) || '';
}

function isSecondaryAbort(controller, err) {
  return !!controller?.signal?.aborted
    || err?.name === 'AbortError'
    || ['secondary-timeout', 'AbortError'].includes(String(typeof err === 'string' ? err : err?.message || ''));
}

function cancelledRequestError(message) {
  const error = new Error(String(message || '请求已取消'));
  error.code = 'AM_REQUEST_CANCELLED';
  return error;
}

async function callSecondary(messages, maxTokens = 2400, options = {}) {
  const s = settings();
  const base = baseApiUrl(s.secondaryUrl);
  if (!base || !s.secondaryKey) throw new Error('副API地址或密钥未配置');
  if (!String(s.secondaryModel || '').trim()) throw new Error('副API模型为空；请先拉取模型或手动填写准确模型名');
  const timeoutMs = Math.max(15 * 1000, Math.min(10 * 60 * 1000, Number(options.timeoutMs) || SECONDARY_REQUEST_TIMEOUT_MS));
  const taskLabel = String(options.taskLabel || '副API请求').trim() || '副API请求';

  const requestOnce = async (requestMessages, tokenBudget) => {
    const request = state.requests.create('secondary');
    const controller = request.controller;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      // Do not pass a string abort reason here. Safari/WebKit and some mobile Chromium builds reject
      // fetch() with that raw string instead of an AbortError, which used to leak the internal token
      // `secondary-timeout` into the UI and misclassify a plugin timeout as an API transport error.
      try { controller.abort(); } catch { /* noop */ }
    }, timeoutMs);
    let response;
    try {
      response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: getRequestHeaders(),
        signal: controller.signal,
        body: JSON.stringify({
          chat_completion_source: 'openai',
          reverse_proxy: base,
          proxy_password: s.secondaryKey,
          model: s.secondaryModel || undefined,
          messages: requestMessages,
          // Keep the compatibility request intentionally minimal. Several domestic OpenAI-compatible
          // providers/models impose model-specific temperature constraints (notably Kimi K2.5/K2.6),
          // so omitting it lets the upstream model choose its documented default.
          max_tokens: tokenBudget,
          stream: false,
        }),
      });
    } catch (err) {
      if (isSecondaryAbort(controller, err)) {
        if (timedOut) {
          throw new Error(`${taskLabel}超过${Math.ceil(timeoutMs / 1000)}秒，插件已中止本次请求；已完成的数据和重建进度均保留`);
        }
        const reason = secondaryAbortReason(controller, err);
        throw cancelledRequestError(`副API请求已因切换聊天、刷新页面或取消任务而中止；结果不会写入任何聊天${reason && !/abort/i.test(reason) ? `（${reason}）` : ''}`);
      }
      throw new Error(`副API请求失败：${err?.message || String(err)}`);
    } finally {
      clearTimeout(timeout);
      request.cleanup();
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(secondaryConnectionDiagnostics(base, s.secondaryModel, `Secondary API ${response.status}: ${errText.slice(0, 180)}`));
    }
    const raw = await response.text();
    if (!String(raw || '').trim()) throw new Error('副API返回了空响应体；请先点“测试副API”检查模型、地址和密钥');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const sse = parseSecondarySse(raw);
      if (sse.content) return sse;
      // A plain-text provider response is valid only when it contains actual text, not an HTML error page.
      const plain = raw.trim();
      if (/^\s*<!doctype html|^\s*<html/i.test(plain)) {
        throw new Error(`副API返回了HTML页面而不是模型结果：${plain.replace(/\s+/g, ' ').slice(0, 140)}`);
      }
      return { content: plain, finishReason: '' };
    }
    const apiError = extractSecondaryError(parsed);
    if (apiError) throw new Error(`副API返回错误：${secondaryConnectionDiagnostics(base, s.secondaryModel, apiError)}`);
    const content = extractSecondaryResponseText(parsed);
    const finishReason = extractSecondaryFinishReason(parsed);
    if (!content) {
      const refusal = secondaryTextValue(
        parsed?.choices?.[0]?.message?.refusal
        || parsed?.data?.choices?.[0]?.message?.refusal
        || parsed?.response?.choices?.[0]?.message?.refusal,
      );
      const detail = refusal ? `；模型拒绝：${refusal.slice(0, 140)}` : '';
      const diagnostics = secondaryResponseDiagnostics(parsed);
      const hint = secondaryEmptyResponseHint(parsed);
      throw new Error(`副API响应成功但没有可用正文（finish_reason=${finishReason || '未提供'}；${diagnostics}${detail}）。判断：${hint}`);
    }
    return { content, finishReason };
  };

  const truncatedReasons = new Set(['length', 'max_tokens', 'max_output_tokens', 'token_limit']);
  let result = await requestOnce(messages, maxTokens);
  if (truncatedReasons.has(result.finishReason)) {
    const retryBudget = Math.min(12000, Math.max(maxTokens + 1200, Math.ceil(maxTokens * 1.5)));
    const retryMessages = messages.map((message, index) => (
      index === 0 && message?.role === 'system'
        ? {
            ...message,
            content: `${message.content}
The previous attempt was cut off by the output-token limit. Regenerate the complete result from the beginning, keep every required field/section, and compress wording enough to finish within the budget.`,
          }
        : message
    ));
    result = await requestOnce(retryMessages, retryBudget);
    if (truncatedReasons.has(result.finishReason)) {
      throw new Error(`副API连续两次因输出上限被截断（${maxTokens} → ${retryBudget} tokens）；本次结果未保存，将保留任务等待重跑`);
    }
  }
  return result.content;
}

async function callWriter(prompt, maxTokens = 3200) {
  const s = settings();
  if (secondaryConfigured(s)) {
    return callSecondary([
      { role: 'system', content: 'You are a precise narrative memory archivist. Output only the requested Markdown.' },
      { role: 'user', content: prompt },
    ], maxTokens);
  }
  throw new Error('锚点/合并后台整理需要先配置并启用副API；为避免把记忆整理提示词发送给主模型，本版本不再使用主模型静默整理。');
}

async function callSummaryWriter(prompt, maxTokens = 1000) {
  const s = settings();
  if (!secondaryConfigured(s)) {
    throw new Error('逐楼摘要需要先配置并启用副API');
  }
  return callSecondary([
    { role: 'system', content: 'You are a precise Godlog narrative summarizer. Return only the requested XML fields for the background task. Never use Markdown code fences and never write content intended for the visible chat reply.' },
    { role: 'user', content: prompt },
  ], maxTokens);
}

function buildGodlogPrompt(data, row, item = null) {
  const previous = validGodlogMaterials(data)
    .filter(item => item.row.index < row.index)
    .slice(-3)
    .map(({ godlog }) => godlog.body)
    .join('\n\n---\n\n') || '（暂无上一楼摘要）';
  const hasUserInput = /【用户输入｜/.test(row.turnText || '');
  const openingInstruction = hasUserInput
    ? '当前回合包含用户输入与随后的AI回复。'
    : '当前回合没有用户输入，这是首条AI开场楼或单独AI楼；必须直接总结这条AI回复里的开场设定、已发生动作、地点、人物状态和可确认信息，不要因为缺少用户输入而输出空内容。';
  const canon = buildCanonContextBlock(data, row, null, 5200);

  return `${renderTemplate(settings().godlogRules || DEFAULT_GODLOG_RULES)}

请只为当前回合写 Godlog。通常当前回合 = 用户输入 + 随后的AI回复；如果没有用户输入，则当前回合 = 这条AI开场/AI回复本身。Godlog 只返回给本次后台摘要任务，插件会单独渲染静态摘要卡；不要把 Godlog 写回 AI 回复正文，不要使用 Markdown 代码块，不要总结其他回合，不要输出HTML标签。

身份与关系判定边界：
- 角色卡、角色书、世界书是稳定身份和既有关系的最高依据；当前楼只记录“这一楼发生了什么”。
- 不要因为某人做了医疗行为就改写职业，不要因为本楼出现某人就写“初次见面”。
- 如果设定里已有身份/关系，沿用设定；如果设定和本楼冲突，把本楼当作临时表象或冲突线索，不要直接覆盖稳定身份。

## 当前回合判定
${openingInstruction}

## 角色卡/世界书/上文硬依据
${canon}

## 上三楼摘要（仅供对齐剧情，不要复述）
${clampText(previous, 2200)}

## 当前已知剧情定位（只作线索；原文冲突时以原文为准）
时间：${data.codex.currentTime || '未明'}
地点：${data.codex.currentPlace || '未明'}

## 当前楼层标识
Nub: ${item?.number || godlogNumberForRow(row) || data.processing.godlogCount + 1}
Role: ${row.role}
Name: ${row.name || '未命名'}
SendDate: ${row.sendDate || '未记录'}

## 当前回合原文（唯一剧情事实来源）
${row.turnText || row.text}`;
}

function buildCodexPatchPrompt(data, row, godlog) {
  const ctx = getContext();
  const charName = trackedCharacterLabel(data, ctx);
  const trackedNames = trackedCharacterNames(data, ctx);
  const userName = ctx.name1 || '{{user}}';
  const floor = row.index;
  const currentFacts = safeGodlogMemoryText(godlog.body || '');
  const canon = buildCanonContextBlock(data, row, godlog, 7600);

  return `你是长篇角色扮演的后台记忆索引员。你只更新插件内部索引，不写聊天正文，不和玩家对话。

任务：根据“角色卡/世界书/上文硬依据”、“当前楼层事实”和“已有索引”，输出更新后的完整索引。只记录已经发生的内容，不预测，不评价模型表现，不写代码块，不输出 XML/HTML。

本聊天人物纪要追踪白名单：${trackedNames.join('、') || charName}
玩家名（绝对禁止写入人物纪要）：${userName}

${renderMemoryRules(settings().characterRules || DEFAULT_CHARACTER_RULES, data, ctx)}

${renderMemoryRules(settings().peopleRules || DEFAULT_PEOPLE_RULES, data, ctx)}

${renderMemoryRules(settings().itemRules || DEFAULT_ITEM_RULES, data, ctx)}

事实优先级：
1. 角色卡、角色书、世界书、已有索引里的稳定身份与既有关系优先级最高。
2. 当前楼层事实只用于更新本楼发生的事件、情绪变化、临时状态和新交集。
3. 如果当前楼层没有明确说“第一次见面/初次见面/刚认识”，禁止写初次见面；只能写“本索引首次记录于第 ${floor} 楼”或“本楼同场出现/本楼互动”。
4. 禁止从职业动作反推稳定身份。例如会治疗、在医院、被称 doctor，不等于身份一定是医生；若角色卡写 ${charName} 是总裁/家族成员/其他身份，必须沿用角色卡。
5. 禁止把介绍句的关系主体写反。比如“${charName} 介绍 ${userName} 是朋友”只能说明 ${charName} 对家人这样介绍 ${userName}，不能写成母亲主动认定或两人初见。
6. 如果角色卡/世界书已经明确写出某角色的职业或身份，就必须沿用该身份；任何已知身份都不能被“未明”覆盖。

规则：
- 【人物关系】是固定名单表。名称列与行数由用户控制，必须逐字保留当前提供的名称和顺序；禁止新增、删除、改名或交换行。每一行都表示“该名称对应人物 ↔ ${userName}”的关系。
- “过去”用一句话概括最初可确认的关系状态；一旦形成就保持稳定，除非当前有效剧情证明早期状态需要纠正。
- “发展”用一句话概括从过去到当前的主要推进过程，只写已经发生的关键节点，不罗列流水账。
- “当前”用一句话概括此刻最核心的关系、矛盾、依赖或拉扯状态。当前楼没有关系变化时，原样保留该行三列。
- 人物纪要只允许出现白名单中的角色：${trackedNames.join('、') || charName}。一人一行，禁止出现 ${userName}，禁止出现NPC或配角。即使模型认为玩家也发生了成长，也必须放弃该行。
- 如果本楼没有白名单角色的真实心理/关系/行为模式变化，保留该角色上一版，不得用 ${userName} 或其他人物补位。
- 出场人物库只记录白名单主角与 ${userName} 之外的重要NPC、配角；白名单主角和玩家不得出现在该表中。如果当前楼出现或明确提及了新人，要立刻入库，但身份/关系必须先查硬依据。
- 物品与核心细节只记录会推动剧情、关系、伏笔或反复出现的内容；已有条目未在本楼出现时必须保留，禁止因本楼未提及而丢失。
- 场景记录按地点合并：同一地点只保留一行并更新其最近确认时间与事实；已有地点未在本楼出现时保留，禁止重复建项。
- 场景记录只写当前已经确认的时间、地点、人物状态与发生事实。
- 表格必须至少保留表头和一行内容；未知写“未明”，不要留空。

输出必须严格包含以下结构：

**【人物关系】**
| 名称 | 过去 | 发展 | 当前 |
| :--- | :--- | :--- | :--- |
${relationshipTableMarkdown(data.relationshipTable, true).split('\n').slice(2).join('\n')}

**当前时间：** 剧情内时间；无法判断写“未明”
**当前地点：** 地点；无法判断写“未明”

**【人物纪要】**
| 角色名 | 身份/标签 | 原始楼层 | 触发事件 | 心态转变 | 当前变化 |
| :--- | :--- | :--- | :--- | :--- | :--- |

**【出场人物库】**
| 角色名 | 身份/标签 | 当前状态与核心作用 | 与${userName}的关系 | 与${charName}的关系 |
| :--- | :--- | :--- | :--- | :--- |

**【重要道具、梗与核心细节】**
| 物品/细节/内部梗 | 绑定人物 | 核心象征意义与影响 |
| :--- | :--- | :--- |

**【场景记录】**
| 场景/地点 | 时间 | 人物 | 已发生事实 |
| :--- | :--- | :--- | :--- |

## 角色卡/世界书/上文硬依据
${canon}

## 固定人物关系表（只允许更新三列，名称列和行数不可改）
${relationshipTableMarkdown(data.relationshipTable, true)}

## 已有人物纪要
${data.codex.characterMemo || '（暂无）'}

## 已有出场人物库
${data.codex.peopleIndex || '（暂无）'}

## 已有物品与核心细节
${data.codex.itemIndex || '（暂无）'}

## 已有场景记录
${data.codex.sceneIndex || '（暂无）'}

## 当前楼层事实
第 ${floor} 楼 / ${row.name || '未命名'}
${currentFacts || cleanText(row.turnText || row.text)}`;
}

async function updateCodexFromGodlog(data, row, godlog, force = false) {
  if (!data || !row || !godlog || godlog.status !== 'ready' || !godlog.body) return false;
  const s = settings();
  if (!secondaryConfigured(s)) return false;
  if (data.processing?.codexDirty && !force) {
    scheduleCodexBacklog();
    return false;
  }
  if (!data.processing.codexKeys) data.processing.codexKeys = {};
  const revisionHash = summaryRevisionHash(godlog, row);
  if (!force && data.processing.codexKeys[row.key] === revisionHash) return false;
  const contextToken = captureChatContextToken(data);

  try {
    const patch = await callSecondary([
      { role: 'system', content: 'You update private roleplay memory indexes for a background task. Output only the requested Markdown tables. Never write visible chat content.' },
      { role: 'user', content: buildCodexPatchPrompt(data, row, godlog) },
    ], 3000);
    if (!isSameChatContext(contextToken)) return false;
    validateCodexPatchStructure(data, patch);

    // Build the whole update on a detached candidate. No active index/table is modified until every
    // required section and every fixed relationship row has passed validation.
    const relationshipWasDirty = !!data.processing?.relationshipDirty;
    const candidate = {
      codex: normalizedCodex(clonePlainObject(data.codex)),
      relationshipTable: normalizeRelationshipTable(
        clonePlainObject(data.relationshipTable),
        data.codex?.relationship || '',
      ),
      processing: {
        ...data.processing,
        codexKeys: { ...(data.processing.codexKeys || {}) },
      },
    };

    const changed = refreshCodexFromPatch(candidate, patch);
    let relationResult = { found: false, matched: 0, unexpected: 0, changed: false, complete: false };
    // A dirty relationship table is rebuilt from the complete surviving timeline by its dedicated
    // job. Incremental rows may still update the other indexes, but must not clear that dirty flag.
    if (!relationshipWasDirty) {
      relationResult = applyRelationshipPatch(candidate, patch, row, {
        recordEvenIfUnchanged: false,
        requireComplete: true,
        preserveKnownOnUnknown: true,
      });
      if (!relationResult.complete) {
        throw new Error('人物关系表包含缺行、额外行或重复行；旧索引与旧关系表已完整保留');
      }
    }

    snapshotCodex(data, '逐楼状态索引提交前备份');
    data.codex = candidate.codex;
    syncEntityLedgers(data);
    refreshTimelineFromGodlogs(data);
    if (!relationshipWasDirty) {
      data.relationshipTable = candidate.relationshipTable;
      data.processing.relationshipDirty = candidate.processing.relationshipDirty;
      data.processing.relationshipDirtyReason = candidate.processing.relationshipDirtyReason;
      data.processing.relationshipDirtyAt = candidate.processing.relationshipDirtyAt;
      data.processing.relationshipLastGoodAt = candidate.processing.relationshipLastGoodAt;
      data.processing.relationshipRebuildFailures = candidate.processing.relationshipRebuildFailures;
    }
    data.processing.codexKeys[row.key] = revisionHash;
    data.processing.codexDirty = false;
    data.processing.codexDirtyReason = '';
    data.processing.codexDirtyAt = 0;
    data.processing.codexLastGoodAt = Date.now();
    data.processing.codexRebuildFailures = 0;
    data.processing.codexRetryAt = 0;
    data.processing.codexRebuildCheckpoint = null;
    data.processing.codexUnsafeFromFloor = null;
    data.processing.lastError = '';
    if (godlog.floor !== undefined) {
      data.processing.lastCodexFloor = Math.max(Number(data.processing.lastCodexFloor || -1), Number(godlog.floor));
    }
    saveMemory(true);
    if (data.processing?.relationshipDirty || data.processing?.codexDirty) scheduleCodexBacklog(4);
    return changed || relationResult.changed;
  } catch (err) {
    if (!isSameChatContext(contextToken)) return false;
    console.warn('[AnchorMemory] codex patch failed', err);
    data.processing.lastError = `状态索引未提交：${err.message}`;
    markCodexDirty(data, `增量状态索引未提交：${err.message}`, false, false, Number(row.index));
    markRelationshipDirty(data, `增量人物关系未提交：${err.message}`);
    saveMemory();
    scheduleCodexBacklog(4);
    return false;
  }
}

async function processCodexBacklog(limit = 4) {
  if (state.codexRunning) return false;
  const data = memoryData();
  const contextToken = captureChatContextToken(data);
  const operationEpoch = state.contextEpoch;
  const rows = pendingCodexRows(data).slice(0, limit);
  if (rows.length === 0) return true;

  state.codexRunning = true;
  data.processing.codexBusy = true;
  saveMemory();

  let completed = 0;
  try {
    for (const { row, godlog } of rows) {
      if (!isSameChatContext(contextToken)) return false;
      const before = data.processing?.codexKeys?.[row.key] || '';
      await updateCodexFromGodlog(data, row, godlog);
      if (!isSameChatContext(contextToken)) return false;
      const revisionHash = summaryRevisionHash(godlog, row);
      if (data.processing?.codexKeys?.[row.key] === revisionHash && before !== revisionHash) completed++;
    }
    return true;
  } finally {
    if (state.contextEpoch === operationEpoch) state.codexRunning = false;
    if (!isSameChatContext(contextToken)) return;
    data.processing.codexBusy = false;
    saveMemory();
    updatePreview();
    if (data.processing?.codexDirty
      || data.processing?.relationshipDirty
      || (completed > 0 && pendingCodexRows(data).length > 0)) {
      scheduleCodexBacklog(limit);
    }
    flushDeferredIntervalRecheck();
  }
}

async function rebuildCodexFromGodlogs(confirmFirst = true) {
  const s = settings();
  if (!secondaryConfigured(s)) {
    if (confirmFirst) toastr?.warning?.('请先配置并启用副API，人物索引重建需要后台模型。', 'Anchor Memory');
    return false;
  }
  if (state.codexRunning || state.summaryRunning || state.running) {
    if (confirmFirst) toastr?.warning?.('后台记忆任务正在运行，稍后再重建人物索引。', 'Anchor Memory');
    return false;
  }
  const data = memoryData();
  if (!confirmFirst && Number(data.processing?.codexRetryAt || 0) > Date.now()) return false;
  const contextToken = captureChatContextToken(data);
  const operationEpoch = state.contextEpoch;
  const blockedRows = blockedRebuildGodlogRows(data);
  if (blockedRows.length > 0) {
    const preview = blockedRows.slice(0, 5).map(row => `第${row.index}楼`).join('、');
    markCodexDirty(data, `等待 ${blockedRows.length} 楼逐楼摘要完成后再安全重建`, false, false, Math.min(...blockedRows.map(row => Number(row.index))));
    markRelationshipDirty(data, `等待 ${blockedRows.length} 楼逐楼摘要完成后再按完整时间线重建`);
    saveMemory(true);
    if (confirmFirst) toastr?.warning?.(`${preview}${blockedRows.length > 5 ? '等' : ''}尚无有效逐楼摘要。为避免遗漏关系发展，暂不覆盖现有索引。`, 'Anchor Memory');
    return false;
  }
  const materials = validGodlogMaterials(data).sort((a, b) => a.row.index - b.row.index);
  if (materials.length === 0) {
    markCodexDirty(data, '当前没有可用于重建的有效逐楼摘要', false);
    saveMemory(true);
    if (confirmFirst) toastr?.warning?.('当前没有有效逐楼摘要；原人物/物品/场景索引已保留，未执行清空。', 'Anchor Memory');
    return false;
  }

  const chunks = buildCodexRebuildChunks(materials);
  const checkpoint = normalizeCodexRebuildCheckpoint(data, materials, chunks);
  const resumeAt = Math.min(checkpoint.cursor, chunks.length);
  if (confirmFirst) {
    const action = resumeAt > 0 ? `从第 ${resumeAt + 1}/${chunks.length} 段继续` : `分 ${chunks.length} 段重建`;
    if (!confirm(`将根据 ${materials.length} 条有效逐楼摘要${action}人物/物品/场景索引。每段成功后都会保存进度，全部完成前不会覆盖现有安全快照。继续？`)) return false;
    data.processing.codexRetryAt = 0;
  }

  state.codexRunning = true;
  data.processing.codexBusy = true;
  data.processing.codexRebuildCheckpoint = checkpoint;
  saveMemory(true);
  showStatus(`正在分段重建人物索引 ${resumeAt}/${chunks.length}`);

  try {
    let candidateHolder = {
      codex: normalizedCodex(checkpoint.candidateCodex),
      relationshipTable: normalizeRelationshipTable(checkpoint.candidateRelationship),
      trackedCharacters: [...(data.trackedCharacters || [])],
      processing: { ...defaultData().processing },
    };

    for (let index = resumeAt; index < chunks.length; index++) {
      if (!isSameChatContext(contextToken)) return false;
      const chunk = chunks[index];
      const prompt = buildCodexRebuildChunkPrompt(data, candidateHolder, chunk, index, chunks.length);
      showStatus(`正在分段重建人物索引 ${index + 1}/${chunks.length}`);
      const patch = await callSecondary([
        { role: 'system', content: 'Incrementally rebuild a private roleplay state index. Output only the complete requested Markdown structure.' },
        { role: 'user', content: prompt },
      ], 4200, { taskLabel: `人物索引重建第 ${index + 1}/${chunks.length} 段` });
      if (!isSameChatContext(contextToken)) return false;
      validateCodexPatchStructure(data, patch);

      const nextHolder = {
        codex: normalizedCodex(clonePlainObject(candidateHolder.codex)),
        relationshipTable: normalizeRelationshipTable(clonePlainObject(candidateHolder.relationshipTable)),
        trackedCharacters: [...(data.trackedCharacters || [])],
        processing: { ...defaultData().processing },
      };
      refreshCodexFromPatch(nextHolder, patch);
      const relationResult = applyRelationshipPatch(nextHolder, patch, null, {
        clearDirty: false,
        requireComplete: true,
        preserveKnownOnUnknown: true,
      });
      const expectedRows = normalizeRelationshipTable(data.relationshipTable).rows.length;
      if (!relationResult.complete || relationResult.matched !== expectedRows) {
        throw new Error(`第 ${index + 1}/${chunks.length} 段没有严格返回固定人物关系表：固定 ${expectedRows} 行，成功匹配 ${relationResult.matched} 行`);
      }
      if (!validateCodexCandidate(nextHolder.codex, patch)) {
        throw new Error(`第 ${index + 1}/${chunks.length} 段返回的状态索引为空、被截断或格式不完整`);
      }

      candidateHolder = nextHolder;
      const lastRow = chunk.at(-1)?.row;
      data.processing.codexRebuildCheckpoint = {
        version: 1,
        signature: checkpoint.signature,
        cursor: index + 1,
        totalChunks: chunks.length,
        candidateCodex: clonePlainObject(candidateHolder.codex),
        candidateRelationship: clonePlainObject(candidateHolder.relationshipTable),
        startedAt: checkpoint.startedAt || Date.now(),
        updatedAt: Date.now(),
        lastCompletedFloor: Number(lastRow?.index ?? -1),
      };
      data.processing.codexRebuildFailures = 0;
      data.processing.codexRetryAt = 0;
      saveMemory(true);
    }

    if (!validateCodexCandidate(candidateHolder.codex, JSON.stringify(candidateHolder.codex))) {
      throw new Error('分段重建完成，但最终状态索引为空或格式不完整');
    }
    commitCodexReplacement(data, candidateHolder.codex, materials, '完整分段重建成功前备份');
    commitRelationshipReplacement(data, candidateHolder.relationshipTable, materials[materials.length - 1]?.row || null);
    data.processing.lastCodexFloor = materials[materials.length - 1]?.row?.index ?? -1;
    data.processing.lastError = '';
    saveMemory(true);
    updatePreview();
    if (confirmFirst) toastr?.success?.(`人物/物品/场景索引已按 ${chunks.length} 段完整重建`, 'Anchor Memory');
    return true;
  } catch (err) {
    if (!isSameChatContext(contextToken)) return false;
    data.processing.lastError = err.message;
    data.processing.codexRebuildFailures = Number(data.processing.codexRebuildFailures || 0) + 1;
    data.processing.codexRetryAt = Date.now() + codexRebuildRetryDelay(data.processing.codexRebuildFailures);
    const progress = data.processing.codexRebuildCheckpoint;
    const cursor = Math.min(Number(progress?.cursor || 0), chunks.length);
    markCodexDirty(data, `索引分段重建暂停于 ${cursor}/${chunks.length}：${err.message}`, false, true);
    saveMemory(true);
    if (confirmFirst) toastr?.error?.(`人物索引重建暂停于 ${cursor}/${chunks.length}：${err.message}。已保存进度，下次从未完成分段继续。`, 'Anchor Memory');
    return false;
  } finally {
    if (state.contextEpoch === operationEpoch) state.codexRunning = false;
    if (!isSameChatContext(contextToken)) return;
    data.processing.codexBusy = false;
    saveMemory(true);
    showStatus(statusText(memoryData()));
    if (!confirmFirst && data.processing?.codexDirty) scheduleCodexBacklog(4);
    flushDeferredIntervalRecheck();
  }
}

async function rebuildRelationshipFromGodlogs(confirmFirst = true) {
  const data = memoryData();
  // Relationship values and the other entity indexes are derived from the same chronological
  // memory. Rebuilding the relationship table with one giant standalone prompt duplicated the same
  // timeout risk and could leave it out of sync with people/items/scenes. Route both manual and
  // automatic relationship rebuilds through the transactional chunked rebuild instead.
  markRelationshipDirty(data, data.processing?.relationshipDirtyReason || '固定人物关系表需要按当前有效剧情重建');
  markCodexDirty(data, data.processing?.codexDirtyReason || '固定人物关系表变化后同步重建人物/物品/场景索引', false);
  saveMemory(true);
  return rebuildCodexFromGodlogs(confirmFirst);
}

function scheduleCodexBacklog(limit = 4) {
  if (!secondaryConfigured()) return;
  // Frequent chat renders used to clear and recreate this timer, while failed full rebuilds could
  // be launched again almost immediately. Keep one timer, honor persisted backoff, and stop
  // automatic retries after three consecutive no-progress failures. The manual rebuild button can
  // always resume from the saved checkpoint.
  if (state.codexTimer) return;
  const data = memoryData();
  const failures = Number(data.processing?.codexRebuildFailures || 0);
  if (data.processing?.codexDirty && failures >= 3 && Number(data.processing?.codexRetryAt || 0) > 0) return;
  const delay = data.processing?.codexDirty
    ? Math.max(900, Number(data.processing?.codexRetryAt || 0) - Date.now())
    : 900;
  state.codexTimer = setTimeout(() => {
    state.codexTimer = null;
    const latest = memoryData();
    const task = latest.processing?.codexDirty
      ? rebuildCodexFromGodlogs(false)
      : latest.processing?.relationshipDirty
        ? rebuildRelationshipFromGodlogs(false)
        : processCodexBacklog(limit);
    Promise.resolve(task).catch(err => console.warn('[AnchorMemory] codex task failed', err));
  }, delay);
}

function buildAnchorPrompt(data, materials) {
  const s = settings();
  const next = data.processing.anchorCount + 1;
  const rows = materials.map(item => item.row);
  const start = rows[0]?.assistantNumber || rows[0]?.index + 1 || 0;
  const end = rows[rows.length - 1]?.assistantNumber || rows[rows.length - 1]?.index + 1 || 0;

  return `你是长篇角色扮演的后台锚点整理员。请只把下面这一批新增记忆材料压缩成一个独立锚点。绝大多数材料是逐楼摘要；若个别楼层标记为“保底原文”，它是摘要失败后的唯一事实来源，必须按原文提取且不得补写。

${renderTemplate(s.anchorRules || DEFAULT_ANCHOR_RULES)}

输出必须严格采用以下结构，不要添加其他章节：

### 第 ${next} 次锚点记录

**本次新增锚点：**
* **[时间] - [事件名称]：** 地点；起因；人物；详细过程；重要物品；结果/影响；核心对话原话（必须注明谁说了什么）。

本批对应 AI 回合：第 ${start}-${end} 回合。

## 本批新增记忆材料
${formatGodlogMaterials(materials)}`;
}

function sourceKeysForAnchorRewrite(data, anchor) {
  const direct = (anchor?.sourceKeys || []).filter(Boolean);
  if (direct.length) return [...new Set(direct)];
  const covered = (anchor?.coveredKeys || []).filter(Boolean);
  if (covered.length) return [...new Set(covered)];
  const byId = new Map((data?.godlogs || []).map(item => [item.id, item.key]));
  return [...new Set((anchor?.sourceGodlogIds || []).map(id => byId.get(id)).filter(Boolean))];
}

function manualRewriteMaterialsForKeys(data, sourceKeys = []) {
  const rows = chatRows(true).filter(row => row.role === 'assistant');
  const rowByKey = new Map(rows.map(row => [row.key, row]));
  const materials = [];
  const missingKeys = [];
  for (const key of [...new Set((sourceKeys || []).filter(Boolean))]) {
    const row = rowByKey.get(key);
    if (!row) {
      missingKeys.push(key);
      continue;
    }
    const godlog = godlogForRow(data, row);
    if (isGodlogReady(godlog, row)) {
      materials.push({ row, godlog, mode: 'godlog' });
      continue;
    }
    const fallbackText = rawFallbackTextForRow(row, 8000);
    if (fallbackText) materials.push({ row, godlog: null, mode: 'raw-fallback', fallbackText });
    else missingKeys.push(key);
  }
  return { materials, missingKeys };
}

function buildAnchorRewritePrompt(data, anchor, materials, missingKeys = []) {
  const s = settings();
  const number = Number(anchor?.number || 1);
  const rows = (materials || []).map(item => item.row).filter(Boolean);
  const start = rows[0]?.assistantNumber || rows[0]?.index + 1 || 0;
  const end = rows[rows.length - 1]?.assistantNumber || rows[rows.length - 1]?.index + 1 || 0;
  const missingNote = missingKeys.length
    ? `注意：有 ${missingKeys.length} 个原始楼层已不存在或无法读取。现有锚点只能用于防止关键事实丢失；不得据此扩写新事实。`
    : '全部原始楼层仍可读取。原始逐楼摘要/保底原文是唯一权威事实来源；现有锚点仅用于核对是否遗漏。';

  return `你是长篇角色扮演的后台锚点整理员。请重新生成下面这一个既有分段锚点。此次操作是“重写”，不是新增锚点：必须保留原编号、原覆盖范围，不得引入覆盖范围之外的新事实。

${renderTemplate(s.anchorRules || DEFAULT_ANCHOR_RULES)}

${missingNote}

输出必须严格采用以下结构，不要添加其他章节：

### 第 ${number} 次锚点记录

**本次新增锚点：**
* **[时间] - [事件名称]：** 地点；起因；人物；详细过程；重要物品；结果/影响；核心对话原话（必须注明谁说了什么）。

本锚点原覆盖 AI 回合：第 ${start || '未明'}-${end || '未明'} 回合。

## 原始记忆材料
${formatGodlogMaterials(materials) || '（原始楼层已不可读取，只能依据现有锚点进行保守压缩）'}

## 现有锚点（仅用于防漏核对）
${clampTextHeadTail(anchor?.body || '', 10000, 0.45)}`;
}

function anchorBatchSize(anchor = null) {
  const sourceCount = Array.isArray(anchor?.sourceKeys) ? anchor.sourceKeys.length : 0;
  const legacyCount = Array.isArray(anchor?.sourceGodlogIds) ? anchor.sourceGodlogIds.length : 0;
  return Math.max(1, Number(anchor?.batchSize) || sourceCount || legacyCount || Number(anchor?.intervalUsed) || DEFAULT_ANCHOR_INTERVAL);
}

function anchorBatchLabel(anchor = null) {
  return `${anchorBatchSize(anchor)}回合锚点`;
}

function buildMergePrompt(data, plan, force = false) {
  const s = settings();
  const next = data.processing.mergeCount + 1;
  const previousMerge = latestMerge(data)?.body || '（暂无上一次历史锚点，这是第一次全量合并）';
  const blocks = (plan?.blocks || []).map((block, index) => {
    const label = block.kind === 'anchor'
      ? `${anchorBatchLabel(block.item)}：第${block.item?.number || index + 1}次`
      : block.kind === 'raw-fallback'
        ? `摘要失败保底原文：第${block.row?.assistantNumber || block.row?.index + 1 || index + 1}回合`
        : `逐楼摘要：第${block.row?.assistantNumber || block.row?.index + 1 || index + 1}回合`;
    const body = block.kind === 'anchor'
      ? safePromptMemoryText('anchor', block.item, 6500)
      : block.kind === 'raw-fallback'
        ? clampTextHeadTail(block.fallbackText || rawFallbackTextForRow(block.row, 8000), 8000, 0.38)
        : safePromptMemoryText('godlog', block.item, 1400);
    return `### ${label}\n${body}`;
  }).join('\n\n---\n\n');

  return `你是长篇角色扮演的后台历史压缩员。请把“上一次历史锚点”和“本周期新增记忆”合并为一份新的累计历史锚点。

${renderTemplate(s.mergeRules || DEFAULT_MERGE_RULES)}

无论自定义规则如何，以下压缩约束必须执行：同一剧情日、同一目标或同一核心冲突连续推进的多个场景必须合并为一条因果事件链；禁止按地点切换、吃饭、回家、发消息或每轮对话机械拆条。只有剧情日期、核心矛盾、行动目标或关系阶段发生实质改变时才另起一条。

输出必须严格采用以下结构，不要添加其他章节：

### 第 ${next} 次全量合并锚点

**历史锚点简述**
* **[日期/短时间段] - [合并后的主事件名称]：** 起因 -> 连续推进/核心冲突 -> 结果/影响。关键转折、伏笔、道具与必要原话保留并注明说话人。

## 上一次历史锚点
${clampText(previousMerge, 14000)}

## 本周期新增记忆（${plan?.anchorCount ? `${plan.anchorCount}个分段锚点 / ` : ''}${plan?.sourceKeys?.length || 0}个AI回合${force ? '，手动合并' : ''}）
${clampText(blocks, 26000)}`;
}

function buildMergeRewritePrompt(data, merge) {
  const s = settings();
  const number = Number(merge?.number || data.processing?.mergeCount || 1);
  return `你是长篇角色扮演的后台历史压缩员。请在不添加新事实、不遗漏关键转折的前提下，把下面已经存在的累计历史锚点重新整理为更短、更连贯的版本。

${renderTemplate(s.mergeRules || DEFAULT_MERGE_RULES)}

无论自定义规则如何，以下压缩约束必须执行：同一剧情日、同一目标或同一核心冲突连续推进的多个场景必须合并为一条因果事件链；禁止按地点切换、吃饭、回家、发消息或每轮对话机械拆条。只有剧情日期、核心矛盾、行动目标或关系阶段发生实质改变时才另起一条。

这是对现有累计历史的重写，不是新增一次合并。必须保留原编号，只输出以下结构，不添加其他章节：

### 第 ${number} 次全量合并锚点

**历史锚点简述**
* **[日期/短时间段] - [合并后的主事件名称]：** 起因 -> 连续推进/核心冲突 -> 结果/影响。关键转折、伏笔、道具与必要原话保留并注明说话人。

## 待重写的现有累计历史锚点
${clampTextHeadTail(merge?.body || '', 42000, 0.42)}`;
}

function mergePlanBlocksForRewrite(data, sourceKeys = [], materials = []) {
  const sourceKeySet = new Set(sourceKeys || []);
  const rowOrder = new Map((sourceKeys || []).map((key, index) => [key, index]));
  const represented = new Set();
  const blocks = [];

  for (const anchor of activeAnchors(data)) {
    const keys = (anchor.sourceKeys || []).filter(Boolean);
    if (!keys.length || !keys.every(key => sourceKeySet.has(key))) continue;
    keys.forEach(key => represented.add(key));
    blocks.push({
      kind: 'anchor',
      item: anchor,
      order: Math.min(...keys.map(key => rowOrder.get(key) ?? Number.MAX_SAFE_INTEGER)),
    });
  }

  for (const material of materials || []) {
    if (!material?.row || represented.has(material.row.key)) continue;
    if (material.godlog && isGodlogReady(material.godlog, material.row)) {
      blocks.push({ kind: 'godlog', item: material.godlog, row: material.row, order: rowOrder.get(material.row.key) ?? 0 });
    } else {
      blocks.push({
        kind: 'raw-fallback',
        item: null,
        row: material.row,
        fallbackText: material.fallbackText || rawFallbackTextForRow(material.row, 8000),
        order: rowOrder.get(material.row.key) ?? 0,
      });
    }
  }
  return blocks.sort((a, b) => a.order - b.order);
}

function renderMergeRewriteBlocks(blocks = []) {
  return blocks.map((block, index) => {
    const label = block.kind === 'anchor'
      ? `${anchorBatchLabel(block.item)}：第${block.item?.number || index + 1}次`
      : block.kind === 'raw-fallback'
        ? `摘要失败保底原文：第${block.row?.assistantNumber || block.row?.index + 1 || index + 1}回合`
        : `逐楼摘要：第${block.row?.assistantNumber || block.row?.index + 1 || index + 1}回合`;
    const body = block.kind === 'anchor'
      ? safePromptMemoryText('anchor', block.item, 6500)
      : block.kind === 'raw-fallback'
        ? clampTextHeadTail(block.fallbackText || rawFallbackTextForRow(block.row, 8000), 8000, 0.38)
        : safePromptMemoryText('godlog', block.item, 1400);
    return `### ${label}\n${body}`;
  }).join('\n\n---\n\n');
}

function mergeRewriteSourcePlan(data, merge) {
  const merges = activeMerges(data);
  const index = merges.findIndex(item => item.id === merge?.id);
  const previous = merge?.previousMergeId
    ? merges.find(item => item.id === merge.previousMergeId) || null
    : (index > 0 ? merges[index - 1] : null);
  const previousKeys = new Set(previous?.sourceKeys || []);
  const cycleSourceKeys = Array.isArray(merge?.cycleSourceKeys) && merge.cycleSourceKeys.length
    ? [...new Set(merge.cycleSourceKeys.filter(Boolean))]
    : [...new Set((merge?.sourceKeys || []).filter(key => !previousKeys.has(key)))];
  const source = manualRewriteMaterialsForKeys(data, cycleSourceKeys);
  const blocks = mergePlanBlocksForRewrite(data, cycleSourceKeys, source.materials);
  return { previous, cycleSourceKeys, materials: source.materials, missingKeys: source.missingKeys, blocks };
}

function buildMergeSourceRewritePrompt(data, merge, plan) {
  const s = settings();
  const number = Number(merge?.number || 1);
  const missingNote = plan.missingKeys.length
    ? `有 ${plan.missingKeys.length} 个本周期原始楼层已不存在或无法读取。必须保守重写，现有累计锚点只可用于防漏，不得扩写新事实。`
    : '本周期原始材料仍可读取，应以这些材料和上一次累计历史为权威来源，现有版本仅用于核对遗漏。';

  return `你是长篇角色扮演的后台历史压缩员。请重新生成下面这一次既有全量合并。此次操作是“重写”，不是新增一次合并：必须保留原编号和原覆盖边界，不得把后续剧情提前写入。

${renderTemplate(s.mergeRules || DEFAULT_MERGE_RULES)}

无论自定义规则如何，以下压缩约束必须执行：同一剧情日、同一目标或同一核心冲突连续推进的多个场景必须合并为一条因果事件链；禁止按地点切换、吃饭、回家、发消息或每轮对话机械拆条。只有剧情日期、核心矛盾、行动目标或关系阶段发生实质改变时才另起一条。

${missingNote}

输出必须严格采用以下结构，不要添加其他章节：

### 第 ${number} 次全量合并锚点

**历史锚点简述**
* **[日期/短时间段] - [合并后的主事件名称]：** 起因 -> 连续推进/核心冲突 -> 结果/影响。关键转折、伏笔、道具与必要原话保留并注明说话人。

## 上一次累计历史
${clampText(plan.previous?.body || '（这是第一次全量合并，没有上一次累计历史）', 12000)}

## 本次原始新增材料（${plan.cycleSourceKeys.length}个AI回合）
${clampText(renderMergeRewriteBlocks(plan.blocks), 26000) || '（原始新增材料已不可读取）'}

## 当前这一次全量合并（仅用于防漏核对）
${clampTextHeadTail(merge?.body || '', 10000, 0.42)}`;
}

function clearRemovedMergeReferences(data, removedIds = []) {
  const removed = new Set(removedIds.filter(Boolean));
  if (!removed.size) return;
  for (const anchor of data.anchors || []) {
    if (removed.has(anchor.compactedIntoMergeId)) delete anchor.compactedIntoMergeId;
  }
}

function rollbackMergesDependingOnKeys(data, sourceKeys = []) {
  const keySet = new Set(sourceKeys.filter(Boolean));
  const removed = [];
  let cascade = false;
  data.merges = (data.merges || []).filter(merge => {
    const touches = (merge.sourceKeys || []).some(key => keySet.has(key));
    if (cascade || touches) {
      cascade = true;
      removed.push(merge);
      removeStoredVector(data, merge.id);
      return false;
    }
    return true;
  });
  clearRemovedMergeReferences(data, removed.map(item => item.id));
  return removed;
}

function rollbackMergesAfterItem(data, merge) {
  const index = (data.merges || []).findIndex(item => item.id === merge?.id);
  if (index < 0) return [];
  const removed = data.merges.slice(index + 1);
  for (const item of removed) removeStoredVector(data, item.id);
  data.merges = data.merges.slice(0, index + 1);
  clearRemovedMergeReferences(data, removed.map(item => item.id));
  return removed;
}

async function rewriteAnchorItemUnlocked(data, anchor, contextToken) {
  const anchorSourceKeys = sourceKeysForAnchorRewrite(data, anchor);
  const source = manualRewriteMaterialsForKeys(data, anchorSourceKeys);
  showStatus(`正在重写第 ${anchor?.number || 1} 次分段锚点`);
  try {
    const number = Number(anchor?.number || 1);
    const body = normalizeAnchorBody(await callWriter(buildAnchorRewritePrompt(data, anchor, source.materials, source.missingKeys), 5200), number);
    if (!isSameChatContext(contextToken)) return false;
    if (!body || body.trim().length < 100) throw new Error('重写后的锚点内容为空或过短');

    const previousBody = anchor.body;
    const removedMerges = rollbackMergesDependingOnKeys(data, anchorSourceKeys);
    anchor.body = body.trim();
    anchor.rewrittenAt = Date.now();
    anchor.updatedAt = Date.now();
    anchor.rewriteCount = Number(anchor.rewriteCount || 0) + 1;
    anchor.previousBodyHash = stableHash(previousBody);
    removeStoredVector(data, anchor.id);
    markCodexDirty(data, '分段锚点被重写');
    renumberDerivedMemory(data);
    refreshCoverageMaps(data);
    saveMemory(true);
    try { await enforceAnchorHiddenState(data); } catch (err) { console.warn('[AnchorMemory] rewritten anchor hide reconciliation failed', err); }
    if (!isSameChatContext(contextToken)) return false;
    if (removedMerges.length) queueMemoryJob('锚点重写后重建累计历史', 180);
    safeUpdatePreview('分段锚点重写后刷新');
    if (state.selectedMemoryId === anchor.id) $('#am_timeline_detail').val(anchor.body);
    toastr?.success?.(`第 ${number} 次分段锚点已重写${removedMerges.length ? `；已回滚 ${removedMerges.length} 个依赖合并并等待重建` : ''}`, 'Anchor Memory');
    return true;
  } catch (err) {
    if (!isSameChatContext(contextToken)) return false;
    data.processing.lastError = err.message || String(err);
    saveMemory();
    toastr?.error?.(`分段锚点重写失败，旧版本仍保留：${err.message}`, 'Anchor Memory');
    return false;
  } finally {
    if (isSameChatContext(contextToken)) showStatus(statusText(data));
  }
}

async function rewriteMergeItemUnlocked(data, merge, contextToken) {
  const plan = mergeRewriteSourcePlan(data, merge);
  showStatus(`正在重写第 ${merge?.number || 1} 次累计历史`);
  try {
    const number = Number(merge?.number || 1);
    const prompt = plan.cycleSourceKeys.length
      ? buildMergeSourceRewritePrompt(data, merge, plan)
      : buildMergeRewritePrompt(data, merge);
    const body = normalizeMergeBody(await callWriter(prompt, 6200), number);
    if (!isSameChatContext(contextToken)) return false;
    if (!body || body.trim().length < 120) throw new Error('重写后的合并内容为空或过短');

    const previousBody = merge.body;
    const removedLater = rollbackMergesAfterItem(data, merge);
    merge.body = body.trim();
    merge.rewrittenAt = Date.now();
    merge.updatedAt = Date.now();
    merge.rewriteCount = Number(merge.rewriteCount || 0) + 1;
    merge.previousBodyHash = stableHash(previousBody);
    removeStoredVector(data, merge.id);
    markCodexDirty(data, '累计历史锚点被重写');
    renumberDerivedMemory(data);
    refreshCoverageMaps(data);
    saveMemory(true);
    try { await enforceAnchorHiddenState(data); } catch (err) { console.warn('[AnchorMemory] rewritten merge hide reconciliation failed', err); }
    if (!isSameChatContext(contextToken)) return false;
    if (removedLater.length) queueMemoryJob('累计历史重写后重建后续记录', 180);
    safeUpdatePreview('累计历史重写后刷新');
    if (state.selectedMemoryId === merge.id) $('#am_timeline_detail').val(merge.body);
    toastr?.success?.(`第 ${number} 次累计历史已重写${removedLater.length ? `；已回滚后续 ${removedLater.length} 次合并并等待重建` : ''}`, 'Anchor Memory');
    return true;
  } catch (err) {
    if (!isSameChatContext(contextToken)) return false;
    data.processing.lastError = err.message || String(err);
    saveMemory();
    toastr?.error?.(`累计历史重写失败，旧版本仍保留：${err.message}`, 'Anchor Memory');
    return false;
  } finally {
    if (isSameChatContext(contextToken)) showStatus(statusText(data));
  }
}

async function rewriteMemoryItem(id) {
  if (!hasPersistentChatContext()) {
    toastr?.info?.('当前没有可写入记忆的聊天，请先打开一个角色聊天。', 'Anchor Memory');
    return false;
  }
  if (!settings().enabled) {
    toastr?.info?.('锚点书当前已暂停，请先点击顶部“启动插件”。', 'Anchor Memory');
    return false;
  }
  const found = findMemoryItem(id);
  if (!found) {
    toastr?.warning?.('找不到要重写的分段锚点或累计历史', 'Anchor Memory');
    return false;
  }
  if (state.anchorPreparing || state.mergeRunning || state.running) {
    toastr?.warning?.('已有锚点、重写或累计历史任务正在运行，请勿重复点击', 'Anchor Memory');
    return false;
  }

  const operationEpoch = state.contextEpoch;
  const contextToken = captureChatContextToken(found.data);
  if (found.kind === 'anchor') state.anchorPreparing = true;
  else state.mergeRunning = true;
  if (found.data?.processing) {
    if (found.kind === 'anchor') found.data.processing.busy = true;
    else found.data.processing.mergeBusy = true;
    saveMemory();
  }
  try {
    return found.kind === 'anchor'
      ? await rewriteAnchorItemUnlocked(found.data, found.item, contextToken)
      : await rewriteMergeItemUnlocked(found.data, found.item, contextToken);
  } finally {
    if (state.contextEpoch === operationEpoch) {
      if (found.kind === 'anchor') state.anchorPreparing = false;
      else state.mergeRunning = false;
    }
    if (found.data?.processing && isSameChatContext(contextToken)) {
      if (found.kind === 'anchor') found.data.processing.busy = false;
      else found.data.processing.mergeBusy = false;
      saveMemory(true);
    }
    flushDeferredIntervalRecheck();
  }
}

async function rewriteLatestAnchor() {
  const data = memoryData();
  const anchor = latestAnchor(data);
  if (!anchor) {
    toastr?.info?.('当前还没有可重写的分段锚点', 'Anchor Memory');
    return false;
  }
  return rewriteMemoryItem(anchor.id);
}

async function rewriteLatestMerge() {
  const data = memoryData();
  const merge = latestMerge(data);
  if (!merge) {
    toastr?.info?.('当前还没有可重写的累计历史', 'Anchor Memory');
    return false;
  }
  return rewriteMemoryItem(merge.id);
}

async function rewriteSelectedMemory() {
  if (!state.selectedMemoryId) {
    toastr?.warning?.('请先在记忆库选择一条分段锚点或累计历史', 'Anchor Memory');
    return false;
  }
  return rewriteMemoryItem(state.selectedMemoryId);
}

function recentNarrativeQuery(chat = getContext().chat || [], limit = 6) {
  return (Array.isArray(chat) ? chat : [])
    .filter(message => message && isNarrativeMessage(message))
    .map(message => outboundMessageText(message))
    .filter(Boolean)
    .slice(-Math.max(1, Number(limit) || 6))
    .join('\n');
}

function normalizeEntityMatchText(text) {
  return String(text || '')
    .toLocaleLowerCase()
    .replace(/[`*_~<>\[\]{}()（）【】「」『』“”‘’'"，。！？、；：:;,.!?/\\|\s-]+/g, '');
}

function entityTokensFromCell(cell) {
  const raw = String(cell || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[`*_~]/g, ' ')
    .trim();
  const candidates = new Set([raw]);
  for (const part of raw.split(/[／/、,，;；|()（）【】\[\]：:·•]+/)) {
    if (part.trim()) candidates.add(part.trim());
  }
  for (const part of raw.split(/\s+/)) {
    if (part.trim()) candidates.add(part.trim());
  }
  return [...candidates]
    .map(value => normalizeEntityMatchText(value))
    .filter(value => {
      if (!value || /^(?:未明|暂无|无|未知|角色名|人物)$/.test(value)) return false;
      return /^[a-z0-9]+$/i.test(value) ? value.length >= 3 : value.length >= 2;
    });
}

function selectMentionedTableRows(markdown, query, headerCandidates = [], maxRows = 12) {
  const tableLines = String(markdown || '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('|') && line.endsWith('|'));
  if (tableLines.length < 3) return '';
  const headers = tableLines[0].split('|').slice(1, -1).map(cell => cell.trim());
  let keyIndex = headerCandidates
    .map(name => headers.findIndex(header => header === name || header.includes(name)))
    .find(index => index >= 0);
  if (!Number.isInteger(keyIndex) || keyIndex < 0) keyIndex = 0;

  const normalizedQuery = normalizeEntityMatchText(query);
  if (!normalizedQuery) return '';
  const matched = [];
  for (const line of tableLines.slice(2)) {
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
    const tokens = entityTokensFromCell(cells[keyIndex] || '');
    if (tokens.some(token => normalizedQuery.includes(token))) matched.push(line);
    if (matched.length >= Math.max(1, Number(maxRows) || 12)) break;
  }
  if (matched.length === 0) return '';
  return [tableLines[0], tableLines[1], ...matched].join('\n');
}

function tableWithLimitedRows(markdown, maxRows = 12) {
  const lines = String(markdown || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  const tableLines = lines.filter(line => line.startsWith('|') && line.endsWith('|'));
  if (tableLines.length < 3) return '';
  return [...tableLines.slice(0, 2), ...tableLines.slice(2, 2 + Math.max(1, Number(maxRows) || 12))].join('\n');
}

function relationshipInjectionBlock(data, maxChars = RELATIONSHIP_MEMORY_CHAR_BUDGET) {
  const table = normalizeRelationshipTable(data.relationshipTable, data.codex?.relationship || '');
  const rows = table.rows.filter(row => row.past || row.development || row.current);
  if (rows.length === 0) {
    return data.processing?.relationshipDirty
      ? '（人物关系表正在重建，当前安全快照尚无已确认关系内容）'
      : '（暂无已确认的人物关系变化）';
  }
  const content = rows.map(row => [
    `### ${renderMacros(row.name)}`,
    `过去：${renderMacros(row.past || '未明')}`,
    `发展：${renderMacros(row.development || '未明')}`,
    `当前：${renderMacros(row.current || '未明')}`,
  ].join('\n')).join('\n\n');
  const prefix = data.processing?.relationshipDirty
    ? `（以下为已回退并验证的安全关系快照${table.lastGoodFloor >= 0 ? `，截至第 ${table.lastGoodFloor + 1} 楼` : ''}；最新等待生成摘要的楼层暂未计入，重建完成后自动更新）\n`
    : '';
  return clampTextHeadTail(`${prefix}${content}`, maxChars, 0.34);
}

function anchorEventInjectionBlock(data, charScale = 1) {
  const parts = [];
  const anchorInterval = normalizeAnchorInterval(settings().anchorInterval);
  const mergeAnchorInterval = normalizeMergeAnchorInterval(settings().mergeAnchorInterval);
  const merge = latestMerge(data);
  parts.push(`**1. 历史锚点简述（每 ${mergeAnchorInterval} 个分段锚点累计合并一次）：**`);
  parts.push(merge
    ? safePromptMemoryText('merge', merge, Math.round(7600 * charScale))
    : `（尚未累计到 ${mergeAnchorInterval} 个分段锚点，暂无累计历史锚点）`);
  parts.push(`**2. 本次新增锚点（每 ${anchorInterval} 个有效AI回合）：**`);
  const anchors = activeAnchorsAfterMerge(data);
  if (anchors.length === 0) parts.push(`（暂无尚未并入累计历史的 ${anchorInterval} 回合锚点）`);
  else {
    for (const anchor of anchors) {
      // normalizeAnchorBody() already includes the numbered heading. Do not add a second duplicate heading.
      parts.push(safePromptMemoryText('anchor', anchor, Math.round(2600 * charScale)));
    }
  }
  // Do not pre-trim the combined anchor block here. fitMemorySections() owns the final token
  // budget, so a second head/tail trim would silently delete a different middle slice twice.
  return parts.join('\n\n');
}

function codexSnapshotSafeForInjection(data) {
  if (!data?.processing?.codexDirty) return true;
  if (!codexHasContent(data.codex)) return false;
  if (/人物纪要追踪名单已变化/.test(String(data.processing?.codexDirtyReason || ''))) return false;
  // A dirty flag can be caused by an interrupted rebuild while the currently stored snapshot still
  // covers only completed history. It is safe to keep injecting that snapshot when there is no hole
  // inside the completed timeline and the snapshot does not claim a floor newer than the last ready
  // summary. Confirmed deletion/reroll of an older processed floor fails one of these checks and the
  // non-relationship indexes remain withheld until a full rebuild succeeds.
  const partition = rebuildGodlogTimelinePartition(data);
  if (partition.blockedRows.length > 0) return false;
  const lastReadyFloor = partition.materials.reduce((max, entry) => Math.max(max, Number(entry.row?.index ?? -1)), -1);
  const lastCodexFloor = Number(data.processing?.lastCodexFloor ?? -1);
  const unsafeFromFloor = data.processing?.codexUnsafeFromFloor;
  // If an already-indexed historical floor was edited, deleted, rerolled or manually re-summarized,
  // the cumulative tables may still contain the superseded fact. Merely having a new valid summary
  // for that floor does not make the old table safe again; only a successful rebuild can subtract it.
  if (unsafeFromFloor !== null && unsafeFromFloor !== ''
      && Number.isFinite(Number(unsafeFromFloor))
      && Number(unsafeFromFloor) <= lastCodexFloor) return false;
  return lastCodexFloor <= lastReadyFloor;
}

function injectionCodex(data) {
  return codexSnapshotSafeForInjection(data) ? normalizedCodex(data.codex) : null;
}

function codexSafeSnapshotPrefix(data, label = '状态索引', safeSnapshot = undefined) {
  const safe = safeSnapshot === undefined ? codexSnapshotSafeForInjection(data) : !!safeSnapshot;
  return data.processing?.codexDirty && safe
    ? `（以下为最近一次已验证的${label}安全快照；最新待摘要或待重建楼层暂未计入，若与最近正文冲突以最近正文为准）\n`
    : '';
}

function matchedPeopleInjectionBlock(data, chat, codexOverride = undefined) {
  if (!settings().recallMentionedPeople) return '（人物索引召回未启用）';
  const codex = codexOverride === undefined ? injectionCodex(data) : codexOverride;
  if (!codex) return '（出场人物表正在安全重建；当前没有可确认的回退快照）';
  const query = recentNarrativeQuery(chat, 6);
  const matched = selectMentionedTableRows(codex.peopleIndex, query, ['角色名', '人物'], 12);
  const content = matched || '（本轮上下文未匹配到需要补充的出场人物）';
  return `${codexSafeSnapshotPrefix(data, '出场人物表', !!codex)}${content}`;
}

function importantItemsInjectionBlock(data, chat, codexOverride = undefined) {
  if (!settings().injectImportantItems) return '（重要物品表注入未启用）';
  const codex = codexOverride === undefined ? injectionCodex(data) : codexOverride;
  if (!codex) return '（重要物品表正在安全重建；当前没有可确认的回退快照）';
  if (!codex.itemIndex) return '（暂无需要持续带入的重要道具、梗或核心细节）';
  const query = recentNarrativeQuery(chat, 6);
  const matched = selectMentionedTableRows(codex.itemIndex, query, ['物品/细节/内部梗', '物品', '细节'], 12);
  // The item ledger already contains only plot-relevant items. Prefer current matches, but retain a
  // bounded ledger fallback so an unmentioned but continuously carried key item is not forgotten.
  const content = matched || tableWithLimitedRows(codex.itemIndex, 10) || '（暂无）';
  return `${codexSafeSnapshotPrefix(data, '重要物品表', !!codex)}${content}`;
}

function buildCoreInjection(data, chat = getContext().chat || []) {
  const trackedLabel = trackedCharacterLabel(data);
  const codex = injectionCodex(data);
  const characterMemoContent = codex
    ? (sanitizeCharacterMemoSection(data, codex.characterMemo) || '（暂无明确核心转变）')
    : '（人物动态表正在安全重建；当前没有可确认的回退快照）';
  const characterMemo = `${codexSafeSnapshotPrefix(data, '人物动态表', !!codex)}${characterMemoContent}`;
  return [
    '锚点记录',
    '使用边界：以下均为已经发生的剧情记忆。直接延续当前正文，不复述资料标题，不写整理说明；若与最近正文冲突，以最近正文为准。',
    '【一. 人物关系】',
    relationshipInjectionBlock(data),
    '【二. 锚点事件】',
    anchorEventInjectionBlock(data),
    `【三. ${trackedLabel} 动态演变（核心转变）】`,
    safeCodexText(characterMemo, 2800),
    '【四. 匹配到的出场人物库】',
    safeCodexText(matchedPeopleInjectionBlock(data, chat, codex), 1800),
    '【五. 重要道具、梗与核心细节】',
    safeCodexText(importantItemsInjectionBlock(data, chat, codex), 1800),
  ].join('\n\n');
}

function buildRecentFactsInjection(data, rows = chatRows(true), options = {}) {
  const commit = options.commit !== false;
  const recentFactsMeta = [];
  if (commit) state.lastRecentFactsMeta = [];
  refreshCoverageMaps(data);
  const assistantRows = rows.filter(row => row.role === 'assistant');
  const recentRawKeys = new Set(assistantRows
    .slice(-Math.max(1, Number(settings().keepRecent) || 3))
    .map(row => row.key));
  const coveredKeys = new Set([
    ...Object.keys(data.processing?.mergedKeys || {}),
    ...Object.keys(data.processing?.anchoredKeys || {}),
  ]);
  const candidates = assistantRows
    .filter(row => !recentRawKeys.has(row.key) && !coveredKeys.has(row.key))
    .map(row => ({ row, godlog: godlogForRow(data, row) }));
  const readyCandidates = candidates.filter(({ row, godlog }) => isGodlogReady(godlog, row));
  const missing = candidates.filter(({ row, godlog }) => !isGodlogReady(godlog, row) && rawFallbackEligible(row, assistantRows));
  // The old 1000-char-per-Godlog rendering could exceed the section's token allocation before the
  // first 15-turn anchor, causing fitMemorySections() to keep only the head and tail and silently
  // drop middle turns. Allocate a compact per-turn line so every unanchored ready floor remains
  // represented inside one bounded section.
  const readyTotalBudget = missing.length
    ? Math.max(1600, RECENT_READY_SUMMARY_TOTAL_CHAR_BUDGET - MISSING_RAW_FALLBACK_TOTAL_CHAR_BUDGET)
    : RECENT_READY_SUMMARY_TOTAL_CHAR_BUDGET;
  const perReadyBudget = readyCandidates.length
    ? Math.max(150, Math.min(420, Math.floor(readyTotalBudget / readyCandidates.length)))
    : 0;
  const entries = readyCandidates
    .map(({ row, godlog }) => ({ row, godlog, text: compactGodlogMemoryText(godlog.body || '', perReadyBudget) }))
    .filter(entry => entry.text);
  const perMissingBudget = missing.length
    ? Math.max(240, Math.floor(MISSING_RAW_FALLBACK_TOTAL_CHAR_BUDGET / missing.length))
    : 0;
  const fallbackEntries = missing
    .map(({ row }) => ({ row, text: rawFallbackTextForRow(row, perMissingBudget) }))
    .filter(entry => entry.text);
  if (entries.length === 0 && fallbackEntries.length === 0) return '';
  recentFactsMeta.push(...entries.map(({ row, godlog }) => injectionRef('godlog', godlog, {
    floor: row.index,
    key: row.key,
    method: 'unanchored-summary',
    title: godlogFieldValue(godlog.body || '', 'Title'),
  })));
  if (Array.isArray(options.metaTarget)) options.metaTarget.push(...recentFactsMeta);
  if (commit) state.lastRecentFactsMeta = recentFactsMeta;
  const parts = [`### 逐楼摘要（尚未进入每 ${normalizeAnchorInterval(settings().anchorInterval)} 回合锚点）`];
  if (fallbackEntries.length) {
    parts.push('#### 摘要失败楼层的临时保底原文');
    parts.push('以下只在对应逐楼摘要尚未成功、且原文已离开最近窗口时注入；禁止补写未显示的细节。');
    for (const { row, text } of fallbackEntries) {
      parts.push(`##### 第 ${row.assistantNumber || row.index + 1} 个AI回合（保底原文）`);
      parts.push(text);
    }
  }
  for (const { row, text } of entries) {
    parts.push(`#### 第 ${row.assistantNumber || row.index + 1} 个AI回合`);
    parts.push(text);
  }
  return clampTextHeadTail(parts.join('\n\n'), RECENT_FACTS_MEMORY_CHAR_BUDGET, fallbackEntries.length ? 0.58 : 0.28);
}

const RECALL_STOP_TERMS = new Set([
  '这个', '那个', '然后', '已经', '还是', '因为', '所以', '但是', '自己', '对方', '他们', '她们', '我们', '你们',
  '一个', '没有', '不是', '就是', '可以', '需要', '当前', '本楼', '剧情', '回复', '用户', '角色', '人物',
  'the', 'and', 'that', 'this', 'with', 'from', 'have', 'was', 'were', 'are', 'you', 'your', 'user', 'assistant',
]);

function keywordSet(text, maxTerms = 600) {
  const value = String(text || '').toLocaleLowerCase();
  const termLimit = Math.max(32, Math.min(1200, Number(maxTerms) || 600));
  const result = new Set();
  const add = token => {
    const value = String(token || '').trim();
    if (!value || RECALL_STOP_TERMS.has(value) || result.size >= termLimit) return;
    result.add(value);
  };

  for (const token of value.match(/[a-z0-9_]{3,}/g) || []) add(token);
  for (const sequence of value.match(/[\u3400-\u9fff]{2,}/g) || []) {
    if (sequence.length <= 16) add(sequence);
    const maxGram = Math.min(4, sequence.length);
    for (let width = 2; width <= maxGram; width++) {
      for (let index = 0; index <= sequence.length - width; index++) {
        const gram = sequence.slice(index, index + width);
        if (/^[的是了在和与及也都而或把被就又还很]+$/.test(gram)) continue;
        add(gram);
        if (result.size >= termLimit) return result;
      }
    }
  }
  return result;
}

function recallMaxCount() {
  return Math.max(1, Math.min(12, Number(settings().embeddingTopK) || 4));
}

function recallMinCount() {
  // Backward-compatible metadata name. Recall is no longer forced to return irrelevant minimum hits.
  return recallMaxCount();
}

function recallCandidateLimit() {
  return Math.max(12, Math.min(40, recallMaxCount() * 7));
}

function recallTokenBudget() {
  return Math.max(2200, Math.min(7200, 1400 + recallMaxCount() * 850));
}

function recallHitText(hit, limit = null) {
  return safePromptMemoryText(hit.kind, hit.item, limit || (hit.kind === 'merge' ? 2800 : 1800));
}

function recallScoreProfile(candidates = []) {
  const semanticScores = candidates.map(hit => Number(hit.semanticScore ?? (hit.method === 'embedding' ? hit.score : 0))).filter(score => score > 0);
  const keywordScores = candidates.map(hit => Number(hit.keywordScore ?? (hit.method === 'keyword' ? hit.score : 0))).filter(score => score > 0);
  const fusionScores = candidates.map(hit => Number(hit.score || 0)).filter(score => score > 0);
  const topSemantic = semanticScores.length ? Math.max(...semanticScores) : 0;
  const topKeyword = keywordScores.length ? Math.max(...keywordScores) : 0;
  const topFusion = fusionScores.length ? Math.max(...fusionScores) : 0;
  return {
    topSemantic,
    topKeyword,
    topFusion,
    semanticThreshold: topSemantic ? Math.max(0.28, topSemantic * 0.82) : Number.POSITIVE_INFINITY,
    keywordThreshold: topKeyword ? Math.max(1.5, topKeyword * 0.45) : Number.POSITIVE_INFINITY,
    fusionThreshold: topFusion ? Math.max(0.22, topFusion * 0.48) : Number.POSITIVE_INFINITY,
  };
}

function selectAdaptiveRecallHits(candidates) {
  const maxCount = recallMaxCount();
  const budget = recallTokenBudget();
  const profile = recallScoreProfile(candidates || []);
  const selected = [];
  let usedTokens = 0;

  for (const hit of candidates || []) {
    if (selected.length >= maxCount) break;
    const method = hit.method || 'keyword';
    const semanticScore = Number(hit.semanticScore ?? (method === 'embedding' ? hit.score : 0));
    const keywordScore = Number(hit.keywordScore ?? (method === 'keyword' ? hit.score : 0));
    const fusionScore = Number(hit.score || 0);
    const semanticStrong = semanticScore > 0 && semanticScore >= profile.semanticThreshold;
    const keywordStrong = keywordScore > 0 && keywordScore >= profile.keywordThreshold;
    const fusionStrong = fusionScore > 0 && fusionScore >= profile.fusionThreshold
      && (Number(hit.semanticNorm || 0) >= 0.34 || Number(hit.keywordNorm || 0) >= 0.44);
    const qualifies = method === 'keyword'
      ? keywordStrong
      : (semanticStrong || keywordStrong || fusionStrong);
    if (!qualifies) continue;

    const text = recallHitText(hit);
    const cost = estimateTokens(`${hit.kind} ${hit.item?.number || ''}
${text}`);
    if (usedTokens + cost > budget) continue;

    let recallReason = '相关度达标';
    if (semanticStrong && keywordStrong) recallReason = '语义 + 关键词/实体双重命中';
    else if (semanticStrong && keywordScore > 0) recallReason = '语义主导 · 关键词/实体辅助';
    else if (keywordStrong && semanticScore > 0) recallReason = '关键词/实体主导 · 语义辅助';
    else if (semanticStrong) recallReason = '语义相关度达标';
    else if (keywordStrong) recallReason = '关键词/实体相关度达标';
    else if (fusionStrong) recallReason = '混合相关度达标';

    selected.push({
      ...hit,
      recallReason,
      recallTokens: cost,
    });
    usedTokens += cost;
  }

  return {
    selected,
    budget,
    usedTokens,
    threshold: profile.fusionThreshold,
    semanticThreshold: profile.semanticThreshold,
    keywordThreshold: profile.keywordThreshold,
    minCount: 0,
    maxCount,
    candidateCount: (candidates || []).length,
  };
}

function rawRecallItem(row) {
  const rawText = row?.turnText || row?.text || '';
  const narrative = taggedNarrativeContent(rawText) || cleanText(rawText);
  const body = clampTextHeadTail(narrative, 3600, 0.42);
  const sourceRevision = row?.rawHash || stableHash(rawText);
  return {
    id: `am_raw_recall_${stableHash(`${row?.key || row?.index || 0}|${sourceRevision}`)}`,
    key: row?.key || '',
    number: row?.assistantNumber || 0,
    floor: row?.index ?? null,
    kind: 'raw-recall',
    body,
    title: '原楼正文保底',
  };
}

function recallCorpus(data) {
  const rows = chatRows(true).filter(row => row.role === 'assistant');
  const recentRawKeys = new Set(rows
    .slice(-Math.max(1, Number(settings().keepRecent) || 3))
    .map(row => row.key));
  const corpus = [];
  for (const row of rows) {
    if (recentRawKeys.has(row.key)) continue;
    const godlog = godlogForRow(data, row);
    if (isGodlogReady(godlog, row)) {
      corpus.push({ kind: 'godlog', item: godlog, text: safeGodlogMemoryText(godlog.body || '') });
      continue;
    }
    const raw = rawRecallItem(row);
    if (raw.body) corpus.push({ kind: 'raw-recall', item: raw, text: raw.body });
  }
  return corpus;
}

function keywordRecall(data, query, limit = recallCandidateLimit()) {
  const rankedTerms = [...keywordSet(query, 360)]
    .sort((a, b) => {
      const aLatin = /^[a-z0-9_]+$/i.test(a) ? 1 : 0;
      const bLatin = /^[a-z0-9_]+$/i.test(b) ? 1 : 0;
      return bLatin - aLatin || b.length - a.length;
    })
    .slice(0, 180);
  const terms = new Set(rankedTerms);
  if (terms.size === 0) return [];
  const liveCacheKeys = new Set();
  const candidates = recallCorpus(data).map(source => {
    const text = source.text || '';
    const cacheKey = `${source.kind}:${source.item?.id || source.item?.key || source.item?.number}:${stableHash(text)}`;
    liveCacheKeys.add(cacheKey);
    let cached = state.recallTermCache.get(cacheKey);
    if (!cached || cached instanceof Set) {
      cached = {
        terms: cached instanceof Set ? cached : keywordSet(text),
        normalized: normalizeEntityMatchText(text),
      };
      state.recallTermCache.set(cacheKey, cached);
    }
    return { ...source, own: cached.terms, normalized: cached.normalized };
  });
  if (state.recallTermCache.size > Math.max(64, liveCacheKeys.size * 2)) {
    for (const cacheKey of state.recallTermCache.keys()) {
      if (!liveCacheKeys.has(cacheKey)) state.recallTermCache.delete(cacheKey);
    }
  }
  const documentFrequency = new Map([...terms].map(term => [term, 0]));
  for (const candidate of candidates) {
    for (const term of terms) {
      if (candidate.own.has(term)) documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
    }
  }
  const documentCount = Math.max(1, candidates.length);
  return candidates
    .map(candidate => {
      let score = 0;
      for (const term of terms) {
        const frequency = documentFrequency.get(term) || 0;
        const prevalence = frequency / documentCount;
        if (candidate.own.has(term)) {
          if (prevalence > 0.65 && term.length <= 3) continue;
          const base = term.length >= 4 ? 3.5 : term.length === 3 ? 2.5 : 1.5;
          const idf = Math.log((documentCount + 1) / (frequency + 1)) + 0.3;
          score += base * idf;
        } else if (term.length >= 4 && candidate.normalized.includes(term)) {
          score += 0.55;
        }
      }
      // A ready Godlog is the preferred memory source. Raw正文 only fills a missing-summary hole.
      if (candidate.kind === 'godlog' && score > 0) score *= 1.06;
      const { own: _own, normalized: _normalized, ...result } = candidate;
      return { ...result, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score
      || Number(b.item?.floor ?? b.item?.number ?? 0) - Number(a.item?.floor ?? a.item?.number ?? 0))
    .slice(0, limit);
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa && bb ? dot / (Math.sqrt(aa) * Math.sqrt(bb)) : 0;
}

function embeddingConfigured() {
  const s = settings();
  const url = s.embeddingUrl || s.secondaryUrl;
  const key = s.embeddingKey || s.secondaryKey;
  return s.useEmbedding && url && key && !state.vectorStorageUnavailable;
}

function modelSupportsDimensions(model) {
  const id = String(model || '');
  return /text-embedding-3/i.test(id) || /Qwen\/Qwen3-Embedding-/i.test(id);
}

function embeddingRequestBody(texts) {
  const s = settings();
  const body = {
    model: s.embeddingModel,
    input: texts,
  };
  const mode = s.embeddingDimensionsMode || 'auto';
  const dimensions = Number(s.embeddingDimensions) || 0;
  if (dimensions > 0 && (mode === 'always' || (mode === 'auto' && modelSupportsDimensions(s.embeddingModel)))) {
    body.dimensions = dimensions;
  }
  return body;
}

function embeddingSignature() {
  const s = settings();
  const body = embeddingRequestBody(['signature']);
  return stableHash(JSON.stringify({
    url: baseApiUrl(s.embeddingUrl || s.secondaryUrl),
    model: body.model || '',
    dimensions: body.dimensions || '',
    mode: s.embeddingDimensionsMode || 'auto',
  }));
}

async function embedTexts(texts) {
  const s = settings();
  const base = baseApiUrl(s.embeddingUrl || s.secondaryUrl);
  const key = s.embeddingKey || s.secondaryKey;
  const request = state.requests.create('embedding');
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try { request.controller.abort(); } catch { /* noop */ }
  }, 45 * 1000);
  try {
    const response = await fetch(`${base}/embeddings`, {
      method: 'POST',
      signal: request.controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(embeddingRequestBody(texts)),
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Embedding API ${response.status}: ${errText.slice(0, 180)}`);
    }
    const json = await response.json();
    return (json.data || []).map(item => item.embedding);
  } catch (err) {
    if (isSecondaryAbort(request.controller, err)) {
      if (timedOut) throw new Error('Embedding 请求超过45秒，已取消并回退关键词召回');
      throw cancelledRequestError('Embedding 请求已因聊天上下文变化而取消');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    request.cleanup();
  }
}

function looksLikeEmbeddingModel(id) {
  return /(embedding|embed|bge|gte|e5|bce|jina|m3)/i.test(String(id || ''));
}

function looksLikeChatModel(id) {
  return !looksLikeEmbeddingModel(id) && !/(rerank|stable-diffusion|image|video|tts|whisper)/i.test(String(id || ''));
}

function collectModelIds(payload) {
  const ids = [];
  const seen = new Set();
  const add = value => {
    const id = String(value || '').trim();
    if (!id || id.length >= 300) return;
    ids.push(id);
  };
  const readModelEntry = entry => {
    if (typeof entry === 'string') return add(entry);
    if (!entry || typeof entry !== 'object') return;
    // `id` and `model` are strong model identifiers. `name` is accepted only inside an
    // actual model-list container, never from arbitrary provider/account metadata.
    add(entry.id || entry.model || entry.name);
  };
  const visitContainer = (value, depth = 0) => {
    if (depth > 7 || value == null) return;
    if (typeof value === 'string') return add(value);
    if (typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) {
        readModelEntry(entry);
        if (entry && typeof entry === 'object') {
          for (const key of ['data', 'models', 'items', 'result', 'response', 'available_models', 'model_list', 'model_names', 'model_ids']) {
            if (entry[key] != null) visitContainer(entry[key], depth + 1);
          }
        }
      }
      return;
    }
    // A root/item with an explicit id/model is itself a model record. Do not accept a lone `name`
    // here because status endpoints often use it for the provider or account display name.
    add(value.id || value.model);
    for (const key of ['data', 'models', 'items', 'result', 'response', 'available_models', 'model_list', 'model_names', 'model_ids']) {
      if (value[key] != null) visitContainer(value[key], depth + 1);
    }
  };
  visitContainer(payload);
  return [...new Set(ids)];
}

async function fetchModelsThroughSillyTavern(base, key) {
  // SillyTavern versions differ on whether a custom OpenAI-compatible endpoint is represented as
  // `custom_url/api_key` or `reverse_proxy/proxy_password`. Try both contracts through the server
  // so mobile browsers do not depend on cross-origin /models access.
  const attempts = [
    {
      endpoint: '/api/backends/chat-completions/status',
      label: 'status/custom',
      body: {
        chat_completion_source: 'custom',
        custom_url: base,
        custom_model: '',
        api_key: key,
      },
    },
    {
      endpoint: '/api/backends/chat-completions/status',
      label: 'status/reverse-proxy',
      body: {
        chat_completion_source: 'openai',
        reverse_proxy: base,
        proxy_password: key,
      },
    },
    {
      endpoint: '/api/backends/chat-completions/models',
      label: 'models/custom',
      body: {
        chat_completion_source: 'custom',
        custom_url: base,
        custom_model: '',
        api_key: key,
      },
    },
    {
      endpoint: '/api/backends/chat-completions/models',
      label: 'models/reverse-proxy',
      body: {
        chat_completion_source: 'openai',
        reverse_proxy: base,
        proxy_password: key,
      },
    },
  ];
  let lastError = '';
  const deadline = Date.now() + 24000;
  for (const attempt of attempts) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const request = state.requests.create('models');
    let timedOut = false;
    const attemptTimeoutMs = Math.max(1200, Math.min(8000, remainingMs));
    const timeout = setTimeout(() => {
      timedOut = true;
      try { request.controller.abort(); } catch { /* noop */ }
    }, attemptTimeoutMs);
    try {
      const response = await fetch(attempt.endpoint, {
        method: 'POST',
        signal: request.controller.signal,
        headers: getRequestHeaders(),
        body: JSON.stringify(attempt.body),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        lastError = `${attempt.label} ${response.status}: ${text.slice(0, 140)}`;
        continue;
      }
      const raw = await response.text();
      let parsed;
      try { parsed = JSON.parse(raw); } catch {
        lastError = `${attempt.label} 返回了非JSON模型列表`;
        continue;
      }
      const apiError = extractSecondaryError(parsed);
      if (apiError) {
        lastError = `${attempt.label}: ${apiError}`;
        continue;
      }
      const models = collectModelIds(parsed);
      if (models.length > 0) return models;
      lastError = `${attempt.label} 未返回模型ID`;
    } catch (err) {
      if (isSecondaryAbort(request.controller, err) && !timedOut) {
        throw cancelledRequestError('模型列表请求已因切换聊天、刷新页面或取消任务而中止');
      }
      lastError = timedOut ? `${attempt.label} 请求超过${Math.ceil(attemptTimeoutMs / 1000)}秒` : (err?.message || String(err));
    } finally {
      clearTimeout(timeout);
      request.cleanup();
    }
  }
  throw new Error(lastError || '酒馆后端代理未返回模型列表');
}

async function fetchModelsDirect(base, key, subType = '') {
  const urls = [];
  if (subType) urls.push({ endpoint: `${base}/models?sub_type=${encodeURIComponent(subType)}`, filteredByProvider: true });
  urls.push({ endpoint: `${base}/models`, filteredByProvider: false });
  let lastError = '';
  const deadline = Date.now() + 16000;
  for (const { endpoint, filteredByProvider } of urls) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const request = state.requests.create('models');
    let timedOut = false;
    const attemptTimeoutMs = Math.max(1200, Math.min(9000, remainingMs));
    const timeout = setTimeout(() => {
      timedOut = true;
      try { request.controller.abort(); } catch { /* noop */ }
    }, attemptTimeoutMs);
    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        signal: request.controller.signal,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${key}`,
        },
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        lastError = `${response.status}: ${text.slice(0, 160)}`;
        continue;
      }
      const raw = await response.text();
      let json;
      try { json = JSON.parse(raw); } catch {
        lastError = '模型接口返回了非JSON内容';
        continue;
      }
      const apiError = extractSecondaryError(json);
      if (apiError) {
        lastError = apiError;
        continue;
      }
      const ids = collectModelIds(json);
      if (filteredByProvider && ids.length > 0) return ids;
      if (filteredByProvider) continue;
      return ids;
    } catch (err) {
      if (isSecondaryAbort(request.controller, err) && !timedOut) {
        throw cancelledRequestError('模型列表请求已因切换聊天、刷新页面或取消任务而中止');
      }
      lastError = timedOut ? `${endpoint} 请求超过${Math.ceil(attemptTimeoutMs / 1000)}秒` : (err?.message || String(err));
    } finally {
      clearTimeout(timeout);
      request.cleanup();
    }
  }
  throw new Error(lastError || '模型列表为空或接口不支持拉取');
}

async function fetchProviderModels(url, key, subType = '') {
  const base = baseApiUrl(url);
  if (!base || !key) throw new Error('请先填写 API 地址和密钥');
  let ids = [];
  let proxyError = '';
  try {
    // Mobile browsers frequently block direct cross-origin /models calls. Prefer the same
    // SillyTavern server-side proxy path used by actual summary generation.
    ids = await fetchModelsThroughSillyTavern(base, key);
  } catch (err) {
    if (err?.code === 'AM_REQUEST_CANCELLED') throw err;
    proxyError = err?.message || String(err);
    try {
      ids = await fetchModelsDirect(base, key, subType);
    } catch (directErr) {
      if (directErr?.code === 'AM_REQUEST_CANCELLED') throw directErr;
      throw new Error(`酒馆代理拉取失败：${proxyError}；浏览器直连也失败：${directErr?.message || directErr}`);
    }
  }
  const filtered = subType === 'embedding'
    ? ids.filter(looksLikeEmbeddingModel)
    : subType === 'chat'
      ? ids.filter(looksLikeChatModel)
      : ids;
  if (filtered.length === 0) {
    throw new Error(subType === 'embedding' ? '接口返回了模型，但没有识别到Embedding模型' : '接口返回了模型，但没有识别到可用对话模型');
  }
  return [...new Set(filtered)].sort((a, b) => a.localeCompare(b));
}

function renderModelOptions(selector, models) {
  const container = $(selector);
  if (!container.length) return;
  container.empty();
  for (const model of models || []) {
    container.append(`<option value="${escapeHtml(model)}"></option>`);
  }
}

function ensureVectorStorageId(data) {
  if (!data?.processing) return '';
  if (!data.processing.storageId) {
    const uuid = globalThis.crypto?.randomUUID?.();
    data.processing.storageId = uuid || `am-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
  return data.processing.storageId;
}

function vectorCacheKey(data, id) {
  return `${ensureVectorStorageId(data)}:${String(id || '')}`;
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function idbTransactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve(true);
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
}

async function openVectorDb() {
  if (!globalThis.indexedDB) return null;
  if (state.vectorDbPromise) return state.vectorDbPromise;
  state.vectorDbPromise = new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(VECTOR_DB_NAME, VECTOR_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const store = db.objectStoreNames.contains(VECTOR_STORE_NAME)
        ? request.transaction.objectStore(VECTOR_STORE_NAME)
        : db.createObjectStore(VECTOR_STORE_NAME, { keyPath: 'key' });
      if (!store.indexNames.contains('storageId')) store.createIndex('storageId', 'storageId', { unique: false });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法打开向量 IndexedDB'));
  }).catch(err => {
    console.warn('[AnchorMemory] IndexedDB unavailable; semantic vectors are disabled and keyword recall remains available.', err);
    state.vectorStorageUnavailable = true;
    state.vectorDbPromise = null;
    return null;
  });
  return state.vectorDbPromise;
}

async function putStoredVector(data, id, record) {
  if (!data || !id || !record?.vector) return false;
  const storageId = ensureVectorStorageId(data);
  const key = `${storageId}:${id}`;
  const stored = { ...record, key, storageId, id: String(id) };
  const db = await openVectorDb();
  if (!db) {
    // Never place large float arrays back into chat metadata. Long chats would otherwise become
    // progressively larger and slower to save. Dynamic recall transparently falls back to keywords.
    delete data.vectors?.[id];
    delete data.vectorRefs?.[id];
    state.vectorStorageUnavailable = true;
    return false;
  }
  const tx = db.transaction(VECTOR_STORE_NAME, 'readwrite');
  tx.objectStore(VECTOR_STORE_NAME).put(stored);
  await idbTransactionDone(tx);
  state.vectorCache.set(key, stored);
  data.vectorRefs[id] = {
    signature: record.signature || '',
    dimensions: record.dimensions || record.vector.length,
    model: record.model || '',
    updatedAt: record.updatedAt || Date.now(),
  };
  delete data.vectors[id];
  return true;
}

async function getStoredVector(data, id) {
  if (!data || !id) return null;
  const key = vectorCacheKey(data, id);
  if (state.vectorCache.has(key)) return state.vectorCache.get(key);
  const db = await openVectorDb();
  if (!db) return null;
  const tx = db.transaction(VECTOR_STORE_NAME, 'readonly');
  const record = await idbRequest(tx.objectStore(VECTOR_STORE_NAME).get(key));
  if (record) state.vectorCache.set(key, record);
  return record || null;
}

async function listStoredVectors(data) {
  if (!data) return [];
  const storageId = ensureVectorStorageId(data);
  const db = await openVectorDb();
  if (!db) return [];
  const tx = db.transaction(VECTOR_STORE_NAME, 'readonly');
  const records = await idbRequest(tx.objectStore(VECTOR_STORE_NAME).index('storageId').getAll(storageId));
  for (const record of records || []) state.vectorCache.set(record.key, record);
  return records || [];
}

function removeStoredVector(data, id) {
  if (!data || !id) return false;
  const storageId = ensureVectorStorageId(data);
  const key = `${storageId}:${id}`;
  const existed = !!(data.vectorRefs?.[id] || data.vectors?.[id] || state.vectorCache.has(key));
  delete data.vectorRefs?.[id];
  delete data.vectors?.[id];
  state.vectorCache.delete(key);
  openVectorDb().then(db => {
    if (!db) return;
    const tx = db.transaction(VECTOR_STORE_NAME, 'readwrite');
    tx.objectStore(VECTOR_STORE_NAME).delete(key);
  }).catch(err => console.warn('[AnchorMemory] vector delete failed:', err));
  return existed;
}

async function clearStoredVectors(data) {
  if (!data) return;
  const storageId = ensureVectorStorageId(data);
  const db = await openVectorDb();
  if (db) {
    const tx = db.transaction(VECTOR_STORE_NAME, 'readwrite');
    const store = tx.objectStore(VECTOR_STORE_NAME);
    const keys = await idbRequest(store.index('storageId').getAllKeys(storageId));
    for (const key of keys || []) store.delete(key);
    await idbTransactionDone(tx);
  }
  for (const key of [...state.vectorCache.keys()]) {
    if (key.startsWith(`${storageId}:`)) state.vectorCache.delete(key);
  }
  data.vectorRefs = {};
  data.vectors = {};
}

function scheduleLegacyVectorMigration(data) {
  if (!data || Object.keys(data.vectors || {}).length === 0) return;
  const storageId = ensureVectorStorageId(data);
  if (state.vectorMigrationStorageIds.has(storageId)) return;
  state.vectorMigrationStorageIds.add(storageId);
  setTimeout(async () => {
    try {
      const entries = Object.entries(data.vectors || {});
      for (const [id, record] of entries) {
        if (record?.vector) await putStoredVector(data, id, record);
      }
      // v0.9.3 never retains vectors in chat metadata. If IndexedDB is unavailable, discard the
      // legacy payloads and keep keyword recall; users can rebuild vectors after storage recovers.
      data.vectors = {};
      if (state.vectorStorageUnavailable) data.vectorRefs = {};
      saveMemory(true);
    } catch (err) {
      console.warn('[AnchorMemory] legacy vector migration failed:', err);
    }
  }, 0);
}

async function embedMemoryItem(data, id, text) {
  const sourceText = String(text || '').trim();
  if (!embeddingConfigured() || !sourceText) return;
  try {
    const [vector] = await embedTexts([sourceText]);
    if (vector) {
      await putStoredVector(data, id, {
        vector,
        signature: embeddingSignature(),
        dimensions: vector.length,
        model: settings().embeddingModel,
        updatedAt: Date.now(),
      });
      saveMemory();
    }
  } catch (err) {
    console.warn('[AnchorMemory] embedding failed', err);
  }
}

async function ensureMemoryItemEmbedded(data, id, text) {
  if (!embeddingConfigured() || !id) return;
  const current = data.vectorRefs?.[id] || data.vectors?.[id];
  if (current?.signature === embeddingSignature()) return;
  await embedMemoryItem(data, id, text);
}

async function vectorRecall(data, query, limit = recallCandidateLimit()) {
  if (!embeddingConfigured()) return null;
  const [queryVector] = await embedTexts([query]);
  const signature = embeddingSignature();
  const byId = new Map();
  // Use the exact same historical corpus as keyword recall. This lets a failed-summary floor
  // participate in semantic recall whenever its raw fallback has an embedding, instead of making
  // the semantic channel structurally blind to the very floors most at risk of being forgotten.
  for (const source of recallCorpus(data)) {
    if (source?.item?.id) byId.set(source.item.id, source);
  }

  const records = await listStoredVectors(data);
  if (state.vectorStorageUnavailable) throw new Error('向量 IndexedDB 不可用，改用关键词召回');
  const results = records
    .map(record => {
      const id = record.id || String(record.key || '').split(':').pop();
      if (record.signature !== signature) return null;
      const source = byId.get(id);
      if (!source || !Array.isArray(record.vector)) return null;
      return { ...source, score: cosine(queryVector, record.vector), method: 'embedding' };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return results;
}

function recallIdentity(hit) {
  return `${hit?.kind || ''}:${hit?.item?.id || hit?.item?.key || hit?.item?.number || ''}`;
}

function fuseHybridRecall(vectorHits = [], keywordHits = [], limit = recallCandidateLimit()) {
  const semanticTop = Math.max(0, ...vectorHits.map(hit => Math.max(0, Number(hit.score || 0))));
  const keywordTop = Math.max(0, ...keywordHits.map(hit => Math.max(0, Number(hit.score || 0))));
  const merged = new Map();

  const ensure = hit => {
    const key = recallIdentity(hit);
    if (!merged.has(key)) merged.set(key, { ...hit, score: 0, semanticScore: 0, keywordScore: 0, semanticNorm: 0, keywordNorm: 0 });
    return merged.get(key);
  };

  for (const hit of vectorHits) {
    const target = ensure(hit);
    target.semanticScore = Number(hit.score || 0);
    target.semanticNorm = semanticTop > 0 ? Math.max(0, target.semanticScore) / semanticTop : 0;
  }
  for (const hit of keywordHits) {
    const target = ensure(hit);
    target.keywordScore = Number(hit.score || 0);
    target.keywordNorm = keywordTop > 0 ? Math.max(0, target.keywordScore) / keywordTop : 0;
  }

  return [...merged.values()]
    .map(hit => {
      const hasSemantic = hit.semanticNorm > 0;
      const hasKeyword = hit.keywordNorm > 0;
      const bothBonus = hasSemantic && hasKeyword
        ? 0.10 * Math.min(hit.semanticNorm, hit.keywordNorm)
        : 0;
      // A source that is absent from one channel must not have an artificial score ceiling.
      // Single-channel hits stay on a full 0..1 scale; dual-channel agreement can still earn
      // a small bonus. This is especially important for raw-recall fallbacks after Godlog failure.
      const fused = hasSemantic && hasKeyword
        ? 0.64 * hit.semanticNorm + 0.36 * hit.keywordNorm + bothBonus
        : Math.max(hit.semanticNorm, hit.keywordNorm);
      const method = hit.semanticScore > 0 && hit.keywordScore > 0
        ? 'hybrid'
        : (hit.semanticScore > 0 ? 'embedding' : 'keyword');
      return { ...hit, score: fused, method };
    })
    .sort((a, b) => b.score - a.score
      || Number(b.keywordScore || 0) - Number(a.keywordScore || 0)
      || Number(b.semanticScore || 0) - Number(a.semanticScore || 0)
      || Number(b.item?.floor ?? b.item?.number ?? 0) - Number(a.item?.floor ?? a.item?.number ?? 0))
    .slice(0, limit);
}

async function hybridRecall(data, recallQuery, limit = recallCandidateLimit()) {
  const keywordQuery = recallQuery?.keywordQuery || recallQuery?.query || '';
  const semanticQuery = recallQuery?.semanticQuery || recallQuery?.query || '';
  const keywordHits = keywordRecall(data, keywordQuery, limit)
    .map(hit => ({ ...hit, method: 'keyword' }));
  if (!embeddingConfigured()) return keywordHits;
  const vectorHits = await vectorRecall(data, semanticQuery, limit) || [];
  return fuseHybridRecall(vectorHits, keywordHits, limit);
}

function taggedNarrativeContent(text) {
  const source = String(text || '');
  const parts = [];
  const pattern = /<(content|context)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = pattern.exec(source))) {
    const body = cleanText(match[2] || '');
    if (body) parts.push(body);
  }
  return parts.join('\n\n').trim();
}

function stripRecallMetaBlocks(text) {
  return String(text || '')
    .replace(/<(think|analysis|reasoning|reflection)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<Godlog\b[^>]*>[\s\S]*?<\/Godlog>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

function recallQueryMessageText(message) {
  const raw = message?.mes ?? message?.content ?? '';
  const tagged = taggedNarrativeContent(raw);
  if (tagged) return tagged;
  return cleanText(stripRecallMetaBlocks(raw));
}

function buildRecallQuery(chat = getContext().chat || []) {
  const visible = (chat || []).filter(message => message && !message.is_system && !message.is_hidden);
  const lastUser = [...visible].reverse().find(message => message.is_user);
  const lastUserText = recallQueryMessageText(lastUser);
  const recentNarrative = visible.slice(-4)
    .map(message => ({ message, text: recallQueryMessageText(message) }))
    .filter(entry => entry.text)
    .slice(-3);
  const recent = recentNarrative
    .map(({ message, text }) => `${message.is_user ? '用户' : 'AI'}：${text}`)
    .join('\n');
  const keywordQuery = [lastUserText, recent].filter(Boolean).join('\n');
  const terms = [...keywordSet(keywordQuery)].slice(0, 36).join(' ');
  // Embeddings should receive natural narrative only. Artificial n-gram keyword lists can distort
  // semantic similarity, so keyword expansion is kept exclusively in the lexical channel.
  const semanticQuery = [
    lastUserText ? `当前用户正文：${lastUserText}` : '',
    recent ? `最近正文线索：\n${recent}` : '',
  ].filter(Boolean).join('\n\n');
  const query = [
    semanticQuery,
    terms ? `检索关键词：${terms}` : '',
  ].filter(Boolean).join('\n\n');
  const tagged = !!taggedNarrativeContent(lastUser?.mes ?? lastUser?.content ?? '');
  return {
    query,
    semanticQuery,
    keywordQuery,
    source: lastUser
      ? `当前用户正文${tagged ? '（已优先读取 <content>/<context>）' : ''} + 最近正文线索`
      : '最近正文线索',
    lastUser: lastUserText,
    terms,
  };
}

function recallQueryCacheKey(recallQuery) {
  return stableHash(`${embeddingConfigured() ? `hybrid:${embeddingSignature()}` : 'keyword'}\n${recallQuery?.query || ''}`);
}

function clearRecallPrefetch() {
  state.recallPrefetchKey = '';
  state.recallPrefetchPromise = null;
  state.recallPrefetchResult = null;
  state.recallPrefetchAt = 0;
  state.recallPrefetchStatus = null;
}

function beginDynamicRecallCycle(chat = getContext().chat || [], source = '用户消息已写入') {
  if (!settings().useDynamicRecall || !hasPersistentChatContext()) return null;
  const recallQuery = buildRecallQuery(chat);
  if (!recallQuery.query.trim()) return null;
  const key = recallQueryCacheKey(recallQuery);
  if (state.lastRecallQuery?.key === key && ['prefetching', 'prepared', 'injected-before-send'].includes(state.lastRecallQuery.stage)) {
    return state.lastRecallQuery;
  }
  state.lastRecall = '';
  state.lastRecallMeta = [];
  state.lastRecallQuery = {
    key,
    source: recallQuery.source,
    preview: clampText(recallQuery.query, 1200),
    minCount: 0,
    maxCount: recallMaxCount(),
    candidateLimit: recallCandidateLimit(),
    budget: recallTokenBudget(),
    mode: embeddingConfigured() ? 'hybrid-prefetch' : 'keyword',
    stage: 'prefetching',
    lifecycleSource: source,
    startedAt: Date.now(),
    selectedCount: 0,
    candidateCount: 0,
    usedTokens: 0,
    usedForCurrentPrompt: false,
  };
  refreshCommittedRecallUi();
  return state.lastRecallQuery;
}

async function prepareDynamicRecall(chat = getContext().chat || []) {
  if (!settings().useDynamicRecall || !hasPersistentChatContext()) {
    clearRecallPrefetch();
    return null;
  }
  const recallQuery = buildRecallQuery(chat);
  if (!recallQuery.query.trim()) {
    clearRecallPrefetch();
    return null;
  }
  const key = recallQueryCacheKey(recallQuery);
  if (state.recallPrefetchKey === key && (state.recallPrefetchPromise || state.recallPrefetchResult)) {
    return state.recallPrefetchPromise || state.recallPrefetchResult;
  }
  state.recallPrefetchKey = key;
  state.recallPrefetchResult = null;
  state.recallPrefetchAt = Date.now();
  state.recallPrefetchStatus = {
    key,
    stage: 'prefetching',
    mode: embeddingConfigured() ? 'hybrid' : 'keyword',
    startedAt: state.recallPrefetchAt,
    readyAt: 0,
    resultCount: 0,
    lateForCurrentPrompt: false,
  };
  if (!embeddingConfigured()) {
    const result = keywordRecall(memoryData(), recallQuery.keywordQuery || recallQuery.query, recallCandidateLimit())
      .map(hit => ({ ...hit, method: 'keyword' }));
    state.recallPrefetchResult = result;
    state.recallPrefetchPromise = null;
    state.recallPrefetchStatus = {
      ...state.recallPrefetchStatus,
      stage: 'ready',
      readyAt: Date.now(),
      resultCount: result.length,
    };
    return result;
  }
  const promise = hybridRecall(memoryData(), recallQuery, recallCandidateLimit())
    .then(result => {
      if (state.recallPrefetchKey === key) {
        const readyAt = Date.now();
        state.recallPrefetchResult = result || [];
        const injectedAt = state.lastRecallQuery?.key === key ? Number(state.lastRecallQuery.injectedAt || 0) : 0;
        state.recallPrefetchStatus = {
          ...(state.recallPrefetchStatus || {}),
          key,
          stage: 'ready',
          mode: 'hybrid',
          readyAt,
          resultCount: (result || []).length,
          lateForCurrentPrompt: !!(injectedAt && readyAt > injectedAt),
        };
        refreshCommittedRecallUi();
      }
      return result || [];
    })
    .catch(err => {
      console.warn('[AnchorMemory] hybrid recall semantic channel failed; prompt will use keyword results', err);
      const fallback = keywordRecall(memoryData(), recallQuery.keywordQuery || recallQuery.query, recallCandidateLimit())
        .map(hit => ({ ...hit, method: 'keyword' }));
      if (state.recallPrefetchKey === key) {
        state.recallPrefetchResult = fallback;
        state.recallPrefetchStatus = {
          ...(state.recallPrefetchStatus || {}),
          key,
          stage: 'ready',
          mode: 'keyword-after-hybrid-semantic-error',
          readyAt: Date.now(),
          resultCount: fallback.length,
          error: err?.message || String(err),
        };
        refreshCommittedRecallUi();
      }
      return fallback;
    })
    .finally(() => {
      if (state.recallPrefetchKey === key) state.recallPrefetchPromise = null;
    });
  state.recallPrefetchPromise = promise;
  return promise;
}

async function resolveDynamicRecallBeforeSend(chat = getContext().chat || [], timeoutMs = DYNAMIC_RECALL_PROMPT_WAIT_MS) {
  if (!settings().useDynamicRecall || !hasPersistentChatContext()) return null;
  const recallQuery = buildRecallQuery(chat);
  if (!recallQuery.query.trim()) return null;
  const key = recallQueryCacheKey(recallQuery);
  const cycle = beginDynamicRecallCycle(chat, '生成前召回');
  const startedAt = Number(cycle?.startedAt || state.recallPrefetchAt || Date.now());
  const resolveStartedAt = Date.now();
  const prefetch = prepareDynamicRecall(chat);

  if (!embeddingConfigured()) {
    const results = await prefetch;
    const readyAt = Date.now();
    return {
      key,
      results: Array.isArray(results) ? results : [],
      mode: 'keyword',
      startedAt,
      readyAt,
      waitedMs: Math.max(0, readyAt - resolveStartedAt),
      prefetchMs: Math.max(0, readyAt - startedAt),
      timedOut: false,
    };
  }

  if (state.recallPrefetchKey === key && Array.isArray(state.recallPrefetchResult)) {
    const readyAt = Number(state.recallPrefetchStatus?.readyAt || Date.now());
    return {
      key,
      results: state.recallPrefetchResult,
      mode: state.recallPrefetchStatus?.mode || 'hybrid',
      startedAt,
      readyAt,
      waitedMs: 0,
      prefetchMs: Math.max(0, readyAt - startedAt),
      timedOut: false,
    };
  }

  const waitStartedAt = Date.now();
  const timeout = Math.max(0, Number(timeoutMs) || 0);
  let timer = null;
  const timeoutResult = new Promise(resolve => {
    timer = setTimeout(() => resolve({ timedOut: true, results: null }), timeout);
  });
  const recallResult = Promise.resolve(prefetch)
    .then(results => ({ timedOut: false, results: Array.isArray(results) ? results : [] }))
    .catch(() => ({ timedOut: false, results: [] }));
  const outcome = await Promise.race([recallResult, timeoutResult]);
  if (timer) clearTimeout(timer);
  const readyAt = Date.now();
  if (outcome.timedOut) {
    return {
      key,
      results: null,
      mode: 'keyword-fallback-timeout',
      startedAt,
      readyAt,
      waitedMs: Math.max(0, readyAt - waitStartedAt),
      prefetchMs: Math.max(0, readyAt - startedAt),
      timedOut: true,
    };
  }
  return {
    key,
    results: outcome.results,
    mode: 'hybrid',
    startedAt,
    readyAt,
    waitedMs: Math.max(0, readyAt - waitStartedAt),
    prefetchMs: Math.max(0, readyAt - startedAt),
    timedOut: false,
  };
}

function dynamicRecall(data, chat, rows = chatRows(true), options = {}) {
  const commit = options.commit !== false;
  const recallQuery = buildRecallQuery(chat);
  const key = recallQueryCacheKey(recallQuery);
  const previousCycle = state.lastRecallQuery?.key === key ? state.lastRecallQuery : null;
  const resolvedRecall = options.resolvedRecall?.key === key ? options.resolvedRecall : null;
  const queryState = {
    key,
    source: recallQuery.source,
    preview: clampText(recallQuery.query, 1200),
    minCount: 0,
    maxCount: recallMaxCount(),
    candidateLimit: recallCandidateLimit(),
    budget: recallTokenBudget(),
    mode: resolvedRecall?.mode || (embeddingConfigured() ? 'hybrid-prefetch' : 'keyword'),
    stage: 'prepared',
    lifecycleSource: previousCycle?.lifecycleSource || '生成前召回',
    startedAt: Number(resolvedRecall?.startedAt || previousCycle?.startedAt || state.recallPrefetchAt || Date.now()),
    readyAt: Number(resolvedRecall?.readyAt || state.recallPrefetchStatus?.readyAt || Date.now()),
    waitedMs: Number(resolvedRecall?.waitedMs || 0),
    prefetchMs: Number(resolvedRecall?.prefetchMs || 0),
    timedOut: !!resolvedRecall?.timedOut,
    selectedCount: 0,
    candidateCount: 0,
    usedTokens: 0,
    usedForCurrentPrompt: false,
  };
  const recallMeta = [];
  if (!recallQuery.query.trim()) {
    if (commit) {
      state.lastRecallMeta = [];
      state.lastRecallQuery = queryState;
    }
    return '';
  }

  let recalled = Array.isArray(resolvedRecall?.results)
    ? resolvedRecall.results
    : (state.recallPrefetchKey === key && Array.isArray(state.recallPrefetchResult)
      ? state.recallPrefetchResult
      : null);
  if (!recalled || recalled.length === 0) {
    recalled = keywordRecall(data, recallQuery.keywordQuery || recallQuery.query, recallCandidateLimit())
      .map(hit => ({ ...hit, method: 'keyword' }));
    if (resolvedRecall?.timedOut) queryState.mode = 'keyword-fallback-timeout';
    else if (resolvedRecall && Array.isArray(resolvedRecall.results)) queryState.mode = 'keyword-fallback-no-hybrid-hit';
    else if (state.recallPrefetchKey === key && state.recallPrefetchPromise) queryState.mode = 'keyword-fallback-while-hybrid-prefetching';
    else queryState.mode = 'keyword';
  } else {
    queryState.mode = resolvedRecall?.mode || recalled[0]?.method || 'hybrid';
  }

  const recentRawKeys = new Set(rows
    .filter(row => row.role === 'assistant')
    .slice(-Math.max(1, Number(settings().keepRecent) || 3))
    .map(row => row.key));
  const deterministicRefs = Array.isArray(options.recentFactsMeta)
    ? options.recentFactsMeta
    : (state.lastRecentFactsMeta || []);
  const deterministicIds = new Set(deterministicRefs.map(ref => ref.id).filter(Boolean));
  recalled = recalled.filter(hit => ['godlog', 'raw-recall'].includes(hit.kind)
    && !deterministicIds.has(hit.item?.id)
    && !recentRawKeys.has(hit.item?.key));

  let adaptive = selectAdaptiveRecallHits(recalled);
  Object.assign(queryState, {
    selectedCount: adaptive.selected.length,
    candidateCount: adaptive.candidateCount,
    usedTokens: adaptive.usedTokens,
    threshold: adaptive.threshold,
    budget: adaptive.budget,
  });
  recalled = adaptive.selected;

  recallMeta.push(...recalled.map(hit => ({
    id: hit.item.id,
    number: hit.item.number,
    floor: hit.item.floor ?? null,
    kind: hit.kind,
    key: hit.item.key || '',
    title: hit.kind === 'godlog' ? godlogFieldValue(hit.item.body || '', 'Title') : (hit.item.title || '原楼正文保底'),
    method: hit.method || 'keyword',
    score: Number(hit.score || 0),
    semanticScore: Number(hit.semanticScore || 0),
    keywordScore: Number(hit.keywordScore || 0),
    semanticNorm: Number(hit.semanticNorm || 0),
    keywordNorm: Number(hit.keywordNorm || 0),
    querySource: recallQuery.source,
    recallReason: hit.recallReason || '',
    recallTokens: hit.recallTokens || 0,
  })));
  if (Array.isArray(options.metaTarget)) options.metaTarget.push(...recallMeta);
  if (options.queryTarget && typeof options.queryTarget === 'object') Object.assign(options.queryTarget, queryState);
  if (commit) {
    state.lastRecallMeta = recallMeta;
    state.lastRecallQuery = queryState;
  }
  if (!recalled.length) return '';

  const parts = ['### 动态召回（与当前输入相关的旧楼细节）'];
  for (const hit of recalled) {
    const assistantNumber = Number(hit.item?.assistantNumber || hit.item?.number || 0);
    const floorLabel = assistantNumber > 0 ? `第 ${assistantNumber} 个AI回合` : '旧AI回合';
    const title = hit.kind === 'godlog' ? godlogFieldValue(hit.item.body || '', 'Title') : '原楼正文保底';
    parts.push(`#### ${floorLabel}${title ? `｜${title}` : ''}`);
    parts.push(safePromptMemoryText(hit.kind, hit.item, hit.kind === 'godlog' ? 1200 : 1400));
  }
  return clampTextHeadTail(parts.join('\n\n'), DYNAMIC_RECALL_MEMORY_CHAR_BUDGET, 0.25);
}

function hasCoreInjectionContent(data) {
  const relationshipRows = normalizeRelationshipTable(data?.relationshipTable, data?.codex?.relationship || '')
    .rows.some(row => row.past || row.development || row.current);
  const codex = injectionCodex(data);
  return !!(
    latestMerge(data)
    || activeAnchorsAfterMerge(data).length
    || relationshipRows
    || (codex && settings().recallMentionedPeople && (codex.characterMemo || codex.peopleIndex))
    || (codex && settings().injectImportantItems && codex.itemIndex)
  );
}

function injectionRef(kind, item, extra = {}) {
  if (!item) return null;
  return {
    kind,
    id: item.id || '',
    number: item.number || 0,
    floor: extra.floor ?? item.floor ?? item.floorAt ?? null,
    key: extra.key || item.key || '',
    title: extra.title || (kind === 'godlog' ? godlogFieldValue(item.body || '', 'Title') : '') || item.title || '',
    method: extra.method || '',
  };
}

function uniqueInjectionRefs(refs) {
  const seen = new Set();
  const result = [];
  for (const ref of refs || []) {
    if (!ref?.id) continue;
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}

function promptReadyInjectionRefs(data) {
  const refs = [];
  refs.push(injectionRef('merge', latestMerge(data)));
  for (const anchor of activeAnchorsAfterMerge(data)) refs.push(injectionRef('anchor', anchor));
  for (const ref of state.lastRecentFactsMeta || []) refs.push(ref);
  if (settings().useDynamicRecall) {
    for (const hit of state.lastRecallMeta || []) {
      refs.push({
        kind: hit.kind,
        id: hit.id,
        number: hit.number || 0,
        floor: hit.floor ?? (hit.kind === 'godlog' && hit.number ? hit.number - 1 : null),
        method: hit.method || 'keyword',
        score: Number(hit.score || 0),
        semanticScore: Number(hit.semanticScore || 0),
        keywordScore: Number(hit.keywordScore || 0),
        recallReason: hit.recallReason || '',
        recallTokens: hit.recallTokens || 0,
      });
    }
  }
  return uniqueInjectionRefs(refs);
}

function estimateKeptNarrativeTokens(chat = getContext().chat || []) {
  const plan = recentRawHistoryPlan(chat, Math.max(1, Number(settings().keepRecent) || 3));
  return plan.keepIndices.reduce((sum, index) => {
    const message = chat[index];
    if (!message) return sum;
    return sum + estimateTokens(`${message.is_user ? 'user' : 'assistant'}:${message.name || ''}\n${message.mes || message.content || ''}`);
  }, 0);
}

function currentMemoryTokenBudget(chat = getContext().chat || []) {
  const s = settings();
  const maxMemoryTokens = Math.max(1200, Number(s.memoryMaxTokens) || 8000);
  const reserveTokens = Math.max(600, Number(s.memoryReserveTokens) || 1400);
  if (!s.adaptiveTokenBudget) return maxMemoryTokens;
  return resolveAdaptiveMemoryBudget({
    contextSize: state.lastContextSize,
    promptTokens: estimateKeptNarrativeTokens(chat),
    maxMemoryTokens,
    reserveTokens,
    minimumMemoryTokens: Math.min(1600, maxMemoryTokens),
  });
}

async function buildPromptReadyInjection(chat = getContext().chat || [], options = {}) {
  const commit = options.commit !== false;
  const data = memoryData();
  const rows = chatRows(true);
  const trackedLabel = trackedCharacterLabel(data);
  const codex = injectionCodex(data);
  const characterMemoContent = codex
    ? (sanitizeCharacterMemoSection(data, codex.characterMemo) || '（暂无明确核心转变）')
    : '（人物动态表正在安全重建；当前没有可确认的回退快照）';
  const characterMemo = `${codexSafeSnapshotPrefix(data, '人物动态表', !!codex)}${characterMemoContent}`;

  const recentFactsMeta = [];
  const recallMeta = [];
  const recallQueryState = {};
  const recentFacts = buildRecentFactsInjection(data, rows, { commit, metaTarget: recentFactsMeta });
  const recall = settings().useDynamicRecall
    ? dynamicRecall(data, chat, rows, {
      commit,
      resolvedRecall: options.resolvedRecall || null,
      recentFactsMeta,
      metaTarget: recallMeta,
      queryTarget: recallQueryState,
    })
    : '';
  if (commit) {
    state.lastRecentFacts = recentFacts;
    state.lastRecall = recall;
    if (!settings().useDynamicRecall) {
      state.lastRecallMeta = [];
      state.lastRecallQuery = null;
    }
  }
  const detailParts = [recentFacts, recall].filter(part => String(part || '').trim());
  const recallEnabled = !!settings().useDynamicRecall;
  const sectionSix = [
    recallEnabled ? '【六. 未锚定逐楼摘要与可选动态召回】' : '【六. 未锚定逐楼摘要】',
    detailParts.length
      ? detailParts.join('\n\n')
      : (recallEnabled
        ? '（当前没有需要补充的未锚定逐楼摘要或相关旧楼召回）'
        : '（当前没有需要补充的未锚定逐楼摘要；动态召回处于关闭状态）'),
  ].join('\n\n');

  const timeline = refreshTimelineFromGodlogs(data);
  const timeCue = `当前剧情定位：时间 ${codex?.currentTime || '未明'}；地点 ${codex?.currentPlace || '未明'}。${timeline.warnings?.length ? ` 时间连续性存在 ${timeline.warnings.length} 条待核对提示，最近正文优先。` : ''}`;
  const budget = currentMemoryTokenBudget(chat);
  // The previous fixed per-section maxima summed to 11,600 tokens, so raising the user-visible
  // memory limit above that value had no effect. Scale both section caps and source text ceilings
  // when a larger budget is genuinely available.
  const sectionScale = Math.max(1, Math.min(3, budget / BASE_SECTION_MAX_TOKENS));
  const sectionMax = value => Math.max(value, Math.round(value * sectionScale));
  const charScale = Math.max(1, Math.min(3, sectionScale));
  const sections = [
    {
      id: 'relationship', minTokens: 320, maxTokens: sectionMax(1500), weight: 1.2, headRatio: 0.45,
      text: [
        '锚点记录',
        '使用边界：以下均为已经发生的剧情记忆。直接延续当前正文，不复述资料标题，不写整理说明；若与最近正文冲突，以最近正文为准。',
        timeCue,
        '【一. 人物关系】',
        relationshipInjectionBlock(data, Math.round(RELATIONSHIP_MEMORY_CHAR_BUDGET * charScale)),
      ].join('\n\n'),
    },
    {
      id: 'anchors', minTokens: 1100, maxTokens: sectionMax(4300), weight: 3.8, headRatio: 0.28,
      truncationMarker: '…（锚点事件中段因本次预算省略；这不是完整列表，必要时可由旧楼动态召回补回相关细节）…',
      text: `【二. 锚点事件】\n\n${anchorEventInjectionBlock(data, charScale)}`,
    },
    { id: 'character', minTokens: 260, maxTokens: sectionMax(1050), weight: 1.1, headRatio: 0.38, text: `【三. ${trackedLabel} 动态演变（核心转变）】\n\n${safeCodexText(characterMemo, Math.round(3200 * charScale))}` },
    { id: 'people', minTokens: 180, maxTokens: sectionMax(850), weight: 0.8, headRatio: 0.45, text: `【四. 匹配到的出场人物库】\n\n${safeCodexText(matchedPeopleInjectionBlock(data, chat, codex), Math.round(2200 * charScale))}` },
    { id: 'items', minTokens: 180, maxTokens: sectionMax(900), weight: 0.9, headRatio: 0.45, text: `【五. 重要道具、梗与核心细节】\n\n${safeCodexText(importantItemsInjectionBlock(data, chat, codex), Math.round(2400 * charScale))}` },
    { id: 'recent', minTokens: 1400, maxTokens: sectionMax(3000), weight: 3.6, headRatio: 0.48, text: sectionSix },
  ];

  const fitted = fitMemorySections(sections, budget);
  const bounded = sanitizeMainPromptMemoryText(fitted.text);
  const memoryBudget = {
    budgetTokens: budget,
    usedTokens: estimateTokens(bounded),
    contextSize: state.lastContextSize || 0,
    keptNarrativeTokens: estimateKeptNarrativeTokens(chat),
    allocations: fitted.allocations,
    at: Date.now(),
  };
  if (commit) {
    state.lastMemoryBudget = memoryBudget;
    state.lastPromptInjection = bounded;
  }
  return bounded;
}

function markDynamicRecallInjected(backend = 'prompt-ready', content = '') {
  if (!settings().useDynamicRecall || !state.lastRecallQuery) return;
  const injectedAt = Date.now();
  Object.assign(state.lastRecallQuery, {
    stage: 'injected-before-send',
    injectedAt,
    usedForCurrentPrompt: true,
    backend,
    containedRecallHits: !!state.lastRecallMeta.length,
    injectionContainedDynamicRecallSection: String(content || '').includes('动态召回'),
    totalElapsedMs: Math.max(0, injectedAt - Number(state.lastRecallQuery.startedAt || injectedAt)),
  });
  if (state.lastRecallQuery.timedOut
    && state.recallPrefetchStatus?.key === state.lastRecallQuery.key
    && Number(state.recallPrefetchStatus.readyAt || 0) >= Number(state.lastRecallQuery.readyAt || 0)) {
    state.recallPrefetchStatus.lateForCurrentPrompt = true;
  }
  console.info(
    `[AnchorMemory] dynamic recall ${state.lastRecallQuery.mode} prepared before send: `
    + `${state.lastRecallQuery.selectedCount || 0} hit(s), waited ${state.lastRecallQuery.waitedMs || 0}ms, backend=${backend}`,
  );
}

function recallStageText(query = state.lastRecallQuery) {
  if (!query) return '';
  if (query.stage === 'injected-before-send') return '已在主请求发送前注入';
  if (query.stage === 'prepared') return '已完成，等待写入主请求';
  if (query.stage === 'prefetching') return '正在主请求发送前召回';
  return query.stage || '';
}

function refreshCommittedRecallUi() {
  try {
    if (!$ || !$('#anchor_memory_workbench').length || !$('#anchor_memory_workbench').hasClass('open')) return;
    if (!state.selectedRecallMessageKey) {
      $('#am_recall_preview_title').text(settings().useDynamicRecall
        ? '第六段：未锚定摘要 + 可选旧楼召回（本轮实际注入）'
        : '第六段：未锚定摘要（动态召回已关闭）');
      $('#am_recall_preview_note').hide();
      $('#am_clear_recall_selection').hide();
      const lifecycle = state.lastRecallQuery ? `【召回状态】${recallStageText(state.lastRecallQuery)}\n\n` : '';
      $('#am_recall_preview').val(`${lifecycle}${[state.lastRecentFacts, state.lastRecall].filter(Boolean).join('\n\n')}`
        || (settings().useDynamicRecall ? '当前没有可补充内容。' : '当前没有未锚定摘要；额外旧楼动态召回已关闭。'));
    }
    renderRecallHits();
  } catch (err) {
    console.warn('[AnchorMemory] recall UI refresh failed', err);
  }
}

function compactInjectionPreview(content, maxChars = 480) {
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

function rememberPromptInjectionForNextMessage(data, chat, content) {
  const refs = promptReadyInjectionRefs(data);
  const fullContent = String(content || '');
  state.lastInjectionRefs = refs;
  // The full prompt is only needed until the next AI message is adopted. Keeping a cumulative
  // copy on every floor made chat metadata grow quadratically because most memory text repeats.
  state.pendingInjectionContent = fullContent;
  const targetIndex = Array.isArray(chat) ? chat.length : (getContext().chat || []).length;
  data.processing.pendingPromptInjection = {
    targetIndex,
    refs,
    recallQuery: state.lastRecallQuery ? { ...state.lastRecallQuery } : null,
    contentHash: stableHash(fullContent),
    contentPreview: compactInjectionPreview(fullContent),
    injectedChars: fullContent.length,
    at: Date.now(),
  };
  return data.processing.pendingPromptInjection;
}

function adoptPendingPromptInjection(data, row) {
  if (!data || !row?.key) return false;
  const pending = data.processing?.pendingPromptInjection;
  if (!pending || Number(pending.targetIndex) !== Number(row.index)) return false;
  const transientContent = String(state.pendingInjectionContent || '');
  data.messageRecalls[row.key] = {
    key: row.key,
    floor: row.index,
    name: row.name || '',
    refs: Array.isArray(pending.refs) ? pending.refs : [],
    recallQuery: pending.recallQuery || null,
    contentHash: pending.contentHash || stableHash(transientContent || pending.content || ''),
    contentPreview: pending.contentPreview || compactInjectionPreview(transientContent || pending.content || ''),
    injectedChars: pending.injectedChars || transientContent.length || String(pending.content || '').length,
    at: pending.at || Date.now(),
  };
  state.pendingInjectionContent = '';
  data.processing.pendingPromptInjection = null;
  saveMemory();
  return true;
}

function messageRecallRecord(data, row) {
  if (!data || !row?.key) return null;
  adoptPendingPromptInjection(data, row);
  return data.messageRecalls?.[row.key] || null;
}

function rememberMessageGodlogCard(data, row, item, status) {
  if (!data || !row?.key) return false;
  const next = {
    key: row.key,
    floor: row.index,
    name: row.name || '',
    godlogId: item?.id || syntheticGodlogId(row),
    status: status || item?.status || 'missing',
    updatedAt: item?.updatedAt || Date.now(),
    uiOnly: true,
  };
  const prev = data.messageGodlogs?.[row.key];
  if (JSON.stringify(prev || null) === JSON.stringify(next)) return false;
  data.messageGodlogs[row.key] = next;
  return true;
}

function pruneMessageUiIndexes(data, rows = chatRows(true)) {
  if (!data) return false;
  const liveKeys = new Set((rows || []).map(row => row.key).filter(Boolean));
  let changed = false;
  for (const key of Object.keys(data.messageGodlogs || {})) {
    if (liveKeys.has(key)) continue;
    delete data.messageGodlogs[key];
    changed = true;
  }
  for (const key of Object.keys(data.messageRecalls || {})) {
    if (liveKeys.has(key)) continue;
    delete data.messageRecalls[key];
    changed = true;
  }
  const pending = data.processing?.pendingPromptInjection;
  const chatLength = (getContext().chat || []).length;
  if (pending && Number(pending.targetIndex) > chatLength + 1) {
    data.processing.pendingPromptInjection = null;
    changed = true;
  }
  return changed;
}

function normalizedInjectionDepth(value = settings().injectionDepth) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 4;
}

function resolvePromptInsertIndex(promptChat, depth = 4) {
  if (!Array.isArray(promptChat) || promptChat.length === 0) return 0;
  const position = Math.max(0, Number(depth) || 0);
  if (position === 0) {
    for (let index = promptChat.length - 1; index >= 0; index--) {
      if (promptChat[index]?.role === 'user' || promptChat[index]?.role === 'assistant') return index + 1;
    }
    return promptChat.length;
  }

  let turns = 0;
  for (let index = promptChat.length - 1; index >= 0; index--) {
    if (promptChat[index]?.role !== 'user' && promptChat[index]?.role !== 'assistant') continue;
    turns++;
    if (turns >= position) return index;
  }
  return 0;
}

function isAnchorMemoryPromptMessage(message) {
  const content = typeof message?.content === 'string' ? message.content : '';
  return message?.role === 'system'
    && /^锚点记录(?:\r?\n|$)/.test(content)
    && content.includes('【一. 人物关系】')
    && content.includes('【二. 锚点事件】')
    && content.includes('【六.');
}

function removeExistingAnchorMemoryPrompt(promptChat) {
  if (!Array.isArray(promptChat)) return 0;
  let removed = 0;
  for (let index = promptChat.length - 1; index >= 0; index--) {
    if (!isAnchorMemoryPromptMessage(promptChat[index])) continue;
    promptChat.splice(index, 1);
    removed++;
  }
  return removed;
}

function resolvePromptReadyPayload(eventData, secondArg = false) {
  // SillyTavern and prompt-inspection extensions expose the final message list through several
  // payload shapes. Resolve the actual array instead of silently skipping pruning on a new shape.
  const candidates = [
    eventData,
    eventData?.detail,
    eventData?.data,
    eventData?.request,
    eventData?.payload,
    eventData?.chatCompletion,
    eventData?.completion,
    eventData?.prompt,
  ];
  let promptChat = null;
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      promptChat = candidate;
      break;
    }
    for (const key of ['chat', 'messages', 'prompt']) {
      if (Array.isArray(candidate?.[key])) {
        promptChat = candidate[key];
        break;
      }
    }
    if (promptChat) break;
  }
  const dryRun = !!(
    secondArg === true
    || secondArg?.dryRun
    || secondArg?.isDryRun
    || eventData?.dryRun
    || eventData?.isDryRun
    || eventData?.detail?.dryRun
    || eventData?.detail?.isDryRun
  );
  return { promptChat, dryRun };
}

async function injectMemoryIntoPromptReady(eventData, secondArg = false) {
  const reportedContextSize = Number(eventData?.contextSize ?? eventData?.maxContext ?? eventData?.detail?.contextSize ?? 0);
  if (reportedContextSize > 0) state.lastContextSize = reportedContextSize;
  const s = settings();
  const { promptChat, dryRun } = resolvePromptReadyPayload(eventData, secondArg);
  // Prompt Inspector / Prompt List uses a dry run. The old code returned here, so the inspector
  // always displayed full old chatHistory bodies even when real generations were compressed.
  // Apply the same deterministic pruning in dry runs, but do not persist injection bookkeeping.
  if (!Array.isArray(promptChat)) return;
  if (!s.enabled) {
    removeExistingAnchorMemoryPrompt(promptChat);
    return;
  }
  const operationEpoch = state.contextEpoch;
  try {
    const contextChat = getContext().chat || [];
    const recallResolutionPromise = !dryRun && s.useDynamicRecall
      ? resolveDynamicRecallBeforeSend(contextChat, DYNAMIC_RECALL_PROMPT_WAIT_MS)
      : Promise.resolve(null);
    // Wait before mutating the real request array. This lets the master pause switch invalidate the
    // operation cleanly instead of leaving a half-pruned, half-injected prompt behind.
    const recallResolution = await recallResolutionPromise;
    if (!settings().enabled || operationEpoch !== state.contextEpoch) {
      removeExistingAnchorMemoryPrompt(promptChat);
      return;
    }
    const content = await buildPromptReadyInjection(contextChat, {
      commit: !dryRun,
      resolvedRecall: recallResolution,
    });
    if (!settings().enabled || operationEpoch !== state.contextEpoch) {
      removeExistingAnchorMemoryPrompt(promptChat);
      clearInjectedPromptState();
      return;
    }
    const replacementStats = applyGodlogContextReplacement(promptChat, {
      mode: 'prompt-ready-history-hide',
      save: false,
      prune: true,
    });
    const sanitizedLeaks = sanitizePromptReadyGodlogLeaks(promptChat);
    removeExistingAnchorMemoryPrompt(promptChat);
    let promptRecord = null;
    if (String(content || '').trim()) {
      const insertIndex = resolvePromptInsertIndex(promptChat, normalizedInjectionDepth(s.injectionDepth));
      promptChat.splice(insertIndex, 0, { role: 'system', content });
      sanitizePromptReadyGodlogLeaks(promptChat);
      if (!dryRun) {
        markDynamicRecallInjected('chat-completion-prompt-ready', content);
        promptRecord = rememberPromptInjectionForNextMessage(memoryData(), contextChat, content);
      }
    }
    if (!dryRun) {
      const data = memoryData();
      data.processing.lastContextReplacement = {
        ...replacementStats,
        at: Date.now(),
        missing: Math.max(Number(replacementStats?.missing || 0), pendingGodlogRows(data).length),
        keepRecent: Math.max(1, Number(s.keepRecent) || 3),
        mode: 'prompt-ready-history-hide',
        sanitizedLeaks,
        injectedChars: String(content || '').length,
        injectedTokens: estimateTokens(content || ''),
        memoryBudgetTokens: state.lastMemoryBudget?.budgetTokens || 0,
        injectedItems: promptRecord?.refs?.length || 0,
        targetMessageIndex: promptRecord?.targetIndex ?? null,
      };
      saveMemory();
      refreshCommittedRecallUi();
    }
  } catch (err) {
    console.error('[AnchorMemory] prompt-ready injection failed', err);
  }
}

function usesChatCompletionPromptReady() {
  // Do not import `main_api`: it is not exported by every SillyTavern build.
  // The event itself is the compatibility signal; unsupported backends simply never emit it.
  return !!event_types?.CHAT_COMPLETION_PROMPT_READY;
}

async function injectMemory(chat = getContext().chat || [], options = {}) {
  const s = settings();
  const data = memoryData();
  if (!s.enabled) {
    clearInjectedPromptState();
    return;
  }

  const commit = options.commit === true || options.generation === true;
  const memoryPrompt = await buildPromptReadyInjection(chat, {
    commit,
    resolvedRecall: options.resolvedRecall || null,
  });
  setExtensionPrompt(
    CORE_PROMPT_KEY,
    memoryPrompt,
    extension_prompt_types.IN_CHAT,
    normalizedInjectionDepth(s.injectionDepth),
    false,
    extension_prompt_roles.SYSTEM,
  );
  // Use one deterministic block so the six sections keep the same order on every backend.
  setExtensionPrompt(RECALL_PROMPT_KEY, '', extension_prompt_types.IN_PROMPT, 0);
  if (options.generation) {
    markDynamicRecallInjected(
      usesChatCompletionPromptReady()
        ? 'extension-prompt-fallback-before-prompt-ready'
        : 'extension-prompt-generate-interceptor',
      memoryPrompt,
    );
    if (String(memoryPrompt || '').trim()) {
      rememberPromptInjectionForNextMessage(data, getContext().chat || chat, memoryPrompt);
    }
    refreshCommittedRecallUi();
  }
}

function markAnchorsStaleByKey(data, key, reason) {
  if (!data || !key) return { anchors: 0, merges: 0 };
  const removedAnchorIds = new Set();
  const removedAnchorKeys = new Set();
  const keptAnchors = [];
  for (const anchor of data.anchors || []) {
    if ((anchor.sourceKeys || []).includes(key)) {
      removedAnchorIds.add(anchor.id);
      for (const sourceKey of anchor.sourceKeys || []) removedAnchorKeys.add(sourceKey);
      removeStoredVector(data, anchor.id);
    } else {
      keptAnchors.push(anchor);
    }
  }
  data.anchors = keptAnchors;

  let cascade = false;
  let removedMerges = 0;
  const keptMerges = [];
  for (const merge of data.merges || []) {
    const touchesKey = (merge.sourceKeys || []).includes(key);
    const touchesAnchor = (merge.sourceAnchorIds || []).some(id => removedAnchorIds.has(id));
    // A merge is cumulative. Once one earlier merge is invalidated, every later merge is derived
    // from it and must be discarded as well.
    if (cascade || touchesKey || touchesAnchor) {
      cascade = true;
      removedMerges++;
      removeStoredVector(data, merge.id);
    } else {
      keptMerges.push(merge);
    }
  }
  data.merges = keptMerges;

  if (removedAnchorIds.size || removedMerges) {
    data.processing.lastError = reason || '源楼层已变动，相关锚点已回滚';
  }
  renumberDerivedMemory(data);
  refreshCoverageMaps(data);
  return { anchors: removedAnchorIds.size, merges: removedMerges, releasedKeys: [...removedAnchorKeys] };
}

function refreshCoverageMaps(data = memoryData()) {
  const mergedKeys = {};
  const merge = latestMerge(data);
  for (const key of merge?.sourceKeys || []) mergedKeys[key] = true;

  const anchoredKeys = {};
  for (const anchor of activeAnchors(data)) {
    for (const key of anchor.sourceKeys || []) {
      if (!mergedKeys[key]) anchoredKeys[key] = true;
    }
  }
  data.processing.mergedKeys = mergedKeys;
  data.processing.anchoredKeys = anchoredKeys;
  return { mergedKeys, anchoredKeys };
}

function refreshAnchoredKeys(data = memoryData()) {
  return refreshCoverageMaps(data).anchoredKeys;
}

function pruneVectorIndex(data = memoryData()) {
  if (!data) return 0;
  const validIds = new Set(recallCorpus(data).map(source => source?.item?.id).filter(Boolean));
  let removed = 0;
  const ids = new Set([...Object.keys(data.vectorRefs || {}), ...Object.keys(data.vectors || {})]);
  for (const id of ids) {
    if (!validIds.has(id) && removeStoredVector(data, id)) removed++;
  }
  return removed;
}

function forgetGodlogItem(data, item, reason = '源楼层已变动', includeUser = false) {
  if (!data || !item) return false;
  clearSummaryRetryTimer(item.key);
  state.forcedSummaryReruns.delete(item.key);
  removeGodlogBlockFromMessage(currentRowForGodlog(item, includeUser));
  markAnchorsStaleByKey(data, item.key, reason);
  removeStoredVector(data, item.id);
  delete data.processing?.codexKeys?.[item.key];
  delete data.messageGodlogs?.[item.key];
  delete data.messageRecalls?.[item.key];
  if (data.processing?.pendingPromptInjection?.targetKey === item.key) {
    data.processing.pendingPromptInjection = null;
  }
  // Incremental tables are cumulative and cannot subtract a deleted/rerolled fact. Roll the fixed
  // relationship table back to its nearest earlier snapshot, then rebuild every derived index from
  // the surviving timeline instead of leaving ghost people/items/relationships behind.
  rollbackRelationshipToFloor(data, Number(item.floor ?? -1) - 1, reason || '源楼层已变动');
  markCodexDirty(data, reason || '源楼层已变动', true, false, Number(item.floor ?? -1));

  if (state.selectedGodlogId === item.id) {
    state.selectedGodlogId = '';
    $('#am_godlog_detail').val('');
  }
  const index = (data.godlogs || []).findIndex(entry => entry.id === item.id);
  if (index >= 0) data.godlogs.splice(index, 1);
  refreshCoverageMaps(data);
  return index >= 0;
}

function preserveCompletedGodlogOnSourceChange(data, item, row, reason = '楼层在摘要完成后发生了变化') {
  if (!data || !item || !row) return false;
  const changed = lockCompletedSummaryToSavedSnapshot(item, row, reason);
  if (!changed) return false;
  rememberMessageGodlogCard(data, row, item, 'ready');
  refreshCoverageMaps(data);
  return true;
}

function markGodlogForSourceRefresh(data, item, row, reason = '源楼层内容已更新') {
  if (!data || !item || !row) return false;
  noteRowRevision(row, true);
  const wasCurrent = item.rawHash === row.rawHash && item.status === 'stale' && item.stale;
  if (wasCurrent) return false;

  // Keep the last completed body visible as a temporary card, but immediately revoke it from
  // anchors, embeddings, codex, and prompt injection because it no longer matches the source.
  markAnchorsStaleByKey(data, item.key, reason);
  removeStoredVector(data, item.id);
  delete data.processing?.codexKeys?.[item.key];
  delete data.messageRecalls?.[item.key];
  if (data.processing?.pendingPromptInjection?.targetKey === item.key) {
    data.processing.pendingPromptInjection = null;
  }
  rollbackRelationshipToFloor(data, Number(row.index ?? item.floor ?? -1) - 1, reason || '源楼层已变动');
  markCodexDirty(data, reason || '源楼层已变动', true, false, Number(row.index ?? item.floor ?? -1));

  const hasOldBody = !!String(item.body || '').trim();
  Object.assign(item, {
    floor: row.index,
    role: row.role,
    name: row.name,
    sendDate: row.sendDate,
    previousRawHash: item.rawHash || item.previousRawHash || '',
    rawHash: row.rawHash,
    status: hasOldBody ? 'stale' : 'pending',
    stale: hasOldBody,
    staleSince: Date.now(),
    error: hasOldBody
      ? '楼层内容仍在更新；旧摘要暂时保留，正文稳定后会自动刷新。'
      : '楼层内容仍在更新；正文稳定后才会生成摘要。',
    updatedAt: item.updatedAt || Date.now(),
  });
  rememberMessageGodlogCard(data, row, item, hasOldBody ? 'stale' : 'pending');
  refreshCoverageMaps(data);
  return true;
}

function remapGodlogSourceKey(data, item, nextKey) {
  const oldKey = String(item?.key || '');
  const targetKey = String(nextKey || '');
  if (!data || !item || !oldKey || !targetKey || oldKey === targetKey) return false;
  const remapList = values => [...new Set((values || []).map(key => key === oldKey ? targetKey : key).filter(Boolean))];
  for (const anchor of data.anchors || []) {
    anchor.sourceKeys = remapList(anchor.sourceKeys);
    anchor.coveredKeys = remapList(anchor.coveredKeys);
    anchor.rawFallbackKeys = remapList(anchor.rawFallbackKeys);
  }
  for (const merge of data.merges || []) {
    merge.sourceKeys = remapList(merge.sourceKeys);
    merge.cycleSourceKeys = remapList(merge.cycleSourceKeys);
    merge.rawFallbackKeys = remapList(merge.rawFallbackKeys);
  }
  const moveObjectKey = object => {
    if (!object || typeof object !== 'object' || !Object.prototype.hasOwnProperty.call(object, oldKey)) return;
    if (!Object.prototype.hasOwnProperty.call(object, targetKey)) object[targetKey] = object[oldKey];
    delete object[oldKey];
  };
  moveObjectKey(data.messageGodlogs);
  moveObjectKey(data.messageRecalls);
  moveObjectKey(data.processing?.codexKeys);
  if (data.processing?.pendingPromptInjection?.targetKey === oldKey) {
    data.processing.pendingPromptInjection.targetKey = targetKey;
  }
  const table = normalizeRelationshipTable(data.relationshipTable, data.codex?.relationship || '');
  table.history = (table.history || []).map(entry => entry.sourceKey === oldKey ? { ...entry, sourceKey: targetKey } : entry);
  if (table.lastGoodKey === oldKey) table.lastGoodKey = targetKey;
  data.relationshipTable = table;
  data.codex.relationship = relationshipTableMarkdown(table, false);
  item.key = targetKey;
  if (state.selectedRecallMessageKey === oldKey) state.selectedRecallMessageKey = targetKey;
  state.godlogIndexData = null;
  state.godlogIndexArray = null;
  state.godlogByKey = new Map();
  refreshCoverageMaps(data);
  return true;
}

function syncGodlogsWithChat(reason = '聊天变动') {
  if (!hasPersistentChatContext()) return false;
  const data = memoryData();
  let changed = ensureLegacyGodlogCleanup();
  const rows = chatRows(true);
  const byKey = new Map(rows.map(row => [row.key, row]));

  for (const item of [...(data.godlogs || [])]) {
    if (item.archived) continue;
    let row = byKey.get(item.key) || currentRowForGodlog(item, true);
    if (!row || row.role !== 'assistant') {
      if (!row && activeSummarySourceLookupDeferred(item)) {
        // A transient host re-render is not a deletion. Keep the pending record and postpone the
        // destructive rollback until the active summary request and its grace window have ended.
        item.sourceLookupDeferredAt = item.sourceLookupDeferredAt || Date.now();
        changed = true;
        continue;
      }
      changed = forgetGodlogItem(data, item, !row ? '源楼层已删除或重生成' : '用户楼不保留逐楼摘要', true) || changed;
      continue;
    }

    if (item.key !== row.key) {
      changed = remapGodlogSourceKey(data, item, row.key) || changed;
    }
    if (item.sourceLookupDeferredAt) {
      item.sourceLookupDeferredAt = 0;
      changed = true;
    }
    if (item.floor !== row.index
        || item.name !== row.name
        || item.sendDate !== row.sendDate
        || Number(item.assistantNumber || 0) !== Number(row.assistantNumber || 0)) {
      item.floor = row.index;
      item.name = row.name;
      item.sendDate = row.sendDate;
      item.assistantNumber = row.assistantNumber || item.assistantNumber || 0;
      item.updatedAt = Date.now();
      changed = true;
    }

    if (item.rawHash && item.rawHash !== row.rawHash) {
      changed = isCompletedSummary(item)
        ? preserveCompletedGodlogOnSourceChange(data, item, row, reason || '楼层在摘要完成后发生了变化') || changed
        : markGodlogForSourceRefresh(data, item, row, reason || '源楼层已编辑或重生成') || changed;
      continue;
    }

    if (item.sourceMismatch || item.currentRawHash || item.sourceMismatchReason) {
      changed = preserveCompletedGodlogOnSourceChange(data, item, row, '') || changed;
    }

    if (syncGodlogNumber(item, row)) {
      item.updatedAt = Date.now();
      removeStoredVector(data, item.id);
      changed = true;
    }
  }

  syncGodlogCount(data);
  refreshTimelineFromGodlogs(data);
  refreshCoverageMaps(data);
  if (pruneVectorIndex(data) > 0) changed = true;
  if (pruneMessageUiIndexes(data, rows)) changed = true;
  if (changed) saveMemory(true);
  scheduleCodexBacklog(4);
  enforceAnchorHiddenState(data).catch(err => console.warn('[AnchorMemory] reconcile hidden state failed:', err));
  scheduleGodlogPanelRender();
  return changed;
}

function saveChatNow() {
  try {
    const ctx = getContext();
    const result = typeof ctx.saveChat === 'function'
      ? ctx.saveChat()
      : (ctx.groupId && typeof legacyGroupModule.saveGroupChat === 'function'
        ? legacyGroupModule.saveGroupChat(ctx.groupId, true)
        : undefined);
    if (result && typeof result.catch === 'function') {
      result.catch(err => console.warn('[AnchorMemory] saveChat failed:', err));
    }
    return result;
  } catch (err) {
    console.warn('[AnchorMemory] saveChat failed:', err);
  }
  return null;
}

function refreshMessageBlock(rowOrIndex) {
  const index = typeof rowOrIndex === 'number' ? rowOrIndex : rowOrIndex?.index;
  if (!Number.isInteger(index)) return false;
  const chat = getContext().chat || [];
  const message = chat[index];
  if (!message || !$(`#chat .mes[mesid="${index}"]`).length) return false;
  try {
    updateMessageBlock(index, message, { rerenderMessage: true });
    return true;
  } catch (err) {
    console.warn('[AnchorMemory] message block refresh failed:', err);
    return false;
  }
}

function syncGodlogBlockToMessage(row, _body) {
  return removeGodlogBlockFromMessage(row);
}

function removeGodlogBlockFromMessage(row) {
  if (!row) return false;
  const chat = getContext().chat || [];
  const message = chat[row.index];
  if (!message || (message.is_system && !isMemoryManagedHidden(message)) || !stripGodlogFromMessageRecord(message)) return false;

  refreshMessageBlock(row);
  saveChatNow();
  return true;
}

function removeAllGodlogBlocksFromChat() {
  const chat = getContext().chat || [];
  let changed = false;
  for (let index = 0; index < chat.length; index++) {
    const message = chat[index];
    if (!message || (message.is_system && !isMemoryManagedHidden(message))) continue;
    const rowChanged = stripGodlogFromMessageRecord(message);
    if (rowChanged) refreshMessageBlock(index);
    changed = rowChanged || changed;
  }
  if (changed) saveChatNow();
  return changed;
}

function ensureLegacyGodlogCleanup() {
  if (state.godlogCleanupEpoch === state.contextEpoch) return false;
  const changed = removeAllGodlogBlocksFromChat();
  state.godlogCleanupEpoch = state.contextEpoch;
  return changed;
}

function contiguousRanges(indices) {
  const valid = [...new Set((indices || []).filter(Number.isInteger))].sort((a, b) => a - b);
  if (valid.length === 0) return [];
  const ranges = [];
  let start = valid[0];
  let prev = valid[0];
  for (let i = 1; i < valid.length; i++) {
    const current = valid[i];
    if (current === prev + 1) {
      prev = current;
      continue;
    }
    ranges.push([start, prev]);
    start = current;
    prev = current;
  }
  ranges.push([start, prev]);
  return ranges;
}

function anchorHiddenMeta(message) {
  if (!message.anchor_memory_meta) message.anchor_memory_meta = {};
  if (!Array.isArray(message.anchor_memory_meta.hiddenAnchorIds)) {
    message.anchor_memory_meta.hiddenAnchorIds = [];
  }
  return message.anchor_memory_meta;
}

async function setMessagesHiddenByAnchor(indices, hidden, anchorId = '') {
  const chat = getContext().chat || [];
  const unique = [...new Set((indices || [])
    .filter(index => Number.isInteger(index) && index >= 0 && index < chat.length && !!chat[index]))]
    .sort((a, b) => a - b);
  if (unique.length === 0) return false;

  const actionIndices = [];
  for (const index of unique) {
    const message = chat[index];
    // Never take ownership of a genuine SillyTavern system/hidden message. We only unhide records
    // carrying our own metadata, including records hidden by older Anchor Memory versions.
    if (hidden && message.is_system && !isMemoryManagedHidden(message)) continue;
    if (!hidden && !hasMemoryHideOwnership(message)) continue;

    const meta = anchorHiddenMeta(message);
    if (hidden) {
      if (!meta.hiddenAnchorIds.includes(anchorId)) meta.hiddenAnchorIds.push(anchorId);
      if (meta.wasHiddenBeforeAnchor === undefined) meta.wasHiddenBeforeAnchor = !!message.is_hidden;
      if (meta.wasSystemBeforeAnchor === undefined) meta.wasSystemBeforeAnchor = !!message.is_system;
      meta.hiddenByMemory = true;
      actionIndices.push(index);
    } else {
      meta.hiddenAnchorIds = anchorId === '*' ? [] : meta.hiddenAnchorIds.filter(id => id !== anchorId);
      if (meta.hiddenAnchorIds.length === 0) actionIndices.push(index);
    }
  }
  if (actionIndices.length === 0) return false;

  let officialHideSucceeded = false;
  try {
    // Dynamic import avoids a fatal module-load error on ST versions that do not export this helper.
    const chatsModule = await import('../../../chats.js');
    const officialHide = chatsModule?.hideChatMessageRange;
    if (typeof officialHide === 'function') {
      for (const [start, end] of contiguousRanges(actionIndices)) {
        // SillyTavern uses `false` for hide and `true` for unhide.
        await officialHide(start, end, !hidden);
      }
      officialHideSucceeded = true;
    }
  } catch (err) {
    console.warn('[AnchorMemory] official hide API unavailable; using fallback:', err);
  }

  if (!officialHideSucceeded) {
    try {
      const slashModule = await import('/scripts/slash-commands.js');
      const exec = slashModule.executeSlashCommandsWithOptions;
      if (typeof exec === 'function') {
        const command = hidden ? '/hide' : '/unhide';
        for (const [start, end] of contiguousRanges(actionIndices)) {
          const range = start === end ? `${start}` : `${start}-${end}`;
          await exec(`${command} ${range}`);
        }
      }
    } catch (err) {
      console.warn('[AnchorMemory] /hide fallback failed; using direct flags:', err);
    }
  }

  for (const index of actionIndices) {
    const message = chat[index];
    const meta = anchorHiddenMeta(message);
    if (hidden || meta.hiddenAnchorIds.length > 0) {
      meta.hiddenByMemory = true;
      message.is_hidden = true;
    } else {
      message.is_hidden = meta.wasHiddenBeforeAnchor === true;
      message.is_system = meta.wasSystemBeforeAnchor === true;
      delete meta.hiddenByMemory;
      delete meta.hiddenAnchorIds;
      delete meta.wasHiddenBeforeAnchor;
      delete meta.wasSystemBeforeAnchor;
    }

    const element = $(`#chat .mes[mesid="${index}"], .mes[mesid="${index}"]`);
    if (message.is_hidden || isMemoryManagedHidden(message)) element.attr('is_hidden', 'true');
    else element.removeAttr('is_hidden');
    if (message.is_system) element.attr('is_system', 'true');
    else element.removeAttr('is_system');
  }

  // Hidden-state changes can affect chatRows(false) even when the chat length and tail message are
  // unchanged. Without this invalidation, old visible-row caches survived until another unrelated
  // event and the message panels/counts could disagree with the actual prompt window.
  invalidateRuntimeCaches(hidden ? 'old messages hidden by memory window' : 'memory-hidden messages restored');
  await Promise.resolve(saveChatNow());
  return true;
}

function turnMessageIndicesForAssistant(chat, assistantIndex) {
  const assistant = chat?.[assistantIndex];
  if (!Array.isArray(chat) || !assistant || assistant.is_user || !isNarrativeMessage(assistant)) return [];
  let start = assistantIndex;
  for (let index = assistantIndex - 1; index >= 0; index--) {
    const message = chat[index];
    if (!message || !isNarrativeMessage(message)) continue;
    if (!message.is_user) break;
    start = index;
  }
  const indices = [];
  for (let index = start; index <= assistantIndex; index++) {
    const message = chat[index];
    if (!message || !isNarrativeMessage(message)) continue;
    indices.push(index);
  }
  return indices;
}

function coveredRowsForAnchorRows(rows) {
  const chat = getContext().chat || [];
  const byIndex = new Map();
  for (const row of rows || []) {
    for (const index of turnMessageIndicesForAssistant(chat, row.index)) {
      const message = chat[index];
      if (!message) continue;
      byIndex.set(index, {
        index,
        key: messageKey(message, index),
        role: messageRole(message),
        name: message.name || '',
        sendDate: message.send_date || '',
      });
    }
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

function indicesForCoveredAnchor(anchor) {
  const chat = getContext().chat || [];
  const indices = new Set();
  const keys = new Set(anchor?.coveredKeys || []);
  if (keys.size > 0) {
    for (let index = 0; index < chat.length; index++) {
      const message = chat[index];
      if (!message) continue;
      if (keys.has(messageKey(message, index))) indices.add(index);
    }
    return [...indices].sort((a, b) => a - b);
  }
  const sourceKeys = new Set(anchor?.sourceKeys || []);
  if (sourceKeys.size > 0) {
    for (let index = 0; index < chat.length; index++) {
      const message = chat[index];
      if (!message) continue;
      if (!sourceKeys.has(messageKey(message, index))) continue;
      for (const coveredIndex of turnMessageIndicesForAssistant(chat, index)) indices.add(coveredIndex);
    }
    return [...indices].sort((a, b) => a - b);
  }
  if (!Array.isArray(anchor?.coveredFloors) && Array.isArray(anchor?.sourceFloors)) {
    for (const sourceFloor of anchor.sourceFloors) {
      for (const coveredIndex of turnMessageIndicesForAssistant(chat, sourceFloor)) indices.add(coveredIndex);
    }
    return [...indices].sort((a, b) => a - b);
  }
  for (const index of anchor?.coveredFloors || []) {
    if (Number.isInteger(index) && index >= 0 && index < chat.length && chat[index]) indices.add(index);
  }
  return [...indices].sort((a, b) => a - b);
}

async function setAnchorCoveredMessagesHidden(anchor, hidden = true) {
  if (!anchor) return false;
  return setMessagesHiddenByAnchor(indicesForCoveredAnchor(anchor), hidden, anchor.id);
}

function recentRawHistoryPlan(chat = getContext().chat || [], keepRecent = Math.max(1, Number(settings().keepRecent) || 3)) {
  const safeChat = Array.isArray(chat) ? chat : [];
  const assistantIndices = [];
  for (let index = 0; index < safeChat.length; index++) {
    const message = safeChat[index];
    if (!message || !isNarrativeMessage(message) || message.is_user || !cleanText(message.mes || '')) continue;
    assistantIndices.push(index);
  }

  const keepCount = Math.max(1, Number(keepRecent) || 3);
  const keepAssistantIndices = assistantIndices.slice(-keepCount);
  const keepIndices = new Set();
  for (const assistantIndex of keepAssistantIndices) {
    for (const index of turnMessageIndicesForAssistant(safeChat, assistantIndex)) keepIndices.add(index);
  }

  // While a new reply is being requested, the newest user input has no assistant partner yet.
  // It must remain in the prompt together with any other narrative rows after the latest AI floor.
  const lastAssistantIndex = assistantIndices.length ? assistantIndices[assistantIndices.length - 1] : -1;
  for (let index = lastAssistantIndex + 1; index < safeChat.length; index++) {
    const message = safeChat[index];
    if (message && isNarrativeMessage(message)) keepIndices.add(index);
  }

  const hideIndices = [];
  for (let index = 0; index < safeChat.length; index++) {
    const message = safeChat[index];
    if (!message || !isNarrativeMessage(message) || keepIndices.has(index)) continue;
    hideIndices.push(index);
  }

  return {
    keepRecent: keepCount,
    assistantIndices,
    keepAssistantIndices,
    keepIndices: [...keepIndices].sort((a, b) => a - b),
    hideIndices,
  };
}

async function enforceAnchorHiddenState(data = memoryData()) {
  const chat = getContext().chat || [];
  if (!Array.isArray(chat) || chat.length === 0) return false;

  // A pause/resume click can happen while SillyTavern is still applying hidden flags. Re-evaluate the
  // desired mode after each async pass so an older “hide” operation cannot finish after pause and
  // leave plugin-managed rows hidden. Three passes are enough to absorb a rapid double toggle while
  // avoiding an unbounded retry loop caused by another extension continuously changing the rows.
  let changed = false;
  for (let pass = 0; pass < 3; pass++) {
    const shouldHide = !!(settings().enabled && settings().autoHide);
    // “保留最近 N 个 AI 正文”是独立的硬窗口，不再依赖摘要是否成功、是否进入分段锚点。
    // 摘要失败不能让第四轮及以前的完整正文重新泄漏到 chat history；缺失楼层由独立的受限保底原文段维持连续性。
    const plan = recentRawHistoryPlan(chat);
    const desiredHidden = new Set(shouldHide ? plan.hideIndices : []);
    const toHide = [];
    const toUnhide = [];

    for (let index = 0; index < chat.length; index++) {
      const message = chat[index];
      if (!message) continue;
      const managed = hasMemoryHideOwnership(message);
      if (desiredHidden.has(index)) {
        if (!managed || !message.is_hidden) toHide.push(index);
      } else if (managed) {
        toUnhide.push(index);
      }
    }

    if (toHide.length > 0) changed = await setMessagesHiddenByAnchor(toHide, true, 'recent-window') || changed;
    if (toUnhide.length > 0) changed = await setMessagesHiddenByAnchor(toUnhide, false, '*') || changed;

    const currentMode = !!(settings().enabled && settings().autoHide);
    if (currentMode === shouldHide) return changed;
  }
  return changed;
}

function currentRowForGodlog(item, includeUser = false) {
  if (!item) return null;
  const rows = chatRows(true, includeUser);
  const exact = rows.find(row => row.key === item.key);
  if (exact) return exact;
  const assistantRows = rows.filter(row => row.role === 'assistant');

  // SillyTavern can briefly replace/normalize a message object while a background request is in
  // flight. Resolve the same narrative floor by immutable content/date/assistant ordinal before
  // declaring it deleted; source-hash validation later still prevents committing to a wrong row.
  if (item.rawHash) {
    const hashMatches = assistantRows.filter(row => row.rawHash === item.rawHash);
    if (hashMatches.length === 1) return hashMatches[0];
  }
  if (item.sendDate) {
    const dateMatches = assistantRows.filter(row => row.sendDate && row.sendDate === item.sendDate);
    if (dateMatches.length === 1) return dateMatches[0];
  }
  if (Number(item.assistantNumber) > 0) {
    const ordinalMatches = assistantRows.filter(row => Number(row.assistantNumber) === Number(item.assistantNumber));
    if (ordinalMatches.length === 1) return ordinalMatches[0];
  }
  const floorMatches = assistantRows.filter(row => Number(row.index) === Number(item.floor));
  if (floorMatches.length === 1) return floorMatches[0];
  return null;
}


function summaryRowKey(rowOrKey) {
  if (typeof rowOrKey === 'string') return rowOrKey;
  return String(rowOrKey?.key || '');
}

function isSummaryRowBusy(rowOrKey) {
  const key = summaryRowKey(rowOrKey);
  return !!key && state.summaryTasks.has(key);
}

function syncActiveSummaryRowKey() {
  state.activeSummaryRowKey = state.summaryTasks.keys().next().value || '';
}

function clearSummaryRetryTimer(rowOrKey) {
  const key = summaryRowKey(rowOrKey);
  if (!key) return;
  const timer = state.summaryRetryTimers.get(key);
  if (timer) clearTimeout(timer);
  state.summaryRetryTimers.delete(key);
}

function clearAllSummaryRuntimeTasks() {
  for (const timer of state.summaryRetryTimers.values()) clearTimeout(timer);
  state.summaryRetryTimers.clear();
  state.forcedSummaryReruns.clear();
  state.summaryTasks.clear();
  syncActiveSummaryRowKey();
}

function summaryErrorIsNonRetryable(error) {
  if (error?.code === 'AM_REQUEST_CANCELLED') return true;
  const text = String(error?.message || error || '');
  return /(?:地址或密钥未配置|逐楼摘要需要先配置并启用副API|副API模型为空|Secondary API (?:400|401|403|404)|invalid\s*(?:api[-_ ]?)?key|unauthori[sz]ed|forbidden|authentication failed|鉴权失败|认证失败)/i.test(text);
}

function summaryRetryDelay(retryCount) {
  const index = Math.max(0, Math.min(SUMMARY_AUTO_RETRY_DELAYS_MS.length - 1, Number(retryCount || 1) - 1));
  return SUMMARY_AUTO_RETRY_DELAYS_MS[index];
}

function scheduleGodlogAutoRetry(row, force, retryCount, errorText = '') {
  if (!row?.key || retryCount >= 3 || summaryErrorIsNonRetryable(errorText)) return false;
  clearSummaryRetryTimer(row.key);
  const delay = summaryRetryDelay(retryCount);
  const contextToken = captureChatContextToken(memoryData());
  const key = row.key;
  const timer = setTimeout(async () => {
    state.summaryRetryTimers.delete(key);
    if (!settings().enabled || !isSameChatContext(contextToken)) return;
    const current = rowByStableKey(key) || currentRowForGodlog(godlogForRow(memoryData(), row));
    if (!current) return;
    if (!isRowSettledForGodlog(current)) {
      if (force) {
        state.forcedSummaryReruns.add(key);
        scheduleMemoryAfterSettle('摘要自动重试等待正文稳定', current, true);
      } else {
        scheduleMemoryAfterSettle('摘要自动重试等待正文稳定', current);
      }
      return;
    }
    if (isSummaryRowBusy(key)) {
      scheduleGodlogAutoRetry(current, force, Math.max(1, retryCount), errorText);
      return;
    }
    await generateGodlogForRow(current, force);
  }, delay);
  state.summaryRetryTimers.set(key, timer);
  return true;
}

function markManualRerunQueued(data, row, existing = null) {
  const item = existing || upsertGodlog(data, row, {
    status: 'pending',
    stale: false,
    error: '正文仍在生成或尚未稳定；已排队手动重跑。',
  });
  item.rerunPending = true;
  item.rerunQueued = true;
  item.rerunError = '';
  item.rerunStartedAt = item.rerunStartedAt || Date.now();
  item.updatedAt = Date.now();
  state.forcedSummaryReruns.add(row.key);
  saveMemory();
  scheduleGodlogPanelRender(row.index);
  return item;
}

function activeSummarySourceLookupDeferred(item) {
  if (!item || (item.status !== 'pending' && !item.rerunPending)) return false;
  const active = isSummaryRowBusy(item.key);
  const deferredAt = Number(item.sourceLookupDeferredAt || item.summaryStartedAt || 0);
  return !!active || (deferredAt > 0 && Date.now() - deferredAt < ACTIVE_SUMMARY_SOURCE_LOOKUP_GRACE_MS);
}

function scheduleDeferredSummarySourceCheck(item, contextToken) {
  if (!item?.key) return;
  const timerKey = `source-check:${item.key}`;
  const existing = state.settleTimers.get(timerKey);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    state.settleTimers.delete(timerKey);
    if (!settings().enabled || !isSameChatContext(contextToken)) return;
    invalidateRuntimeCaches('deferred summary source check');
    syncGodlogsWithChat('摘要源楼层延迟确认');
    if (hasPendingMemoryWork()) queueMemoryJob('摘要源楼层已重新确认', 0);
  }, ACTIVE_SUMMARY_SOURCE_LOOKUP_GRACE_MS + 120);
  state.settleTimers.set(timerKey, timer);
}

function syncLatestGodlogPositionFields(data) {
  const latest = [...(data.godlogs || [])]
    .filter(item => !item.archived && item.status === 'ready' && !item.stale && item.body)
    .sort((a, b) => (b.floor ?? -1) - (a.floor ?? -1) || (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  if (!latest) return false;

  let nextBody = latest.body;
  if (data.codex.currentTime) nextBody = replaceGodlogField(nextBody, 'Time', data.codex.currentTime);
  if (data.codex.currentPlace) nextBody = replaceGodlogField(nextBody, 'Pln', data.codex.currentPlace);
  if (nextBody === latest.body) return false;

  latest.body = nextBody;
  latest.editedAt = Date.now();
  latest.updatedAt = Date.now();
  removeStoredVector(data, latest.id);
  syncGodlogBlockToMessage(currentRowForGodlog(latest), latest.body);
  return true;
}

async function generateGodlogForRow(row, force = false) {
  const key = summaryRowKey(row);
  if (!key) return false;
  if (isSummaryRowBusy(key)) return false;
  if (force && state.forcedSummaryReruns.has(key)) return false;

  clearSummaryRetryTimer(key);
  const task = generateGodlogForRowUnlocked(row, force);
  state.summaryTasks.set(key, task);
  syncActiveSummaryRowKey();
  scheduleGodlogPanelRender(row.index);
  try {
    return await task;
  } finally {
    if (state.summaryTasks.get(key) === task) state.summaryTasks.delete(key);
    syncActiveSummaryRowKey();
    scheduleGodlogPanelRender(row.index);
  }
}

async function generateGodlogForRowUnlocked(row, force = false) {
  if (!settings().enabled || !hasPersistentChatContext()) return false;
  if (!row || row.role !== 'assistant') {
    if (row?.role === 'user') removeGodlogBlockFromMessage(row);
    return false;
  }
  const data = memoryData();
  const contextToken = captureChatContextToken(data);
  const operationEpoch = state.contextEpoch;
  const existing = godlogForRow(data, row);
  const replacingCompleted = !!(force && isCompletedSummary(existing));

  if (!force && isGodlogReady(existing, row)) {
    if (syncGodlogNumber(existing, row)) {
      removeStoredVector(data, existing.id);
      saveMemory();
    }
    syncGodlogBlockToMessage(row, existing.body);
    refreshTimelineFromGodlogs(data);
    await updateCodexFromGodlog(data, row, existing);
    if (!isSameChatContext(contextToken)) return false;
    await ensureMemoryItemEmbedded(data, existing.id, safeGodlogMemoryText(existing.body || ''));
    return true;
  }
  if (!force && existing?.status === 'failed') {
    const s = settings();
    const canRetry = !!(secondaryConfigured(s) && (existing.retryCount || 0) < 3);
    if (!canRetry) return false;
  }

  if (!isRowSettledForGodlog(row)) {
    if (force) {
      markManualRerunQueued(data, row, existing);
      scheduleMemoryAfterSettle('当前楼正文稳定后执行手动重跑', row, true);
    } else {
      scheduleMemoryAfterSettle('当前楼正文稳定后写摘要', row);
    }
    return false;
  }

  state.forcedSummaryReruns.delete(row.key);
  const sourceHash = row.rawHash;
  const item = replacingCompleted
    ? existing
    : upsertGodlog(data, row, force
      ? { status: 'pending', stale: !!existing?.body, error: '正在重新生成；成功前不会替换已有摘要。' }
      : { status: 'pending', error: '' });

  item.summaryStartedAt = Date.now();
  item.sourceLookupDeferredAt = 0;
  if (force) {
    item.rerunPending = true;
    item.rerunQueued = false;
    item.retryScheduledAt = 0;
    item.rerunError = '';
    item.rerunStartedAt = item.rerunStartedAt || Date.now();
  }
  if (replacingCompleted) {
    item.rerunRetryCount = item.rerunRetryCount || 0;
  }
  saveMemory();
  showStatus(`正在写逐楼摘要：第 ${row.index} 楼`);

  try {
    const basePrompt = buildGodlogPrompt(data, row, item);
    let body = '';
    if (item.pendingGeneratedBody && item.pendingGeneratedRawHash === sourceHash) {
      body = normalizeGodlogBlock(item.pendingGeneratedBody);
    } else {
      body = normalizeGodlogBlock(await callSummaryWriter(basePrompt, 1200));
      if (!isSameChatContext(contextToken)) return false;
    }
    body = replaceGodlogField(body, 'Nub', String(item.number || godlogNumberForRow(row) || 1));
    let validation = validateGodlogCandidate(body, row);
    if (!validation.ok) {
      // Only a real model answer with a format/length defect gets a corrective rewrite. Transport,
      // authentication, empty-response and parser errors are thrown by callSecondary with the real
      // cause and must not be disguised as a second “summary correction” request.
      if (!String(body || '').trim()) throw new Error(`摘要校验失败：${validation.reason}`);
      const correctionPrompt = buildGodlogCorrectionPrompt(basePrompt, body, validation);
      body = normalizeGodlogBlock(await callSummaryWriter(correctionPrompt, 1800));
      if (!isSameChatContext(contextToken)) return false;
      body = replaceGodlogField(body, 'Nub', String(item.number || godlogNumberForRow(row) || 1));
      validation = validateGodlogCandidate(body, row);
    }
    if (!validation.ok) throw new Error(`摘要校验失败：${validation.reason}；已自动纠正重试1次`);
    body = validation.block;

    // Never commit against a source revision different from the one sent to the writer. For a
    // manual rerun, keep the old ready snapshot untouched instead of demoting it to missing/stale.
    let latestRow = currentRowForGodlog(item);
    if (!latestRow) {
      invalidateRuntimeCaches('summary source re-resolve');
      latestRow = currentRowForGodlog(item);
    }
    if (!latestRow || latestRow.rawHash !== sourceHash) {
      if (replacingCompleted) {
        item.rerunPending = false;
        item.rerunError = latestRow
          ? '重跑期间楼层内容继续变化；旧摘要仍然保留，请在正文稳定后手动重跑。'
          : '重跑结束时暂未定位到源楼层；旧摘要仍然保留，插件会延迟确认，不会立即回滚关系表。';
        item.rerunFinishedAt = Date.now();
        if (latestRow) preserveCompletedGodlogOnSourceChange(data, item, latestRow, '重跑期间楼层内容发生变化');
        else {
          item.sourceLookupDeferredAt = Date.now();
          scheduleDeferredSummarySourceCheck(item, contextToken);
        }
        saveMemory(true);
        scheduleGodlogPanelRender();
        return false;
      }
      if (latestRow) {
        delete item.pendingGeneratedBody;
        delete item.pendingGeneratedRawHash;
        markGodlogForSourceRefresh(data, item, latestRow, '摘要生成期间楼层内容继续变化');
        scheduleMemoryAfterSettle('楼层变化后重新写摘要', latestRow);
      } else {
        // Do not convert a transient message-object replacement into a destructive deletion. Keep
        // the already-generated candidate so the next stable pass can commit it without another API call.
        item.pendingGeneratedBody = body;
        item.pendingGeneratedRawHash = sourceHash;
        item.sourceLookupDeferredAt = Date.now();
        item.status = 'pending';
        item.error = '摘要已生成，正在等待酒馆确认源楼层稳定；期间不会回滚人物关系或状态表。';
        scheduleDeferredSummarySourceCheck(item, contextToken);
      }
      saveMemory(true);
      scheduleGodlogPanelRender();
      return false;
    }

    if (item.key !== latestRow.key) remapGodlogSourceKey(data, item, latestRow.key);

    // Replacement is transactional: dependent memories are revoked only after the new summary is
    // complete and validated. A failed rerun therefore never destroys the last good snapshot.
    if (force && existing) {
      markAnchorsStaleByKey(data, latestRow.key, '逐楼摘要被手动重跑');
      delete data.messageRecalls?.[latestRow.key];
      rollbackRelationshipToFloor(data, Number(latestRow.index) - 1, '逐楼摘要被手动重跑');
      markCodexDirty(data, '逐楼摘要被手动重跑', true, false, Number(latestRow.index));
    }

    Object.assign(item, {
      number: godlogNumberForRow(latestRow) || item.number,
      floor: latestRow.index,
      key: latestRow.key,
      role: latestRow.role,
      name: latestRow.name,
      sendDate: latestRow.sendDate,
      assistantNumber: latestRow.assistantNumber || item.assistantNumber || 0,
      body,
      rawHash: sourceHash,
      status: 'ready',
      stale: false,
      staleSince: 0,
      previousRawHash: '',
      error: '',
      retryCount: 0,
      retryScheduledAt: 0,
      currentRawHash: '',
      sourceMismatch: false,
      sourceMismatchReason: '',
      sourceMismatchAt: 0,
      sourceLookupDeferredAt: 0,
      summaryStartedAt: 0,
      pendingGeneratedBody: '',
      pendingGeneratedRawHash: '',
      rerunPending: false,
      rerunQueued: false,
      rerunRetryCount: 0,
      rerunError: '',
      rerunFinishedAt: Date.now(),
      updatedAt: Date.now(),
    });
    syncGodlogBlockToMessage(latestRow, item.body);
    refreshCoverageMaps(data);
    refreshTimelineFromGodlogs(data);
    data.processing.lastError = '';
    saveMemory(true);
    await enforceAnchorHiddenState(data);
    if (!isSameChatContext(contextToken)) return false;
    await updateCodexFromGodlog(data, latestRow, item);
    if (!isSameChatContext(contextToken)) return false;
    // If this floor previously relied on raw-recall, retire that fallback vector now that the
    // canonical Godlog exists.
    removeStoredVector(data, rawRecallItem(latestRow).id);
    await embedMemoryItem(data, item.id, safeGodlogMemoryText(item.body || ''));
    saveMemory(true);
    if (force && existing) queueMemoryJob('逐楼摘要已手动重跑', 120);
    return true;
  } catch (err) {
    if (!isSameChatContext(contextToken)) return false;
    const nonRetryable = summaryErrorIsNonRetryable(err);
    if (replacingCompleted) {
      const retryCount = (item.rerunRetryCount || 0) + 1;
      const willRetry = !nonRetryable && retryCount < 3;
      item.rerunPending = willRetry;
      item.rerunQueued = willRetry;
      item.rerunRetryCount = retryCount;
      item.rerunError = willRetry
        ? `第 ${retryCount} 次重跑失败：${err.message}；插件将自动重试（最多3次）。`
        : err.message;
      item.rerunFinishedAt = willRetry ? 0 : Date.now();
      item.retryScheduledAt = willRetry ? Date.now() + summaryRetryDelay(retryCount) : 0;
      data.processing.lastError = `摘要重跑失败，旧摘要已保留：${err.message}`;
      saveMemory();
      if (willRetry) scheduleGodlogAutoRetry(row, true, retryCount, err);
      return false;
    }
    const retryCount = (item.retryCount || 0) + 1;
    const willRetry = !nonRetryable && retryCount < 3;
    Object.assign(item, {
      status: willRetry ? 'pending' : 'failed',
      stale: !!item.body,
      retryCount,
      retryScheduledAt: willRetry ? Date.now() + summaryRetryDelay(retryCount) : 0,
      rerunPending: force ? willRetry : !!item.rerunPending,
      rerunQueued: force ? willRetry : false,
      rerunRetryCount: force ? retryCount : (item.rerunRetryCount || 0),
      rerunError: force ? (willRetry ? `第 ${retryCount} 次重跑失败，已安排自动重试。` : err.message) : (item.rerunError || ''),
      error: willRetry
        ? `第 ${retryCount} 次摘要请求失败：${err.message}；插件将自动重试（最多3次）。`
        : err.message,
      updatedAt: Date.now(),
    });
    data.processing.lastError = err.message;
    saveMemory();
    if (willRetry) {
      scheduleGodlogAutoRetry(row, force, retryCount, err);
    } else {
      const raw = rawRecallItem(row);
      if (raw.body) embedMemoryItem(data, raw.id, raw.body).catch(embedErr => console.warn('[AnchorMemory] raw fallback embedding failed', embedErr));
    }
    return false;
  } finally {
    if (isSameChatContext(contextToken)) scheduleGodlogPanelRender(row.index);
  }
}

async function processGodlogBacklog(limit = 4) {
  if (!settings().enabled || !hasPersistentChatContext()) return false;
  if (state.summaryRunning) return false;
  const data = memoryData();
  const contextToken = captureChatContextToken(data);
  const operationEpoch = state.contextEpoch;
  const pending = pendingGodlogRows(data);
  const rows = pending.filter(row => isRowSettledForGodlog(row)).slice(0, limit);
  const unsettledRows = pending.filter(row => !isRowSettledForGodlog(row)).slice(0, 8);
  for (const unsettled of unsettledRows) {
    scheduleMemoryAfterSettle('等待该楼正文稳定后写摘要', unsettled);
  }
  if (rows.length === 0) return pending.length === 0;

  state.summaryRunning = true;
  data.processing.summaryBusy = true;
  data.processing.lastError = '';
  saveMemory();

  try {
    let okCount = 0;
    for (const row of rows) {
      if (!isSameChatContext(contextToken)) return false;
      const ok = await generateGodlogForRow(row, false);
      if (!isSameChatContext(contextToken)) return false;
      if (ok) okCount++;
      if (!ok && (!secondaryConfigured())) break;
    }
    return okCount === rows.length;
  } finally {
    if (state.contextEpoch === operationEpoch) state.summaryRunning = false;
    if (!isSameChatContext(contextToken)) return;
    data.processing.summaryBusy = false;
    saveMemory();
    updatePreview();
    flushDeferredIntervalRecheck();
  }
}

async function repairMissingGodlogs(limit = Number.MAX_SAFE_INTEGER) {
  if (state.summaryRunning) {
    toastr?.warning?.('逐楼摘要正在生成，稍后再试', 'Anchor Memory');
    return false;
  }
  const data = memoryData();
  const contextToken = captureChatContextToken(data);
  const operationEpoch = state.contextEpoch;
  const rows = missingGodlogRepairRows(data).slice(0, limit);
  if (rows.length === 0) {
    toastr?.info?.('没有缺失的逐楼摘要', 'Anchor Memory');
    return true;
  }

  state.summaryRunning = true;
  data.processing.summaryBusy = true;
  data.processing.lastError = '';
  saveMemory();

  try {
    let okCount = 0;
    for (const row of rows) {
      if (!isSameChatContext(contextToken)) return false;
      const ok = await generateGodlogForRow(row, true);
      if (!isSameChatContext(contextToken)) return false;
      if (ok) okCount++;
      if (!ok && (!secondaryConfigured())) break;
    }
    if (okCount === rows.length) {
      toastr?.success?.(`已自动补写 ${okCount} 楼逐楼摘要`, 'Anchor Memory');
    } else {
      toastr?.warning?.(`已补写 ${okCount}/${rows.length} 楼；未完成楼层会继续待补写。它离开最近正文窗口后将使用受限保底原文维持时间线，不再永久阻塞后续锚点`, 'Anchor Memory');
    }
    return okCount === rows.length;
  } finally {
    if (state.contextEpoch === operationEpoch) state.summaryRunning = false;
    if (!isSameChatContext(contextToken)) return;
    data.processing.summaryBusy = false;
    saveMemory();
    updatePreview();
    flushDeferredIntervalRecheck();
  }
}

function outboundMessageText(message) {
  if (!message) return '';
  if (typeof message.mes === 'string') return cleanText(message.mes);
  if (typeof message.content === 'string') return cleanText(message.content);
  if (Array.isArray(message.content)) {
    return cleanText(message.content.map(part => (typeof part === 'string' ? part : part?.text || '')).join('\n'));
  }
  return '';
}

function normalizePromptBody(text) {
  return cleanText(text).replace(/\s+/g, ' ').trim();
}

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function promptBodyPattern(text) {
  const source = cleanText(text).trim();
  if (source.length < 12) return null;
  const tokens = source.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  return new RegExp(tokens.map(escapeRegExp).join('\\s+'), 'g');
}

function replaceOutboundMessageText(outbound, index, text, backups = null) {
  if (!Array.isArray(outbound) || index < 0 || index >= outbound.length || !outbound[index]) return false;
  if (backups && !backups.has(index)) backups.set(index, outbound[index]);
  const original = outbound[index];
  const next = { ...original, anchor_memory_context_replacement: true };
  if (typeof original.mes === 'string' || !('content' in original)) {
    next.mes = text;
  } else if (typeof original.content === 'string') {
    next.content = text;
  } else if (Array.isArray(original.content)) {
    next.content = [{ type: 'text', text }];
  } else {
    next.content = text;
  }
  outbound[index] = next;
  return true;
}

function replaceTextFragment(value, originalText, replacement) {
  if (typeof value !== 'string') return { changed: false, value };
  const cleanOriginal = cleanText(originalText);
  if (!cleanOriginal) return { changed: false, value };
  if (value.includes(cleanOriginal)) {
    return { changed: true, value: value.split(cleanOriginal).join(replacement) };
  }
  const pattern = promptBodyPattern(cleanOriginal);
  if (pattern && pattern.test(value)) {
    pattern.lastIndex = 0;
    return { changed: true, value: value.replace(pattern, replacement) };
  }
  return { changed: false, value };
}

function replaceOutboundMessageFragment(outbound, index, originalText, replacement, backups = null) {
  if (!Array.isArray(outbound) || index < 0 || index >= outbound.length || !outbound[index]) return false;
  const original = outbound[index];
  const next = { ...original, anchor_memory_context_replacement: true };
  let changed = false;
  if (typeof original.mes === 'string' || !('content' in original)) {
    const result = replaceTextFragment(String(original.mes || ''), originalText, replacement);
    changed = result.changed;
    next.mes = result.value;
  } else if (typeof original.content === 'string') {
    const result = replaceTextFragment(original.content, originalText, replacement);
    changed = result.changed;
    next.content = result.value;
  } else if (Array.isArray(original.content)) {
    next.content = original.content.map(part => {
      if (typeof part === 'string') {
        const result = replaceTextFragment(part, originalText, replacement);
        changed = changed || result.changed;
        return result.value;
      }
      if (part && typeof part.text === 'string') {
        const result = replaceTextFragment(part.text, originalText, replacement);
        changed = changed || result.changed;
        return { ...part, text: result.value };
      }
      return part;
    });
  }
  if (!changed) return false;
  if (backups && !backups.has(index)) backups.set(index, original);
  outbound[index] = next;
  return true;
}

function outboundRoleMatchesContext(outboundMessage, contextMessage) {
  if (!outboundMessage?.role || !contextMessage) return true;
  const expected = contextMessage.is_user ? 'user' : 'assistant';
  return outboundMessage.role === expected;
}

function findOutboundIndexForContextMessage(outbound, contextChat, contextIndex, used = new Set()) {
  if (!Array.isArray(outbound)) return -1;
  const original = contextChat?.[contextIndex];
  const originalText = cleanText(original?.mes || '');
  if (!originalText) return -1;
  const normalizedOriginal = normalizePromptBody(originalText);
  const direct = outbound[contextIndex];
  if (
    direct
    && !used.has(contextIndex)
    && outboundRoleMatchesContext(direct, original)
    && normalizePromptBody(outboundMessageText(direct)) === normalizedOriginal
  ) {
    return contextIndex;
  }
  for (let index = 0; index < outbound.length; index++) {
    if (used.has(index)) continue;
    if (!outboundRoleMatchesContext(outbound[index], original)) continue;
    const outboundText = outboundMessageText(outbound[index]);
    const normalizedOutbound = normalizePromptBody(outboundText);
    if (normalizedOutbound === normalizedOriginal) return index;
    if (normalizedOriginal.length >= 30 && normalizedOutbound.includes(normalizedOriginal)) return index;
  }
  return -1;
}

function hideOutboundContextMessage(outbound, contextChat, contextIndex, replacement, used = new Set(), backups = null) {
  const outboundIndex = findOutboundIndexForContextMessage(outbound, contextChat, contextIndex, used);
  if (outboundIndex >= 0) {
    if (replaceOutboundMessageText(outbound, outboundIndex, replacement, backups)) {
      used.add(outboundIndex);
      return 'whole-message';
    }
  }

  const original = contextChat?.[contextIndex];
  const originalText = cleanText(original?.mes || '');
  if (!originalText) return '';
  for (let index = 0; index < outbound.length; index++) {
    if (!outboundRoleMatchesContext(outbound[index], original)) continue;
    if (replaceOutboundMessageFragment(outbound, index, originalText, replacement, backups)) {
      return 'body-fragment';
    }
  }
  return '';
}

function buildOutboundSearchCache(outbound = []) {
  const entries = [];
  const exactByRole = new Map();
  const exactAnyRole = new Map();
  for (let index = 0; index < outbound.length; index++) {
    const message = outbound[index];
    const normalized = normalizePromptBody(outboundMessageText(message));
    const role = String(message?.role || '');
    const entry = { index, role, normalized };
    entries.push(entry);
    if (!normalized) continue;
    const roleKey = `${role}\u0000${normalized}`;
    if (!exactByRole.has(roleKey)) exactByRole.set(roleKey, []);
    exactByRole.get(roleKey).push(index);
    if (!exactAnyRole.has(normalized)) exactAnyRole.set(normalized, []);
    exactAnyRole.get(normalized).push(index);
  }
  return { entries, exactByRole, exactAnyRole };
}

function stripOutboundContextMessage(outbound, contextChat, contextIndex, used = new Set(), removals = new Set(), backups = null, searchCache = null) {
  if (!Array.isArray(outbound)) return '';
  const original = contextChat?.[contextIndex];
  const originalText = cleanText(original?.mes || '');
  if (!originalText) return '';
  const normalizedOriginal = normalizePromptBody(originalText);
  const cache = searchCache || buildOutboundSearchCache(outbound);
  const expectedRole = original?.is_user ? 'user' : 'assistant';

  // Remove every dedicated duplicate of this chatHistory item. Normalize each outbound item once
  // per request instead of once per old floor; the old path became quadratic on long chats.
  let exactMatches = 0;
  const exactCandidates = cache.exactByRole.get(`${expectedRole}\u0000${normalizedOriginal}`) || [];
  for (const index of exactCandidates) {
    if (used.has(index)) continue;
    if (backups && !backups.has(index)) backups.set(index, outbound[index]);
    removals.add(index);
    used.add(index);
    exactMatches++;
  }
  if (exactMatches > 0) return 'whole-message';

  // Wrapped prompt items are rarer. Narrow fallback scans using already-normalized text and a short
  // source prefix, then run the expensive regex replacement only on plausible candidates.
  const prefix = normalizedOriginal.slice(0, Math.min(48, normalizedOriginal.length));
  const roleCandidates = cache.entries.filter(entry => (
    (!entry.role || entry.role === expectedRole)
    && (!prefix || entry.normalized.includes(prefix))
  ));
  let fragments = 0;
  for (const entry of roleCandidates) {
    if (replaceOutboundMessageFragment(outbound, entry.index, originalText, '', backups)) fragments++;
  }
  if (fragments > 0) return 'body-fragment';

  // Last compatibility fallback for templates that rewrite roles. Keep it prefix-filtered so an
  // absent historical floor does not rescan every prompt item.
  const anyRoleCandidates = cache.entries.filter(entry => !prefix || entry.normalized.includes(prefix));
  for (const entry of anyRoleCandidates) {
    if (replaceOutboundMessageFragment(outbound, entry.index, originalText, '', backups)) fragments++;
  }
  return fragments > 0 ? 'body-fragment-any-role' : '';
}

function removeOutboundIndices(outbound, removals) {
  if (!Array.isArray(outbound) || !removals?.size) return 0;
  const indices = [...removals]
    .filter(index => Number.isInteger(index) && index >= 0 && index < outbound.length)
    .sort((a, b) => b - a);
  for (const index of indices) outbound.splice(index, 1);
  return indices.length;
}

function hiddenAssistantTurnText(row, godlog) {
  if (isGodlogReady(godlog, row)) {
    return `【剧情资料｜旧楼摘要｜第 ${row.index} 楼】\n${safePromptMemoryText('godlog', godlog, 1300)}`;
  }
  return `【剧情资料｜旧楼正文已隐藏｜第 ${row.index} 楼】\n这一楼已超过最近原文保留窗口，正文未发送给主模型；逐楼摘要尚未生成。请不要凭空补写这一楼细节。`;
}

function hiddenUserTurnText(assistantRow) {
  return `【剧情资料｜旧用户输入已隐藏】\n该输入已由第 ${assistantRow.index} 楼摘要覆盖，原文未发送给主模型。`;
}

function applyGodlogContextReplacement(outboundChat = [], options = {}) {
  const s = settings();
  const keepRecent = Math.max(1, Number(s.keepRecent) || 3);
  const emptyStats = {
    at: Date.now(), replaced: 0, covered: 0, hiddenBodies: 0, removedMessages: 0,
    fragmentHidden: 0, unmatched: 0, missing: 0, keepRecent, rawKept: 0,
    mode: options.mode || 'history-hide',
  };
  if (!s.enabled || !Array.isArray(outboundChat)) return emptyStats;

  const data = memoryData();
  refreshCoverageMaps(data);
  const contextChat = getContext().chat || [];
  const strictPlan = recentRawHistoryPlan(contextChat, keepRecent);
  if (strictPlan.hideIndices.length === 0) {
    const stats = { ...emptyStats, rawKept: strictPlan.keepAssistantIndices.length };
    if (options.save !== false) {
      data.processing.lastContextReplacement = stats;
      saveMemory();
    }
    return stats;
  }

  // Work only on message indices that can actually enter this request. Older builds scanned every
  // assistant floor and then repeatedly searched the outbound array, which became quadratic.
  const assistantRows = chatRows(true).filter(row => row.role === 'assistant');
  const assistantByIndex = new Map(assistantRows.map(row => [row.index, row]));
  const godlogs = godlogIndex(data);
  const coveredKeys = new Set([
    ...Object.keys(data.processing?.mergedKeys || {}),
    ...Object.keys(data.processing?.anchoredKeys || {}),
  ]);
  const usedOutbound = new Set();
  const backups = outboundChat === contextChat ? new Map() : null;
  const removals = new Set();
  const outboundSearchCache = buildOutboundSearchCache(outboundChat);
  const prune = options.prune !== false && outboundChat !== contextChat;
  const touchedAssistantKeys = new Set();
  const missingAssistantKeys = new Set();
  let covered = 0;
  let hiddenBodies = 0;
  let fragmentHidden = 0;
  let unmatched = 0;

  for (const contextIndex of strictPlan.hideIndices) {
    const contextMessage = contextChat[contextIndex];
    if (!contextMessage) continue;
    const row = assistantByIndex.get(contextIndex);
    const godlog = row ? godlogs.get(row.key) : null;
    if (row) {
      touchedAssistantKeys.add(row.key);
      if (!coveredKeys.has(row.key) && !isGodlogReady(godlog, row)) missingAssistantKeys.add(row.key);
    }

    let method = '';
    if (prune) {
      method = stripOutboundContextMessage(
        outboundChat,
        contextChat,
        contextIndex,
        usedOutbound,
        removals,
        backups,
        outboundSearchCache,
      );
    } else {
      const replacement = row
        ? hiddenAssistantTurnText(row, godlog)
        : '【剧情资料｜旧用户输入已隐藏】\n该输入已超过最近正文保留窗口，原文未发送给主模型。';
      method = hideOutboundContextMessage(
        outboundChat,
        contextChat,
        contextIndex,
        replacement,
        usedOutbound,
        backups,
      );
    }

    if (!method) {
      unmatched++;
      continue;
    }
    covered++;
    hiddenBodies++;
    if (method.includes('fragment')) fragmentHidden++;
  }

  const removedMessages = prune ? removeOutboundIndices(outboundChat, removals) : 0;
  restoreTemporaryContextReplacement(outboundChat, backups);
  const stats = {
    at: Date.now(),
    replaced: touchedAssistantKeys.size,
    covered,
    hiddenBodies,
    removedMessages,
    fragmentHidden,
    unmatched,
    missing: missingAssistantKeys.size,
    keepRecent,
    rawKept: strictPlan.keepAssistantIndices.length,
    mode: options.mode || 'history-hide',
  };
  if (options.save !== false) {
    data.processing.lastContextReplacement = stats;
    saveMemory();
  }
  return stats;
}

function restoreTemporaryContextReplacement(outbound, backups) {
  if (!Array.isArray(outbound) || !backups?.size) return;
  setTimeout(() => {
    for (const [index, original] of backups.entries()) {
      if (outbound[index]?.anchor_memory_context_replacement) outbound[index] = original;
    }
  }, 0);
}

async function createAnchorUnlocked(force = false, customMaterials = null, intervalOptions = {}) {
  if (!hasPersistentChatContext()) return false;
  const anchorIntervalAtStart = normalizeAnchorInterval(intervalOptions.anchorInterval ?? settings().anchorInterval);
  const mergeAnchorIntervalAtStart = normalizeMergeAnchorInterval(intervalOptions.mergeAnchorInterval ?? settings().mergeAnchorInterval);
  let data = memoryData();
  const contextToken = captureChatContextToken(data);
  const operationEpoch = state.contextEpoch;
  if (data.processing.busy || state.running) return false;
  if (!customMaterials) {
    await processGodlogBacklog(force ? anchorIntervalAtStart : Math.min(anchorIntervalAtStart, 8));
    if (!isSameChatContext(contextToken)) return false;
    data = memoryData();
  }
  const interval = anchorIntervalAtStart;
  const available = customMaterials || pendingAnchorMaterials(data);
  const materials = available.slice(0, interval);
  if (!force && materials.length < interval) return false;
  if (materials.length === 0) {
    if (force) toastr?.info?.('没有连续且已完成的未锚定摘要', 'Anchor Memory');
    return false;
  }
  if (!force && materials.some(item => item.mode !== 'raw-fallback' && !isGodlogReady(item.godlog, item.row))) return false;

  state.running = true;
  data.processing.busy = true;
  data.processing.lastError = '';
  saveMemory();
  showStatus(`正在生成锚点：${materials.length} 份逐楼摘要`);

  try {
    const number = data.processing.anchorCount + 1;
    const body = normalizeAnchorBody(await callWriter(buildAnchorPrompt(data, materials), 4200), number);
    if (!isSameChatContext(contextToken)) return false;
    if (!body || body.trim().length < 60) throw new Error('锚点内容为空或过短');
    const rows = materials.map(item => item.row);
    const sourceFloors = rows.map(row => row.index);
    const sourceKeys = rows.map(row => row.key);
    const sourceGodlogIds = materials.map(item => item.godlog?.id).filter(Boolean);
    const coveredRows = coveredRowsForAnchorRows(rows);
    const id = `am_anchor_${Date.now()}_${stableHash(body).slice(0, 6)}`;
    const anchor = {
      id,
      number,
      kind: 'anchor',
      body: body.trim(),
      sourceFloors,
      sourceKeys,
      sourceGodlogIds,
      rawFallbackKeys: materials.filter(item => item.mode === 'raw-fallback').map(item => item.row.key),
      intervalUsed: interval,
      batchSize: materials.length,
      coveredFloors: coveredRows.map(row => row.index),
      coveredKeys: coveredRows.map(row => row.key),
      createdAt: Date.now(),
    };
    data.anchors.push(anchor);
    renumberDerivedMemory(data);
    anchor.number = data.anchors.indexOf(anchor) + 1;
    data.processing.anchorCount = data.anchors.length;
    data.processing.lastAnchorFloor = Math.max(...sourceFloors);
    refreshCoverageMaps(data);
    saveMemory(true);
    try { await enforceAnchorHiddenState(data); } catch (err) { console.warn('[AnchorMemory] anchor hide reconciliation failed', err); }
    if (!isSameChatContext(contextToken)) return false;
    await maybeMerge(false, true, mergeAnchorIntervalAtStart);
    if (!isSameChatContext(contextToken)) return false;
    safeUpdatePreview('锚点完成后刷新');
    toastr?.success?.(`第 ${number} 次锚点完成`, 'Anchor Memory');
    return true;
  } catch (err) {
    if (!isSameChatContext(contextToken)) return false;
    data.processing.lastError = err.message;
    saveMemory();
    toastr?.error?.(`锚点失败：${err.message}`, 'Anchor Memory');
    return false;
  } finally {
    if (state.contextEpoch === operationEpoch) state.running = false;
    if (!isSameChatContext(contextToken)) return;
    data.processing.busy = false;
    saveMemory(true);
    showStatus(statusText(data));
  }
}



async function createAnchor(force = false, customMaterials = null, intervalOptions = {}) {
  if (!settings().enabled) {
    if (force) toastr?.info?.('锚点书当前已暂停，请先点击顶部“启动插件”。', 'Anchor Memory');
    return false;
  }
  if (state.anchorPreparing || state.mergeRunning) {
    if (force) toastr?.warning?.('已有锚点或累计历史任务正在运行，请勿重复点击', 'Anchor Memory');
    return false;
  }
  const operationEpoch = state.contextEpoch;
  state.anchorPreparing = true;
  try {
    return await createAnchorUnlocked(force, customMaterials, intervalOptions);
  } finally {
    if (state.contextEpoch === operationEpoch) state.anchorPreparing = false;
    flushDeferredIntervalRecheck();
  }
}


async function maybeMergeUnlocked(force = false, intervalOverride = null) {
  if (!hasPersistentChatContext()) return false;
  if (state.running && force) {
    toastr?.warning?.('锚点任务正在运行，稍后再合并', 'Anchor Memory');
    return false;
  }
  const data = memoryData();
  const contextToken = captureChatContextToken(data);
  const anchorThreshold = normalizeMergeAnchorInterval(intervalOverride ?? settings().mergeAnchorInterval);
  let sourceKeys = [];
  let blocks = [];
  let floorAt = data.processing.lastMergeFloor;
  let anchorCount = 0;

  if (!force) {
    const anchors = mergeCycleAnchors(data);
    if (anchors.length < anchorThreshold) return false;
    const selected = anchors.slice(0, anchorThreshold);
    anchorCount = selected.length;
    sourceKeys = [...new Set(selected.flatMap(anchor => anchor.sourceKeys || []))];
    blocks = selected.map((anchor, index) => ({ kind: 'anchor', item: anchor, order: index }));
    floorAt = Math.max(
      data.processing.lastMergeFloor ?? -1,
      ...selected.flatMap(anchor => anchor.sourceFloors || []).filter(Number.isFinite),
    );
  } else {
    // Manual/final archive merge is intentionally broader: it may absorb the last partial segment so
    // a transfer archive can end with one complete cumulative memory snapshot.
    const cycle = mergeCycleMaterials(data);
    if (cycle.length === 0) {
      toastr?.info?.('没有新的逐楼摘要可写入累计历史；如需改写旧内容，请使用“重写最近累计历史”或记忆库中的“重写选中内容”。', 'Anchor Memory');
      return false;
    }
    sourceKeys = cycle.map(item => item.row.key);
    const sourceKeySet = new Set(sourceKeys);
    const rowOrder = new Map(cycle.map((item, index) => [item.row.key, index]));
    const represented = new Set();
    for (const anchor of activeAnchorsAfterMerge(data)) {
      const keys = anchor.sourceKeys || [];
      if (!keys.length || !keys.every(key => sourceKeySet.has(key))) continue;
      keys.forEach(key => represented.add(key));
      blocks.push({
        kind: 'anchor',
        item: anchor,
        order: Math.min(...keys.map(key => rowOrder.get(key) ?? Number.MAX_SAFE_INTEGER)),
      });
    }
    for (const material of cycle) {
      if (represented.has(material.row.key)) continue;
      if (material.godlog && isGodlogReady(material.godlog, material.row)) {
        blocks.push({ kind: 'godlog', item: material.godlog, row: material.row, order: rowOrder.get(material.row.key) || 0 });
      } else {
        blocks.push({
          kind: 'raw-fallback',
          item: null,
          row: material.row,
          fallbackText: material.fallbackText || rawFallbackTextForRow(material.row, 8000),
          order: rowOrder.get(material.row.key) || 0,
        });
      }
    }
    blocks.sort((a, b) => a.order - b.order);
    anchorCount = blocks.filter(block => block.kind === 'anchor').length;
    floorAt = cycle[cycle.length - 1]?.row?.index ?? data.processing.lastMergeFloor;
  }

  if (sourceKeys.length === 0 || blocks.length === 0) return false;
  const plan = { sourceKeys, blocks, anchorCount };
  showStatus(force
    ? `正在整理最终累计历史：${sourceKeys.length} 个AI回合`
    : `正在更新累计历史：${anchorCount} 个分段锚点`);
  try {
    const mergeNumber = data.processing.mergeCount + 1;
    const body = normalizeMergeBody(await callWriter(buildMergePrompt(data, plan, force), 6200), mergeNumber);
    if (!isSameChatContext(contextToken)) return false;
    if (!body || body.trim().length < 120) throw new Error('合并内容为空或过短');

    const previous = latestMerge(data);
    const cumulativeKeys = [...new Set([...(previous?.sourceKeys || []), ...sourceKeys])];
    const number = mergeNumber;
    const id = `am_merge_${Date.now()}_${stableHash(body).slice(0, 6)}`;
    const merge = {
      id,
      number,
      kind: 'merge',
      body: body.trim(),
      sourceKeys: cumulativeKeys,
      cycleSourceKeys: sourceKeys,
      sourceAnchorIds: blocks.filter(block => block.kind === 'anchor').map(block => block.item.id),
      sourceGodlogIds: blocks.filter(block => block.kind === 'godlog' && block.item?.id).map(block => block.item.id),
      rawFallbackKeys: blocks.filter(block => block.kind === 'raw-fallback').map(block => block.row?.key).filter(Boolean),
      previousMergeId: previous?.id || '',
      mergeAnchorIntervalUsed: force ? anchorCount : anchorThreshold,
      intervalUsed: force ? sourceKeys.length : anchorThreshold,
      cycleAnchorCount: anchorCount,
      cycleSize: sourceKeys.length,
      coverageCount: cumulativeKeys.length,
      createdAt: Date.now(),
      floorAt,
    };

    for (const block of blocks) {
      if (block.kind === 'anchor' && block.item) block.item.compactedIntoMergeId = id;
    }
    data.merges.push(merge);
    renumberDerivedMemory(data);
    merge.number = data.merges.indexOf(merge) + 1;
    data.processing.mergeCount = data.merges.length;
    data.processing.lastMergeFloor = merge.floorAt;
    refreshCoverageMaps(data);
    saveMemory(true);
    try { await enforceAnchorHiddenState(data); } catch (err) { console.warn('[AnchorMemory] merge hide reconciliation failed', err); }
    if (!isSameChatContext(contextToken)) return false;
    safeUpdatePreview('累计历史更新后刷新');
    toastr?.success?.(
      force
        ? `第 ${number} 次最终累计历史完成（累计 ${cumulativeKeys.length} 个AI回合）`
        : `第 ${number} 次累计历史更新完成（本次 ${anchorCount} 个分段锚点，累计覆盖 ${cumulativeKeys.length} 个AI回合）`,
      'Anchor Memory',
    );
    return true;
  } catch (err) {
    if (!isSameChatContext(contextToken)) return false;
    data.processing.lastError = err.message;
    saveMemory();
    toastr?.error?.(`合并失败：${err.message}`, 'Anchor Memory');
    return false;
  } finally {
    if (isSameChatContext(contextToken)) showStatus(statusText(data));
  }
}

async function maybeMerge(force = false, allowDuringAnchor = false, intervalOverride = null) {
  if (!settings().enabled) {
    if (force) toastr?.info?.('锚点书当前已暂停，请先点击顶部“启动插件”。', 'Anchor Memory');
    return false;
  }
  if (state.mergeRunning || ((state.anchorPreparing || state.running) && !allowDuringAnchor)) {
    if (force) toastr?.warning?.('已有锚点或累计历史任务正在运行，请勿重复点击', 'Anchor Memory');
    return false;
  }
  const operationEpoch = state.contextEpoch;
  state.mergeRunning = true;
  const data = hasPersistentChatContext() ? memoryData() : null;
  const contextToken = data ? captureChatContextToken(data) : null;
  if (data?.processing) {
    data.processing.mergeBusy = true;
    saveMemory();
  }
  try {
    return await maybeMergeUnlocked(force, intervalOverride);
  } finally {
    if (state.contextEpoch === operationEpoch) state.mergeRunning = false;
    if (data?.processing && isSameChatContext(contextToken)) {
      data.processing.mergeBusy = false;
      saveMemory(true);
    }
    flushDeferredIntervalRecheck();
  }
}

async function batchInitializeHistory() {
  if (!settings().enabled) {
    toastr?.info?.('锚点书当前已暂停，请先点击顶部“启动插件”。', 'Anchor Memory');
    return;
  }
  const s = settings();
  const anchorInterval = normalizeAnchorInterval(s.anchorInterval);
  const mergeAnchorInterval = normalizeMergeAnchorInterval(s.mergeAnchorInterval);
  const data = memoryData();
  if (state.running || state.summaryRunning || data.processing.busy) {
    toastr?.warning?.('已有记忆任务正在运行', 'Anchor Memory');
    return;
  }
  const total = pendingGodlogRows(data).length;
  if (total === 0 && pendingAnchorMaterials(data).length === 0 && mergeCycleAnchors(data).length < mergeAnchorInterval) {
    toastr?.info?.('没有需要初始化的历史楼层', 'Anchor Memory');
    return;
  }
  if (!confirm(`将补写逐楼摘要，并严格按每 ${anchorInterval} 个AI回合生成分段锚点、每累计 ${mergeAnchorInterval} 个分段锚点生成一次累计历史。继续？`)) return;

  await processGodlogBacklog(Number.MAX_SAFE_INTEGER);
  let anchorsMade = 0;
  let mergesMade = 0;

  while (true) {
    const fresh = memoryData();
    if (mergeCycleAnchors(fresh).length >= mergeAnchorInterval) {
      if (!await maybeMerge(false, false, mergeAnchorInterval)) break;
      mergesMade++;
      continue;
    }
    if (pendingAnchorMaterials(fresh).length >= anchorInterval) {
      if (!await createAnchor(false, null, { anchorInterval, mergeAnchorInterval })) break;
      anchorsMade++;
      continue;
    }
    break;
  }

  updatePreview();
  toastr?.success?.(`历史初始化完成：新增 ${anchorsMade} 个分段锚点、${mergesMade} 个累计历史`, 'Anchor Memory');
}

function latestAssistantTailProbe() {
  const chat = getContext().chat || [];
  for (let index = chat.length - 1; index >= 0; index--) {
    const message = chat[index];
    if (!message || !isNarrativeMessage(message) || message.is_user || !message.mes) continue;
    const text = cleanText(message.mes);
    if (!text) continue;
    const turnText = turnTextForAssistant(chat, index);
    return {
      index,
      key: messageKey(message, index),
      role: 'assistant',
      name: message.name || '',
      text,
      turnText,
      rawHash: stableHash(turnText || text),
      sendDate: message.send_date || '',
      assistantNumber: 0,
    };
  }
  return null;
}

function latestAssistantRow() {
  const rows = chatRows(true);
  for (let index = rows.length - 1; index >= 0; index--) {
    if (rows[index].role === 'assistant') return rows[index];
  }
  return null;
}

function noteRowRevision(row, forceTimestamp = false) {
  if (!row?.key) return null;
  const previous = state.rowRevisionState.get(row.key);
  if (forceTimestamp || !previous || previous.hash !== row.rawHash) {
    // Any content revision invalidates a prior authoritative “finished” mark for this floor.
    // A later MESSAGE_RECEIVED / GENERATION_ENDED will mark the new hash final again.
    if (!previous || previous.hash !== row.rawHash) state.finalizedRowHashes.delete(row.key);
    const next = { hash: row.rawHash, changedAt: Date.now() };
    state.rowRevisionState.set(row.key, next);
    return next;
  }
  return previous;
}

function markRowFinalizedForGodlog(row) {
  if (!row?.key || !row?.rawHash) return false;
  state.finalizedRowHashes.set(row.key, row.rawHash);
  return true;
}

function rowHasAuthoritativeFinalHash(row) {
  return !!row?.key && !!row?.rawHash && state.finalizedRowHashes.get(row.key) === row.rawHash;
}

function observeLatestAssistantRow(forceTimestamp = false) {
  const row = latestAssistantRow();
  if (!row) {
    state.latestRowKey = '';
    state.latestRowHash = '';
    state.latestRowChangedAt = 0;
    return null;
  }
  const revision = noteRowRevision(row, forceTimestamp);
  if (forceTimestamp || state.latestRowKey !== row.key || state.latestRowHash !== row.rawHash) {
    state.latestRowKey = row.key;
    state.latestRowHash = row.rawHash;
    state.latestRowChangedAt = revision?.changedAt || Date.now();
  } else if (!state.latestRowChangedAt) {
    state.latestRowChangedAt = revision?.changedAt || Date.now();
  }
  return row;
}

function isLatestAssistantRow(row) {
  if (!row?.key) return false;
  const latest = latestAssistantRow();
  return !!latest && latest.key === row.key;
}

function generationIsActiveForGodlog(row = null) {
  const latestOnly = row ? isLatestAssistantRow(row) : true;
  if (!latestOnly) return false;
  if (isGenerationActive()) return true;
  // Lifecycle events are only a short fallback. A missed end event must never block the queue for
  // minutes, and background/quiet API streaming must not masquerade as the visible AI generation.
  if (state.generationLifecycleActive && Date.now() - state.generationStartedAt < 30 * 1000) return true;
  if (state.generationLifecycleActive) state.generationLifecycleActive = false;
  return false;
}

function rowSettleDelay(row) {
  if (!row) return 0;
  const latest = observeLatestAssistantRow(false);
  const isLatest = !!latest && latest.key === row.key;

  // GENERATION_ENDED / STOPPED is authoritative even if SillyTavern's lower-level generation flag
  // takes another event-loop tick to flip. onGenerationStarted clears this mark before a new run.
  if (rowHasAuthoritativeFinalHash(row)) return 0;
  if (isLatest && generationIsActiveForGodlog(row)) return GODLOG_SOURCE_SETTLE_MS;

  const revision = state.rowRevisionState.get(row.key);
  // Every row has its own revision clock. A newer visible generation must not keep an older edited
  // floor in “waiting for stability” forever.
  const changedAt = revision?.hash === row.rawHash ? revision.changedAt : 0;
  const now = Date.now();
  const sourceDelay = changedAt
    ? Math.max(0, GODLOG_SOURCE_SETTLE_MS - (now - changedAt))
    : 0;
  const generationDelay = isLatest && state.generationEndedAt
    ? Math.max(0, GODLOG_POST_GENERATION_SETTLE_MS - (now - state.generationEndedAt))
    : 0;
  return Math.max(sourceDelay, generationDelay);
}

function isRowSettledForGodlog(row) {
  if (!row) return true;
  return rowSettleDelay(row) <= 0 && !generationIsActiveForGodlog(row);
}

function settleTimerKey(row = null) {
  return row?.key ? `row:${row.key}` : 'latest';
}

function cancelSettleTimer(row = null) {
  const key = settleTimerKey(row);
  const timer = state.settleTimers.get(key);
  if (timer) clearTimeout(timer);
  state.settleTimers.delete(key);
}

function clearAllSettleTimers() {
  for (const timer of state.settleTimers.values()) clearTimeout(timer);
  state.settleTimers.clear();
  if (state.settleTimer) clearTimeout(state.settleTimer);
  state.settleTimer = null;
}

function rowByStableKey(key) {
  if (!key) return latestAssistantRow();
  return chatRows(true).find(row => row.role === 'assistant' && row.key === key) || null;
}

function scheduleMemoryAfterSettle(source = '等待当前楼正文稳定', row = null, forceSummaryRerun = false) {
  if (!settings().enabled) return;
  const target = row || latestAssistantRow();
  const targetKey = target?.key || '';
  const forced = !!forceSummaryRerun || (!!targetKey && state.forcedSummaryReruns.has(targetKey));
  const timerKey = settleTimerKey(target);
  cancelSettleTimer(target);
  // IMPORTANT: a settled row legitimately returns 0. Do not use `|| GODLOG_SOURCE_SETTLE_MS` here:
  // that converted the valid zero into another 1800ms wait and made completed generations feel laggy.
  const measuredDelay = target ? rowSettleDelay(target) : GODLOG_SOURCE_SETTLE_MS;
  const delay = Math.max(0, Number(measuredDelay) || 0);
  const timer = setTimeout(() => {
    state.settleTimers.delete(timerKey);
    const current = rowByStableKey(targetKey);
    if (targetKey && !current) {
      state.forcedSummaryReruns.delete(targetKey);
      queueMemoryJob(`${source}（源楼已删除）`, 0);
      return;
    }
    const observed = current || latestAssistantRow();
    if (observed && !isRowSettledForGodlog(observed)) {
      scheduleMemoryAfterSettle(source, observed, forced);
      return;
    }
    if (forced && observed) {
      state.forcedSummaryReruns.delete(observed.key);
      if (isSummaryRowBusy(observed)) {
        state.forcedSummaryReruns.add(observed.key);
        scheduleMemoryAfterSettle(`${source}（等待现有摘要任务结束）`, observed, true);
        return;
      }
      generateGodlogForRow(observed, true).catch(err => console.warn('[AnchorMemory] queued manual summary rerun failed', err));
      return;
    }
    queueMemoryJob(source, 0);
  }, Math.max(GODLOG_FINAL_EVENT_GRACE_MS, delay + 20));
  state.settleTimers.set(timerKey, timer);
}

async function reconcileStrictRecentWindow(source = '发送前同步最近正文窗口') {
  if (!settings().enabled || !hasPersistentChatContext()) return false;
  try {
    const changed = await enforceAnchorHiddenState(memoryData());
    if (changed) {
      const plan = recentRawHistoryPlan();
      console.info(`[AnchorMemory] ${source}: 仅保留最近 ${plan.keepRecent} 个AI正文，隐藏旧消息 ${plan.hideIndices.length} 条`);
    }
    return changed;
  } catch (err) {
    console.warn('[AnchorMemory] strict recent-window reconciliation failed', err);
    return false;
  }
}

function onUserMessageRendered() {
  if (!settings().enabled) return;
  const chat = getContext().chat || [];
  beginDynamicRecallCycle(chat, '用户消息写入后');
  prepareDynamicRecall(chat).catch(err => console.warn('[AnchorMemory] recall prefetch failed', err));
  // This event proves the previous AI floor is no longer streaming. It is an additional Horae-style
  // completion signal, while GENERATION_ENDED/STOPPED and source-hash settling remain authoritative.
  const previousAssistant = observeLatestAssistantRow(false);
  if (previousAssistant) scheduleMemoryAfterSettle('用户已发送下一条消息，处理上一AI楼', previousAssistant);
  reconcileStrictRecentWindow('用户消息写入后').catch(console.warn);
}

function onGenerationAfterCommands() {
  if (!settings().enabled) return;
  // Run before SillyTavern assembles the final prompt so hidden flags affect every backend, not only
  // Chat Completion payloads that emit CHAT_COMPLETION_PROMPT_READY.
  const chat = getContext().chat || [];
  beginDynamicRecallCycle(chat, '正式构造请求前');
  prepareDynamicRecall(chat).catch(err => console.warn('[AnchorMemory] recall prefetch failed before prompt assembly', err));
  reconcileStrictRecentWindow('正式构造请求前').catch(console.warn);
}

function onGenerationStarted() {
  if (!settings().enabled) return;
  state.generationLifecycleActive = true;
  state.generationStartedAt = Date.now();
  // The latest floor may be about to be regenerated/swiped. Its old finalized hash must not grant
  // the new generation an immediate-summary bypass before the new body is committed.
  const latest = observeLatestAssistantRow(true);
  if (latest?.key) state.finalizedRowHashes.delete(latest.key);
  // Do not cancel timers belonging to older edited floors. Their summaries are independent from
  // the newly starting visible generation.
}

function onGenerationFinished(source = '生成结束') {
  if (!settings().enabled) return;
  state.generationLifecycleActive = false;
  state.generationEndedAt = Date.now();
  if (state.streamProbeTimer) clearTimeout(state.streamProbeTimer);
  state.streamProbeTimer = null;
  invalidateRuntimeCaches('generation finished');
  const row = observeLatestAssistantRow(true);
  // SillyTavern has explicitly told us visible generation is over. Mark this exact body hash final,
  // then start the summary after only a tiny commit grace instead of the generic 1800ms source debounce.
  markRowFinalizedForGodlog(row);
  scheduleMemoryAfterSettle(source, row);
  scheduleGodlogPanelRender();
}

async function drainDueDerivedMemory(anchorInterval, mergeAnchorInterval, maxPasses = 12) {
  let anchorsMade = 0;
  let mergesMade = 0;
  for (let pass = 0; pass < Math.max(1, Number(maxPasses) || 12); pass++) {
    const fresh = memoryData();
    if (mergeCycleAnchors(fresh).length >= mergeAnchorInterval) {
      if (!await maybeMerge(false, false, mergeAnchorInterval)) break;
      mergesMade++;
      continue;
    }
    if (pendingAnchorMaterials(fresh).length >= anchorInterval) {
      if (!await createAnchor(false, null, { anchorInterval, mergeAnchorInterval })) break;
      anchorsMade++;
      continue;
    }
    break;
  }
  return { anchorsMade, mergesMade };
}

async function runMemoryJobQueue() {
  if (!settings().enabled || !hasPersistentChatContext()) return false;
  if (state.jobRunning || state.archiveRunning) return false;
  const data = memoryData();
  const contextToken = captureChatContextToken(data);
  const operationEpoch = state.contextEpoch;
  state.jobRunning = true;
  data.processing.queueRunning = true;
  data.processing.queuePending = false;
  saveMemory();

  try {
    do {
      if (!isSameChatContext(contextToken)) return false;
      const sources = [...state.jobSources];
      state.jobSources.clear();
      data.processing.queueSources = sources;
      data.processing.queuePending = false;
      saveMemory();
      const intervalRecheck = sources.some(source => String(source).includes('运行间隔调整'));

      const pendingRowsNow = pendingGodlogRows(data);
      const hasSettledHistoricalWork = pendingRowsNow.some(row => isRowSettledForGodlog(row));
      if (generationIsActiveForGodlog(latestAssistantRow()) && !hasSettledHistoricalWork) {
        scheduleMemoryAfterSettle(intervalRecheck ? '运行间隔调整后重新检查' : '发送完成后处理');
        break;
      }

      syncGodlogsWithChat(sources.join(' / ') || '队列同步');
      const anchorInterval = normalizeAnchorInterval(settings().anchorInterval);
      const mergeAnchorInterval = normalizeMergeAnchorInterval(settings().mergeAnchorInterval);
      await createAnchor(false, null, { anchorInterval, mergeAnchorInterval });
      if (!isSameChatContext(contextToken)) return false;
      // Always drain every already-due boundary, not only after a settings edit. This fixes old
      // chats that had enough ready material for a second/third cumulative merge but only produced
      // one boundary per later user action.
      await drainDueDerivedMemory(anchorInterval, mergeAnchorInterval, intervalRecheck ? 12 : 6);
    } while (state.jobSources.size > 0 && isSameChatContext(contextToken));
    return true;
  } catch (err) {
    if (!isSameChatContext(contextToken)) return false;
    data.processing.lastError = err.message || String(err);
    saveMemory();
    console.warn('[AnchorMemory] queued job failed', err);
    return false;
  } finally {
    if (state.contextEpoch === operationEpoch) state.jobRunning = false;
    if (!isSameChatContext(contextToken)) return;
    data.processing.queueRunning = false;
    data.processing.queuePending = state.jobSources.size > 0;
    saveMemory(true);
    updatePreview();
    if (state.jobSources.size > 0) queueMemoryJob('队列续跑');
    flushDeferredIntervalRecheck();
  }
}

function queueMemoryJob(source = '消息已变动', delay = 900) {
  if (!settings().enabled || !hasPersistentChatContext()) return;
  if (!hasPendingMemoryWork()) return;
  state.jobSources.add(source);
  const data = memoryData();
  data.processing.queuePending = true;
  data.processing.queueSources = [...state.jobSources];
  saveMemory();
  if (state.jobTimer) clearTimeout(state.jobTimer);
  state.jobTimer = setTimeout(() => {
    state.jobTimer = null;
    runMemoryJobQueue();
  }, delay);
}

function scheduleAnchorCheck() {
  if (!settings().enabled) return;
  // Render events can fire repeatedly while a floor is still streaming or while inline image
  // metadata is being appended. Record the newest fingerprint now, revoke an already-outdated
  // summary immediately, then wait for the source to settle before requesting a replacement.
  const latest = observeLatestAssistantRow(false);
  if (latest) {
    const data = memoryData();
    const item = godlogForRow(data, latest);
    if (item?.rawHash && item.rawHash !== latest.rawHash) {
      syncGodlogsWithChat('当前楼正文仍在更新');
      scheduleGodlogPanelRender(latest.index);
    }
  }
  if (state.queueTimer) clearTimeout(state.queueTimer);
  state.queueTimer = setTimeout(() => {
    state.queueTimer = null;
    if (!hasPendingMemoryWork()) return;
    if (latest && !isRowSettledForGodlog(latest)) {
      scheduleMemoryAfterSettle('新AI楼正文稳定后处理', latest);
      return;
    }
    queueMemoryJob('新AI消息');
  }, 120);
}

function registerEventHandlers(names, handler, mode = 'on') {
  if (!eventSource || typeof eventSource.on !== 'function') {
    console.warn('[AnchorMemory] event bus is not ready; event handlers were not registered yet.');
    return;
  }
  const seen = new Set();
  for (const name of names) {
    const type = event_types?.[name];
    if (!type || seen.has(type)) continue;
    seen.add(type);
    if (mode === 'makeLast' && typeof eventSource.makeLast === 'function') {
      eventSource.makeLast(type, handler);
    } else {
      eventSource.on(type, handler);
    }
  }
}

function statusText(data = memoryData()) {
  const s = settings();
  const name = currentCharacterName();
  if (!s.enabled) return `${name}：锚点书已暂停；已有记忆与设置仍保留。`;

  const assistantRows = chatRows(true).filter(row => row.role === 'assistant');
  const currentAiTurn = assistantRows.length;
  const pendingSummaries = pendingGodlogRows(data).length;
  const continuousReady = pendingAnchorMaterials(data).length;
  const anchorInterval = normalizeAnchorInterval(s.anchorInterval);
  const mergeAnchorInterval = normalizeMergeAnchorInterval(s.mergeAnchorInterval);
  const coveredKeys = new Set([
    ...Object.keys(data.processing?.mergedKeys || {}),
    ...Object.keys(data.processing?.anchoredKeys || {}),
  ]);
  const nextAnchorAt = coveredKeys.size + anchorInterval;
  const anchorRemaining = Math.max(0, nextAnchorAt - currentAiTurn);
  const mergeReady = mergeCycleAnchors(data).length >= mergeAnchorInterval;

  if (!secondaryConfigured(s)) return `${name}：先填写副API；之后会自动生成逐楼摘要、分段锚点和累计历史。`;
  if (data.processing?.queueRunning || state.summaryRunning || state.running || state.mergeRunning) {
    return `${name}：正在整理记忆；完成后会自动继续下一步。`;
  }
  if (pendingSummaries > 0) return `${name}：还有 ${pendingSummaries} 楼等待生成摘要；补齐后会自动继续锚定。`;
  if (mergeReady) return `${name}：分段锚点已达到合并条件，等待写入累计历史。`;
  if (continuousReady >= anchorInterval || anchorRemaining === 0) return `${name}：已到锚点边界，等待生成下一个分段锚点。`;
  return `${name}：运行正常；还有 ${anchorRemaining} 个AI回复生成下一个分段锚点。`;
}

function currentVectorCount(data = memoryData()) {
  const validIds = new Set(recallCorpus(data).map(source => source?.item?.id).filter(Boolean));
  const refs = Object.entries(data.vectorRefs || {}).filter(([id]) => validIds.has(id));
  const legacy = Object.entries(data.vectors || {}).filter(([id]) => validIds.has(id));
  if (!embeddingConfigured()) return refs.length || legacy.length;
  const signature = embeddingSignature();
  return refs.filter(([, record]) => record.signature === signature).length
    || legacy.filter(([, record]) => record.signature === signature).length;
}

function estimateTokens(text) {
  return estimateTextTokens(text);
}

function estimateMemoryTokens(data = memoryData()) {
  const injection = state.lastPromptInjection || buildCoreInjection(data);
  return estimateTokens(injection);
}

function updatePreview() {
  const data = memoryData();
  showStatus(statusText(data));
  const lastError = String(data.processing?.lastError || '').trim();
  $('#am_last_error_card')
    .text(lastError ? `最近一次后台错误：${lastError}` : '')
    .toggle(!!lastError);
  // The workbench contains several full lists, Markdown-table parsers and health scans. Rebuilding
  // all of them while the drawer is closed wastes the main thread after every message/job.
  if (!$('#anchor_memory_workbench').hasClass('open')) {
    scheduleGodlogPanelRender();
    try {
      maybeWarnMissingGodlogs(data);
    } catch (err) {
      console.warn('[AnchorMemory] missing Godlog warning failed', err);
    }
    return;
  }
  const merge = latestMerge(data);
  const anchor = latestAnchor(data);
  const readyGodlogs = (data.godlogs || []).filter(item => item.status === 'ready').length;
  const failedGodlogs = (data.godlogs || []).filter(item => ['failed', 'stale', 'orphaned'].includes(item.status)).length;
  $('#am_stat_anchors').text(activeAnchorsAfterMerge(data).length);
  $('#am_stat_merges').text(activeMerges(data).length);
  $('#am_stat_godlogs').text(readyGodlogs);
  $('#am_stat_pending_summaries').text(pendingGodlogRows(data).length);
  $('#am_stat_pending').text(pendingAnchorMaterials(data).length);
  $('#am_stat_godlog_issues').text(failedGodlogs);
  $('#am_stat_vectors').text(currentVectorCount(data));
  $('#am_stat_tokens').text(estimateMemoryTokens(data));
  const replacement = data.processing.lastContextReplacement;
  $('#am_context_window').text(replacement
    ? (replacement.mode === 'prompt-ready-history-hide'
      ? `最终请求：保留最近 ${replacement.rawKept || replacement.keepRecent || settings().keepRecent} 个AI回合原文；移除旧正文 ${replacement.hiddenBodies || replacement.covered || 0} 条；注入记忆 ${replacement.injectedTokens || estimateTokens(state.lastPromptInjection || '')} Token（预算 ${replacement.memoryBudgetTokens || state.lastMemoryBudget?.budgetTokens || settings().memoryMaxTokens}，${replacement.injectedChars || 0} 字符）/ ${replacement.injectedItems || 0} 个来源；缺摘要 ${replacement.missing || 0} 楼（只注入受限保底原文，不回退整段旧聊天）`
      : replacement.mode === 'prompt-ready'
        ? `生成前注入记忆 ${replacement.injectedTokens || estimateTokens(state.lastPromptInjection || '')} Token（预算 ${replacement.memoryBudgetTokens || state.lastMemoryBudget?.budgetTokens || settings().memoryMaxTokens}，${replacement.injectedChars || 0} 字符）/ ${replacement.injectedItems || 0} 个来源 / 缺摘要 ${replacement.missing || 0} 楼`
        : replacement.mode === 'history-hide'
          ? `请求裁剪：保留最近 ${replacement.rawKept || replacement.keepRecent || settings().keepRecent} 个AI回合原文；移除旧正文 ${replacement.hiddenBodies || replacement.covered || 0} 条；缺摘要 ${replacement.missing || 0} 楼`
        : replacement.mode === 'history-compress'
          ? `保留最近 ${replacement.rawKept || replacement.keepRecent || settings().keepRecent} 楼AI原文 / 已隐藏旧回合 ${replacement.replaced || 0} 个 / 旧回合缺摘要 ${replacement.missing || 0} 个`
        : `静态提示注入 / 待摘要 ${replacement.missing || 0} 楼`)
    : `保留最近 ${settings().keepRecent} 楼AI原文 / 等待下次生成时统计`);
  $('#am_current_time').text(renderMacros(data.codex.currentTime || '未明'));
  $('#am_current_place').text(renderMacros(data.codex.currentPlace || '未明'));
  const timelineWarnings = data.timeline?.warnings || [];
  $('#am_timeline_health').text(timelineWarnings.length
    ? `检测到 ${timelineWarnings.length} 条时间连续性提示：${timelineWarnings[timelineWarnings.length - 1]?.message || '请核对最近摘要。'} 当前现实时间仍保持为“${data.codex.currentTime || '未明'}”。`
    : '时间连续性正常：回忆、梦境和转述不会覆盖当前现实时间；手动修正后，后续楼层从修正基线继续推进。')
    .toggleClass('am-warning-text', timelineWarnings.length > 0);
  const autoTracked = automaticTrackedCharacterNames();
  const effectiveTracked = trackedCharacterNames(data);
  $('#am_tracked_characters').val((data.trackedCharacters || []).join('\n'));
  $('#am_tracked_characters_status').text((data.trackedCharacters || []).length
    ? `当前使用手动名单：${effectiveTracked.join('、')}`
    : `当前自动识别：${autoTracked.join('、') || '未识别到角色，请手动填写'}`);
  $('#am_character_memo_title').text(`角色成长纪要（只追踪 ${effectiveTracked.join('、') || renderMacros('{{char}}')}）`);
  const codexStatus = data.processing?.codexDirty
    ? (codexSnapshotSafeForInjection(data)
      ? `索引待重建：主模型继续使用截至最近有效摘要的安全快照，最新等待生成摘要的楼层暂未计入。${data.processing.codexDirtyReason ? ` 原因：${data.processing.codexDirtyReason}` : ''}`
      : `索引待重建：旧数据已保留，但当前无法确认其时间线安全，重建成功前不会注入人物动态/人物库/物品表。${data.processing.codexDirtyReason ? ` 原因：${data.processing.codexDirtyReason}` : ''}`)
    : `索引已持久化${data.processing?.codexLastGoodAt ? `，最近更新：${new Date(data.processing.codexLastGoodAt).toLocaleString()}` : ''}`;
  $('#am_codex_status').text(codexStatus)
    .toggleClass('am-warning-text', !!data.processing?.codexDirty);
  $('#am_restore_codex_backup').prop('disabled', !data.codexBackup?.codex
    || (!codexHasContent(data.codexBackup.codex) && !relationshipHasContent(data.codexBackup.relationshipTable)));
  $('#am_current_time_edit').val(data.codex.currentTime || '');
  $('#am_current_place_edit').val(data.codex.currentPlace || '');
  $('#am_core_preview').val('正在生成六段记忆拼接预览……');
  const previewContextToken = captureChatContextToken(data);
  // Workbench preview must be side-effect free. It may run while the main model is already
  // generating, so it must never overwrite the recall record that was actually injected.
  buildPromptReadyInjection(getContext().chat || [], { commit: false }).then(content => {
    if (isSameChatContext(previewContextToken) && $('#anchor_memory_workbench').hasClass('open')) {
      $('#am_core_preview').val(content || '暂无可注入记忆。');
      $('#am_stat_tokens').text(estimateMemoryTokens(data));
    }
  }).catch(err => {
    if (isSameChatContext(previewContextToken)) $('#am_core_preview').val(`拼接预览失败：${err.message || err}`);
  });
  const selectedRecall = state.selectedRecallMessageKey ? data.messageRecalls?.[state.selectedRecallMessageKey] : null;
  if (selectedRecall) {
    $('#am_recall_preview_title').text('历史楼层生成前注入记录（不是当前动态召回）');
    $('#am_recall_preview_note').show();
    $('#am_clear_recall_selection').show();
    $('#am_recall_preview').val(formatMessageRecallDetail(selectedRecall, data));
  } else {
    $('#am_recall_preview_title').text(settings().useDynamicRecall
      ? '第六段：未锚定摘要 + 可选旧楼召回（本轮实际注入）'
      : '第六段：未锚定摘要（动态召回已关闭）');
    $('#am_recall_preview_note').hide();
    $('#am_clear_recall_selection').hide();
    const lifecycle = state.lastRecallQuery ? `【召回状态】${recallStageText(state.lastRecallQuery)}\n\n` : '';
    $('#am_recall_preview').val(`${lifecycle}${[state.lastRecentFacts, state.lastRecall].filter(Boolean).join('\n\n')}`
      || (settings().useDynamicRecall ? '当前没有可补充内容。' : '当前没有未锚定摘要；额外旧楼动态召回已关闭。'));
  }
  $('#am_character_memo_edit').val(data.codex.characterMemo || '');
  $('#am_people_edit').val(data.codex.peopleIndex || '');
  $('#am_items_edit').val(data.codex.itemIndex || '');
  $('#am_scenes_edit').val(data.codex.sceneIndex || '');
  $('#am_timeline_detail').val(anchor?.body || merge?.body || '暂无锚点。');
  renderGodlogList();
  renderTimelineList();
  renderTableCards('#am_character_cards', data.codex.characterMemo, '暂无角色成长纪要。', ['角色名']);
  renderTableCards('#am_people_cards', data.codex.peopleIndex, '暂无出场人物库。', ['角色名']);
  renderTableCards('#am_item_cards', data.codex.itemIndex, '暂无重要道具、内部梗与核心细节。', ['物品/细节/内部梗', '物品']);
  renderTableCards('#am_scene_cards', data.codex.sceneIndex, '暂无场景记录。', ['场景/地点', '场景']);
  renderRelationshipEditor(data);
  $('[data-am-macro-template]').each(function () {
    const template = String($(this).attr('data-am-macro-template') || '');
    if (template) $(this).text(renderMacros(template));
  });
  renderArchiveCards();
  renderHealth();
  renderRecallHits();
  renderGodlogPanels();
  try {
    maybeWarnMissingGodlogs(data);
  } catch (err) {
    console.warn('[AnchorMemory] missing Godlog warning failed', err);
  }
}

function safeUpdatePreview(reason = '刷新面板') {
  try {
    updatePreview();
    return true;
  } catch (err) {
    console.error(`[AnchorMemory] ${reason} failed`, err);
    showStatus(`Anchor Memory 面板刷新失败：${err.message || err}`);
    toastr?.error?.(`面板刷新失败：${err.message || err}`, 'Anchor Memory');
    return false;
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function parseMarkdownTable(markdown) {
  const lines = String(markdown || '').split('\n').map(line => line.trim()).filter(Boolean);
  const tableLines = lines.filter(line => line.startsWith('|') && line.endsWith('|'));
  if (tableLines.length < 3) return [];
  const headers = tableLines[0].split('|').slice(1, -1).map(cell => cell.trim());
  return tableLines.slice(2).map(line => {
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
    if (cells.every(cell => !cell)) return null;
    const row = {};
    headers.forEach((header, index) => { row[header] = cells[index] || ''; });
    return row;
  }).filter(Boolean);
}

function renderTableCards(containerSelector, markdown, emptyText, titleKeys = []) {
  const container = $(containerSelector);
  if (!container.length) return;
  const rows = parseMarkdownTable(markdown);
  container.empty();
  if (rows.length === 0) {
    container.append(`<div class="am-card"><div class="am-card-body">${escapeHtml(emptyText)}</div></div>`);
    return;
  }
  for (const row of rows) {
    const entries = Object.entries(row);
    const titleEntry = entries.find(([key]) => titleKeys.includes(key)) || entries[0];
    const title = renderMacros(titleEntry?.[1] || titleEntry?.[0] || '未命名');
    const body = entries
      .filter(([key]) => key !== titleEntry?.[0])
      .map(([key, value]) => `<div><span class="am-pill">${escapeHtml(renderMacros(key))}</span> ${escapeHtml(renderMacros(value || '未记录'))}</div>`)
      .join('');
    container.append(`
      <div class="am-card">
        <div class="am-card-title"><span>${escapeHtml(title)}</span></div>
        <div class="am-card-body">${body}</div>
      </div>
    `);
  }
}

function godlogStatusLabel(status, item = null) {
  if (status === 'archived') return '归档';
  if (item?.rerunQueued) return '已排队重跑';
  if (item?.retryScheduledAt && item.retryScheduledAt > Date.now()) return '自动重试中';
  if (status === 'ready') {
    if (item?.key && isSummaryRowBusy(item.key)) return '重跑中';
    return item?.sourceMismatch || item?.rerunError ? '已保存' : '已完成';
  }
  if (status === 'missing') return '待自动补写';
  if (status === 'failed') return '待补写';
  if (status === 'stale') return '待刷新';
  if (status === 'orphaned') return '孤儿';
  if (status === 'pending') {
    if (item?.key && isSummaryRowBusy(item.key)) return '生成中';
    if (item?.sourceLookupDeferredAt) return '等待确认';
    return '待生成';
  }
  return '待处理';
}

function renderGodlogList() {
  const data = memoryData();
  const query = ($('#am_godlog_search').val() || '').trim().toLowerCase();
  const container = $('#am_godlog_list');
  if (!container.length) return;
  const entries = godlogListEntries(data)
    .sort((a, b) => (a.item.floor ?? 0) - (b.item.floor ?? 0))
    .filter(({ item }) => {
      const haystack = `${item.floor} ${item.name} ${item.status} ${item.body} ${item.error}`.toLowerCase();
      return !query || haystack.includes(query);
    });

  container.empty();
  if (entries.length === 0) {
    state.godlogPage = 0;
    container.append('<div class="am-card"><div class="am-card-body">暂无逐楼摘要。配置副API后，聊天落地会自动补写。</div></div>');
    return;
  }

  const pageSize = Math.max(20, Number(state.godlogPageSize) || 80);
  const pageCount = Math.max(1, Math.ceil(entries.length / pageSize));
  state.godlogPage = Math.min(Math.max(0, Number(state.godlogPage) || 0), pageCount - 1);
  const pageEntries = entries.slice(state.godlogPage * pageSize, (state.godlogPage + 1) * pageSize);
  container.append(`
    <div class="am-card am-godlog-pager">
      <div class="am-card-actions">
        <button class="am-godlog-prev" type="button" ${state.godlogPage <= 0 ? 'disabled' : ''}>上一页</button>
        <span>第 ${state.godlogPage + 1}/${pageCount} 页 · 共 ${entries.length} 条 · 每页 ${pageSize} 条</span>
        <button class="am-godlog-next" type="button" ${state.godlogPage >= pageCount - 1 ? 'disabled' : ''}>下一页</button>
      </div>
    </div>
  `);

  for (const { item, synthetic } of pageEntries) {
    const displayText = item.body ? plainGodlogText(item.body) : (item.error || '等待生成。');
    const excerpt = displayText.slice(0, 260);
    const status = item.archived ? 'archived' : (item.status === 'failed' ? 'failed' : (item.stale ? 'stale' : (item.status || 'pending')));
    const actions = item.archived
      ? ''
      : `<div class="am-card-actions"><button class="am-rerun-godlog" data-godlog-id="${escapeHtml(item.id)}" ${isSummaryRowBusy(item.key) || item.rerunQueued ? 'disabled' : ''}>${isSummaryRowBusy(item.key) ? '正在重跑…' : (item.rerunQueued ? '已排队重跑' : '重跑本楼摘要')}</button></div>`;
    container.append(`
      <div class="am-card am-godlog-card am-status-${escapeHtml(status)}${synthetic ? ' am-godlog-missing' : ''}" data-godlog-id="${escapeHtml(item.id)}">
        <div class="am-card-title">
          <span>第 ${escapeHtml(item.floor ?? 0)} 楼 · ${escapeHtml(item.name || '未知')}</span>
          <span class="am-pill">${escapeHtml(godlogStatusLabel(status, item))}</span>
        </div>
        <div class="am-card-meta">Nub ${escapeHtml(item.number || '')} · ${item.updatedAt ? new Date(item.updatedAt).toLocaleString() : '未生成'}</div>
        <div class="am-card-body">${escapeHtml(excerpt)}${displayText.length > excerpt.length ? '...' : ''}</div>
        ${actions}
      </div>
    `);
  }
}

function godlogFieldValue(body, tag) {
  const block = normalizeGodlogBlock(body);
  const match = block.match(new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, 'i'));
  if (!match) return '';
  return match[0].replace(new RegExp(`^<${tag}>|<\\/${tag}>$`, 'gi'), '').trim();
}

function messageGodlogSummary(item, row) {
  if (!item) {
    if (generationIsActiveForGodlog(row)) return '正文生成中 · 摘要尚未开始';
    if (!isRowSettledForGodlog(row)) return '正文已结束 · 等待稳定后摘要';
    return missingGodlogUiStatus(row) === 'pending' ? '等待自动生成逐楼摘要' : '待自动补写逐楼摘要';
  }
  if (item.rerunQueued) return '已排队手动重跑 · 等待正文稳定';
  if (item.retryScheduledAt && item.retryScheduledAt > Date.now()) {
    const attempt = Math.max(item.rerunRetryCount || 0, item.retryCount || 0, 1);
    return `第 ${attempt} 次失败 · 已安排自动重试`;
  }
  if (item.key && isSummaryRowBusy(item.key)) return item.rerunPending ? '正在重跑逐楼摘要' : '正在生成逐楼摘要';
  if (item.status === 'failed') return item.error || '摘要生成失败，等待补写';
  if (item.status === 'stale') return item.error || '楼层内容已更新，等待自动刷新摘要';
  if (item.status === 'pending' && item.body) return item.error || '正在刷新摘要，旧摘要暂时保留';
  if (item.status === 'ready') {
    return godlogFieldValue(item.body, 'Title')
      || godlogFieldValue(item.body, 'Cond').slice(0, 80)
      || `第 ${row.index} 楼摘要已完成`;
  }
  return item.error || '等待自动生成逐楼摘要';
}

function messageGodlogBody(item, row) {
  if (!item) return missingGodlogUiText(row);
  if (item.body) {
    const notices = [];
    if (item.status === 'stale' || item.stale) {
      notices.push('【旧摘要暂存；当前楼稳定后将自动更新】');
    } else {
      if (item.rerunQueued) {
        notices.push('【手动重跑已排队；正文稳定后会自动开始，旧摘要继续生效。】');
      } else if (item.retryScheduledAt && item.retryScheduledAt > Date.now()) {
        notices.push('【本次重跑失败，已安排自动重试；旧摘要继续生效。】');
      } else if (item.rerunPending || (item.key && isSummaryRowBusy(item.key))) {
        notices.push('【正在手动重跑；旧摘要继续生效，只有新摘要成功后才会替换。】');
      }
      if (item.rerunError) {
        notices.push(`【上次手动重跑失败：${item.rerunError}；旧摘要仍然保留。】`);
      }
      if (item.sourceMismatch) {
        notices.push('【摘要已保存并锁定；该楼后来发生了注入、渲染或正文变化，插件不会自动重跑。如需按当前正文更新，请手动点“重跑本楼摘要”。】');
      }
    }
    const prefix = notices.length > 0 ? `${notices.join('\n')}\n` : '';
    return `${prefix}${plainGodlogText(item.body)}`;
  }
  if (item.rerunQueued) return item.error || '正文仍在生成或尚未稳定；手动重跑已排队，稳定后会自动执行。';
  if (item.retryScheduledAt && item.retryScheduledAt > Date.now()) return item.error || '摘要请求失败，已安排自动重试。';
  if (item.key && isSummaryRowBusy(item.key)) return item.rerunPending ? '正在手动重跑逐楼摘要；旧摘要在成功前继续生效。' : '逐楼摘要请求已经发出，正在等待模型返回。';
  if (item.status === 'pending') return item.error || '等待后台自动生成逐楼摘要。';
  return item.error || '等待生成。';
}

function sanitizeLeakedGodlogDom(messageEl) {
  const mesText = messageEl?.querySelector?.('.mes_text');
  if (!mesText) return false;
  let changed = false;

  mesText.querySelectorAll('godlog').forEach(element => {
    element.remove();
    changed = true;
  });

  mesText.querySelectorAll('pre, code, details, .code-block, .mes_code, .markdown-code-block').forEach(element => {
    const text = element.textContent || '';
    const attrText = Array.from(element.attributes || []).map(attr => attr.value).join('\n');
    if (!looksLikeGodlogLeakText(`${text}\n${attrText}`)) return;
    const removable = element.closest('details, pre, .code-block, .mes_code, .markdown-code-block') || element;
    removable.remove();
    changed = true;
  });

  const walker = document.createTreeWalker(mesText, NodeFilter.SHOW_TEXT, null, false);
  const nodes = [];
  let node;
  while ((node = walker.nextNode())) nodes.push(node);
  for (const textNode of nodes) {
    const next = stripGodlogBlocks(textNode.textContent || '');
    if (next === textNode.textContent) continue;
    textNode.textContent = next;
    changed = true;
  }
  if (changed) mesText.normalize();
  return changed;
}

function memoryRefLabel(ref, data = memoryData()) {
  const source = ref?.id
    ? [...(data.godlogs || []), ...(data.anchors || []), ...(data.merges || [])].find(item => item.id === ref.id)
    : null;
  const kind = ref?.kind === 'merge' ? '累计历史'
    : ref?.kind === 'anchor' ? anchorBatchLabel(source)
      : ref?.kind === 'godlog' ? '前情片段'
        : ref?.kind === 'raw-recall' ? '原楼正文保底'
          : '记忆';
  const title = ref?.title || (ref?.kind === 'godlog' ? godlogFieldValue(source?.body || '', 'Title') : '') || '';
  const aiTurnNumber = Number(ref?.number || source?.assistantNumber || source?.number || 0);
  const number = ['godlog', 'raw-recall'].includes(ref?.kind)
    ? (aiTurnNumber > 0 ? `第 ${aiTurnNumber} 个AI回合`
      : (Number.isInteger(ref?.floor) ? `聊天第 ${ref.floor} 楼` : ''))
    : (source?.number || ref?.number ? `第 ${source?.number || ref.number} 次` : '');
  return [kind, number, title].filter(Boolean).join(' · ');
}

function memoryRefKindLabel(ref, data = memoryData()) {
  if (ref?.kind === 'merge') return '累计历史';
  if (ref?.kind === 'godlog') return '逐楼摘要';
  if (ref?.kind === 'raw-recall') return '原楼正文保底';
  if (ref?.kind === 'anchor') {
    const source = ref?.id
      ? [...(data.anchors || [])].find(item => item.id === ref.id)
      : null;
    return anchorBatchLabel(source);
  }
  return '记忆';
}

function memoryRefBody(ref, data = memoryData()) {
  if (ref?.kind === 'raw-recall') {
    const row = chatRows(true).find(item => item.key === ref.key || Number(item.index) === Number(ref.floor));
    return row ? safePromptMemoryText('raw-recall', rawRecallItem(row), 1800) : '';
  }
  const source = ref?.id
    ? [...(data.godlogs || []), ...(data.anchors || []), ...(data.merges || [])].find(item => item.id === ref.id)
    : null;
  if (!source) return '';
  return safePromptMemoryText(ref.kind, source, ref.kind === 'merge' ? 3000 : 1800);
}

function formatMessageRecallDetail(record, data = memoryData()) {
  if (!record) return '这楼还没有生成前注入记录。';
  const lines = [
    '【历史记录提示】这是该楼当时生成前实际收到的记忆快照，不会因后来新建锚点而回溯改写，也不代表下一次生成仍会注入同样内容。',
    '',
    `第 ${Number(record.floor ?? 0)} 楼生成前注入记录`,
    `注入字符：${record.injectedChars || 0}`,
    `记录时间：${record.at ? new Date(record.at).toLocaleString() : '未记录'}`,
    '',
  ];
  if (record.recallQuery) {
    lines.push(
      `召回来源：${record.recallQuery.source || '最近上下文'}`,
      `召回方式：${record.recallQuery.mode || 'keyword'} / 最低 ${record.recallQuery.minCount || record.recallQuery.topK || 3} 条 / 实际 ${record.recallQuery.selectedCount || 0} 条`,
      '',
    );
  }
  const refs = Array.isArray(record.refs) ? record.refs : [];
  if (refs.length === 0) {
    lines.push('本次只有基础记忆或剧情定位，没有可列出的具体锚点或前情条目。');
  } else {
    for (const ref of refs) lines.push(`- ${memoryRefLabel(ref, data)}`);
  }
  if (record.contentPreview) {
    lines.push('', '--- 当时注入内容预览（已去重压缩） ---', record.contentPreview);
  }
  if (refs.length > 0) {
    lines.push('', '--- 当前可用的命中内容展开 ---');
    for (const ref of refs) {
      lines.push(`\n【${memoryRefLabel(ref, data)}】`);
      lines.push(memoryRefBody(ref, data) || '该来源已被合并、回滚或删除，当前没有可展开正文。');
    }
  }
  lines.push('', `内容签名：${record.contentHash || '旧记录未保存签名'}`);
  return lines.join('\n');
}

function messageRenderContext() {
  const rows = chatRows(false).filter(row => row.role === 'assistant');
  return {
    data: memoryData(),
    rows,
    rowsByIndex: new Map(rows.map(row => [row.index, row])),
  };
}

function visibleAssistantMessageIndices(rows = chatRows(false).filter(row => row.role === 'assistant')) {
  const selected = new Set(rows.slice(-MESSAGE_RENDER_RECENT_COUNT).map(row => row.index));
  const chatElement = document.querySelector('#chat');
  if (!chatElement) return selected;

  // On long chats, measuring every historical message on every scroll causes layout thrashing.
  // IntersectionObserver maintains a tiny near-viewport set incrementally, so 300+ floors do not
  // require hundreds of getBoundingClientRect() calls every 120ms.
  if (state.messageVisibilityObserver && state.messageVisibilityHost === chatElement) {
    for (const index of state.visibleMessageIndices) selected.add(index);
    return selected;
  }

  // Compatibility fallback for browsers without IntersectionObserver.
  const chatRect = chatElement.getBoundingClientRect?.();
  const viewportTop = (chatRect?.top ?? 0) - MESSAGE_RENDER_MARGIN_PX;
  const viewportBottom = (chatRect?.bottom
    ?? (globalThis.innerHeight || document.documentElement?.clientHeight || 900)) + MESSAGE_RENDER_MARGIN_PX;
  for (const element of chatElement.querySelectorAll('.mes[mesid]')) {
    const index = Number(element.getAttribute('mesid'));
    if (!Number.isInteger(index)) continue;
    const rect = element.getBoundingClientRect?.();
    if (!rect || rect.bottom < viewportTop || rect.top > viewportBottom) continue;
    selected.add(index);
  }
  return selected;
}

function messageBadgeSignature(record, refs) {
  return stableHash(JSON.stringify({
    contentHash: record?.contentHash || '',
    injectedChars: record?.injectedChars || 0,
    refs: (refs || []).map(ref => [ref.kind || '', ref.id || '', ref.key || '', ref.number || 0]),
  }));
}

function renderInjectionBadgeForIndex(messageIndex, prepared = null) {
  const index = Number(messageIndex);
  if (!Number.isInteger(index)) return false;
  const messageEl = document.querySelector(`#chat .mes[mesid="${index}"]`);
  if (!messageEl) return false;

  const context = prepared || messageRenderContext();
  const row = context.rowsByIndex?.get(index) || context.rows?.find(item => item.index === index);
  const existing = messageEl.querySelector('.am-message-memory-badge');
  if (!row || row.role !== 'assistant') {
    existing?.remove();
    return false;
  }
  const data = context.data || memoryData();
  const record = messageRecallRecord(data, row);
  const refs = Array.isArray(record?.refs) ? record.refs : [];
  if (!record || (refs.length === 0 && !record.injectedChars)) {
    existing?.remove();
    return false;
  }

  const signature = messageBadgeSignature(record, refs);
  if (existing?.dataset?.renderSignature === signature
      && existing.dataset.messageKey === row.key) return true;

  existing?.remove();
  const title = formatMessageRecallDetail(record, data);
  const anchor = messageEl.querySelector('.mes_block .ch_name') || messageEl.querySelector('.ch_name') || messageEl;
  anchor.insertAdjacentHTML('afterend', `
    <button class="am-message-memory-badge" type="button" data-message-key="${escapeHtml(row.key)}" data-render-signature="${escapeHtml(signature)}" title="${escapeHtml(title)}">
      a${escapeHtml(refs.length || '')}
    </button>
  `);
  return true;
}

function renderInjectionBadges(indices = null, prepared = null) {
  const context = prepared || messageRenderContext();
  const targets = indices || visibleAssistantMessageIndices(context.rows);
  for (const index of targets) renderInjectionBadgeForIndex(index, context);
}

function panelRenderSignature(row, item, status, summary, body) {
  return stableHash(JSON.stringify({
    key: row?.key || '',
    rawHash: row?.rawHash || '',
    id: item?.id || '',
    status,
    stale: !!item?.stale,
    sourceMismatch: !!item?.sourceMismatch,
    currentRawHash: item?.currentRawHash || '',
    rerunPending: !!item?.rerunPending,
    rerunQueued: !!item?.rerunQueued,
    retryScheduledAt: item?.retryScheduledAt || 0,
    busy: !!(row?.key && isSummaryRowBusy(row.key)),
    rerunError: item?.rerunError || '',
    number: item?.number || 0,
    updatedAt: item?.updatedAt || 0,
    summary,
    bodyHash: stableHash(body || ''),
  }));
}

function renderGodlogPanelForIndex(messageIndex, prepared = null) {
  const index = Number(messageIndex);
  if (!Number.isInteger(index)) return false;
  const chat = getContext().chat || [];
  const message = chat[index];
  if (!message || message.is_user || message.is_system) return false;
  if (stripGodlogFromMessageRecord(message)) {
    invalidateRuntimeCaches('removed leaked Godlog block');
    refreshMessageBlock(index);
    saveChatNow();
    scheduleGodlogPanelRender(index, 1);
    return true;
  }

  const messageEl = document.querySelector(`#chat .mes[mesid="${index}"]`);
  if (!messageEl) return false;
  sanitizeLeakedGodlogDom(messageEl);

  const context = prepared || messageRenderContext();
  const row = context.rowsByIndex?.get(index) || context.rows?.find(item => item.index === index);
  if (!row) return false;

  const data = context.data || memoryData();
  const item = godlogForRow(data, row);
  const hasExplicitQueuedRerun = state.forcedSummaryReruns.has(row.key);
  // Do not render a fake "queued" summary card for the normal settle/backlog window.
  // The card appears only once a real summary record/request exists, or when the user explicitly
  // queued a manual rerun. This keeps every new floor from looking permanently stuck in a queue.
  if (!item && !hasExplicitQueuedRerun) {
    messageEl.querySelector('.am-message-godlog-panel')?.remove();
    renderInjectionBadgeForIndex(index, context);
    return true;
  }
  if (!item && generationIsActiveForGodlog(row)) {
    messageEl.querySelector('.am-message-godlog-panel')?.remove();
    renderInjectionBadgeForIndex(index, context);
    return true;
  }
  const status = item?.archived ? 'archived' : (item?.status === 'failed' ? 'failed' : (item?.stale ? 'stale' : (item?.status || missingGodlogUiStatus(row, data))));
  const id = item?.id || syntheticGodlogId(row);
  const summary = messageGodlogSummary(item, row);
  const body = messageGodlogBody(item, row);
  const signature = panelRenderSignature(row, item, status, summary, body);
  const existingPanel = messageEl.querySelector('.am-message-godlog-panel');
  if (existingPanel?.dataset?.renderSignature === signature) {
    renderInjectionBadgeForIndex(index, context);
    return true;
  }

  const wasOpen = !!existingPanel?.classList.contains('open');
  existingPanel?.remove();
  const updatedAt = item?.updatedAt ? new Date(item.updatedAt).toLocaleString() : '未生成';
  const mesText = messageEl.querySelector('.mes_text') || messageEl;
  if (rememberMessageGodlogCard(data, row, item, status)) saveMemory();

  mesText.insertAdjacentHTML('afterend', `
    <div class="am-message-godlog-panel am-status-${escapeHtml(status)}${wasOpen ? ' open' : ''}" data-godlog-id="${escapeHtml(id)}" data-message-index="${escapeHtml(index)}" data-render-signature="${escapeHtml(signature)}">
      <button class="am-message-godlog-toggle" type="button" title="展开逐楼摘要">
        <span class="am-message-godlog-mark">a</span>
        <span class="am-message-godlog-floor">第 ${escapeHtml(index)} 楼</span>
        <span class="am-message-godlog-status">${escapeHtml(godlogStatusLabel(status, item))}</span>
        <span class="am-message-godlog-summary">${escapeHtml(summary)}</span>
      </button>
      <div class="am-message-godlog-body"${wasOpen ? '' : ' hidden'}>
        <div class="am-message-godlog-meta">Nub ${escapeHtml(item?.number || godlogNumberForRow(row) || '')} · ${escapeHtml(updatedAt)}</div>
        <div class="am-message-godlog-text">${escapeHtml(body)}</div>
        <div class="am-message-godlog-actions">
          <button class="am-message-godlog-open" type="button">打开摘要页</button>
          <button class="am-message-godlog-rerun" type="button" ${isSummaryRowBusy(row) || item?.rerunQueued ? 'disabled' : ''}>${isSummaryRowBusy(row) ? '正在重跑…' : (item?.rerunQueued ? '已排队重跑' : '重跑本楼摘要')}</button>
        </div>
      </div>
    </div>
  `);
  renderInjectionBadgeForIndex(index, context);
  return true;
}

function removeOffscreenMessageDecorations(targets) {
  const keep = targets instanceof Set ? targets : new Set(targets || []);
  const chatElement = document.querySelector('#chat');
  if (!chatElement) return;
  for (const panel of chatElement.querySelectorAll('.am-message-godlog-panel[data-message-index]')) {
    const index = Number(panel.getAttribute('data-message-index'));
    if (!keep.has(index)) panel.remove();
  }
  for (const badge of chatElement.querySelectorAll('.am-message-memory-badge')) {
    const host = badge.closest('.mes[mesid]');
    const index = Number(host?.getAttribute('mesid'));
    if (!keep.has(index)) badge.remove();
  }
}

function renderGodlogPanels() {
  const context = messageRenderContext();
  const targets = visibleAssistantMessageIndices(context.rows);
  removeOffscreenMessageDecorations(targets);
  let rendered = 0;
  let expected = 0;
  for (const index of targets) {
    if (!context.rowsByIndex.has(index)) continue;
    expected++;
    if (renderGodlogPanelForIndex(index, context)) rendered++;
  }
  return { expected, rendered };
}

function scheduleGodlogPanelRender(messageId = '', attempt = 0) {
  const index = typeof eventMessageIndex === 'function' ? eventMessageIndex(messageId) : Number(messageId);
  if (Number.isInteger(index)) state.panelRenderTargets.add(index);
  else state.panelRenderAll = true;
  state.panelRenderAttempt = Math.max(state.panelRenderAttempt, Number(attempt) || 0);
  if (state.panelRenderTimer) return;

  const delay = state.panelRenderAttempt > 0 ? 300 : PANEL_RENDER_DEBOUNCE_MS;
  state.panelRenderTimer = setTimeout(() => {
    state.panelRenderTimer = null;
    const renderAll = state.panelRenderAll;
    const targets = [...state.panelRenderTargets];
    const currentAttempt = state.panelRenderAttempt;
    state.panelRenderAll = false;
    state.panelRenderTargets.clear();
    state.panelRenderAttempt = 0;

    let expected = 0;
    let rendered = 0;
    if (renderAll || targets.length !== 1) {
      ({ expected, rendered } = renderGodlogPanels());
    } else {
      const targetIndex = targets[0];
      const chat = getContext().chat || [];
      const message = chat[targetIndex];
      expected = message && !message.is_user && !message.is_system ? 1 : 0;
      const context = messageRenderContext();
      rendered = renderGodlogPanelForIndex(targetIndex, context) ? 1 : 0;
    }
    if (expected > rendered && currentAttempt < 8) {
      scheduleGodlogPanelRender(renderAll ? '' : targets[0] ?? '', currentAttempt + 1);
    }
  }, delay);
}

function resetMessageVisibilityTracking() {
  state.messageVisibilityObserver?.disconnect?.();
  state.messageVisibilityMutationObserver?.disconnect?.();
  state.messageVisibilityObserver = null;
  state.messageVisibilityMutationObserver = null;
  state.messageVisibilityHost = null;
  state.messageVisibilityObservedElements = new WeakSet();
  state.visibleMessageIndices.clear();
  state.lazyRenderBound = false;
}

function bindLazyMessageRendering() {
  if (state.lazyRenderBound) return;
  const chat = document.querySelector('#chat');
  if (!chat) {
    setTimeout(bindLazyMessageRendering, 500);
    return;
  }
  state.lazyRenderBound = true;

  if (typeof globalThis.IntersectionObserver === 'function') {
    state.messageVisibilityHost = chat;
    const observeElement = element => {
      if (!(element instanceof Element) || !element.matches('.mes[mesid]')) return;
      if (state.messageVisibilityObservedElements.has(element)) return;
      state.messageVisibilityObservedElements.add(element);
      state.messageVisibilityObserver.observe(element);
    };
    state.messageVisibilityObserver = new IntersectionObserver(entries => {
      let changed = false;
      for (const entry of entries) {
        const index = Number(entry.target?.getAttribute?.('mesid'));
        if (!Number.isInteger(index)) continue;
        if (entry.isIntersecting) {
          if (!state.visibleMessageIndices.has(index)) {
            state.visibleMessageIndices.add(index);
            changed = true;
          }
        } else if (state.visibleMessageIndices.delete(index)) {
          changed = true;
        }
      }
      if (changed) scheduleGodlogPanelRender();
    }, { root: chat, rootMargin: `${MESSAGE_RENDER_MARGIN_PX}px 0px`, threshold: 0 });
    chat.querySelectorAll('.mes[mesid]').forEach(observeElement);
    state.messageVisibilityMutationObserver = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes || []) {
          if (!(node instanceof Element)) continue;
          observeElement(node);
          node.querySelectorAll?.('.mes[mesid]').forEach(observeElement);
        }
      }
    });
    state.messageVisibilityMutationObserver.observe(chat, { childList: true, subtree: true });
    return;
  }

  // Older-browser fallback. This keeps previous behavior, but modern ST browsers use the observer path.
  chat.addEventListener('scroll', () => {
    if (state.visibleRenderTimer) cancelAnimationFrame(state.visibleRenderTimer);
    state.visibleRenderTimer = requestAnimationFrame(() => {
      state.visibleRenderTimer = null;
      scheduleGodlogPanelRender();
    });
  }, { passive: true });
}

function showGodlogInWorkbench(id) {
  const syntheticRow = rowFromSyntheticGodlogId(id);
  const data = memoryData();
  const item = (data.godlogs || []).find(entry => entry.id === id);
  state.selectedGodlogId = id;
  openWorkbench();
  activateTab('summaries');
  renderGodlogList();
  $('#am_godlog_detail').val(item?.body || item?.error || (syntheticRow ? messageGodlogBody(null, syntheticRow) : ''));
}

function showRecallRecordInWorkbench(messageKey) {
  const key = String(messageKey || '').trim();
  const data = memoryData();
  const record = key ? data.messageRecalls?.[key] : null;
  if (!record) {
    toastr?.info?.('这条消息没有可查看的生成前记忆记录。', 'Anchor Memory');
    return false;
  }
  state.selectedRecallMessageKey = key;
  openWorkbench();
  activateTab('recall');
  updatePreview();
  return true;
}

async function rerunGodlogFromPanel(id) {
  const syntheticRow = rowFromSyntheticGodlogId(id);
  const data = memoryData();
  const item = (data.godlogs || []).find(entry => entry.id === id);
  const row = syntheticRow || currentRowForGodlog(item);
  if (!row) {
    toastr?.warning?.('找不到对应楼层，可能已删除或切换了 swipe', 'Anchor Memory');
    return;
  }
  state.selectedGodlogId = id;
  if (isSummaryRowBusy(row) || state.forcedSummaryReruns.has(row.key)) {
    toastr?.info?.(`第 ${row.index} 楼摘要任务已接收，不会重复提交。`, 'Anchor Memory');
    scheduleGodlogPanelRender(row.index);
    return;
  }
  const ok = await generateGodlogForRow(row, true);
  const current = godlogForRow(memoryData(), row);
  updatePreview();
  renderGodlogPanelForIndex(row.index);
  if (ok) toastr?.success?.(`第 ${row.index} 楼摘要已重新生成`, 'Anchor Memory');
  else if (current?.rerunQueued || state.forcedSummaryReruns.has(row.key)) toastr?.info?.('当前楼正文仍在生成或等待稳定；手动重跑已排队，稳定后会自动执行。', 'Anchor Memory');
  else if (current?.retryScheduledAt > Date.now()) toastr?.warning?.('本次摘要请求失败，插件已安排自动重试，不需要再次点击。', 'Anchor Memory');
  else toastr?.error?.(`本楼摘要未完成：${current?.rerunError || current?.error || memoryData()?.processing?.lastError || '请检查副API配置或控制台错误'}`, 'Anchor Memory');
}

function renderMemoryCards(container, items, emptyText) {
  if (!container.length) return;
  container.empty();
  if (items.length === 0) {
    container.append(`<div class="am-card"><div class="am-card-body">${escapeHtml(emptyText)}</div></div>`);
    return;
  }
  const assistantRowsByKey = new Map(chatRows(true)
    .filter(row => row.role === 'assistant')
    .map(row => [row.key, row]));
  for (const { type, kind, item } of items) {
    const fullBody = cleanText(item.body);
    const previewLimit = 600;
    const excerpt = fullBody.slice(0, previewLimit);
    const previewOnly = fullBody.length > excerpt.length;
    const sourceRows = (item.sourceKeys || []).map(key => assistantRowsByKey.get(key)).filter(Boolean);
    const firstAi = sourceRows[0]?.assistantNumber;
    const lastAi = sourceRows[sourceRows.length - 1]?.assistantNumber;
    const messageRange = item.sourceFloors?.length
      ? `聊天楼层 ${Number(item.sourceFloors[0]) + 1}-${Number(item.sourceFloors[item.sourceFloors.length - 1]) + 1}`
      : (item.floorAt !== undefined ? `到聊天楼层 ${Number(item.floorAt) + 1}` : '');
    const aiRange = firstAi && lastAi
      ? `AI回合 ${firstAi}-${lastAi}`
      : (item.coverageCount ? `累计 ${item.coverageCount} 个AI回合` : '');
    const range = [aiRange, messageRange].filter(Boolean).join(' · ');
    container.append(`
      <div class="am-card am-memory-card" data-memory-id="${escapeHtml(item.id)}">
        <div class="am-card-title">
          <span>${escapeHtml(type)} · 第 ${escapeHtml(item.number)} 次</span>
          <span class="am-pill">${escapeHtml(item.stale ? '可能过期' : range)}</span>
        </div>
        <div class="am-card-meta">${new Date(item.createdAt).toLocaleString()}${item.rewriteCount ? ` · 已重写 ${Number(item.rewriteCount)} 次` : ''}${previewOnly ? ' · 卡片仅预览，点击后在下方查看全文' : ''}</div>
        <div class="am-card-body">${escapeHtml(excerpt)}${previewOnly ? '\n\n【预览到此；存储正文未截断】' : ''}</div>
        <div class="am-card-actions">
          <button class="am-rewrite-memory" data-memory-id="${escapeHtml(item.id)}">重写此${kind === 'merge' ? '累计历史' : '分段锚点'}</button>
        </div>
      </div>
    `);
  }
}

function renderTimelineList() {
  const data = memoryData();
  const query = ($('#am_timeline_search').val() || '').trim().toLowerCase();
  const matches = item => !query || String(item.body || '').toLowerCase().includes(query);
  const newAnchors = activeAnchorsAfterMerge(data)
    .filter(matches)
    .map(item => ({ type: '分段锚点', kind: 'anchor', item }))
    .sort((a, b) => b.item.createdAt - a.item.createdAt);
  const oldAnchors = data.merges
    .filter(matches)
    .map(item => ({ type: '累计历史', kind: 'merge', item }))
    .sort((a, b) => b.item.createdAt - a.item.createdAt);

  renderMemoryCards($('#am_new_anchor_list'), newAnchors, '暂无新锚点。攒满有效摘要后会自动生成。');
  renderMemoryCards($('#am_old_anchor_list'), oldAnchors, '暂无旧锚点。攒满合并间隔后会自动生成。');
  $('#am_timeline_list').empty();
}

function archiveIsTransferReady(archive) {
  if (!archive || !archive.data) return false;
  if (archive.mode === 'full-merge') return (archive.data.merges || []).length === 1;
  // Structural fallback for archives created by an early test build of this feature.
  return (archive.data.godlogs || []).length === 0
    && (archive.data.anchors || []).length === 0
    && (archive.data.merges || []).length === 1;
}

function archiveMatchesCurrentChat(archive, data = null) {
  if (!archive?.sourceStorageId || !hasPersistentChatContext()) return false;
  const current = data || memoryData();
  return String(archive.sourceStorageId) === String(current?.processing?.storageId || '');
}

function archiveCoverageCount(archive) {
  const merges = archive?.data?.merges || [];
  const merge = merges[merges.length - 1] || null;
  return Number(archive?.sourceAiTurns || merge?.archivedCoverageCount || merge?.coverageCount || 0);
}

function inheritedArchiveCoverageCount(data) {
  const imported = Number(data?.processing?.archiveSourceAiTurns || 0);
  const mergeBase = Math.max(0, ...(data?.merges || [])
    .filter(item => item?.archiveBase)
    .map(item => Number(item.archivedCoverageCount || 0)));
  return Math.max(imported, mergeBase);
}

function currentTransferCoverageCount(data = memoryData()) {
  const currentTurns = chatRows(true).filter(row => row.role === 'assistant').length;
  return inheritedArchiveCoverageCount(data) + currentTurns;
}

function renderArchiveCards() {
  const s = settings();
  const charName = currentCharacterName();
  const archives = s.slots?.[charName] || {};
  const container = $('#am_archive_cards');
  if (!container.length) return;
  container.empty();
  const names = Object.keys(archives).sort();
  if (names.length === 0) {
    container.append('<div class="am-card"><div class="am-card-body">当前角色暂无记忆档案。先保存当前档案，卡片中会出现“补齐并整理为累计历史”按钮；整理完成后才能安全加载到新开场。</div></div>');
    return;
  }
  const current = hasPersistentChatContext() ? memoryData() : null;
  for (const name of names) {
    const archive = archives[name];
    const d = archive.data || {};
    const ready = archiveIsTransferReady(archive);
    const sameSource = archiveMatchesCurrentChat(archive, current);
    const status = ready ? '已全量整理' : '待全量整理';
    const counts = ready
      ? `已压成 1 份累计全量记忆，原覆盖约 ${archiveCoverageCount(archive)} 个AI回合；旧逐楼摘要与旧分段锚点不会带入新开场。`
      : `当前快照含摘要 ${d.godlogs?.length || 0} 条、分段锚点 ${d.anchors?.length || 0} 个、累计历史 ${d.merges?.length || 0} 份。请在原聊天中补齐摘要并完成最终整理。`;
    const finalizeLabel = ready ? '用当前聊天更新累计历史' : '补齐并整理为累计历史';
    const finalizeTitle = sameSource
      ? '补齐当前聊天所有缺失逐楼摘要，把尚未进入累计历史的内容完成最终整理，并更新此档案'
      : '此档案不是从当前聊天保存的；请回到原聊天，或在当前聊天重新保存一个档案后再整理';
    container.append(`
      <div class="am-card">
        <div class="am-card-title"><span>${escapeHtml(name)}</span><span class="am-pill">${escapeHtml(status)}</span></div>
        <div class="am-card-meta">${escapeHtml(charName)} · 更新于 ${new Date(archive.updatedAt || Date.now()).toLocaleString()}</div>
        <div class="am-card-body">${escapeHtml(counts)}</div>
        <div class="am-card-actions">
          <button class="am-finalize-archive" data-archive="${escapeHtml(name)}" title="${escapeHtml(finalizeTitle)}" ${sameSource ? '' : 'disabled'}>${escapeHtml(finalizeLabel)}</button>
          <button class="am-load-archive" data-archive="${escapeHtml(name)}" ${(ready && !sameSource) ? '' : 'disabled'} title="${sameSource ? '这是档案的原聊天；禁止把精简转档副本覆盖回原聊天' : (ready ? '仅加载最终累计全量记忆与人物、物品、场景状态' : '请先完成全量整理')}">${sameSource ? '原聊天禁止加载' : (ready ? '加载到当前聊天' : '需先全量整理')}</button>
          <button class="am-delete-archive" data-archive="${escapeHtml(name)}">删除</button>
        </div>
      </div>
    `);
  }
}

function renderHealth() {
  const s = settings();
  const data = memoryData();
  const issues = [];
  const assistantTurnCount = chatRows(true).filter(row => row.role === 'assistant').length;
  if (!secondaryConfigured(s)) issues.push('未完整配置副API：逐楼摘要、锚点和合并不会自动完成；本版本不会把后台记忆整理提示词发送给主模型。');
  if (s.useEmbedding && !embeddingConfigured()) issues.push('已启用Embedding，但向量API地址、密钥或模型不完整。');
  if (s.useEmbedding && state.vectorStorageUnavailable) issues.push('当前浏览器无法使用 IndexedDB：语义向量已自动停用，插件只使用关键词召回；不会把向量浮点数组写入聊天元数据。');
  if ((data.timeline?.warnings || []).length > 0) issues.push(`剧情时间连续性有 ${(data.timeline.warnings || []).length} 条待核对提示；回忆/梦境不会覆盖当前现实时间。最近一条：${data.timeline.warnings.at(-1)?.message || '请检查场景页'}`);
  if (assistantTurnCount >= HIGH_FLOOR_RECALL_HINT_TURNS && !s.useDynamicRecall) {
    issues.push(`当前聊天已超过 ${assistantTurnCount} 个AI回合。高楼层建议开启“旧楼动态召回”，可从完整逐楼记忆中找回早期事件；不开启也不会影响分层锚点本身。`);
  }
  if (s.useEmbedding) {
    const validVectorIds = new Set(recallCorpus(data).map(source => source?.item?.id).filter(Boolean));
    const expected = validVectorIds.size;
    const signature = embeddingConfigured() ? embeddingSignature() : '';
    const actual = Object.entries(data.vectorRefs || {})
      .filter(([id, record]) => validVectorIds.has(id) && record.signature === signature).length;
    if (actual < expected) issues.push(`当前模型的向量索引不完整：${actual}/${expected}，建议点“重建向量”。`);
  }
  const liveKeys = new Set(chatRows(true).map(row => row.key));
  const orphanKeys = Object.keys(data.processing.anchoredKeys || {}).filter(key => !liveKeys.has(key));
  if (orphanKeys.length > 0) issues.push(`检测到 ${orphanKeys.length} 条锚定标记对应的原楼层已不存在；这通常来自删楼，可导出备份后重置当前记忆或手动整理。`);
  const failedGodlogs = (data.godlogs || []).filter(item => item.status === 'failed');
  const staleGodlogs = (data.godlogs || []).filter(item => item.status === 'stale');
  const staleAnchors = (data.anchors || []).filter(item => item.stale);
  const missingDiagnostics = missingGodlogDiagnostics(data);
  const missingFloors = missingDiagnostics.slice(0, 5).map(({ row }) => `第${row.index}楼`).join('、');
  if (failedGodlogs.length > 0) issues.push(`有 ${failedGodlogs.length} 条逐楼摘要待自动补写，可到“逐楼摘要”页点“自动补写缺失摘要”或重跑单楼。`);
  if (staleGodlogs.length > 0) issues.push(`有 ${staleGodlogs.length} 条逐楼摘要已过期，通常来自编辑、swipe 或 regenerate。`);
  if (staleAnchors.length > 0) issues.push(`检测到 ${staleAnchors.length} 个旧版过期锚点；重新载入聊天后会自动清理。`);
  if (pendingGodlogRows(data).length > 0) issues.push(`还有 ${pendingGodlogRows(data).length} 楼缺少有效逐楼摘要；配置副API后可自动补写。`);
  if (missingDiagnostics.length > 0) issues.push(`${missingFloors}${missingDiagnostics.length > 5 ? `等 ${missingDiagnostics.length} 楼` : ''}已经落后仍无有效摘要；插件会弹窗提示，并可在“逐楼摘要”页自动补写。`);
  if (pendingAnchorMaterials(data).length >= normalizeAnchorInterval(s.anchorInterval)) issues.push('有效摘要已达到锚点间隔，可以生成锚点。');
  const tokenEstimate = estimateMemoryTokens(data);
  const configuredBudget = Math.max(1200, Number(s.memoryMaxTokens) || 8000);
  if (tokenEstimate > configuredBudget) issues.push(`记忆注入估算约 ${tokenEstimate} Token，超过配置上限 ${configuredBudget}；发送前会自动按优先级裁剪。`);
  if (data.anchors.length === 0) issues.push('暂无锚点。聊满间隔后会自动生成，也可以手动点“生成锚点”。');
  if (data.processing?.codexDirty) {
    issues.push(codexSnapshotSafeForInjection(data)
      ? `人物/物品/场景索引需要重建；当前仍注入截至最近有效摘要的安全快照，最新等待生成摘要的楼层暂不计入。${data.processing.codexDirtyReason ? `原因：${data.processing.codexDirtyReason}` : ''}`
      : `人物/物品/场景索引需要重建；旧数据仍被保留，但无法确认回退边界，重建成功前不会注入。${data.processing.codexDirtyReason ? `原因：${data.processing.codexDirtyReason}` : ''}`);
    const checkpoint = data.processing?.codexRebuildCheckpoint;
    if (checkpoint) {
      const cursor = Math.min(Number(checkpoint.cursor || 0), Number(checkpoint.totalChunks || 0));
      issues.push(`索引采用分段事务重建，当前进度 ${cursor}/${Number(checkpoint.totalChunks || 0)}；已完成分段已保存，失败或刷新后会从下一段继续，不会重新从第1段开始。`);
    }
    if (Number(data.processing?.codexRebuildFailures || 0) >= 3 && Number(data.processing?.codexRetryAt || 0) > 0) {
      issues.push('索引自动重试已在连续三次无进展失败后暂停，避免副API死循环扣费。请检查副API后，在“人物动态”页手动继续安全重建。');
    }
  }
  if (data.processing?.relationshipDirty) {
    issues.push(`固定人物关系表需要按当前有效楼层重建；期间仍会注入已回退的安全快照。${data.processing.relationshipDirtyReason ? `原因：${data.processing.relationshipDirtyReason}` : ''}`);
  }
  if (!codexHasContent(data.codex)) issues.push('暂无人物/物品/场景索引。若逐楼摘要仍在，可配置副API后安全重建；重建失败不会再清空已有数据。');
  if (data.codexBackup?.codex && (codexHasContent(data.codexBackup.codex) || relationshipHasContent(data.codexBackup.relationshipTable))) issues.push('检测到一份人物关系/人物/物品/场景索引安全备份，可在“人物动态”页手动恢复。');

  const container = $('#am_health_list');
  if (!container.length) return;
  container.empty();
  if (issues.length === 0) {
    container.append('<div class="am-card"><div class="am-card-title">状态良好</div><div class="am-card-body">当前没有明显配置或记忆断层。</div></div>');
    return;
  }
  for (const issue of issues) {
    container.append(`<div class="am-card"><div class="am-card-body">${escapeHtml(issue)}</div></div>`);
  }
}

function repairHealth() {
  const data = memoryData();
  syncGodlogsWithChat('记忆体检同步');
  const liveKeys = new Set(chatRows(true).map(row => row.key));
  let removedAnchoredKeys = 0;
  for (const key of Object.keys(data.processing.anchoredKeys || {})) {
    if (!liveKeys.has(key)) {
      delete data.processing.anchoredKeys[key];
      removedAnchoredKeys++;
    }
  }
  const removedVectors = pruneVectorIndex(data);
  saveMemory();
  updatePreview();
  return { removedAnchoredKeys, removedVectors };
}

function renderRecallHits() {
  const data = memoryData();
  const container = $('#am_recall_hits');
  if (!container.length) return;
  container.empty();
  if (state.lastRecallQuery && !state.selectedRecallMessageKey) {
    const query = state.lastRecallQuery;
    const timingParts = [recallStageText(query)];
    if (Number.isFinite(Number(query.waitedMs)) && Number(query.waitedMs) > 0) timingParts.push(`等待 ${Number(query.waitedMs)}ms`);
    if (Number.isFinite(Number(query.totalElapsedMs)) && Number(query.totalElapsedMs) > 0) timingParts.push(`总耗时 ${Number(query.totalElapsedMs)}ms`);
    if (query.timedOut) timingParts.push('混合召回中的语义通道超时，已用关键词结果');
    if (state.recallPrefetchStatus?.key === query.key && state.recallPrefetchStatus?.lateForCurrentPrompt) {
      timingParts.push('后到的语义结果未用于本轮混合排序');
    }
    const countText = query.stage === 'prefetching' || query.mode === 'hybrid-prefetch'
      ? '候选正在计算'
      : `实际 ${query.selectedCount ?? 0} 条 · 候选 ${query.candidateCount ?? 0} 条`;
    container.append(`
        <div class="am-card">
          <div class="am-card-title"><span>本轮检索条件（不是命中内容）</span><span class="am-pill">${escapeHtml(query.mode || 'keyword')}</span></div>
        <div class="am-card-meta">${escapeHtml(timingParts.filter(Boolean).join(' · ') || '等待生成前注入')}<br>${escapeHtml(countText)} · ${escapeHtml(query.source || '最新正文')}</div>
        <div class="am-card-body"><strong>查询文本：</strong>${escapeHtml(query.preview || '暂无查询内容。')}</div>
      </div>
    `);
  }
  const selectedRecord = state.selectedRecallMessageKey ? data.messageRecalls?.[state.selectedRecallMessageKey] : null;
  if (selectedRecord) {
    const refs = Array.isArray(selectedRecord.refs) ? selectedRecord.refs : [];
    if (refs.length === 0) {
      container.append('<div class="am-card"><div class="am-card-body">这楼有生成前注入记录，但没有可列出的具体锚点或前情片段。</div></div>');
      return;
    }
    for (const ref of refs) {
      const label = memoryRefKindLabel(ref, data);
      const meta = ref.method
        ? `${ref.method}${ref.score ? ` · ${Number(ref.score).toFixed(3)}` : ''}${ref.recallReason ? ` · ${ref.recallReason}` : ''}`
        : '静态注入';
      const body = memoryRefBody(ref, data);
      container.append(`
        <div class="am-card">
          <div class="am-card-title"><span>${escapeHtml(label)}</span><span class="am-pill">${escapeHtml(meta)}</span></div>
          <div class="am-card-meta">${escapeHtml(memoryRefLabel(ref, data))}</div>
          <div class="am-card-body">${escapeHtml(body || '没有可展开的正文。')}</div>
        </div>
      `);
    }
    return;
  }
  if (!state.lastRecallMeta.length) {
    container.append('<div class="am-card"><div class="am-card-body">没有找到达到相关度阈值的旧楼记忆；上方仅显示本轮检索条件，不代表已经召回正文。</div></div>');
    return;
  }
  for (const hit of state.lastRecallMeta) {
    const label = memoryRefKindLabel(hit, data);
    const body = memoryRefBody(hit, data);
    const position = ['godlog', 'raw-recall'].includes(hit.kind)
      ? (Number(hit.number) > 0 ? `第 ${Number(hit.number)} 个AI回合` : (Number.isInteger(hit.floor) ? `聊天第 ${hit.floor} 楼` : '旧AI回合'))
      : `第 ${hit.number} 次`;
    container.append(`
      <div class="am-card">
        <div class="am-card-title"><span>${escapeHtml(label)} · ${escapeHtml(position)}</span><span class="am-pill">${escapeHtml(hit.method)}</span></div>
        <div class="am-card-meta">融合相关度：${hit.score.toFixed(3)}${hit.semanticScore ? ` · 语义 ${Number(hit.semanticScore).toFixed(3)}` : ''}${hit.keywordScore ? ` · 关键词 ${Number(hit.keywordScore).toFixed(2)}` : ''}${hit.recallReason ? ` · ${escapeHtml(hit.recallReason)}` : ''}${hit.recallTokens ? ` · 约${escapeHtml(hit.recallTokens)} token` : ''}</div>
        <div class="am-card-body">${escapeHtml(body || '没有可展开的正文。')}</div>
      </div>
    `);
  }
}

function findGodlogItem(id) {
  const data = memoryData();
  const item = (data.godlogs || []).find(entry => entry.id === id);
  return item ? { data, item } : null;
}

async function saveSelectedGodlog() {
  const found = findGodlogItem(state.selectedGodlogId);
  if (!found) {
    if (rowFromSyntheticGodlogId(state.selectedGodlogId)) {
      toastr?.warning?.('这楼还没有摘要记录，请点“重跑本楼摘要”或“自动补写缺失摘要”。', 'Anchor Memory');
      return;
    }
    toastr?.warning?.('请先选择一条逐楼摘要', 'Anchor Memory');
    return;
  }
  let body = normalizeGodlogBlock($('#am_godlog_detail').val());
  if (!body) {
    toastr?.warning?.('摘要内容不能为空', 'Anchor Memory');
    return;
  }
  const row = currentRowForGodlog(found.item);
  if (row) body = replaceGodlogField(body, 'Nub', String(godlogNumberForRow(row) || found.item.number || 1));
  const changedBody = body !== found.item.body;

  if (!changedBody) {
    if (row) preserveCompletedGodlogOnSourceChange(found.data, found.item, row, '楼层在摘要保存后发生了变化');
    saveMemory();
    updatePreview();
    scheduleGodlogPanelRender(row?.index ?? found.item.floor);
    toastr?.info?.('摘要内容没有改动，继续保留原保存版本；不会因为点“保存”而重新绑定当前正文。', 'Anchor Memory');
    return;
  }

  markAnchorsStaleByKey(found.data, found.item.key, '逐楼摘要被手动修改');
  delete found.data.messageRecalls?.[found.item.key];
  rollbackRelationshipToFloor(found.data, Math.max(-1, Number(found.item.floor || 0) - 1), '逐楼摘要被手动修改');
  markCodexDirty(found.data, '逐楼摘要被手动修改', true, false, Number(row?.index ?? found.item.floor ?? -1));

  Object.assign(found.item, {
    body,
    status: 'ready',
    stale: false,
    staleSince: 0,
    previousRawHash: '',
    currentRawHash: '',
    sourceMismatch: false,
    sourceMismatchReason: '',
    sourceMismatchAt: 0,
    rerunPending: false,
    rerunError: '',
    retryCount: 0,
    error: '',
    editedAt: Date.now(),
    updatedAt: Date.now(),
  });
  if (row) {
    Object.assign(found.item, {
      number: godlogNumberForRow(row) || found.item.number,
      floor: row.index,
      key: row.key,
      role: row.role,
      name: row.name,
      sendDate: row.sendDate,
      rawHash: row.rawHash,
    });
  }
  removeStoredVector(found.data, found.item.id);
  refreshCoverageMaps(found.data);
  saveMemory(true);
  await enforceAnchorHiddenState(found.data);
  scheduleCodexBacklog();
  await embedMemoryItem(found.data, found.item.id, safeGodlogMemoryText(found.item.body || ''));
  queueMemoryJob('逐楼摘要已修改', 120);
  updatePreview();
  toastr?.success?.('逐楼摘要已保存；依赖的锚点已按需回滚', 'Anchor Memory');
}

async function rerunSelectedGodlog() {
  const syntheticRow = rowFromSyntheticGodlogId(state.selectedGodlogId);
  if (syntheticRow) {
    if (isSummaryRowBusy(syntheticRow) || state.forcedSummaryReruns.has(syntheticRow.key)) {
      toastr?.info?.(`第 ${syntheticRow.index} 楼摘要任务已接收，不会重复提交。`, 'Anchor Memory');
      return;
    }
    const ok = await generateGodlogForRow(syntheticRow, true);
    const current = godlogForRow(memoryData(), syntheticRow);
    $('#am_godlog_detail').val(current?.body || current?.error || '');
    updatePreview();
    if (ok) toastr?.success?.(`第 ${syntheticRow.index} 楼摘要已生成`, 'Anchor Memory');
    else if (current?.rerunQueued || state.forcedSummaryReruns.has(syntheticRow.key)) toastr?.info?.('当前楼正文仍在生成或等待稳定；手动重跑已排队，稳定后会自动执行。', 'Anchor Memory');
    else if (current?.retryScheduledAt > Date.now()) toastr?.warning?.('本次摘要请求失败，插件已安排自动重试，不需要再次点击。', 'Anchor Memory');
    else toastr?.error?.(`本楼摘要未完成：${current?.rerunError || current?.error || memoryData()?.processing?.lastError || '请检查副API配置或控制台错误'}`, 'Anchor Memory');
    return;
  }
  const found = findGodlogItem(state.selectedGodlogId);
  if (!found) {
    toastr?.warning?.('请先选择一条逐楼摘要', 'Anchor Memory');
    return;
  }
  if (found.item.archived) {
    toastr?.warning?.('归档摘要没有当前楼层原文，不能重跑；可以手动编辑后保存。', 'Anchor Memory');
    return;
  }
  const row = chatRows(false).find(item => item.key === found.item.key);
  if (!row) {
    forgetGodlogItem(found.data, found.item, '原楼层已删除，无法重跑');
    saveMemory();
    updatePreview();
    toastr?.warning?.('原楼层已删除，已清理对应摘要', 'Anchor Memory');
    return;
  }
  if (isSummaryRowBusy(row) || state.forcedSummaryReruns.has(row.key)) {
    toastr?.info?.(`第 ${row.index} 楼摘要任务已接收，不会重复提交。`, 'Anchor Memory');
    return;
  }
  const ok = await generateGodlogForRow(row, true);
  const current = godlogForRow(memoryData(), row);
  $('#am_godlog_detail').val(current?.body || current?.error || '');
  updatePreview();
  if (ok) toastr?.success?.(`第 ${row.index} 楼摘要已重新生成`, 'Anchor Memory');
  else if (current?.rerunQueued || state.forcedSummaryReruns.has(row.key)) toastr?.info?.('当前楼正文仍在生成或等待稳定；手动重跑已排队，稳定后会自动执行。', 'Anchor Memory');
  else if (current?.retryScheduledAt > Date.now()) toastr?.warning?.('本次摘要请求失败，插件已安排自动重试，不需要再次点击。', 'Anchor Memory');
  else toastr?.error?.(`本楼摘要未完成：${current?.rerunError || current?.error || memoryData()?.processing?.lastError || '请检查副API配置或控制台错误'}`, 'Anchor Memory');
}

function deleteSelectedGodlog() {
  const found = findGodlogItem(state.selectedGodlogId);
  if (!found) {
    if (rowFromSyntheticGodlogId(state.selectedGodlogId)) {
      toastr?.warning?.('这楼还没有摘要记录，不需要删除；可直接自动补写。', 'Anchor Memory');
      return;
    }
    toastr?.warning?.('请先选择一条逐楼摘要', 'Anchor Memory');
    return;
  }
  if (!confirm('删除选中的逐楼摘要？依赖它的分段锚点和累计历史也会回滚，并在下次任务中重建。')) return;
  forgetGodlogItem(found.data, found.item, '逐楼摘要被手动删除');
  state.selectedGodlogId = '';
  $('#am_godlog_detail').val('');
  saveMemory(true);
  enforceAnchorHiddenState(found.data).catch(console.warn);
  queueMemoryJob('逐楼摘要已删除', 120);
  updatePreview();
  toastr?.success?.('逐楼摘要及其派生记忆已回滚', 'Anchor Memory');
}

function findMemoryItem(id) {
  const data = memoryData();
  const anchor = data.anchors.find(item => item.id === id);
  if (anchor) return { data, item: anchor, list: data.anchors, kind: 'anchor' };
  const merge = data.merges.find(item => item.id === id);
  if (merge) return { data, item: merge, list: data.merges, kind: 'merge' };
  return null;
}

async function saveSelectedMemory() {
  const found = findMemoryItem(state.selectedMemoryId);
  if (!found) {
    toastr?.warning?.('请先在时间线选择一条锚点或合并', 'Anchor Memory');
    return;
  }
  const body = $('#am_timeline_detail').val().trim();
  if (!body) {
    toastr?.warning?.('内容不能为空', 'Anchor Memory');
    return;
  }
  if (body === found.item.body) return;

  if (found.kind === 'anchor') {
    const keys = new Set(found.item.sourceKeys || []);
    let cascade = false;
    found.data.merges = found.data.merges.filter(merge => {
      const touches = (merge.sourceKeys || []).some(key => keys.has(key));
      if (cascade || touches) {
        cascade = true;
        removeStoredVector(found.data, merge.id);
        return false;
      }
      return true;
    });
  } else {
    const index = found.data.merges.findIndex(item => item.id === found.item.id);
    for (const merge of found.data.merges.slice(index + 1)) removeStoredVector(found.data, merge.id);
    found.data.merges = found.data.merges.slice(0, index + 1);
  }

  found.item.body = body;
  found.item.editedAt = Date.now();
  removeStoredVector(found.data, found.item.id);
  markCodexDirty(found.data, found.kind === 'anchor' ? '锚点被修改或删除' : '累计历史锚点被修改或删除');
  renumberDerivedMemory(found.data);
  refreshCoverageMaps(found.data);
  saveMemory(true);
  await enforceAnchorHiddenState(found.data);
  scheduleCodexBacklog();
  updatePreview();
  toastr?.success?.('记忆已保存；依赖它的后续合并已回滚', 'Anchor Memory');
}

async function deleteSelectedMemory() {
  const found = findMemoryItem(state.selectedMemoryId);
  if (!found) {
    toastr?.warning?.('请先在时间线选择一条锚点或合并', 'Anchor Memory');
    return;
  }
  if (!confirm('删除选中的锚点/合并？依赖它的后续合并会一起回滚。')) return;

  if (found.kind === 'anchor') {
    const keys = new Set(found.item.sourceKeys || []);
    found.data.anchors = found.data.anchors.filter(item => item.id !== found.item.id);
    let cascade = false;
    found.data.merges = found.data.merges.filter(merge => {
      const touches = (merge.sourceKeys || []).some(key => keys.has(key));
      if (cascade || touches) {
        cascade = true;
        removeStoredVector(found.data, merge.id);
        return false;
      }
      return true;
    });
  } else {
    const index = found.data.merges.findIndex(item => item.id === found.item.id);
    for (const merge of found.data.merges.slice(index)) removeStoredVector(found.data, merge.id);
    found.data.merges = found.data.merges.slice(0, Math.max(0, index));
  }

  removeStoredVector(found.data, found.item.id);
  markCodexDirty(found.data, found.kind === 'anchor' ? '锚点被修改或删除' : '累计历史锚点被修改或删除');
  renumberDerivedMemory(found.data);
  refreshCoverageMaps(found.data);
  state.selectedMemoryId = '';
  saveMemory(true);
  await enforceAnchorHiddenState(found.data);
  scheduleCodexBacklog();
  queueMemoryJob('派生记忆已删除', 120);
  updatePreview();
  toastr?.success?.('选中记忆及其依赖已回滚', 'Anchor Memory');
}

function compactArchiveSnapshot(data) {
  const snapshot = JSON.parse(JSON.stringify(data || defaultData()));
  snapshot.messageGodlogs = {};
  snapshot.messageRecalls = {};
  snapshot.vectorRefs = {};
  snapshot.vectors = {};
  snapshot.relationshipTable = normalizeRelationshipTable(snapshot.relationshipTable, snapshot.codex?.relationship || '');
  snapshot.relationshipTable.history = [];
  if (snapshot.codexBackup?.relationshipTable) snapshot.codexBackup.relationshipTable.history = [];
  snapshot.processing = {
    ...defaultData().processing,
    ...(snapshot.processing || {}),
    storageId: '',
    pendingPromptInjection: null,
    queueSources: [],
    busy: false,
    summaryBusy: false,
    codexBusy: false,
    queuePending: false,
    queueRunning: false,
    codexRetryAt: 0,
    codexRebuildCheckpoint: null,
    codexUnsafeFromFloor: null,
  };
  return snapshot;
}

function saveArchive() {
  const s = settings();
  const charName = currentCharacterName();
  const archiveName = ($('#am_archive_name').val() || '主线').trim();
  const data = memoryData();
  const sourceStorageId = ensureVectorStorageId(data);
  if (!s.slots[charName]) s.slots[charName] = {};
  s.slots[charName][archiveName] = {
    updatedAt: Date.now(),
    mode: 'snapshot',
    sourceStorageId,
    sourceAiTurns: currentTransferCoverageCount(data),
    data: compactArchiveSnapshot(data),
  };
  saveMemory(true);
  saveSettingsDebounced();
  renderArchiveCards();
  toastr?.success?.(`已保存记忆档案：${charName} / ${archiveName}。请在档案卡片点击“补齐并整理为累计历史”，整理完成后再转入新开场。`, 'Anchor Memory', {
    timeOut: 9000,
    extendedTimeOut: 4000,
    closeButton: true,
    tapToDismiss: true,
  });
}

function transferMergeSnapshot(merge, archivedCoverageCount = 0) {
  if (!merge) return null;
  const body = String(merge.body || '').replace(/^###\s*第\s*\d+\s*次全量合并锚点/m, '### 第 1 次全量合并锚点');
  return {
    ...JSON.parse(JSON.stringify(merge)),
    id: `am_archive_merge_${Date.now()}_${stableHash(body).slice(0, 6)}`,
    number: 1,
    body,
    sourceKeys: [],
    cycleSourceKeys: [],
    sourceAnchorIds: [],
    sourceGodlogIds: [],
    rawFallbackKeys: [],
    previousMergeId: '',
    intervalUsed: normalizeMergeAnchorInterval(settings().mergeAnchorInterval),
    mergeAnchorIntervalUsed: normalizeMergeAnchorInterval(settings().mergeAnchorInterval),
    cycleAnchorCount: 0,
    cycleSize: 0,
    coverageCount: 0,
    archivedCoverageCount: Number(archivedCoverageCount || merge.coverageCount || merge.sourceKeys?.length || 0),
    floorAt: -1,
    archiveBase: true,
    createdAt: Date.now(),
  };
}

function buildTransferArchiveSnapshot(data) {
  const snapshot = compactArchiveSnapshot(data);
  const finalMerge = latestMerge(snapshot);
  if (!finalMerge?.body) throw new Error('当前没有可用于转档的最终累计历史');
  const archivedCoverageCount = Math.max(
    Number(finalMerge.coverageCount || 0),
    Number(finalMerge.sourceKeys?.length || 0),
    currentTransferCoverageCount(data),
  );
  const transferMerge = transferMergeSnapshot(finalMerge, archivedCoverageCount);
  snapshot.godlogs = [];
  snapshot.anchors = [];
  snapshot.merges = [transferMerge];
  snapshot.messageGodlogs = {};
  snapshot.messageRecalls = {};
  snapshot.vectorRefs = {};
  snapshot.vectors = {};
  snapshot.codexBackup = null;
  snapshot.relationshipTable = normalizeRelationshipTable(snapshot.relationshipTable, snapshot.codex?.relationship || '');
  snapshot.relationshipTable.history = [];
  snapshot.relationshipTable.lastGoodFloor = -1;
  snapshot.relationshipTable.lastGoodKey = '';
  snapshot.timeline = {
    ...(snapshot.timeline || defaultData().timeline),
    currentSourceKey: '',
    currentFloor: -1,
    warnings: [],
    history: [],
    updatedAt: Date.now(),
  };
  snapshot.processing = {
    ...defaultData().processing,
    storageId: '',
    godlogCount: 0,
    anchorCount: 0,
    mergeCount: 1,
    lastAnchorFloor: -1,
    lastMergeFloor: -1,
    archiveImported: false,
  };
  return snapshot;
}

async function finalizeArchiveForTransfer(archiveName = '') {
  const s = settings();
  const charName = currentCharacterName();
  archiveName = archiveName || $('#am_archive_name').val().trim();
  const archive = s.slots?.[charName]?.[archiveName];
  if (!archiveName || !archive) {
    toastr?.warning?.(`找不到 ${charName} 的这个记忆档案`, 'Anchor Memory');
    return false;
  }
  if (!settings().enabled) {
    toastr?.warning?.('锚点书当前已暂停，请先启动插件再整理档案。', 'Anchor Memory');
    return false;
  }
  const data = memoryData();
  if (!archiveMatchesCurrentChat(archive, data)) {
    toastr?.warning?.('这个档案不是从当前聊天保存的，无法在这里补写原楼层摘要。请回到原聊天，或在当前聊天重新保存一个档案。', 'Anchor Memory');
    return false;
  }
  if (state.archiveRunning || state.running || state.anchorPreparing || state.mergeRunning || state.summaryRunning || state.jobRunning || data.processing?.busy || data.processing?.summaryBusy || data.processing?.mergeBusy) {
    toastr?.warning?.('已有摘要、锚点、合并或归档整理任务正在运行，请完成当前任务后再点击。', 'Anchor Memory');
    return false;
  }
  if (generationIsActiveForGodlog(latestAssistantRow())) {
    toastr?.warning?.('当前AI回复仍在生成，不能归档最终版本；请在本楼正文完成后再点击。', 'Anchor Memory');
    return false;
  }
  const pendingCount = missingGodlogRepairRows(data).length;
  const unmergedCount = mergeCycleMaterials(data).length;
  if ((pendingCount > 0 || unmergedCount > 0) && (!secondaryConfigured(s))) {
    toastr?.warning?.('当前档案仍有待补摘要或待合并内容，请先配置并启用副API后再整理。', 'Anchor Memory');
    return false;
  }
  if (!latestMerge(data)?.body && unmergedCount === 0) {
    toastr?.warning?.('当前聊天没有可整理的累计记忆。', 'Anchor Memory');
    return false;
  }
  if (!confirm(`将整理档案「${charName} / ${archiveName}」：\n\n1. 补齐当前聊天全部缺失或失效的逐楼摘要（${pendingCount} 楼）；\n2. 把尚未并入累计历史的 ${unmergedCount} 个AI回合做最后一次累计历史整理；\n3. 用“最终累计历史 + 人物关系/人物/物品/场景状态”覆盖此档案；\n4. 不把旧档逐楼摘要和旧分段锚点带入新开场。\n\n继续？`)) return false;

  const contextToken = captureChatContextToken(data);
  const operationEpoch = state.contextEpoch;
  state.archiveRunning = true;
  showStatus(`正在整理档案：${archiveName}`);
  try {
    if (pendingCount > 0) {
      const repaired = await repairMissingGodlogs(Number.MAX_SAFE_INTEGER);
      if (!repaired || !isSameChatContext(contextToken)) return false;
    }

    const fresh = memoryData();
    const remaining = missingGodlogRepairRows(fresh);
    if (remaining.length > 0) {
      const floors = remaining.slice(0, 6).map(row => `第${row.index}楼`).join('、');
      throw new Error(`${floors}${remaining.length > 6 ? `等${remaining.length}楼` : ''}仍没有有效逐楼摘要；档案未被覆盖`);
    }

    if (mergeCycleMaterials(fresh).length > 0) {
      const merged = await maybeMerge(true, false, normalizeMergeAnchorInterval(s.mergeAnchorInterval));
      if (!merged || !isSameChatContext(contextToken)) throw new Error('最终累计历史没有完成；档案未被覆盖');
    }

    const finalData = memoryData();
    if (!latestMerge(finalData)?.body) throw new Error('没有生成最终累计历史；档案未被覆盖');
    const sourceAiTurns = currentTransferCoverageCount(finalData);
    s.slots[charName][archiveName] = {
      ...archive,
      updatedAt: Date.now(),
      finalizedAt: Date.now(),
      mode: 'full-merge',
      sourceStorageId: String(finalData.processing?.storageId || archive.sourceStorageId || ''),
      sourceAiTurns,
      data: buildTransferArchiveSnapshot(finalData),
    };
    saveSettingsDebounced();
    renderArchiveCards();
    toastr?.success?.(`档案「${archiveName}」已完成最终全量整理：旧逐楼摘要与旧分段锚点不会带入新开场，新聊天可从第1楼重新计数。`, 'Anchor Memory', {
      timeOut: 10000,
      extendedTimeOut: 5000,
      closeButton: true,
      tapToDismiss: true,
    });
    return true;
  } catch (err) {
    toastr?.error?.(`归档整理失败：${err.message}`, 'Anchor Memory');
    return false;
  } finally {
    if (state.contextEpoch === operationEpoch) state.archiveRunning = false;
    if (isSameChatContext(contextToken)) {
      showStatus(statusText(memoryData()));
      if (state.jobSources.size > 0) queueMemoryJob('归档整理结束后续跑', 120);
    }
  }
}

function portableArchiveData(data, archive = null) {
  const source = JSON.parse(JSON.stringify(data || defaultData()));
  const finalMerge = latestMerge(source);
  if (!finalMerge?.body) throw new Error('这个档案没有最终累计全量记忆');
  const loaded = source;
  loaded.godlogs = [];
  loaded.anchors = [];
  loaded.merges = [transferMergeSnapshot(finalMerge, archiveCoverageCount(archive || { data: source }))];
  loaded.processing = {
    ...defaultData().processing,
    archiveImported: true,
    archiveImportedAt: Date.now(),
    archiveSourceAiTurns: archiveCoverageCount(archive || { data: source }),
    storageId: '',
    mergeCount: 1,
  };
  loaded.messageGodlogs = {};
  loaded.messageRecalls = {};
  loaded.vectorRefs = {};
  loaded.vectors = {};
  loaded.relationshipTable = normalizeRelationshipTable(loaded.relationshipTable, loaded.codex?.relationship || '');
  loaded.relationshipTable.history = [];
  loaded.relationshipTable.lastGoodFloor = -1;
  loaded.relationshipTable.lastGoodKey = '';
  loaded.codexBackup = null;
  loaded.timeline = {
    ...(loaded.timeline || defaultData().timeline),
    currentSourceKey: '',
    currentFloor: -1,
    warnings: [],
    history: [],
    updatedAt: Date.now(),
  };
  return loaded;
}

async function loadArchive(archiveName = '') {
  const s = settings();
  const charName = currentCharacterName();
  archiveName = archiveName || $('#am_archive_name').val().trim();
  const archive = s.slots?.[charName]?.[archiveName];
  if (!archiveName || !archive) {
    toastr?.warning?.(`找不到 ${charName} 的这个记忆档案`, 'Anchor Memory');
    return;
  }
  if (!archiveIsTransferReady(archive)) {
    toastr?.warning?.('这个档案还没有完成“补齐并整理为累计历史”，为避免旧档第1楼与新档第1楼混淆，当前禁止直接加载。请先回原聊天完成全量整理。', 'Anchor Memory');
    return;
  }
  if (archiveMatchesCurrentChat(archive, hasPersistentChatContext() ? memoryData() : null)) {
    toastr?.warning?.('这是该档案的原聊天。为防止精简转档副本覆盖原聊天的逐楼摘要、分段锚点和详细状态，当前禁止加载回原聊天；请到新的开场聊天中加载。', 'Anchor Memory');
    return;
  }
  if (!confirm(`加载档案「${charName} / ${archiveName}」会替换当前聊天内的 Anchor Memory 数据。将只带入最终累计全量记忆和人物、物品、场景状态，不带入旧逐楼摘要。继续？`)) return;
  const ctx = getContext();
  if (!ctx.chatMetadata) ctx.chatMetadata = {};
  try {
    ctx.chatMetadata[DATA_KEY] = portableArchiveData(archive.data, archive);
  } catch (err) {
    toastr?.error?.(`档案加载失败：${err.message}`, 'Anchor Memory');
    return;
  }
  invalidateMemoryDataCache();
  invalidateRuntimeCaches('archive loaded');
  const data = memoryData();
  saveMemory(true);
  await enforceAnchorHiddenState(data);
  await injectMemory();
  updatePreview();
  toastr?.success?.(`已加载全量整理档案：${charName} / ${archiveName}。旧档楼层不会出现在逐楼摘要列表，新开场从第1楼独立计数。`, 'Anchor Memory');
}

function deleteArchive(archiveName = '') {
  const s = settings();
  const charName = currentCharacterName();
  archiveName = archiveName || $('#am_archive_name').val().trim();
  if (!archiveName || !s.slots?.[charName]?.[archiveName]) return;
  if (!confirm(`删除记忆档案「${charName} / ${archiveName}」？`)) return;
  delete s.slots[charName][archiveName];
  saveSettingsDebounced();
  renderArchiveCards();
  toastr?.success?.('记忆档案已删除', 'Anchor Memory');
}

async function rebuildVectors() {
  const data = memoryData();
  if (!embeddingConfigured()) {
    toastr?.warning?.('请先配置副API并启用Embedding', 'Anchor Memory');
    return;
  }
  await clearStoredVectors(data);
  saveMemory();
  showStatus('正在重建向量...');
  for (const source of recallCorpus(data)) {
    if (source?.item?.id && source.text) await embedMemoryItem(data, source.item.id, source.text);
  }
  toastr?.success?.('向量重建完成：仅索引可被动态召回的逐楼摘要与原文保底', 'Anchor Memory');
  updatePreview();
}

function normalizeSecondaryPresetName(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

function makeSecondaryPresetId() {
  try {
    if (globalThis.crypto?.randomUUID) return `secondary-${globalThis.crypto.randomUUID()}`;
  } catch {}
  return `secondary-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeSecondaryPresetRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const name = normalizeSecondaryPresetName(record.name);
  if (!name) return null;
  const models = [...new Set((Array.isArray(record.models) ? record.models : [])
    .map(value => String(value || '').trim())
    .filter(Boolean))].slice(0, 500);
  const createdAt = Number(record.createdAt) > 0 ? Number(record.createdAt) : Date.now();
  const updatedAt = Number(record.updatedAt) > 0 ? Number(record.updatedAt) : createdAt;
  return {
    id: String(record.id || '').trim() || makeSecondaryPresetId(),
    name,
    url: String(record.url || '').trim(),
    key: String(record.key || ''),
    model: String(record.model || '').trim(),
    models,
    createdAt,
    updatedAt,
  };
}

function normalizeSecondaryPresetList(value) {
  const result = [];
  const ids = new Set();
  const names = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    const preset = normalizeSecondaryPresetRecord(raw);
    if (!preset) continue;
    const normalizedName = preset.name.toLocaleLowerCase();
    if (ids.has(preset.id) || names.has(normalizedName)) continue;
    ids.add(preset.id);
    names.add(normalizedName);
    result.push(preset);
    if (result.length >= 50) break;
  }
  return result;
}

function secondaryPresetSnapshot(s = settings()) {
  return {
    url: String(s.secondaryUrl || '').trim(),
    key: String(s.secondaryKey || ''),
    model: String(s.secondaryModel || '').trim(),
    models: [...new Set((Array.isArray(s.secondaryModels) ? s.secondaryModels : [])
      .map(value => String(value || '').trim())
      .filter(Boolean))].slice(0, 500),
  };
}

function bumpSecondaryConfigRevision() {
  state.secondaryConfigRevision = Math.max(0, Number(state.secondaryConfigRevision) || 0) + 1;
  return state.secondaryConfigRevision;
}

function secondaryPresetConfigEquals(preset, s = settings()) {
  if (!preset) return false;
  const current = secondaryPresetSnapshot(s);
  return preset.url === current.url
    && preset.key === current.key
    && preset.model === current.model
    && JSON.stringify(preset.models || []) === JSON.stringify(current.models || []);
}

function activeSecondaryPreset(s = settings()) {
  return (s.secondaryPresets || []).find(item => item.id === String(s.activeSecondaryPresetId || '')) || null;
}

function updateSecondaryPresetStatus() {
  const status = $('#am_secondary_preset_status');
  if (!status.length) return;
  const s = settings();
  const preset = activeSecondaryPreset(s);
  status.removeClass('am-preset-dirty am-preset-ready');
  if (!preset) {
    const count = (s.secondaryPresets || []).length;
    status.text(count ? `已保存 ${count} 个预设；当前字段未绑定预设。` : '尚未保存副API预设。');
    return;
  }
  if (secondaryPresetConfigEquals(preset, s)) {
    status.addClass('am-preset-ready').text(`正在使用预设「${preset.name}」。`);
  } else {
    status.addClass('am-preset-dirty').text(`预设「${preset.name}」已载入，但当前字段有未保存修改。`);
  }
}

function renderSecondaryPresetOptions({ preserveNameInput = false } = {}) {
  const s = settings();
  const select = $('#am_secondary_preset_select');
  if (!select.length) return;
  const previousName = preserveNameInput ? String($('#am_secondary_preset_name').val() || '') : '';
  select.empty().append($('<option>').val('').text('不使用已保存预设'));
  for (const preset of s.secondaryPresets || []) {
    select.append($('<option>').val(preset.id).text(preset.name));
  }
  select.val(activeSecondaryPreset(s)?.id || '');
  if (preserveNameInput) $('#am_secondary_preset_name').val(previousName);
  else $('#am_secondary_preset_name').val(activeSecondaryPreset(s)?.name || '');
  updateSecondaryPresetStatus();
}

function loadSecondaryPreset(presetId) {
  const s = settings();
  const id = String(presetId || '');
  if (!id) {
    s.activeSecondaryPresetId = '';
    saveSettingsDebounced();
    $('#am_secondary_preset_name').val('');
    updateSecondaryPresetStatus();
    return;
  }
  const preset = (s.secondaryPresets || []).find(item => item.id === id);
  if (!preset) {
    s.activeSecondaryPresetId = '';
    saveSettingsDebounced();
    renderSecondaryPresetOptions();
    toastr?.warning?.('所选副API预设已经不存在。', 'Anchor Memory');
    return;
  }

  // Do not abort active memory writers: their result is still valid for the same chat facts.
  // Instead, advance the connection revision so any older model-list result is ignored on arrival.
  clearRecallPrefetch();

  s.secondaryUrl = preset.url;
  s.secondaryKey = preset.key;
  s.secondaryModel = preset.model;
  s.secondaryModels = [...(preset.models || [])];
  s.activeSecondaryPresetId = preset.id;
  bumpSecondaryConfigRevision();
  saveSettingsDebounced();

  $('#am_secondary_url').val(s.secondaryUrl);
  $('#am_secondary_key').val(s.secondaryKey);
  updateSecondaryProviderHint(s.secondaryUrl);
  $('#am_secondary_model').val(s.secondaryModel);
  renderModelOptions('#am_secondary_model_options', s.secondaryModels);
  $('#am_secondary_preset_name').val(preset.name);
  updateSecondaryPresetStatus();
  updatePreview();
  toastr?.success?.(`已切换到副API预设「${preset.name}」`, 'Anchor Memory');
  if (s.useSecondary && secondaryConfigured(s)) queueMemoryJob(`已切换副API预设「${preset.name}」`, 180);
}

function saveSecondaryPreset({ overwriteActive = false } = {}) {
  const s = syncSecondaryInputsFromUi({ clearModel: false });
  const name = normalizeSecondaryPresetName($('#am_secondary_preset_name').val());
  if (!name) {
    toastr?.warning?.('请先填写预设名称。', 'Anchor Memory');
    $('#am_secondary_preset_name').trigger('focus');
    return;
  }
  const snapshot = secondaryPresetSnapshot(s);
  if (!snapshot.url || !snapshot.key) {
    toastr?.warning?.('至少填写副API地址和密钥后才能保存预设。', 'Anchor Memory');
    return;
  }

  let target = overwriteActive ? activeSecondaryPreset(s) : null;
  const sameName = (s.secondaryPresets || []).find(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  if (overwriteActive && !target) {
    toastr?.warning?.('请先从下拉框选择要覆盖的预设。', 'Anchor Memory');
    return;
  }
  if (sameName && (!target || sameName.id !== target.id)) {
    if (overwriteActive) {
      toastr?.warning?.(`预设名称「${sameName.name}」已被其他预设使用，请换一个名称。`, 'Anchor Memory');
      return;
    }
    if (!confirm(`已经存在名为「${sameName.name}」的副API预设，是否覆盖它？`)) return;
    target = sameName;
  }

  const now = Date.now();
  const record = {
    id: target?.id || makeSecondaryPresetId(),
    name,
    ...snapshot,
    createdAt: target?.createdAt || now,
    updatedAt: now,
  };
  const next = [...(s.secondaryPresets || [])];
  const index = next.findIndex(item => item.id === record.id);
  if (index >= 0) next[index] = record;
  else next.push(record);
  s.secondaryPresets = normalizeSecondaryPresetList(next);
  s.activeSecondaryPresetId = record.id;
  saveSettingsDebounced();
  renderSecondaryPresetOptions();
  toastr?.success?.(`${target ? '已更新' : '已保存'}副API预设「${record.name}」`, 'Anchor Memory');
}

function deleteSecondaryPreset() {
  const s = settings();
  const preset = activeSecondaryPreset(s);
  if (!preset) {
    toastr?.warning?.('请先选择要删除的副API预设。', 'Anchor Memory');
    return;
  }
  if (!confirm(`删除副API预设「${preset.name}」？当前输入框里的配置不会被清空。`)) return;
  s.secondaryPresets = (s.secondaryPresets || []).filter(item => item.id !== preset.id);
  s.activeSecondaryPresetId = '';
  saveSettingsDebounced();
  renderSecondaryPresetOptions();
  toastr?.success?.(`已删除副API预设「${preset.name}」`, 'Anchor Memory');
}

function syncSecondaryInputsFromUi({ clearModel = false } = {}) {
  const s = settings();
  const before = JSON.stringify(secondaryPresetSnapshot(s));
  const urlInput = $('#am_secondary_url');
  const keyInput = $('#am_secondary_key');
  const modelInput = $('#am_secondary_model');
  if (urlInput.length) {
    const typedUrl = String(urlInput.val() || '').trim();
    s.secondaryUrl = baseApiUrl(typedUrl);
    if (typedUrl && s.secondaryUrl && typedUrl !== s.secondaryUrl) urlInput.val(s.secondaryUrl);
    updateSecondaryProviderHint(s.secondaryUrl);
  }
  if (keyInput.length) s.secondaryKey = String(keyInput.val() || '').trim();
  if (clearModel) {
    s.secondaryModel = '';
    s.secondaryModels = [];
    modelInput.val('');
    renderModelOptions('#am_secondary_model_options', []);
  } else if (modelInput.length) {
    s.secondaryModel = String(modelInput.val() || '').trim();
  }
  if (before !== JSON.stringify(secondaryPresetSnapshot(s))) bumpSecondaryConfigRevision();
  saveSettingsDebounced();
  return s;
}

function syncEmbeddingInputsFromUi({ clearModel = false } = {}) {
  const s = settings();
  const urlInput = $('#am_embedding_url');
  const keyInput = $('#am_embedding_key');
  const modelInput = $('#am_embedding_model');
  if (urlInput.length) s.embeddingUrl = String(urlInput.val() || '').trim();
  if (keyInput.length) s.embeddingKey = String(keyInput.val() || '').trim();
  if (clearModel) {
    s.embeddingModel = '';
    s.embeddingModels = [];
    modelInput.val('');
    renderModelOptions('#am_embedding_model_options', []);
  } else if (modelInput.length) {
    s.embeddingModel = String(modelInput.val() || '').trim();
  }
  saveSettingsDebounced();
  return s;
}

function setButtonBusy(selector, busy, busyText = '') {
  const button = $(selector);
  if (!button.length) return;
  if (busy) {
    if (button.data('am-original-text') === undefined) button.data('am-original-text', button.text());
    button.prop('disabled', true);
    if (busyText) button.text(busyText);
  } else {
    button.prop('disabled', false);
    const original = button.data('am-original-text');
    if (original !== undefined) button.text(original);
    button.removeData('am-original-text');
  }
}

function selectFetchedModel(current, models) {
  const value = String(current || '').trim();
  if (!Array.isArray(models) || models.length === 0) return value;
  return models.includes(value) ? value : models[0];
}

async function fetchSecondaryModels() {
  // Read the DOM synchronously before the mobile keyboard/blur lifecycle can leave settings stale.
  // Do NOT clear a manually-entered model merely because /models is unsupported: some otherwise
  // valid OpenAI-compatible providers (or account tiers) require users to copy the model ID from
  // their console. A revision guard still prevents stale results overwriting a changed connection.
  const s = syncSecondaryInputsFromUi({ clearModel: false });
  const requestRevision = Number(state.secondaryConfigRevision) || 0;
  if (!s.secondaryUrl || !s.secondaryKey) {
    toastr?.warning?.('请先填写副API地址和密钥', 'Anchor Memory');
    return;
  }
  setButtonBusy('#am_fetch_secondary_models', true, '正在拉取…');
  try {
    showStatus('正在通过酒馆后端拉取副API模型...');
    const models = await fetchProviderModels(s.secondaryUrl, s.secondaryKey, 'chat');
    if (requestRevision !== Number(state.secondaryConfigRevision || 0)) {
      console.info('[AnchorMemory] ignored stale secondary model list after connection changed');
      return;
    }
    s.secondaryModels = models;
    s.secondaryModel = selectFetchedModel(s.secondaryModel, models);
    bumpSecondaryConfigRevision();
    saveSettingsDebounced();
    renderModelOptions('#am_secondary_model_options', models);
    $('#am_secondary_model').val(s.secondaryModel);
    updateSecondaryPresetStatus();
    if (secondaryConfigured(s)) queueMemoryJob('副API模型已配置，继续补齐记忆', 180);
    toastr?.success?.(`已拉取 ${models.length} 个副API模型，并自动选择 ${s.secondaryModel}`, 'Anchor Memory');
  } catch (err) {
    if (requestRevision !== Number(state.secondaryConfigRevision || 0) || err?.code === 'AM_REQUEST_CANCELLED') {
      console.info('[AnchorMemory] secondary model pull cancelled or superseded; current configuration preserved');
      return;
    }
    const info = openAiCompatibleProviderInfo(s.secondaryUrl);
    toastr?.error?.(`模型拉取失败：${err.message}。${info.name} 若未开放标准 /models 列表，可直接保留并手动填写控制台中的准确模型 ID；现有模型不会被清空。`, 'Anchor Memory');
  } finally {
    setButtonBusy('#am_fetch_secondary_models', false);
    updateSecondaryPresetStatus();
    updatePreview();
  }
}

async function fetchEmbeddingModels() {
  const s = syncEmbeddingInputsFromUi({ clearModel: true });
  const url = s.embeddingUrl || s.secondaryUrl;
  const key = s.embeddingKey || s.secondaryKey;
  if (!url || !key) {
    toastr?.warning?.('请先填写Embedding API地址和密钥', 'Anchor Memory');
    return;
  }
  setButtonBusy('#am_fetch_embedding_models', true, '正在拉取…');
  try {
    showStatus('正在拉取Embedding模型...');
    const models = await fetchProviderModels(url, key, 'embedding');
    s.embeddingModels = models;
    s.embeddingModel = selectFetchedModel('', models);
    saveSettingsDebounced();
    renderModelOptions('#am_embedding_model_options', models);
    $('#am_embedding_model').val(s.embeddingModel).trigger('change');
    toastr?.success?.(`已拉取 ${models.length} 个Embedding模型`, 'Anchor Memory');
  } catch (err) {
    s.embeddingModels = [];
    s.embeddingModel = '';
    saveSettingsDebounced();
    $('#am_embedding_model').val('');
    renderModelOptions('#am_embedding_model_options', []);
    toastr?.error?.(`模型拉取失败：${err.message}`, 'Anchor Memory');
  } finally {
    setButtonBusy('#am_fetch_embedding_models', false);
    updatePreview();
  }
}

function applySiliconFlowEmbeddingPreset() {
  const s = settings();
  s.useEmbedding = true;
  s.embeddingUrl = 'https://api.siliconflow.cn/v1';
  if (!s.embeddingKey && s.secondaryKey) s.embeddingKey = s.secondaryKey;
  s.embeddingModel = s.embeddingModel || 'BAAI/bge-m3';
  if (!s.embeddingModel || /text-embedding-3/i.test(s.embeddingModel)) s.embeddingModel = 'BAAI/bge-m3';
  s.embeddingDimensionsMode = 'never';
  saveSettingsDebounced();
  loadUi();
  toastr?.success?.('已套用硅基流动向量配置：默认不发送 dimensions', 'Anchor Memory');
}

async function testEmbedding() {
  syncSecondaryInputsFromUi();
  syncEmbeddingInputsFromUi();
  if (!embeddingConfigured()) {
    toastr?.warning?.('请先启用Embedding，并填写Embedding API或副API', 'Anchor Memory');
    return;
  }
  try {
    showStatus('正在测试向量接口...');
    const [vector] = await embedTexts(['锚点记忆测试']);
    const hasDimensions = Object.prototype.hasOwnProperty.call(embeddingRequestBody(['test']), 'dimensions');
    toastr?.success?.(`向量接口可用，返回 ${vector?.length || 0} 维；dimensions ${hasDimensions ? '已发送' : '未发送'}`, 'Anchor Memory');
  } catch (err) {
    toastr?.error?.(`向量测试失败：${err.message}`, 'Anchor Memory');
  } finally {
    updatePreview();
  }
}

async function testSecondary() {
  const s = syncSecondaryInputsFromUi();
  if (!secondaryConfigured(s)) {
    toastr?.warning?.('请先启用副API并填写地址、密钥和模型', 'Anchor Memory');
    return;
  }
  try {
    showStatus('正在测试副API...');
    const text = await callSecondary([
      { role: 'system', content: '你是连接测试助手。' },
      { role: 'user', content: '请只回复：连接成功' },
    ], 50);
    const info = openAiCompatibleProviderInfo(s.secondaryUrl);
    toastr?.success?.(`${info.name} 可用：${text.slice(0, 80)}`, 'Anchor Memory');
  } catch (err) {
    toastr?.error?.(`副API测试失败：${err.message}`, 'Anchor Memory');
  } finally {
    updatePreview();
  }
}

function renderRelationshipEditor(data = memoryData()) {
  const container = $('#am_relationship_rows');
  if (!container.length) return;
  const table = normalizeRelationshipTable(data.relationshipTable, data.codex?.relationship || '');
  container.empty();
  for (const row of table.rows) {
    const displayName = renderMacros(row.name);
    container.append(`
      <tr data-relationship-id="${escapeHtml(row.id)}">
        <td>
          ${row.locked
            ? `<div class="am-relationship-locked-name"><b>${escapeHtml(displayName)}</b><small>自动绑定主角色</small></div>`
            : `<input class="text_pole am-relationship-name" type="text" value="${escapeHtml(row.name)}" aria-label="关系人物名称" />`}
        </td>
        <td>${escapeHtml(renderMacros(row.past || '未明'))}</td>
        <td>${escapeHtml(renderMacros(row.development || '未明'))}</td>
        <td>${escapeHtml(renderMacros(row.current || '未明'))}</td>
        <td>${row.locked ? '<span class="am-pill">固定</span>' : '<button type="button" class="am-delete-relationship-row">删除</button>'}</td>
      </tr>
    `);
  }
  const status = data.processing?.relationshipDirty
    ? `关系表待重建：${data.processing.relationshipDirtyReason || '固定名单或剧情来源已变化'}。固定行不会丢失；主模型会继续使用已回退的安全快照，最新等待生成摘要的楼层暂不计入。`
    : `关系表已持久化，共 ${table.rows.length} 行${table.lastGoodFloor >= 0 ? `；最近有效快照到第 ${table.lastGoodFloor + 1} 楼` : ''}。`;
  $('#am_relationship_status').text(status)
    .toggleClass('am-warning-text', !!data.processing?.relationshipDirty);
}

function addRelationshipRow() {
  const data = memoryData();
  const input = $('#am_relationship_new_name');
  const name = cleanRelationshipCell(input.val(), 120);
  if (!name) {
    toastr?.warning?.('请先填写要追踪的人物名称。', 'Anchor Memory');
    return false;
  }
  const table = normalizeRelationshipTable(data.relationshipTable, data.codex?.relationship || '');
  const key = relationshipNameKey(name);
  if (!key || table.rows.some(row => relationshipNameKey(row.name) === key)) {
    toastr?.warning?.('该人物已在固定关系表中，不能重复添加。', 'Anchor Memory');
    return false;
  }
  snapshotCodex(data, '新增固定人物关系行前备份');
  table.rows.push({
    id: relationshipRowId(name),
    name,
    locked: false,
    past: '',
    development: '',
    current: '',
    createdAt: Date.now(),
    updatedAt: 0,
  });
  table.history = [];
  data.relationshipTable = table;
  data.codex.relationship = relationshipTableMarkdown(table, false);
  markRelationshipDirty(data, `新增固定关系人物“${renderMacros(name)}”，等待根据当前有效剧情回填`);
  saveMemory(true);
  input.val('');
  scheduleCodexBacklog(4);
  updatePreview();
  return true;
}

function saveRelationshipNames() {
  const data = memoryData();
  const table = normalizeRelationshipTable(data.relationshipTable, data.codex?.relationship || '');
  const byId = new Map(table.rows.map(row => [row.id, row]));
  const proposed = [];
  let invalid = '';
  $('#am_relationship_rows tr').each(function () {
    const id = String($(this).data('relationship-id') || '');
    const row = byId.get(id);
    if (!row) return;
    const name = row.locked ? '{{char}}' : cleanRelationshipCell($(this).find('.am-relationship-name').val(), 120);
    if (!name && !invalid) invalid = '人物名称不能为空。';
    proposed.push({ row, name });
  });
  if (invalid) {
    toastr?.warning?.(invalid, 'Anchor Memory');
    return false;
  }
  const seen = new Set();
  for (const item of proposed) {
    const key = relationshipNameKey(item.name);
    if (!key || seen.has(key)) {
      toastr?.warning?.('固定关系表中存在重名人物，请修改后再保存。', 'Anchor Memory');
      return false;
    }
    seen.add(key);
  }
  const schemaChanged = proposed.some(({ row, name }) => row.name !== name);
  if (schemaChanged) snapshotCodex(data, '修改固定人物关系名单前备份');
  for (const { row, name } of proposed) {
    if (row.name === name) continue;
    row.name = name;
    row.past = '';
    row.development = '';
    row.current = '';
    row.updatedAt = 0;
  }
  if (schemaChanged) {
    table.history = [];
    markRelationshipDirty(data, '固定人物关系名单被改名，等待根据当前有效剧情重新回填');
  }
  data.relationshipTable = table;
  data.codex.relationship = relationshipTableMarkdown(table, false);
  saveMemory(true);
  if (schemaChanged) scheduleCodexBacklog(4);
  updatePreview();
  toastr?.success?.('固定人物关系名单已保存', 'Anchor Memory');
  return true;
}

function deleteRelationshipRow(id) {
  const data = memoryData();
  const table = normalizeRelationshipTable(data.relationshipTable, data.codex?.relationship || '');
  const row = table.rows.find(item => item.id === id);
  if (!row || row.locked) return false;
  if (!confirm(`从固定人物关系表删除“${renderMacros(row.name)}”？只删除该关系行，不删除人物库。`)) return false;
  snapshotCodex(data, '删除固定人物关系行前备份');
  table.rows = table.rows.filter(item => item.id !== id);
  for (const snapshot of table.history || []) delete snapshot.states?.[id];
  data.relationshipTable = table;
  data.codex.relationship = relationshipTableMarkdown(table, false);
  saveMemory(true);
  injectMemory().catch(console.warn);
  updatePreview();
  toastr?.success?.('关系行已删除', 'Anchor Memory');
  return true;
}

async function saveTrackedCharacterSettings() {
  const data = memoryData();
  const next = parseTrackedCharacterInput($('#am_tracked_characters').val());
  const before = JSON.stringify(data.trackedCharacters || []);
  data.trackedCharacters = next;
  // Apply the whitelist immediately so a previously leaked {{user}} row disappears before the
  // background rebuild. The last known valid values for retained protagonists are preserved.
  data.codex.characterMemo = sanitizeCharacterMemoSection(data, data.codex.characterMemo);
  data.codex.peopleIndex = sanitizePeopleIndexSection(data, data.codex.peopleIndex);
  if (before !== JSON.stringify(next)) markCodexDirty(data, '人物纪要追踪名单已变化，需要按当前有效剧情安全重建', true, false, 0);
  saveMemory(true);
  updatePreview();
  await injectMemory().catch(console.warn);
  const s = settings();
  if (secondaryConfigured(s)) {
    const rebuilt = await rebuildCodexFromGodlogs(false);
    if (rebuilt) toastr?.success?.(`已保存追踪名单：${trackedCharacterLabel(memoryData())}`, 'Anchor Memory');
    else toastr?.warning?.('追踪名单已保存；索引仍在等待安全重建。', 'Anchor Memory');
  } else {
    toastr?.warning?.(`追踪名单已保存：${trackedCharacterLabel(data)}。配置副API后请点“安全重建人物/物品/场景索引”。`, 'Anchor Memory');
  }
}

function saveCharacterEdits() {
  const data = memoryData();
  data.codex.characterMemo = sanitizeCharacterMemoSection(data, $('#am_character_memo_edit').val().trim());
  data.codex.peopleIndex = sanitizePeopleIndexSection(data, $('#am_people_edit').val().trim());
  saveMemory();
  updatePreview();
  toastr?.success?.('人物记忆已保存，并已按追踪白名单过滤', 'Anchor Memory');
}

function saveItemEdits() {
  const data = memoryData();
  const before = data.codex.itemIndex || '';
  const rawInput = $('#am_items_edit').val().trim();
  const entities = ensureEntityState(data);
  for (const row of parseMarkdownTable(rawInput)) {
    const name = firstTableValue(row, ['物品/细节/内部梗', '物品', '细节', '内部梗'], ['物品', '细节', '内部梗']);
    if (name) delete entities.itemTombstones[entityKey(name)];
  }
  const candidate = sanitizeItemIndexSection(data, rawInput);
  markManualEntityDeletions(data, 'items', before, candidate);
  data.codex.itemIndex = sanitizeItemIndexSection(data, candidate);
  syncEntityLedgers(data, { manualItems: true });
  saveMemory(true);
  injectMemory().catch(err => console.warn('[AnchorMemory] inject after item edit failed', err));
  updatePreview();
  toastr?.success?.('物品/梗/伏笔已保存；手动删除项已建立防复活标记', 'Anchor Memory');
}

function saveSceneEdits() {
  const data = memoryData();
  const before = data.codex.sceneIndex || '';
  const rawInput = $('#am_scenes_edit').val().trim();
  const entities = ensureEntityState(data);
  for (const row of parseMarkdownTable(rawInput)) {
    const name = firstTableValue(row, ['场景/地点', '场景', '地点', '名称'], ['场景', '地点']);
    if (name) delete entities.sceneTombstones[entityKey(name)];
  }
  const candidate = sanitizeSceneIndexSection(data, rawInput);
  markManualEntityDeletions(data, 'scenes', before, candidate);
  data.codex.sceneIndex = sanitizeSceneIndexSection(data, candidate);
  const currentTime = $('#am_current_time_edit').val().trim();
  const currentPlace = $('#am_current_place_edit').val().trim();
  const latestFloor = Math.max(-1, ...(data.godlogs || []).map(item => Number(item.floor ?? -1)));
  data.timeline = ensureTimelineState(data);
  data.timeline.manualOverride = (currentTime || currentPlace) ? {
    currentTime: currentTime || data.codex.currentTime || '未明',
    currentPlace: currentPlace || data.codex.currentPlace || '未明',
    floor: latestFloor,
    sourceKey: '',
    at: Date.now(),
  } : null;
  if (currentTime) data.codex.currentTime = currentTime;
  if (currentPlace) data.codex.currentPlace = currentPlace;
  syncEntityLedgers(data, { manualScenes: true });
  refreshTimelineFromGodlogs(data);
  syncLatestGodlogPositionFields(data);
  saveMemory(true);
  injectMemory().catch(err => console.warn('[AnchorMemory] inject after scene edit failed', err));
  updatePreview();
  toastr?.success?.('场景记录与剧情时间基线已保存；后续楼层会从该基线继续推进', 'Anchor Memory');
}

function exportData() {
  $('#am_json_box').val(JSON.stringify(memoryData(), null, 2));
  toastr?.success?.('当前记忆已导出到文本框', 'Anchor Memory');
}

function exportConfig() {
  const s = settings();
  const safeConfig = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (['secondaryKey', 'embeddingKey', 'secondaryPresets', 'activeSecondaryPresetId', 'slots'].includes(key)) continue;
    safeConfig[key] = s[key];
  }
  $('#am_json_box').val(JSON.stringify({
    type: 'anchor-memory-config',
    version: DATA_VERSION,
    exportedAt: Date.now(),
    settings: safeConfig,
  }, null, 2));
  toastr?.success?.('配置已导出，不包含API密钥和记忆档案', 'Anchor Memory');
}

async function importConfig() {
  try {
    const imported = JSON.parse($('#am_json_box').val() || '{}');
    const incoming = imported.settings || imported;
    const s = settings();
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (['secondaryKey', 'embeddingKey', 'secondaryPresets', 'activeSecondaryPresetId', 'slots'].includes(key)) continue;
      if (incoming[key] !== undefined) s[key] = incoming[key];
    }
    saveSettingsDebounced();
    loadUi();
    await setPluginEnabled(!!s.enabled, { notify: false });
    toastr?.success?.('配置已导入，原API密钥和记忆档案已保留', 'Anchor Memory');
  } catch (err) {
    toastr?.error?.(`配置导入失败：${err.message}`, 'Anchor Memory');
  }
}

async function importData() {
  try {
    const imported = JSON.parse($('#am_json_box').val() || '{}');
    const current = hasPersistentChatContext() ? memoryData() : null;
    if (current && (codexHasContent(current.codex) || relationshipHasContent(current.relationshipTable)) && !imported.codexBackup) {
      imported.codexBackup = {
        savedAt: Date.now(),
        reason: '导入新记忆JSON前自动备份',
        signature: codexSignature(current.codex, current.relationshipTable),
        codex: clonePlainObject(current.codex),
        relationshipTable: clonePlainObject(normalizeRelationshipTable(current.relationshipTable, current.codex?.relationship || '')),
        codexKeys: clonePlainObject(current.processing?.codexKeys || {}),
        lastCodexFloor: Number(current.processing?.lastCodexFloor ?? -1),
      };
    }
    // Exported JSON intentionally omits the heavy IndexedDB vectors. Do not carry dangling
    // references/storage namespaces into an imported chat; embeddings can be rebuilt on demand.
    imported.vectorRefs = {};
    if (!imported.vectors || typeof imported.vectors !== 'object') imported.vectors = {};
    imported.processing = { ...(imported.processing || {}), storageId: '' };
    const ctx = getContext();
    if (!ctx.chatMetadata) ctx.chatMetadata = {};
    ctx.chatMetadata[DATA_KEY] = {
      ...defaultData(),
      ...imported,
      processing: { ...defaultData().processing, ...(imported.processing || {}), busy: false, summaryBusy: false, codexBusy: false, queueRunning: false },
    };
    const data = memoryData();
    saveMemory(true);
    await enforceAnchorHiddenState(data);
    await injectMemory();
    updatePreview();
    toastr?.success?.('记忆JSON已导入并完成一致性校验', 'Anchor Memory');
  } catch (err) {
    toastr?.error?.(`导入失败：${err.message}`, 'Anchor Memory');
  }
}

async function resetCurrentMemory() {
  if (!confirm('清空当前聊天的锚点记忆？记忆档案不会被删除。')) return;
  const ctx = getContext();
  removeAllGodlogBlocksFromChat();
  if (!ctx.chatMetadata) ctx.chatMetadata = {};
  ctx.chatMetadata[DATA_KEY] = defaultData();
  const data = memoryData();
  saveMemory(true);
  await enforceAnchorHiddenState(data);
  setExtensionPrompt(CORE_PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0);
  setExtensionPrompt(RECALL_PROMPT_KEY, '', extension_prompt_types.IN_PROMPT, 0);
  state.lastRecall = '';
  state.lastRecallMeta = [];
  updatePreview();
  toastr?.success?.('当前聊天锚点记忆已清空，插件隐藏状态已还原', 'Anchor Memory');
}

function promptPreset(name) {
  if (name === 'strict') {
    return {
      godlog: `${DEFAULT_GODLOG_RULES}
补充要求：关键原话优先保真，无法确认的细节写“未明”，不要自行补完。`,
      anchor: `${DEFAULT_ANCHOR_RULES}
- 原话保真优先级最高；无法确认的台词不得伪造。
- 每条事件必须写明“谁因为什么采取行动，导致什么后果”。
- 对敏感、尴尬、冲突内容不美化、不回避，只做客观记录。`,
      merge: `${DEFAULT_MERGE_RULES}
- 合并时优先保留关键原话、承诺、冲突、破壁事件、道具伏笔。
- 不得为了压缩而删除角色弧光的转折点。`,
      character: DEFAULT_CHARACTER_RULES,
      people: DEFAULT_PEOPLE_RULES,
      item: DEFAULT_ITEM_RULES,
    };
  }
  if (name === 'compact') {
    return {
      godlog: `${DEFAULT_GODLOG_RULES}
补充要求：Cond 控制在200字左右，只保留会影响因果链、心理转折或后续伏笔的细节。`,
      anchor: `${DEFAULT_ANCHOR_RULES}
- 在不丢失因果和原话的前提下压缩措辞。
- 日常动作只在影响关系、伏笔或角色变化时记录。`,
      merge: `${DEFAULT_MERGE_RULES}
- 历史事件尽量短句化，新增事件保留必要细节。
- 表格用短语，不写长段散文。`,
      character: `${DEFAULT_CHARACTER_RULES}
- 一句话摘要必须短，不超过80字。`,
      people: `${DEFAULT_PEOPLE_RULES}
- 表格单元格尽量用短句。`,
      item: `${DEFAULT_ITEM_RULES}
- 只保留关键物品、核心细节和会反复出现的梗。`,
    };
  }
  return {
    godlog: DEFAULT_GODLOG_RULES,
    anchor: DEFAULT_ANCHOR_RULES,
    merge: DEFAULT_MERGE_RULES,
    character: DEFAULT_CHARACTER_RULES,
    people: DEFAULT_PEOPLE_RULES,
    item: DEFAULT_ITEM_RULES,
  };
}

function installExtensionSettingsEntry() {
  if (!$ || $('#anchor_memory_settings_entry').length) return true;
  const host = $('#extensions_settings2, #extensions_settings').first();
  if (!host.length) {
    setTimeout(installExtensionSettingsEntry, 500);
    return false;
  }

  const entry = $(`
    <div id="anchor_memory_settings_entry" class="anchor-memory-extension-entry inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>Anchor Memory 锚点书</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <div class="am-extension-entry-row">
          <span>逐楼摘要、分段锚点与累计历史（间隔均可配置）</span>
          <div class="am-extension-entry-actions">
            <button id="am_extension_master_toggle" type="button" class="menu_button">暂停插件</button>
            <button id="am_open_workbench_from_extensions" type="button" class="menu_button">打开面板</button>
          </div>
        </div>
        <small id="am_extension_load_status">插件已加载 · ${EXTENSION_VERSION}</small>
      </div>
    </div>
  `);
  host.append(entry);
  entry.find('.inline-drawer-toggle').on('click', function () {
    entry.find('.inline-drawer-content').first().slideToggle?.(200);
    entry.find('.inline-drawer-icon').toggleClass('down up');
  });
  entry.find('#am_open_workbench_from_extensions').on('click', () => {
    if (!openWorkbench()) {
      toastr?.warning?.('面板模板尚未加载，请稍后再试。', 'Anchor Memory');
    }
  });
  entry.find('#am_extension_master_toggle').on('click', () => {
    setPluginEnabled(!settings().enabled).catch(err => console.warn('[AnchorMemory] extension toggle failed', err));
  });
  syncPluginEnabledUi();
  return true;
}

let workbenchViewportEventsBound = false;
let workbenchViewportRaf = 0;

function syncWorkbenchViewport() {
  const shell = document.getElementById('anchor_memory_workbench');
  if (!shell) return;
  const viewport = window.visualViewport;
  const width = Math.max(240, Math.round(viewport?.width || window.innerWidth || document.documentElement.clientWidth || 0));
  const height = Math.max(240, Math.round(viewport?.height || window.innerHeight || document.documentElement.clientHeight || 0));
  const offsetTop = Math.max(0, Math.round(viewport?.offsetTop || 0));
  const offsetLeft = Math.max(0, Math.round(viewport?.offsetLeft || 0));
  shell.style.setProperty('--am-vv-width', `${width}px`);
  shell.style.setProperty('--am-vv-height', `${height}px`);
  shell.style.setProperty('--am-vv-top', `${offsetTop}px`);
  shell.style.setProperty('--am-vv-left', `${offsetLeft}px`);
}

function scheduleWorkbenchViewportSync() {
  if (workbenchViewportRaf) cancelAnimationFrame(workbenchViewportRaf);
  workbenchViewportRaf = requestAnimationFrame(() => {
    workbenchViewportRaf = 0;
    if ($('#anchor_memory_workbench').hasClass('open')) syncWorkbenchViewport();
  });
}

function bindWorkbenchViewportEvents() {
  if (workbenchViewportEventsBound) return;
  workbenchViewportEventsBound = true;
  window.addEventListener('resize', scheduleWorkbenchViewportSync, { passive: true });
  window.addEventListener('orientationchange', scheduleWorkbenchViewportSync, { passive: true });
  window.visualViewport?.addEventListener('resize', scheduleWorkbenchViewportSync, { passive: true });
  window.visualViewport?.addEventListener('scroll', scheduleWorkbenchViewportSync, { passive: true });
}

function openWorkbench() {
  const shell = $('#anchor_memory_workbench');
  if (!shell.length) return false;
  bindWorkbenchViewportEvents();
  syncWorkbenchViewport();
  shell.addClass('open').attr('aria-hidden', 'false');
  $('body').addClass('am-workbench-open');
  const content = shell.find('.am-workbench-content').get(0);
  if (content) content.scrollTop = 0;
  scheduleWorkbenchViewportSync();
  updatePreview();
  return true;
}

function closeWorkbench() {
  $('#anchor_memory_workbench').removeClass('open').attr('aria-hidden', 'true');
  $('body').removeClass('am-workbench-open');
}

// Recovery hook: `anchorMemoryOpen()` can be called from the browser console even if a theme
// changes the navigation layout and hides the normal launcher.
window.anchorMemoryOpen = openWorkbench;


function installPublicApi() {
  const readonlySnapshot = () => {
    const data = memoryData();
    return clonePlainObject({
      version: EXTENSION_VERSION,
      dataVersion: DATA_VERSION,
      godlogs: data.godlogs || [],
      anchors: activeAnchors(data),
      merges: activeMerges(data),
      relationshipTable: normalizeRelationshipTable(data.relationshipTable, data.codex?.relationship || ''),
      codex: data.codex || {},
      timeline: data.timeline || {},
      entities: data.entities || {},
      processing: {
        codexDirty: !!data.processing?.codexDirty,
        relationshipDirty: !!data.processing?.relationshipDirty,
        pendingGodlogs: pendingGodlogRows(data).length,
        pendingAnchors: pendingAnchorMaterials(data).length,
        lastError: data.processing?.lastError || '',
      },
    });
  };
  globalThis.AnchorMemory = Object.freeze({
    version: EXTENSION_VERSION,
    open: openWorkbench,
    getStatus: () => statusText(memoryData()),
    getSnapshot: readonlySnapshot,
    getPromptPreview: async () => buildPromptReadyInjection(getContext().chat || [], { commit: false }),
    getMemoryBudget: () => clonePlainObject(state.lastMemoryBudget || {}),
    getTimelineWarnings: () => clonePlainObject(memoryData().timeline?.warnings || []),
    isEnabled: () => !!settings().enabled,
    enable: () => setPluginEnabled(true),
    disable: () => setPluginEnabled(false),
    toggle: () => setPluginEnabled(!settings().enabled),
    cancelBackgroundRequests: () => state.requests.abortAll('public-api-cancel'),
  });
}

const NAVBAR_USER_TARGET_SELECTORS = [
  '#user-settings-button',
  '#userSettingsButton',
  '#user_settings_button',
  '#persona-management-button',
  '#personaManagementButton',
  '#persona_management_button',
  '#PersonaManagementButton',
  '[data-i18n="[title]User Settings"]',
  '[data-i18n="[title]Persona Management"]',
  '[title="用户信息"]',
  '[title*="用户信息"]',
  '[aria-label*="用户信息"]',
  '[title*="User Settings"]',
  '[aria-label*="User Settings"]',
  '[title*="Persona Management"]',
  '[aria-label*="Persona Management"]',
];

function topLevelNavbarChild(holder, candidate) {
  const host = holder?.[0];
  let node = candidate?.[0];
  if (!host || !node || !host.contains(node)) return null;
  while (node.parentElement && node.parentElement !== host) node = node.parentElement;
  return node.parentElement === host ? $(node) : null;
}

function navbarUserReference(holder) {
  if (!holder?.length) return null;
  for (const selector of NAVBAR_USER_TARGET_SELECTORS) {
    const matches = holder.find(selector).addBack(selector);
    const candidate = matches.filter(':visible').first().length ? matches.filter(':visible').first() : matches.first();
    const topLevel = topLevelNavbarChild(holder, candidate);
    if (topLevel?.length && !topLevel.is('#anchor_memory_nav_button')) return topLevel;
  }

  // Theme compatibility: some beautification packs remove stock IDs but keep a translated title.
  const semanticCandidate = holder.children().filter((_, element) => {
    if (element.id === 'anchor_memory_nav_button') return false;
    const label = [element.getAttribute('title'), element.getAttribute('aria-label'), element.textContent]
      .filter(Boolean)
      .join(' ');
    return /(用户信息|用户设置|个人信息|人格管理|user settings|persona management|account)/i.test(label);
  }).filter(':visible').first();
  if (semanticCandidate.length) return semanticCandidate;

  // Last-resort placement still stays inside the native sequence: insert before the final visible
  // native launcher rather than pinning Anchor Memory to the far edge with a custom flex order.
  const lastNative = holder.children('.drawer-icon, .menu_button, .interactable')
    .not('#anchor_memory_nav_button')
    .filter(':visible')
    .last();
  return lastNative.length ? lastNative : null;
}

function navInsertionTarget() {
  const visibleHolder = $('#top-settings-holder').filter(':visible').first();
  const holder = visibleHolder.length ? visibleHolder : $('#top-settings-holder').first();
  if (holder.length) return { holder, before: navbarUserReference(holder) };

  // Compatibility fallback for themes that replace the stock holder but retain a known user icon.
  for (const selector of NAVBAR_USER_TARGET_SELECTORS) {
    const reference = $(selector).filter(':visible').first().length
      ? $(selector).filter(':visible').first()
      : $(selector).first();
    if (reference.length && reference.parent().length) {
      return { holder: reference.parent(), before: reference };
    }
  }

  const nativeButton = $('#extensionsMenuButton, #extensions-settings-button').first();
  if (nativeButton.length && nativeButton.parent().length) {
    return { holder: nativeButton.parent(), before: nativeButton };
  }
  return null;
}

function navbarStructuralClasses(reference) {
  const fallback = ['drawer-icon', 'menu_button', 'interactable'];
  if (!reference?.length) return fallback;
  const excludedState = /^(?:active|selected|disabled|hidden|open|closed|drawer-open|drawer-closed|pressed)$/i;
  const iconClass = /^(?:fa|fas|far|fal|fat|fad|fab|fa-[a-z0-9-]+)$/i;
  const classes = String(reference.attr('class') || '')
    .split(/\s+/)
    .map(value => value.trim())
    .filter(Boolean)
    .filter(value => !iconClass.test(value) && !excludedState.test(value) && value !== 'am-navbar-button');
  return classes.length ? classes : fallback;
}

function syncNavbarButton(button, reference) {
  const pluginDisabled = !settings().enabled;
  const classes = [...new Set(['am-navbar-button', ...navbarStructuralClasses(reference)])].join(' ');
  if (button.attr('class') !== classes) button.attr('class', classes);
  button.toggleClass('am-disabled', pluginDisabled);
  if (!button.children('.am-navbar-letter').length || button.children().length !== 1) {
    button.empty().append('<span class="am-navbar-letter" aria-hidden="true">A</span>');
  }
}

function scheduleNavbarReconcile() {
  clearTimeout(state.navbarRepairTimer);
  state.navbarRepairTimer = setTimeout(() => installNavbarEntry(), 40);
}

function observeNavbar(holder) {
  const host = holder?.[0];
  if (!host || state.navbarObservedHost === host) return;
  state.navbarObserver?.disconnect?.();
  state.navbarObservedHost = host;
  state.navbarObserver = new MutationObserver(mutations => {
    const externalMutation = mutations.some(mutation => {
      const target = mutation.target instanceof Element ? mutation.target : mutation.target?.parentElement;
      return !target?.closest?.('#anchor_memory_nav_button');
    });
    if (externalMutation) scheduleNavbarReconcile();
  });
  state.navbarObserver.observe(host, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'title', 'aria-label'],
  });
}

function installNavbarEntry(attempt = 0) {
  const target = navInsertionTarget();
  if (!target?.holder?.length) {
    if (attempt < 30) setTimeout(() => installNavbarEntry(attempt + 1), 500);
    else console.warn('[AnchorMemory] navbar container not found; workbench entry was not installed');
    return false;
  }

  const duplicates = $('#anchor_memory_nav_button');
  let button = duplicates.first();
  duplicates.slice(1).remove();
  if (!button.length) button = $('<div id="anchor_memory_nav_button"></div>');

  syncNavbarButton(button, target.before);
  button
    .attr('title', '锚点书')
    .attr('tabindex', '0')
    .attr('role', 'button')
    .attr('aria-label', '打开锚点书')
    .off('.anchorMemoryNav')
    .on('click.anchorMemoryNav', openWorkbench)
    .on('keydown.anchorMemoryNav', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openWorkbench();
      }
    });

  const beforeNode = target.before?.[0];
  const hostNode = target.holder[0];
  if (beforeNode && beforeNode.parentElement === hostNode) {
    if (button[0].nextElementSibling !== beforeNode || button[0].parentElement !== hostNode) {
      target.before.before(button);
    }
  } else if (button[0].parentElement !== hostNode) {
    target.holder.append(button);
  }

  observeNavbar(target.holder);
  return true;
}

function loadUi() {
  const s = settings();
  $('#am_enabled').prop('checked', !!s.enabled);
  $('#am_anchor_interval').val(s.anchorInterval);
  $('#am_merge_anchor_interval').val(s.mergeAnchorInterval);
  $('#am_keep_recent').val(s.keepRecent);
  $('#am_injection_depth').val(s.injectionDepth);
  $('#am_adaptive_token_budget').prop('checked', !!s.adaptiveTokenBudget);
  $('#am_memory_max_tokens').val(s.memoryMaxTokens);
  $('#am_memory_reserve_tokens').val(s.memoryReserveTokens);
  $('#am_auto_hide').prop('checked', !!s.autoHide);
  $('#am_use_dynamic_recall').prop('checked', !!s.useDynamicRecall);
  $('#am_recall_mentioned_people').prop('checked', !!s.recallMentionedPeople);
  $('#am_inject_important_items').prop('checked', !!s.injectImportantItems);
  $('#am_use_secondary').prop('checked', !!s.useSecondary);
  $('#am_secondary_url').val(s.secondaryUrl);
  $('#am_secondary_key').val(s.secondaryKey);
  updateSecondaryProviderHint(s.secondaryUrl);
  $('#am_secondary_model').val(s.secondaryModel);
  renderModelOptions('#am_secondary_model_options', s.secondaryModels || []);
  renderSecondaryPresetOptions();
  $('#am_use_embedding').prop('checked', !!s.useEmbedding);
  $('#am_embedding_url').val(s.embeddingUrl);
  $('#am_embedding_key').val(s.embeddingKey);
  $('#am_embedding_model').val(s.embeddingModel);
  renderModelOptions('#am_embedding_model_options', s.embeddingModels || []);
  $('#am_embedding_dimensions').val(s.embeddingDimensions);
  $('#am_embedding_dimensions_mode').val(s.embeddingDimensionsMode || 'auto');
  $('#am_embedding_top_k').val(s.embeddingTopK);
  $('#am_godlog_rules').val(s.godlogRules || DEFAULT_GODLOG_RULES);
  $('#am_anchor_rules').val(s.anchorRules || DEFAULT_ANCHOR_RULES);
  $('#am_merge_rules').val(s.mergeRules || DEFAULT_MERGE_RULES);
  $('#am_character_rules').val(s.characterRules || DEFAULT_CHARACTER_RULES);
  $('#am_people_rules').val(s.peopleRules || DEFAULT_PEOPLE_RULES);
  $('#am_item_rules').val(s.itemRules || DEFAULT_ITEM_RULES);
  $('#am_godlog_format').val(renderTemplate(GODLOG_FORMAT_HELP));
  $('#am_anchor_format').val(renderTemplate(ANCHOR_FORMAT_HELP));
  $('#am_merge_format').val(renderTemplate(MERGE_FORMAT_HELP));
  $('#am_secondary_fields').show();
  $('#am_embedding_fields').show();
  syncPluginEnabledUi();
  safeUpdatePreview('加载面板');
}

function setAdvancedTabsExpanded(expanded) {
  const show = !!expanded;
  $('.anchor-memory-settings .am-tabs').toggleClass('am-show-advanced', show);
  $('#am_toggle_advanced_tabs')
    .attr('aria-expanded', show ? 'true' : 'false')
    .text(show ? '收起高级' : '更多功能');
}

function activateTab(tab) {
  const target = $(`.anchor-memory-settings .am-tab[data-tab="${tab}"]`);
  if (target.hasClass('am-advanced-tab')) setAdvancedTabsExpanded(true);
  $('.anchor-memory-settings .am-tab').removeClass('active');
  target.addClass('active');
  $('.anchor-memory-settings .am-tab-panel').removeClass('active');
  $(`.anchor-memory-settings .am-tab-panel[data-panel="${tab}"]`).addClass('active');
}

function bindUi() {
  $('.anchor-memory-settings .am-tab[data-tab]').on('click', function () {
    activateTab($(this).data('tab'));
  });
  $('#am_toggle_advanced_tabs').on('click', function () {
    const tabs = $('.anchor-memory-settings .am-tabs');
    const next = !tabs.hasClass('am-show-advanced');
    if (!next && tabs.find('.am-advanced-tab.active').length) activateTab('dashboard');
    setAdvancedTabsExpanded(next);
  });

  $('#am_enabled').on('change', function () {
    setPluginEnabled(this.checked).catch(err => console.warn('[AnchorMemory] settings toggle failed', err));
  });
  $('#am_master_toggle').on('click', function () {
    setPluginEnabled(!settings().enabled).catch(err => console.warn('[AnchorMemory] master toggle failed', err));
  });
  $('#am_anchor_interval').on('change', function () { applyIntervalSettingChange('anchorInterval', this.value, this); });
  $('#am_merge_anchor_interval').on('change', function () { applyIntervalSettingChange('mergeAnchorInterval', this.value, this); });
  $('#am_keep_recent').on('change', function () {
    saveSetting('keepRecent', Math.max(1, Number(this.value) || 3));
    reconcileStrictRecentWindow('保留轮数设置已变化').catch(console.warn);
  });
  $('#am_injection_depth').on('change', function () { saveSetting('injectionDepth', normalizedInjectionDepth(this.value)); });
  $('#am_adaptive_token_budget').on('change', function () { saveSetting('adaptiveTokenBudget', this.checked); injectMemory().catch(console.warn); });
  $('#am_memory_max_tokens').on('change', function () { saveSetting('memoryMaxTokens', Math.max(1200, Math.min(32000, Number(this.value) || 8000))); injectMemory().catch(console.warn); });
  $('#am_memory_reserve_tokens').on('change', function () { saveSetting('memoryReserveTokens', Math.max(600, Math.min(16000, Number(this.value) || 1400))); injectMemory().catch(console.warn); });
  $('#am_auto_hide').on('change', function () { saveSetting('autoHide', this.checked); reconcileStrictRecentWindow('自动隐藏设置已变化').catch(console.warn); });
  $('#am_use_dynamic_recall').on('change', function () {
    saveSetting('useDynamicRecall', this.checked);
    saveSetting('dynamicRecallExplicit', true);
    clearRecallPrefetch();
    prepareDynamicRecall().catch(console.warn);
    injectMemory().catch(console.warn);
  });
  $('#am_recall_mentioned_people').on('change', function () { saveSetting('recallMentionedPeople', this.checked); injectMemory().catch(console.warn); });
  $('#am_inject_important_items').on('change', function () { saveSetting('injectImportantItems', this.checked); injectMemory().catch(console.warn); });
  $('#am_use_secondary').on('change', function () {
    saveSetting('useSecondary', this.checked);
    if (this.checked && secondaryConfigured()) queueMemoryJob('副API已启用，继续补齐记忆', 120);
  });
  $('#am_secondary_preset_select').on('change', function () { loadSecondaryPreset(this.value); });
  $('#am_save_secondary_preset').on('click', () => saveSecondaryPreset({ overwriteActive: false }));
  $('#am_update_secondary_preset').on('click', () => saveSecondaryPreset({ overwriteActive: true }));
  $('#am_delete_secondary_preset').on('click', deleteSecondaryPreset);
  $('#am_secondary_url, #am_secondary_key').on('input change', function () {
    const s = settings();
    const key = this.id === 'am_secondary_url' ? 'secondaryUrl' : 'secondaryKey';
    const value = String(this.value || '').trim();
    if (this.id === 'am_secondary_url') updateSecondaryProviderHint(value);
    if (s[key] !== value) {
      s[key] = value;
      // A model selected for another endpoint/key is unsafe. Clear it immediately instead of
      // silently sending a stale model name after mobile users edit the connection fields.
      s.secondaryModel = '';
      s.secondaryModels = [];
      $('#am_secondary_model').val('');
      renderModelOptions('#am_secondary_model_options', []);
      bumpSecondaryConfigRevision();
      saveSettingsDebounced();
      updateSecondaryPresetStatus();
    }
  });
  $('#am_secondary_model').on('input change', function () {
    const s = settings();
    const value = this.value.trim();
    if (s.secondaryModel !== value) {
      s.secondaryModel = value;
      bumpSecondaryConfigRevision();
      saveSettingsDebounced();
    }
    updateSecondaryPresetStatus();
    if (secondaryConfigured()) queueMemoryJob('副API模型已配置，继续补齐记忆', 180);
  });
  $('#am_fetch_secondary_models').on('click', fetchSecondaryModels);
  $('#am_use_embedding').on('change', function () {
    saveSetting('useEmbedding', this.checked);
    clearRecallPrefetch();
    prepareDynamicRecall().catch(console.warn);
  });
  $('#am_embedding_url, #am_embedding_key').on('input change', function () {
    const s = settings();
    const key = this.id === 'am_embedding_url' ? 'embeddingUrl' : 'embeddingKey';
    const value = String(this.value || '').trim();
    if (s[key] !== value) {
      s[key] = value;
      s.embeddingModel = '';
      s.embeddingModels = [];
      $('#am_embedding_model').val('');
      renderModelOptions('#am_embedding_model_options', []);
      saveSettingsDebounced();
      clearRecallPrefetch();
    }
  });
  $('#am_embedding_model').on('input change', function () { saveSetting('embeddingModel', this.value.trim()); clearRecallPrefetch(); });
  $('#am_embedding_dimensions').on('change', function () { saveSetting('embeddingDimensions', Math.max(64, Number(this.value) || 256)); });
  $('#am_embedding_dimensions_mode').on('change', function () { saveSetting('embeddingDimensionsMode', this.value || 'auto'); });
  $('#am_embedding_top_k').on('change', function () { saveSetting('embeddingTopK', Math.max(1, Number(this.value) || 3)); });
  $('#am_fetch_embedding_models').on('click', fetchEmbeddingModels);
  $('#am_apply_siliconflow_embedding').on('click', applySiliconFlowEmbeddingPreset);
  $('#am_force_anchor').on('click', () => createAnchor(true));
  $('#am_force_merge').on('click', () => maybeMerge(true));
  $('#am_rewrite_latest_anchor').on('click', rewriteLatestAnchor);
  $('#am_rewrite_latest_merge').on('click', rewriteLatestMerge);
  $('#am_batch_init').on('click', batchInitializeHistory);
  $('#am_health_check').on('click', () => {
    const result = repairHealth();
    toastr?.info?.(`体检完成：清理孤儿锚定标记 ${result.removedAnchoredKeys} 条，孤儿向量 ${result.removedVectors} 条`, 'Anchor Memory');
  });
  $('#am_open_api_settings').on('click', () => activateTab('settings'));
  $('#am_refresh_view').on('click', updatePreview);
  $('#am_godlog_search').on('input', () => { state.godlogPage = 0; renderGodlogList(); });
  $('#am_godlog_list').on('click', '.am-godlog-prev', function () {
    state.godlogPage = Math.max(0, state.godlogPage - 1);
    renderGodlogList();
  });
  $('#am_godlog_list').on('click', '.am-godlog-next', function () {
    state.godlogPage += 1;
    renderGodlogList();
  });
  $('#am_godlog_list').on('click', '.am-godlog-card', function () {
    const id = $(this).data('godlog-id');
    state.selectedGodlogId = id;
    const item = (memoryData().godlogs || []).find(entry => entry.id === id);
    const syntheticRow = rowFromSyntheticGodlogId(id);
    $('#am_godlog_detail').val(item?.body || item?.error || (syntheticRow ? `第 ${syntheticRow.index} 楼尚未生成逐楼摘要。请点“重跑本楼摘要”或“自动补写缺失摘要”，插件会调用模型自动补写。` : ''));
  });
  $('#am_godlog_list').on('click', '.am-rerun-godlog', async function (event) {
    event.stopPropagation();
    state.selectedGodlogId = $(this).data('godlog-id');
    await rerunSelectedGodlog();
  });
  $('#am_save_selected_godlog').on('click', saveSelectedGodlog);
  $('#am_rerun_selected_godlog').on('click', rerunSelectedGodlog);
  $('#am_delete_selected_godlog').on('click', deleteSelectedGodlog);
  $('#am_generate_missing_godlogs').on('click', async () => {
    await repairMissingGodlogs(Number.MAX_SAFE_INTEGER);
    updatePreview();
  });
  $('#am_timeline_search').on('input', renderTimelineList);
  $('#am_clear_recall_selection').on('click', () => {
    state.selectedRecallMessageKey = '';
    updatePreview();
  });
  $('#am_new_anchor_list, #am_old_anchor_list, #am_timeline_list').on('click', '.am-memory-card', function () {
    const id = $(this).data('memory-id');
    state.selectedMemoryId = id;
    const data = memoryData();
    const item = [...data.anchors, ...data.merges].find(entry => entry.id === id);
    $('#am_timeline_detail').val(item?.body || '');
  });
  $('#am_new_anchor_list, #am_old_anchor_list, #am_timeline_list').on('click', '.am-rewrite-memory', function (event) {
    event.preventDefault();
    event.stopPropagation();
    const id = $(this).data('memory-id');
    state.selectedMemoryId = id;
    rewriteMemoryItem(id);
  });
  $('#am_save_selected_memory').on('click', saveSelectedMemory);
  $('#am_rewrite_selected_memory').on('click', rewriteSelectedMemory);
  $('#am_delete_selected_memory').on('click', deleteSelectedMemory);
  $('#am_rebuild_codex').on('click', rebuildCodexFromGodlogs);
  $('#am_restore_codex_backup').on('click', () => restoreCodexBackup(memoryData(), true));
  $('#am_add_relationship_row').on('click', addRelationshipRow);
  $('#am_save_relationship_rows').on('click', saveRelationshipNames);
  $('#am_rebuild_relationship').on('click', rebuildRelationshipFromGodlogs);
  $('#am_relationship_new_name').on('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addRelationshipRow();
    }
  });
  $('#am_relationship_rows').on('click', '.am-delete-relationship-row', function () {
    deleteRelationshipRow(String($(this).closest('tr').data('relationship-id') || ''));
  });
  $('#am_rebuild_vectors').on('click', rebuildVectors);
  $('#am_test_embedding').on('click', testEmbedding);
  $('#am_test_secondary').on('click', testSecondary);
  $('#am_save_archive').on('click', saveArchive);
  $('#am_archive_cards').on('click', '.am-finalize-archive', function () { finalizeArchiveForTransfer($(this).data('archive')); });
  $('#am_archive_cards').on('click', '.am-load-archive', function () { loadArchive($(this).data('archive')); });
  $('#am_archive_cards').on('click', '.am-delete-archive', function () { deleteArchive($(this).data('archive')); });
  $('#am_save_tracked_characters').on('click', saveTrackedCharacterSettings);
  $('#am_save_character_edits').on('click', saveCharacterEdits);
  $('#am_save_item_edits').on('click', saveItemEdits);
  $('#am_save_scene_edits').on('click', saveSceneEdits);
  $('#am_export_data').on('click', exportData);
  $('#am_import_data').on('click', importData);
  $('#am_export_config').on('click', exportConfig);
  $('#am_import_config').on('click', importConfig);
  $('#am_reset_memory').on('click', resetCurrentMemory);
  $('#am_save_prompts').on('click', () => {
    saveSetting('godlogRules', $('#am_godlog_rules').val().trim() || DEFAULT_GODLOG_RULES);
    saveSetting('anchorRules', $('#am_anchor_rules').val().trim() || DEFAULT_ANCHOR_RULES);
    saveSetting('mergeRules', $('#am_merge_rules').val().trim() || DEFAULT_MERGE_RULES);
    saveSetting('characterRules', $('#am_character_rules').val().trim() || DEFAULT_CHARACTER_RULES);
    saveSetting('peopleRules', $('#am_people_rules').val().trim() || DEFAULT_PEOPLE_RULES);
    saveSetting('itemRules', $('#am_item_rules').val().trim() || DEFAULT_ITEM_RULES);
    toastr?.success?.('提示词规则已保存', 'Anchor Memory');
  });
  $('#am_apply_prompt_preset').on('click', () => {
    const preset = promptPreset($('#am_prompt_preset').val());
    $('#am_godlog_rules').val(preset.godlog);
    $('#am_anchor_rules').val(preset.anchor);
    $('#am_merge_rules').val(preset.merge);
    $('#am_character_rules').val(preset.character);
    $('#am_people_rules').val(preset.people);
    $('#am_item_rules').val(preset.item);
    toastr?.info?.('预设已填入，确认后点“保存提示词”', 'Anchor Memory');
  });
  $('#am_reset_prompts').on('click', () => {
    saveSetting('godlogRules', DEFAULT_GODLOG_RULES);
    saveSetting('anchorRules', DEFAULT_ANCHOR_RULES);
    saveSetting('mergeRules', DEFAULT_MERGE_RULES);
    saveSetting('characterRules', DEFAULT_CHARACTER_RULES);
    saveSetting('peopleRules', DEFAULT_PEOPLE_RULES);
    saveSetting('itemRules', DEFAULT_ITEM_RULES);
    $('#am_godlog_rules').val(DEFAULT_GODLOG_RULES);
    $('#am_anchor_rules').val(DEFAULT_ANCHOR_RULES);
    $('#am_merge_rules').val(DEFAULT_MERGE_RULES);
    $('#am_character_rules').val(DEFAULT_CHARACTER_RULES);
    $('#am_people_rules').val(DEFAULT_PEOPLE_RULES);
    $('#am_item_rules').val(DEFAULT_ITEM_RULES);
    toastr?.success?.('已恢复默认提示词规则', 'Anchor Memory');
  });
  $('#am_close_workbench').on('click', closeWorkbench);
  $('#anchor_memory_workbench').on('click', '[data-am-close="1"]', closeWorkbench);
  $(document).on('keydown.anchorMemoryWorkbench', event => {
    if (event.key === 'Escape' && $('#anchor_memory_workbench').hasClass('open')) closeWorkbench();
  });

  $(document)
    .off('click.anchorMemoryGodlogPanel')
    .on('click.anchorMemoryGodlogPanel', '.am-message-godlog-toggle', function () {
      const panel = $(this).closest('.am-message-godlog-panel');
      const body = panel.find('.am-message-godlog-body').first();
      const hidden = body.prop('hidden');
      body.prop('hidden', !hidden);
      panel.toggleClass('open', hidden);
    })
    .on('click.anchorMemoryGodlogPanel', '.am-message-godlog-open', function (event) {
      event.stopPropagation();
      const id = $(this).closest('.am-message-godlog-panel').data('godlog-id');
      showGodlogInWorkbench(String(id || ''));
    })
    .on('click.anchorMemoryGodlogPanel', '.am-message-godlog-rerun', async function (event) {
      event.stopPropagation();
      const id = $(this).closest('.am-message-godlog-panel').data('godlog-id');
      await rerunGodlogFromPanel(String(id || ''));
    })
    .on('click.anchorMemoryGodlogPanel', '.am-message-memory-badge', function (event) {
      event.stopPropagation();
      showRecallRecordInWorkbench(String($(this).data('message-key') || ''));
    });
}

function restoreCurrentChatState(reason = '切换聊天') {
  if (!hasPersistentChatContext()) return false;
  installNavbarEntry();
  syncPluginEnabledUi();
  if (!settings().enabled) {
    clearInjectedPromptState();
    enforceAnchorHiddenState(memoryData()).catch(err => console.warn('[AnchorMemory] paused-state unhide failed', err));
    safeUpdatePreview(`${reason}（插件已暂停）`);
    return true;
  }
  syncGodlogsWithChat(reason);
  safeUpdatePreview(reason);
  scheduleGodlogPanelRender();
  injectMemory().catch(err => console.warn('[AnchorMemory] inject failed', err));
  if (hasPendingMemoryWork()) queueMemoryJob(`${reason}后自动补齐待处理记忆`, 180);
  return true;
}

function scheduleRestoreCurrentChatState(reason = '切换聊天', attempts = 20) {
  if (state.restoreTimer) clearTimeout(state.restoreTimer);
  const tryRestore = remaining => {
    state.restoreTimer = null;
    if (restoreCurrentChatState(reason)) return;
    if (remaining <= 1) {
      console.warn('[AnchorMemory] chat metadata was not ready; waiting for next CHAT_CHANGED event');
      return;
    }
    state.restoreTimer = setTimeout(() => tryRestore(remaining - 1), 100);
  };
  tryRestore(attempts);
}

function eventMessageIndex(payload) {
  const value = typeof payload === 'object' && payload !== null
    ? (payload.messageId ?? payload.message_id ?? payload.mesid ?? payload.index ?? payload.id)
    : payload;
  const index = Number(value);
  return Number.isInteger(index) ? index : null;
}

function onStreamTokenReceived() {
  if (!settings().enabled) return;
  // STREAM_TOKEN_RECEIVED fires once per streamed token. The old implementation cleared the whole
  // chat cache and rebuilt every historical row for every token, making cost grow with chat length.
  // Keep this path tail-only and throttled; full reconciliation still runs on MESSAGE_RECEIVED /
  // GENERATION_ENDED, where it belongs.
  if (!isGenerationActive() && !state.generationLifecycleActive) return;
  const now = Date.now();
  const wasActive = state.generationLifecycleActive;
  state.generationLifecycleActive = true;
  state.lastStreamTokenAt = now;
  state.latestRowChangedAt = now;
  if (!wasActive) state.generationStartedAt = now;
  if (state.latestRowKey) cancelSettleTimer({ key: state.latestRowKey });
  if (state.streamProbeTimer) return;

  state.streamProbeTimer = setTimeout(() => {
    state.streamProbeTimer = null;
    const latest = latestAssistantTailProbe();
    if (!latest) return;
    const revision = noteRowRevision(latest, false);
    state.latestRowKey = latest.key;
    state.latestRowHash = latest.rawHash;
    state.latestRowChangedAt = Math.max(state.lastStreamTokenAt || 0, revision?.changedAt || 0, Date.now());
    cancelSettleTimer(latest);
  }, STREAM_TAIL_PROBE_MS);
}

function onMessageReceived() {
  if (!settings().enabled) return;
  if (state.streamProbeTimer) clearTimeout(state.streamProbeTimer);
  state.streamProbeTimer = null;
  invalidateRuntimeCaches('message received');
  const row = observeLatestAssistantRow(true);
  // Some SillyTavern/back-end paths commit MESSAGE_RECEIVED just after GENERATION_ENDED. If visible
  // generation is already inactive, this is the strongest final-body signal and should kick summary now.
  if (row && !generationIsActiveForGodlog(row)) markRowFinalizedForGodlog(row);
  scheduleMemoryAfterSettle('AI消息完整写入后处理', row);
}

function onLatestMessageRendered(payload) {
  if (!settings().enabled) return;
  const index = eventMessageIndex(payload);
  if (index === null) return;
  const latest = latestAssistantRow();
  if (!latest || latest.index !== index) return;
  const previousHash = state.latestRowHash;
  observeLatestAssistantRow(false);
  const data = memoryData();
  const item = godlogForRow(data, latest);
  if ((previousHash && previousHash !== latest.rawHash) || (item?.rawHash && item.rawHash !== latest.rawHash)) {
    onChatMutated('当前楼渲染内容已更新');
    return;
  }
  scheduleAnchorCheck();
}

function onChatChanged() {
  state.requests.abortAll('chat-changed');
  state.contextEpoch += 1;
  state.godlogCleanupEpoch = -1;
  resetMessageVisibilityTracking();
  state.running = false;
  state.anchorPreparing = false;
  state.mergeRunning = false;
  state.archiveRunning = false;
  state.summaryRunning = false;
  state.codexRunning = false;
  state.jobRunning = false;
  state.pendingIntervalRecheck = false;
  clearAllSummaryRuntimeTasks();
  invalidateMemoryDataCache();
  invalidateRuntimeCaches('chat changed');
  if (state.queueTimer) clearTimeout(state.queueTimer);
  if (state.jobTimer) clearTimeout(state.jobTimer);
  if (state.restoreTimer) clearTimeout(state.restoreTimer);
  if (state.mutationTimer) clearTimeout(state.mutationTimer);
  if (state.streamProbeTimer) clearTimeout(state.streamProbeTimer);
  if (state.panelRenderTimer) clearTimeout(state.panelRenderTimer);
  if (state.messageKeySaveTimer) clearTimeout(state.messageKeySaveTimer);
  if (state.visibleRenderTimer) cancelAnimationFrame(state.visibleRenderTimer);
  clearAllSettleTimers();
  state.queueTimer = null;
  state.jobTimer = null;
  state.restoreTimer = null;
  state.mutationTimer = null;
  state.streamProbeTimer = null;
  state.panelRenderTimer = null;
  state.messageKeySaveTimer = null;
  state.visibleRenderTimer = null;
  state.panelRenderAll = false;
  state.panelRenderTargets.clear();
  state.panelRenderAttempt = 0;
  state.latestRowKey = '';
  state.latestRowHash = '';
  state.latestRowChangedAt = 0;
  state.generationLifecycleActive = false;
  state.generationStartedAt = 0;
  state.generationEndedAt = 0;
  state.rowRevisionState.clear();
  state.finalizedRowHashes.clear();
  state.jobSources.clear();
  state.selectedRecallMessageKey = '';
  state.lastInjectionRefs = [];
  state.pendingInjectionContent = '';
  state.vectorCache.clear();
  clearRecallPrefetch();
  setExtensionPrompt(CORE_PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0);
  setExtensionPrompt(RECALL_PROMPT_KEY, '', extension_prompt_types.IN_PROMPT, 0);
  state.lastRecall = '';
  state.lastRecallMeta = [];
  state.lastRecallQuery = null;
  state.lastRecentFacts = '';
  state.lastRecentFactsMeta = [];
  state.lastPromptInjection = '';

  // CHAT_CHANGED can be emitted before chatMetadata is fully restored.
  // Defer one task so we read the persisted object instead of creating and
  // mutating a throw-away default object.
  scheduleRestoreCurrentChatState('切换聊天');
  setTimeout(bindLazyMessageRendering, 0);
}

function onChatMutated(reason) {
  if (!settings().enabled) return;
  invalidateRuntimeCaches(reason || 'chat mutated');
  // Swipe/edit/delete events can fire before SillyTavern has committed the new message object.
  // Debounce to the next settled state so the old summary is removed from metadata and UI reliably.
  if (state.mutationTimer) clearTimeout(state.mutationTimer);
  state.mutationTimer = setTimeout(() => {
    state.mutationTimer = null;
    observeLatestAssistantRow(false);
    syncGodlogsWithChat(reason);
    const latest = latestAssistantRow();
    if (latest && !isRowSettledForGodlog(latest)) scheduleMemoryAfterSettle(reason, latest);
    else queueMemoryJob(reason, 120);
    updatePreview();
    scheduleGodlogPanelRender();
  }, 120);
}

window.anchorMemory_onGenerate = async (chat, contextSize, abort, type) => {
  if (type === 'quiet') return;
  if (!settings().enabled) {
    clearInjectedPromptState();
    if (Array.isArray(chat)) removeExistingAnchorMemoryPrompt(chat);
    return;
  }
  const operationEpoch = state.contextEpoch;
  const cancelIfPaused = () => {
    if (settings().enabled && operationEpoch === state.contextEpoch) return false;
    clearInjectedPromptState();
    if (Array.isArray(chat)) removeExistingAnchorMemoryPrompt(chat);
    return true;
  };
  if (Number.isFinite(Number(contextSize)) && Number(contextSize) > 0) state.lastContextSize = Number(contextSize);
  // This interceptor is the last backend-independent guard before prompt construction.
  await reconcileStrictRecentWindow('generate interceptor');
  if (cancelIfPaused()) return;
  const generationChat = chat || [];
  beginDynamicRecallCycle(generationChat, 'generate interceptor');
  // Chat-completion backends have a later final-array hook. Start prefetch here, then let
  // CHAT_COMPLETION_PROMPT_READY await the bounded result while it edits the real request array.
  // Other backends must resolve recall here because setExtensionPrompt is their final path.
  let recallResolution = null;
  if (settings().useDynamicRecall) {
    if (usesChatCompletionPromptReady()) {
      prepareDynamicRecall(generationChat).catch(err => console.warn('[AnchorMemory] generate prefetch failed', err));
    } else {
      recallResolution = await resolveDynamicRecallBeforeSend(generationChat, DYNAMIC_RECALL_PROMPT_WAIT_MS);
    }
  }
  if (cancelIfPaused()) return;
  await injectMemory(generationChat, {
    generation: true,
    resolvedRecall: recallResolution,
  });
  if (cancelIfPaused()) return;
  if (Array.isArray(chat)) {
    const contextChat = getContext().chat || [];
    // Always apply the cap here as well. CHAT_COMPLETION_PROMPT_READY is a second final-array guard,
    // not a reason to skip text-completion or backend-specific generation paths.
    applyGodlogContextReplacement(chat, {
      mode: 'generate-interceptor-history-hide',
      prune: chat !== contextChat,
    });
  }
};

async function bootstrapAnchorMemory() {
  $ = globalThis.jQuery || globalThis.$ || $;
  if (globalThis.__anchorMemoryBootstrapped) return;
  globalThis.__anchorMemoryBootstrapped = true;

  await loadLegacyRuntimeFallbacks();
  refreshRuntimeBindings();

  if (!$) {
    globalThis.__anchorMemoryBootstrapped = false;
    console.error('[AnchorMemory] jQuery is not ready; retrying initialization.');
    setTimeout(bootstrapAnchorMemory, 500);
    return;
  }

  installExtensionSettingsEntry();
  const settingsUrl = new URL('./settings.html', import.meta.url);
  // Put the launcher on screen before loading the workbench template. A missing/slow template
  // must not make the entire extension look absent.
  try {
    installNavbarEntry();
  } catch (err) {
    console.error('[AnchorMemory] early navbar install failed', err);
  }
  try {
    const response = await fetch(settingsUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status} while loading settings.html`);
    const html = await response.text();
    if (!$('#anchor_memory_workbench').length) $('body').append(html);
  } catch (err) {
    console.warn('[AnchorMemory] failed to load settings', err);
  }

  try {
    loadUi();
  } catch (err) {
    console.error('[AnchorMemory] loadUi failed', err);
  }
  try {
    bindUi();
  } catch (err) {
    console.error('[AnchorMemory] bindUi failed', err);
  }
  bindLazyMessageRendering();
  installPublicApi();
  installNavbarEntry();
  installExtensionSettingsEntry();
  try {
    scheduleRestoreCurrentChatState('插件启动同步');
  } catch (err) {
    console.error('[AnchorMemory] startup sync failed', err);
  }

  registerEventHandlers(['CHAT_CHANGED'], onChatChanged);
  // Anchor summaries are created for assistant turns. Do not listen to the
  // generic MESSAGE_RENDERED event: it fires for every historical floor on a
  // refresh and was the main cause of false regeneration jobs.
  registerEventHandlers(['USER_MESSAGE_RENDERED'], onUserMessageRendered);
  registerEventHandlers(['GENERATION_AFTER_COMMANDS'], onGenerationAfterCommands);
  registerEventHandlers(['GENERATION_STARTED'], onGenerationStarted);
  registerEventHandlers(['STREAM_TOKEN_RECEIVED'], onStreamTokenReceived);
  registerEventHandlers(['MESSAGE_RECEIVED'], onMessageReceived);
  registerEventHandlers(['GENERATION_ENDED'], () => onGenerationFinished('AI生成结束'));
  registerEventHandlers(['GENERATION_STOPPED'], () => onGenerationFinished('AI生成停止'));
  registerEventHandlers(['CHARACTER_MESSAGE_RENDERED'], scheduleAnchorCheck, 'makeLast');
  registerEventHandlers(['MESSAGE_RENDERED'], onLatestMessageRendered);
  registerEventHandlers(['CHAT_COMPLETION_PROMPT_READY'], injectMemoryIntoPromptReady);
  registerEventHandlers(['CHARACTER_MESSAGE_RENDERED', 'MESSAGE_RENDERED'], scheduleGodlogPanelRender);
  registerEventHandlers(['MESSAGE_DELETED'], () => onChatMutated('楼层已删除'));
  registerEventHandlers(['MESSAGE_UPDATED', 'MESSAGE_EDITED'], () => onChatMutated('楼层已编辑'));
  registerEventHandlers(['MESSAGE_SWIPED'], messageId => {
    onChatMutated('楼层已切换swipe');
    scheduleGodlogPanelRender(messageId);
  });
  registerEventHandlers(['TOOL_CALLS_RENDERED'], () => onChatMutated('工具调用内容已写入当前楼'));

  if (hasPersistentChatContext()) {
    injectMemory().catch(err => console.warn('[AnchorMemory] initial inject failed', err));
  }
  scheduleGodlogPanelRender();
  window.addEventListener('pagehide', () => { state.requests.abortAll('pagehide'); saveMetadataDebounced(); flushMemoryNow(); }, { once: false });
  console.info('[AnchorMemory] loaded', EXTENSION_VERSION);
}

export async function onActivate() {
  await bootstrapAnchorMemory();
}

function scheduleBootstrap() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrapAnchorMemory, { once: true });
  } else {
    queueMicrotask(bootstrapAnchorMemory);
  }
}

scheduleBootstrap();
