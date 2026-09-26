console.log('NexusKitty background service worker started');

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ nexuskitty_last_run: Date.now() });
});

// An MV3 service worker can be terminated at any moment. If that happens while
// the render tab exists, the in-memory session is lost and the tab would stay
// in the user's tab strip forever. The tab id is persisted in storage.session
// (in-memory, cleared on browser restart) and any leftover tab is closed as soon
// as the worker wakes up again.
const RENDER_TAB_STORAGE_KEY = 'nexuskittyRenderTabId';

async function closeOrphanedRenderTab() {
  try {
    const stored = await chrome.storage.session.get(RENDER_TAB_STORAGE_KEY);
    const tabId = stored?.[RENDER_TAB_STORAGE_KEY];
    await chrome.storage.session.remove(RENDER_TAB_STORAGE_KEY);
    if (typeof tabId === 'number') {
      await chrome.tabs.remove(tabId);
      console.log('NexusKitty [RENDER]: closed orphaned render tab', tabId);
    }
  } catch (e) {
    // No leftover tab, or it is already gone.
  }
}

closeOrphanedRenderTab();

/* =========================================================
   LEGAL PAGE FETCH RELAY
   ========================================================= */

/* =========================================================
   CHARSET-AWARE DECODING
   FIX: older Cyrillic sites (esp. .bg running windows-1251) usually
   declare their encoding ONLY via <meta charset> inside the HTML and
   ship a Content-Type header with no charset parameter. Response.text()
   then decodes the bytes as UTF-8, which yields mojibake instead of
   Cyrillic; the page downloads fine (200, ~2.9 kB) but the extracted
   text is unreadable garbage, fails every keyword/length check in
   stripJunkNoise / fetchLegalPageText, and the analysis never starts
   ("could not enter the analysis" on foreign-language sites).
   Read the raw bytes and decode them with the declared charset instead.
   ========================================================= */

function detectCharsetFromBytes(buffer) {
  // <meta charset> always lives in <head>, so sniffing the first 2 kB is enough.
  const head = new Uint8Array(buffer.slice(0, 2048));
  let ascii = '';
  for (let i = 0; i < head.length; i += 1) {
    ascii += head[i] < 128 ? String.fromCharCode(head[i]) : ' ';
  }
  const metaCharset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(ascii);
  if (metaCharset && metaCharset[1]) return metaCharset[1].toLowerCase();
  const httpEquiv = /<meta[^>]+content=["'][^"']*charset=([\w-]+)/i.exec(ascii);
  if (httpEquiv && httpEquiv[1]) return httpEquiv[1].toLowerCase();
  return null;
}

function decodeWithCharset(buffer, contentType) {
  // 1. Prefer the charset declared in the HTTP header, when present.
  const headerMatch = /charset=([\w-]+)/i.exec(contentType || '');
  let charset = headerMatch ? headerMatch[1].toLowerCase() : null;

  // 2. Otherwise sniff <meta charset> / http-equiv inside the document.
  if (!charset) {
    charset = detectCharsetFromBytes(buffer) || 'utf-8';
  }

  try {
    return new TextDecoder(charset).decode(buffer);
  } catch (error) {
    // Unknown/unsupported label - fall back to utf-8 instead of throwing
    // and losing the page entirely.
    return new TextDecoder('utf-8').decode(buffer);
  }
}

/* =========================================================
   RENDERED FETCH (client-side rendered pages)
   FIX: a plain fetch() never executes JavaScript, so for SPA sites
   (Next.js/Nuxt/React articles, e.g. betano.bg/statiya/...) the static
   HTML is only an empty app shell - 276 kB of markup that parses down to
   a handful of characters. A real browser tab that runs the JS is the only
   way to get the text.

   UX: Chrome has no truly headless navigation (an off-screen document cannot
   load a remote page, and chrome.debugger refuses to attach to a background
   target), so the render happens in a REAL TAB. To keep that unobtrusive:
     - ONE worker tab, reused for every URL - no tab storm, nothing opens and
       closes per document
     - a normal tab in the tab strip of the window the user is already using,
       not a second browser window
     - inactive, muted, pinned and auto-discardable, so it never takes focus
       and never plays sound
     - parked on about:blank and closed after a longer idle period
     - serialized, so concurrent legal pages queue instead of racing
   ========================================================= */

const RENDER_TAB_TIMEOUT_MS = 9000;
const RENDER_SETTLE_MS = 1200;
// Long enough that a burst of legal pages reuses the same tab, short enough
// that the user's tab strip returns to normal shortly after an analysis.
const RENDER_TAB_IDLE_CLOSE_MS = 60000;
// Below this, the page is treated as "the app has not finished yet" and we
// keep waiting instead of shipping a shell.
const RENDER_THIN_TEXT_CHARS = 2500;
const RENDER_EXTRA_WAIT_ROUNDS = 3;
const RENDER_EXTRA_WAIT_MS = 2500;

let renderSession = null; // { windowId, tabId }
let renderIdleTimer = null;
// Serializes rendered reads: one navigation at a time in the single worker tab.
let renderQueue = Promise.resolve();

function clearRenderIdleTimer() {
  if (renderIdleTimer) {
    clearTimeout(renderIdleTimer);
    renderIdleTimer = null;
  }
}

async function closeRenderSession() {
  clearRenderIdleTimer();
  const session = renderSession;
  renderSession = null;
  chrome.storage.session.remove(RENDER_TAB_STORAGE_KEY).catch(() => {});
  if (!session) return;
  try {
    await chrome.tabs.remove(session.tabId);
  } catch (e) {}
}

function scheduleRenderSessionClose() {
  clearRenderIdleTimer();
  renderIdleTimer = setTimeout(() => {
    closeRenderSession().catch(() => {});
  }, RENDER_TAB_IDLE_CLOSE_MS);
}

// The render tab goes into the tab strip of the window the user is reading, so
// it has to pick that window deliberately: the last focused normal one, never
// a minimized/offscreen/popup window and never the DevTools window.
async function pickRenderHostWindowId() {
  const last = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  if (typeof last?.id === 'number' && last.state !== 'minimized') return last.id;

  const all = await chrome.windows.getAll({ windowTypes: ['normal'] }).catch(() => []);
  const usable = all.filter((w) => w.state !== 'minimized' && !/devtools/i.test(w.url || ''));
  if (usable.length) return usable[usable.length - 1].id;

  if (typeof last?.id === 'number') return last.id;
  const current = await chrome.windows.getCurrent().catch(() => null);
  return current?.id;
}

async function ensureRenderSession() {
  if (renderSession) {
    try {
      const tab = await chrome.tabs.get(renderSession.tabId);
      if (tab) {
        clearRenderIdleTimer();
        return renderSession;
      }
    } catch (e) {
      // Tab was closed by the user - drop the stale session.
    }
    renderSession = null;
  }

  const windowId = await pickRenderHostWindowId();
  // Inactive and pinned: it sits in the tab strip as a quiet placeholder and
  // never steals focus from the page being read. NOTE: `muted` is NOT accepted
  // by tabs.create - it is a tabs.update-only property.
  const tab = await chrome.tabs.create({
    windowId,
    url: 'about:blank',
    active: false,
    pinned: true,
  });

  if (typeof tab?.id !== 'number') {
    throw new Error('render tab was not created');
  }

  try {
    await chrome.tabs.update(tab.id, { muted: true, autoDiscardable: true });
  } catch (e) {}

  renderSession = { windowId, tabId: tab.id };

  // Remember the tab so a service-worker restart cannot orphan it in the strip.
  chrome.storage.session.set({ [RENDER_TAB_STORAGE_KEY]: tab.id }).catch(() => {});
  clearRenderIdleTimer();
  return renderSession;
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (completed) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(completed);
    };
    const onUpdated = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === 'complete') finish(true);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    setTimeout(() => finish(false), timeoutMs);
  });
}

