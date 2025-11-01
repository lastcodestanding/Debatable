// options.js - manage on-device model settings, runtime behavior, category definitions, and prompt template.

const DEFAULT_PROMPT_TEMPLATE = `You are a factuality, debate and rhetoric classifier. Output ONLY JSON. 
Definitions:
{{DEFINITIONS}}
Statements (JSON array):
{{STATEMENTS_JSON}}
Categories: {{CLASS_IDS}}
Rules:
- Return {"items":[...]} with objects that always include "category" ONLY WHEN CATEGORY IS NEUTRAL.
- Do NOT RETURN if category is neutral.
- Only include "confidence" (0-1) when category is not "neutral".
- Do NOT add rationale for ANY category.
- If insufficient info -> neutral.`;

const DEFAULT_CLASSES = [
  // { id: 'false', label: 'False', definition: 'Contradicts well-established facts.', color: '#ef4444', textColor: '#ffffff' },
  { id: 'debated', label: 'Debated', definition: 'Opinions disputed or with multiple viewpoints.', color: '#facc15', textColor: '#ffffff' },
  { id: 'hyperbole', label: 'Hyperbole', definition: 'Rhetorical or promotional exaggeration.', color: '#fb923c', textColor: '#ffffff' },
  { id: 'neutral', label: 'Neutral', definition: 'No issues detected.', color: '#9ca3af', textColor: '#ffffff' }
];

const els = {
  modelId: document.getElementById('modelId'),
  saveApi: document.getElementById('saveApi'),
  enablePromptApi: document.getElementById('enablePromptApi'),
  privacyMode: document.getElementById('privacyMode'),
  debugLogging: document.getElementById('debugLogging'),
  maxSentences: document.getElementById('maxSentences'),
  batchSize: document.getElementById('batchSize'),
  saveBehavior: document.getElementById('saveBehavior'),
  promptTemplate: document.getElementById('promptTemplate'),
  savePrompt: document.getElementById('savePrompt'),
  resetPrompt: document.getElementById('resetPrompt'),
  purgeCache: document.getElementById('purgeCache'),
  classList: document.getElementById('classList'),
  addClassBtn: document.getElementById('addClassBtn'),
  saveClasses: document.getElementById('saveClasses'),
  toastHost: document.getElementById('toastHost')
};

let editableClasses = [];
let toastTimer = null;

init();

function init() {
  loadAll();
  wire();
}

function wire() {
  els.saveApi.addEventListener('click', saveApiSettings);
  els.saveBehavior.addEventListener('click', saveBehaviorSettings);
  els.savePrompt.addEventListener('click', savePromptTemplate);
  els.resetPrompt.addEventListener('click', resetPromptTemplate);
  els.purgeCache.addEventListener('click', purgeCache);
  els.addClassBtn.addEventListener('click', addClassCard);
  els.saveClasses.addEventListener('click', persistClasses);
}

async function loadAll() {
  const data = await chrome.storage.local.get([
    'modelId','enablePromptApi','privacyMode','maxSentences','batchSize','promptTemplate','classificationClasses','debugLogging'
  ]);

  els.modelId.value = data.modelId || 'gemini-nano';
  els.enablePromptApi.checked = data.enablePromptApi ?? true;
  els.privacyMode.checked = data.privacyMode ?? false;
  els.debugLogging.checked = data.debugLogging ?? true;
  els.maxSentences.value = data.maxSentences ?? 60;
  els.batchSize.value = data.batchSize ?? 20;
  els.promptTemplate.value = data.promptTemplate || DEFAULT_PROMPT_TEMPLATE;

  editableClasses = normalizeClassesForUI(data.classificationClasses);
  renderClassList();
}

