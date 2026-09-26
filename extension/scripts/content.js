function cleanText(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}
function stripJunkNoise(text) {
  if (!text) return '';
  let t = text;

  // FIX: generalized — previously hardcoded to "Issued to EXTRA DIGITAL
  // LIMITED ... IASME Consortium Ltd. ... Click for more info.", which
  // meant Cyber Essentials / IASME certification badges on ANY OTHER
  // company's site (different company name in the badge) were never
  // stripped, and that certificate/issuer text got sent to the LLM
  // instead of the real cookie banner / policy text.
  t = t.replace(/Issued to[\s\S]{0,150}?IASME Consortium Ltd\.?[\s\S]{0,400}?(Click for more info\.?)?/gi, ' ');
  t = t.replace(/Issued by (The )?IASME Consortium Ltd\.?/gi, ' ');
  t = t.replace(/Cyber Essentials.*?(badge|certificate|plus)?/gi, ' ');
  t = t.replace(/Issued to.*?\(.*?\)/gi, ' ');

  t = t.replace(/reCAPTCHA Enterprise quota limits[\s\S]{0,600}/gi, ' ');
  t = t.replace(/This site is exceeding reCAPTCHA[\s\S]{0,300}/gi, ' ');
  t = t.replace(/The provided text indicates a system message regarding reCAPTCHA[\s\S]{0,500}/gi, ' ');
  t = t.replace(/Recaptcha requires verification\.?/gi, ' ');
  t = t.replace(/protected by reCAPTCHA/gi, ' ');
  t = t.replace(/Click for more info\./gi, ' ');

  // FIX: added — other common trust-badge widgets that cause the exact
  // same failure mode (badge/certificate text mistaken for page content).
  t = t.replace(/Trustpilot.*?(reviews|excellent|rated)/gi, ' ');
  t = t.replace(/(Secured|Verified) by (Norton|McAfee|Sectigo|DigiCert|Comodo)[\s\S]{0,200}/gi, ' ');
  t = t.replace(/SSL Certificate[\s\S]{0,200}/gi, ' ');

  return t.replace(/\s+/g, ' ').trim();
}

// Per-document extraction cap. 9000 characters was cutting long privacy
// declarations (betano's is ~31k) before the translator even saw them, so the
// model reasoned about a fragment. The combined set is bounded separately by
// the translation budget, which now spreads itself across every document.
const MAX_TEXT_LENGTH = 20000;
const MAX_LEGAL_LINKS = 12;

// How the final analysis text is split between the three kinds of source. The
// deep scan gets the most because it holds the actual policy documents; the
// banner and the current page are supporting evidence.
const CONSENT_BANNER_CHARS = 4000;
const MAIN_DOC_CHARS = 6000;
const DEEP_SCAN_CHARS = 18000;
const COMBINED_TEXT_CAP = 30000;