// Runs in the tab's ISOLATED world - it only reads the DOM, so no CSP or
// page-script interference. Must stay self-contained (executeScript
// serializes the function source).
function collectRenderedPageText() {
  const main = document.querySelector('main, article, [role="main"], .content, #content');
  const root = main || document.body;
  const text = root ? (root.innerText || root.textContent || '') : '';
  return {
    text: text || '',
    title: document.title || '',
    href: location.href,
    readyState: document.readyState,
  };
}

// Generic consent/lazy-content pass, injected into the render tab. Legal pages
// very often hide the actual clauses behind a cookie wall, a collapsed
// <details>, or a "show more" button, and a plain read then returns navigation
// chrome instead of the document. Everything here is heuristic and language
// agnostic by intent - it clicks at most a few controls and never submits a
// form. Must stay self-contained.
function prepareRenderedDocument() {
  const norm = (value) => (value || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const summary = { clicked: 0, expanded: 0, overlays: 0, scrolled: false };

  // 1. Accept / reject consent controls. Accept is preferred, but rejecting is
  //    better than leaving the wall up - the document is what we came for.
  const acceptPattern = /^(accept( all)?|agree( & continue| to all)?|allow all|accept cookies|i agree|ok|continue|got it|yes, i agree|alle akzeptieren|zustimmen|zustimmen und weiter|akzeptieren|alle cookies erlauben|oui, j'accepte|accepter( tout)?|tout accepter|aceptar|aceitar( tudo)?|acepto|accepta( tot)?|souhlasím|přijmout( vše)?|запознай|прием(ам)?|приеми всички|разреши всички|съгласен съм|да, съгласен съм|kabul et|onaylıyorum|quảng cáo)$/;
  const declinePattern = /^(reject all|decline all|deny|reject|alle ablehnen|ablehnen|refuser( tout)?|tout refuser|rejeitar|odrzuć|отхвърли( всички)?|отказвам|reddet)$/;

  const controls = Array.from(
    document.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"]')
  ).slice(0, 1200);

  for (const element of controls) {
    if (summary.clicked >= 3) break;
    const label = norm(element.innerText || element.value || element.getAttribute('aria-label') || '');
    if (!label || label.length > 40) continue;
    if (acceptPattern.test(label) || declinePattern.test(label)) {
      try { element.click(); summary.clicked += 1; } catch (e) {}
    }
  }

  // 2. Collapsed sections: <details> and aria-expanded toggles hide whole
  //    chapters of a policy until clicked.
  for (const details of Array.from(document.querySelectorAll('details')).slice(0, 200)) {
    if (details.open) continue;
    try { details.open = true; summary.expanded += 1; } catch (e) {}
  }
  for (const toggle of Array.from(document.querySelectorAll('[aria-expanded="false"]')).slice(0, 200)) {
    const label = norm(toggle.innerText || toggle.getAttribute('aria-label') || '');
    if (/^(show more|read more|mehr( anzeigen)?|weitere anzeigen|mehr lesen|voir plus|leer más|ver mais|visa mer|więcej|pokazat bolshe|прочети още|покажи още|повече)$/i.test(label)) {
      try { toggle.click(); summary.expanded += 1; } catch (e) {}
    }
  }

  // 3. Full-viewport overlays (consent walls) can sit on top of the text. Only
  //    small ones are removed - a removed main column would lose the document.
  for (const element of Array.from(document.querySelectorAll('div, dialog, section')).slice(0, 400)) {
    if (summary.overlays >= 6) break;
    const style = window.getComputedStyle(element);
    if (style.position !== 'fixed' && style.position !== 'sticky') continue;
    const rect = element.getBoundingClientRect();
    if (rect.width < window.innerWidth * 0.6 || rect.height < window.innerHeight * 0.4) continue;
    if (norm(element.innerText || '').length > 3000) continue;
    try { element.remove(); summary.overlays += 1; } catch (e) {}
  }

  // 4. Trigger lazy-loaded text, then come back to the top.
  try {
    window.scrollTo(0, document.body ? document.body.scrollHeight : 0);
    summary.scrolled = true;
  } catch (e) {}

  return summary;
}

async function readRenderedTab(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: collectRenderedPageText,
  });
  return results && results[0] ? results[0].result : null;
}

