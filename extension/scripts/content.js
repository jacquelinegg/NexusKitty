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

const MAX_TEXT_LENGTH = 9000;
const MAX_LEGAL_LINKS = 12;
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
  if (window.self !== window.top) {
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
  return stripJunkNoise(cleanText(node.textContent || ''));
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
function normalizeLegalUrl(url) {
  try {
    const parsed = new URL(url); parsed.hash = '';
    let path = parsed.pathname; if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    parsed.pathname = path; return parsed.origin + parsed.pathname + parsed.search;
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
async function discoverDomainLegalLinks() {
  const origin = window.location.origin;
  const cached = await readDomainLegalCache(origin);
  if (cached !== null) return cached;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'NEXUSKITTY_DISCOVER_LEGAL_URLS', origin });
    const urls = response?.ok && Array.isArray(response.urls) ? response.urls : [];
    await writeDomainLegalCache(origin, urls);
    return urls;
  } catch (error) { return []; }
}
function scoreLegalImportance(href, text) {
  let score = 0;
  const combined = `${href} ${text}`.toLowerCase();
  if (/privacy|datenschutz|personal-data|лични данни|поверителност/i.test(combined)) score += 10;
  if (/cookie|biskvitki|consent|съгласие/i.test(combined)) score += 10;
  if (/terms|conditions|usloviya|условия/i.test(combined)) score += 8;
  if (/policy|politika|политика/i.test(combined)) score += 5;
  if (/legal|gdpr|declaration/i.test(combined)) score += 4;
  if (/iasme|certificate|recaptcha|blockmarktech|trusted-shops|quota limits|exceeding recaptcha/i.test(combined)) score -= 100;
  if (/cookieyes\.com|onetrust\.com|cookiebot\.com|quantcast\.com/i.test(combined) && !combined.includes(window.location.hostname)) score -= 100;
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
async function fetchLegalPageText(url) {
  // FIX: reuse an already-fetched-and-cleaned copy of this exact legal
  // page if we fetched it within the last few seconds. This is what
  // stops popup.js's polling loop (force_refresh:true, up to 6 times per
  // popup open) from re-downloading the same /cookie, /privacy-policy,
  // /terms-of-use pages over and over within a single popup session -
  // see the duplicated entries in the Network tab.
  const cacheKey = normalizeLegalUrl(url);
  const cachedEntry = fetchedLegalPageCache.get(cacheKey);
  if (cachedEntry && Date.now() - cachedEntry.timestamp < FETCHED_PAGE_CACHE_TTL) {
    console.log('NexusKitty [CACHE]: reusing fetched legal page', url);
    return cachedEntry.text;
  }

  try {
    const response = await chrome.runtime.sendMessage({ type: 'NEXUSKITTY_FETCH_URL', url });
    if (!response?.ok || !response.html) return '';
    // FIX: reject non-HTML responses up front using the content-type
    // background.js now reports (see NEXUSKITTY_FETCH_URL / fetchLegalUrl).
    const contentType = (response.contentType || '').toLowerCase();
    if (contentType && !/text\/html|application\/xhtml/.test(contentType)) {
      console.log('NexusKitty [FILTER]: Skipping non-HTML content-type', contentType, url);
      return '';
    }
    const early = response.html.slice(0, 3000);
    if (/reCAPTCHA.*quota|quota limits|enterprise quota|exceeding recaptcha|Issued to.*IASME/i.test(early)) {
      console.log('NexusKitty [FILTER]: Skipping quota/certificate page', url);
      return '';
    }
    const parser = new DOMParser(); const doc = parser.parseFromString(response.html, 'text/html');
    doc.querySelectorAll('script, style, nav, header, footer, svg, noscript').forEach((el) => el.remove());
    const mainNode = doc.querySelector('main, article, [role="main"],.content, #content, body');
    if (!mainNode) return '';
    const raw = cleanText(mainNode.textContent || mainNode.innerText || '');
    const cleaned = stripJunkNoise(raw);
    if (cleaned.length < 200) return '';
    if (/Issued to|IASME|Recaptcha requires/i.test(cleaned.slice(0, 800)) && cleaned.length < 1200) return '';
    // FIX: reject bodies that look like source code rather than prose
    // (covers the case where content-type was misreported as text/html
    // by a misconfigured server but the body is really a JS bundle).
    if (looksLikeSourceCodeNotProse(cleaned)) {
      console.log('NexusKitty [FILTER]: Skipping source-code-looking body', url);
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
async function extractMainText() {
  console.log('NexusKitty [DIAG]: extractMainText() started for', window.location.href);
  if (isTechnicalCmpIframe()) { console.log('[NEXUSKITTY] Skipping technical iframe:', window.location.href); return ''; }
  const signals = detectLegalPageSignals();
  const { isLegalPage } = signals;

  let legalLinks = findLegalLinks();
  console.log('NexusKitty [DIAG]: STEP_1 findLegalLinks() found', legalLinks.length, legalLinks);
  if (legalLinks.length === 0) {
    const domainUrls = await discoverDomainLegalLinks();
    if (domainUrls.length) {
      const origin = window.location.origin;
      legalLinks = domainUrls.filter(u => { try { return new URL(u).origin === origin; } catch { return false; } })
        .filter(u => !/iasme|certificate|blockmarktech|recaptcha.*quota|trusted-shops/i.test(u))
        .map(href => ({ href, text: '', score: scoreLegalImportance(href, '') }))
        .filter(o => o.score >= 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_LEGAL_LINKS);
      console.log('NexusKitty [DIAG]: STEP_1b sitemap discovered', legalLinks.length, legalLinks);
    }
  }

  function textSignature(text) {
    if (!text) return ''; const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
    let hash = 0; for (let i = 0; i < normalized.length; i += 1) hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
    return hash.toString(36);
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
      if (!/(personal data|privacy|cookie|consent|terms|geolocation|third[- ]party|advertising partner|store and\/or access|we and our partners)/i.test(r.text)) {
        console.log('Not important enough, skip', r.href);
        continue;
      }
      important.push(r);
    }
    fetchedMeta = important;
    fetchedPagesText = important.map(r => `[SOURCE: ${r.href} | score ${r.score}]\n${r.text}`).join('\n\n--- NEXT LEGAL SECTION ---\n\n');
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
  console.log('NexusKitty [DIAG]: STEP_3 final bannerText length =', bannerText.length);

  const sections = [];
  if (bannerText && bannerText.length >= 80) {
    sections.push(`[Active Consent Popup / Cookie Banner - PRIORITY - MUST REVIEW]\n${bannerText.slice(0, 5000)}`);
  }
  if (dedicatedPageText) {
    sections.push(`[Main Document - Dedicated Legal Page]\n${dedicatedPageText.slice(0, 3000)}`);
  }
  if (fetchedPagesText) {
    sections.push(`[Deep Scan of Sitemap - ${fetchedMeta.length} Important Legal Pages]\n${fetchedPagesText.slice(0, 6000)}`);
  }

  let combinedResult = sections.join('\n\n').trim();
  combinedResult = stripJunkNoise(combinedResult);
  console.log('NexusKitty [DIAG]: STEP_5 combinedResult length =', combinedResult.length, 'sections:', sections.length, 'preview:', combinedResult.slice(0, 400));

  if (combinedResult.length > 100) return combinedResult.slice(0, MAX_TEXT_LENGTH);

  const fallback = getTextExcludingOverlays(document.body) || cleanText(document.body?.innerText || '');
  const cleanedFallback = stripJunkNoise(fallback);
  if (cleanedFallback.length > 300) return cleanedFallback.slice(0, MAX_TEXT_LENGTH);
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
  const existingHud = button.parentElement?.querySelector('.nexuskitty-consent-hud'); if (existingHud) return;
  const warning = document.createElement('div'); warning.className = 'nexuskitty-consent-hud'; warning.textContent = 'NK';
  warning.style.cssText = `display: inline-block; position: absolute; top: -9px; right: -7px; margin: 0; padding: 2px 5px; border-radius: 2px; font-size: 9px; line-height: 1; font-weight: 700; letter-spacing: 0.03em; color: #f4dfad; background: #302a24; border: 1px solid rgba(218, 174, 88, 0.65); box-shadow: 0 1px 5px rgba(0, 0, 0, 0.22); z-index: 999999; pointer-events: none;`;
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
  try {
    const response = await chrome.runtime.sendMessage({ type: 'NEXUSKITTY_TRANSLATE_TEXT', text });
    if (response?.ok && response.text) return { text: response.text, detectedLang: response.detectedLang || null, translated: response.translated === true };
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
// Combined with the fetchedLegalPageCache above (which now also protects
// SEQUENTIAL, non-overlapping calls), popup.js's 6x polling loop no
// longer causes 6x network traffic for the same legal pages.
let inFlightBuildPromise = null;

async function buildPagePayload(forceRefresh = false) {
  if (!forceRefresh) {
    const cached = await readPageCache();
    if (cached) return cached;
  }

  if (inFlightBuildPromise) return inFlightBuildPromise;

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
      const payload = { text, analysis_text: analysisText, detected_language: detectedLanguage, translated: wasTranslated, trackers, detected_trackers: trackers, consent_controls: consentControls, legal_surface: legalSurface, url: window.location.href, hostname: window.location.hostname, title: document.title || '' };
      if (!isFallback) await writePageCache(payload);
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
    button.style.outline = '3px solid #ff304f';
    button.style.boxShadow = '0 0 0 4px rgba(255, 48, 79, 0.28), 0 0 18px rgba(255, 48, 79, 0.8)';
    button.title = 'WARNING: Clicking this may accept risky data or privacy terms.';
    createConsentHud(button);
  });
}
async function handleMessage(request, sender, sendResponse) {
  try {
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