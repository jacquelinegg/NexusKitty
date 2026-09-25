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
   TRANSLATION RELAY
   ---------------------------------------------------------
   content.js extracts page text in whatever language the
   visited site uses. Rather than teaching the analysis
   backend to understand every language, we translate the
   extracted text to English here (same CSP-avoidance reason
   as fetchLegalUrl above: the service worker isn't bound by
   the visited page's CSP, so it can reach a translation
   endpoint even on sites that would block it from content.js).

   NOTE: This currently calls Google's public, unauthenticated
   translate endpoint (translate.googleapis.com). It's free and
   needs no API key, but it's undocumented/unofficial, rate
   limited, and can change or break without notice. If that
   becomes a problem in production, swap TRANSLATE_ENDPOINT_URL
   below (and the response parsing in translateChunk) for the
   official Google Cloud Translation API or another provider -
   that will need an API key stored via chrome.storage or a
   build-time secret, not hardcoded here.

   Also make sure the manifest's host_permissions cover
   https://translate.googleapis.com/* (already satisfied if the
   manifest uses <all_urls>, as fetchLegalUrl above assumes).
   ========================================================= */

const TRANSLATE_TARGET_LANG = 'en';
const TRANSLATE_CHUNK_SIZE = 4500; // stay under the endpoint's ~5000 char query limit
const TRANSLATE_TIMEOUT_MS = 8000;

function splitIntoTranslationChunks(text, maxLen) {
  if (!text) {
    return [];
  }

  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + maxLen, text.length);

    if (end < text.length) {
      const lastBreak = text.lastIndexOf('\n', end);
      const lastSpace = text.lastIndexOf(' ', end);
      const breakPoint = lastBreak > start ? lastBreak : lastSpace;

      if (breakPoint > start) {
        end = breakPoint;
      }
    }

    chunks.push(text.slice(start, end));
    start = end;
  }

  return chunks;
}

async function translateChunk(chunk, targetLang) {
  const url =
    'https://translate.googleapis.com/translate_a/single' +
    '?client=gtx&sl=auto&tl=' + encodeURIComponent(targetLang) +
    '&dt=t&q=' + encodeURIComponent(chunk);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TRANSLATE_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      return { text: chunk, detectedLang: null, translated: false };
    }

    const data = await response.json();

    const translatedText = Array.isArray(data?.[0])
      ? data[0].map((segment) => (Array.isArray(segment) ? segment[0] || '' : '')).join('')
      : '';

    const detectedLang = typeof data?.[2] === 'string' ? data[2] : null;

    if (!translatedText) {
      return { text: chunk, detectedLang, translated: false };
    }

    return { text: translatedText, detectedLang, translated: true };
  } catch (error) {
    console.debug('NexusKitty: translateChunk failed, returning original chunk.', error?.message || error);
    return { text: chunk, detectedLang: null, translated: false };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function translateToEnglish(text) {
  if (!text || !text.trim()) {
    return { text: text || '', detectedLang: null, translated: false };
  }

  // Already English source pages still get sent through the endpoint once
  // (cheap) so detectedLang is populated consistently; skipping detection
  // heuristics here avoids misclassifying non-English Latin-script text
  // (French, Spanish, Bulgarian transliterations, etc.) as English.

  const chunks = splitIntoTranslationChunks(text, TRANSLATE_CHUNK_SIZE);
  const translatedParts = [];
  let detectedLang = null;
  let anyTranslated = false;

  for (const chunk of chunks) {
    const result = await translateChunk(chunk, TRANSLATE_TARGET_LANG);
    translatedParts.push(result.text);

    if (!detectedLang && result.detectedLang) {
      detectedLang = result.detectedLang;
    }

    if (result.translated) {
      anyTranslated = true;
    }
  }

  return {
    text: translatedParts.join(' '),
    detectedLang,
    translated: anyTranslated
  };
}

/* =========================================================
   DOMAIN-LEVEL LEGAL PAGE DISCOVERY
   ---------------------------------------------------------
   FIX: NEW. findLegalLinks() in content.js only ever looked
   at <a href> elements present in the CURRENT page's DOM. On
   a page with no footer link matching a legal keyword and no
   open consent popup (e.g. a homepage whose footer nav is
   collapsed behind JS, or a random inner page like a
   dictionary search result), nothing was ever found, and
   extractMainText()/extractDocumentTextAsync() fell all the
   way through to junk (raw <noscript> GTM markup, or the
   literal "Legal analysis fallback for site: X" placeholder).

   This block adds a domain-scoped discovery step that runs
   from the service worker (same CSP-avoidance reasoning as
   fetchLegalUrl above) and tries, in order:
     1. robots.txt -> Sitemap: entries -> sitemap.xml <loc> URLs
        that look like legal pages.
     2. A short list of well-known legal-page URL slugs,
        fetched in parallel and lightly validated by checking
        their <title>/<h1> against the same keyword list.
   Results are meant to be cached per-domain by content.js so
   this only runs once per site per cache TTL, not on every
   page load.
   ========================================================= */

const LEGAL_URL_KEYWORDS_BG = [
  'terms', 'conditions', 'privacy', 'cookie', 'policy', 'legal', 'gdpr',
  'datenschutz', 'einwilligung', 'nutzungs',
  'politique', 'consentement',
  'privacidad', 'consentimiento', 'condiciones',
  'privacidade', 'consentimento', 'condições',
  'правила', 'поверителност', 'бисквитки', 'съгласие', 'лични данни',
  'декларация', 'защита на данни', 'условия за ползване', 'политика за',
  'политика', 'согласие',
  'політика', 'згода',
];

const LEGAL_KEYWORDS_REGEX = new RegExp(LEGAL_URL_KEYWORDS_BG.join('|'), 'i');

// Root-relative slugs to probe when nothing else worked. Kept intentionally
// short (favoring the most common English + Bulgarian-Latin forms already
// observed in the wild, e.g. runners.bg's own "/Politika-za-biskvitki")
// to bound the number of speculative requests per undiscovered domain.
const LEGAL_PATH_SLUGS = [
  'privacy', 'privacy-policy', 'privacy_policy',
  'terms', 'terms-of-service', 'terms-of-use', 'terms-and-conditions',
  'cookie-policy', 'cookies',
  'legal', 'legal-notice', 'gdpr', 'data-protection',
  'impressum',
  'obshti-usloviya', 'Obshti-usloviya',
  'politika-za-poveritelnost', 'Politika-za-poveritelnost',
  'politika-za-biskvitki', 'Politika-za-biskvitki',
  'usloviya-za-polzvane', 'zashtita-na-lichni-danni',
  'declaration-personal-data', 'deklaraciya-za-poveritelnost',
];

const DISCOVERY_FETCH_TIMEOUT_MS = 5000;
const MAX_DISCOVERED_URLS = 5;

async function fetchTextWithTimeout(url, timeoutMs = DISCOVERY_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      credentials: 'omit',
      redirect: 'follow',
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    return await response.text();
  } catch (error) {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function isLikelyLegalHtml(html) {
  if (!html) return false;
  const head = html.slice(0, 4000);
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  const h1Match = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(head);
  const sample = `${titleMatch?.[1] || ''} ${h1Match?.[1] || ''}`;
  return LEGAL_KEYWORDS_REGEX.test(sample);
}

async function discoverViaSitemap(origin) {
  const robotsText = await fetchTextWithTimeout(`${origin}/robots.txt`);
  if (!robotsText) {
    return [];
  }

  const sitemapUrls = [...robotsText.matchAll(/^sitemap:\s*(\S+)/gim)]
    .map((match) => match[1])
    .slice(0, 2); // cap: don't crawl an unbounded number of sitemaps

  const found = [];

  for (const sitemapUrl of sitemapUrls) {
    const sitemapXml = await fetchTextWithTimeout(sitemapUrl);
    if (!sitemapXml) continue;

    const locUrls = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/gi)]
      .map((match) => match[1].trim());

    for (const locUrl of locUrls) {
      if (LEGAL_KEYWORDS_REGEX.test(locUrl)) {
        found.push(locUrl);
      }
      if (found.length >= MAX_DISCOVERED_URLS) break;
    }

    if (found.length >= MAX_DISCOVERED_URLS) break;
  }

  return [...new Set(found)].slice(0, MAX_DISCOVERED_URLS);
}