async function performRenderedFetch(url) {
  let session = null;
  try {
    session = await ensureRenderSession();
    await chrome.tabs.update(session.tabId, { url, active: false });
    const completed = await waitForTabComplete(session.tabId, RENDER_TAB_TIMEOUT_MS);
    // Even a "complete" load can be followed by a hydration render, so always
    // give the SPA a short settle window before reading the DOM.
    await new Promise((resolve) => setTimeout(resolve, RENDER_SETTLE_MS));

    // Consent walls, collapsed <details> and "show more" buttons hide the very
    // clauses we came for. This runs in the render tab, so it can interact with
    // the page, and it is what makes the render work on sites beyond DW/betano.
    let prepSummary = null;
    // A navigation that dies (ERR_NAME_NOT_RESOLVED, ERR_CONNECTION_RESET, a
    // geo or bot block served as a bare 5xx) leaves Chrome's non-scriptable error
    // document in the tab, and every later executeScript throws "Frame with ID 0
    // is showing error page". That is a failed navigation, not a failed script,
    // so it gets its own reason and the tab is recycled immediately.
    try {
      const injected = await chrome.scripting.executeScript({
        target: { tabId: session.tabId },
        func: prepareRenderedDocument,
      });
      prepSummary = injected?.[0]?.result || null;
      if (prepSummary && (prepSummary.clicked || prepSummary.expanded || prepSummary.overlays)) {
        console.log('NexusKitty [RENDER]: prepared', session.tabId, JSON.stringify(prepSummary));
        // Let the clicks and the scroll-triggered lazy content settle.
        await new Promise((resolve) => setTimeout(resolve, RENDER_SETTLE_MS));
      }
    } catch (error) {
      const message = error?.message || String(error);
      if (/error page|cannot access|frame with id/i.test(message)) {
        console.log('NexusKitty [RENDER]: navigation failed for', url, '| tab recycled');
        await closeRenderSession();
        return { ok: false, text: '', reason: 'navigation_error', error: message };
      }
      console.log('NexusKitty [RENDER]: document preparation skipped', message);
    }

    let payload = await readRenderedTab(session.tabId);
    // Second chance: consent walls and route-level code splitting can hydrate
    // a second or two after `complete`, so re-read once rather than reporting
    // an empty DOM as "nothing there".
    if (!payload || (payload.text || '').length < 200) {
      await new Promise((resolve) => setTimeout(resolve, RENDER_SETTLE_MS));
      const retry = await readRenderedTab(session.tabId);
      if (retry && (!payload || (retry.text || '').length > (payload.text || '').length)) {
        payload = retry;
      }
    }

    // Still thin? A React/Apollo app (learngerman.dw.com runs Apollo and
    // fetches its legal text from a GraphQL endpoint) renders the shell first
    // and the document only after that request resolves. 629 characters meant
    // "the app had not finished", not "that is the whole document" - so keep
    // waiting instead of shipping the shell to the model.
    let extraRounds = 0;
    while (extraRounds < RENDER_EXTRA_WAIT_ROUNDS && ((payload?.text || '').length < RENDER_THIN_TEXT_CHARS)) {
      extraRounds += 1;
      await new Promise((resolve) => setTimeout(resolve, RENDER_EXTRA_WAIT_MS));
      const grown = await readRenderedTab(session.tabId);
      const grownLen = (grown?.text || '').length;
      if (grownLen > (payload?.text || '').length) {
        payload = grown;
        console.log('NexusKitty [RENDER]:', url, '| text grew to', grownLen, 'chars after waiting');
      }
    }

    const text = (payload && payload.text) || '';

    console.log(
      'NexusKitty [RENDER]:', url,
      '| completed:', completed,
      '| readyState:', payload?.readyState,
      '| title:', payload?.title,
      '| rendered chars:', text.length
    );

    scheduleRenderSessionClose();

    if (!text) return { ok: false, text: '', reason: 'empty_dom' };
    return {
      ok: true,
      text,
      title: payload.title,
      finalUrl: payload.href || url,
      rendered: true,
    };
  } catch (error) {
    console.log('NexusKitty [RENDER]: failed for', url, error?.message || error);
    // A broken worker tab must not poison later attempts.
    await closeRenderSession();
    return { ok: false, text: '', reason: 'exception', error: error?.message || String(error) };
  }
}

/* =========================================================
   SHARED URL CACHE KEYS + RENDERED RESULT CACHE
   =========================================================
   The hash fragment never reaches the server, and betano's table of contents
   fills the page with #ParagraphN links to itself. Treating those as distinct
   documents multiplied every fetch, every render and every translation. One
   key per document, computed identically here and in the content script.
   ========================================================= */

const RENDERED_RESULT_CACHE_TTL = 5 * 60 * 1000;

// url -> { timestamp, result }
const renderedResultCache = new Map();
// cacheKey -> Promise, so concurrent callers share a single render
const renderedInFlight = new Map();
const staticResultCache = new Map();
const staticInFlight = new Map();
const STATIC_RESULT_CACHE_TTL = 60 * 1000;

function cacheKeyForUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    // Tracking parameters only fragment the cache; the document is identical.
    for (const name of Array.from(parsed.searchParams.keys())) {
      if (/^(utm_|gclid$|fbclid$|msclkid$|_ga|ref$)/i.test(name)) parsed.searchParams.delete(name);
    }
    return parsed.origin + parsed.pathname + parsed.search;
  } catch (error) {
    return String(url).split('#')[0];
  }
}

function fetchRenderedUrl(url) {
  // One render per document, no matter how many callers ask for it. The
  // content script caches in page memory, but every frame of every tab runs
  // its own copy, and the worker tab itself loads the analysed page - so the
  // same URL used to be fetched and re-rendered several times per popup
  // session. Deduplicating here is what actually stops that.
  const key = cacheKeyForUrl(url);

  const cached = renderedResultCache.get(key);
  if (cached && Date.now() - cached.timestamp < RENDERED_RESULT_CACHE_TTL) {
    console.log('NexusKitty [CACHE]: reusing rendered result for', key, '| age', Math.round((Date.now() - cached.timestamp) / 1000), 's');
    return Promise.resolve(cached.result);
  }

  const inFlight = renderedInFlight.get(key);
  if (inFlight) {
    console.log('NexusKitty [CACHE]: joining an in-flight render for', key);
    return inFlight;
  }

  // Chain onto the queue so parallel legal pages take turns in the one
  // off-screen document / worker window.
  const run = renderQueue.then(
    () => renderInvisible(url),
    () => renderInvisible(url)
  ).then((result) => {
    if (result && result.ok) {
      renderedResultCache.set(key, { timestamp: Date.now(), result });
    }
    return result;
  }).finally(() => {
    renderedInFlight.delete(key);
  });

  renderedInFlight.set(key, run);
  renderQueue = run.catch(() => {});
  return run;
}


