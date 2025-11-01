// contentScript.js
// Extract sentences, request classification, apply highlights.

const MAX_SENTENCES_INITIAL = 60;
const BATCH_SIZE = 20;

const DEFAULT_CLASS_DEFS = [
  // { id: 'false', label: 'False', definition: 'Contradicts well-established facts.', color: '#ef4444', textColor: '#ffffff' },
  { id: 'debated', label: 'Debated', definition: 'Opinions disputed or with multiple viewpoints.', color: '#facc15', textColor: '#ffffff' },
  { id: 'hyperbole', label: 'Hyperbole', definition: 'Rhetorical or promotional exaggeration.', color: '#fb923c', textColor: '#ffffff' },
  { id: 'neutral', label: 'Neutral', definition: 'No apparent factual issues.', color: '#9ca3af', textColor: '#ffffff' }
];

const PANEL_ORIGIN = new URL(chrome.runtime.getURL('src/ui/panel.html')).origin;

// Global state for panel communication
window.__factFlagState = {
  sentences: [], // { text, element, id }
  classifications: [], // raw classification items merged with sentence ids
  flagged: [], // subset with display categories
  classes: DEFAULT_CLASS_DEFS,
  progress: { total: 0, completed: 0, status: 'idle', etaMs: 0 },
  errors: [],
  debugEnabled: false,
  debugPrompts: [],
  pendingPanelFocus: null
};

const highlightedIds = new Set();
let highlightTooltipEl = null;
let highlightInteractionBound = false;

function normalizeClassesFromStorage(stored) {
  const normalized = [];
  const seen = new Set();
  if (Array.isArray(stored) && stored.length) {
    for (const raw of stored) {
      if (!raw || typeof raw !== 'object') continue;
      const id = String(raw.id || raw.key || '').trim().toLowerCase();
      if (!id || seen.has(id)) continue;
      const base = DEFAULT_CLASS_DEFS.find(c => c.id === id) || {};
      const label = String(raw.label || raw.name || base.label || id);
      const definition = String(raw.definition || raw.description || base.definition || '');
      const color = validateHexColor(raw.color) ? raw.color : (base.color || '#9ca3af');
      const textColor = validateHexColor(raw.textColor) ? raw.textColor : (base.textColor || '#111111');
      normalized.push({ id, label, definition, color, textColor });
      seen.add(id);
    }
  } else {
    return DEFAULT_CLASS_DEFS.map(c => ({ ...c }));
  }
  if (!seen.has('neutral')) {
    const fallbackNeutral = DEFAULT_CLASS_DEFS.find(c => c.id === 'neutral');
    if (fallbackNeutral) normalized.push({ ...fallbackNeutral });
  }
  return normalized;
}

function validateHexColor(color) {
  if (typeof color !== 'string') return false;
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color.trim());
}

