console.log('NexusKitty background service worker started');

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ nexuskitty_last_run: Date.now() });
});

/* =========================================================
   LEGAL PAGE FETCH RELAY
   ========================================================= */

async function fetchLegalUrl(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);

  try {
    // FIX: added `cache: 'no-store'`. Without it, the browser's HTTP
    // cache serves a conditional revalidation on the 2nd/3rd/... fetch of
    // the same URL within one analysis session (popup.js polls
    // NEXUSKITTY_GET_PAGE_DATA with force_refresh up to 6 times). The
    // server then legitimately answers with 304 Not Modified - which has
    // NO body - and fetch() treats any non-200..299 status (304 included)
    // as response.ok === false. That made every re-fetch after the first
    // one silently return an EMPTY string for legal pages already fetched
    // once, so later analysis attempts lost the real Privacy/Cookie/Terms
    // text entirely (this is what happened on extradigital.co.uk).
    const response = await fetch(url, {
      credentials: 'omit',
      redirect: 'follow',
      cache: 'no-store',
      signal: controller.signal,
    });

    const contentType = response.headers.get('content-type') || '';

    if (!response.ok) {
      return { html: '', status: response.status, finalUrl: response.url, contentType };
    }

    const html = await response.text();
    return { html, status: response.status, finalUrl: response.url, contentType };
  } finally {
    clearTimeout(timeoutId);
  }
}

/* =========================================================
   TRANSLATION RELAY
   ========================================================= */

const TRANSLATE_TARGET_LANG = 'en';
const TRANSLATE_CHUNK_SIZE = 4500;
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

// FIX: added — reject list for asset/script URLs that merely happen to
// contain a legal-sounding word in their filename (e.g. a bundled
// "cookie-consent.min.js"). Without this, a JS file could be picked up
// by the sitemap scan and be analyzed as if it were the legal page.
const NON_HTML_ASSET_PATTERN = /\.(js|mjs|cjs|json|css|png|jpe?g|gif|svg|webp|woff2?|ttf|map)(\?|#|$)/i;

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
    // FIX: same `cache: 'no-store'` reasoning as fetchLegalUrl above.
    const response = await fetch(url, {
      credentials: 'omit',
      redirect: 'follow',
      cache: 'no-store',
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
    .slice(0, 2);

  const found = [];

  for (const sitemapUrl of sitemapUrls) {
    const sitemapXml = await fetchTextWithTimeout(sitemapUrl);
    if (!sitemapXml) continue;

    const locUrls = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/gi)]
      .map((match) => match[1].trim());

    for (const locUrl of locUrls) {
      // FIX: skip .js/.css/image/etc. assets even if their path happens
      // to contain a legal keyword.
      if (NON_HTML_ASSET_PATTERN.test(locUrl)) continue;
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
   ========================================================= */

async function relayIframeConsentTextToTopFrame(message, sender) {
  const tabId = sender?.tab?.id;

  if (typeof tabId !== 'number') {
    console.debug('NexusKitty: iframe consent message had no sender.tab.id, cannot relay.');
    return;
  }

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
      { frameId: 0 }
    );
  } catch (error) {
    console.debug('NexusKitty: could not relay iframe consent text to top frame.', error?.message || error);
  }
}

async function handlePageDataUpdated(message, sender) {
  const tabId = sender?.tab?.id;

  if (typeof tabId !== 'number') {
    return;
  }

  console.debug(
    'NexusKitty: received updated page payload after iframe relay (backend re-analysis not yet wired up here):',
    { url: message?.payload?.url, textLength: message?.payload?.text?.length }
  );
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
    return true;
  }

  if (message && message.type === 'NEXUSKITTY_TRANSLATE_TEXT') {
    translateToEnglish(message.text || '')
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message && message.type === 'NEXUSKITTY_IFRAME_CONSENT_TEXT') {
    relayIframeConsentTextToTopFrame(message, sender)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message && message.type === 'NEXUSKITTY_PAGE_DATA_UPDATED') {
    handlePageDataUpdated(message, sender)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message && message.type === 'NEXUSKITTY_DISCOVER_LEGAL_URLS') {
    discoverLegalUrls(message.origin)
      .then((urls) => sendResponse({ ok: true, urls }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error), urls: [] }));
    return true;
  }

  return false;
});