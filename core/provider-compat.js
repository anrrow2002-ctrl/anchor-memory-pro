/**
 * OpenAI-compatible provider URL normalization for Anchor Memory.
 *
 * SillyTavern's generic Chat Completions reverse proxy expects a BASE URL and
 * appends /chat/completions itself. Users, however, often paste either a host
 * root or a full provider endpoint. Normalize both forms without rewriting
 * already-specific provider paths (e.g. DeepSeek /beta or StepFun /step_plan/v1).
 */

const ENDPOINT_SUFFIXES = [
  '/chat/completions',
  '/responses',
  '/embeddings',
  '/models',
];

const PROVIDERS = [
  {
    id: 'volcengine-ark',
    name: '火山方舟 / 豆包',
    hosts: ['ark.cn-beijing.volces.com'],
    basePath: '/api/v3',
    aliases: ['/v1'],
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    hosts: ['api.siliconflow.cn', 'api.siliconflow.com'],
    basePath: '/v1',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    hosts: ['api.deepseek.com'],
    basePath: '',
  },
  {
    id: 'moonshot',
    name: 'Kimi / Moonshot',
    hosts: ['api.moonshot.cn', 'api.moonshot.ai'],
    basePath: '/v1',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    hosts: ['open.bigmodel.cn'],
    basePath: '/api/paas/v4',
    aliases: ['/v1'],
  },
  {
    id: 'qianfan',
    name: '百度千帆',
    hosts: ['qianfan.baidubce.com'],
    basePath: '/v2',
    aliases: ['/v1'],
  },
  {
    id: 'hunyuan',
    name: '腾讯混元',
    hosts: ['api.hunyuan.cloud.tencent.com'],
    basePath: '/v1',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    hosts: ['api.minimaxi.com', 'api.minimax.io'],
    basePath: '/v1',
  },
  {
    id: 'stepfun',
    name: '阶跃星辰 StepFun',
    hosts: ['api.stepfun.com'],
    basePath: '/v1',
  },
  {
    id: 'baichuan',
    name: '百川智能',
    hosts: ['api.baichuan-ai.com'],
    basePath: '/v1',
  },
  {
    id: 'gitee-ai',
    name: '模力方舟 Gitee AI',
    hosts: ['ai.gitee.com'],
    basePath: '/v1',
  },
  {
    id: 'modelscope',
    name: '魔搭 ModelScope',
    hosts: ['api-inference.modelscope.cn'],
    basePath: '/v1',
  },
  {
    id: 'dashscope',
    name: '阿里云百炼 / 通义千问',
    hosts: ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com'],
    hostSuffixes: ['.maas.aliyuncs.com'],
    basePath: '/compatible-mode/v1',
    aliases: ['/v1'],
  },
];

function ensureScheme(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) return value;
  // Preserve explicitly relative/local paths rather than inventing a remote URL.
  if (/^[/.]/.test(value)) return value;
  return `https://${value}`;
}

function cleanPath(pathname) {
  let path = String(pathname || '').replace(/\/{2,}/g, '/');
  if (path !== '/') path = path.replace(/\/+$/, '');
  const lower = path.toLowerCase();
  for (const suffix of ENDPOINT_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      path = path.slice(0, path.length - suffix.length).replace(/\/+$/, '');
      break;
    }
  }
  return path === '/' ? '' : path;
}

function hostMatches(profile, hostname) {
  const host = String(hostname || '').toLowerCase();
  if (profile.hosts?.some(value => host === value)) return true;
  return !!profile.hostSuffixes?.some(suffix => host.endsWith(suffix));
}

export function detectOpenAiCompatibleProvider(url) {
  const candidate = ensureScheme(url);
  if (!candidate || /^[/.]/.test(candidate)) return null;
  try {
    const parsed = new URL(candidate);
    return PROVIDERS.find(profile => hostMatches(profile, parsed.hostname)) || null;
  } catch {
    return null;
  }
}

export function normalizeOpenAiCompatibleBaseUrl(url) {
  const raw = ensureScheme(url);
  if (!raw) return '';

  // Keep legacy behavior for a relative/local non-URL value.
  if (/^[/.]/.test(raw)) {
    return String(raw)
      .trim()
      .replace(/\/+$/, '')
      .replace(/\/chat\/completions\/?$/i, '')
      .replace(/\/responses\/?$/i, '')
      .replace(/\/embeddings\/?$/i, '')
      .replace(/\/models\/?$/i, '');
  }

  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    parsed.search = '';
    let path = cleanPath(parsed.pathname);
    const provider = PROVIDERS.find(profile => hostMatches(profile, parsed.hostname));

    if (provider) {
      const aliases = new Set((provider.aliases || []).map(value => String(value).toLowerCase()));
      if (!path || aliases.has(path.toLowerCase())) path = provider.basePath;
    }

    parsed.pathname = path || '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    // Invalid/custom values still get endpoint-suffix stripping instead of failing configuration.
    return String(raw)
      .trim()
      .replace(/[?#].*$/, '')
      .replace(/\/+$/, '')
      .replace(/\/chat\/completions\/?$/i, '')
      .replace(/\/responses\/?$/i, '')
      .replace(/\/embeddings\/?$/i, '')
      .replace(/\/models\/?$/i, '');
  }
}

export function openAiCompatibleProviderInfo(url) {
  const profile = detectOpenAiCompatibleProvider(url);
  const baseUrl = normalizeOpenAiCompatibleBaseUrl(url);
  return {
    id: profile?.id || 'custom',
    name: profile?.name || '自定义 OpenAI 兼容接口',
    recognized: !!profile,
    baseUrl,
  };
}

export function providerCompatibilityHint(url) {
  const info = openAiCompatibleProviderInfo(url);
  if (!String(url || '').trim()) {
    return '支持自动识别火山方舟/豆包、硅基流动、DeepSeek、百炼/千问、Kimi、智谱GLM、百度千帆、腾讯混元、MiniMax、阶跃星辰、百川、Gitee AI、魔搭；也支持其他 OpenAI 兼容接口。';
  }
  if (!info.baseUrl) return 'API 地址无法识别，请检查 URL。';
  return `${info.recognized ? `已识别：${info.name}` : info.name}；实际请求 Base URL：${info.baseUrl}`;
}

export const OPENAI_COMPATIBLE_PROVIDER_PROFILES = Object.freeze(
  PROVIDERS.map(profile => Object.freeze({ ...profile })),
);

/**
 * Interpret provider finish reasons conservatively without throwing away a body
 * that already satisfies the caller's task-specific completeness contract.
 *
 * Several OpenAI-compatible gateways report `length` whenever the generation
 * counter touches the ceiling, even when the requested XML/Markdown payload has
 * already closed cleanly. The finish reason is therefore an auxiliary signal;
 * the task-specific validator is authoritative for whether a retry is needed.
 */
export function assessOutputLimitResult(finishReason, content, isContentComplete = null) {
  const reason = String(finishReason || '').toLowerCase();
  const outputLimitReasons = new Set(['length', 'max_tokens', 'max_output_tokens', 'token_limit']);
  const hitOutputLimit = outputLimitReasons.has(reason);
  let contentComplete = false;
  let validatorError = null;

  if (hitOutputLimit && typeof isContentComplete === 'function') {
    try {
      contentComplete = !!isContentComplete(String(content || ''));
    } catch (err) {
      validatorError = err;
      contentComplete = false;
    }
  }

  return {
    reason,
    hitOutputLimit,
    contentComplete,
    shouldRetry: hitOutputLimit && !contentComplete,
    validatorError,
  };
}