function rgbaFromHex(hex, alpha = 0.28) {
  if (!validateHexColor(hex)) return `rgba(156,163,175,${alpha})`;
  const clean = hex.replace('#', '');
  const isShort = clean.length === 3;
  const r = parseInt(isShort ? clean[0] + clean[0] : clean.slice(0, 2), 16);
  const g = parseInt(isShort ? clean[1] + clean[1] : clean.slice(2, 4), 16);
  const b = parseInt(isShort ? clean[2] + clean[2] : clean.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function classById(id) {
  return (window.__factFlagState.classes || []).find(c => c.id === id) || null;
}

function buildClassDefinitionsString(classes) {
  return (classes || []).map(cls => {
    const id = (cls.id || '').toString().trim();
    if (!id) return '';
    const label = (cls.label || '').toString().trim();
    const definition = (cls.definition || '').toString().trim() || 'No definition provided.';
    const header = label && label.toLowerCase() !== id ? `${id} (${label})` : id;
    return `${header}:\n  ${definition}`;
  }).filter(Boolean).join('\n\n');
}

(async function init() {
  if (window.top !== window.self) return; // ignore iframes for now
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();

function start() {
  injectStylesIfNeeded();
  ensureHighlightInteractions();
  analyzePage();
  setupMessageListener();
  // TODO: mutation observer for dynamic content.
}

async function analyzePage() {
  highlightedIds.clear();
  window.__factFlagState.errors = [];
  const cfg = await getSettings();
  window.__factFlagState.debugEnabled = Boolean(cfg.debugLogging);
  window.__factFlagState.debugPrompts = [];
  window.__factFlagState.pendingPanelFocus = null;
  const classes = normalizeClassesFromStorage(cfg.classificationClasses);
  window.__factFlagState.classes = classes;
  renderLegend();
  renderDebugPrompts();
  const sentences = extractSentences();
  const maxSentences = Number(cfg.maxSentences) > 0 ? Number(cfg.maxSentences) : MAX_SENTENCES_INITIAL;
  const limited = sentences.slice(0, maxSentences);
  window.__factFlagState.sentences = limited.map((s) => ({ ...s, id: genId(s.text) }));
  window.__factFlagState.classifications = new Array(limited.length).fill(null);
  window.__factFlagState.flagged = [];
  window.__factFlagState.lastRunMeta = null;
  window.__factFlagState.progress = {
    total: limited.length,
    completed: 0,
    status: limited.length ? 'pending' : 'idle',
    etaMs: 0,
    startedAt: performance.now()
  };
  setLegendError('');
  broadcastPanelState();
  if (!limited.length) {
    updateLegendStatus();
    updateProgressUI({ reset: true });
    broadcastPanelState();
    return;
  }
  try {
    const wantsOnDevice = cfg.enablePromptApi && (cfg.modelId || '').toLowerCase().includes('gemini-nano');
    const onDeviceAvailable = hasOnDeviceAPI();
    if (wantsOnDevice && onDeviceAvailable) {
      const availability = await LanguageModel.availability();
      if (availability === 'unavailable') {
        window.__factFlagState.lastRunMeta = { mode: 'on-device-unavailable', error: 'LanguageModel API reports unavailable (hardware or flags).' };
        showToast('On-device model unavailable');
        await runRemoteOrHeuristic(cfg);
      } else if (availability === 'downloadable' || availability === 'downloading') {
        // Need user interaction; set status and attach one-time click listener
        window.__factFlagState.lastRunMeta = { mode: 'on-device-wait', error: null };
        updateLegendStatus();
        showToast('Click page to download on-device model');
        updateProgressUI({ setCompleted: 0, message: 'Tap to download on-device model', status: 'pending' });
        await waitForUserGesture();
        try {
          updateProgressUI({ setCompleted: 0, message: 'Downloading on-device model…', status: 'running' });
          const classifications = await classifyOnDeviceGeminiNano(window.__factFlagState.sentences, cfg, true /* showProgress */);
          window.__factFlagState.lastRunMeta = { mode: 'on-device', error: null };
          applyHighlights({ classifications });
          finalizeProgress(true, 'Complete');
          updateLegendStatus();
          showToast('On-device classification complete');
        } catch (err) {
          await handleOnDeviceError(err, cfg);
        }
      } else { // ready
        try {
          updateProgressUI({ setCompleted: 0, message: 'Running on-device model…', status: 'running' });
          const classifications = await classifyOnDeviceGeminiNano(window.__factFlagState.sentences, cfg);
          window.__factFlagState.lastRunMeta = { mode: 'on-device', error: null };
          applyHighlights({ classifications });
          finalizeProgress(true, 'Complete');
          updateLegendStatus();
          showToast('On-device classification complete');
        } catch (err) {
          await handleOnDeviceError(err, cfg);
        }
      }
    } else if (wantsOnDevice && !onDeviceAvailable) {
      window.__factFlagState.lastRunMeta = { mode: 'on-device-unavailable', error: 'LanguageModel global not present. Enable Chrome flags or update Chrome.' };
      showToast('On-device API missing – using remote/heuristic');
      await runRemoteOrHeuristic(cfg);
    } else {
      await runRemoteOrHeuristic(cfg);
    }
  } catch (e) {
    console.error('Classification failed', e);
    const message = e?.message || 'Classification failed';
    window.__factFlagState.errors.push(message);
    setLegendError(message);
    showToast('Classification failed – see console');
  }
}

async function handleOnDeviceError(err, cfg) {
  const message = err?.message || 'On-device classification failed';
  window.__factFlagState.lastRunMeta = { mode: 'on-device-failed', error: message };
  window.__factFlagState.errors.push(message);
  setLegendError(message);
  updateProgressUI({ reset: true });
  showToast('On-device failed – using fallback');
  await runRemoteOrHeuristic(cfg);
}

function extractSentences() {
  const blocks = Array.from(document.body.querySelectorAll('p, li, blockquote, td'));
  const out = [];
  for (const el of blocks) {
    if (!el || !el.innerText) continue;
    const text = el.innerText.trim();
    if (!text) continue;
    const splits = naiveSentenceSplit(text);
    for (const s of splits) {
      const clean = s.trim();
      if (clean.length < 25) continue;
      out.push({ text: clean, element: el });
    }
  }
  // Deduplicate by text
  const seen = new Set();
  const unique = [];
  for (const item of out) {
    const key = item.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function naiveSentenceSplit(text) {
  return text.split(/(?<=[.!?])\s+(?=[A-Z0-9])/).filter(Boolean);
}

async function batchClassify(sentArr, options = {}) {
  const sentences = sentArr.map(s => s.text);
  const batchSize = Number(options.batchSize) > 0 ? Number(options.batchSize) : BATCH_SIZE;
  const batches = [];
  for (let i = 0; i < sentences.length; i += batchSize) {
    batches.push(sentences.slice(i, i + batchSize));
  }
  const pageUrl = location.href;
  const finalItems = [];
  let overallMode = null;
  let overallError = null;
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const batchStart = performance.now();
    let response;
    try {
      response = await sendMessage({ type: 'CLASSIFY_BATCH', payload: { batchId: b, sentences: batch, pageUrl } });
    } catch (err) {
      if (typeof options.onError === 'function') {
        options.onError(err, { batchIndex: b, totalBatches: batches.length });
      }
      throw err;
    }
    const result = response?.result || {};
    if (result && !overallMode) overallMode = result.mode;
    if (result && result.error && !overallError) overallError = result.error;
    const enriched = (result.items || []).map(it => ({ ...it, globalIndex: b * batchSize + it.index }));
    finalItems.push(...enriched);
    const durationMs = performance.now() - batchStart;
    if (typeof options.onBatch === 'function') {
      options.onBatch({
        batchIndex: b,
        totalBatches: batches.length,
        items: enriched,
        rawResult: result,
        durationMs
      });
    }
  }
  return { sentences: sentArr, classifications: finalItems, meta: { mode: overallMode, error: overallError } };
}

function applyHighlights({ classifications, finalize = true }) {
  processBatchClassifications(classifications, { finalize });
}

function processBatchClassifications(classifications, { finalize = false } = {}) {
  const sentences = window.__factFlagState.sentences || [];
  if (!Array.isArray(classifications)) return;
  for (const raw of classifications) {
    const classification = upsertClassification(raw);
    if (!classification) continue;
    const sentence = sentences[classification.globalIndex];
    if (!sentence) continue;
    if (isFlaggedCategory(classification.category)) {
      if (highlightedIds.has(classification.id)) {
        updateHighlightMetadata(classification);
      } else if (highlightSentenceNodeWise(sentence.element, sentence.text, classification.category, classification)) {
        highlightedIds.add(classification.id);
      }
    }
  }
  window.__factFlagState.flagged = (window.__factFlagState.classifications || []).filter(Boolean).filter(c => isFlaggedCategory(c.category));
  if (finalize) ensureFallbackHighlights();
  ensureFloatingLegend();
  updateLegendStatus();
  broadcastPanelState();
}

function highlightSentenceNodeWise(rootEl, sentence, categoryId, metadata) {
  if (!rootEl || !sentence) return false;
  const classInfo = classById(categoryId) || chooseClass(categoryId);
  const spanFactory = () => {
    const span = document.createElement('span');
    span.className = 'fact-flag';
    applyHighlightStyle(span, classInfo);
    span.dataset.factMeta = encodeURIComponent(JSON.stringify(metadata));
    span.dataset.factId = metadata.id || genId(sentence);
    span.dataset.factCategory = categoryId;
    span.dataset.factRationale = metadata?.rationale ? metadata.rationale : '';
    return span;
  };

  const applyRange = (range) => {
    if (!range) return false;
    const span = spanFactory();
    try {
      const contents = range.extractContents();
      span.appendChild(contents);
      range.insertNode(span);
      return true;
    } catch (err) {
      console.warn('[AccuracyHighlighter] Failed to apply highlight range', err);
      return false;
    }
  };

  if (applyRange(createSentenceRange(rootEl, sentence))) return true;
  return applyRange(createSimpleRange(rootEl, sentence));
}

function createSentenceRange(rootEl, sentence) {
  if (!rootEl || !sentence) return null;
  const target = normalizeForComparison(sentence);
  if (!target) return null;
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, null);
  const charEntries = [];
  let node;
  while ((node = walker.nextNode())) {
    const value = node.nodeValue || '';
    if (!value) continue;
    for (let offset = 0; offset < value.length; offset++) {
      const ch = value[offset];
      const normalizedChar = /\s/.test(ch) ? ' ' : ch;
      charEntries.push({ node, offset, normalizedChar });
    }
  }
  if (!charEntries.length) return null;

  const normalizedChars = [];
  const collapsedEntries = [];
  let lastWasSpace = true;
  for (const entry of charEntries) {
    if (entry.normalizedChar === ' ') {
      if (lastWasSpace) continue;
      lastWasSpace = true;
    } else {
      lastWasSpace = false;
    }
    normalizedChars.push(entry.normalizedChar);
    collapsedEntries.push(entry);
  }
  while (normalizedChars.length && normalizedChars[normalizedChars.length - 1] === ' ') {
    normalizedChars.pop();
    collapsedEntries.pop();
  }
  const haystack = normalizedChars.join('');
  const startIndex = haystack.indexOf(target);
  if (startIndex === -1) return null;
  const endIndex = startIndex + target.length - 1;
  const startEntry = collapsedEntries[startIndex];
  const endEntry = collapsedEntries[endIndex];
  if (!startEntry || !endEntry) return null;
  const range = document.createRange();
  range.setStart(startEntry.node, startEntry.offset);
  const endNode = endEntry.node;
  const nodeTextLength = endNode.nodeValue ? endNode.nodeValue.length : 0;
  const endOffset = Math.min(endEntry.offset + 1, nodeTextLength);
  range.setEnd(endNode, endOffset);
  return range;
}

function createSimpleRange(rootEl, sentence) {
  if (!rootEl || !sentence) return null;
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, null);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const value = node.nodeValue || '';
    const idx = value.indexOf(sentence);
    if (idx !== -1) {
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + sentence.length);
      return range;
    }
  }
  return null;
}

function normalizeForComparison(str) {
  return String(str || '').replace(/\s+/g, ' ').trim();
}

function applyHighlightStyle(el, classInfo) {
  const accent = classInfo?.color || '#6b7280';
  el.style.background = rgbaFromHex(accent, 0.26);
  el.style.boxShadow = `inset 0 0 0 1px ${rgbaFromHex(accent, 0.55)}`;
  el.style.color = classInfo?.textColor || '#111111';
}

function upsertClassification(raw) {
  if (!raw) return null;
  const sentences = window.__factFlagState.sentences || [];
  const globalIndex = typeof raw.globalIndex === 'number' ? raw.globalIndex : raw.index;
  if (globalIndex == null) return null;
  const sentence = sentences[globalIndex];
  if (!sentence) return null;
  const category = normalizeCategory(raw.category);
  const classification = {
    globalIndex,
    index: raw.index ?? globalIndex,
    id: sentence.id,
    text: sentence.text,
    category,
    confidence: clamp01(typeof raw.confidence === 'number' ? raw.confidence : 0.5),
    rationale: String(raw.rationale || '').slice(0, 240)
  };
  if (category === 'neutral') {
    delete classification.confidence;
    delete classification.rationale;
  }
  window.__factFlagState.classifications[globalIndex] = classification;
  return classification;
}

function updateHighlightMetadata(classification) {
  if (!classification) return;
  const el = document.querySelector(`.fact-flag[data-fact-id='${CSS.escape(classification.id)}']`);
  if (!el) return;
  el.dataset.factMeta = encodeURIComponent(JSON.stringify(classification));
  el.dataset.factCategory = classification.category;
  el.dataset.factRationale = classification.rationale || '';
  const classInfo = classById(classification.category) || chooseClass(classification.category);
  applyHighlightStyle(el, classInfo);
}

function isFlaggedCategory(categoryId) {
  return Boolean(categoryId && categoryId !== 'neutral');
}

function ensureFallbackHighlights() {
  const flagged = window.__factFlagState.flagged || [];
  if (flagged.length) return;
  const sentences = window.__factFlagState.sentences || [];
  const fallbackClass = chooseClass('hyperbole');
  const fallbackId = fallbackClass.id;
  const picks = [];
  for (let i = 0; i < sentences.length && picks.length < 3; i++) {
    const s = sentences[i];
    if (!s || highlightedIds.has(s.id)) continue;
    if (/( is | are | was | were | will | can )/i.test(s.text)) {
      picks.push({ sentence: s, index: i });
    }
  }
  picks.forEach(({ sentence, index }) => {
    const meta = {
      globalIndex: index,
      index,
      category: fallbackId,
      confidence: 0.32,
      rationale: 'Fallback highlight – adjust classifier settings.'
    };
    const classification = upsertClassification(meta);
    if (!classification) return;
    if (!highlightedIds.has(classification.id) && highlightSentenceNodeWise(sentence.element, sentence.text, classification.category, classification)) {
      highlightedIds.add(classification.id);
    } else {
      updateHighlightMetadata(classification);
    }
  });
  window.__factFlagState.flagged = (window.__factFlagState.classifications || []).filter(Boolean).filter(c => isFlaggedCategory(c.category));
}

function chooseClass(preferredId) {
  const classes = window.__factFlagState.classes || DEFAULT_CLASS_DEFS;
  const direct = classes.find(c => c.id === preferredId);
  if (direct) return direct;
  const nonNeutral = classes.find(c => c.id !== 'neutral');
  return nonNeutral || classes[0] || DEFAULT_CLASS_DEFS[0];
}

function ensureFloatingLegend() {
  let container = document.getElementById('fact-flag-legend');
  if (!container) {
    container = document.createElement('div');
    container.id = 'fact-flag-legend';
    container.className = 'fact-legend-card';
    container.innerHTML = `
      <div class="fact-legend-header">
        <div class="fact-legend-title">Debatable</div>
        <button id="fact-legend-open" class="fact-legend-open" type="button">Panel</button>
      </div>
      <div id="fact-legend-classes" class="fact-legend-classes"></div>
      <div id="fact-legend-progress" class="fact-progress hidden">
        <div class="fact-progress-bar"><div class="fact-progress-fill"></div></div>
        <div class="fact-progress-text"></div>
      </div>
      <div id="fact-debug-section" class="fact-debug hidden">
        <div class="fact-debug-header">
          <span>Debug Prompts</span>
          <button id="fact-debug-clear" class="fact-debug-clear" type="button">Clear</button>
        </div>
        <div id="fact-debug-list" class="fact-debug-list"></div>
      </div>
      <div id="fact-flag-status" class="fact-legend-status"></div>
      <div id="fact-legend-error" class="fact-legend-error"></div>
    `;
    const button = container.querySelector('#fact-legend-open');
    if (button) {
      button.addEventListener('click', ev => {
        ev.stopPropagation();
        openPanel();
      });
    }
    const clearBtn = container.querySelector('#fact-debug-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        clearDebugPrompts();
      });
    }
    document.body.appendChild(container);
  }
  return container;
}