/* =========================================================
   STATIC FETCH (charset aware) + framing capability probe
   =========================================================
   6s was too tight for slow legal pages (learngerman.dw.com's
   /privacy-settings-de was cancelled at 6.02s on a cold request), so the
   static read gets 10s and the rendered path covers the rest.
   ========================================================= */

const STATIC_FETCH_TIMEOUT_MS = 10000;

// url -> can this document be shown in a cross-origin iframe?
// learngerman.dw.com sends `frame-ancestors https://*.dw.com` and betano.bg
// sends `frame-ancestors https://*.betano.bg:*`, so an off-screen iframe is
// refused there; sites that send nothing are worth a cheap off-screen try.
const framingSupportByUrl = new Map();

function detectFramingSupport(url, headers) {
  const get = (name) => {
    try { return headers.get(name) || ''; } catch (e) { return ''; }
  };

  const xfo = get('x-frame-options').trim().toUpperCase();
  if (xfo === 'DENY' || xfo === 'SAMEORIGIN') {
    framingSupportByUrl.set(url, false);
    return false;
  }

  const csp = get('content-security-policy');
  const frameAncestors = /frame-ancestors([^;]*)/i.exec(csp);
  if (frameAncestors) {
    // chrome-extension:// is never a legitimate ancestor expression here, so
    // any frame-ancestors directive means an off-screen frame is refused.
    framingSupportByUrl.set(url, false);
    return false;
  }

  framingSupportByUrl.set(url, true);
  return true;
}

async function fetchLegalUrlUncached(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), STATIC_FETCH_TIMEOUT_MS);

  try {
    // `cache: 'no-store'` is required: without it the browser revalidates on
    // the 2nd/3rd/... fetch of the same URL inside one analysis session, the
    // server answers 304 with no body, and fetch() treats that as !ok - which
    // silently emptied every legal page after its first fetch.
    const response = await fetch(url, {
      credentials: 'omit',
      redirect: 'follow',
      cache: 'no-store',
      signal: controller.signal,
    });

    const contentType = response.headers.get('content-type') || '';
    const frameable = detectFramingSupport(url, response.headers);

    if (!response.ok) {
      return { html: '', status: response.status, finalUrl: response.url, contentType, frameable };
    }

    // Decode with the page's real charset instead of response.text(), which
    // assumes UTF-8 when the Content-Type header omits the charset.
    const buffer = await response.arrayBuffer();
    const html = decodeWithCharset(buffer, contentType);
    console.log(
      'NexusKitty [FETCH]:', response.status, url,
      '| bytes:', buffer.byteLength,
      '| content-type:', contentType || '(none)',
      '| frameable:', frameable,
      '| html chars:', html.length
    );
    return {
      html,
      status: response.status,
      finalUrl: response.url,
      contentType,
      frameable,
      bytes: buffer.byteLength,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// One static read per document per minute, shared by every caller (content
// script frames, the popup's polling loop, the worker tab's own content
// script). A document's HTML does not change between those calls, and the
// duplication showed up as the same URL appearing 4-5 times in the Network tab
// within a single analysis.
function fetchLegalUrl(url) {
  const key = cacheKeyForUrl(url);

  const cached = staticResultCache.get(key);
  if (cached && Date.now() - cached.timestamp < STATIC_RESULT_CACHE_TTL) {
    console.log('NexusKitty [CACHE]: reusing static fetch for', key);
    return Promise.resolve(cached.result);
  }

  const inFlight = staticInFlight.get(key);
  if (inFlight) return inFlight;

  const run = fetchLegalUrlUncached(url)
    .then((result) => {
      // A refusal is cached too, so popup polling does not hammer a site that
      // already said 403/404 for this document.
      staticResultCache.set(key, { timestamp: Date.now(), result });
      return result;
    })
    .finally(() => {
      staticInFlight.delete(key);
    });

  staticInFlight.set(key, run);
  return run;
}

/* =========================================================
   RENDER STRATEGY
   =========================================================
   Chrome cannot execute a remote site's JavaScript in a fully headless way:
     - an off-screen <iframe> is a real browsing context, but is refused by
       every site that sends X-Frame-Options / CSP frame-ancestors;
     - chrome.debugger could do it, but this Chrome rejects
       chrome.debugger.attach({targetId}) ("Either tab id or extension id must
       be specified"), so Target.createTarget is unreachable for extensions.
   What remains is one worker TAB in the tab strip of the window the user is
   already reading: created on demand, pinned/muted/inactive, reused for every
   URL and closed after an idle period. No second browser window is ever opened.
   ========================================================= */

// The worker tab is the only mechanism that always works, so it is the default.
const USE_RENDER_TAB = true;

// An off-screen iframe is genuinely invisible, so it is tried first - but only
// when the static response headers said the site allows being framed. That
// avoids burning 8+ seconds on a doomed attempt for dw.com / betano.bg.
const USE_OFFSCREEN_WHEN_FRAMEABLE = true;

// 'unknown' until the first off-screen attempt either answers or times out.
// sesame.bg sends no X-Frame-Options / frame-ancestors at all, so it is
// perfectly frameable, yet the off-screen frame never reported: the page does
// load, but nothing inside an extension-hosted frame runs our content script,
// so the READY/TEXT handshake cannot complete. One failed probe is enough to
// stop paying the timeout for the rest of the browser session.
let offscreenPathState = 'unknown';
let offscreenPathDisabledLogged = false;

function isFrameableUrl(url) {
  if (!USE_OFFSCREEN_WHEN_FRAMEABLE) return false;
  if (offscreenPathState === 'dead') return false;
  return framingSupportByUrl.get(url) === true;
}

async function renderInvisible(url) {
  if (isFrameableUrl(url)) {
    const viaFrame = await renderWithOffscreenFrame(url);
    if (viaFrame) return viaFrame;
  }

  if (USE_RENDER_TAB) {
    console.log(
      'NexusKitty [RENDER]: rendering in the worker tab for', url,
      isFrameableUrl(url) ? '(off-screen frame did not answer)' : '(site refuses framing)'
    );
    return performRenderedFetch(url);
  }

  console.log('NexusKitty [RENDER]: rendering unavailable for', url, '- not opening a tab');
  return { ok: false, text: '', reason: 'render_unavailable' };
}

/* =========================================================
   OFF-SCREEN FRAME (only for sites that allow being framed)
   ========================================================= */

const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
// Consent walls and CMP scripts are slow: 8s to mount, 9s to settle.
const OFFSCREEN_FRAME_READY_TIMEOUT_MS = 8000;
const OFFSCREEN_FRAME_TEXT_TIMEOUT_MS = 9000;
const RENDER_FRAME_PREFIX = 'nk-render-';

let offscreenDocumentReady = false;
let pendingRenderFrame = null; // { token, resolve, readyTimer, textTimer }

function clearPendingRenderFrame() {
  if (!pendingRenderFrame) return;
  clearTimeout(pendingRenderFrame.readyTimer);
  clearTimeout(pendingRenderFrame.textTimer);
  pendingRenderFrame = null;
}

async function ensureOffscreenDocument() {
  if (offscreenDocumentReady) return true;

  try {
    if (await chrome.offscreen.hasDocument()) {
      offscreenDocumentReady = true;
      return true;
    }
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ['IFRAME_SCRIPTING'],
      justification:
        'Render JavaScript-heavy legal pages off-screen so their text can be analyzed without ever opening a visible tab.',
    });
    offscreenDocumentReady = true;
    return true;
  } catch (error) {
    // "Only a single offscreen document may be created" means one already
    // exists, which is exactly the state we want.
    if (/single offscreen/i.test(error?.message || '')) {
      offscreenDocumentReady = true;
      return true;
    }
    console.log('NexusKitty [RENDER]: offscreen document unavailable', error?.message || error);
    return false;
  }
}

