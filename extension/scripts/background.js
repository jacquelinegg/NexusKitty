console.log('NexusKitty background service worker started');

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ nexuskitty_last_run: Date.now() });
});

/* =========================================================
   LEGAL PAGE FETCH RELAY
   ---------------------------------------------------------
   Content scripts run inside the visited page's execution
   context, so their fetch() calls are bound by that page's
   own Content-Security-Policy (connect-src etc). Many sites
   with cookie-consent managers (OneTrust, Cookiebot...) set
   a strict CSP that silently blocks cross-origin fetch from
   the content script - even though the extension itself has
   <all_urls> host_permissions.

   The service worker is NOT bound by any page's CSP, only by
   this extension's own host_permissions. So all cross-origin
   fetches of linked Privacy/Terms/Cookie pages are relayed
   here instead of being done directly in content.js.
   ========================================================= */

async function fetchLegalUrl(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);

  try {
    const response = await fetch(url, {
      credentials: 'omit',
      redirect: 'follow',
      signal: controller.signal,
    });

    if (!response.ok) {
      return { html: '', status: response.status, finalUrl: response.url };
    }

    const html = await response.text();
    return { html, status: response.status, finalUrl: response.url };
  } finally {
    clearTimeout(timeoutId);
  }
}

/* =========================================================
   CROSS-ORIGIN CMP IFRAME -> TOP FRAME RELAY
   ---------------------------------------------------------
   FIX: This whole block was previously missing entirely.

   content.js runs in EVERY frame of the page (all_frames: true
   in the manifest), including cross-origin CMP iframes (e.g.
   Sourcepoint's "Notice Message App"). The instance running
   INSIDE that iframe can see the fully JS-rendered banner text
   (the top frame cannot, due to the Same-Origin Policy), so it
   sends it here as NEXUSKITTY_IFRAME_CONSENT_TEXT.

   Without this handler, that message was silently dropped
   (the listener below fell through to `return false` for any
   unrecognized type), so the top frame's `receivedIframeConsentText`
   variable was NEVER populated, no matter what content.js did
   with it downstream. This handler forwards the text down to the
   TOP frame of the same tab (frameId 0) as
   NEXUSKITTY_IFRAME_CONSENT_TEXT_RELAY, which is what content.js's
   top-frame instance actually listens for.
   ========================================================= */

async function relayIframeConsentTextToTopFrame(message, sender) {
  const tabId = sender?.tab?.id;

  if (typeof tabId !== 'number') {
    console.debug('NexusKitty: iframe consent message had no sender.tab.id, cannot relay.');
    return;
  }

  // Don't bother relaying a message that already came from the top frame
  // (sender.frameId === 0) - only genuine cross-origin child iframes need
  // this relay; a top-frame consent popup is already visible to itself.
  if (sender.frameId === 0) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(
      tabId,
      {
        type: 'NEXUSKITTY_IFRAME_CONSENT_TEXT_RELAY',
        text: message.text || '',
        frameUrl: message.frameUrl || sender.url || '',
      },
      { frameId: 0 } // top frame only
    );
  } catch (error) {
    // Common and harmless: top frame's content script may not be ready yet,
    // or the tab may have navigated away. Don't spam the console.
    console.debug('NexusKitty: could not relay iframe consent text to top frame.', error?.message || error);
  }
}

/* =========================================================
   FORCED RE-ANALYSIS AFTER IFRAME RELAY
   ---------------------------------------------------------
   content.js's top frame calls this (NEXUSKITTY_PAGE_DATA_UPDATED)
   after it rebuilds its page payload in response to newly-arrived
   iframe consent text, so the backend can re-analyze the page with
   the now-complete banner text and push a fresh verdict back down
   as NEXUSKITTY_ANALYSIS_RESULT.

   TODO: Wire this to whatever function currently calls the
   nexuskitty.onrender.com (or localhost:8000) backend and turns the
   response into { categories, should_warn } - that logic isn't in
   this file yet (it looks like it currently lives in popup.js and
   only runs when the popup is opened). Once that function is
   available here, replace the console.debug below with a real call,
   e.g.:
     const result = await analyzeWithBackend(message.payload);
     await chrome.tabs.sendMessage(tabId, {
       type: 'NEXUSKITTY_ANALYSIS_RESULT',
       categories: result.categories,
       should_warn: result.should_warn,
     }, { frameId: 0 });
   ========================================================= */

async function handlePageDataUpdated(message, sender) {
  const tabId = sender?.tab?.id;

  if (typeof tabId !== 'number') {
    return;
  }

  console.debug(
    'NexusKitty: received updated page payload after iframe relay (backend re-analysis not yet wired up here):',
    { url: message?.payload?.url, textLength: message?.payload?.text?.length }
  );

  // Stub only - see TODO above. Left as a no-op so this doesn't silently
  // pretend to succeed; wire in the real backend call here.
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) {
    return false;
  }

  if (message && message.type === 'NEXUSKITTY_NOTIFY') {
    chrome.storage.local.set({ nexuskitty_last_notice: message.payload || {} });
    sendResponse({ ok: true });
    return true;
  }

  if (message && message.type === 'NEXUSKITTY_FETCH_URL') {
    fetchLegalUrl(message.url)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true; // keep the message channel open for the async response
  }

  // FIX: relay consent text detected inside a cross-origin CMP iframe up to
  // that tab's top frame.
  if (message && message.type === 'NEXUSKITTY_IFRAME_CONSENT_TEXT') {
    relayIframeConsentTextToTopFrame(message, sender)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  // FIX: top frame notifying us that it rebuilt its payload after receiving
  // relayed iframe text, so we can (eventually) re-run backend analysis.
  if (message && message.type === 'NEXUSKITTY_PAGE_DATA_UPDATED') {
    handlePageDataUpdated(message, sender)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  return false;
});