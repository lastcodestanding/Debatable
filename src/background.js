// background.js - service worker
// Responsible for brokering API calls, caching, and message routing.

const MODEL_VERSION = 'prompt-v1';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

const DEFAULT_CLASS_DEFS = [
  { id: 'false', label: 'False', definition: 'Contradicts well-established facts.' },
  { id: 'debated', label: 'Debated', definition: 'Credible expert disagreement presented as fact.' },
  { id: 'hyperbole', label: 'Hyperbole', definition: 'Rhetorical or promotional exaggeration.' },
  { id: 'neutral', label: 'Neutral', definition: 'No issues detected.' }
];

function debugLog(enabled, ...args) {
  if (!enabled) return;
  console.log('[Debatable Debug]', ...args);
}

function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/**
 * In-memory LRU-ish cache (resets when service worker unloads). For persistence we also mirror to chrome.storage.local.
 */
const memoryCache = new Map();

function normalizeStoredClasses(raw) {
  const normalized = [];
  const seen = new Set();
  if (Array.isArray(raw) && raw.length) {
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const id = String(item.id || item.key || '').trim().toLowerCase();
      if (!id || seen.has(id)) continue;
      const label = String(item.label || item.name || id).trim() || id;
      const definition = String(item.definition || item.description || '').trim();
      normalized.push({ id, label, definition });
      seen.add(id);
    }
  } else {
    return DEFAULT_CLASS_DEFS.map(c => ({ ...c }));
  }
  if (!seen.has('neutral')) {
    normalized.push({ id: 'neutral', label: 'Neutral', definition: 'No issues detected.' });
  }
  return normalized;
}

async function classifyBatch(sentences, pageUrl, options) {
  const batchStartMonotonic = nowMs();
  // Basic cache key per sentence
  const modelVersion = MODEL_VERSION;
  const now = Date.now();
  const cached = [];
  const toQuery = [];
  for (let i = 0; i < sentences.length; i++) {
    const text = sentences[i];
    const key = hashKey(pageUrl, text, modelVersion);
    const mem = memoryCache.get(key);
    if (mem && (now - mem.ts) < CACHE_TTL_MS) {
      cached.push({ index: i, ...mem.data });
    } else {
      toQuery.push({ index: i, text, key });
    }
  }

  const rawSettings = await chrome.storage.local.get(['enablePromptApi','modelId','privacyMode','promptTemplate','classificationClasses','debugLogging']);
  const settings = {
    enablePromptApi: rawSettings.enablePromptApi ?? true,
    modelId: rawSettings.modelId || 'gemini-nano',
    privacyMode: rawSettings.privacyMode ?? false,
    promptTemplate: rawSettings.promptTemplate || null,
    classificationClasses: rawSettings.classificationClasses || null,
    debugLogging: rawSettings.debugLogging ?? false
  };
  const debugEnabled = Boolean(settings.debugLogging);
  const classDefs = normalizeStoredClasses(settings.classificationClasses);
  let apiResults = [];
  let mode = 'heuristic';
  let errorMsg = '';
  let debugPayload = null;

  debugLog(debugEnabled, 'Starting classifyBatch', {
    sentencesRequested: sentences.length,
    toQueryCount: toQuery.length,
    cachedCount: cached.length,
    pageUrl,
    modelVersion
  });

  if (toQuery.length) {
    try {
      if (settings.enablePromptApi) {
        debugLog(debugEnabled, 'Dispatching remote classification batch', {
          statements: toQuery.length,
          pageUrl,
          modelVersion
        });
        apiResults = await callPromptAPI(toQuery.map(x => x.text), settings, classDefs);
        mode = 'remote';
        if (apiResults && apiResults.debug) {
          debugPayload = apiResults.debug;
        }
      } else {
        apiResults = { items: toQuery.map(t => mockClassify(t.text, t.index, settings)) };
        mode = 'heuristic';
      }

      for (let item of apiResults.items || []) {
        const orig = toQuery[item.index];
        if (!orig) continue;
        const data = normalizeClassification(item, classDefs);
        memoryCache.set(orig.key, { ts: now, data });
      }
    } catch (e) {
      console.warn('Primary classification failed, using heuristic fallback', e);
      debugLog(debugEnabled, 'Prompt API request failed, switching to heuristic fallback', {
        message: e.message,
        statements: toQuery.length
      });
      if (debugEnabled && !debugPayload) {
        debugPayload = {
          error: e.message || String(e),
          statements: toQuery.length,
          mode: 'remote-error'
        };
      }
      apiResults = { items: toQuery.map(t => mockClassify(t.text, t.index, settings, true)) };
      mode = settings.enablePromptApi ? 'heuristic-fallback' : 'heuristic';
      errorMsg = e.message || String(e);
      for (let item of apiResults.items) {
        const orig = toQuery[item.index];
        if (!orig) continue;
        const data = normalizeClassification(item, classDefs);
        memoryCache.set(orig.key, { ts: now, data });
      }
    }
  } else {
    debugLog(debugEnabled, 'All statements satisfied by cache', {
      sentences: sentences.length
    });
  }

  if (mode === 'heuristic' && toQuery.length) {
    debugLog(debugEnabled, 'Processed batch using heuristic scoring', {
      statements: toQuery.length
    });
  }

  // Compose final list in original order
  const merged = sentences.map((_, i) => {
    const text = sentences[i];
    const key = hashKey(pageUrl, text, modelVersion);
    const mem = memoryCache.get(key);
    if (!mem) {
      return { index: i, text, category: 'neutral', confidence: 0.0, rationale: 'Unclassified' };
    }
    return { index: i, text, ...mem.data };
  });

  const elapsedMs = nowMs() - batchStartMonotonic;
  const batchMetrics = {
    elapsedMs: Number(elapsedMs.toFixed(1)),
    requested: sentences.length,
    remoteEvaluations: toQuery.length,
    cacheHits: cached.length,
    mode
  };

  debugLog(debugEnabled, 'Batch finished', {
    mode,
    error: errorMsg,
    items: merged.length,
    elapsedMs: batchMetrics.elapsedMs,
    cacheHits: cached.length,
    remoteEvaluations: toQuery.length
  });

  const summary = { modelVersion, items: merged, mode, error: errorMsg };

  if (debugEnabled) {
    const combinedDebug = { ...(debugPayload || {}), batchMetrics };
    summary.debug = combinedDebug;
  } else if (debugPayload) {
    summary.debug = debugPayload;
  }

  return summary;
}