async function discoverViaPathGuessing(origin) {
  const candidates = LEGAL_PATH_SLUGS.map((slug) => `${origin}/${slug}`);

  const results = await Promise.all(
    candidates.map(async (url) => {
      const html = await fetchTextWithTimeout(url);
      if (html && isLikelyLegalHtml(html)) {
        return url;
      }
      return null;
    })
  );

  return results.filter(Boolean).slice(0, MAX_DISCOVERED_URLS);
}

async function discoverLegalUrls(originUrl) {
  let origin;
  try {
    origin = new URL(originUrl).origin;
  } catch (error) {
    return [];
  }

  try {
    const sitemapHits = await discoverViaSitemap(origin);
    if (sitemapHits.length) {
      return sitemapHits;
    }
  } catch (error) {
    console.debug('NexusKitty: sitemap discovery failed.', error?.message || error);
  }

  try {
    return await discoverViaPathGuessing(origin);
  } catch (error) {
    console.debug('NexusKitty: path-guessing discovery failed.', error?.message || error);
    return [];
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

   IMPORTANT: when that backend call is wired in, send
   message.payload.analysis_text (the English-translated text) to
   the backend, not message.payload.text (the original-language
   text) - see the TRANSLATION RELAY block above and the
   analysis_text field content.js now adds to every payload.
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

  // Translate arbitrary extracted page text to English before analysis.
  if (message && message.type === 'NEXUSKITTY_TRANSLATE_TEXT') {
    translateToEnglish(message.text || '')
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
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

  // FIX: NEW. Domain-level legal-page discovery (sitemap + well-known
  // path guessing) for pages where no legal link could be found in the
  // current page's own DOM. See the DOMAIN-LEVEL LEGAL PAGE DISCOVERY
  // block above.
  if (message && message.type === 'NEXUSKITTY_DISCOVER_LEGAL_URLS') {
    discoverLegalUrls(message.origin)
      .then((urls) => sendResponse({ ok: true, urls }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error), urls: [] }));
    return true;
  }

  return false;
});