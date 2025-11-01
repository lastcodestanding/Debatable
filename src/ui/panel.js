// panel.js - modern side panel for Debatable

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const statsEl = document.getElementById('stats');
const totalEl = document.getElementById('totalSentences');
const rerunBtn = document.getElementById('rerunBtn');
const closeBtn = document.getElementById('closeBtn');
const filtersEl = document.getElementById('filters');
const progressCard = document.getElementById('progressCard');
const progressLabel = document.getElementById('progressLabel');
const progressEta = document.getElementById('progressEta');
const progressFill = document.getElementById('progressFill');
const errorCard = document.getElementById('errorCard');
const modePill = document.getElementById('modePill');
const state = {
  statements: [],
  meta: null,
  progress: null,
  classes: [],
  errors: [],
  total: 0,
  activeFilters: new Set()
};

let pendingFocusId = null;
let focusFlashTimeout = null;

window.addEventListener('message', event => {
  if (!event || event.source !== window.parent) return;
  const { type, payload, id } = event.data || {};
  if (type === 'FACT_PANEL_STATE' && payload) {
    syncState(payload, { preserveFilters: true });
    render();
  } else if (type === 'FACT_PANEL_SCROLL_TO' && id) {
    requestPanelFocus(id);
  }
});

rerunBtn.addEventListener('click', async () => {
  rerunBtn.disabled = true;
  rerunBtn.textContent = 'Re-running…';
  try {
    await sendToContent({ type: 'FACT_PANEL_RERUN' });
    await fetchData();
  } finally {
    rerunBtn.disabled = false;
    rerunBtn.textContent = 'Re-run';
  }
});

closeBtn.addEventListener('click', () => {
  closePanel();
});

async function fetchData() {
  try {
    const data = await sendToContent({ type: 'FACT_PANEL_REQUEST_DATA' });
    syncState(data, { preserveFilters: state.activeFilters.size > 0 });
    render();
  } catch (err) {
    errorCard.classList.remove('hidden');
    errorCard.textContent = `Failed to load panel data: ${err.message || err}`;
  }
}

function syncState(data, { preserveFilters = false } = {}) {
  const prevFilters = preserveFilters ? new Set(state.activeFilters) : new Set();
  state.statements = data.statements || [];
  state.meta = data.meta || null;
  state.progress = data.progress || null;
  state.classes = normalizeClasses(data.classes || []);
  state.errors = data.errors || [];
  state.total = data.total || 0;

  const classIds = new Set(state.classes.map(c => c.id));
  const nextFilters = new Set([...prevFilters].filter(id => classIds.has(id)));
  if (nextFilters.size === 0) {
    const defaults = state.classes.filter(c => c.id !== 'neutral').map(c => c.id);
    defaults.forEach(id => nextFilters.add(id));
  }
  state.activeFilters = nextFilters;
  if (pendingFocusId) {
    ensureFiltersInclude(pendingFocusId);
  }
}

function render() {
  renderFilters();
  renderList();
  renderStats();
  renderProgress();
  renderErrors();
  requestAnimationFrame(applyPendingFocus);
}

function renderFilters() {
  filtersEl.innerHTML = '';
  const categories = state.classes.filter(cls => cls.id !== 'neutral');
  if (!categories.length) return;
  categories.forEach(cls => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `filter-btn${state.activeFilters.has(cls.id) ? ' active' : ''}`;
    btn.dataset.cat = cls.id;
    btn.style.borderColor = cls.color;
    btn.style.color = cls.textColor || '#e2e8f0';
    btn.style.background = state.activeFilters.has(cls.id)
      ? applyAlpha(cls.color, 0.28)
      : applyAlpha(cls.color, 0.12);
    btn.textContent = cls.label || cls.id;
    btn.addEventListener('click', () => {
      if (state.activeFilters.has(cls.id)) {
        state.activeFilters.delete(cls.id);
      } else {
        state.activeFilters.add(cls.id);
      }
      renderList();
      renderStats();
    });
    filtersEl.appendChild(btn);
  });
}

function renderList() {
  listEl.innerHTML = '';
  const items = state.statements.filter(stmt => state.activeFilters.size === 0 || state.activeFilters.has(stmt.category));
  if (items.length === 0) {
    emptyEl.style.display = 'block';
    return;
  }
  emptyEl.style.display = 'none';
  const classMap = new Map(state.classes.map(cls => [cls.id, cls]));
  for (const stmt of items) {
    const cls = classMap.get(stmt.category) || {};
    const card = document.createElement('article');
    card.className = 'item-card';
    card.dataset.id = stmt.id;
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.style.background = applyAlpha(cls.color || '#64748b', 0.22);
    badge.style.color = cls.textColor || '#e2e8f0';
    badge.textContent = cls.label || stmt.category;
    const text = document.createElement('div');
    text.className = 'item-text';
    text.textContent = stmt.text;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const confidence = typeof stmt.confidence === 'number'
      ? `${Math.round(stmt.confidence * 100)}%`
      : 'N/A';
    meta.textContent = `Confidence ${confidence} • ${stmt.rationale || 'No rationale provided.'}`;
    card.appendChild(badge);
    card.appendChild(text);
    card.appendChild(meta);
    card.addEventListener('mouseenter', () => highlightInPage(stmt.id, true));
    card.addEventListener('mouseleave', () => highlightInPage(stmt.id, false));
    card.addEventListener('click', async () => {
      highlightInPage(stmt.id, true);
      setTimeout(() => highlightInPage(stmt.id, false), 800);
      try {
        await focusInPage(stmt.id);
      } catch (err) {
        // ignore focus errors so panel can still close
      } finally {
        closePanel();
      }
    });
    listEl.appendChild(card);
  }
}

