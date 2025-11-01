// popup.js - basic controls

document.getElementById('purgeBtn').addEventListener('click', async () => {
  await sendBg({ type: 'PURGE_CACHE' });
  window.close();
});

const openOptsBtn = document.getElementById('openOptionsBtn');
if (openOptsBtn) {
  openOptsBtn.addEventListener('click', () => {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open(chrome.runtime.getURL('src/ui/options.html'));
    }
  });
}

const apiStatusEl = document.getElementById('apiStatus');
chrome.storage.local.get(['enablePromptApi','modelId'], data => {
  if (!apiStatusEl) return;
  const enabled = data.enablePromptApi ?? true;
  const model = data.modelId || 'gemini-nano';
  if (!enabled) {
    apiStatusEl.textContent = 'On-device model disabled – using heuristic fallback.';
  } else {
    apiStatusEl.textContent = `On-device model: ${model}`;
  }
});

async function sendBg(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, resp => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      resolve(resp);
    });
  });
}