// Take `budget` characters out of a multi-document text, spreading them over the
// [SOURCE: ...] blocks proportionally and sampling each block evenly (opening,
// middle, closing) instead of cutting a prefix. Documents about consent,
// retention and liability put their obligations in different halves, so a
// prefix-only cut is exactly the wrong sample.
function sampleSourcesProportionally(text, budget) {
  const source = String(text || '');
  if (source.length <= budget) return source;

  const blocks = source.split(/(?=\[SOURCE:)/).map((b) => b.trim()).filter(Boolean);
  if (blocks.length <= 1) return sampleEvenly(source, budget);

  const total = blocks.reduce((sum, b) => sum + b.length, 0);
  let shares = blocks.map((b) => Math.max(600, Math.floor((budget * b.length) / total)));
  const shareSum = shares.reduce((a, b) => a + b, 0);
  if (shareSum > budget) {
    const factor = budget / shareSum;
    shares = shares.map((s) => Math.max(200, Math.floor(s * factor)));
  }

  console.log(
    'NexusKitty [DIAG]: deep-scan budget', budget, 'over', blocks.length,
    'documents (chars/share):', blocks.map((b, i) => `${b.length}/${shares[i]}`).join(', ')
  );
  return blocks.map((b, i) => sampleEvenly(b, shares[i])).join('\n\n');
}

function sampleEvenly(text, budget) {
  if (!text || text.length <= budget) return text || '';
  const slices = 4;
  const first = Math.max(200, Math.floor(budget / slices));
  const rest = text.slice(first);
  // The remaining slices share what is left of the budget, otherwise the four
  // slices together return 1.25x the requested size.
  const restLength = Math.max(200, Math.floor((budget - first) / (slices - 1)));
  const parts = [text.slice(0, first)];
  for (let i = 0; i < slices - 1; i += 1) {
    const offset = Math.floor((rest.length * i) / (slices - 1));
    parts.push(rest.slice(offset, offset + restLength));
  }
  return parts.join('\n[...]\n');
}
const CACHE_TTL = 24 * 60 * 60 * 1000;
const HUD_UPDATE_DELAY = 350;
const BANNER_BUDGET = 3000;
const CACHE_PREFIX = 'nk_cache_v4_';
const DOMAIN_LEGAL_CACHE_PREFIX = 'nk_domain_legal_v1_';
const DOMAIN_LEGAL_CACHE_TTL = 24 * 60 * 60 * 1000;
const NO_CONTENT_FALLBACK_PREFIX = 'Legal analysis fallback for site: ';

// FIX: in-memory cache for individually fetched legal pages (privacy,
// terms, cookies, etc.). popup.js's polling loop calls
// NEXUSKITTY_GET_PAGE_DATA with force_refresh:true up to 6 times per
// popup open (every 350ms), and each of those calls used to trigger a
// brand-new extractMainText() pass which re-fetched the SAME legal URLs
// over the network from scratch every single time - that's what the
// duplicated "cookie / privacy-policy / winbet.bg / terms-of-use"
// requests in the Network tab were. The page content behind those URLs
// cannot realistically change within a couple of seconds, so we cache
// each successfully fetched legal page's cleaned text for a short TTL
// and reuse it on subsequent force_refresh passes within the same
// popup session.
const fetchedLegalPageCache = new Map();
const FETCHED_PAGE_CACHE_TTL = 20000; // 20s comfortably covers one popup session

// Why the last fetch of a given URL produced no usable text. Without this the
// caller cannot tell "the page is client-side rendered" (big HTML, empty body -
// nothing a fetch can fix) from "the server sent a PDF", "the server returned
// 403", or "the body was a JS bundle" - and a single message claiming
// "rendered by JavaScript" would be wrong in most of those cases.
const FETCH_REASON_HTTP = 'http_error';
const FETCH_REASON_CONTENT_TYPE = 'content_type';
const FETCH_REASON_QUOTA = 'quota_page';
const FETCH_REASON_JS_RENDERED = 'js_rendered';
const FETCH_REASON_THIN = 'too_thin';
const FETCH_REASON_SOURCE = 'source_code';
const fetchedPageFailureReasons = new Map();

// URLs for which we already paid the cost of opening an inactive tab to read
// the hydrated DOM. This is a TIMESTAMPED cooldown, not a permanent set: a
// permanent "never again" mark meant one transient failure (or one popup open
// before the user even saw the result) locked that URL out for the whole life
// of the content script, i.e. until a manual page reload. The cooldown is far
// longer than popup.js's ~2s polling window, so ticks still cannot spawn a tab
// storm, while a later popup open can retry.
const RENDER_RETRY_COOLDOWN_MS = 90000;
const renderedFetchAttemptedAt = new Map();
// Rendered text is stable (it is a policy document, not live page state) and
// expensive to re-acquire, so it outlives the 20s static-fetch cache. It must
// stay longer than RENDER_RETRY_COOLDOWN_MS, otherwise the two limits open a
// gap where the result is neither cached nor re-obtainable.
const RENDERED_PAGE_CACHE_TTL = 5 * 60 * 1000;

// FIX: extractMainText() ends with a last-resort fallback that returns the
// RAW text of whatever page the user happens to be on. On a non-legal page
// whose linked policy could not be extracted (e.g. a client-side-rendered
// consent-settings page whose static HTML is just a loading template), that
// silently ships the surrounding marketing copy to the LLM, which then
// "analyzes" an ad and reports 0 findings. Track whether the last pass
// degraded to that fallback so the popup can warn instead of pretending the
// analysis is about the policy.
let lastExtractionUsedSurroundingPage = false;

// FIX: set when legal URLs were discovered but every fetched body was empty,
// which almost always means the policy text is client-side rendered (CSR).
// A plain fetch() from the service worker cannot execute JS, so the real
// text is unreachable from the background context; the popup uses this flag
// to explain that instead of showing a false "0 issues" result.
let lastExtractionJsRenderedSuspect = false;

// FIX: same problem existed for translateTextToEnglish() — it had NO
// caching at all, so every one of popup.js's up-to-6 force_refresh polling
// ticks re-translated the same extracted text from scratch via the
// Google Translate endpoint (chrome.runtime -> NEXUSKITTY_TRANSLATE_TEXT
// -> the "single?client=gtx&sl=auto&tl=en..." requests visible in the
// Network tab). Give it the same short-TTL, signature-keyed cache the
// legal-page fetcher already uses, so repeated polling ticks against the
// same extracted text reuse the previous translation instead of hitting
// the network again.
const translationCache = new Map();
const TRANSLATION_CACHE_TTL = 20000; // matches FETCHED_PAGE_CACHE_TTL

// FIX: moved out of extractMainText() (where it was a local closure) to
// module scope so it can be shared by translateTextToEnglish()'s cache
// key as well, instead of duplicating the same hashing logic twice.
function textSignature(text) {
  if (!text) return '';
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  let hash = 0;
  for (let i = 0; i < normalized.length; i += 1) hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}

const LEGAL_URL_KEYWORDS = [
  'terms', 'conditions', 'privacy', 'cookie', 'policy', 'legal', 'gdpr',
  'datenschutz', 'einwilligung', 'nutzungs', 'politique', 'consentement',
  'privacidad', 'consentimiento', 'condiciones', 'privacidade', 'consentimento', 'condições',
  'правила', 'поверителност', 'бисквитки', 'съгласие', 'лични данни', 'декларация', 'защита на данни',
  'условия за ползване', 'политика за', 'правила', 'политика', 'согласие', 'політика', 'згода',
  'kişisel', 'çerez', 'onay', 'şartları', 'سياسة', 'خصوصية', 'موافقة', 'プライバシー', '同意', '利用規約',
  '개인정보', '동의', '이용', '隐私', '同意', '使用条款', 'गोपनीयता', 'सहमति', 'ความเป็น', 'การยินยอม',
  'פרטיות', 'הסכם', 'προσωπικά', 'συγκατάθεση', 'prywatność', 'ciasteczka', 'zgoda', 'osobní', 'souhlas', 'podmínky',
];
const LEGAL_PAGE_REGEX = new RegExp(LEGAL_URL_KEYWORDS.join('|'), 'i');
const LEGAL_URL_REGEX = new RegExp(LEGAL_URL_KEYWORDS.join('|'), 'i');
const DEDICATED_LEGAL_URL_KEYWORDS = [
  'privacy', 'terms', 'conditions', 'cookie-policy', 'cookie_policy', 'legal', 'gdpr', 'tos',
  'obshti-usloviya', 'polzovatelsko-soglashenie', 'usloviya-polzovaniya', 'politika-konfidentsialnosti',
  'privacy-policy', 'terms-of-service', 'terms-of-use', 'data-protection', 'data_policy', 'legal-notice',
  'impressum', 'aviso-legal', 'mentions-legales', 'datenschutz', 'nutzungsbedingungen',
  'allgemeine-geschaeftsbedingungen', 'cookies', 'consent', 'user-agreement', 'service-terms',
  'declaration-personal-data', 'personal-data', 'declaration',
];
const BG_LATIN_TO_CYRILLIC_MAP = [
  ['shch', 'щ'], ['sht', 'щ'], ['yu', 'ю'], ['ya', 'я'], ['zh', 'ж'], ['ch', 'ч'], ['sh', 'ш'],
  ['ts', 'ц'], ['ye', 'е'], ['yo', 'ьо'], ['kh', 'х'], ['dzh', 'дж'], ['a', 'а'], ['b', 'б'],
  ['v', 'в'], ['g', 'г'], ['d', 'д'], ['e', 'е'], ['z', 'з'], ['i', 'и'], ['j', 'й'], ['y', 'ъ'],
  ['k', 'к'], ['l', 'л'], ['m', 'м'], ['n', 'н'], ['o', 'о'], ['p', 'п'], ['r', 'р'], ['s', 'с'],
  ['t', 'т'], ['u', 'у'], ['f', 'ф'], ['h', 'х'], ['c', 'ц'], ['q', 'к'], ['w', 'в'], ['x', 'кс'],
];
function transliterateLatinToCyrillicBG(text) {
  if (!text) return '';
  const lower = text.toLowerCase();
  let result = ''; let i = 0;
  outer: while (i < lower.length) {
    for (const [latin, cyrillic] of BG_LATIN_TO_CYRILLIC_MAP) {
      if (lower.startsWith(latin, i)) { result += cyrillic; i += latin.length; continue outer; }
    }
    result += lower[i]; i += 1;
  }
  return result;
}

/* EDGE ADAPTERS - Cookiebot, CookieYes, Quantcast */
const COOKIEBOT_SELECTORS = [
  '#CybotCookiebotDialog', '#CybotCookiebotDialogBodyEdge', '#CybotCookiebotDialogBodyEdgeMoreDetails',
  '#CybotCookiebotDialogBodyLevelWrapper', '#CookiebotWidget', '[id*="CybotCookiebot" i]',
  '[class*="CybotCookiebot" i]', '[id*="Cookiebot" i]', '[class*="Cookiebot" i]'
];
const COOKIEYES_SELECTORS = [
  '.cky-notice', '.cky-consent-container', '#cky-consent', '.cky-detail',
  '[id*="cky" i]', '[class*="cky-" i]'
];
const QUANTCAST_SELECTORS = [
  '.qc-cmp2-container', '.qc-cmp2-summary', '#qc-cmp2-container', '#qc-cmp2-main',
  '[id*="qc-cmp" i]', '[class*="qc-cmp" i]', '[class*="sp_choice_type" i]', '.sp_choice_type_11'
];

function findCookiebotRoot() {
  for (const s of COOKIEBOT_SELECTORS) { const n = document.querySelector(s); if (n) return n; }
  return null;
}
function isCookiebotDetected() {
  return !!(window.Cookiebot || window.CybotCookiebot || findCookiebotRoot() || document.querySelector('script[src*="cookiebot" i]'));
}
function isCookieYesDetected() {
  return !!document.querySelector(COOKIEYES_SELECTORS.join(','));
}
function isQuantcastDetected() {
  return !!document.querySelector(QUANTCAST_SELECTORS.join(',')) ||
       !!document.querySelector('iframe[src*="quantcast" i], iframe[src*="consensu.org" i], iframe[src*="quantserve" i]');
}

function getDeepTextNoVisibility(root) {
  if (!root) return '';
  const visited = new WeakSet(); const pieces = [];
  function walk(node) {
    if (!node || visited.has(node)) return;
    visited.add(node);
    if (node.nodeType === Node.TEXT_NODE) { const t = node.textContent?.trim(); if (t) pieces.push(t); return; }
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
    const tag = node.tagName ? node.tagName.toLowerCase() : '';
    if (['script', 'style', 'noscript', 'svg', 'template'].includes(tag)) return;
    for (const child of node.childNodes) walk(child);
    if (node.shadowRoot) walk(node.shadowRoot);
    if (tag === 'iframe') { try { if (node.contentDocument?.body) walk(node.contentDocument.body); } catch (e) {} }
  }
  walk(root);
  return stripJunkNoise(cleanText(pieces.join(' ')));
}
function extractCookiebotGlobalData() {
  let text = ''; let declaration = null;
  try {
    const cb = window.Cookiebot || window.CybotCookiebot;
    if (!cb) return { text: '', declaration };
    declaration = cb.decl || null;
    if (declaration) text += '\n[Cookiebot Declaration]\n' + JSON.stringify(declaration, null, 2);
    for (const key of ['consent', 'consents', 'consentState', 'categories']) {
      try { if (cb[key] !== undefined && typeof cb[key] !== 'function') text += `\n[Cookiebot ${key}]\n` + JSON.stringify(cb[key], null, 2); } catch (e) {}
    }
  } catch (e) {}
  return { text, declaration };
}
function extractCookiebotDomText() {
  let combined = '';
  const nodes = document.querySelectorAll(COOKIEBOT_SELECTORS.join(','));
  for (const node of nodes) {
    const deep = getDeepTextNoVisibility(node);
    if (deep.length > 30 && !combined.includes(deep.slice(0, 50))) combined += '\n\n[Cookiebot DOM]\n' + deep;
  }
  return combined;
}
function extractCookieYesDeepText() {
  let combined = '';
  try {
    const roots = document.querySelectorAll('.cky-consent-container,.cky-notice,#cky-consent,.cky-detail,.cky-preference');
    for (const root of roots) {
      const deep = getDeepTextNoVisibility(root);
      if (deep.length > 40 && !combined.includes(deep.slice(0, 50))) combined += '\n\n[CookieYes]\n' + deep;
    }
  } catch (e) {}
  return combined;
}
function extractQuantcastDeepText() {
  let combined = '';
  try {
    const roots = document.querySelectorAll(QUANTCAST_SELECTORS.join(','));
    for (const root of roots) {
      const deep = getDeepTextNoVisibility(root);
      if (deep.length > 50 && !combined.includes(deep.slice(0, 50))) combined += '\n\n[Quantcast]\n' + deep;
    }
    if (receivedIframeConsentText && receivedIframeConsentText.length > 100) {
      const cleaned = stripJunkNoise(receivedIframeConsentText);
      if (cleaned.length > 100 && !combined.includes(cleaned.slice(0, 50))) {
        combined += '\n\n[Quantcast Iframe Relay]\n' + cleaned;
      }
    }
  } catch (e) {}
  return combined;
}
async function extractCookiebotIframeText() {
  const iframes = Array.from(document.querySelectorAll('iframe[src]')).filter(i => /cookiebot|cybot|consentcdn\.cookiebot\.eu/i.test(i.src || ''));
  if (!iframes.length) return '';
  const results = await Promise.all(iframes.map(async f => { try { return await fetchIframeConsentText(f.src); } catch { return ''; } }));
  return results.filter(t => t && t.length > 50).join('\n\n--- COOKIEBOT IFRAME ---\n\n');
}
async function extractCookiebotEdgeCase() {
  const result = { detected: false, source: [], text: '', declaration: null };
  try {
    if (!isCookiebotDetected()) return result;
    result.detected = true;
    const globalData = extractCookiebotGlobalData();
    if (globalData.text) { result.source.push('window.Cookiebot'); result.text += globalData.text; result.declaration = globalData.declaration; }
    const domText = extractCookiebotDomText();
    if (domText.length > 20) { result.source.push('DOM'); result.text += domText; }
    const iframeText = await extractCookiebotIframeText();
    if (iframeText.length > 50) { result.source.push('iframe'); result.text += '\n\n[Cookiebot Iframe]\n' + iframeText; }
  } catch (e) {}
  result.text = stripJunkNoise(cleanText(result.text)).slice(0, MAX_TEXT_LENGTH);
  return result;
}
async function extractCookieYesEdgeCase() {
  if (!isCookieYesDetected()) return { detected: false, text: '' };
  let text = extractCookieYesDeepText();
  return { detected: true, source: ['CookieYes'], text: stripJunkNoise(cleanText(text)).slice(0, MAX_TEXT_LENGTH) };
}
async function extractQuantcastEdgeCase() {
  if (!isQuantcastDetected()) return { detected: false, text: '' };
  let text = extractQuantcastDeepText();
  return { detected: true, source: ['Quantcast'], text: stripJunkNoise(cleanText(text)).slice(0, MAX_TEXT_LENGTH) };
}

const CMP_OVERLAY_SELECTORS = [
  '[id*="onetrust" i]', '[class*="onetrust" i]', '[id*="didomi" i]', '[class*="didomi" i]',
  '[id*="cookielaw" i]', '[class*="cookielaw" i]', '[id*="cmp" i]', '[class*="cmp" i]',
  '[id*="trustarc" i]', '[class*="trustarc" i]', '[id*="evidon" i]', '[class*="evidon" i]',
  '[id*="quantcast" i]', '[class*="quantcast" i]', '[id*="cybot" i]', '[class*="cybot" i]',
  '[id*="usercentrics" i]', '[class*="usercentrics" i]', '[id*="sp_message" i]', '[class*="sp_message" i]',
  '[id*="iubenda" i]', '[class*="iubenda" i]', '[id*="termly" i]', '[class*="termly" i]',
  '[id*="cookie-script" i]', '[class*="cookie-script" i]', '[id*="axeptio" i]', '[class*="axeptio" i]',
  '[id*="fg-modal" i]', '[class*="fg-modal" i]', '[id*="cookie-banner" i]', '[class*="cookie-banner" i]',
  '[id*="consent-banner" i]', '[class*="consent-banner" i]', '[id*="cookie-wall" i]', '[class*="cookie-wall" i]',
  '[id*="modal-overlay" i]', '[class*="modal-overlay" i]', '[id*="lightbox" i]', '[class*="lightbox" i]',
  '[id*="backdrop" i]', '[class*="backdrop" i]', '[id*="flyout" i]', '[class*="flyout" i]',
  '[id*="drawer" i]', '[class*="drawer" i]', '[id*="interstitial" i]', '[class*="interstitial" i]',
  '[id*="takeover" i]', '[class*="takeover" i]', '[id*="sheet" i]', '[class*="sheet" i]',
  '[class*="overlay" i]', '[class*="modal" i]', '[class*="dialog" i]', '[class*="popup" i]',
  '[id*="modal" i]', '[id*="dialog" i]', '[id*="popup" i]', '[class*="notice" i]', '[id*="notice" i]',
  '[class*="alert" i]', '[id*="alert" i]', '[class*="disclaimer" i]', '[id*="disclaimer" i]',
  '[class*="banner" i]', '[id*="banner" i]', '[class*="sticky-footer" i]', '[id*="sticky-footer" i]',
  '[class*="bottom-bar" i]', '[id*="bottom-bar" i]', '[class*="privacy-prompt" i]', '[id*="privacy-prompt" i]',
  '[class*="gdpr-modal" i]', '[id*="gdpr-modal" i]', '[class*="consent-wall" i]', '[id*="consent-wall" i]',
  '[class*="tos-popup" i]', '[id*="tos-popup" i]', '[class*="terms-modal" i]', '[id*="terms-modal" i]',
  '[data-testid*="cookie" i]', '[data-testid*="consent" i]', '#uc-main-dialog', '#cookiescript_injected', '.cmp.gdpr',
];
const CMP_OVERLAY_SELECTOR_STRING = CMP_OVERLAY_SELECTORS.join(', ');
function isTechnicalCmpIframe() {
  const href = window.location.href.toLowerCase();
  const host = window.location.hostname.toLowerCase();
if (getRenderFrameToken()) {
  // Render target inside the off-screen host: it only has to answer the
  // extract request. Skipping the normal init keeps the frame from doing a
  // full page extraction, writing to storage, or relaying consent text.
  console.log('[NEXUSKITTY] Off-screen render frame ready', location.href);
} else if (window.self !== window.top) {
    if (/consentcdn\.cookiebot\.eu|blockmarktech\.com|iasme|trusted-shops/i.test(href)) return true;
    if (/recaptcha/i.test(href) && !/consensu|quantcast|cmp/i.test(href)) return true;
    if (host.includes('recaptcha') || host.includes('blockmarktech')) return true;
  }
  return false;
}
function isVisible(node) {
  if (!node) return false; let element = node;
  if (element.nodeType === Node.TEXT_NODE) element = element.parentElement;
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
  if (!element.isConnected) return false;
  if (element.hasAttribute && element.hasAttribute('hidden')) return false;
  let style; try { style = window.getComputedStyle(element); } catch (e) { return true; }
  if (!style) return true;
  if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  if (parseFloat(style.opacity) === 0) return false;
  try { const rect = element.getBoundingClientRect(); if (rect.width === 0 && rect.height === 0 && element.getClientRects().length === 0) return false; } catch (e) {}
  return true;
}
function getNodeText(node) {
  if (!node) return '';
  if (node.nodeType === Node.TEXT_NODE) return stripJunkNoise(cleanText(node.textContent));
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  if (typeof node.innerText === 'string' && node.innerText.trim().length > 0) return stripJunkNoise(cleanText(node.innerText));
  // FIX: innerText is empty for hidden consent widgets, so this path used
  // node.textContent - which INCLUDES <script> bodies. That is how a Gemius/
  // CMP tracking snippet (localStorage.gstorage, msgreceiver, postMessage,
  // ...) leaked into the "consent text" and was shipped to the LLM as if it
  // were a policy clause. Strip the non-prose tags on a detached clone, but
  // only when the subtree actually contains one (getConsentContainers() runs
  // this over every matching node, so the clone must stay conditional).
  let source = node;
  try {
    if (node.querySelector('script, style, noscript, template, svg')) {
      source = node.cloneNode(true);
      source.querySelectorAll('script, style, noscript, template, svg').forEach((el) => el.remove());
    }
  } catch (e) {
    source = node;
  }
  return stripJunkNoise(cleanText(source.textContent || ''));
}
function getTextExcludingOverlays(root) {
  if (!root) return '';
  const pieces = [];
  function walk(node) {
    if (!node) return;
    if (node.nodeType === Node.TEXT_NODE) { if (node.textContent) pieces.push(node.textContent); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName ? node.tagName.toLowerCase() : '';
    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'svg') return;
    try { if (node.matches && node.matches(CMP_OVERLAY_SELECTOR_STRING)) return; } catch (e) {}
    for (const child of node.childNodes) walk(child);
  }
  walk(root);
  return stripJunkNoise(cleanText(pieces.join(' ')));
}
function getCmpGlobalData() {
  let extraText = '';
  if (window.Cookiebot && window.Cookiebot.decl) { try { extraText += '\n[Cookiebot Declaration]\n' + JSON.stringify(window.Cookiebot.decl, null, 2); } catch (e) {} }
  return stripJunkNoise(extraText.slice(0, 5000));
}
function getDeepText(node, visited = new WeakSet()) {
  if (!node) return ''; if (visited.has(node)) return ''; visited.add(node);
  let text = '';
  if (node.nodeType === Node.TEXT_NODE) return stripJunkNoise(cleanText(node.textContent));
  if (node.nodeType === Node.ELEMENT_NODE) {
    const tag = node.tagName.toLowerCase();
    if (['script', 'style', 'noscript'].includes(tag)) return '';
    try { if (node.matches && node.matches(CMP_OVERLAY_SELECTOR_STRING)) return ''; } catch (e) {}
    if (node.shadowRoot) text += ' ' + getDeepText(node.shadowRoot, visited);
    for (const child of node.childNodes) text += ' ' + getDeepText(child, visited);
    if (tag === 'iframe') { try { if (node.contentDocument && node.contentDocument.body) text += ' ' + getDeepText(node.contentDocument.body, visited); } catch (e) {} }
  }
  return stripJunkNoise(text);
}
function getMainDocumentText() {
  const selectors = ['main', 'article', '[role="main"]', '.terms', '.privacy-policy', '.terms-of-service', '.cookie-policy', '#content', '.content'];
  let bestText = '';
  for (const selector of selectors) {
    const node = document.querySelector(selector);
    if (!node || !isVisible(node)) continue;
    const text = getTextExcludingOverlays(node);
    if (text.length >= 400 && text.length > bestText.length) bestText = text;
  }
  const deepBodyText = getDeepText(document.body);
  if (deepBodyText.length > bestText.length) bestText = deepBodyText;
  return stripJunkNoise(bestText.slice(0, MAX_TEXT_LENGTH));
}
const CONSENT_SELECTORS = [
  '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]', 'dialog[open]',
  '[id*="cookie" i]', '[class*="cookie" i]', '[id*="consent" i]', '[class*="consent" i]',
  '[id*="fg-modal" i]', '[class*="fg-modal" i]', '[id*="trustarc" i]', '[class*="trustarc" i]',
  '[id*="evidon" i]', '[class*="evidon" i]', '[id*="quantcast" i]', '[class*="quantcast" i]',
  '[id*="cybot" i]', '[class*="cybot" i]', '[id*="usercentrics" i]', '[class*="usercentrics" i]',
  '[id*="sp_message" i]', '[class*="sp_message" i]', '[id*="iubenda" i]', '[class*="iubenda" i]',
  '[id*="termly" i]', '[class*="termly" i]', '[id*="cookie-script" i]', '[class*="cookie-script" i]',
  '[id*="axeptio" i]', '[class*="axeptio" i]', '[id*="privacy" i]', '[class*="privacy" i]',
  '[id*="terms" i]', '[class*="terms" i]', '[id*="policy" i]', '[class*="policy" i]',
  '[id*="cky" i]', '[class*="cky" i]', '[id*="qc-cmp" i]', '[class*="qc-cmp" i]',
  '[id*="privacy-prompt" i]', '[class*="privacy-prompt" i]', '[id*="gdpr-modal" i]', '[class*="gdpr-modal" i]',
  '[id*="consent-wall" i]', '[class*="consent-wall" i]', '[id*="modal" i]', '[class*="modal" i]',
  '[id*="dialog" i]', '[class*="dialog" i]', '[id*="popup" i]', '[class*="popup" i]',
  '[id*="banner" i]', '[class*="banner" i]', '#uc-main-dialog', '#cookiescript_injected', '.cmp.gdpr',
];
function getActionNodes(node) { if (!node) return []; return Array.from(node.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"]')); }
function isSemanticNonConsentLandmark(node) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
  const role = (node.getAttribute('role') || '').toLowerCase();
  if (['banner', 'navigation', 'main', 'contentinfo'].includes(role)) return true;
  const tag = node.tagName ? node.tagName.toLowerCase() : '';
  return ['header', 'nav', 'footer', 'main'].includes(tag);
}
function hasStrongConsentSignal(text) {
  if (!text) return false;
  const markerPattern = /(cookie|consent|gdpr|privacy policy|personal data|third[- ]party|advertising partner|similar technolog|tracking|manage cookies|cookie settings|accept all|reject all|allow all|essential cookies|store and\/or access information|we and our partners|precise geolocation)/gi;
  const hits = text.match(markerPattern) || [];
  return hits.length >= 2;
}
function isConsentContainer(node) {
  if (!isVisible(node)) return false;
  if (isSemanticNonConsentLandmark(node)) return false;
  const nodeId = (node.id || '').toLowerCase();
  const nodeClass = typeof node.className === 'string' ? node.className.toLowerCase() : '';
  if (nodeId === 'uc-main-dialog' || nodeId === 'cookiescript_injected' || nodeClass.includes('cmp gdpr')) return true;
  const text = getNodeText(node);
  if (text.length < 30) return false;
  const style = window.getComputedStyle(node);
  const isLayer = style.position === 'fixed' || style.position === 'sticky' || style.position === 'absolute';
  const isDialog = node.getAttribute('role') === 'dialog' || node.getAttribute('aria-modal') === 'true';
  const actions = getActionNodes(node);
  if (!actions.length) return false;
  const hasCheckbox = Boolean(node.querySelector('input[type="checkbox"]'));
  const hasLink = Boolean(node.querySelector('a[href]'));
  const hasConsentAttribute = Array.from(node.attributes).some((attribute) => /(cookie|consent|privacy|terms|legal|policy|banner|popup|notice)/i.test(`${attribute.name}=${attribute.value}`));
  return (isDialog || hasConsentAttribute || (isLayer && (hasCheckbox || hasLink || actions.length <= 6)));
}
function getConsentContainers() {
  const nodes = new Set();
  for (const selector of CONSENT_SELECTORS) { document.querySelectorAll(selector).forEach((node) => nodes.add(node)); }
  const candidates = Array.from(nodes).filter((node) => isConsentContainer(node));
  const result = [];
  for (let i = 0; i < candidates.length; i += 1) {
    let isDescendant = false;
    for (let j = 0; j < candidates.length; j += 1) { if (i === j) continue; if (candidates[j].contains(candidates[i])) { isDescendant = true; break; } }
    if (!isDescendant) result.push(candidates[i]);
  }
  return result.map((node) => ({ node, text: getNodeText(node) })).sort((left, right) => left.text.length - right.text.length);
}
function findConsentContainersInNode(rootNode) {
  if (!rootNode || rootNode.nodeType !== Node.ELEMENT_NODE) return [];
  const results = new Set(); const selector = CONSENT_SELECTORS.join(',');
  if (rootNode.matches?.(selector)) results.add(rootNode);
  rootNode.querySelectorAll?.(selector).forEach((node) => results.add(node));
  const candidates = Array.from(results).filter((node) => isConsentContainer(node));
  const filtered = [];
  for (let i = 0; i < candidates.length; i += 1) {
    let isDescendant = false;
    for (let j = 0; j < candidates.length; j += 1) { if (i === j) continue; if (candidates[j].contains(candidates[i])) { isDescendant = true; break; } }
    if (!isDescendant) filtered.push(candidates[i]);
  }
  return filtered;
}
function detectLegalPageSignals() {
  const headingText = Array.from(document.querySelectorAll('h1, h2')).slice(0, 5).map((heading) => getNodeText(heading)).join(' ');
  const urlKeywordMatch = DEDICATED_LEGAL_URL_KEYWORDS.some((kw) => window.location.href.toLowerCase().includes(kw));
  const transliteratedUrl = transliterateLatinToCyrillicBG(window.location.href);
  const urlTransliteratedMatch = LEGAL_URL_REGEX.test(transliteratedUrl);
  const headingKeywordMatch = LEGAL_PAGE_REGEX.test(`${document.title} ${headingText}`);
  return { isLegalPage: urlKeywordMatch || urlTransliteratedMatch || headingKeywordMatch, urlKeywordMatch, urlTransliteratedMatch, transliteratedUrl, headingKeywordMatch, headingText };
}
function hasLegalSurface() {
  if (detectLegalPageSignals().isLegalPage) return true;
  if (LEGAL_URL_REGEX.test(window.location.href)) return true;
  return getConsentContainers().length > 0;
}
// Tracking parameters that ride along on every link of a shop or a campaign.
// They never change the document, but they multiply cache entries and make the
// render tab request absurdly long URLs (yami.com alone appends 9 of them).
const TRACKING_PARAM_RE = /^(utm_|ga_|gclid|fbclid|msclkid|yclid|ttclid|igshid|mc_|_ga|ref|referer|referrer|aff|affiliate|track|tracking|scene|module|module_name|content|pg|index|rank|rank_id|bu_type|spm|spm_id|from|from_?page|share|share_id|source|src|sessionid|session_id|sid|click(_?id)?|cmp|campaign|ad(_?id)?|at_medium|at_campaign|at_custom\d|wt_mc|piwik|cid|trk|trkCampaign|scm|sc_campaign|sc_channel|sc_content|sc_medium)$/i;
function normalizeLegalUrl(url) {
  try {
    const parsed = new URL(url); parsed.hash = '';
    let path = parsed.pathname; if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    parsed.pathname = path;
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAM_RE.test(key)) parsed.searchParams.delete(key);
    }
    return parsed.origin + parsed.pathname + parsed.search;
  } catch { return url.split('#')[0].replace(/\/$/, ''); }
}
async function readDomainLegalCache(origin) {
  try {
    const key = DOMAIN_LEGAL_CACHE_PREFIX + origin;
    const result = await chrome.storage.local.get(key);
    const cached = result[key];
    if (cached && typeof cached.timestamp === 'number' && Date.now() - cached.timestamp < DOMAIN_LEGAL_CACHE_TTL && Array.isArray(cached.urls)) return cached.urls;
  } catch (error) {}
  return null;
}
async function writeDomainLegalCache(origin, urls) {
  try { const key = DOMAIN_LEGAL_CACHE_PREFIX + origin; await chrome.storage.local.set({ [key]: { timestamp: Date.now(), urls } }); } catch (error) {}
}
// FIX: chrome.storage.local-backed readDomainLegalCache/writeDomainLegalCache
// was supposed to stop discoverDomainLegalLinks() from re-crawling the
// domain's homepage + legal pages on every force_refresh call, but on
// sites where the on-disk cache read is slow, races, or misses for any
// reason (redirect chains changing window.location.origin between calls,
// storage write not yet flushed, etc.), every miss falls straight back to
// a REAL network crawl via background.js - which is exactly the endless
// "winbet.bg / cookie / privacy-policy / terms-of-use" loop seen in the
// Network tab. Add a same-page-load, in-memory backstop that is NOT
// subject to any of those failure modes: once this content script
// instance has discovered (or failed to discover) legal links for the
// current origin, never ask background.js again for the rest of this
// page load, no matter what chrome.storage does.
let sessionDiscoveredLegalLinks = null; // { origin, urls } | null

