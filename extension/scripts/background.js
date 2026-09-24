console.log('NexusKitty background service worker started');

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ nexuskitty_last_run: Date.now() });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'NEXUSKITTY_NOTIFY') {
    chrome.storage.local.set({ nexuskitty_last_notice: message.payload || {} });
    sendResponse({ ok: true });
  }
  return true;
});