function normalizeClassesForUI(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return DEFAULT_CLASSES.map(c => ({ ...c }));
  }
  const seen = new Set();
  const palette = DEFAULT_CLASSES.map(c => c.color);
  const normalized = raw.reduce((acc, item, idx) => {
    if (!item || typeof item !== 'object') return acc;
    let id = String(item.id || '').trim().toLowerCase();
    if (!id) {
      id = `class-${idx + 1}`;
    }
    if (seen.has(id)) return acc;
    seen.add(id);
    const fallback = DEFAULT_CLASSES.find(c => c.id === id) || {};
    const label = String(item.label || fallback.label || id).trim() || id;
    const definition = String(item.definition || fallback.definition || '').trim();
    const color = validateHex(item.color) ? item.color : (fallback.color || palette[idx % palette.length] || '#64748b');
    const textColor = validateHex(item.textColor) ? item.textColor : (fallback.textColor || idealTextColor(color));
    acc.push({ id, label, definition, color, textColor });
    return acc;
  }, []);
  if (!normalized.some(c => c.id === 'neutral')) {
    const fallbackNeutral = DEFAULT_CLASSES.find(c => c.id === 'neutral');
    if (fallbackNeutral) normalized.push({ ...fallbackNeutral });
  }
  return normalized;
}

function renderClassList() {
  els.classList.innerHTML = '';
  editableClasses.forEach((cls, index) => {
    const previewColor = validateHex(cls.color) ? cls.color : '#64748b';
    const definitionValue = (cls.definition || '').replace(/[\r\n]+/g, ' ').trim();
    const row = document.createElement('div');
    row.className = 'class-row-slim';
    row.dataset.index = String(index);
    row.innerHTML = `
      <span class="class-color-dot" style="background:${escapeAttr(previewColor)};"></span>
      <input type="text" value="${escapeAttr(cls.label)}" data-field="label" placeholder="Category name" aria-label="Category name" />
      <input type="text" value="${escapeAttr(definitionValue)}" data-field="definition" placeholder="Definition" aria-label="Category definition" class="definition-input" />
      <input type="color" value="${escapeAttr(previewColor)}" data-field="color" aria-label="Accent color" />
      <button type="button" class="class-remove" aria-label="Remove category">×</button>
    `;
  row.title = definitionValue ? `${cls.label || cls.id}: ${definitionValue}` : (cls.label || cls.id);
    attachClassRowHandlers(row, index);
    els.classList.appendChild(row);
  });
}

function attachClassRowHandlers(row, index) {
  row.querySelectorAll('input').forEach(input => {
    input.addEventListener('input', (event) => {
      const field = event.currentTarget.dataset.field;
      if (!field) return;
      const value = event.currentTarget.value;
      applyClassUpdate(index, field, value);
      if (field === 'label' || field === 'color' || field === 'definition') {
        refreshClassRow(row, editableClasses[index]);
      }
    });
  });
  const deleteBtn = row.querySelector('.class-remove');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => removeClass(index));
  }
}

function applyClassUpdate(index, field, rawValue) {
  const cls = editableClasses[index];
  if (!cls) return;
  if (field === 'color') {
    const color = validateHex(rawValue) ? rawValue : cls.color;
    const textColor = idealTextColor(color);
    editableClasses[index] = { ...cls, color, textColor };
  } else if (field === 'label') {
    editableClasses[index] = { ...cls, label: rawValue };
  } else if (field === 'definition') {
    editableClasses[index] = { ...cls, definition: rawValue };
  }
}

function refreshClassRow(row, cls) {
  if (!row || !cls) return;
  const bg = validateHex(cls.color) ? cls.color : '#64748b';
  const dot = row.querySelector('.class-color-dot');
  if (dot) dot.style.background = bg;
  const definitionValue = (cls.definition || '').replace(/[\r\n]+/g, ' ').trim();
  row.title = definitionValue ? `${cls.label || cls.id}: ${definitionValue}` : (cls.label || cls.id);
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'category';
}

function addClassCard() {
  const nextIndex = editableClasses.length;
  const defaultColor = nextAccentColor(nextIndex);
  editableClasses.push({
    id: `category-${nextIndex + 1}`,
    label: 'New Category',
    definition: '',
    color: defaultColor,
    textColor: idealTextColor(defaultColor)
  });
  renderClassList();
}

function removeClass(index) {
  editableClasses.splice(index, 1);
  if (editableClasses.length === 0) {
    editableClasses = DEFAULT_CLASSES.map(c => ({ ...c }));
    toast('At least one category is required. Restored defaults.');
  }
  renderClassList();
}