async function discoverDomainLegalLinks() {
  const origin = window.location.origin;

  if (sessionDiscoveredLegalLinks && sessionDiscoveredLegalLinks.origin === origin) {
    return sessionDiscoveredLegalLinks.urls;
  }

  const cached = await readDomainLegalCache(origin);
  if (cached !== null) {
    sessionDiscoveredLegalLinks = { origin, urls: cached };
    return cached;
  }
  try {
    const response = await chrome.runtime.sendMessage({ type: 'NEXUSKITTY_DISCOVER_LEGAL_URLS', origin });
    const urls = response?.ok && Array.isArray(response.urls) ? response.urls : [];
    await writeDomainLegalCache(origin, urls);
    sessionDiscoveredLegalLinks = { origin, urls };
    return urls;
  } catch (error) {
    // FIX: cache the failure too (empty result) for this page load, so a
    // persistently failing background.js call doesn't get retried on
    // every single force_refresh tick either.
    sessionDiscoveredLegalLinks = { origin, urls: [] };
    return [];
  }
}
// Shops bury legal-looking words in product names. A yami.com bestseller is
// "/us/en/p/thin-and-crispy-sandwich-cookies-rich-black-sesame-flavor/...":
// "cookies" in the middle of the slug used to score +10 for the cookie rule and
// every one of those product pages was then fetched, rendered and translated.
// So the href is scored from its LAST NON-NUMERIC path segment only, which is
// where policies keep their name: /statiya/pravila-i-usloviya/339282/ is scored
// from "pravila-i-usloviya", not from the article id. The visible link text is
// still trusted, because a link labelled "Privacy policy" is one whatever it
// points at.
function hrefTailSegment(href) {
  try {
    const segments = new URL(href).pathname.split('/').filter(Boolean);
    const meaningful = [...segments].reverse().find((segment) => !/^\d[\w-]*$/i.test(segment));
    return (meaningful || segments[segments.length - 1] || '').toLowerCase();
  } catch { return ''; }
}
// Commerce and catalogue URLs are never policy documents, whatever they contain.
// The segments are checked as whole path segments, so "/statiya/pravila-i-usloviya/"
// is unaffected while "/us/en/p/thin-and-crispy-.../1016533491" is vetoed by "/p/".
// The veto is applied by the scorer only when nothing legal was recognised, so
// a site that really keeps its policy under "/p/..." and links it as
// "Privacy policy" still wins on the visible text.
const COMMERCE_PATH_RE = /\/(p|dp|gp|itm|prd|prod|product|products|item|items|goods|shop|store|catalog|catalogue|collection|collections|category|categories|search|listing|listings|deals|browse|pdp)(\/|$)/i;
const COMMERCE_PARAM_RE = /^(productid|itemid|goodsid|product_id|item_id|spu|sku|variantid|offerid|catalogueid)$/i;
function isCommerceUrl(href) {
  try {
    const parsed = new URL(href);
    if (COMMERCE_PATH_RE.test(parsed.pathname)) return true;
    for (const key of parsed.searchParams.keys()) {
      if (COMMERCE_PARAM_RE.test(key)) return true;
    }
    // "/small-flower-cookie-12-35-oz/1016233601" has no commerce segment, but a
    // long kebab slug parent followed by a numeric id is a product address.
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length >= 2) {
      const parent = segments[segments.length - 2];
      const last = segments[segments.length - 1];
      if (/\d{3,}/.test(last) && parent.split('-').length >= 4) return true;
    }
    return false;
  } catch { return false; }
}
// Latin transliterations matter as much as the Cyrillic words: policy slugs on
// Bulgarian and Serbian sites are usually romanised ("bonus-pravila",
// "deklaratsiya-za-poveritelnost") and scored 0 without them.
function legalTermScore(lowerText) {
  let score = 0;
  if (/privacy|privatnost|povertyatelnost|poveritelnost|datenschutz|personal-data|лични данни|поверителност/i.test(lowerText)) score += 10;
  if (/cookie|biskvitki?|consent|съгласие|saglasie|согласие/i.test(lowerText)) score += 10;
  if (/terms|conditions|usloviya|uslovia|uslovi|uvjeti|условия|условия/i.test(lowerText)) score += 8;
  if (/policy|politika|pravila|polityka|политика|правила/i.test(lowerText)) score += 5;
  if (/legal|gdpr|declaration|deklarac|deklarat|izjava|statement|деклараци|изјава/i.test(lowerText)) score += 4;
  if (/dost[ae]?p?nost|availability|достъпност|доступност|accessibility/i.test(lowerText)) score += 5;
  return score;
}
function scoreLegalImportance(href, text) {
  const scoreFromTail = legalTermScore(hrefTailSegment(href));
  const scoreFromLabel = legalTermScore((text || '').toLowerCase());
  let score = scoreFromTail + scoreFromLabel;
  if (/iasme|certificate|recaptcha|blockmarktech|trusted-shops|quota limits|exceeding recaptcha/i.test(href)) score -= 100;
  if (/cookieyes\.com|onetrust\.com|cookiebot\.com|quantcast\.com/i.test(href) && !href.includes(window.location.hostname)) score -= 100;
  // The legal word came only from the address, and the address is a shop: a
  // product page that happens to contain "cookies" or "terms" in its name. The
  // visible link text still wins, so a real policy under "/p/..." is kept.
  if (scoreFromLabel === 0 && isCommerceUrl(href)) return -100;
  return score;
}
function findLegalLinks() {
  const origin = window.location.origin;
  const links = Array.from(document.querySelectorAll('a[href]'));
  const scored = [];
  const seen = new Set();
  for (const link of links) {
    const href = link.href;
    const text = link.textContent || link.getAttribute('aria-label') || '';
    if (!href || href.startsWith('javascript:') || href.startsWith('#')) continue;
    try { const url = new URL(href); if (url.origin !== origin) continue; } catch { continue; }
    if (!LEGAL_URL_REGEX.test(`${href} ${text}`)) continue;
    if (/iasme|certificate|blockmarktech|trusted-shops|quota limits|exceeding recaptcha/i.test(href)) continue;
    const normalized = normalizeLegalUrl(href);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const score = scoreLegalImportance(href, text);
    if (score < 0) continue;
    scored.push({ href, text: cleanText(text), score });
  }
  scored.sort((a, b) => b.score - a.score);
  console.log('NexusKitty [DIAG]: scored legal links', scored);
  return scored.slice(0, MAX_LEGAL_LINKS);
}
// FIX: URLs whose path merely contains a legal-sounding word (e.g. an
// undiscovered "/assets/cookie-consent.min.js" bundle, or a redirect that
// lands on a .json config endpoint) were previously fed straight through
// DOMParser, whose textContent fallback happily returns raw JS/JSON
// source as "body text" when there's no real HTML structure. That source
// code then looked long enough and contained enough of the word "cookie"/
// "consent"/"privacy" (variable names, comments) to pass the "important"
// filter and get sent to the LLM as if it were the actual policy - which
// is why the analysis once said "This script manages cookie consent
// settings by storing... local storage" (it had literally read a CMP
// library's JS source, not the rendered banner).
function looksLikeSourceCodeNotProse(text) {
  if (!text) return false;
  const codeSignalPattern = /function\s*\(|=>\s*\{|\bvar\s+\w+\s*=|\bconst\s+\w+\s*=|\blet\s+\w+\s*=|module\.exports|require\(['"]|window\.\w+\s*=|\.prototype\.|localStorage\.(get|set)Item|JSON\.(parse|stringify)|=>\s*\(|\bfunction\s+\w+\s*\(/g;
  const hits = (text.match(codeSignalPattern) || []).length;
  // A real policy page can legitimately mention "cookie" a hundred times,
  // but it will not contain dozens of JS syntax tokens per 1000 chars.
  return hits >= 6 && hits / Math.max(text.length, 1) > 0.002;
}
// FIX: frameworks that hydrate client-side frequently embed the page's real
// text as JSON inside a <script> tag, which the usual
// script/style/nav/header/footer removal throws away. Recover prose from the
// three shapes that matter:
//
//   1. <script id="__NEXT_DATA__" type="application/json">{...}</script>
//   2. self.__next_f.push([1,"...escaped RSC chunk..."])  (Next.js App Router)
//   3. window.__NUXT__ = {...} / __NUXT__ = {...}          (Nuxt)
//
// Only long, prose-shaped string values are kept, and the result is rejected
// if it reads like source code, so a JS bundle payload cannot be mistaken for
// policy text.
function stripTagsFromMarkup(value) {
  return String(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function collectProseStrings(value, out, depth = 0) {
  if (depth > 12 || out.length > 400) return;
  if (typeof value === 'string') {
    if (value.length >= 200 && /\s/.test(value)) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectProseStrings(item, out, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) collectProseStrings(value[key], out, depth + 1);
  }
}

// The recovered text is not clean prose: RSC/JSON scaffolding tokens like
// ["$","article"...] , "children":, null, "pageProps": survive the tag strip
// and would reach the LLM as garbage. Drop structural tokens that only ever
// appear as JSON keys/refs, without touching real sentences.
function stripPayloadScaffolding(text) {
  return String(text)
    .replace(/\[\s*"\$"\s*,?/g, ' ')
    .replace(/"\$"\s*,?/g, ' ')
    .replace(/"(?:children|pageProps|props|type|key|href|ref|html|content|body)"\s*:\s*/g, ' ')
    .replace(/\b(?:null|undefined|true|false)\b(?=\s*[,}\]])/g, ' ')
    .replace(/(^|\s)\d+:(?=\s)/g, '$1')
    .replace(/\s*[\]}]{2,}\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function extractEmbeddedPayloadProse(doc) {
  const collected = [];

  for (const script of doc.querySelectorAll('script')) {
    const source = script.textContent || '';
    if (!source) continue;

    // 1. Plain JSON island: __NEXT_DATA__, __NUXT__, or any application/json.
    if (script.getAttribute('type') === 'application/json' || /__NEXT_DATA__|__NUXT__/.test(source)) {
      const jsonSource = source.replace(/^\s*window\.__NUXT__\s*=\s*/, '').replace(/;\s*$/, '');
      try {
        collectProseStrings(JSON.parse(jsonSource), collected);
        continue;
      } catch (e) {
        // fall through to the string-literal scan below
      }
    }

    // 2/3. Streaming pushes and object literals: pull out every JSON string
    // literal, unescape it, and keep the ones that look like prose.
    if (/__next_f\.push|__NUXT__|__PRELOADED_STATE__|__INITIAL_STATE__/.test(source)) {
      const literalPattern = /"((?:[^"\\]|\\.)*)"/g;
      let match;
      while ((match = literalPattern.exec(source)) !== null) {
        let decoded;
        try {
          decoded = JSON.parse(`"${match[1]}"`);
        } catch (e) {
          continue;
        }
        if (decoded.length >= 200 && /\s/.test(decoded)) collected.push(decoded);
      }
      try {
        collectProseStrings(JSON.parse(source.replace(/^\s*window\.__NUXT__\s*=\s*/, '')), collected);
      } catch (e) {}
    }
  }

  if (collected.length === 0) return '';

  const merged = stripJunkNoise(cleanText(stripTagsFromMarkup(stripPayloadScaffolding(collected.join(' '))))).slice(0, MAX_TEXT_LENGTH);
  if (!merged || merged.length < 200) return '';
  if (looksLikeSourceCodeNotProse(merged)) {
    console.log('NexusKitty [FILTER]: embedded payload looks like source code, ignoring it');
    return '';
  }
  return merged;
}

// Open the URL in an inactive tab, let JavaScript hydrate, and read the
// resulting DOM. This is the only way to read a client-side-rendered policy
// (betano.bg, learngerman.dw.com and similar SPAs ship an empty app shell to
// a plain fetch). Returns the cleaned text on success, or null.
//
// Called from two places, both of which the previous inline version missed:
//   - the static HTML parsed down to almost nothing (CSR app shell)
//   - the static fetch never returned a body at all (aborted by the 6s
//     timeout, which is what happens on slow non-cached legal pages)
async function attemptRenderedFetch(url, cacheKey, triggerReason) {
  const lastAttempt = renderedFetchAttemptedAt.get(cacheKey) || 0;
  if (Date.now() - lastAttempt < RENDER_RETRY_COOLDOWN_MS) {
    console.log('NexusKitty [RENDER]: skipping, already tried', Math.round((Date.now() - lastAttempt) / 1000), 's ago');
    return null;
  }

  renderedFetchAttemptedAt.set(cacheKey, Date.now());
  console.log('NexusKitty [RENDER]: requesting an off-screen render of', url, '| reason:', triggerReason);

  let rendered = null;
  try {
    rendered = await chrome.runtime.sendMessage({ type: 'NEXUSKITTY_FETCH_RENDERED', url });
  } catch (renderError) {
    console.log('NexusKitty [RENDER]: rendered fetch unavailable', renderError?.message || renderError);
    return null;
  }

  if (!rendered?.ok || !rendered.text) {
    console.log('NexusKitty [RENDER]: no rendered text for', url, '| reason:', rendered?.reason || rendered?.error || 'unknown');
    // A broken attempt (extension API error, timeout, no response) says nothing
    // about the document, so it must not burn the 90s cooldown - otherwise one
    // failure makes the next extraction passes of the same page give up without
    // ever retrying, and the popup reports "only the surrounding page".
    const transient = !rendered || rendered.reason === 'exception' || rendered.reason === 'render_unavailable' || Boolean(rendered.error);
    if (transient) {
      renderedFetchAttemptedAt.delete(cacheKey);
      console.log('NexusKitty [RENDER]: attempt was transient, allowing an immediate retry');
    }
    return null;
  }

  const renderedClean = stripJunkNoise(cleanText(rendered.text));
  console.log('NexusKitty [RENDER]: rendered text for', url, '->', renderedClean.length, 'chars (raw', (rendered.text || '').length, ')');

  if (renderedClean.length < 200 || looksLikeSourceCodeNotProse(renderedClean)) {
    // The page DID render a real document, but stripJunkNoise/cleanText threw
    // almost all of it away - typical for a cookie-policy page whose body is
    // mostly links with a long prose block the heuristic mis-weights. Dropping
    // the document entirely leaves the popup with nothing, which is worse than
    // handing the model some navigation noise along with the policy text.
    const rawText = (rendered.text || '').trim();
    if (rawText.length >= 1200 && !looksLikeSourceCodeNotProse(rawText)) {
      console.log('NexusKitty [RENDER]: keeping the unstripped render for', url, '->', rawText.length, 'chars');
      fetchedLegalPageCache.set(cacheKey, { text: rawText, timestamp: Date.now(), ttl: RENDERED_PAGE_CACHE_TTL });
      fetchedPageFailureReasons.delete(cacheKey);
      return rawText;
    }
    console.log('NexusKitty [RENDER]: rendered text rejected as too thin or source-like', url);
    return null;
  }

  fetchedLegalPageCache.set(cacheKey, {
    text: renderedClean,
    timestamp: Date.now(),
    // A rendered page is far more expensive to obtain than a static fetch, so
    // it gets its own, much longer TTL. Without it the 20s static cache and
    // the 90s render cooldown left a dead window: after 20s the success was
    // gone, and the cooldown refused to re-render until 90s, so the next
    // extraction of the same page returned 0 chars and reported the site as
    // "JS-rendered, nothing found" (learngerman.dw.com did exactly this).
    ttl: RENDERED_PAGE_CACHE_TTL,
  });
  fetchedPageFailureReasons.delete(cacheKey);
  return renderedClean;
}

async function fetchLegalPageText(url) {
  // FIX: reuse an already-fetched-and-cleaned copy of this exact legal
  // page if we fetched it within the last few seconds. This is what
  // stops popup.js's polling loop (force_refresh:true, up to 6 times per
  // popup open) from re-downloading the same /cookie, /privacy-policy,
  // /terms-of-use pages over and over within a single popup session -
  // see the duplicated entries in the Network tab.
  const cacheKey = normalizeLegalUrl(url);
  const cachedEntry = fetchedLegalPageCache.get(cacheKey);
  // Per-entry TTL: rendered results carry their own, much longer one.
  const entryTtl = cachedEntry?.ttl || FETCHED_PAGE_CACHE_TTL;
  if (cachedEntry && Date.now() - cachedEntry.timestamp < entryTtl) {
    console.log('NexusKitty [CACHE]: reusing fetched legal page', url, cachedEntry.ttl ? '(rendered)' : '');
    return cachedEntry.text;
  }
  // NOTE: deliberately NOT clearing fetchedPageFailureReasons here. On a
  // cache hit (popup.js polls up to 6 times within the 20s TTL) a real fetch
  // never runs, so clearing the reason would make every later pass report
  // "unknown" and suppress the JS-rendered detection. Clear it only when an
  // actual fetch is about to happen.

  try {
    fetchedPageFailureReasons.delete(cacheKey);
    const response = await chrome.runtime.sendMessage({ type: 'NEXUSKITTY_FETCH_URL', url });

    // FIX: a definitive HTTP failure (4xx/5xx) is not a transient hiccup -
    // it means the server categorically refused this URL (e.g. bot
    // protection on a help-center article, like adidas.com's
    // "what-is-the-privacy-policy" returning 403). Retrying it on every
    // polling tick within the same popup session just repeats the same
    // blocked request over the network for no gain. Cache the empty
    // result too, same short TTL as a genuine success, so subsequent
    // extraction passes within this popup session skip it.
    // NOTE: response.ok is the service worker's own wrapper flag
    // (background.js does sendResponse({ ok: true, ...result })), so it is
    // true even for a 403 - the real HTTP status lives in response.status.
    // A missing/failed sendMessage (network/timeout error, no response)
    // is NOT cached here - that still falls through to the catch block
    // below and stays retryable.
    if (response && typeof response.status === 'number' && response.status >= 400) {
      // 403/429/503 are edge bot protection, not a decision about the document:
      // betano.bg answers a background fetch with a Cloudflare "Betano Splash
      // Screen" page (403), because the request has no browser fingerprint and
      // no cookies. The off-screen/debugger render is a real browser navigation
      // and does get through, so try it before giving up. Only a hard refusal
      // (404/410 and friends) is cached straight away.
      const isEdgeBlock = response.status === 403 || response.status === 429 || response.status === 503;
      if (isEdgeBlock) {
        console.log('NexusKitty [DIAG]: edge/bot block', response.status, 'for', url, '- trying a real browser render');
        const renderedText = await attemptRenderedFetch(url, cacheKey, `edge block ${response.status}`);
        if (renderedText) return renderedText;
      }
      console.log('NexusKitty [CACHE]: caching definitive HTTP failure', response.status, url);
      fetchedPageFailureReasons.set(cacheKey, FETCH_REASON_HTTP);
      fetchedLegalPageCache.set(cacheKey, { text: '', timestamp: Date.now() });
      return '';
    }

    if (!response?.ok || !response.html) {
      fetchedPageFailureReasons.set(cacheKey, FETCH_REASON_THIN);
      console.log('NexusKitty [DIAG]: static fetch produced no body for', url, '- trying a rendered tab');
      const renderedText = await attemptRenderedFetch(url, cacheKey, 'static fetch returned no body (timeout or transport error)');
      if (renderedText) return renderedText;
      return '';
    }
    // FIX: reject non-HTML responses up front using the content-type
    // background.js now reports (see NEXUSKITTY_FETCH_URL / fetchLegalUrl).
    const contentType = (response.contentType || '').toLowerCase();
    if (contentType && !/text\/html|application\/xhtml/.test(contentType)) {
      console.log('NexusKitty [FILTER]: Skipping non-HTML content-type', contentType, url);
      fetchedPageFailureReasons.set(cacheKey, FETCH_REASON_CONTENT_TYPE);
      return '';
    }
    const early = response.html.slice(0, 3000);
    if (/reCAPTCHA.*quota|quota limits|enterprise quota|exceeding recaptcha|Issued to.*IASME/i.test(early)) {
      console.log('NexusKitty [FILTER]: Skipping quota/certificate page', url);
      fetchedPageFailureReasons.set(cacheKey, FETCH_REASON_QUOTA);
      return '';
    }
    const parser = new DOMParser(); const doc = parser.parseFromString(response.html, 'text/html');

    // FIX: modern frameworks (Next.js App Router, Nuxt, Remix) often ship the
    // article text ONLY inside a JSON payload embedded in a <script> tag -
    // e.g. self.__next_f.push([1,"...escaped RSC chunk..."]) or
    // <script id="__NEXT_DATA__" type="application/json">. The next line
    // deletes every <script>, so that text used to vanish and the page
    // extracted to 0 characters despite 250+ kB of markup. Mine the payload
    // BEFORE removing scripts and keep it as a second source.
    const payloadProse = extractEmbeddedPayloadProse(doc);
    const payloadScripts = doc.querySelectorAll('script').length;
    const payloadWithProse = payloadProse.length;

    doc.querySelectorAll('script, style, nav, header, footer, svg, noscript').forEach((el) => el.remove());
    const mainNode = doc.querySelector('main, article, [role="main"],.content, #content, body');
    const raw = mainNode ? cleanText(mainNode.textContent || mainNode.innerText || '') : '';
    let cleaned = stripJunkNoise(raw);
    // DIAGNOSTIC: a client-side-rendered page returns tens of kB of HTML whose
    // <body> is an empty mount point, so `raw` collapses to a handful of
    // characters even though the fetch succeeded. Logging the numbers makes
    // that distinguishable from a content-type rejection or a decode failure.
    // Decisive check: does the raw HTML contain policy prose AT ALL (even
    // inside a script payload)? If not, the page is genuinely client-side
    // rendered and no amount of static parsing can recover it.
    const policyWordHits = (response.html.match(/бисквит|персонални данни|доверителност|privacy policy|personal data|cookie polic|terms of use|условия за ползване/gi) || []).length;

    console.log(
      'NexusKitty [FETCH]:', url,
      '| html chars:', response.html.length,
      '| mainNode:', mainNode ? (mainNode.tagName || '?').toLowerCase() : 'none',
      '| raw:', raw.length,
      '| cleaned:', cleaned.length,
      '| scripts:', payloadScripts,
      '| payload prose:', payloadWithProse,
      '| policy words in raw html:', policyWordHits
    );
    // Prefer the rendered DOM text; fall back to the embedded JSON payload
    // when the DOM is just an app shell.
    if (cleaned.length < 200 && payloadProse.length >= 200) {
      console.log('NexusKitty [FETCH]: using embedded JSON payload prose instead of empty DOM', url);
      cleaned = payloadProse;
    }

    // Last resort before giving up: open the URL in an inactive tab and read
    // the DOM AFTER JavaScript has run (see attemptRenderedFetch).
    if (cleaned.length < 200 && response.html.length >= 2000) {
      const renderedText = await attemptRenderedFetch(url, cacheKey, 'static extraction too thin');
      if (renderedText) return renderedText;
    }
    if (cleaned.length < 200) {
      // Big HTML that yields almost no prose = the body is an empty mount
      // point filled in by JavaScript after hydration.
      const reason = response.html.length >= 2000 ? FETCH_REASON_JS_RENDERED : FETCH_REASON_THIN;
      fetchedPageFailureReasons.set(cacheKey, reason);
      return '';
    }
    if (/Issued to|IASME|Recaptcha requires/i.test(cleaned.slice(0, 800)) && cleaned.length < 1200) {
      fetchedPageFailureReasons.set(cacheKey, FETCH_REASON_QUOTA);
      return '';
    }
    // FIX: reject bodies that look like source code rather than prose
    // (covers the case where content-type was misreported as text/html
    // by a misconfigured server but the body is really a JS bundle).
    if (looksLikeSourceCodeNotProse(cleaned)) {
      console.log('NexusKitty [FILTER]: Skipping source-code-looking body', url);
      fetchedPageFailureReasons.set(cacheKey, FETCH_REASON_SOURCE);
      return '';
    }

    // Only cache genuine successes - empty/rejected results should NOT
    // be cached, so a transient network hiccup can still be retried on
    // the next polling tick instead of being locked in for 20s.
    fetchedLegalPageCache.set(cacheKey, { text: cleaned, timestamp: Date.now() });
    return cleaned;
  } catch (err) { return ''; }
}
const CMP_IFRAME_HOST_PATTERN = /(onetrust|cookielaw|didomi|trustarc|evidon|quantcast|cybot|cookiebot|usercentrics|sourcepoint|sp[-_.]?prod|privacy-mgmt|consentmanager|iubenda|termly|axeptio|cmp\.|cookie-script|consensu|cky|qc-cmp)/i;
function getConsentIframeCandidates() {
  return Array.from(document.querySelectorAll('iframe[src]')).filter((iframe) => {
    if (!isVisible(iframe)) {
      const src = iframe.src || '';
      if (/quantcast|consensu\.org|qc-cmp/i.test(src)) {
        // Quantcast iframe е невидим по default, но е важен
      } else {
        return false;
      }
    }
    const src = iframe.src || '';
    if (!src || src.startsWith('about:') || src.startsWith('javascript:')) return false;
    if (/blockmarktech|iasme|trusted-shops/i.test(src)) return false;
    if (/recaptcha/i.test(src) && !/consensu|quantcast|cmp|qc-cmp/i.test(src)) return false;
    if (CMP_IFRAME_HOST_PATTERN.test(src)) return true;
    const style = window.getComputedStyle(iframe); const rect = iframe.getBoundingClientRect();
    const isOverlayLayer = ['fixed', 'sticky', 'absolute'].includes(style.position);
    const isLargeEnough = rect.width >= 200 && rect.height >= 150;
    return isOverlayLayer && isLargeEnough;
  }).map((iframe) => iframe.src).filter((src, index, array) => array.indexOf(src) === index).slice(0, 4);
}
async function fetchIframeConsentText(url) {
  try {
    if (/blockmarktech|iasme|trusted-shops/i.test(url)) return '';
    if (/recaptcha/i.test(url) && !/consensu|quantcast/i.test(url)) return '';
    const response = await chrome.runtime.sendMessage({ type: 'NEXUSKITTY_FETCH_URL', url });
    if (!response?.ok || !response.html) return '';
    const contentType = (response.contentType || '').toLowerCase();
    if (contentType && !/text\/html|application\/xhtml/.test(contentType)) return '';
    if (/reCAPTCHA.*quota|quota limits|Issued to.*IASME/i.test(response.html.slice(0, 2000))) return '';
    const parser = new DOMParser(); const doc = parser.parseFromString(response.html, 'text/html');
    doc.querySelectorAll('script, style, svg, noscript').forEach((el) => el.remove());
    const text = stripJunkNoise(cleanText(doc.body ? (doc.body.textContent || doc.body.innerText || '') : ''));
    if (looksLikeSourceCodeNotProse(text)) return '';
    return text;
  } catch (err) { return ''; }
}
const CMP_DETAIL_SELECTORS = [
  '#CookiebotWidget', '#CybotCookiebotDialog', '.cc-btn', '.cc-link', '[id*="cookiebot"]', '[class*="cookiebot"]',
  '#onetrust-policy', '#onetrust-consent-sdk', '.ot-pc-footer', '.ot-pc-header', '[id*="onetrust"]', '[class*="onetrust"]',
  '#didomi-popup', '[id*="didomi"]', '[class*="didomi"]', '[data-testid*="uc-"]', '[class*="usercentrics"]',
  '[class*="iubenda"]', '[id*="iubenda"]', '[class*="termly"]', '[id*="details"]',
  '[class*="details"]', '[id*="accordion"]', '[class*="accordion"]', '[id*="vendor"]', '[class*="vendor"]',
  '[id*="purpose"]', '[class*="purpose"]', '[id*="category"]', '[class*="category"]',
  '[id*="cookie-table"]', '[class*="cookie-table"]', '[id*="cookie-list"]', '[class*="cookie-list"]',
  '[id*="partner"]', '[class*="partner"]', '[id*="third-party"]', '[class*="third-party"]',
  '.cookie-consent-details', '.consent-details', '.vendor-list', '.purpose-list', '.cookie-policy-details',
  '[role="tabpanel"]', '[aria-hidden="true"]', 'details > summary', 'details[open]', '[data-tab]', '[data-panel]',
  '#uc-privacy-title', '#uc-privacy-description', '.privacy-title', '.privacy-text',
  '#cookiescript_header', '#cookiescript_description', '#cookiescript_buttons', '#cookiescript_checkboxs',
  '#cookiescript_readmore', '.uc-cmp-btn', '.uc-btn', '.cs-btn', '.cookie-script-btn',
  '.cky-detail', '.cky-accordion', '.cky-preference', '[data-cky-tag="detail"]',
  '.qc-cmp2-summary', '.qc-cmp2-main', '[id*="qc-cmp"]', '[class*="qc-cmp"]'
];
function extractCMPDetails(cmpElement) {
  if (!cmpElement) return '';
  let combinedText = getNodeText(cmpElement);
  const detailElements = cmpElement.querySelectorAll(CMP_DETAIL_SELECTORS.join(', '));
  for (const detailEl of detailElements) {
    if (detailEl === cmpElement) continue;
    const detailText = getNodeText(detailEl);
    if (detailText && detailText.length > 20) { if (!combinedText.includes(detailText.slice(0, 50))) combinedText += '\n\n[CMP Detail Section]\n' + detailText; }
  }
  const hiddenPanels = cmpElement.querySelectorAll('[role="tabpanel"], [aria-hidden="true"], details:not([open]),.hidden, [style*="display: none"], [style*="visibility: hidden"]');
  for (const panel of hiddenPanels) {
    const panelText = getNodeText(panel);
    if (panelText && panelText.length > 30 && !combinedText.includes(panelText.slice(0, 50))) combinedText += '\n\n[CMP Hidden Panel]\n' + panelText;
  }
  return stripJunkNoise(combinedText.slice(0, MAX_TEXT_LENGTH));
}
function getActiveConsentPopup() {
  const activeSelectors = [...CMP_OVERLAY_SELECTORS, ...COOKIEYES_SELECTORS, ...QUANTCAST_SELECTORS, '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]'];
  const elements = document.querySelectorAll(activeSelectors.join(', '));
  for (const el of elements) {
    if (!isVisible(el)) {
      const id = (el.id || '') + ' ' + (el.className || '');
      if (!/qc-cmp|sp_choice|consent/i.test(id)) continue;
    }
    if (isSemanticNonConsentLandmark(el)) continue;
    const fullCmpText = extractCMPDetails(el);
    if (fullCmpText.length >= 30 && hasStrongConsentSignal(fullCmpText)) return { node: el, text: fullCmpText };
  }
  const containers = getConsentContainers();
  if (containers.length > 0) { const fullText = extractCMPDetails(containers[0].node); return { node: containers[0].node, text: fullText }; }
  return null;
}
// NOTE: a per-language LEGAL_CONTENT_MARKERS keyword list used to live here
// (EN/DE/BG/RU/FR/ES/IT/PT/TR/NL/PL). It was removed on purpose - see the
// prose-based gate below. Adding the next language to a list only postpones
// the same bug; the structural test has no vocabulary to maintain.

// ============================================================
// LANGUAGE-AGNOSTIC PROSE DETECTION
// ============================================================
// FIX: this replaced a hardcoded list of English/German/Bulgarian/... legal
// keywords. A keyword list can never be universal - the next language breaks
// it again, and until now a correctly extracted page was thrown away as
// "not important enough" purely because nobody had added its language yet.
//
// Instead we ask a question that has the same answer in every language:
// does this text look like running PROSE rather than navigation, code, markup
// or a list of links? That is measurable from Unicode letter classes, sentence
// terminators (including CJK 。！？ and Devanagari danda ।) and symbol density,
// none of which depend on knowing the words.
//
// The remaining question - "is this document about privacy/cookies/terms?" -
// is semantic, and the LLM already answers it for any language, so it stays
// on the backend instead of being guessed from a vocabulary here.
const PROSE_MIN_LENGTH = 300;
const PROSE_SCORE_THRESHOLD = 0.55;

function scoreProseQuality(text) {
  if (!text) return 0;

  const sample = text.length > 6000 ? text.slice(0, 6000) : text;
  const total = sample.length;
  if (total < 50) return 0;

  // Combining marks (Devanagari matras, Arabic/Hebrew diacritics) are part of
  // the letters for this purpose - without them, Hindi and Arabic score worse
  // than English purely because of how their script encodes vowels.
  const letters = (sample.match(/[\p{L}\p{M}]/gu) || []).length;
  const digits = (sample.match(/\p{N}/gu) || []).length;
  const alnum = letters + digits;

  // 1. Letter density. Prose in ANY script is dominated by letters; source
  //    code, markup and symbol soup are not.
  const letterRatio = letters / total;

  // 2. Symbol density: everything that is neither letter, digit, whitespace nor
  //    common sentence punctuation. Braces, brackets, slashes and quotes pile
  //    up in code and nav menus.
  const symbols = (sample.match(/[^\p{L}\p{M}\p{N}\s.,;:!?'"()\[\]{}\-–—/\\]/gu) || []).length;
  const symbolRatio = symbols / total;

  // 3. Sentence structure. Count universal terminators; average length between
  //    them separates prose from a run of link labels. A period between two
  //    digits is a decimal point, not a sentence end (otherwise "12.99" makes
  //    a price list look like well-punctuated prose).
  const terminators = (sample.match(/(?<!\d)[.!?…]|[。！？।؟۔]/gu) || []).length;
  const sentenceCount = Math.max(terminators, 1);
  const avgSentenceLength = alnum / sentenceCount;

  // 4. Digit density. Legal prose mentions numbers occasionally; a price list,
  //    a table of SKUs or a stats widget is mostly digits.
  const digitRatio = digits / Math.max(alnum, 1);

  // 5. Type-token ratio: how much of the text is made of words that appear
  //    only once. Running prose is lexically varied; a navigation menu or a
  //    repeated template ("Product A 12.99 Product B ...") is not. Measured on
  //    space-separated tokens, so it is meaningless for scripts without spaces
  //    - there the token count is tiny and the ratio is simply not applied.
  const tokens = sample.split(/\s+/).filter((token) => /\p{L}/u.test(token));
  let typeTokenRatio = 1;
  if (tokens.length >= 40) {
    typeTokenRatio = new Set(tokens.map((token) => token.toLowerCase())).size / tokens.length;
  }

  let score = 0;
  if (letterRatio >= 0.55) score += 0.45;
  else if (letterRatio >= 0.4) score += 0.3;
  else if (letterRatio >= 0.25) score += 0.1;

  if (symbolRatio <= 0.02) score += 0.25;
  else if (symbolRatio <= 0.05) score += 0.15;
  else if (symbolRatio <= 0.1) score += 0.05;

  if (terminators >= 3) score += 0.2;
  else if (terminators >= 1) score += 0.1;
  // No sentence punctuation at all is the strongest single tell for a
  // list of labels - a menu, a button row, a breadcrumb. Prose in every
  // script ends sentences somehow (including CJK ideographic marks).
  else score -= 0.3;

  // Prose sentences run long; a nav menu is a run of 2-3 word labels.
  if (terminators >= 1 && avgSentenceLength >= 45) score += 0.15;
  else if (terminators >= 1 && avgSentenceLength >= 20) score += 0.08;

  if (digitRatio > 0.08) score -= 0.2;
  if (typeTokenRatio < 0.35) score -= 0.15;

  // Enough letters to be a real body of text. Deliberately NOT a space count,
  // so scripts without word separators (Chinese, Japanese, Thai) are not
  // penalised.
  if (letters > 400) score += 0.05;

  return Math.max(0, Math.min(1, score));
}

function looksLikeProseDocument(text) {
  if (!text) return false;
  if (text.length < PROSE_MIN_LENGTH) return false;
  if (looksLikeSourceCodeNotProse(text)) return false;
  return scoreProseQuality(text) >= PROSE_SCORE_THRESHOLD;
}

// Second, lower bar for genuinely short legal pages. A consent-settings page
// with six cookie categories is legitimate policy text of ~600 characters, not
// noise - it was being discarded purely for length (DW's
// /datenschutzeinstellungen/privacy-settings-de extracts to 629 chars). It
// still has to clear the "is this prose at all" test, just with less margin.
const PROSE_SCORE_THRESHOLD_LOW = 0.4;

function looksLikeShortLegalPage(text) {
  if (!text) return false;
  if (text.length < 300) return false;
  if (looksLikeSourceCodeNotProse(text)) return false;
  return scoreProseQuality(text) >= PROSE_SCORE_THRESHOLD_LOW;
}

async function extractMainText() {
  console.log('NexusKitty [DIAG]: extractMainText() started for', window.location.href);
  lastExtractionUsedSurroundingPage = false;
  lastExtractionJsRenderedSuspect = false;
  if (isTechnicalCmpIframe()) { console.log('[NEXUSKITTY] Skipping technical iframe:', window.location.href); return ''; }
  const signals = detectLegalPageSignals();
  const { isLegalPage } = signals;

  let legalLinks = findLegalLinks();
  // In-page anchors are not separate documents. Betano's table of contents
  // links to #Paragraph3 / #Paragraph7 of the very page being analysed, so
  // treating them as legal pages made the same document be fetched and
  // rendered again under a different URL (and paid for twice in translation).
  const selfUrl = normalizeLegalUrl(window.location.href);
  const anchorsDropped = legalLinks.filter((link) => normalizeLegalUrl(link.href) === selfUrl);
  if (anchorsDropped.length) {
    console.log(
      'NexusKitty [DIAG]: STEP_0 dropped', anchorsDropped.length,
      'self-anchor link(s):', anchorsDropped.map((l) => l.href)
    );
    legalLinks = legalLinks.filter((link) => normalizeLegalUrl(link.href) !== selfUrl);
  }
  console.log('NexusKitty [DIAG]: STEP_1 findLegalLinks() found', legalLinks.length, legalLinks);

  // A link whose normalized path is the site root ("https://sesame.bg/#",
  // "/?ref=footer") is a homepage, not a policy document. Rendering it returns
  // 4.7 kB of casino navigation that then competes with the real privacy text
  // for the analysis budget. Only keep the root when the page being analysed
  // IS the root - there is nothing else to read in that case.
  const isRootPath = (href) => {
    try {
      const parsed = new URL(href, window.location.href);
      const path = parsed.pathname.replace(/\/+$/, '');
      return path === '' || /^\/(index|home|main)\.[a-z]{2,4}$/i.test(path);
    } catch { return false; }
  };
  const rootDropped = legalLinks.filter((link) => isRootPath(link.href) && normalizeLegalUrl(link.href) !== selfUrl);
  if (rootDropped.length) {
    console.log('NexusKitty [DIAG]: STEP_0b dropped', rootDropped.length, 'homepage link(s):', rootDropped.map((l) => l.href));
    legalLinks = legalLinks.filter((link) => !rootDropped.includes(link));
  }

  // Translated duplicates of one document. Localised legal sites publish the
  // same article under several paths that share the article id, e.g.
  // /statiya/pravila-i-usloviya/339282/ and /en/article/terms-conditions/339282/
  // both carry id 339282. Each variant was fetched, rendered and paid for in
  // translation separately, which roughly doubled the runtime and added
  // nothing: the translated copy states the same terms.
  const documentIdentityKey = (href) => {
    try {
      const parsed = new URL(href, window.location.href);
      const segments = parsed.pathname.split('/').filter(Boolean);
      const idSegment = [...segments].reverse().find((segment) => /\d{3,}/.test(segment));
      return idSegment
        ? `${parsed.origin}#${idSegment.match(/\d{3,}/)[0]}`
        : normalizeLegalUrl(href);
    } catch { return normalizeLegalUrl(href); }
  };
  const languagePrefix = (href) => {
    try {
      const segment = new URL(href, window.location.href).pathname.split('/').filter(Boolean)[0] || '';
      return /^[a-z]{2}(-[a-z]{2})?$/i.test(segment) ? segment.toLowerCase() : '';
    } catch { return ''; }
  };
  const selfLanguage = languagePrefix(window.location.href);
  const dedupeTranslatedDuplicates = (links) => {
    const kept = [];
    const dropped = [];
    for (const link of links) {
      const key = documentIdentityKey(link.href);
      const index = kept.findIndex((candidate) => documentIdentityKey(candidate.href) === key);
      if (index === -1) {
        kept.push(link);
        continue;
      }
      const existing = kept[index];
      const sameLanguage = languagePrefix(link.href) === languagePrefix(existing.href);
      const prefersCurrentLanguage = languagePrefix(link.href) === selfLanguage && languagePrefix(existing.href) !== selfLanguage;
      const preferLink = prefersCurrentLanguage
        || (sameLanguage && link.score > existing.score)
        || (sameLanguage && link.score === existing.score && link.href.length < existing.href.length);
      if (preferLink) {
        kept[index] = link;
        dropped.push(existing.href);
      } else {
        dropped.push(link.href);
      }
    }
    return { links: kept, dropped };
  };
  const identityFiltered = dedupeTranslatedDuplicates(legalLinks);
  if (identityFiltered.dropped.length) {
    console.log('NexusKitty [DIAG]: STEP_0c dropped', identityFiltered.dropped.length, 'translated duplicate(s):', identityFiltered.dropped);
  }
  legalLinks = identityFiltered.links;

  // FIX: sitemap discovery used to run ONLY when the page contained zero legal
  // links. One footer link was enough to suppress it, which is how
  // learngerman.dw.com ended up analysing a 629-character cookie-settings
  // page while the real privacy declaration (a-64905194, linked only from the
  // sitemap) was never fetched. Discovery now SUPPLEMENTS what was found on
  // the page, and it is cached per origin, so the extra robots.txt/sitemap.xml
  // requests happen at most once per session.
  if (legalLinks.length < 3) {
    const domainUrls = await discoverDomainLegalLinks();
    if (domainUrls.length) {
      const origin = window.location.origin;
      const known = new Set(legalLinks.map((link) => normalizeLegalUrl(link.href)));
      const extra = domainUrls
        .filter((href) => {
          try { return new URL(href).origin === origin; } catch { return false; }
        })
        .filter((href) => !/iasme|certificate|blockmarktech|recaptcha.*quota|trusted-shops/i.test(href))
        .map((href) => ({ href, text: '', score: scoreLegalImportance(href, '') }))
        .filter((candidate) => candidate.score >= 4 && !known.has(normalizeLegalUrl(candidate.href)));
      if (extra.length) {
        console.log('NexusKitty [DIAG]: STEP_1b sitemap added', extra.length, 'legal candidates');
        const merged = dedupeTranslatedDuplicates([...legalLinks, ...extra]);
        if (merged.dropped.length) {
          console.log('NexusKitty [DIAG]: STEP_1b dropped', merged.dropped.length, 'translated duplicate(s):', merged.dropped);
        }
        legalLinks = merged.links
          .sort((a, b) => b.score - a.score)
          .slice(0, MAX_LEGAL_LINKS);
      }
    }
  }

  if (legalLinks.length === 0) {
    const domainUrls = await discoverDomainLegalLinks();
    if (domainUrls.length) {
      const origin = window.location.origin;
      legalLinks = domainUrls.filter(u => { try { return new URL(u).origin === origin; } catch { return false; } })
        .filter(u => !/iasme|certificate|blockmarktech|recaptcha.*quota|trusted-shops/i.test(u))
        .map(href => ({ href, text: '', score: scoreLegalImportance(href, '') }))
        // score >= 0 accepted EVERY sitemap entry, so a shop sitemap filled the
        // document list with product pages. Only URLs that actually look like a
        // policy survive now.
        .filter(o => o.score >= 4)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_LEGAL_LINKS);
      const finalFilter = dedupeTranslatedDuplicates(legalLinks);
      if (finalFilter.dropped.length) {
        console.log('NexusKitty [DIAG]: STEP_1c dropped', finalFilter.dropped.length, 'translated duplicate(s):', finalFilter.dropped);
      }
      legalLinks = finalFilter.links;
      console.log('NexusKitty [DIAG]: STEP_1c sitemap discovered', legalLinks.length, legalLinks);
    }
  }

  let fetchedPagesText = '';
  let fetchedMeta = [];
  if (legalLinks.length > 0) {
    const results = await Promise.all(legalLinks.map(async link => {
      const text = await fetchLegalPageText(link.href);
      console.log(`NexusKitty [DIAG]: fetched "${link.href}" -> ${text.length} chars`);
      return { ...link, text };
    }));
    const seen = new Set();
    const important = [];
    for (const r of results) {
      if (r.text.length < 300) continue;
      if (/reCAPTCHA.*quota|exceeding recaptcha|Issued to.*IASME/i.test(r.text.slice(0, 1000))) continue;
      const sig = textSignature(r.text);
      if (seen.has(sig)) { console.log('DEDUP skip', r.href); continue; }
      seen.add(sig);
      // FIX: "is this worth sending to the LLM?" used to be answered with a
      // hardcoded English keyword list, so every correctly extracted
      // non-English page (Datenschutz, поверителност, données personnelles, ...)
      // was discarded as "not important enough". It is now a language-agnostic
      // prose test - does this read as running text rather than navigation,
      // code or a list of links? The semantic question is left to the LLM,
      // which understands every language.
      const proseScore = scoreProseQuality(r.text);
      const isProse = proseScore >= PROSE_SCORE_THRESHOLD && r.text.length >= PROSE_MIN_LENGTH;
      const isShortLegalPage = !isProse && looksLikeShortLegalPage(r.text);
      if (!isProse && !isShortLegalPage) {
        console.log('Not prose, skip', r.href, '| score:', proseScore.toFixed(2), '| chars:', r.text.length);
        continue;
      }
      if (isShortLegalPage) {
        console.log('Short but prose-like, keeping', r.href, '| score:', proseScore.toFixed(2), '| chars:', r.text.length);
      }
      important.push(r);
    }
    fetchedMeta = important;
    fetchedPagesText = important.map(r => `[SOURCE: ${r.href} | score ${r.score}]\n${r.text}`).join('\n\n--- NEXT LEGAL SECTION ---\n\n');

    // FIX: we DID find legal URLs, but every one came back with no usable
    // text. Only claim "rendered by JavaScript" when the evidence supports
    // it: the fetch returned a large HTML document whose body collapsed to
    // almost nothing. Other reasons (403, PDF content-type, quota page, JS
    // bundle) must not be mislabelled as CSR.
    const reasonCounts = {};
    for (const link of legalLinks) {
      const reason = fetchedPageFailureReasons.get(normalizeLegalUrl(link.href)) || 'unknown';
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    }
    if (important.length === 0 && results.every(r => r.text.length === 0)) {
      console.log(
        'NexusKitty [DIAG]: STEP_1b legal pages found but all fetched empty',
        JSON.stringify(reasonCounts), 'of', legalLinks.length
      );
      if ((reasonCounts[FETCH_REASON_JS_RENDERED] || 0) === legalLinks.length) {
        lastExtractionJsRenderedSuspect = true;
      }
    }
  }
  console.log('NexusKitty [DIAG]: STEP_1 fetchedPagesText length =', fetchedPagesText.length, 'from', fetchedMeta.length, 'important pages');

  let dedicatedPageText = '';
  if (isLegalPage) {
    let baseText = getMainDocumentText();
    if (!baseText || baseText.length <= 400) {
      const bodyText = getTextExcludingOverlays(document.body);
      if (bodyText && bodyText.length > baseText.length) baseText = bodyText;
    }
    if (baseText && baseText.length > 100) dedicatedPageText = stripJunkNoise(baseText);
  }

  const activePopup = getActiveConsentPopup();
  let popupText = activePopup?.text || '';
  console.log('NexusKitty [DIAG]: STEP_3 initial popupText length =', popupText.length);

  if (receivedIframeConsentText.length > popupText.length) popupText = receivedIframeConsentText;

  if (popupText.length < 600) {
    if (isCookiebotDetected()) {
      const r = await extractCookiebotEdgeCase();
      if (r.text.length > popupText.length) { console.log('NexusKitty [DIAG]: Cookiebot recovered', r.text.length); popupText = r.text; }
    }
    if (isCookieYesDetected()) {
      const r = await extractCookieYesEdgeCase();
      if (r.text.length > popupText.length) { console.log('NexusKitty [DIAG]: CookieYes recovered', r.text.length); popupText = r.text; }
    }
    if (isQuantcastDetected()) {
      const r = await extractQuantcastEdgeCase();
      if (r.text.length > popupText.length) { console.log('NexusKitty [DIAG]: Quantcast recovered', r.text.length, r.text.slice(0, 200)); popupText = r.text; }
    }
  }

  if (popupText.length < 150) {
    const iframeCandidates = getConsentIframeCandidates();
    if (iframeCandidates.length) {
      const iframeTexts = await Promise.all(iframeCandidates.map((src) => fetchIframeConsentText(src)));
      const combinedIframeText = iframeTexts.filter((text) => text.length > 80).join('\n\n--- NEXT CONSENT FRAME ---\n\n');
      if (combinedIframeText.length > popupText.length) popupText = combinedIframeText;
    }
  }

  const structuralConsent = getConsentContainers();
  const structuralBannerText = structuralConsent.length ? structuralConsent[0].text.slice(0, BANNER_BUDGET) : '';
  let bannerText = popupText.length >= structuralBannerText.length ? popupText : structuralBannerText;
  bannerText = stripJunkNoise(bannerText);
  // FIX: the consent dialog is DOM-based, not fetched, so it never went
  // through fetchLegalPageText()'s looksLikeSourceCodeNotProse() guard. A CMP
  // that leaks its tracking snippet as text (unclosed <script>, debug output
  // in a hidden <pre>/<div>) produced a "banner" that was pure JavaScript,
  // which the LLM then reported as policy clauses about localStorage and
  // postMessage. Apply the same guard here.
  if (bannerText && looksLikeSourceCodeNotProse(bannerText)) {
    console.log('NexusKitty [FILTER]: Skipping source-code-looking banner text', bannerText.length, 'chars');
    bannerText = '';
  }
  console.log('NexusKitty [DIAG]: STEP_3 final bannerText length =', bannerText.length);

  // Per-section budgets. The deep scan used to be a flat slice(0, 6000), so a
  // site with a cookie policy AND a privacy declaration only ever sent the
  // first document - the model then answered from a fragment. Each source block
  // now gets its own share of the deep-scan budget.
  const sections = [];
  if (bannerText && bannerText.length >= 80) {
    sections.push(`[Active Consent Popup / Cookie Banner - PRIORITY - MUST REVIEW]\n${bannerText.slice(0, CONSENT_BANNER_CHARS)}`);
  }
  if (dedicatedPageText) {
    sections.push(`[Main Document - Dedicated Legal Page]\n${dedicatedPageText.slice(0, MAIN_DOC_CHARS)}`);
  }
  if (fetchedPagesText) {
    sections.push(
      `[Deep Scan of Sitemap - ${fetchedMeta.length} Important Legal Pages]\n` +
      sampleSourcesProportionally(fetchedPagesText, DEEP_SCAN_CHARS)
    );
  }

  let combinedResult = sections.join('\n\n').trim();
  combinedResult = stripJunkNoise(combinedResult);
  console.log('NexusKitty [DIAG]: STEP_5 combinedResult length =', combinedResult.length, 'sections:', sections.length, 'preview:', combinedResult.slice(0, 400));

  if (combinedResult.length > 100) return combinedResult.slice(0, COMBINED_TEXT_CAP);

  // Last resort: the current page's own text. It is NOT the legal document
  // unless this page happens to be one, so flag it for the popup.
  const fallback = getTextExcludingOverlays(document.body) || cleanText(document.body?.innerText || '');
  let cleanedFallback = stripJunkNoise(fallback);
  // Same guard as the fetched-page paths: a body that is mostly JS source is
  // not prose, and sending it to the LLM only produces invented "findings".
  if (cleanedFallback && looksLikeSourceCodeNotProse(cleanedFallback)) {
    console.log('NexusKitty [FILTER]: Skipping source-code-looking fallback body', cleanedFallback.length, 'chars');
    cleanedFallback = '';
  }
  if (cleanedFallback.length > 300) {
    lastExtractionUsedSurroundingPage = !isLegalPage;
    console.log(
      'NexusKitty [DIAG]: FALLBACK to surrounding page text',
      cleanedFallback.length,
      'chars, isLegalPage =', isLegalPage
    );
    return cleanedFallback.slice(0, MAX_TEXT_LENGTH);
  }
  return 'No readable text found on this page.';
}

const KNOWN_TRACKER_DOMAINS = ['google-analytics.com', 'analytics.google.com', 'googletagmanager.com', 'googletagservices.com', 'googlesyndication.com', 'googleadservices.com', 'doubleclick.net', 'connect.facebook.net', 'hotjar.com', 'hotjar.io', 'clarity.ms', 'bat.bing.com', 'criteo.com', 'criteo.net', 'taboola.com', 'outbrain.com', 'adnxs.com', 'scorecardresearch.com', 'amazon-adsystem.com', 'quantserve.com', 'pubmatic.com', 'rubiconproject.com', 'openx.net', 'casalemedia.com', 'adsrvr.org', 'snap.licdn.com', 'px.ads.linkedin.com', 'ads-twitter.com', 'analytics.tiktok.com', 'ct.pinterest.com', 'mc.yandex.ru', 'fullstory.com', 'segment.io', 'segment.com', 'mixpanel.com', 'amplitude.com', 'chartbeat.com', 'chartbeat.net', 'parsely.com', 'permutive.com', 'bluekai.com', 'krxd.net', 'demdex.net', 'omtrdc.net', '2o7.net', 'everesttech.net', 'adobedtm.com', 'moatads.com', 'adform.net', 'smartadserver.com', 'teads.tv', 'yieldmo.com', 'sharethrough.com', '3lift.com', 'indexww.com', 'bidswitch.net', 'mathtag.com', 'tapad.com', 'liveramp.com', 'rlcdn.com', 'id5-sync.com', 'crwdcntrl.net', 'agkn.com', 'addthis.com', 'sharethis.com'];
function detectTrackers() {
  const currentHost = window.location.hostname; const found = new Set();
  for (const entry of performance.getEntriesByType('resource')) {
    try {
      const host = new URL(entry.name).hostname;
      if (!host || host === currentHost) continue;
      const isTracker = KNOWN_TRACKER_DOMAINS.some((domain) => host === domain || host.endsWith('.' + domain));
      if (isTracker) found.add(host);
    } catch {}
  }
  return [...found];
}
function isExplicitConsentButton(element) {
  if (!element || !isVisible(element)) {
    const src = element?.src || '';
    if (/qc-cmp|quantcast/i.test(src)) {} else { if (!isVisible(element)) return false; }
  }
  const text = (element.textContent || element.value || element.getAttribute('aria-label') || '').trim();
  if (!text) return false;
  const pageIsLegal = LEGAL_URL_REGEX.test(window.location.href);
  const inConsentContainer = Boolean(element.closest(CONSENT_SELECTORS.join(',')) || element.closest('[role="dialog"], [aria-modal="true"]'));
  const strictConsentPhrases = /(i agree|accept terms|accept all|agree to terms|accept privacy|accept policy|accept cookies|reject all|decline|refuse|manage cookies|cookie settings|privacy settings|policy settings|allow all|allow essential cookies|allow cookies|essential cookies|customise|more options)/i;
  if (strictConsentPhrases.test(text)) return inConsentContainer || pageIsLegal;
  const shortPhrases = /^(ok|accept|agree|allow|settings|preferences|customise|more options)$/i;
  if (shortPhrases.test(text)) {
    const parentContext = element.closest('[role="dialog"], [aria-modal="true"]')?.textContent || element.parentElement?.textContent || '';
    return /(cookie|cookies|consent|privacy|policy|personal data|data protection)/i.test(parentContext);
  }
  return false;
}
function findConsentButtons() {
  const selectors = ['button', 'input[type="button"]', 'input[type="submit"]', '[role="button"]', 'a'];
  const structuralContainers = getConsentContainers();
  if (structuralContainers.length) {
    const buttons = structuralContainers[0].node.querySelectorAll(selectors.join(','));
    const result = Array.from(buttons).filter((element) => isExplicitConsentButton(element));
    if (result.length) return result;
  }
  const legalPageButtons = Array.from(document.querySelectorAll('main button, article button, [role="main"] button, main [role="button"], article [role="button"]')).filter((button) => {
    const form = button.closest('form'); if (!form) return false;
    return Boolean(form.querySelector('input[type="checkbox"]') || Array.from(form.querySelectorAll('a[href]')).some((link) => /(terms|condition|privacy|cookie|legal|policy|rights|gdpr|data)/i.test(link.href)));
  });
  if (legalPageButtons.length) {
    const result = legalPageButtons.filter((element) => isExplicitConsentButton(element));
    if (result.length) return result;
  }
  return Array.from(document.querySelectorAll(selectors.join(','))).filter((element) => isExplicitConsentButton(element));
}
function getConsentSnapshot() {
  return findConsentButtons().map((element) => {
    const rawText = element.textContent || element.value || element.getAttribute('aria-label') || '';
    const label = cleanText(rawText); let action = 'accept';
    if (/(reject|decline|refuse)/i.test(rawText)) action = 'reject';
    else if (/(manage|settings|preferences|customise|more options)/i.test(rawText)) action = 'manage';
    return { label, action };
  }).filter((button) => button.label);
}
let domainDisabled = false; let domainSettingsLoaded = false; let observerTimer = null;
let receivedIframeConsentText = ''; let iframeRelayReanalysisTimer = null;
let lastReanalyzedIframeTextLength = 0; let lastSentPageSignature = '';
function computePageSignature(payload) {
  if (!payload) return ''; const parts = [window.location.href, payload.text || '', Array.isArray(payload.detected_trackers) ? payload.detected_trackers.join('|') : '', Array.isArray(payload.consent_controls) ? payload.consent_controls.map((c) => c.text || c.label || '').join('|') : ''];
  const raw = parts.join('\x00'); let hash = 0; for (let i = 0; i < raw.length; i += 1) hash = (hash * 31 + raw.charCodeAt(i)) >>> 0; return hash.toString(36);
}
function scheduleReanalysisAfterIframeRelay() {
  if (isDomainDisabledSync()) return;
  if (receivedIframeConsentText.length <= lastReanalyzedIframeTextLength) return;
  if (iframeRelayReanalysisTimer) clearTimeout(iframeRelayReanalysisTimer);
  iframeRelayReanalysisTimer = setTimeout(async () => {
    iframeRelayReanalysisTimer = null; if (isDomainDisabledSync()) return;
    lastReanalyzedIframeTextLength = receivedIframeConsentText.length;
    try {
      const payload = await buildPagePayload(true);
      if (payload?.text?.length > 0) {
        const signature = computePageSignature(payload);
        if (signature && signature === lastSentPageSignature) return;
        lastSentPageSignature = signature;
        try { await chrome.storage.local.set({ [`nexuskitty_page_${window.location.href}`]: payload.text }); } catch (error) {}
        try { await chrome.runtime.sendMessage({ type: 'NEXUSKITTY_PAGE_DATA_UPDATED', payload }); } catch (error) {}
      }
    } catch (error) {}
  }, 400);
}
async function loadDomainSettings() {
  if (domainSettingsLoaded) return domainDisabled;
  try {
    const domain = window.location.hostname;
    const result = await chrome.storage.local.get('disabledDomains');
    const disabledDomains = Array.isArray(result.disabledDomains) ? result.disabledDomains : [];
    domainDisabled = disabledDomains.includes(domain);
  } catch (error) { domainDisabled = false; } finally { domainSettingsLoaded = true; }
  return domainDisabled;
}
function isDomainDisabledSync() { return domainDisabled; }
function removeAllHuds() { document.querySelectorAll('.nexuskitty-consent-hud').forEach((el) => el.remove()); }
function removeRiskOutlines() { findConsentButtons().forEach((button) => { button.style.outline = ''; button.style.boxShadow = ''; button.title = ''; removeConsentHud(button); }); }
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.disabledDomains) return;
  const list = Array.isArray(changes.disabledDomains.newValue) ? changes.disabledDomains.newValue : [];
  domainDisabled = list.includes(window.location.hostname); domainSettingsLoaded = true;
  if (domainDisabled) { removeAllHuds(); removeRiskOutlines(); } else { applyRiskWarning(lastCategories, lastShouldWarn); }
});
function createConsentHud(button) {
  if (!button) return; if (button.querySelector('.nexuskitty-consent-hud')) return;
  const parent = button.parentElement; if (!parent) return;
  if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative'; parent.appendChild(warning);
}
function removeConsentHud(button) { if (!button) return; const hud = button.querySelector('.nexuskitty-consent-hud'); if (hud) hud.remove(); }
function getPageCacheKey() { try { const url = new URL(window.location.href); return CACHE_PREFIX + url.origin + url.pathname + url.search; } catch { return CACHE_PREFIX + window.location.href; } }
async function readPageCache() {
  try {
    const key = getPageCacheKey(); const result = await chrome.storage.local.get(key);
    const cached = result[key];
    if (cached && cached.timestamp && Date.now() - cached.timestamp < CACHE_TTL && cached.payload) return cached.payload;
  } catch (error) {} return null;
}
async function writePageCache(payload) { try { const key = getPageCacheKey(); await chrome.storage.local.set({ [key]: { timestamp: Date.now(), payload } }); } catch (error) {} }
async function pruneExpiredCache() {
  try {
    const { nk_last_prune: lastPrune = 0 } = await chrome.storage.local.get('nk_last_prune');
    if (Date.now() - lastPrune < CACHE_TTL) return;
    const all = await chrome.storage.local.get(null);
    const expired = Object.keys(all).filter((key) => key.startsWith(CACHE_PREFIX) && (!all[key]?.timestamp || Date.now() - all[key].timestamp >= CACHE_TTL));
    if (expired.length) await chrome.storage.local.remove(expired);
    await chrome.storage.local.set({ nk_last_prune: Date.now() });
  } catch (error) {}
}
async function translateTextToEnglish(text) {
  if (!text || !text.trim()) return { text: text || '', detectedLang: null, translated: false };

  // FIX: cache by content signature (not by full text, to keep the map
  // key small) so repeated calls with the SAME extracted text within a
  // short window reuse the previous translation instead of re-hitting
  // the Google Translate endpoint. This is what stopped the repeated
  // "single?client=gtx&sl=auto&tl=en..." requests seen in the Network
  // tab during popup.js's force_refresh polling loop.
  const cacheKey = textSignature(text);
  const cachedEntry = translationCache.get(cacheKey);
  if (cachedEntry && Date.now() - cachedEntry.timestamp < TRANSLATION_CACHE_TTL) {
    console.log('NexusKitty [CACHE]: reusing translation for unchanged text');
    return cachedEntry.result;
  }

  try {
    const response = await chrome.runtime.sendMessage({ type: 'NEXUSKITTY_TRANSLATE_TEXT', text });
    if (response?.ok && response.text) {
      const result = { text: response.text, detectedLang: response.detectedLang || null, translated: response.translated === true };
      // Only cache genuine successes, same rationale as fetchLegalPageText:
      // a transient failure should still be retryable on the next tick.
      translationCache.set(cacheKey, { result, timestamp: Date.now() });
      return result;
    }
  } catch (error) {}
  return { text, detectedLang: null, translated: false };
}
async function extractDocumentTextAsync() {
  try {
    const text = await extractMainText();
    if (text && text.trim().length >= 20 && text !== 'No readable text found on this page.') return { source: 'zero_failure', text };
  } catch (error) {}
  let extractedText = "";
  try {
    const cmpNodes = document.querySelectorAll('#CybotCookiebotDialog, #CookiebotWidget, [id*="Cookiebot"], [id*="cmpbox"], [class*="cookie"],.cky-notice,.qc-cmp2-container');
    cmpNodes.forEach(node => { extractedText += " " + (node.innerText || node.textContent || ""); });
    if (window.Cookiebot && window.Cookiebot.decl) extractedText += "\n\nCookiebot Declaration Data: " + JSON.stringify(window.Cookiebot.decl);
  } catch (e) {}
  if (extractedText.trim().length < 100) {
    try {
      const legalLink = Array.from(document.querySelectorAll('a[href]')).find(a => {
        const h = a.href.toLowerCase(); const t = (a.innerText || '').toLowerCase();
        return ['privacy', 'poveritelnost', 'terms', 'usloviya', 'cookie', 'biskvitki'].some(kw => h.includes(kw) || t.includes(kw));
      });
      if (legalLink && legalLink.href.startsWith('http')) {
        const html = await fetchLegalPageText(legalLink.href); if (html) extractedText += "\n\n" + html;
      }
    } catch (err) {}
  }
  if (extractedText.trim().length < 20) extractedText = getTextExcludingOverlays(document.body) || (NO_CONTENT_FALLBACK_PREFIX + window.location.hostname);
  return { source: 'zero_failure_fallback', text: stripJunkNoise(extractedText) };
}

// FIX: buildPagePayload used to be plain "async function" with no
// reentrancy guard. Every caller that passed force_refresh:true
// (popup.js's polling loop calling it up to 6 times per popup open, AND
// scheduleReanalysisAfterIframeRelay firing independently on iframe
// relay messages) started its OWN full extractMainText() pass, each one
// re-walking the DOM and re-fetching every discovered legal page over
// the network from scratch. Because extractMainText() and its helpers
// (fetchLegalPageText, translateTextToEnglish, etc.) share mutable
// module-level state (receivedIframeConsentText, the on-disk page cache
// entry keyed by getPageCacheKey(), etc.), these concurrent passes could
// race and step on each other, and it was pure luck which pass's result
// ended up cached/returned last. This is exactly what the duplicated
// "fetched .../cookies/ -> ..." log pairs show.
//
// Fix: keep a single in-flight promise. Any caller that shows up with
// force_refresh:true while an extraction is already running just awaits
// that SAME extraction instead of starting a second one. A
// force_refresh:false caller still short-circuits via the normal
// readPageCache() path above and never touches the lock.
//
// Combined with the fetchedLegalPageCache and translationCache above
// (which now also protect SEQUENTIAL, non-overlapping calls), popup.js's
// 6x polling loop no longer causes 6x network traffic for the same legal
// pages or the same translation.
let inFlightBuildPromise = null;

// FIX: even with per-URL caches (fetchedLegalPageCache, translationCache)
// and the in-flight guard above, nothing previously stopped SEPARATE,
// SEQUENTIAL force_refresh:true callers - popup.js's own polling loop
// (up to ~7 calls, 350ms apart) PLUS scheduleReanalysisAfterIframeRelay()
// firing independently up to 3 times as a Cookiebot iframe reports
// growing consent text - from each triggering a brand new, full
// extractMainText() pass back-to-back. If any per-URL cache happens to
// miss for a given site (different origin after a redirect, a
// cache-busting query param, a slow chrome.storage read, etc.) that
// compounds into exactly the runaway request loop seen in the Network
// tab (repeated cookie/privacy-policy/terms-of-use/homepage fetches).
//
// This is a hard, root-cause-agnostic backstop: no matter WHY a
// lower-level cache misses, buildPagePayload will not re-run the full
// extraction pipeline more often than once per MIN_REEXTRACTION_INTERVAL_MS,
// for ANY reason a force_refresh comes in (polling or iframe relay).
// Callers that hit the throttle just get the most recent payload back.
let lastExtractionAt = 0;
let lastExtractionPayload = null;
const MIN_REEXTRACTION_INTERVAL_MS = 1500;

async function buildPagePayload(forceRefresh = false) {
  if (!forceRefresh) {
    const cached = await readPageCache();
    if (cached) return cached;
  }

  if (inFlightBuildPromise) return inFlightBuildPromise;

  // The throttle below exists to stop a burst of polling from re-running the
  // whole pipeline. Applied blindly it also froze the popup on a USELESS
  // payload: on sesame.bg the first pass returned the 57-character "no text"
  // fallback, every following poll got that same fallback back for 1.5s, and
  // the popup read it as "converged, nothing here". A pass that produced no
  // usable text must never be served as an answer - it only means "not ready".
  const lastTextLength = String(lastExtractionPayload?.text || '').trim().length;
  const lastWasUnusable = lastExtractionPayload ? lastTextLength < 300 : false;

  if (
    forceRefresh &&
    lastExtractionPayload &&
    !lastWasUnusable &&
    Date.now() - lastExtractionAt < MIN_REEXTRACTION_INTERVAL_MS
  ) {
    console.log('NexusKitty [THROTTLE]: skipping re-extraction, returning last payload');
    return lastExtractionPayload;
  }

  inFlightBuildPromise = (async () => {
    try {
      let text = await extractMainText();
      if (!text || text.trim().length < 30 || text === 'No readable text found on this page.') {
        const asyncResult = await extractDocumentTextAsync();
        if (asyncResult?.text && asyncResult.text.trim().length > (text || '').trim().length) text = asyncResult.text;
      }
      const isFallback = !text || text.trim().length < 30 || text === 'No readable text found on this page.' || text.startsWith(NO_CONTENT_FALLBACK_PREFIX);
      if (isFallback && forceRefresh) {
        const cached = await readPageCache();
        if (cached && cached.text && cached.text.trim().length >= 30 && cached.text !== 'No readable text found on this page.' && !cached.text.startsWith(NO_CONTENT_FALLBACK_PREFIX)) return cached;
      }
      let analysisText = text; let detectedLanguage = null; let wasTranslated = false;
      if (!isFallback) {
        const translation = await translateTextToEnglish(text);
        analysisText = translation.text || text; detectedLanguage = translation.detectedLang; wasTranslated = translation.translated;
      }
      const trackers = detectTrackers(); const consentControls = getConsentSnapshot(); const legalSurface = hasLegalSurface();
      const payload = { text, analysis_text: analysisText, detected_language: detectedLanguage, translated: wasTranslated, trackers, detected_trackers: trackers, consent_controls: consentControls, legal_surface: legalSurface, used_surrounding_page: lastExtractionUsedSurroundingPage, js_rendered_suspected: lastExtractionJsRenderedSuspect, url: window.location.href, hostname: window.location.hostname, title: document.title || '' };
      if (!isFallback) await writePageCache(payload);
      // FIX: record every completed extraction (fallback or not) so the
      // throttle above has something recent to hand back to the next
      // force_refresh caller instead of re-running the whole pipeline.
      lastExtractionAt = Date.now();
      lastExtractionPayload = payload;
      return payload;
    } finally {
      inFlightBuildPromise = null;
    }
  })();

  return inFlightBuildPromise;
}

async function applyRiskWarning(categories, shouldWarn) {
  if (isDomainDisabledSync()) { removeRiskOutlines(); return; }
  if (!shouldWarn) { removeRiskOutlines(); return; }
  findConsentButtons().forEach((button) => {
    button.title = 'WARNING: Clicking this may accept risky data or privacy terms.';
    createConsentHud(button);
  });
}
// =========================================================
// OFF-SCREEN RENDER FRAME PROTOCOL
// =========================================================
// When this frame was created by the off-screen render host, its window.name
// carries "nk-render-<token>". The service worker uses that to ask exactly
// this frame for its rendered text, which is how client-side rendered legal
// pages are read WITHOUT opening a visible tab. On a normal page nothing
// happens: the name never matches, so this code stays completely inert.
const RENDER_FRAME_PREFIX = 'nk-render-';
const RENDER_FRAME_HASH_KEY = '__nk_render';

function getRenderFrameToken() {
  // Primary: the marker the off-screen host put in the fragment. window.name is
  // only a fallback because plenty of sites overwrite it, which used to break
  // the handshake silently.
  try {
    const marker = new URLSearchParams(window.location.hash.replace(/^#/, '')).get(RENDER_FRAME_HASH_KEY);
    if (marker) return marker;
  } catch (e) {}

  try {
    if (typeof window.name === 'string' && window.name.startsWith(RENDER_FRAME_PREFIX)) {
      return window.name.slice(RENDER_FRAME_PREFIX.length);
    }
  } catch (e) {}
  return null;
}

if (getRenderFrameToken()) {
  // The host's marker lives in the fragment; it must never leak into the URL we
  // report back as the document's final address.
  const cleanHref = () => {
    try {
      const parsed = new URL(location.href);
      parsed.hash = parsed.hash.replace(new RegExp(`[&]?${RENDER_FRAME_HASH_KEY}=[^&]*`), '');
      return parsed.href;
    } catch (e) {
      return location.href.split('#')[0];
    }
  };
  const announceRenderFrame = () => {
    try {
      chrome.runtime.sendMessage({
        type: 'NEXUSKITTY_RENDER_FRAME_READY',
        token: getRenderFrameToken(),
        href: cleanHref(),
        title: document.title || '',
        readyState: document.readyState,
      });
    } catch (e) {}
  };
  // document_idle already means the document is parsed; a short delay lets
  // client-side routes mount before the worker asks for the text.
  setTimeout(announceRenderFrame, 800);
}

async function handleMessage(request, sender, sendResponse) {
  try {
    if (request && request.type === 'NEXUSKITTY_RENDER_FRAME_EXTRACT') {
      const token = getRenderFrameToken();
      if (!token || token !== request.token) return; // not our frame: stay silent
      const root = document.querySelector('main, article, [role="main"], .content, #content') || document.body;
      const text = root ? (root.innerText || root.textContent || '') : '';
      try {
        chrome.runtime.sendMessage({
          type: 'NEXUSKITTY_RENDER_FRAME_TEXT',
          token,
          text: text || '',
          title: document.title || '',
          href: cleanHref(),
        });
      } catch (e) {}
      sendResponse({ ok: true, chars: (text || '').length });
      return;
    }
    if (request && request.type === 'NEXUSKITTY_GET_PAGE_DATA') { const payload = await buildPagePayload(request.force_refresh === true); sendResponse({ ok: true, ...payload }); return; }
    if (request && request.type === 'NEXUSKITTY_GET_DOCUMENT_TEXT') {
      const result = await extractDocumentTextAsync();
      const trackers = detectTrackers(); const consentControls = getConsentSnapshot(); const legalSurface = hasLegalSurface();
      let analysisText = result.text; let detectedLanguage = null; let wasTranslated = false;
      if (result.text && result.text.trim().length >= 30) {
        const translation = await translateTextToEnglish(result.text);
        analysisText = translation.text || result.text; detectedLanguage = translation.detectedLang; wasTranslated = translation.translated;
      }
      sendResponse({ ok: true, source: result.source, text: result.text, analysis_text: analysisText, detected_language: detectedLanguage, translated: wasTranslated, trackers, detected_trackers: trackers, consent_controls: consentControls, legal_surface: legalSurface, fetchedUrl: result.fetchedUrl || null }); return;
    }
    if (request && request.type === 'NEXUSKITTY_ANALYSIS_RESULT') { lastCategories = request.categories || []; lastShouldWarn = request.should_warn === true; await applyRiskWarning(lastCategories, lastShouldWarn); sendResponse({ ok: true }); return; }
    if (request && request.type === 'NEXUSKITTY_IFRAME_CONSENT_TEXT_RELAY') {
      if (request.text && request.text.length > receivedIframeConsentText.length) {
        receivedIframeConsentText = stripJunkNoise(request.text);
        scheduleReanalysisAfterIframeRelay();
      }
      sendResponse({ ok: true }); return;
    }
    sendResponse({ ok: false, error: 'Unknown NexusKitty message type.' });
  } catch (error) { sendResponse({ ok: false, error: error?.message || 'Unknown content-script error.' }); }
}
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => { if (sender.id !== chrome.runtime.id) return false; handleMessage(request, sender, sendResponse); return true; });
const BUTTON_SELECTOR = 'button, [role="button"], input[type="button"], input[type="submit"]';
function mutationLooksRelevant(mutation) {
  if (mutation.type !== 'childList') return false;
  for (const node of Array.from(mutation.addedNodes || [])) {
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    if (node.classList?.contains('nexuskitty-consent-hud')) continue;
    const consentContainers = findConsentContainersInNode(node);
    if (consentContainers.length) return true;
    if (node.matches?.(BUTTON_SELECTOR)) { if (isExplicitConsentButton(node)) return true; }
    const buttons = node.querySelectorAll?.(BUTTON_SELECTOR);
    if (buttons?.length) { for (const button of buttons) { if (isExplicitConsentButton(button)) return true; } }
  }
  return false;
}
let lastShouldWarn = false; let lastCategories = [];
function scheduleConsentHudUpdate() {
  if (observerTimer) clearTimeout(observerTimer);
  observerTimer = setTimeout(() => { observerTimer = null; applyRiskWarning(lastCategories, lastShouldWarn); }, HUD_UPDATE_DELAY);
}
async function initContentScript() {
  try {
    await loadDomainSettings();
    const payload = isDomainDisabledSync() ? null : await buildPagePayload(false);
    if (payload?.text?.length > 0) { try { await chrome.storage.local.set({ [`nexuskitty_page_${window.location.href}`]: payload.text }); } catch (error) {} }
    pruneExpiredCache();
    const observer = new MutationObserver((mutations) => {
      if (isDomainDisabledSync()) return;
      const relevant = mutations.some((mutation) => mutationLooksRelevant(mutation));
      if (!relevant) return; scheduleConsentHudUpdate();
    });
    if (document.documentElement) observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => { if (!isDomainDisabledSync()) scheduleConsentHudUpdate(); }, 1000);
    setTimeout(() => { if (!isDomainDisabledSync()) scheduleConsentHudUpdate(); }, 3000);
  } catch (error) { console.error('NexusKitty: Content script initialization failed.', error); }
}
function detectOwnFrameConsentText() {
  const popup = getActiveConsentPopup();
  if (popup && popup.text && popup.text.length >= 80) {
    const looksLikeJsCode = /function\s*\(\)\s*\{|var\s+\w+\s*=|postMessage\(|CookieConsentBulkSetting|handleRequest/.test(popup.text);
    if (!looksLikeJsCode) return stripJunkNoise(popup.text);
  }
  const spNode = document.querySelector('.message.type-modal, [class*="sp_choice_type"], #notice.message, [class*="message-component"],.qc-cmp2-container');
  if (spNode) {
    const container = spNode.closest('.message, [role="dialog"], [aria-modal="true"], body') || spNode;
    const text = getNodeText(container);
    if (text && text.length >= 80) {
      const looksLikeJsCode = /function\s*\(\)\s*\{|var\s+\w+\s*=|postMessage\(|CookieConsentBulkSetting|handleRequest/.test(text);
      if (!looksLikeJsCode) return stripJunkNoise(text);
    }
  }
  return '';
}
let lastReportedIframeConsentText = '';
function reportIframeConsentText() {
  try {
    const text = detectOwnFrameConsentText();
    if (text && text !== lastReportedIframeConsentText) {
      lastReportedIframeConsentText = text;
      chrome.runtime.sendMessage({ type: 'NEXUSKITTY_IFRAME_CONSENT_TEXT', text, frameUrl: window.location.href }).catch(() => {});
    }
  } catch (err) {}
}
if (window.self !== window.top) {
  const scheduleIframeReports = () => { reportIframeConsentText(); setTimeout(reportIframeConsentText, 800); setTimeout(reportIframeConsentText, 2000); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scheduleIframeReports, { once: true });
  else scheduleIframeReports();
} else if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { initContentScript(); }, { once: true });
} else { initContentScript(); }