function renderStats() {
  const filteredCount = listEl.childElementCount;
  const totalFlagged = state.statements.length;
  const mode = (state.meta && state.meta.mode) || 'heuristic';
  statsEl.textContent = `${filteredCount} shown • ${totalFlagged} flagged`;
  totalEl.textContent = state.total ? `${state.total} sentences scanned` : '';
  const label = mapModeToLabel(mode);
  if (label) {
    modePill.style.display = 'inline-flex';
    modePill.textContent = label;
  } else {
    modePill.style.display = 'none';
  }
}

function renderProgress() {
  const progress = state.progress;
  if (!progress || !progress.total || progress.status === 'done') {
    progressCard.style.display = 'none';
    return;
  }
  progressCard.style.display = 'grid';
  const pct = Math.min(100, Math.max(0, (progress.completed / progress.total) * 100));
  progressFill.style.width = `${pct}%`;
  if (progress.status === 'error') {
    progressLabel.textContent = `Processing failed (${progress.completed}/${progress.total})`;
  } else if (progress.status === 'pending') {
    progressLabel.textContent = `Waiting • ${progress.completed}/${progress.total}`;
  } else {
    progressLabel.textContent = `${progress.completed}/${progress.total} processed`;
  }
  progressEta.textContent = progress.etaMs > 0 ? `ETA ${formatEta(progress.etaMs)}` : '';
}

function renderErrors() {
  if (!state.errors || !state.errors.length) {
    errorCard.classList.add('hidden');
    errorCard.textContent = '';
    return;
  }
  errorCard.classList.remove('hidden');
  errorCard.innerHTML = state.errors.map(err => escapeHtml(err)).join('<br/>');
}

function mapModeToLabel(mode) {
  switch (mode) {
    case 'remote': return 'Prompt API';
    case 'heuristic-fallback': return 'Fallback';
    case 'heuristic': return 'Heuristic';
    case 'on-device': return 'On-device';
    case 'on-device-unavailable': return 'On-device Missing';
    case 'on-device-failed': return 'On-device Error';
    default: return '';
  }
}

function normalizeClasses(classes) {
  return (classes || []).map(cls => ({
    id: String(cls.id || '').trim().toLowerCase(),
    label: cls.label || cls.id || '',
    color: cls.color || '#64748b',
    textColor: cls.textColor || '#e2e8f0'
  })).filter(cls => cls.id);
}

function formatEta(ms) {
  if (!ms || !Number.isFinite(ms)) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return rem ? `${mins}m ${rem}s` : `${mins}m`;
}

function applyAlpha(hex, alpha) {
  if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex)) return `rgba(100,116,139,${alpha})`;
  const clean = hex.replace('#', '');
  const isShort = clean.length === 3;
  const r = parseInt(isShort ? clean[0] + clean[0] : clean.slice(0, 2), 16);
  const g = parseInt(isShort ? clean[1] + clean[1] : clean.slice(2, 4), 16);
  const b = parseInt(isShort ? clean[2] + clean[2] : clean.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
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

function sendToContent(message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (!tabs.length) return reject(new Error('No active tab detected'));
      chrome.tabs.sendMessage(tabs[0].id, message, resp => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
        if (resp && resp.error) return reject(new Error(resp.error));
        resolve(resp || {});
      });
    });
  });
}

function highlightInPage(id, on) {
  return sendToContent({ type: 'FACT_PANEL_HOVER', id, on }).catch(()=>{});
}

function focusInPage(id) {
  return sendToContent({ type: 'FACT_PANEL_FOCUS', id }).catch(()=>{});
}

function closePanel() {
  sendToContent({ type: 'FACT_PANEL_CLOSE' }).catch(()=>{});
  window.parent.postMessage({ type: 'FACT_PANEL_CLOSE' }, '*');
}

function requestPanelFocus(id) {
  if (!id) return;
  pendingFocusId = id;
  ensureFiltersInclude(id);
  render();
}

function ensureFiltersInclude(id) {
  if (!id || state.activeFilters.size === 0) return false;
  const stmt = state.statements.find(s => s.id === id);
  if (!stmt) return false;
  if (state.activeFilters.has(stmt.category)) return false;
  state.activeFilters.add(stmt.category);
  return true;
}

function applyPendingFocus() {
  if (!pendingFocusId) return;
  const selectorId = escapeSelector(pendingFocusId);
  const card = selectorId ? listEl.querySelector(`[data-id='${selectorId}']`) : null;
  if (!card) return;
  pendingFocusId = null;
  if (focusFlashTimeout) {
    clearTimeout(focusFlashTimeout);
    focusFlashTimeout = null;
  }
  card.classList.add('item-card-focus');
  card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  focusFlashTimeout = setTimeout(() => {
    card.classList.remove('item-card-focus');
    focusFlashTimeout = null;
  }, 1400);
}

function escapeSelector(value) {
  if (typeof value !== 'string') return '';
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

fetchData();