function renderWithOffscreenFrame(url) {
  return new Promise((resolve) => {
    const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    ensureOffscreenDocument().then((ready) => {
      if (!ready) {
        resolve(null);
        return;
      }

      clearPendingRenderFrame();
      const entry = { token, resolve, readyTimer: null, textTimer: null, frameLoaded: false };

      entry.readyTimer = setTimeout(() => {
        if (pendingRenderFrame !== entry) return;
        clearPendingRenderFrame();
        if (offscreenPathState !== 'works') {
          offscreenPathState = 'dead';
          if (!offscreenPathDisabledLogged) {
            offscreenPathDisabledLogged = true;
            console.log(
              'NexusKitty [RENDER]: the off-screen frame path does not work in this browser',
              entry.frameLoaded
                ? '(the frame loaded, but no content script ran inside it)'
                : '(the site refused the frame). Using the worker tab from now on.'
            );
          }
        }
        console.log('NexusKitty [RENDER]: off-screen frame never reported for', url, '| frameLoaded:', entry.frameLoaded);
        resolve(null);
      }, OFFSCREEN_FRAME_READY_TIMEOUT_MS);

      pendingRenderFrame = entry;
      if (offscreenPathState === 'unknown') offscreenPathState = 'probing';

      chrome.runtime.sendMessage({ type: 'NEXUSKITTY_OFFSCREEN_RENDER', url, token })
        .catch((error) => {
          console.log('NexusKitty [RENDER]: off-screen host unreachable', error?.message || error);
          if (pendingRenderFrame === entry) {
            clearPendingRenderFrame();
            resolve(null);
          }
        });
    });
  });
}

// READY arrives from the frame's content script; reply by asking that frame to
// hand over its rendered text.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;

  if (message.type === 'NEXUSKITTY_OFFSCREEN_FRAME_LOADED') {
    const entry = pendingRenderFrame;
    if (!entry || message.token !== entry.token) return false;
    // The frame element completed a navigation. If READY still does not arrive
    // within the timeout, the frame was reached but our content script did not
    // run inside it - which is a different problem from a site that refuses
    // framing, and the log now says so explicitly.
    entry.frameLoaded = true;
    console.log('NexusKitty [RENDER]: off-screen frame loaded', message.src, '- waiting for its content script');
    return false;
  }

  if (message.type === 'NEXUSKITTY_RENDER_FRAME_READY') {
    const entry = pendingRenderFrame;
    if (!entry || message.token !== entry.token) return false;

    entry.textTimer = setTimeout(() => {
      if (pendingRenderFrame !== entry) return;
      clearPendingRenderFrame();
      console.log('NexusKitty [RENDER]: off-screen frame produced no text');
      entry.resolve(null);
    }, OFFSCREEN_FRAME_TEXT_TIMEOUT_MS);

    chrome.runtime
      .sendMessage({ type: 'NEXUSKITTY_RENDER_FRAME_EXTRACT', token: entry.token })
      .catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'NEXUSKITTY_RENDER_FRAME_TEXT') {
    const entry = pendingRenderFrame;
    if (!entry || message.token !== entry.token) return false;

    clearPendingRenderFrame();
    const text = message.text || '';
    offscreenPathState = 'works';
    console.log(
      'NexusKitty [RENDER]: off-screen frame for', message.href || '(unknown url)',
      '| rendered chars:', text.length
    );

    if (!text) {
      entry.resolve(null);
      return true;
    }

    entry.resolve({
      ok: true,
      text,
      title: message.title || '',
      finalUrl: message.href || '',
      rendered: true,
      offscreen: true,
    });
    return true;
  }

  return false;
});

/* =========================================================
   TRANSLATION RELAY
   ========================================================= */

const TRANSLATE_TARGET_LANG = 'en';
const TRANSLATE_CHUNK_SIZE = 4500;
const TRANSLATE_TIMEOUT_MS = 8000;