function normalizeClassification(item, classDefs) {
  let { category, confidence, rationale } = item;
  const allowed = new Set(allowedCategories(classDefs));
  category = String(category || '').trim().toLowerCase();
  if (!allowed.has(category)) category = 'neutral';
  if (category === 'neutral') {
    return { category };
  }
  confidence = typeof confidence === 'number' ? Math.min(1, Math.max(0, confidence)) : 0.5;
  rationale = rationale ? String(rationale).slice(0, 400) : '';
  return { category, confidence, rationale };
}

async function callPromptAPI(sentences, settings, classDefs) {
  // Note: This function is preserved for potential future external API integration
  // Currently the extension primarily uses the on-device Gemini Nano path
  throw new Error('External API not configured. Use on-device model (enablePromptApi should be false).');
}

function mockClassify(text, index, settings = {}, fallback = false) {
  const lower = text.toLowerCase();
  // improved patterns
  if (/\bthe earth has two moons\b|\bperpetual motion machine\b/.test(lower)) {
    return { index, category: 'false', confidence: 0.9, rationale: 'Contradicts established science.' };
  }
  if (/(quantum supremacy|ai has achieved consciousness|cold fusion has been solved)/.test(lower)) {
    return { index, category: 'debated', confidence: 0.72, rationale: 'Claim area has ongoing expert debate.' };
  }
  const intense = /(literally|change.*forever|revolutionary|game-?changing|the best ever|unprecedented|absolutely incredible)/.test(lower);
  const hasMetric = /\b(\d+%|\d+x|\d+\.\d+|megapixel|fps|nm|gigabit|tera|petaflop|times?)\b/.test(lower);
  if (intense) {
    return { index, category: 'hyperbole', confidence: hasMetric ? 0.5 : 0.62, rationale: 'Promotional / intensity phrasing' + (hasMetric ? ' (some evidence present)' : '') + '.' };
  }
  return { index, category: 'neutral' };
}