function renderLegend() {
  const container = ensureFloatingLegend();
  const host = container.querySelector('#fact-legend-classes');
  if (!host) return;
  host.innerHTML = '';
  const classes = window.__factFlagState.classes || [];
  classes.forEach(cls => {
    if (!cls) return;
    const chip = document.createElement('span');
    chip.className = 'fact-class-chip';
    chip.dataset.classId = cls.id;
    chip.style.background = rgbaFromHex(cls.color || '#64748b', 0.32);
    chip.style.color = cls.textColor || '#f8fafc';
    chip.style.boxShadow = `inset 0 0 0 1px ${rgbaFromHex(cls.color || '#64748b', 0.6)}`;
    chip.title = cls.definition || cls.label;
    chip.textContent = cls.label;
    host.appendChild(chip);
  });
  renderDebugPrompts();
}

function pushDebugPrompt(info, meta = {}) {
  if (!info || !window.__factFlagState.debugEnabled) return;
  const promptText = typeof info.prompt === 'string' ? info.prompt : '';
  const entry = {
    prompt: promptText,
    statements: typeof info.statements === 'number' ? info.statements : null,
    endpoint: typeof info.endpoint === 'string' ? info.endpoint : null,
    model: typeof info.model === 'string' ? info.model : null,
    timings: info.timings && typeof info.timings === 'object' ? info.timings : null,
    modelTimings: info.modelTimings && typeof info.modelTimings === 'object' ? info.modelTimings : null,
    tokens: info.tokens && typeof info.tokens === 'object' ? info.tokens : null,
    payloadBytes: typeof info.payloadBytes === 'number' ? info.payloadBytes : null,
  response: typeof info.response === 'string' ? info.response : null,
    categories: Array.isArray(info.categories) ? info.categories : null,
    status: typeof info.status === 'number' ? info.status : null,
    errorStatus: typeof info.errorStatus === 'number' ? info.errorStatus : null,
    error: typeof info.error === 'string' ? info.error : null,
    timestamp: Date.now(),
    batchIndex: typeof meta.batchIndex === 'number' ? meta.batchIndex : null,
    totalBatches: typeof meta.totalBatches === 'number' ? meta.totalBatches : null
  };
  const list = Array.isArray(window.__factFlagState.debugPrompts) ? window.__factFlagState.debugPrompts.slice() : [];
  const maxSize = 5;
  list.push(entry);
  const trimmed = list.slice(-maxSize);
  window.__factFlagState.debugPrompts = trimmed;
  if (promptText) {
    const labelParts = [];
    if (typeof entry.batchIndex === 'number') {
      labelParts.push(`batch ${entry.batchIndex + 1}${entry.totalBatches ? `/${entry.totalBatches}` : ''}`);
    }
    if (entry.endpoint) labelParts.push(entry.endpoint);
    if (entry.model) labelParts.push(entry.model);
    const consoleMeta = {
      statements: entry.statements,
      timings: entry.timings,
      tokens: entry.tokens,
      payloadBytes: entry.payloadBytes
    };
    console.log('[AccuracyHighlighter][Debug] Prompt dispatched', labelParts.join(' • ') || '', consoleMeta, '\n', promptText);
  } else if (entry.error) {
    console.warn('[AccuracyHighlighter][Debug] Prompt request error', entry.error, entry);
  }
  renderDebugPrompts();
  broadcastPanelState();
}