// FIX: translate.googleapis.com is a GET endpoint, so the ENTIRE chunk travels
// in the `q=` query parameter. Percent-encoding expands Cyrillic ~6x, so a
// 4500-character Bulgarian chunk produces a ~27 kB URL and Google answers
// 400 Bad Request. The failure was silent (translateChunk just returned the
// original chunk), which is why the LLM kept receiving untranslated Bulgarian
// text. Bound the encoded length, not the character count.
const TRANSLATE_MAX_ENCODED_Q = 2800;
const TRANSLATE_MIN_CHUNK = 200;
const TRANSLATE_MAX_CHUNKS = 48;

// Chunks translated at the same time. 4 keeps a 14k-character document at
// roughly 4 round trips instead of 31 sequential ones.
const TRANSLATE_CONCURRENCY = 4;

// Total characters we are willing to translate for one document set. Google is
// called from a service worker, so an unbounded legal page would mean dozens of
// round trips; the budget is spent across ALL discovered documents, not spent on
// the first one alone.
const TRANSLATE_BUDGET_CHARS = 14000;

// Sections are the [SOURCE: url] blocks content.js builds. Every one of them
// gets its own share of the budget, because a two-document page (cookie policy
// + privacy declaration) used to send only the first document's opening, and the
// model then answered from a fragment.
const TRANSLATE_MIN_SECTION_CHARS = 900;
const SECTION_SEPARATOR = /-{3,}\s*NEXT LEGAL SECTION\s*-{3,}/i;

// How many evenly spaced slices a truncated section contributes. One (the
// beginning only) is what produced "some coincidence" answers; four covers the
// opening, the middle and the closing obligations, where consent, retention and
// liability clauses usually live.
const SECTION_SLICES = 4;

function sliceAtBoundary(text, start, length) {
  const end = Math.min(text.length, start + length);
  if (start <= 0) return text.slice(0, end);
  // Never start or end mid-word.
  let from = start;
  while (from < end && !/\s/.test(text[from])) from += 1;
  let to = end;
  while (to > from && !/\s/.test(text[to - 1])) to -= 1;
  return text.slice(from, Math.max(from, to));
}

function sampleSection(text, budget) {
  if (text.length <= budget) return text;
  const slices = SECTION_SLICES;
  const firstLength = Math.max(200, Math.floor(budget / slices));
  const rest = text.slice(firstLength);
  // The remaining slices share what is left of the budget; dividing the whole
  // budget by (slices - 1) would return 1.25x the requested size.
  const restLength = Math.max(200, Math.floor((budget - firstLength) / (slices - 1)));
  const parts = [sliceAtBoundary(text, 0, firstLength)];
  for (let i = 0; i < slices - 1; i += 1) {
    const offset = Math.floor((rest.length * i) / (slices - 1));
    parts.push(sliceAtBoundary(rest, offset, restLength));
  }
  return parts.join('\n[...]\n');
}

// Spend the budget over every discovered document proportionally, so a long
// privacy declaration cannot starve a short cookie policy and vice versa.
function buildTranslateBudget(text, budgetChars) {
  const source = String(text || '');
  if (source.length <= budgetChars) return source;

  // Split on the top-level section marker AND on each [SOURCE: ...] block, so
  // every discovered document gets its own share. content.js already sampled the
  // deep scan; the shares here simply never starve a document that is still
  // longer than its slice.
  const sections = source
    .split(/(?=-{3,}\s*NEXT LEGAL SECTION\s*-{3,})|(?=\[SOURCE:)/)
    .map((s) => s.replace(/-{3,}\s*NEXT LEGAL SECTION\s*-{3,}/g, '').trim())
    .filter(Boolean);
  if (sections.length <= 1) return sampleSection(source, budgetChars);

  const total = sections.reduce((sum, s) => sum + s.length, 0);
  const shares = sections.map((section) => Math.max(
    TRANSLATE_MIN_SECTION_CHARS,
    Math.floor((budgetChars * section.length) / total),
  ));

  // With many short sections the per-section minimum can exceed the budget;
  // scale the shares back down in that case instead of silently dropping text.
  const shareSum = shares.reduce((a, b) => a + b, 0);
  if (shareSum > budgetChars) {
    const factor = budgetChars / shareSum;
    for (let i = 0; i < shares.length; i += 1) {
      shares[i] = Math.max(200, Math.floor(shares[i] * factor));
    }
  }

  const sampled = sections.map((section, i) => sampleSection(section, shares[i]));
  console.log(
    'NexusKitty [TRANSLATE]: budget', budgetChars, 'chars spread over', sections.length,
    'documents (chars/share):', sections.map((s, i) => `${s.length}/${shares[i]}`).join(', ')
  );
  return sampled.join('\n\n');
}


// Pick the largest chunk whose percent-encoded form still fits the endpoint's
// real URL limit. Latin text encodes to ~1.3 bytes per char (spaces become
// %20), Cyrillic/Arabic/CJK to 6-9, so a fixed character size either breaks
// Bulgarian or wastes requests. The budget is on the ENCODED length, which is
// what Google actually rejects.
function pickTranslationChunkSize(text) {
  const sample = text.slice(0, 2000);
  if (!sample) return TRANSLATE_CHUNK_SIZE;

  let encoded = 0;
  for (const char of sample) {
    encoded += encodeURIComponent(char).length;
  }
  const ratio = encoded / sample.length;
  if (!Number.isFinite(ratio) || ratio <= 0) return TRANSLATE_CHUNK_SIZE;

  // +10% headroom for the ratio drifting on a different section of the text.
  const byEncodedBudget = Math.floor((TRANSLATE_MAX_ENCODED_Q * 0.9) / ratio);
  return Math.max(TRANSLATE_MIN_CHUNK, Math.min(TRANSLATE_CHUNK_SIZE, byEncodedBudget));
}

// Split on paragraph/sentence boundaries so a chunk never breaks a word
// mid-surrogate-pair or mid-sentence.
function splitIntoTranslationChunks(text, maxChars) {
  const size = Math.max(TRANSLATE_MIN_CHUNK, maxChars || TRANSLATE_CHUNK_SIZE);
  if (!text) return [];

  const paragraphs = String(text).split(/\n{2,}/);
  const chunks = [];
  let current = '';

  const pushCurrent = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };

  for (const paragraph of paragraphs) {
    const block = paragraph.trim();
    if (!block) continue;

    if (block.length > size) {
      pushCurrent();
      const sentences = block.split(/(?<=[.!?。！？\n])\s+/);
      for (const sentence of sentences) {
        if (!sentence) continue;
        if (current && current.length + sentence.length + 1 > size) pushCurrent();
        if (sentence.length > size) {
          // A single oversized sentence: hard-split on a code-point boundary.
          for (let i = 0; i < sentence.length; i += size) {
            chunks.push(sentence.slice(i, i + size));
          }
          continue;
        }
        current = current ? `${current} ${sentence}` : sentence;
      }
      pushCurrent();
      continue;
    }

    if (current && current.length + block.length + 2 > size) pushCurrent();
    current = current ? `${current}\n\n${block}` : block;
  }
  pushCurrent();

  return chunks;
}