async function persistClasses() {
  const cleaned = [];
  const seen = new Set();
  for (const cls of editableClasses) {
    const label = (cls.label || '').trim();
    if (!label) {
      toast('Each category needs a name.');
      return;
    }
    const id = slugify(label || cls.id);
    if (seen.has(id)) {
      toast(`Duplicate category name: ${label}`);
      return;
    }
    seen.add(id);
    const color = validateHex(cls.color) ? cls.color : '#64748b';
    const textColor = idealTextColor(color);
    cleaned.push({
      id,
      label,
      definition: (cls.definition || '').trim(),
      color,
      textColor
    });
  }
  if (!cleaned.length) {
    toast('Add at least one category before saving.');
    return;
  }
  if (!cleaned.some(c => c.id === 'neutral')) {
    const fallbackNeutral = DEFAULT_CLASSES.find(c => c.id === 'neutral');
    if (fallbackNeutral) {
      const color = fallbackNeutral.color;
      cleaned.push({
        id: 'neutral',
        label: fallbackNeutral.label,
        definition: fallbackNeutral.definition,
        color,
        textColor: fallbackNeutral.textColor || idealTextColor(color)
      });
    }
  }
  await chrome.storage.local.set({ classificationClasses: cleaned });
  editableClasses = cleaned.map(c => ({ ...c }));
  renderClassList();
  toast('Categories saved');
}

async function saveApiSettings() {
  const payload = {
    modelId: els.modelId.value.trim() || 'gemini-nano'
  };
  await chrome.storage.local.set(payload);
  toast('Model settings saved');
}

async function saveBehaviorSettings() {
  const maxSent = clampInt(els.maxSentences.value, 1, 500, 60);
  const batch = clampInt(els.batchSize.value, 1, 200, 20);
  const data = {
    enablePromptApi: els.enablePromptApi.checked,
    privacyMode: els.privacyMode.checked,
    debugLogging: els.debugLogging.checked,
    maxSentences: maxSent,
    batchSize: batch
  };
  await chrome.storage.local.set(data);
  toast('Behavior saved');
}

async function savePromptTemplate() {
  const val = els.promptTemplate.value.trim() || DEFAULT_PROMPT_TEMPLATE;
  await chrome.storage.local.set({ promptTemplate: val });
  toast('Template saved');
}

async function resetPromptTemplate() {
  els.promptTemplate.value = DEFAULT_PROMPT_TEMPLATE;
  await chrome.storage.local.set({ promptTemplate: DEFAULT_PROMPT_TEMPLATE });
  toast('Template reset');
}

async function purgeCache() {
  await chrome.runtime.sendMessage({ type: 'PURGE_CACHE' });
  toast('Cache purged');
}

function toast(message) {
  if (!els.toastHost) return;
  els.toastHost.textContent = '';
  const toastEl = document.createElement('div');
  toastEl.className = 'toast';
  toastEl.textContent = message;
  els.toastHost.appendChild(toastEl);
  requestAnimationFrame(() => toastEl.classList.add('visible'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('visible');
    setTimeout(() => {
      if (toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
    }, 250);
  }, 2200);
}

function clampInt(value, min, max, fallback) {
  const num = parseInt(value, 10);
  if (Number.isNaN(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function nextAccentColor(index) {
  const palette = ['#0ea5e9', '#22c55e', '#c084fc', '#f97316', '#ef4444', '#14b8a6'];
  return palette[index % palette.length];
}

function idealTextColor(hex) {
  if (!validateHex(hex)) return '#0f172a';
  const clean = hex.replace('#', '');
  const isShort = clean.length === 3;
  const r = parseInt(isShort ? clean[0] + clean[0] : clean.slice(0, 2), 16) / 255;
  const g = parseInt(isShort ? clean[1] + clean[1] : clean.slice(2, 4), 16) / 255;
  const b = parseInt(isShort ? clean[2] + clean[2] : clean.slice(4, 6), 16) / 255;
  const toLinear = v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const L = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  return L > 0.55 ? '#0f172a' : '#ffffff';
}

function validateHex(value) {
  return typeof value === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim());
}

function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, ch => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return ch;
    }
  });
}

function escapeAttr(str = '') {
  return escapeHtml(str);
}