function clearDebugPrompts() {
  window.__factFlagState.debugPrompts = [];
  renderDebugPrompts();
  broadcastPanelState();
}

function renderDebugPrompts() {
  const container = ensureFloatingLegend();
  if (!container) return;
  const section = container.querySelector('#fact-debug-section');
  const listEl = container.querySelector('#fact-debug-list');
  if (!section || !listEl) return;
  const enabled = Boolean(window.__factFlagState.debugEnabled);
  const entries = Array.isArray(window.__factFlagState.debugPrompts) ? window.__factFlagState.debugPrompts : [];
  if (!enabled || !entries.length) {
    section.classList.add('hidden');
    listEl.innerHTML = '';
    return;
  }
  section.classList.remove('hidden');
  listEl.innerHTML = '';
  entries.forEach((entry, idx) => {
    const details = document.createElement('details');
    details.className = 'fact-debug-item';
    details.open = idx === entries.length - 1;

    const summary = document.createElement('summary');
    summary.className = 'fact-debug-summary';
    const summaryParts = [];
    if (typeof entry.batchIndex === 'number') {
      const batchLabel = entry.totalBatches ? `${entry.batchIndex + 1}/${entry.totalBatches}` : `${entry.batchIndex + 1}`;
      summaryParts.push(`Batch ${batchLabel}`);
    } else {
      summaryParts.push(`Prompt ${idx + 1}`);
    }
    if (typeof entry.statements === 'number') {
      summaryParts.push(`${entry.statements} statements`);
    }
    if (entry.timings && typeof entry.timings.totalMs === 'number') {
      summaryParts.push(formatDebugDuration(entry.timings.totalMs));
    }
    summary.textContent = summaryParts.join(' • ');
    details.appendChild(summary);

    const metaPrimaryParts = [];
    if (entry.timings && typeof entry.timings.promptMs === 'number') {
      metaPrimaryParts.push(`Request ${formatDebugDuration(entry.timings.promptMs)}`);
    }
    if (entry.timings && typeof entry.timings.generationMs === 'number') {
      metaPrimaryParts.push(`Generation ${formatDebugDuration(entry.timings.generationMs)}`);
    }
    if (entry.timings && typeof entry.timings.parseMs === 'number') {
      metaPrimaryParts.push(`Parse ${formatDebugDuration(entry.timings.parseMs)}`);
    }
    if (entry.tokens && typeof entry.tokens === 'object') {
      const tokenParts = [];
      if (entry.tokens.promptTokens != null) tokenParts.push(`Prompt ${entry.tokens.promptTokens}`);
      if (entry.tokens.completionTokens != null) tokenParts.push(`Completion ${entry.tokens.completionTokens}`);
      if (entry.tokens.totalTokens != null) tokenParts.push(`Total ${entry.tokens.totalTokens}`);
      if (tokenParts.length) metaPrimaryParts.push(`Tokens ${tokenParts.join(' / ')}`);
    }
    if (typeof entry.payloadBytes === 'number') {
      metaPrimaryParts.push(`${entry.payloadBytes} bytes`);
    }
    if (typeof entry.timestamp === 'number') {
      const stamp = formatDebugTimestamp(entry.timestamp);
      if (stamp) metaPrimaryParts.push(stamp);
    }
    if (metaPrimaryParts.length) {
      const meta = document.createElement('div');
      meta.className = 'fact-debug-meta';
      meta.textContent = metaPrimaryParts.join(' • ');
      details.appendChild(meta);
    }

    const secondaryParts = [];
    if (entry.model) secondaryParts.push(entry.model);
    if (entry.endpoint) {
      try {
        const url = new URL(entry.endpoint);
        secondaryParts.push(url.host);
      } catch (e) {
        secondaryParts.push(entry.endpoint);
      }
    }
    if (typeof entry.status === 'number') {
      secondaryParts.push(`HTTP ${entry.status}`);
    } else if (typeof entry.errorStatus === 'number') {
      secondaryParts.push(`HTTP ${entry.errorStatus}`);
    }
    if (entry.categories && entry.categories.length) {
      secondaryParts.push(`Categories: ${entry.categories.join(', ')}`);
    }
    if (entry.modelTimings) {
      const keys = Object.keys(entry.modelTimings).slice(0, 3);
      if (keys.length) {
        const timingText = keys.map(key => `${key}: ${entry.modelTimings[key]}`).join(', ');
        secondaryParts.push(`Model timings: ${timingText}`);
      }
    }
    if (secondaryParts.length) {
      const secondary = document.createElement('div');
      secondary.className = 'fact-debug-meta fact-debug-meta-secondary';
      secondary.textContent = secondaryParts.join(' • ');
      details.appendChild(secondary);
    }

    if (entry.error) {
      const errorDiv = document.createElement('div');
      errorDiv.className = 'fact-debug-error';
      errorDiv.textContent = `Error: ${entry.error}`;
      details.appendChild(errorDiv);
    }

    if (entry.prompt) {
      const pre = document.createElement('pre');
      pre.className = 'fact-debug-pre';
      pre.textContent = entry.prompt;
      details.appendChild(pre);
    }

    if (entry.response) {
      const responseLabel = document.createElement('div');
      responseLabel.className = 'fact-debug-meta fact-debug-meta-secondary';
      responseLabel.textContent = 'Response';
      details.appendChild(responseLabel);
      const responsePre = document.createElement('pre');
      responsePre.className = 'fact-debug-pre';
      responsePre.textContent = entry.response;
      details.appendChild(responsePre);
    }

    listEl.appendChild(details);
  });
  listEl.scrollTop = listEl.scrollHeight;
}

function formatDebugDuration(ms) {
  const num = Number(ms);
  if (!Number.isFinite(num)) return '';
  if (Math.abs(num) >= 1000) {
    return `${(num / 1000).toFixed(2)}s`;
  }
  return `${Math.round(num)}ms`;
}