// Per-chunk translation cache, keyed by the exact chunk text. The content
// script caches per frame, but several frames (and the worker tab's own copy)
// translate the same Bulgarian policy, and a 6000-character document costs 14
// sequential round trips each time. Google's answer for a given chunk is
// deterministic, so caching it in the worker is safe and removes the repeats.
const TRANSLATE_CHUNK_CACHE_TTL = 10 * 60 * 1000;
const TRANSLATE_CHUNK_CACHE_MAX = 500;
const translateChunkCache = new Map();
const translateChunkInFlight = new Map();

function rememberTranslation(key, value) {
  if (translateChunkCache.size >= TRANSLATE_CHUNK_CACHE_MAX) {
    const oldest = translateChunkCache.keys().next().value;
    translateChunkCache.delete(oldest);
  }
  translateChunkCache.set(key, { timestamp: Date.now(), value });
}

async function translateChunk(chunk, targetLang = TRANSLATE_TARGET_LANG, depth = 0) {
  const cacheable = depth === 0;
  const key = `${targetLang}|${chunk}`;

  if (cacheable) {
    const cached = translateChunkCache.get(key);
    if (cached && Date.now() - cached.timestamp < TRANSLATE_CHUNK_CACHE_TTL) {
      return cached.value;
    }
    const pending = translateChunkInFlight.get(key);
    if (pending) return pending;
  }

  const request = translateChunkRemote(chunk, targetLang, depth).then((value) => {
    if (cacheable) rememberTranslation(key, value);
    return value;
  }).finally(() => {
    if (cacheable) translateChunkInFlight.delete(key);
  });

  if (cacheable) translateChunkInFlight.set(key, request);
  return request;
}