function sanitizeForSend(text, privacyMode) {
  let t = text;
  // Redact simple PII patterns
  t = t.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+/gi, '[EMAIL]');
  t = t.replace(/\b\d{6,}\b/g, '[NUMBER]');
  if (privacyMode) {
    // Already just sentence; could truncate further
    t = t.slice(0, 320);
  }
  return t;
}

function defaultPromptTemplate() {
  return `You are a factuality, debate and rhetoric classifier. Output ONLY JSON. \nDefinitions: \n{{DEFINITIONS}} \nStatements (JSON array): \n{{STATEMENTS_JSON}} \nCategories: {{CLASS_IDS}} \nRules: \n- Return {"items":[...]} with objects that always include "category" ONLY WHEN CATEGORY IS NEUTRAL. \n- Do NOT RETURN if category is neutral. \n- Only include "confidence" (0-1) when category is not "neutral". \n- Do NOT add rationale for ANY category. \n- If insufficient info -> neutral.`
}

function definitionsBlock(classDefs) {
  const defs = classDefinitionsString(classDefs);
  return defs || `\ndebated: Opinions disputed or with multiple viewpoints.\nhyperbole: Rhetorical or promotional exaggeration.\nneutral: none of the above.`;
}

function responseSchema(classIds) {
  return {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer' },
            category: { type: 'string', enum: Array.isArray(classIds) && classIds.length ? classIds : undefined },
            confidence: { type: 'number' },
            rationale: { type: 'string' }
          },
          required: ['index','category']
        }
      }
    },
    required: ['items']
  };
}

function hashKey(pageUrl, text, modelVersion) {
  return `${modelVersion}::${pageUrl}::${text.toLowerCase().trim()}`;
}

function extractTokenUsage(data) {
  if (!data || typeof data !== 'object') return null;
  const candidates = [];
  const usage = data.usage;
  if (usage && typeof usage === 'object') candidates.push(usage);
  const tokenUsage = data.tokenUsage || data.token_usage;
  if (tokenUsage && typeof tokenUsage === 'object') candidates.push(tokenUsage);
  if (data.tokens && typeof data.tokens === 'object') candidates.push(data.tokens);
  if (data.metrics && typeof data.metrics === 'object' && typeof data.metrics.tokens === 'object') {
    candidates.push(data.metrics.tokens);
  }
  if (data.stats && typeof data.stats === 'object' && typeof data.stats.tokens === 'object') {
    candidates.push(data.stats.tokens);
  }
  if (!candidates.length) return null;

  const promptKeys = ['promptTokens', 'prompt_tokens', 'inputTokens', 'input_tokens'];
  const completionKeys = ['completionTokens', 'completion_tokens', 'outputTokens', 'output_tokens', 'generationTokens', 'generation_tokens'];
  const totalKeys = ['totalTokens', 'total_tokens'];

  let promptTokens = null;
  let completionTokens = null;
  let totalTokens = null;

  const toNumber = (value) => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value.trim());
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  };

  const readNumber = (source, keys) => {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        const num = toNumber(source[key]);
        if (num != null) return num;
      }
    }
    return null;
  };

  for (const src of candidates) {
    if (!src || typeof src !== 'object') continue;
    if (promptTokens == null) promptTokens = readNumber(src, promptKeys);
    if (completionTokens == null) completionTokens = readNumber(src, completionKeys);
    if (totalTokens == null) totalTokens = readNumber(src, totalKeys);
  }

  if (totalTokens == null && promptTokens != null && completionTokens != null) {
    totalTokens = promptTokens + completionTokens;
  }

  if (promptTokens == null && completionTokens == null && totalTokens == null) {
    return null;
  }

  return {
    promptTokens: promptTokens != null ? promptTokens : null,
    completionTokens: completionTokens != null ? completionTokens : null,
    totalTokens: totalTokens != null ? totalTokens : (promptTokens != null && completionTokens != null ? promptTokens + completionTokens : null)
  };
}

// (Optional) future: persist memoryCache periodically.