function formatDebugTimestamp(ts) {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function openPanel(options = {}) {
  // Lazy inject panel iframe
  const focusId = options?.focusId || null;
  let frame = document.getElementById('fact-panel-frame');
  if (frame) {
    if (focusId) {
      window.__factFlagState.pendingPanelFocus = focusId;
      focusPanelOnHighlight(focusId);
    }
    return frame;
  }
  frame = document.createElement('iframe');
  frame.id = 'fact-panel-frame';
  frame.src = chrome.runtime.getURL('src/ui/panel.html');
  frame.addEventListener('load', () => {
    broadcastPanelState();
    const pending = window.__factFlagState.pendingPanelFocus || focusId;
    if (pending) focusPanelOnHighlight(pending);
  }, { once: true });
  document.body.appendChild(frame);
  if (focusId) {
    window.__factFlagState.pendingPanelFocus = focusId;
  }
  return frame;
}

function injectStylesIfNeeded() {
  if (document.getElementById('fact-flag-style')) return;
  const link = document.createElement('link');
  link.id = 'fact-flag-style';
  link.rel = 'stylesheet';
  link.href = chrome.runtime.getURL('src/styles/highlights.css');
  document.head.appendChild(link);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, r => `\\${r}`);
}

function genId(text) {
  // Simple non-cryptographic hash
  let h = 0, str = text || '';
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return 's' + (h >>> 0).toString(16);
}

function setupMessageListener() {
  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    try {
      if (msg.type === 'FACT_PANEL_REQUEST_DATA') {
        respond({ 
          statements: window.__factFlagState.flagged.map(c => ({ id: c.id, text: c.text, category: c.category, confidence: c.confidence, rationale: c.rationale })),
          meta: window.__factFlagState.lastRunMeta || null,
          progress: window.__factFlagState.progress || null,
          classes: window.__factFlagState.classes || DEFAULT_CLASS_DEFS,
          errors: (window.__factFlagState.errors || []).slice(-5),
          total: window.__factFlagState.sentences?.length || 0
        });
      } else if (msg.type === 'FACT_PANEL_HOVER') {
        toggleHover(msg.id, msg.on);
        respond({ ok: true });
      } else if (msg.type === 'FACT_PANEL_FOCUS') {
        focusHighlight(msg.id);
        respond({ ok: true });
      } else if (msg.type === 'FACT_PANEL_SCROLL_TO') {
        if (msg.id) {
          window.__factFlagState.pendingPanelFocus = msg.id;
          focusPanelOnHighlight(msg.id);
        }
        respond({ ok: true });
      } else if (msg.type === 'FACT_PANEL_RERUN') {
        clearExistingHighlights();
        analyzePage().then(() => respond({ ok: true }));
        return true; // async
      } else if (msg.type === 'FACT_PANEL_CLOSE') {
        const frame = document.getElementById('fact-panel-frame');
        if (frame) frame.remove();
        window.__factFlagState.pendingPanelFocus = null;
        respond({ ok: true });
      } else {
        // ignore
      }
    } catch (e) {
      console.error('Panel message error', e);
      respond({ ok: false, error: e.message });
    }
    return false;
  });
}

function ensureHighlightInteractions() {
  if (highlightInteractionBound) return;
  highlightInteractionBound = true;
  document.addEventListener('pointerover', handleHighlightPointerOver, true);
  document.addEventListener('pointerout', handleHighlightPointerOut, true);
  document.addEventListener('click', handleHighlightClick, true);
  document.addEventListener('scroll', hideHighlightTooltip, true);
}

function handleHighlightPointerOver(event) {
  const target = event?.target;
  if (!target || typeof target.closest !== 'function') return;
  const span = target.closest('.fact-flag');
  if (!span) return;
  const rationale = (span.dataset?.factRationale || '').trim() || extractRationaleFromMeta(span);
  const text = rationale || 'No rationale provided.';
  showHighlightTooltip(span, text);
}

function handleHighlightPointerOut(event) {
  const target = event?.target;
  if (!target || typeof target.closest !== 'function') return;
  const span = target.closest('.fact-flag');
  if (!span) return;
  const related = event.relatedTarget && typeof event.relatedTarget.closest === 'function'
    ? event.relatedTarget.closest('.fact-flag')
    : null;
  if (related === span) return;
  hideHighlightTooltip();
}

function handleHighlightClick(event) {
  if (!event || event.defaultPrevented || event.button !== 0) return;
  const target = event.target;
  if (!target || typeof target.closest !== 'function') return;
  const span = target.closest('.fact-flag');
  if (!span) return;
  const selection = window.getSelection && window.getSelection();
  if (selection && selection.toString()) return;
  const id = span.dataset?.factId;
  if (!id) return;
  hideHighlightTooltip();
  openPanel({ focusId: id });
}

function extractRationaleFromMeta(node) {
  if (!node || !node.dataset || !node.dataset.factMeta) return '';
  try {
    const decoded = decodeURIComponent(node.dataset.factMeta);
    const parsed = JSON.parse(decoded);
    return typeof parsed?.rationale === 'string' ? parsed.rationale : '';
  } catch (err) {
    return '';
  }
}

function ensureHighlightTooltip() {
  if (highlightTooltipEl) return highlightTooltipEl;
  const div = document.createElement('div');
  div.id = 'fact-flag-tooltip';
  Object.assign(div.style, {
    position: 'absolute',
    zIndex: 2147483647,
    maxWidth: '320px',
    padding: '10px 12px',
    borderRadius: '12px',
    fontSize: '12px',
    lineHeight: '1.4',
    background: 'rgba(15,23,42,0.94)',
    color: '#e2e8f0',
    boxShadow: '0 14px 32px rgba(15,23,42,0.45)',
    border: '1px solid rgba(148,163,184,0.28)',
    pointerEvents: 'none',
    opacity: '0',
    visibility: 'hidden',
    transition: 'opacity 0.15s ease'
  });
  document.body.appendChild(div);
  highlightTooltipEl = div;
  return highlightTooltipEl;
}