async function translateChunkRemote(chunk, targetLang = TRANSLATE_TARGET_LANG, depth = 0) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TRANSLATE_TIMEOUT_MS);

  try {
    const url =
      'https://translate.googleapis.com/translate_a/single' +
      `?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(chunk)}`;

    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      // 400 means this chunk is still too long for the endpoint (its real
      // limit depends on the language's encoding, not on our estimate).
      // Halve it and retry rather than silently shipping untranslated text.
      if (response.status === 400 && chunk.length > TRANSLATE_MIN_CHUNK && depth < 6) {
        const mid = Math.floor(chunk.length / 2);
        const head = await translateChunk(chunk.slice(0, mid), targetLang, depth + 1);
        const tail = await translateChunk(chunk.slice(mid), targetLang, depth + 1);
        return {
          text: `${head.text} ${tail.text}`.trim(),
          detectedLang: head.detectedLang || tail.detectedLang,
          translated: head.translated || tail.translated,
        };
      }
      console.log('NexusKitty [TRANSLATE]: HTTP', response.status, 'for a', chunk.length, 'char chunk');
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

  // Spread the budget over every document instead of cutting at the first
  // 6000 characters, which used to hide the second legal document entirely.
  const budget = buildTranslateBudget(text, TRANSLATE_BUDGET_CHARS);
  const chunkSize = pickTranslationChunkSize(budget);
  const chunks = splitIntoTranslationChunks(budget, chunkSize).slice(0, TRANSLATE_MAX_CHUNKS);
  console.log(
    'NexusKitty [TRANSLATE]:', text.length, 'chars ->', budget.length,
    'in budget ->', chunks.length, 'chunks of up to', chunkSize, 'chars'
  );

  // Serial requests made a 14-chunk document take ~15s. Four in flight is well
  // inside the endpoint's tolerance and keeps the whole translation in ~4
  // round trips; results are re-ordered afterwards so the output is identical
  // to the sequential behaviour.
  const results = new Array(chunks.length);
  let cursor = 0;
  const workerCount = Math.min(TRANSLATE_CONCURRENCY, chunks.length);
  const runners = Array.from({ length: workerCount }, async () => {
    while (cursor < chunks.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await translateChunk(chunks[index], TRANSLATE_TARGET_LANG);
    }
  });
  await Promise.all(runners);

  let detectedLang = null;
  let anyTranslated = false;
  const translatedParts = [];
  for (const result of results) {
    if (!result) continue;
    translatedParts.push(result.text);
    if (!detectedLang && result.detectedLang) detectedLang = result.detectedLang;
    if (result.translated) anyTranslated = true;
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

// Substring matching on a URL is far too eager: "illegale-schatzsuche",
// "legalisierung" and "illegal-drugs" all contain "legal", and with
// MAX_DISCOVERED_URLS = 5 those false positives crowded out the actual privacy
// declaration. A slug counts as legal only when a whole token matches, or when
// a known multi-word phrase appears in it.
const LEGAL_SLUG_TOKENS = new Set([
  'terms', 'tos', 'conditions', 'privacy', 'cookie', 'cookies', 'imprint',
  'impressum', 'legal', 'disclaimer', 'consent', 'gdpr', 'agb',
  'datenschutz', 'datenschutzerklaerung', 'nutzungsbedingungen', 'einwilligung',
  'gebrauchsbedingungen', 'agb', 'mentions', 'confidentialite', 'politique',
  'politica', 'privacidad', 'privacidade', 'cgu', 'confidentiality',
  'notice', 'usloviya', 'uslovija', 'politika', 'pravila', 'pravila',
  'pouzitelnost', 'použitelnost', 'soglashie', 'soglasie', 'soglasiе',
  'правила', 'поверителност', 'бисквитки', 'съгласие', 'условия', 'политика',
  'декларация', 'данни', 'защита', 'пользовання', 'політика', 'згода',
]);

const LEGAL_SLUG_PHRASES = [
  'terms of use', 'terms of service', 'terms and conditions', 'terms & conditions',
  'privacy policy', 'privacy notice', 'cookie policy', 'cookie notice',
  'legal notice', 'legal disclaimer', 'user agreement', 'data protection',
  'general terms', 'acceptable use', 'allgemeine geschaeftsbedingungen',
  'allgemeine geschäftsbedingungen', 'nutzungsbedingungen', 'datenschutzerklaerung',
  'datenschutzerklärung', 'mentions legales', 'politique de confidentialite',
  'politique de confidentialité', 'confidentialite', 'proviso de privacidade',
  'условия за ползване', 'политика за поверителност', 'политика за бисквитки',
  'защита на лични данни', 'защита на данни', 'условия за използване',
];

// Score a URL as a legal document: 0 = not legal, higher = more specific.
function scoreLegalUrl(url) {
  let path = String(url || '');
  try {
    const parsed = new URL(path);
    path = `${parsed.pathname} ${parsed.search}`;
    path = decodeURIComponent(path);
  } catch (error) {
    path = path.replace(/[?#].*$/, '');
  }

  const lower = path.toLowerCase();
  let score = 0;

  for (const phrase of LEGAL_SLUG_PHRASES) {
    if (lower.includes(phrase)) score += 5;
  }

  const tokens = lower.split(/[^a-z0-9\u00c0-\u024f\u0400-\u04ff]+/).filter(Boolean);
  for (const token of tokens) {
    if (LEGAL_SLUG_TOKENS.has(token)) score += 4;
  }

  return score;
}

function isLegalUrl(url) {
  return scoreLegalUrl(url) > 0;
}

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
// One level of nested sitemaps is followed (sitemap index -> real URLs), which
// is what large multilingual sites like learngerman.dw.com use.
const MAX_NESTED_SITEMAPS = 6;

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

    // FIX: same charset reasoning as fetchLegalUrl - robots.txt / sitemap.xml
    // from older Cyrillic sites can be windows-1251 with no charset in the
    // Content-Type header.
    const contentType = response.headers.get('content-type') || '';
    const buffer = await response.arrayBuffer();
    return decodeWithCharset(buffer, contentType);
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

async function discoverViaSitemap(originUrl) {
  let origin;
  try {
    origin = new URL(originUrl).origin;
  } catch (error) {
    return [];
  }

  const robotsText = await fetchTextWithTimeout(`${origin}/robots.txt`);
  if (!robotsText) {
    return [];
  }

  const sitemapUrls = [...robotsText.matchAll(/^sitemap:\s*(\S+)/gim)]
    .map((match) => match[1])
    .slice(0, 2);

  // /de/..., /en/... - the language segment of the page being analysed, used to
  // prefer the matching nested sitemaps.
  const languagePrefix = (() => {
    try {
      const segments = new URL(originUrl).pathname.split('/').filter(Boolean);
      return segments.length && segments[0].length <= 5 ? `/${segments[0]}/` : null;
    } catch (error) {
      return null;
    }
  })();

  const nestedVisited = new Set();

  const found = [];

  // A sitemap is often an INDEX: learngerman.dw.com/sitemap.xml lists only
  // /de/article-sitemap.xml, /en/article-sitemap.xml, ... The real documents -
  // including the privacy declaration - live one level deeper, and the index
  // entries themselves contain no legal keyword, so a flat read found nothing
  // and the site looked like it had a single (settings-shell) document. Follow
  // one level, preferring sitemaps of the same language as the analysed page.
  const collectFromSitemap = async (sitemapUrl, depth) => {
    const sitemapXml = await fetchTextWithTimeout(sitemapUrl);
    if (!sitemapXml) return;

    const locUrls = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/gi)]
      .map((match) => match[1].trim());

    for (const locUrl of locUrls) {
      if (NON_HTML_ASSET_PATTERN.test(locUrl)) continue;

      const isNestedSitemap = /\.xml($|\?)/i.test(locUrl) && /sitemap/i.test(locUrl);
      if (isNestedSitemap) {
        if (depth >= 1) continue;
        if (nestedVisited.size >= MAX_NESTED_SITEMAPS) continue;
        // Same-language first: a German reader wants the German declaration,
        // not the Japanese one.
        if (languagePrefix && !locUrl.includes(languagePrefix) && nestedVisited.size > 0) continue;
        nestedVisited.add(locUrl);
        await collectFromSitemap(locUrl, depth + 1);
        continue;
      }

      if (isLegalUrl(locUrl)) {
        found.push(locUrl);
      }
      if (found.length >= MAX_DISCOVERED_URLS) return;
    }
  };

  for (const sitemapUrl of sitemapUrls) {
    if (found.length >= MAX_DISCOVERED_URLS) break;
    await collectFromSitemap(sitemapUrl, 0);
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
    const sitemapHits = await discoverViaSitemap(originUrl);
    if (sitemapHits.length) {
      console.log('NexusKitty [DISCOVERY]: sitemap yielded', sitemapHits.length, 'legal URL(s) for', origin);
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

  if (message && message.type === 'NEXUSKITTY_POPUP_LOG') {
    // The popup runs in its own context with its own devtools console, so a
    // failure there is invisible in the service worker log the user is already
    // watching. Mirroring the popup's progress here puts the whole run - tab,
    // extraction, request, response - in a single stream.
    console.log('NexusKitty [POPUP]:', message.stage, message.detail ?? '');
    sendResponse({ ok: true });
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

  // Second-chance fetch for pages whose text only exists after JavaScript runs.
  if (message && message.type === 'NEXUSKITTY_FETCH_RENDERED') {
    fetchRenderedUrl(message.url)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, text: '', error: error?.message || String(error) }));
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