function showHighlightTooltip(anchor, text) {
  const tooltip = ensureHighlightTooltip();
  tooltip.textContent = text;
  tooltip.style.visibility = 'hidden';
  tooltip.style.opacity = '0';
  requestAnimationFrame(() => {
    const rect = anchor.getBoundingClientRect();
    const tipRect = tooltip.getBoundingClientRect();
    let top = window.scrollY + rect.top - tipRect.height - 8;
    if (top < window.scrollY + 12) {
      top = window.scrollY + rect.bottom + 8;
    }
    let left = window.scrollX + rect.left + (rect.width - tipRect.width) / 2;
    const minLeft = window.scrollX + 8;
    const maxLeft = window.scrollX + window.innerWidth - tipRect.width - 8;
    left = Math.max(minLeft, Math.min(left, maxLeft));
    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${left}px`;
    tooltip.style.visibility = 'visible';
    tooltip.style.opacity = '1';
  });
}

function hideHighlightTooltip() {
  if (!highlightTooltipEl) return;
  highlightTooltipEl.style.opacity = '0';
  highlightTooltipEl.style.visibility = 'hidden';
}

function toggleHover(id, on) {
  if (!id) return;
  const el = document.querySelector(`.fact-flag[data-fact-id='${CSS.escape(id)}']`);
  if (el) {
    if (on) el.classList.add('fact-flag-hover'); else el.classList.remove('fact-flag-hover');
  }
}

function focusHighlight(id) {
  if (!id) return;
  let target = document.querySelector(`.fact-flag[data-fact-id='${CSS.escape(id)}']`);
  if (!target) {
    const sentence = (window.__factFlagState.sentences || []).find(s => s.id === id);
    if (sentence && sentence.element) {
      target = sentence.element;
    }
  }
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
  if (target.classList.contains('fact-flag')) {
    target.classList.add('fact-flag-pulse');
    setTimeout(() => target.classList.remove('fact-flag-pulse'), 1300);
  } else {
    target.classList.add('fact-flag-host-pulse');
    setTimeout(() => target.classList.remove('fact-flag-host-pulse'), 1300);
  }
}

function clearExistingHighlights() {
  document.querySelectorAll('.fact-flag').forEach(span => {
    const parent = span.parentNode;
    if (!parent) return;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
  });
  highlightedIds.clear();
  hideHighlightTooltip();
  window.__factFlagState.flagged = [];
  setLegendError('');
  updateProgressUI({ reset: true });
  broadcastPanelState();
}

function sendMessage(msg) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(msg, response => {
        if (chrome.runtime.lastError) {
          return reject(chrome.runtime.lastError);
        }
        if (!response || !response.ok) return reject(response?.error || 'Unknown error');
        resolve(response);
      });
    } catch (e) { reject(e); }
  });
}

async function getSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get(['enablePromptApi','modelId','privacyMode','promptTemplate','classificationClasses','maxSentences','batchSize','debugLogging'], (data) => {
      // Apply defaults for undefined values
      resolve({
        enablePromptApi: data.enablePromptApi ?? true,
        modelId: data.modelId || 'gemini-nano',
        privacyMode: data.privacyMode ?? false,
        promptTemplate: data.promptTemplate || null,
        classificationClasses: data.classificationClasses || null,
        maxSentences: data.maxSentences ?? 60,
        batchSize: data.batchSize ?? 20,
        debugLogging: data.debugLogging ?? true
      });
    });
  });
}

function hasOnDeviceAPI() {
  return typeof LanguageModel !== 'undefined' && typeof LanguageModel.create === 'function';
}

let __onDeviceSession = null;
async function classifyOnDeviceGeminiNano(sentences, cfg, showProgress = false) {
  try {
    if (!__onDeviceSession) {
      const params = await LanguageModel.params().catch(()=>({}));
      __onDeviceSession = await LanguageModel.create({
        topK: params.defaultTopK,
        temperature: params.defaultTemperature,
        monitor: showProgress ? (m) => {
          m.addEventListener('downloadprogress', e => {
            updateDownloadProgress(Math.round((e.loaded || 0) * 100));
          });
        } : undefined
      });
    }
    const session = __onDeviceSession;
    const batchSize = Number(cfg.batchSize) > 0 ? Number(cfg.batchSize) : 20;
    const allResults = [];
    const classes = window.__factFlagState.classes || DEFAULT_CLASS_DEFS;
    const totalBatches = Math.max(1, Math.ceil(sentences.length / batchSize));
    const debugEnabled = Boolean(window.__factFlagState?.debugEnabled);
    for (let i = 0; i < sentences.length; i += batchSize) {
      const started = performance.now();
      const slice = sentences.slice(i, i + batchSize);
      const batchIndex = Math.floor(i / batchSize);
      const prompt = buildOnDevicePrompt(slice, classes, cfg);
      const schema = onDeviceResponseSchema();
      const promptBytes = typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(prompt).length : prompt.length;
      const promptShort = prompt.length > 12000 ? `${prompt.slice(0, 12000)}…` : prompt;
      if (debugEnabled) {
        console.log('[AccuracyHighlighter][OnDevice] Prompt start', {
          batch: `${batchIndex + 1}/${totalBatches}`,
          statements: slice.length,
          promptChars: prompt.length,
          payloadBytes: promptBytes
        });
      }
      const requestStart = performance.now();
      const raw = await session.prompt(prompt, { responseConstraint: schema });
      const requestEnd = performance.now();
      const parseStart = performance.now();
      const parsed = safeParseOnDeviceJSON(raw);
      const parseEnd = performance.now();
  const responseLog = formatDebugResponse(raw);
      const batchResults = [];
      for (const item of parsed.items || []) {
        const globalIndex = i + item.index;
        const sentenceObj = sentences[globalIndex];
        if (!sentenceObj) continue;
        const normalizedCategory = normalizeCategory(item.category);
        const result = {
          index: item.index,
            globalIndex,
            id: sentenceObj.id,
            text: sentenceObj.text,
            category: normalizedCategory,
            confidence: clamp01(item.confidence ?? 0.55),
            rationale: (item.rationale || '').slice(0, 200)
        };
        allResults.push(result);
        batchResults.push(result);
      }
      if (batchResults.length) {
        processBatchClassifications(batchResults, { finalize: false });
        const durationMs = performance.now() - started;
        updateProgressUI({ completedDelta: batchResults.length, durationMs, message: 'On-device model' });
      }
      const tokenUsage = extractOnDeviceTokenUsage(parsed) || estimateOnDeviceTokens(prompt, batchResults, raw);
      if (debugEnabled) {
        const executionMs = requestEnd - requestStart;
        const parseMs = parseEnd - parseStart;
        const totalMs = executionMs + parseMs;
        const timingSummary = {
          promptMs: Number(executionMs.toFixed(1)),
          generationMs: Number(executionMs.toFixed(1)),
          parseMs: Number(parseMs.toFixed(1)),
          totalMs: Number(totalMs.toFixed(1))
        };
        console.log('[AccuracyHighlighter][OnDevice] Prompt timings', {
          batch: `${batchIndex + 1}/${totalBatches}`,
          statements: slice.length,
          ...timingSummary,
          tokens: tokenUsage || undefined
        });
        if (responseLog) {
          console.log('[AccuracyHighlighter][OnDevice] Prompt output', {
            batch: `${batchIndex + 1}/${totalBatches}`,
            statements: slice.length,
            tokens: tokenUsage || undefined
          }, '\n', responseLog);
          if (Array.isArray(parsed.items)) {
            console.log('[AccuracyHighlighter][OnDevice] Parsed items', parsed.items);
          }
        }
        pushDebugPrompt({
          prompt: promptShort,
          statements: slice.length,
          endpoint: 'on-device:gemini-nano',
          model: cfg.modelId || 'gemini-nano',
          timings: timingSummary,
          payloadBytes: promptBytes,
          tokens: tokenUsage || undefined,
          response: responseLog
        }, { batchIndex, totalBatches });
      }
    }
    return allResults;
  } catch (err) {
    console.warn('[AccuracyHighlighter] On-device classification failed – falling back.', err);
    throw err;
  }
}

function buildOnDevicePrompt(slice, classes, cfg) {
  const categories = (classes || []).map(c => (c.id || '').trim()).filter(Boolean);
  if (!categories.includes('neutral')) categories.push('neutral');
  const classIds = Array.from(new Set(categories));
  const definitions = buildClassDefinitionsString(classes) || defaultDefinitionsFallback();
  const statements = slice.map((s, idx) => ({ index: idx, text: sanitizeOnDeviceText(s.text, cfg.privacyMode) }));
  const template = (cfg && typeof cfg.promptTemplate === 'string' && cfg.promptTemplate.trim()) || defaultPromptTemplateForOnDevice();
  return template
    .replace(/{{DEFINITIONS}}/g, definitions)
    .replace(/{{STATEMENTS_JSON}}/g, JSON.stringify(statements))
    .replace(/{{CLASS_IDS}}/g, classIds.join('|'));
}

function sanitizeOnDeviceText(text, privacyMode) {
  let t = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+/gi, '[EMAIL]').replace(/\b\d{6,}\b/g, '[NUMBER]');
  if (privacyMode) t = t.slice(0, 320);
  return t;
}

function safeParseOnDeviceJSON(raw) {
  if (!raw) return { items: [] };
  // try direct parse
  raw = raw.trim();
  let jsonText = raw;
  // If model added explanations, extract first JSON block
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) jsonText = match[0];
  try {
    const parsed = JSON.parse(jsonText);
    if (!parsed.items) return { items: [] };
    return parsed;
  } catch (e) {
    console.warn('Failed to parse on-device JSON', e, raw.slice(0, 200));
    return { items: [] };
  }
}

function formatDebugResponse(raw) {
  if (raw == null) return '';
  if (typeof raw === 'string') {
    return raw;
  }
  try {
    return JSON.stringify(raw, null, 2);
  } catch (e) {
    return String(raw);
  }
}

function extractOnDeviceTokenUsage(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.tokens && typeof parsed.tokens === 'object') {
    return normalizeTokenUsageShape(parsed.tokens);
  }
  if (parsed.metrics && typeof parsed.metrics === 'object') {
    if (parsed.metrics.tokens && typeof parsed.metrics.tokens === 'object') {
      return normalizeTokenUsageShape(parsed.metrics.tokens);
    }
  }
  if (parsed.usage && typeof parsed.usage === 'object') {
    return normalizeTokenUsageShape(parsed.usage);
  }
  return null;
}

function normalizeTokenUsageShape(src) {
  if (!src || typeof src !== 'object') return null;
  const toNumber = (value) => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value.trim());
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  };
  const promptTokens = toNumber(src.promptTokens ?? src.prompt_tokens ?? src.inputTokens ?? src.input_tokens);
  const completionTokens = toNumber(src.completionTokens ?? src.completion_tokens ?? src.outputTokens ?? src.output_tokens ?? src.generationTokens ?? src.generation_tokens);
  let totalTokens = toNumber(src.totalTokens ?? src.total_tokens);
  if (totalTokens == null && promptTokens != null && completionTokens != null) {
    totalTokens = promptTokens + completionTokens;
  }
  if (promptTokens == null && completionTokens == null && totalTokens == null) return null;
  return {
    promptTokens: promptTokens != null ? promptTokens : null,
    completionTokens: completionTokens != null ? completionTokens : null,
    totalTokens: totalTokens != null ? totalTokens : (promptTokens != null && completionTokens != null ? promptTokens + completionTokens : null)
  };
}

function estimateOnDeviceTokens(prompt, batchResults, raw) {
  if (!prompt || !Array.isArray(batchResults)) return null;
  const approxCharsPerToken = 4;
  const promptTokens = Math.ceil(prompt.length / approxCharsPerToken);
  const completions = batchResults.map(item => item.rationale || '').join(' ');
  const rawText = typeof raw === 'string' ? raw : '';
  const responseMaterial = rawText.length > completions.length ? rawText : completions;
  const joined = responseMaterial || completions;
  const completionTokens = joined ? Math.ceil(joined.length / approxCharsPerToken) : null;
  return {
    promptTokens,
    completionTokens,
    totalTokens: completionTokens != null ? promptTokens + completionTokens : null
  };
}

function defaultPromptTemplateForOnDevice() {
  return `You are a factuality, debate and rhetoric classifier. Output ONLY JSON. \nDefinitions: \n{{DEFINITIONS}} \nStatements (JSON array): \n{{STATEMENTS_JSON}} \nCategories: {{CLASS_IDS}} \nRules: \n- Return {"items":[...]} with objects that always include "category" ONLY WHEN CATEGORY IS NEUTRAL. \n- Do NOT RETURN if category is neutral. \n- Only include "confidence" (0-1) when category is not "neutral". \n- Do NOT add rationale for ANY category. \n- If insufficient info -> neutral.`
}

function defaultDefinitionsFallback() {
  return `false: contradicts well-established facts.\ndebated: Opinions disputed or with multiple viewpoints.\nhyperbole: rhetorical exaggeration or absolutist promotional phrasing.\nneutral: none of the above.`;
}

function normalizeCategory(cat) {
  if (!cat) return 'neutral';
  const normalized = String(cat).trim().toLowerCase();
  const classes = window.__factFlagState?.classes || DEFAULT_CLASS_DEFS;
  const allowed = new Set((classes || []).map(c => c.id));
  if (!allowed.has('neutral')) allowed.add('neutral');
  return allowed.has(normalized) ? normalized : 'neutral';
}

function clamp01(v) { return Math.min(1, Math.max(0, v)); }

function onDeviceResponseSchema() {
  return {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer' },
            category: { type: 'string' },
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

function updateDownloadProgress(pct) {
  const container = document.getElementById('fact-flag-status');
  if (!container) return;
  container.innerHTML = `<span class="status-pill api-on-device-downloading">Downloading ${pct}%</span>`;
}

function waitForUserGesture() {
  return new Promise(resolve => {
    const handler = () => {
      window.removeEventListener('pointerdown', handler, true);
      window.removeEventListener('keydown', handler, true);
      resolve();
    };
    window.addEventListener('pointerdown', handler, true);
    window.addEventListener('keydown', handler, true);
  });
}

async function runRemoteOrHeuristic(cfg) {
  window.__factFlagState.progress.status = 'running';
  updateProgressUI({ setCompleted: 0, message: 'Starting…', status: 'running' });
  try {
    const result = await batchClassify(window.__factFlagState.sentences, {
      batchSize: Number(cfg.batchSize) > 0 ? Number(cfg.batchSize) : BATCH_SIZE,
      onBatch: ({ items, rawResult, durationMs, batchIndex, totalBatches }) => {
        processBatchClassifications(items, { finalize: false });
        const message = rawResult?.mode === 'remote' ? 'Calling Prompt API…' : '';
        updateProgressUI({ completedDelta: items.length, durationMs, message });
        if (rawResult?.error) {
          setLegendError(rawResult.error);
          window.__factFlagState.errors.push(rawResult.error);
        }
        if (rawResult?.mode) {
          window.__factFlagState.lastRunMeta = { mode: rawResult.mode, error: rawResult.error || null };
        }
        if (cfg.debugLogging && rawResult?.debug) {
          pushDebugPrompt(rawResult.debug, { batchIndex, totalBatches });
        }
      },
      onError: (err) => {
        const message = err?.message || String(err);
        setLegendError(message);
        window.__factFlagState.errors.push(message);
        updateProgressUI({ message: 'Error', error: message });
      }
    });
    if (result?.meta) {
      window.__factFlagState.lastRunMeta = result.meta;
      if (result.meta.error) {
        setLegendError(result.meta.error);
        window.__factFlagState.errors.push(result.meta.error);
      }
    }
    ensureFallbackHighlights();
    finalizeProgress(true, 'Complete');
    updateLegendStatus();
    if (result?.meta?.mode === 'heuristic-fallback') {
      showToast('Using fallback classifier (API error)');
    } else if (result?.meta?.mode === 'remote') {
      showToast('Prompt API classification complete');
    }
  } catch (err) {
    const message = err?.message || 'Classification failed';
    window.__factFlagState.lastRunMeta = { mode: 'error', error: message };
    window.__factFlagState.errors.push(message);
    setLegendError(message);
    finalizeProgress(false, 'Failed');
    updateLegendStatus();
    throw err;
  }
}

function updateLegendStatus() {
  ensureFloatingLegend();
  const meta = window.__factFlagState.lastRunMeta;
  const container = document.getElementById('fact-flag-status');
  if (!container) return;
  let label = 'Heuristic';
  let cls = 'api-heuristic';
  if (meta) {
    if (meta.mode === 'remote') { label = 'Prompt API'; cls = 'api-ok'; }
    else if (meta.mode === 'heuristic-fallback') { label = 'Fallback'; cls = 'api-fallback'; }
    else if (meta.mode === 'on-device') { label = 'On-Device'; cls = 'api-on-device'; }
    else if (meta.mode === 'on-device-unavailable') { label = 'On-Device Missing'; cls = 'api-on-device-missing'; }
  }
  if (meta && meta.error) {
    container.title = meta.error;
  }
  container.innerHTML = `<span class="status-pill ${cls}">${label}</span>`;
  if (meta && meta.error) {
    setLegendError(meta.error);
  }
  broadcastPanelState();
}

function setLegendError(message) {
  const el = document.getElementById('fact-legend-error');
  if (!el) return;
  if (message) {
    el.textContent = message;
    el.classList.remove('hidden');
  } else {
    el.textContent = '';
    el.classList.add('hidden');
  }
  broadcastPanelState();
}

function updateProgressUI(options = {}) {
  const container = ensureFloatingLegend()?.querySelector('#fact-legend-progress');
  if (!container) return;
  const bar = container.querySelector('.fact-progress-fill');
  const text = container.querySelector('.fact-progress-text');
  const state = window.__factFlagState.progress || { total: 0, completed: 0 };

  if (options.reset) {
    bar && (bar.style.width = '0%');
    text && (text.textContent = '');
    container.classList.add('hidden');
    state.completed = 0;
    state.etaMs = 0;
    state.history = [];
    state.status = 'idle';
    state.startedAt = performance.now();
    return;
  }

  if (!state.total) {
    container.classList.add('hidden');
    return;
  }

  if (!state.startedAt || options.setCompleted === 0) state.startedAt = performance.now();
  if (!Array.isArray(state.history)) state.history = [];

  if (typeof options.setCompleted === 'number') {
    state.completed = Math.max(0, Math.min(state.total, options.setCompleted));
    if (options.setCompleted === 0) state.history = [];
  } else if (typeof options.completedDelta === 'number') {
    state.completed = Math.max(0, Math.min(state.total, state.completed + options.completedDelta));
  }

  if (typeof options.durationMs === 'number' && (options.completedDelta || options.setCompleted)) {
    const count = options.completedDelta || (typeof options.setCompleted === 'number' ? options.setCompleted : 0);
    if (count > 0) {
      state.history.push({ durationMs: options.durationMs, count });
    }
  }

  if (options.status) state.status = options.status;

  const totals = state.history.reduce((acc, cur) => {
    acc.duration += cur.durationMs;
    acc.count += cur.count;
    return acc;
  }, { duration: 0, count: 0 });

  const averagePerSentence = totals.count ? totals.duration / totals.count : 0;
  const remaining = Math.max(0, state.total - state.completed);
  state.etaMs = remaining * averagePerSentence;
  state.status = options.status || state.status || 'running';

  container.classList.remove('hidden');
  if (bar) {
    const pct = state.total ? Math.min(100, Math.max(0, (state.completed / state.total) * 100)) : 0;
    bar.style.width = `${pct}%`;
  }

  if (text) {
    const etaText = state.etaMs > 1000 ? `ETA ${formatEta(state.etaMs)}` : (remaining ? 'Estimating…' : '');
    const base = `${state.completed}/${state.total} processed`;
    const extra = [etaText, options.message].filter(Boolean).join(' • ');
    text.textContent = extra ? `${base} • ${extra}` : base;
  }

  if (options.error) {
    setLegendError(options.error);
    state.status = 'error';
  }
  broadcastPanelState();
}

function finalizeProgress(success = true, message = '') {
  const state = window.__factFlagState.progress || {};
  state.status = success ? 'done' : 'error';
  state.completed = state.total;
  const container = ensureFloatingLegend()?.querySelector('#fact-legend-progress');
  if (container) {
    container.classList.remove('hidden');
  }
  updateProgressUI({ setCompleted: state.total, message });
  if (success) {
    setTimeout(() => {
      const el = document.getElementById('fact-legend-progress');
      if (el && window.__factFlagState.progress.status === 'done') {
        el.classList.add('hidden');
      }
    }, 1800);
  }
  broadcastPanelState();
}

function formatEta(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${mins}m${rem ? ` ${rem}s` : ''}`;
}

function showToast(message) {
  // Avoid spamming multiple toasts quickly
  if (document.body.querySelector('.fact-flag-toast')) return;
  const div = document.createElement('div');
  div.className = 'fact-flag-toast';
  div.textContent = message;
  Object.assign(div.style, {
    position: 'fixed',
    bottom: '20px',
    left: '20px',
    background: 'rgba(15,23,42,0.92)',
    color: '#f8fafc',
    padding: '10px 16px',
    borderRadius: '12px',
    fontSize: '13px',
    zIndex: 2147483647,
    border: '1px solid rgba(148,163,184,0.2)',
    boxShadow: '0 18px 40px rgba(15,23,42,0.35)',
    opacity: '0',
    transform: 'translateY(12px)',
    transition: 'opacity .25s ease, transform .25s ease'
  });
  document.body.appendChild(div);
  requestAnimationFrame(()=> {
    div.style.opacity = '1';
    div.style.transform = 'translateY(0)';
  });
  setTimeout(()=> {
    div.style.opacity = '0';
    div.style.transform = 'translateY(12px)';
    setTimeout(()=> div.remove(), 300);
  }, 2800);
}

function buildPanelPayload() {
  return {
    statements: (window.__factFlagState.flagged || []).map(c => ({
      id: c.id,
      text: c.text,
      category: c.category,
      confidence: c.confidence,
      rationale: c.rationale
    })),
    meta: window.__factFlagState.lastRunMeta || null,
    progress: window.__factFlagState.progress || null,
    classes: window.__factFlagState.classes || DEFAULT_CLASS_DEFS,
    errors: (window.__factFlagState.errors || []).slice(-5),
    total: window.__factFlagState.sentences?.length || 0
  };
}

function focusPanelOnHighlight(id) {
  if (!id) return;
  window.__factFlagState.pendingPanelFocus = id;
  let delivered = false;
  const frame = document.getElementById('fact-panel-frame');
  if (frame && frame.contentWindow) {
    try {
      frame.contentWindow.postMessage({ type: 'FACT_PANEL_SCROLL_TO', id }, PANEL_ORIGIN);
      delivered = true;
    } catch (err) {
      // ignore cross-origin errors
    }
  }
  try {
    chrome.runtime.sendMessage({ type: 'FACT_PANEL_SCROLL_TO', id });
    delivered = true;
  } catch (err) {
    // ignore runtime errors (panel may not be ready yet)
  }
  if (delivered) {
    setTimeout(() => {
      if (window.__factFlagState.pendingPanelFocus === id) {
        window.__factFlagState.pendingPanelFocus = null;
      }
    }, 1600);
  }
}

function broadcastPanelState() {
  const frame = document.getElementById('fact-panel-frame');
  if (!frame || !frame.contentWindow) return;
  try {
    frame.contentWindow.postMessage({ type: 'FACT_PANEL_STATE', payload: buildPanelPayload() }, PANEL_ORIGIN);
  } catch (e) {
    // ignore cross-origin issues
  }
}
