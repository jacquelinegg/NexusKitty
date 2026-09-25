function cleanText(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

/* =========================================================
   CONSTANTS
   ========================================================= */

const MAX_TEXT_LENGTH = 9000;
const MAX_LEGAL_LINKS = 5;
const CACHE_TTL = 24 * 60 * 60 * 1000;
const HUD_UPDATE_DELAY = 350;
const BANNER_BUDGET = 1500;
const CACHE_PREFIX = 'nk_cache_v4_';
// FIX: NEW. Domain-scoped cache for the legal URLs discovered via
// background.js's sitemap/path-guessing pipeline (see
// discoverDomainLegalLinks() below). Keyed per-origin so every other page
// on the same site reuses the result instead of re-discovering it.
const DOMAIN_LEGAL_CACHE_PREFIX = 'nk_domain_legal_v1_';
const DOMAIN_LEGAL_CACHE_TTL = 24 * 60 * 60 * 1000;
// A page that reached the very bottom of the extraction pipeline with
// nothing usable gets this exact placeholder (see
// extractDocumentTextAsync() below). It must never be treated as real
// document text - see the isFallback checks in buildPagePayload().
const NO_CONTENT_FALLBACK_PREFIX = 'Legal analysis fallback for site: ';
const LEGAL_URL_KEYWORDS = [
  'terms', 'conditions', 'privacy', 'cookie', 'policy', 'legal', 'gdpr',
  'datenschutz', 'einwilligung', 'nutzungs',
  'politique', 'consentement',
  'privacidad', 'consentimiento', 'condiciones',
  'privacidade', 'consentimento', 'condições',
  'правила', 'поверителност', 'бисквитки', 'съгласие', 'лични данни',
  'декларация', 'защита на данни', 'условия за ползване', 'политика за',
  'правила', 'политика', 'согласие',
  'політика', 'згода',
  'kişisel', 'çerez', 'onay', 'şartları',
  'سياسة', 'خصوصية', 'موافقة',
  'プライバシー', '同意', '利用規約',
  '개인정보', '동의', '이용',
  '隐私', '同意', '使用条款',
  'गोपनीयता', 'सहमति',
  'ความเป็น', 'การยินยอม',
  'פרטיות', 'הסכם',
  'προσωπικά', 'συγκατάθεση',
  'prywatność', 'ciasteczka', 'zgoda',
  'osobní', 'souhlas', 'podmínky',
];

const LEGAL_PAGE_REGEX = new RegExp(LEGAL_URL_KEYWORDS.join('|'), 'i');
const LEGAL_URL_REGEX = new RegExp(LEGAL_URL_KEYWORDS.join('|'), 'i');

// FIX: moved out of extractMainText() to module scope so it can be shared
// by detectLegalPageSignals() below (previously only extractMainText()
// could see this list, which meant hasLegalSurface() had no access to it
// and fell back to a much weaker check - see detectLegalPageSignals()).
const DEDICATED_LEGAL_URL_KEYWORDS = [
  'privacy', 'terms', 'conditions', 'cookie-policy', 'cookie_policy',
  'legal', 'gdpr', 'tos', 'obshti-usloviya', 'polzovatelsko-soglashenie',
  'usloviya-polzovaniya', 'politika-konfidentsialnosti', 'privacy-policy',
  'terms-of-service', 'terms-of-use', 'data-protection', 'data_policy',
  'legal-notice', 'impressum', 'aviso-legal', 'mentions-legales',
  'datenschutz', 'nutzungsbedingungen', 'allgemeine-geschaeftsbedingungen',
  'cookies', 'consent', 'user-agreement', 'service-terms',
  // FIX: added so pages like visit.varna.bg/bg/declaration-personal-data.html
  // are recognized by URL alone, without relying only on heading text.
  'declaration-personal-data', 'personal-data', 'declaration',
];

const BG_LATIN_TO_CYRILLIC_MAP = [
  ['shch', 'щ'], ['sht', 'щ'],
  ['yu', 'ю'], ['ya', 'я'], ['zh', 'ж'], ['ch', 'ч'], ['sh', 'ш'],
  ['ts', 'ц'], ['ye', 'е'], ['yo', 'ьо'], ['kh', 'х'], ['dzh', 'дж'],
  ['a', 'а'], ['b', 'б'], ['v', 'в'], ['g', 'г'], ['d', 'д'],
  ['e', 'е'], ['z', 'з'], ['i', 'и'], ['j', 'й'], ['y', 'ъ'],
  ['k', 'к'], ['l', 'л'], ['m', 'м'], ['n', 'н'], ['o', 'о'],
  ['p', 'п'], ['r', 'р'], ['s', 'с'], ['t', 'т'], ['u', 'у'],
  ['f', 'ф'], ['h', 'х'], ['c', 'ц'], ['q', 'к'], ['w', 'в'], ['x', 'кс'],
];

function transliterateLatinToCyrillicBG(text) {
  if (!text) {
    return '';
  }

  const lower = text.toLowerCase();
  let result = '';
  let i = 0;

  outer: while (i < lower.length) {
    for (const [latin, cyrillic] of BG_LATIN_TO_CYRILLIC_MAP) {
      if (lower.startsWith(latin, i)) {
        result += cyrillic;
        i += latin.length;
        continue outer;
      }
    }
    result += lower[i];
    i += 1;
  }

  return result;
}

const CMP_OVERLAY_SELECTORS = [
  '[id*="onetrust" i]', '[class*="onetrust" i]',
  '[id*="didomi" i]', '[class*="didomi" i]',
  '[id*="cookielaw" i]', '[class*="cookielaw" i]',
  '[id*="cmp" i]', '[class*="cmp" i]',
  '[id*="trustarc" i]', '[class*="trustarc" i]',
  '[id*="evidon" i]', '[class*="evidon" i]',
  '[id*="quantcast" i]', '[class*="quantcast" i]',
  '[id*="cybot" i]', '[class*="cybot" i]',
  '[id*="usercentrics" i]', '[class*="usercentrics" i]',
  '[id*="sp_message" i]', '[class*="sp_message" i]',
  '[id*="iubenda" i]', '[class*="iubenda" i]',
  '[id*="termly" i]', '[class*="termly" i]',
  '[id*="cookie-script" i]', '[class*="cookie-script" i]',
  '[id*="axeptio" i]', '[class*="axeptio" i]',
  '[id*="fg-modal" i]', '[class*="fg-modal" i]',
  '[id*="cookie-banner" i]', '[class*="cookie-banner" i]',
  '[id*="consent-banner" i]', '[class*="consent-banner" i]',
  '[id*="cookie-wall" i]', '[class*="cookie-wall" i]',
  '[id*="modal-overlay" i]', '[class*="modal-overlay" i]',
  '[id*="lightbox" i]', '[class*="lightbox" i]',
  '[id*="backdrop" i]', '[class*="backdrop" i]',
  '[id*="flyout" i]', '[class*="flyout" i]',
  '[id*="drawer" i]', '[class*="drawer" i]',
  '[id*="interstitial" i]', '[class*="interstitial" i]',
  '[id*="takeover" i]', '[class*="takeover" i]',
  '[id*="sheet" i]', '[class*="sheet" i]',
  '[class*="overlay" i]', '[class*="modal" i]', '[class*="dialog" i]',
  '[class*="popup" i]', '[id*="modal" i]', '[id*="dialog" i]', '[id*="popup" i]',
  '[class*="notice" i]', '[id*="notice" i]',
  '[class*="alert" i]', '[id*="alert" i]',
  '[class*="disclaimer" i]', '[id*="disclaimer" i]',
  '[class*="banner" i]', '[id*="banner" i]',
  '[class*="sticky-footer" i]', '[id*="sticky-footer" i]',
  '[class*="bottom-bar" i]', '[id*="bottom-bar" i]',
  '[class*="privacy-prompt" i]', '[id*="privacy-prompt" i]',
  '[class*="gdpr-modal" i]', '[id*="gdpr-modal" i]',
  '[class*="consent-wall" i]', '[id*="consent-wall" i]',
  '[class*="tos-popup" i]', '[id*="tos-popup" i]',
  '[class*="terms-modal" i]', '[id*="terms-modal" i]',
  '[data-testid*="cookie" i]', '[data-testid*="consent" i]',
  '#uc-main-dialog',
  '#cookiescript_injected',
  '.cmp.gdpr',
];

const CMP_OVERLAY_SELECTOR_STRING = CMP_OVERLAY_SELECTORS.join(', ');

function isTechnicalCmpIframe() {
  return (
    window.self !== window.top &&
    /consentcdn\.cookiebot\.eu/i.test(window.location.hostname)
  );
}

function isVisible(node) {
  if (!node) {
    return false;
  }

  let element = node;

  if (element.nodeType === Node.TEXT_NODE) {
    element = element.parentElement;
  }

  if (!element || element.nodeType !== Node.ELEMENT_NODE) {
    return false;
  }

  if (!element.isConnected) {
    return false;
  }

  if (element.hasAttribute && element.hasAttribute('hidden')) {
    return false;
  }

  let style;
  try {
    style = window.getComputedStyle(element);
  } catch (e) {
    return true;
  }

  if (!style) {
    return true;
  }

  if (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.visibility === 'collapse'
  ) {
    return false;
  }

  if (parseFloat(style.opacity) === 0) {
    return false;
  }

  try {
    const rect = element.getBoundingClientRect();
    if (
      rect.width === 0 &&
      rect.height === 0 &&
      element.getClientRects().length === 0
    ) {
      return false;
    }
  } catch (e) {
    // ignore
  }

  return true;
}

function getNodeText(node) {
  if (!node) {
    return '';
  }

  if (node.nodeType === Node.TEXT_NODE) {
    return cleanText(node.textContent);
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return '';
  }

  if (typeof node.innerText === 'string' && node.innerText.trim().length > 0) {
    return cleanText(node.innerText);
  }

  return cleanText(node.textContent || '');
}

function getTextExcludingOverlays(root) {
  if (!root) {
    return '';
  }

  const pieces = [];

  function walk(node) {
    if (!node) {
      return;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      if (node.textContent) {
        pieces.push(node.textContent);
      }
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    const tag = node.tagName ? node.tagName.toLowerCase() : '';

    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'svg') {
      return;
    }

    try {
      if (node.matches && node.matches(CMP_OVERLAY_SELECTOR_STRING)) {
        return;
      }
    } catch (e) {
      // ignore malformed selector match
    }

    for (const child of node.childNodes) {
      walk(child);
    }
  }

  walk(root);

  return cleanText(pieces.join(' '));
}

function getCmpGlobalData() {
  let extraText = '';

  if (window.Cookiebot && window.Cookiebot.decl) {
    try {
      extraText += '\n[Cookiebot Declaration]\n' + JSON.stringify(window.Cookiebot.decl, null, 2);
    } catch (e) {}
  }

  if (window.OnetrustActiveGroups || window.OneTrust) {
    try {
      const otData = window.OneTrust || window.OnetrustActiveGroups;
      extraText += '\n[OneTrust Data]\n' + JSON.stringify(otData, null, 2);
    } catch (e) {}
  }

  if (window.Usercentrics) {
    try {
      extraText += '\n[Usercentrics Data]\n' + JSON.stringify(window.Usercentrics, null, 2);
    } catch (e) {}
  }

  if (window.Didomi) {
    try {
      extraText += '\n[Didomi Data]\n' + JSON.stringify(window.Didomi, null, 2);
    } catch (e) {}
  }

  if (window.CMP || window.cmpManager) {
    try {
      extraText += '\n[Generic CMP Data]\n' + JSON.stringify(window.CMP || window.cmpManager, null, 2);
    } catch (e) {}
  }

  if (window.googlefc) {
    try {
      extraText += '\n[Google Funding Choices]\n' + JSON.stringify(window.googlefc, null, 2);
    } catch (e) {}
  }

  return extraText.slice(0, 5000);
}

function getDeepText(node, visited = new WeakSet()) {
  if (!node) return '';
  if (visited.has(node)) return '';
  visited.add(node);

  let text = '';

  if (node.nodeType === Node.TEXT_NODE) {
    return cleanText(node.textContent);
  }

  if (node.nodeType === Node.ELEMENT_NODE) {
    const tag = node.tagName.toLowerCase();
    if (['script', 'style', 'noscript'].includes(tag)) {
      return '';
    }

    try {
      if (node.matches && node.matches(CMP_OVERLAY_SELECTOR_STRING)) {
        return '';
      }
    } catch (e) {
      // ignore malformed selector match
    }

    if (node.shadowRoot) {
      text += ' ' + getDeepText(node.shadowRoot, visited);
    }

    for (const child of node.childNodes) {
      text += ' ' + getDeepText(child, visited);
    }

    if (tag === 'iframe') {
      try {
        if (node.contentDocument && node.contentDocument.body) {
          text += ' ' + getDeepText(node.contentDocument.body, visited);
        }
      } catch (e) {
        // cross-origin, ignore
      }
    }
  }

  return text;
}

function getMainDocumentText() {
  const selectors = [
    'main', 'article', '[role="main"]',
    '.terms', '.privacy-policy', '.terms-of-service', '.cookie-policy',
    '#content', '.content'
  ];

  let bestText = '';

  for (const selector of selectors) {
    const node = document.querySelector(selector);

    if (!node || !isVisible(node)) {
      continue;
    }

    const text = getTextExcludingOverlays(node);

    if (text.length >= 400 && text.length > bestText.length) {
      bestText = text;
    }
  }

  const deepBodyText = getDeepText(document.body);
  if (deepBodyText.length > bestText.length) {
    bestText = deepBodyText;
  }

  const cmpGlobalText = getCmpGlobalData();
  if (cmpGlobalText) {
    if (bestText) {
      bestText += '\n\n' + cmpGlobalText;
    } else {
      bestText = cmpGlobalText;
    }
  }

  if (!bestText || bestText.length < 400) {
    const bodyText = getTextExcludingOverlays(document.body);
    if (bodyText.length > bestText.length) {
      bestText = bodyText;
    }
  }

  return bestText.slice(0, MAX_TEXT_LENGTH);
}

const CONSENT_SELECTORS = [
  '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]', 'dialog[open]',
  '[id*="cookie" i]', '[class*="cookie" i]',
  '[id*="consent" i]', '[class*="consent" i]',
  '[id*="fg-modal" i]', '[class*="fg-modal" i]',
  '[id*="trustarc" i]', '[class*="trustarc" i]',
  '[id*="evidon" i]', '[class*="evidon" i]',
  '[id*="quantcast" i]', '[class*="quantcast" i]',
  '[id*="cybot" i]', '[class*="cybot" i]',
  '[id*="usercentrics" i]', '[class*="usercentrics" i]',
  '[id*="sp_message" i]', '[class*="sp_message" i]',
  '[id*="iubenda" i]', '[class*="iubenda" i]',
  '[id*="termly" i]', '[class*="termly" i]',
  '[id*="cookie-script" i]', '[class*="cookie-script" i]',
  '[id*="axeptio" i]', '[class*="axeptio" i]',
  '[id*="privacy" i]', '[class*="privacy" i]',
  '[id*="terms" i]', '[class*="terms" i]',
  '[id*="policy" i]', '[class*="policy" i]',
  '[id*="privacy-prompt" i]', '[class*="privacy-prompt" i]',
  '[id*="gdpr-modal" i]', '[class*="gdpr-modal" i]',
  '[id*="consent-wall" i]', '[class*="consent-wall" i]',
  '[id*="modal" i]', '[class*="modal" i]',
  '[id*="dialog" i]', '[class*="dialog" i]',
  '[id*="popup" i]', '[class*="popup" i]',
  '[id*="banner" i]', '[class*="banner" i]',
  '#uc-main-dialog',
  '#cookiescript_injected',
  '.cmp.gdpr',
];

function getActionNodes(node) {
  if (!node) {
    return [];
  }

  return Array.from(
    node.querySelectorAll(
      'button, input[type="button"], input[type="submit"], [role="button"]'
    )
  );
}

// FIX: NEW. "banner", "notice", "alert" and "disclaimer" are extremely
// overloaded words in web markup - a site's HEADER/HERO region very
// commonly carries role="banner" (the standard ARIA landmark for a page's
// masthead, e.g. Drupal themes default their header region to exactly
// this) or a class/id literally containing "banner"/"page-banner", with
// nothing to do with cookies. CMP_OVERLAY_SELECTORS/CONSENT_SELECTORS
// intentionally include bare `[class*="banner" i]` etc. as a catch-all
// for sites that DO name their cookie banner that way, but that same
// catch-all was matching deutschland.de's own site header/nav ("Skip to
// main content Open meta menu ... In focus: Working Studying ...")
// instead of the real Usercentrics dialog. Semantic landmarks (header,
// nav, footer, main, and their ARIA role equivalents) are never
// themselves a consent dialog - only a descendant of one could be, and
// that descendant will already be matched independently by its own
// selector/role. So the landmark itself is always safe to exclude.
function isSemanticNonConsentLandmark(node) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) {
    return false;
  }

  const role = (node.getAttribute('role') || '').toLowerCase();
  if (['banner', 'navigation', 'main', 'contentinfo'].includes(role)) {
    return true;
  }

  const tag = node.tagName ? node.tagName.toLowerCase() : '';
  return ['header', 'nav', 'footer', 'main'].includes(tag);
}

// FIX: NEW. Replaces a single-keyword-anywhere regex test with a
// density check requiring at least two DISTINCT consent-specific
// keyword hits. A long navigation/header text block can easily contain
// one incidental match (e.g. a "Manage account" link, or "policy" inside
// an unrelated category name) against the old single-match regex; a
// genuine cookie/consent dialog reliably contains several of these
// phrases together (cookie + consent/privacy/manage/accept-all, etc.).
function hasStrongConsentSignal(text) {
  if (!text) return false;
  const markerPattern = /(cookie|consent|gdpr|privacy policy|personal data|third[- ]party|advertising partner|similar technolog|tracking|manage cookies|cookie settings|accept all|reject all|allow all|essential cookies)/gi;
  const hits = text.match(markerPattern) || [];
  return hits.length >= 2;
}

function isConsentContainer(node) {
  if (!isVisible(node)) {
    return false;
  }

  // FIX: NEW - reject the page's own header/nav/footer/main landmarks
  // before any of the checks below get a chance to false-positive on
  // them (see isSemanticNonConsentLandmark() above).
  if (isSemanticNonConsentLandmark(node)) {
    return false;
  }

  // Strong CMP-specific identifiers: these are the parent dialog
  // containers for known consent platforms. Matching them here
  // prevents nested child elements (e.g. #cookiescript_header)
  // from being treated as separate consent containers.
  const nodeId = (node.id || '').toLowerCase();
  const nodeClass = typeof node.className === 'string'
    ? node.className.toLowerCase()
    : '';

  if (
    nodeId === 'uc-main-dialog' ||
    nodeId === 'cookiescript_injected' ||
    nodeClass.includes('cmp gdpr') ||
    nodeClass.split(/\s+/).includes('cmp') && nodeClass.split(/\s+/).includes('gdpr')
  ) {
    return true;
  }

  const text = getNodeText(node);

  if (text.length < 30) {
    return false;
  }

  const style = window.getComputedStyle(node);

  const isLayer =
    style.position === 'fixed' ||
    style.position === 'sticky' ||
    style.position === 'absolute';

  const isDialog =
    node.getAttribute('role') === 'dialog' ||
    node.getAttribute('aria-modal') === 'true';

  const actions = getActionNodes(node);

  if (!actions.length) {
    return false;
  }

  const hasCheckbox = Boolean(node.querySelector('input[type="checkbox"]'));
  const hasLink = Boolean(node.querySelector('a[href]'));

  const hasConsentAttribute = Array.from(node.attributes).some((attribute) =>
    /(cookie|consent|privacy|terms|legal|policy|banner|popup|notice)/i.test(
      `${attribute.name}=${attribute.value}`
    )
  );

  return (
    isDialog ||
    hasConsentAttribute ||
    (isLayer && (hasCheckbox || hasLink || actions.length <= 6))
  );
}

function getConsentContainers() {
  const nodes = new Set();

  for (const selector of CONSENT_SELECTORS) {
    document.querySelectorAll(selector).forEach((node) => {
      nodes.add(node);
    });
  }

  const candidates = Array.from(nodes)
    .filter((node) => isConsentContainer(node));

  // Remove descendants of stronger containers so nested CMP
  // elements (e.g. #cookiescript_header inside #cookiescript_injected)
  // are not treated as separate consent containers.
  const result = [];
  for (let i = 0; i < candidates.length; i += 1) {
    let isDescendant = false;
    for (let j = 0; j < candidates.length; j += 1) {
      if (i === j) continue;
      if (candidates[j].contains(candidates[i])) {
        isDescendant = true;
        break;
      }
    }
    if (!isDescendant) {
      result.push(candidates[i]);
    }
  }

  return result
    .map((node) => ({
      node,
      text: getNodeText(node)
    }))
    .sort((left, right) => left.text.length - right.text.length);
}

function findConsentContainersInNode(rootNode) {
  if (!rootNode || rootNode.nodeType !== Node.ELEMENT_NODE) {
    return [];
  }

  const results = new Set();
  const selector = CONSENT_SELECTORS.join(',');

  if (rootNode.matches?.(selector)) {
    results.add(rootNode);
  }

  rootNode.querySelectorAll?.(selector).forEach((node) => {
    results.add(node);
  });

  const candidates = Array.from(results).filter((node) => isConsentContainer(node));

  // Remove descendants of stronger containers so nested CMP
  // elements are not treated as separate consent containers.
  const filtered = [];
  for (let i = 0; i < candidates.length; i += 1) {
    let isDescendant = false;
    for (let j = 0; j < candidates.length; j += 1) {
      if (i === j) continue;
      if (candidates[j].contains(candidates[i])) {
        isDescendant = true;
        break;
      }
    }
    if (!isDescendant) {
      filtered.push(candidates[i]);
    }
  }

  return filtered;
}

// FIX: extracted from what used to be inline, duplicated logic at the top
// of extractMainText(). Previously hasLegalSurface() (called by popup.js
// via the legal_surface field) did NOT use this logic at all - it only
// checked LEGAL_URL_REGEX against the raw URL and whether a consent
// popup was currently open. That meant a dedicated legal page like
// visit.varna.bg/bg/declaration-personal-data.html - whose URL doesn't
// contain any LEGAL_URL_KEYWORDS word and which has no active cookie
// banner - was reported as legal_surface: false even though
// extractMainText() itself would have classified it correctly via its
// own (until now, private) isLegalPage check. Both call sites now share
// this single function so they can never disagree again.
function detectLegalPageSignals() {
  const headingText = Array.from(document.querySelectorAll('h1, h2'))
    .slice(0, 5)
    .map((heading) => getNodeText(heading))
    .join(' ');

  const urlKeywordMatch = DEDICATED_LEGAL_URL_KEYWORDS.some((kw) =>
    window.location.href.toLowerCase().includes(kw)
  );

  const transliteratedUrl = transliterateLatinToCyrillicBG(window.location.href);
  const urlTransliteratedMatch = LEGAL_URL_REGEX.test(transliteratedUrl);

  const headingKeywordMatch = LEGAL_PAGE_REGEX.test(
    `${document.title} ${headingText}`
  );

  return {
    isLegalPage: urlKeywordMatch || urlTransliteratedMatch || headingKeywordMatch,
    urlKeywordMatch,
    urlTransliteratedMatch,
    transliteratedUrl,
    headingKeywordMatch,
    headingText,
  };
}

function hasLegalSurface() {
  // FIX: previously only checked the raw URL against LEGAL_URL_REGEX and
  // whether a consent popup happened to be open at this exact moment.
  // Now reuses the same heading/URL/transliteration signal that
  // extractMainText() already computes, so a dedicated legal page is
  // recognized even with no active cookie banner and a URL that doesn't
  // contain an English legal keyword.
  if (detectLegalPageSignals().isLegalPage) {
    return true;
  }

  if (LEGAL_URL_REGEX.test(window.location.href)) {
    return true;
  }

  return getConsentContainers().length > 0;
}

function normalizeLegalUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    let path = parsed.pathname;
    if (path.length > 1 && path.endsWith('/')) {
      path = path.slice(0, -1);
    }
    parsed.pathname = path;
    return parsed.origin + parsed.pathname + parsed.search;
  } catch {
    return url.split('#')[0].replace(/\/$/, '');
  }
}

// FIX: NEW. Reads the domain-level legal URL cache written by
// discoverDomainLegalLinks() below.
async function readDomainLegalCache(origin) {
  try {
    const key = DOMAIN_LEGAL_CACHE_PREFIX + origin;
    const result = await chrome.storage.local.get(key);
    const cached = result[key];

    if (
      cached &&
      typeof cached.timestamp === 'number' &&
      Date.now() - cached.timestamp < DOMAIN_LEGAL_CACHE_TTL &&
      Array.isArray(cached.urls)
    ) {
      return cached.urls;
    }
  } catch (error) {
    // ignore, treat as cache miss
  }

  return null;
}

async function writeDomainLegalCache(origin, urls) {
  try {
    const key = DOMAIN_LEGAL_CACHE_PREFIX + origin;
    await chrome.storage.local.set({
      [key]: { timestamp: Date.now(), urls },
    });
  } catch (error) {
    // ignore, non-fatal
  }
}

// FIX: NEW. Domain-scoped fallback for when the CURRENT page's own DOM
// has no anchor matching LEGAL_URL_REGEX (findLegalLinks() returned
// empty). Instead of giving up, this asks background.js to look at the
// site's robots.txt/sitemap.xml and, failing that, probe a short list of
// well-known legal-page URL slugs (see DOMAIN-LEVEL LEGAL PAGE DISCOVERY
// in background.js). Cached per-origin so this network round-trip only
// happens once per site per DOMAIN_LEGAL_CACHE_TTL, not on every page.
async function discoverDomainLegalLinks() {
  const origin = window.location.origin;

  const cached = await readDomainLegalCache(origin);
  if (cached !== null) {
    console.log('NexusKitty [DIAG]: domain legal cache hit for', origin, '->', cached);
    return cached;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'NEXUSKITTY_DISCOVER_LEGAL_URLS',
      origin,
    });

    const urls = response?.ok && Array.isArray(response.urls) ? response.urls : [];

    console.log('NexusKitty [DIAG]: domain legal discovery for', origin, '->', urls);

    // Cache even an empty result so we don't re-probe a site that
    // genuinely has no discoverable legal pages on every single page
    // load - it will simply be re-tried after the TTL expires.
    await writeDomainLegalCache(origin, urls);

    return urls;
  } catch (error) {
    console.debug('NexusKitty: domain legal discovery failed.', error?.message || error);
    return [];
  }
}

function findLegalLinks() {
  const links = Array.from(document.querySelectorAll('a[href]'));

  const uniqueLinks = [];
  const seen = new Set();

  for (const link of links) {
    const href = link.href;
    const text = link.textContent || link.getAttribute('aria-label') || '';

    if (
      !href ||
      href.startsWith('javascript:') ||
      href.startsWith('#') ||
      !LEGAL_URL_REGEX.test(`${href} ${text}`)
    ) {
      continue;
    }

    const normalized = normalizeLegalUrl(href);
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);

    uniqueLinks.push({
      href,
      text: cleanText(text)
    });

    if (uniqueLinks.length >= MAX_LEGAL_LINKS) {
      break;
    }
  }

  return uniqueLinks;
}

async function fetchLegalPageText(url) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'NEXUSKITTY_FETCH_URL',
      url
    });

    if (!response?.ok || !response.html) {
      return '';
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(response.html, 'text/html');

    doc
      .querySelectorAll('script, style, nav, header, footer, svg, noscript')
      .forEach((el) => el.remove());

    const mainNode = doc.querySelector(
      'main, article, [role="main"], .content, #content, body'
    );

    if (!mainNode) {
      return '';
    }

    return cleanText(mainNode.textContent || mainNode.innerText || '');
  } catch (err) {
    return '';
  }
}

const CMP_IFRAME_HOST_PATTERN =
  /(onetrust|cookielaw|didomi|trustarc|evidon|quantcast|cybot|cookiebot|usercentrics|sourcepoint|sp[-_.]?prod|privacy-mgmt|consentmanager|iubenda|termly|axeptio|cmp\.|cookie-script|consensu)/i;

function getConsentIframeCandidates() {
  return Array.from(document.querySelectorAll('iframe[src]'))
    .filter((iframe) => {
      if (!isVisible(iframe)) {
        return false;
      }

      const src = iframe.src || '';

      if (!src || src.startsWith('about:') || src.startsWith('javascript:')) {
        return false;
      }

      if (CMP_IFRAME_HOST_PATTERN.test(src)) {
        return true;
      }

      const style = window.getComputedStyle(iframe);
      const rect = iframe.getBoundingClientRect();
      const isOverlayLayer = ['fixed', 'sticky', 'absolute'].includes(style.position);
      const isLargeEnough = rect.width >= 200 && rect.height >= 150;

      return isOverlayLayer && isLargeEnough;
    })
    .map((iframe) => iframe.src)
    .filter((src, index, array) => array.indexOf(src) === index)
    .slice(0, 3);
}

async function fetchIframeConsentText(url) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'NEXUSKITTY_FETCH_URL',
      url
    });

    if (!response?.ok || !response.html) {
      return '';
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(response.html, 'text/html');

    doc.querySelectorAll('script, style, svg, noscript').forEach((el) => el.remove());

    return cleanText(doc.body ? (doc.body.textContent || doc.body.innerText || '') : '');
  } catch (err) {
    return '';
  }
}

const CMP_DETAIL_SELECTORS = [
  '#CookiebotWidget', '#CybotCookiebotDialog', '.cc-btn', '.cc-link',
  '[id*="cookiebot"]', '[class*="cookiebot"]',
  '#onetrust-policy', '#onetrust-consent-sdk', '.ot-pc-footer', '.ot-pc-header',
  '[id*="onetrust"]', '[class*="onetrust"]',
  '#didomi-popup', '[id*="didomi"]', '[class*="didomi"]',
  '[data-testid*="uc-"]', '[class*="usercentrics"]',
  '[class*="iubenda"]', '[id*="iubenda"]',
  '[class*="termly"]', '[id*="termly"]',
  '[id*="details"]', '[class*="details"]',
  '[id*="accordion"]', '[class*="accordion"]',
  '[id*="vendor"]', '[class*="vendor"]',
  '[id*="purpose"]', '[class*="purpose"]',
  '[id*="category"]', '[class*="category"]',
  '[id*="cookie-table"]', '[class*="cookie-table"]',
  '[id*="cookie-list"]', '[class*="cookie-list"]',
  '[id*="partner"]', '[class*="partner"]',
  '[id*="third-party"]', '[class*="third-party"]',
  '.cookie-consent-details', '.consent-details', '.vendor-list', '.purpose-list',
  '.cookie-policy-details',
  '[role="tabpanel"]', '[aria-hidden="true"]',
  'details > summary', 'details[open]',
  '[data-tab]', '[data-panel]',
  '#uc-privacy-title', '#uc-privacy-description', '.privacy-title', '.privacy-text',
  '#cookiescript_header', '#cookiescript_description', '#cookiescript_buttons',
  '#cookiescript_checkboxs', '#cookiescript_readmore',
  '.uc-cmp-btn', '.uc-btn', '.cs-btn', '.cookie-script-btn',
];

function extractCMPDetails(cmpElement) {
  if (!cmpElement) return '';

  let combinedText = getNodeText(cmpElement);

  const detailElements = cmpElement.querySelectorAll(CMP_DETAIL_SELECTORS.join(', '));

  for (const detailEl of detailElements) {
    if (detailEl === cmpElement) continue;

    const detailText = getNodeText(detailEl);
    if (detailText && detailText.length > 20) {
      if (!combinedText.includes(detailText.slice(0, 50))) {
        combinedText += '\n\n[CMP Detail Section]\n' + detailText;
      }
    }
  }

  const hiddenPanels = cmpElement.querySelectorAll(
    '[role="tabpanel"], [aria-hidden="true"], details:not([open]), .hidden, [style*="display: none"], [style*="visibility: hidden"]'
  );

  for (const panel of hiddenPanels) {
    const panelText = getNodeText(panel);
    if (panelText && panelText.length > 30 && !combinedText.includes(panelText.slice(0, 50))) {
      combinedText += '\n\n[CMP Hidden Panel]\n' + panelText;
    }
  }

  return combinedText.slice(0, MAX_TEXT_LENGTH);
}

function getActiveConsentPopup() {
  const activeSelectors = [
    ...CMP_OVERLAY_SELECTORS,
    '[role="dialog"]',
    '[role="alertdialog"]',
    '[aria-modal="true"]'
  ];

  const elements = document.querySelectorAll(activeSelectors.join(', '));

  for (const el of elements) {
    if (!isVisible(el)) {
      continue;
    }

    // FIX: NEW - this loop previously had NO landmark exclusion and
    // accepted a single incidental keyword match anywhere in the
    // element's text. That's how deutschland.de's own <header>/nav
    // ("Skip to main content Open meta menu ... In focus: Working
    // Studying ...") got matched via the bare `[class*="banner" i]` /
    // `[id*="banner" i]` entries in CMP_OVERLAY_SELECTORS and returned
    // as if it were the real Usercentrics consent dialog - see
    // isSemanticNonConsentLandmark() and hasStrongConsentSignal() above.
    if (isSemanticNonConsentLandmark(el)) {
      continue;
    }

    const fullCmpText = extractCMPDetails(el);

    if (
      fullCmpText.length >= 30 &&
      hasStrongConsentSignal(fullCmpText)
    ) {
      return { node: el, text: fullCmpText };
    }
  }

  const containers = getConsentContainers();
  if (containers.length > 0) {
    const fullText = extractCMPDetails(containers[0].node);
    return {
      node: containers[0].node,
      text: fullText
    };
  }

  return null;
}

async function extractMainText() {
  console.log('NexusKitty [DIAG]: extractMainText() started for', window.location.href);

  if (isTechnicalCmpIframe()) {
    console.log('[NEXUSKITTY] Skipping technical CMP iframe:', window.location.href);
    return '';
  }

  // FIX: now delegates to the shared detectLegalPageSignals() instead of
  // recomputing urlKeywordMatch/urlTransliteratedMatch/headingKeywordMatch
  // locally. hasLegalSurface() above uses the exact same function, so the
  // two can never disagree again.
  const signals = detectLegalPageSignals();
  const {
    isLegalPage,
    urlKeywordMatch,
    urlTransliteratedMatch,
    transliteratedUrl,
    headingKeywordMatch,
    headingText,
  } = signals;

  console.log(
    'NexusKitty [DIAG]: isLegalPage =', isLegalPage,
    '(urlKeywordMatch =', urlKeywordMatch,
    ', urlTransliteratedMatch =', urlTransliteratedMatch, '[', transliteratedUrl, ']',
    ', headingKeywordMatch =', headingKeywordMatch, ')',
    'headingText =', JSON.stringify(headingText.slice(0, 200)),
    'title =', document.title
  );

  let legalLinks = findLegalLinks();

  console.log(
    'NexusKitty [DIAG]: STEP_1 findLegalLinks() found', legalLinks.length, 'link(s):',
    legalLinks
  );

  // FIX: NEW. The current page's own DOM had no anchor pointing to a
  // legal page (e.g. collapsed/JS-driven footer nav, or a page that
  // simply doesn't link to Privacy/Terms at all, like a search-result
  // page on a large multi-page site). Fall back to domain-level
  // discovery (sitemap/robots.txt + well-known path guessing, cached
  // per-origin) instead of proceeding straight to the noisy local/body
  // fallbacks below.
  if (legalLinks.length === 0) {
    const domainUrls = await discoverDomainLegalLinks();

    if (domainUrls.length) {
      legalLinks = domainUrls.map((href) => ({ href, text: '' }));
      console.log(
        'NexusKitty [DIAG]: STEP_1b using', legalLinks.length,
        'domain-discovered legal link(s) as fallback:', legalLinks
      );
    }
  }

  function textSignature(text) {
  if (!text) return '';
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  let hash = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

  let fetchedPagesText = '';

  if (legalLinks.length > 0) {
    const pageTexts = await Promise.all(
      legalLinks.map(async (link) => {
        const text = await fetchLegalPageText(link.href);
        console.log(`NexusKitty [DIAG]: STEP_1 fetched "${link.href}" -> ${text.length} chars`);
        return text;
      })
    );

    const seenSignatures = new Set();
    const deduped = [];

    for (const text of pageTexts) {
      if (text.length <= 200) continue;
      const sig = textSignature(text);
      if (seenSignatures.has(sig)) continue;
      seenSignatures.add(sig);
      deduped.push(text);
    }

    fetchedPagesText = deduped.join('\n\n--- NEXT LEGAL SECTION ---\n\n');
  }

  console.log('NexusKitty [DIAG]: STEP_1 fetchedPagesText length =', fetchedPagesText.length);

  let dedicatedPageText = '';

  if (isLegalPage) {
    console.log('NexusKitty: Dedicated legal page detected. Extracting full page content.');

    let baseText = getMainDocumentText();
    console.log('NexusKitty [DIAG]: STEP_2 getMainDocumentText() length =', baseText.length);

    if (!baseText || baseText.length <= 400) {
      const bodyText = getTextExcludingOverlays(document.body);
      console.log('NexusKitty [DIAG]: STEP_2 fallback getTextExcludingOverlays(body) length =', bodyText.length);
      if (bodyText && bodyText.length > baseText.length) {
        baseText = bodyText;
      }
    }

    if (baseText && baseText.length > 100) {
      dedicatedPageText = baseText;
    }

    console.log('NexusKitty [DIAG]: STEP_2 dedicatedPageText length =', dedicatedPageText.length);
  }

  const activePopup = getActiveConsentPopup();

  let popupText = activePopup?.text || '';
  console.log('NexusKitty [DIAG]: STEP_3 getActiveConsentPopup() text length =', popupText.length, 'node =', activePopup?.node);

  console.log('NexusKitty [DIAG]: receivedIframeConsentText length =', receivedIframeConsentText.length);
  if (receivedIframeConsentText.length > popupText.length) {
    popupText = receivedIframeConsentText;
  }

  if (popupText.length < 150) {
    const iframeCandidates = getConsentIframeCandidates();

    if (iframeCandidates.length) {
      console.log('NexusKitty [debug]: trying cross-origin consent iframe(s):', iframeCandidates);

      const iframeTexts = await Promise.all(
        iframeCandidates.map((src) => fetchIframeConsentText(src))
      );

      const combinedIframeText = iframeTexts
        .filter((text) => text.length > 80)
        .join('\n\n--- NEXT CONSENT FRAME ---\n\n');

      console.log(`NexusKitty [debug]: recovered ${combinedIframeText.length} chars from consent iframe(s)`);

      if (combinedIframeText.length > popupText.length) {
        popupText = combinedIframeText;
      }
    }
  }

  const structuralConsent = getConsentContainers();
  const structuralBannerText = structuralConsent.length
    ? structuralConsent[0].text.slice(0, BANNER_BUDGET)
    : '';

  console.log(
    'NexusKitty [DIAG]: STEP_3 structuralConsent containers count =', structuralConsent.length,
    'structuralBannerText length =', structuralBannerText.length
  );

  const bannerText = popupText.length >= structuralBannerText.length
    ? popupText
    : structuralBannerText;

  console.log('NexusKitty [DIAG]: STEP_3 final bannerText length =', bannerText.length);

  let bestLocalText = '';

  // FIX: previously this ran whenever there was no dedicatedPageText,
  // regardless of whether a real active consent popup (bannerText) had
  // already been captured. cookieMarkers is a broad regex (matches
  // "policy", "terms", "legal", "conditions" etc.), so on a page whose
  // ordinary content happens to use those words a lot (e.g. a general
  // article about German economic/social "policy"), the ENTIRE
  // main/article text could get picked up here as a false-positive
  // "cookie-related" candidate and appended as [Extracted Local Section]
  // right alongside the real [Active Consent Popup] section - diluting
  // the actual banner content with thousands of characters of unrelated
  // page text and making the LLM undervalue (or overlook) the real
  // consent choices. Skip this fallback entirely once a substantial
  // active popup has already been captured; the popup already answers
  // the "what happens if you click things on this page" question this
  // fallback exists for.
  if (!dedicatedPageText && bannerText.length < 150) {
    const selectors = [
      '[role="dialog"]', '[aria-modal="true"]',
      '[id*="cookie" i]', '[class*="cookie" i]',
      '[id*="consent" i]', '[class*="consent" i]',
      '[data-testid*="cookie" i]',
      '[id*="privacy" i]', '[class*="privacy" i]',
      'main', 'article', '[role="main"]',
      '.terms', '.privacy-policy', '.terms-of-service', '.cookie-policy',
      '#content', '.content'
    ];

    const candidates = [];
    const seenNodes = new Set();

    console.log('NexusKitty [DIAG]: STEP_4 local-candidate scan starting');

    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((node) => {
        if (seenNodes.has(node) || !isVisible(node)) {
          return;
        }

        seenNodes.add(node);

        const text = getNodeText(node);

        const minLength = ['main', 'article', '#content', '.content'].includes(
          selector
        )
          ? 400
          : 120;

        if (text && text.length >= minLength) {
          candidates.push({ node, text, selector });
        }
      });
    }

    const cookieMarkers =
      /(cookie|cookies|consent|personal data|advertising partner|similar technolog|terms|conditions|privacy|policy|legal|accept|agree|acknowledge)/i;

    const cookieMarkerCount =
      /(cookie|cookies|consent|personal data|advertising partner|similar technolog|terms|conditions|privacy|policy|legal|accept|agree|acknowledge)/gi;

    const cookieCandidate = candidates
      .filter((candidate) => cookieMarkers.test(candidate.text))
      .sort((left, right) => {
        const leftPriority = /(cookie|consent|terms|privacy|legal|dialog|modal)/i.test(
          left.selector
        )
          ? 100
          : 0;

        const rightPriority = /(cookie|consent|terms|privacy|legal|dialog|modal)/i.test(
          right.selector
        )
          ? 100
          : 0;

        const leftScore =
          leftPriority +
          (left.text.match(cookieMarkerCount) || []).length * 10 -
          left.text.length / 1000;

        const rightScore =
          rightPriority +
          (right.text.match(cookieMarkerCount) || []).length * 10 -
          right.text.length / 1000;

        return rightScore - leftScore;
      })[0];

    console.log(
      'NexusKitty [DIAG]: STEP_4 candidates found =', candidates.length,
      'cookieCandidate =', cookieCandidate ? { selector: cookieCandidate.selector, textLength: cookieCandidate.text.length, preview: cookieCandidate.text.slice(0, 150), node: cookieCandidate.node } : null
    );

    if (cookieCandidate) {
      const linksTextLength = Array.from(
        cookieCandidate.node.querySelectorAll('a, button')
      ).reduce((acc, el) => acc + (el.textContent || '').length, 0);

      if (
        !(
          linksTextLength / Math.max(cookieCandidate.text.length, 1) > 0.6 &&
          !isLegalPage
        )
      ) {
        bestLocalText = cookieCandidate.text.slice(0, BANNER_BUDGET);
      }
    }
  } else {
    console.log(
      'NexusKitty [DIAG]: STEP_4 skipped (dedicatedPageText available =', Boolean(dedicatedPageText),
      ', bannerText length =', bannerText.length, ')'
    );
  }

  console.log('NexusKitty [DIAG]: STEP_4 bestLocalText length =', bestLocalText.length);

  const sections = [];

  if (bannerText) {
    sections.push(`[Active Consent Popup / Cookie Banner]\n${bannerText}`);
  }

  if (dedicatedPageText) {
    sections.push(`[Main Document]\n${dedicatedPageText}`);
  } else if (bestLocalText) {
    sections.push(`[Extracted Local Section]\n${bestLocalText}`);
  }

  if (fetchedPagesText) {
    sections.push(`[Auto-Fetched Linked Policies]\n${fetchedPagesText}`);
  }

  const combinedResult = sections.join('\n\n').trim();

  console.log('NexusKitty [DIAG]: STEP_5 combinedResult length =', combinedResult.length);

  if (combinedResult.length > 100) {
    console.log('NexusKitty [DIAG]: RETURN via STEP_5 (combinedResult)');
    return combinedResult.slice(0, MAX_TEXT_LENGTH);
  }

  // FIX: previously this read document.body.innerText/textContent
  // directly, with NO filtering at all - unlike every other extraction
  // path in this file. When innerText happened to be empty (e.g. scan ran
  // before paint), it fell back to textContent, which does NOT respect
  // display:none and - critically - exposes the literal, unparsed markup
  // inside <noscript> tags as raw text once scripting is enabled (e.g. a
  // Google Tag Manager <noscript><iframe src="...googletagmanager.com...">
  // snippet), because the browser treats <noscript> content as a plain
  // text node rather than child elements when JS is on. That's exactly
  // what showed up as analyzed "content" for home.abv.bg. Reusing
  // getTextExcludingOverlays(), which already strips script/style/
  // noscript/svg and known CMP overlay selectors everywhere else in this
  // file, fixes it here too.
  const fallback = getTextExcludingOverlays(document.body)
    || cleanText(document.body?.innerText || '');

  console.log('NexusKitty [DIAG]: FINAL FALLBACK document.body text length =', fallback.length);

  if (fallback.length > 300) {
    console.log('NexusKitty [DIAG]: RETURN via FINAL FALLBACK (body text)');
    return fallback.slice(0, MAX_TEXT_LENGTH);
  }
console.log('NexusKitty [DIAG]: RETURN via FINAL FALLBACK (literal "No readable text" message)');

  console.log('[NEXUSKITTY FALLBACK CREATED]', {
    url: location.href,
    readyState: document.readyState,
    bodyTextLength: document.body?.innerText?.length || 0
  });

  return 'No readable text found on this page.';
}

const KNOWN_TRACKER_DOMAINS = [
  'google-analytics.com', 'analytics.google.com', 'googletagmanager.com',
  'googletagservices.com', 'googlesyndication.com', 'googleadservices.com',
  'doubleclick.net', 'connect.facebook.net', 'hotjar.com', 'hotjar.io',
  'clarity.ms', 'bat.bing.com', 'criteo.com', 'criteo.net', 'taboola.com',
  'outbrain.com', 'adnxs.com', 'scorecardresearch.com', 'amazon-adsystem.com',
  'quantserve.com', 'pubmatic.com', 'rubiconproject.com', 'openx.net',
  'casalemedia.com', 'adsrvr.org', 'snap.licdn.com', 'px.ads.linkedin.com',
  'ads-twitter.com', 'analytics.tiktok.com', 'ct.pinterest.com',
  'mc.yandex.ru', 'fullstory.com', 'segment.io', 'segment.com',
  'mixpanel.com', 'amplitude.com', 'chartbeat.com', 'chartbeat.net',
  'parsely.com', 'permutive.com', 'bluekai.com', 'krxd.net', 'demdex.net',
  'omtrdc.net', '2o7.net', 'everesttech.net', 'adobedtm.com', 'moatads.com',
  'adform.net', 'smartadserver.com', 'teads.tv', 'yieldmo.com',
  'sharethrough.com', '3lift.com', 'indexww.com', 'bidswitch.net',
  'mathtag.com', 'tapad.com', 'liveramp.com', 'rlcdn.com', 'id5-sync.com',
  'crwdcntrl.net', 'agkn.com', 'addthis.com', 'sharethis.com'
];

function detectTrackers() {
  const currentHost = window.location.hostname;
  const found = new Set();

  for (const entry of performance.getEntriesByType('resource')) {
    try {
      const host = new URL(entry.name).hostname;

      if (!host || host === currentHost) {
        continue;
      }

      const isTracker = KNOWN_TRACKER_DOMAINS.some(
        (domain) => host === domain || host.endsWith('.' + domain)
      );

      if (isTracker) {
        found.add(host);
      }
    } catch {
      // ignore malformed URLs
    }
  }

  return [...found];
}

function isExplicitConsentButton(element) {
  if (!element || !isVisible(element)) {
    return false;
  }

  const text = (
    element.textContent ||
    element.value ||
    element.getAttribute('aria-label') ||
    ''
  ).trim();

  if (!text) {
    return false;
  }

  const pageIsLegal = LEGAL_URL_REGEX.test(window.location.href);
  const inConsentContainer = Boolean(
    element.closest(CONSENT_SELECTORS.join(',')) ||
    element.closest('[role="dialog"], [aria-modal="true"]')
  );

  const strictConsentPhrases =
    /(i agree|accept terms|accept all|agree to terms|accept privacy|accept policy|accept cookies|reject all|decline|refuse|manage cookies|cookie settings|privacy settings|policy settings|allow all|allow essential cookies|allow cookies|essential cookies)/i;

  if (strictConsentPhrases.test(text)) {
    return inConsentContainer || pageIsLegal;
  }

  const shortPhrases = /^(ok|accept|agree|allow|settings|preferences)$/i;

  if (shortPhrases.test(text)) {
    const parentContext =
      element.closest('[role="dialog"], [aria-modal="true"]')?.textContent ||
      element.parentElement?.textContent ||
      '';

    return /(cookie|cookies|consent|privacy|policy|personal data|data protection)/i.test(
      parentContext
    );
  }

  return false;
}

function findConsentButtons() {
  const selectors = [
    'button', 'input[type="button"]', 'input[type="submit"]', '[role="button"]', 'a'
  ];

  const structuralContainers = getConsentContainers();

  if (structuralContainers.length) {
    const buttons = structuralContainers[0].node.querySelectorAll(
      selectors.join(',')
    );

    const result = Array.from(buttons).filter((element) =>
      isExplicitConsentButton(element)
    );

    if (result.length) {
      return result;
    }
  }

  const legalPageButtons = Array.from(
    document.querySelectorAll(
      'main button, article button, [role="main"] button, main [role="button"], article [role="button"]'
    )
  ).filter((button) => {
    const form = button.closest('form');

    if (!form) {
      return false;
    }

    return Boolean(
      form.querySelector('input[type="checkbox"]') ||
        Array.from(form.querySelectorAll('a[href]')).some((link) =>
          /(terms|condition|privacy|cookie|legal|policy|rights|gdpr|data)/i.test(
            link.href
          )
        )
    );
  });

  if (legalPageButtons.length) {
    const result = legalPageButtons.filter((element) =>
      isExplicitConsentButton(element)
    );

    if (result.length) {
      return result;
    }
  }

  return Array.from(document.querySelectorAll(selectors.join(','))).filter(
    (element) => isExplicitConsentButton(element)
  );
}

function getConsentSnapshot() {
  return findConsentButtons()
    .map((element) => {
      const rawText =
        element.textContent ||
        element.value ||
        element.getAttribute('aria-label') ||
        '';

      const label = cleanText(rawText);

      let action = 'accept';

      if (/(reject|decline|refuse)/i.test(rawText)) {
        action = 'reject';
      } else if (/(manage|settings|preferences)/i.test(rawText)) {
        action = 'manage';
      }

      return { label, action };
    })
    .filter((button) => button.label);
}

let domainDisabled = false;
let domainSettingsLoaded = false;
let observerTimer = null;

let receivedIframeConsentText = '';

let iframeRelayReanalysisTimer = null;
let lastReanalyzedIframeTextLength = 0;
let lastSentPageSignature = '';

function computePageSignature(payload) {
  if (!payload) return '';
  const parts = [
    window.location.href,
    payload.text || '',
    Array.isArray(payload.detected_trackers) ? payload.detected_trackers.join('|') : '',
    Array.isArray(payload.consent_controls) ? payload.consent_controls.map((c) => c.text || c.label || '').join('|') : '',
  ];
  const raw = parts.join('\x00');
  let hash = 0;
  for (let i = 0; i < raw.length; i += 1) {
    hash = (hash * 31 + raw.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

function scheduleReanalysisAfterIframeRelay() {
  if (isDomainDisabledSync()) {
    return;
  }

  if (receivedIframeConsentText.length <= lastReanalyzedIframeTextLength) {
    return;
  }

  if (iframeRelayReanalysisTimer) {
    clearTimeout(iframeRelayReanalysisTimer);
  }

  iframeRelayReanalysisTimer = setTimeout(async () => {
    iframeRelayReanalysisTimer = null;

    if (isDomainDisabledSync()) {
      return;
    }

    lastReanalyzedIframeTextLength = receivedIframeConsentText.length;

    try {
      const payload = await buildPagePayload(true);

      if (payload?.text?.length > 0) {
        const signature = computePageSignature(payload);
        if (signature && signature === lastSentPageSignature) {
          return;
        }
        lastSentPageSignature = signature;

        try {
          await chrome.storage.local.set({
            [`nexuskitty_page_${window.location.href}`]: payload.text
          });
        } catch (error) {}

        console.log('[NEXUSKITTY REANALYSIS]', {
          url: location.href,
          textLength: payload?.text?.length || 0,
          textPreview: payload?.text?.slice(0, 500) || '',
          reason: 'iframe_relay_reanalysis',
          timestamp: Date.now()
        });

        try {
          await chrome.runtime.sendMessage({
            type: 'NEXUSKITTY_PAGE_DATA_UPDATED',
            payload
          });
        } catch (error) {}
      }
    } catch (error) {}
  }, 400);
}

async function loadDomainSettings() {
  if (domainSettingsLoaded) {
    return domainDisabled;
  }

  try {
    const domain = window.location.hostname;

    const result = await chrome.storage.local.get('disabledDomains');

    const disabledDomains = Array.isArray(result.disabledDomains)
      ? result.disabledDomains
      : [];

    domainDisabled = disabledDomains.includes(domain);
  } catch (error) {
    domainDisabled = false;
  } finally {
    domainSettingsLoaded = true;
  }

  return domainDisabled;
}

function isDomainDisabledSync() {
  return domainDisabled;
}

function removeAllHuds() {
  document
    .querySelectorAll('.nexuskitty-consent-hud')
    .forEach((el) => el.remove());
}

function removeRiskOutlines() {
  findConsentButtons().forEach((button) => {
    button.style.outline = '';
    button.style.boxShadow = '';
    button.title = '';
    removeConsentHud(button);
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.disabledDomains) {
    return;
  }

  const list = Array.isArray(changes.disabledDomains.newValue)
    ? changes.disabledDomains.newValue
    : [];

  domainDisabled = list.includes(window.location.hostname);
  domainSettingsLoaded = true;

  if (domainDisabled) {
    removeAllHuds();
    removeRiskOutlines();
  } else {
    applyRiskWarning(lastCategories, lastShouldWarn);
  }
});

function createConsentHud(button) {
  if (!button) {
    return;
  }

  if (button.querySelector('.nexuskitty-consent-hud')) {
    return;
  }

  const existingHud = button.parentElement?.querySelector(
    '.nexuskitty-consent-hud'
  );

  if (existingHud) {
    return;
  }

  const warning = document.createElement('div');

  warning.className = 'nexuskitty-consent-hud';
  warning.textContent = 'NK';

  warning.style.cssText = `
    display: inline-block;
    position: absolute;
    top: -9px;
    right: -7px;
    margin: 0;
    padding: 2px 5px;
    border-radius: 2px;
    font-size: 9px;
    line-height: 1;
    font-weight: 700;
    letter-spacing: 0.03em;
    color: #f4dfad;
    background: #302a24;
    border: 1px solid rgba(218, 174, 88, 0.65);
    box-shadow: 0 1px 5px rgba(0, 0, 0, 0.22);
    z-index: 999999;
    pointer-events: none;
  `;

  const parent = button.parentElement;

  if (!parent) {
    return;
  }

  if (getComputedStyle(parent).position === 'static') {
    parent.style.position = 'relative';
  }

  parent.appendChild(warning);
}

function removeConsentHud(button) {
  if (!button) return;
  const hud = button.querySelector('.nexuskitty-consent-hud');
  if (hud) hud.remove();
}

function getPageCacheKey() {
  try {
    const url = new URL(window.location.href);

    return CACHE_PREFIX + url.origin + url.pathname + url.search;
  } catch {
    return CACHE_PREFIX + window.location.href;
  }
}

async function readPageCache() {
  try {
    const key = getPageCacheKey();

    const result = await chrome.storage.local.get(key);
    const cached = result[key];

    if (
      cached &&
      cached.timestamp &&
      Date.now() - cached.timestamp < CACHE_TTL &&
      cached.payload
    ) {
      return cached.payload;
    }
  } catch (error) {}

  return null;
}

async function writePageCache(payload) {
  try {
    const key = getPageCacheKey();

    await chrome.storage.local.set({
      [key]: {
        timestamp: Date.now(),
        payload
      }
    });
  } catch (error) {}
}

async function pruneExpiredCache() {
  try {
    const { nk_last_prune: lastPrune = 0 } = await chrome.storage.local.get(
      'nk_last_prune'
    );

    if (Date.now() - lastPrune < CACHE_TTL) {
      return;
    }

    const all = await chrome.storage.local.get(null);

    const expired = Object.keys(all).filter(
      (key) =>
        key.startsWith(CACHE_PREFIX) &&
        (!all[key]?.timestamp || Date.now() - all[key].timestamp >= CACHE_TTL)
    );

    if (expired.length) {
      await chrome.storage.local.remove(expired);
    }

    await chrome.storage.local.set({ nk_last_prune: Date.now() });
  } catch (error) {}
}

async function translateTextToEnglish(text) {
  if (!text || !text.trim()) {
    return { text: text || '', detectedLang: null, translated: false };
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'NEXUSKITTY_TRANSLATE_TEXT',
      text
    });

    if (response?.ok && response.text) {
      return {
        text: response.text,
        detectedLang: response.detectedLang || null,
        translated: response.translated === true
      };
    }
  } catch (error) {
    console.debug('NexusKitty: translation relay failed, using original text.', error?.message || error);
  }

  return { text, detectedLang: null, translated: false };
}

async function extractDocumentTextAsync() {
  try {
    const text = await extractMainText();

    console.log('NexusKitty [DIAG]: extractDocumentTextAsync() using extractMainText() result, length =', text ? text.length : 0);

    if (text && text.trim().length >= 20 && text !== 'No readable text found on this page.') {
      return { source: 'zero_failure', text };
    }
  } catch (error) {
    console.error('NexusKitty: extractMainText() failed inside extractDocumentTextAsync(), falling back.', error);
  }

  let extractedText = "";

  try {
    const cmpNodes = document.querySelectorAll('#CybotCookiebotDialog, #CookiebotWidget, [id*="Cookiebot"], [id*="cmpbox"], [class*="cookie"]');
    cmpNodes.forEach(node => {
      extractedText += " " + (node.innerText || node.textContent || "");
    });

    if (window.Cookiebot && window.Cookiebot.decl) {
      extractedText += "\n\nCookiebot Declaration Data: " + JSON.stringify(window.Cookiebot.decl);
    }
  } catch (e) {}

  if (extractedText.trim().length < 100) {
    try {
      const legalLink = Array.from(document.querySelectorAll('a[href]')).find(a => {
        const h = a.href.toLowerCase();
        const t = (a.innerText || '').toLowerCase();
        return ['privacy', 'poveritelnost', 'terms', 'usloviya', 'cookie', 'biskvitki'].some(kw => h.includes(kw) || t.includes(kw));
      });
      if (legalLink && legalLink.href.startsWith('http')) {
        const html = await fetchLegalPageText(legalLink.href);
        if (html) {
          extractedText += "\n\n" + html;
        }
      }
    } catch (err) {}
  }

  if (extractedText.trim().length < 20) {
    // FIX: previously fell back to raw, unfiltered innerText/textContent
    // here too (same noscript-leak risk as the FINAL FALLBACK fix in
    // extractMainText() above). Now reuses the filtered helper, and the
    // NO_CONTENT_FALLBACK_PREFIX sentinel below is explicitly recognized
    // as "no real content" everywhere it's checked (buildPagePayload()),
    // so it can never be cached or sent to the backend as if it were a
    // real document - see the bg.pons.com case in the reported logs,
    // where this exact 45-char placeholder got analyzed as if it were
    // real page text.
    extractedText = getTextExcludingOverlays(document.body)
      || (NO_CONTENT_FALLBACK_PREFIX + window.location.hostname);
  }

  console.log('NexusKitty [DIAG]: extractDocumentTextAsync() using LAST-RESORT fallback, length =', extractedText.length);

  return { source: 'zero_failure_fallback', text: extractedText };
}

async function buildPagePayload(forceRefresh = false) {
  if (!forceRefresh) {
    const cached = await readPageCache();

    if (cached) {
      return cached;
    }
  }

  let text = await extractMainText();

  // If the initial extraction returned only the fallback message,
  // the page content may be loaded dynamically (SPA, late CMP,
  // async legal links). Use the more resilient extractDocumentTextAsync()
  // which also checks CMP nodes, legal links, and body text.
  if (!text || text.trim().length < 30 || text === 'No readable text found on this page.') {
    const asyncResult = await extractDocumentTextAsync();
    if (asyncResult?.text && asyncResult.text.trim().length > (text || '').trim().length) {
      text = asyncResult.text;
    }
  }

  // FIX: added the NO_CONTENT_FALLBACK_PREFIX check so the
  // "Legal analysis fallback for site: X" placeholder (produced by
  // extractDocumentTextAsync() as an absolute last resort) is recognized
  // as "no real content", exactly like the empty-text and
  // "No readable text found" cases already were. Previously this 45-ish
  // character placeholder string passed the `length < 30` check on sites
  // with a longer hostname and was cached/sent to the LLM as if it were
  // a genuine legal document (see bg.pons.com in the reported logs).
  const isFallback = !text
    || text.trim().length < 30
    || text === 'No readable text found on this page.'
    || text.startsWith(NO_CONTENT_FALLBACK_PREFIX);

  // If we only have the fallback, try to return a previously cached
  // valid payload instead of caching the fallback.
  if (isFallback && forceRefresh) {
    const cached = await readPageCache();
    if (
      cached &&
      cached.text &&
      cached.text.trim().length >= 30 &&
      cached.text !== 'No readable text found on this page.' &&
      !cached.text.startsWith(NO_CONTENT_FALLBACK_PREFIX)
    ) {
      console.log('[NEXUSKITTY] Fallback extracted but valid cache exists, returning cached payload');
      return cached;
    }
  }

  // Translate the extracted text to English before analysis, so that
  // the backend always receives a single language regardless of which
  // language the visited page (or its legal/cookie sub-pages) is in.
  // Runs from the service worker (see NEXUSKITTY_TRANSLATE_TEXT in
  // background.js) to avoid the visited page's own CSP.
  let analysisText = text;
  let detectedLanguage = null;
  let wasTranslated = false;

  if (!isFallback) {
    const translation = await translateTextToEnglish(text);
    analysisText = translation.text || text;
    detectedLanguage = translation.detectedLang;
    wasTranslated = translation.translated;

    console.log(
      'NexusKitty [DIAG]: translation detectedLanguage =', detectedLanguage,
      'wasTranslated =', wasTranslated,
      'analysisText length =', analysisText.length
    );
  }

  const trackers = detectTrackers();
  const consentControls = getConsentSnapshot();
  const legalSurface = hasLegalSurface();

  const payload = {
    text,
    // English text the analysis backend should use. Falls back to the
    // original text if translation failed or wasn't needed.
    analysis_text: analysisText,
    detected_language: detectedLanguage,
    translated: wasTranslated,
    trackers,
    detected_trackers: trackers,
    consent_controls: consentControls,
    legal_surface: legalSurface,
    url: window.location.href,
    hostname: window.location.hostname,
    title: document.title || ''
  };

  // Only write to cache if we have meaningful content (not the fallback).
  // This prevents a transient failed extraction from overwriting a valid cache.
  if (!isFallback) {
    await writePageCache(payload);
  } else {
    console.log('[NEXUSKITTY] Skipping cache write for fallback-only payload');
  }

  return payload;
}

async function applyRiskWarning(categories, shouldWarn) {
  if (isDomainDisabledSync()) {
    removeRiskOutlines();
    return;
  }

  if (!shouldWarn) {
    removeRiskOutlines();
    return;
  }

  findConsentButtons().forEach((button) => {
    button.style.outline = '3px solid #ff304f';

    button.style.boxShadow =
      '0 0 0 4px rgba(255, 48, 79, 0.28), 0 0 18px rgba(255, 48, 79, 0.8)';

    button.title =
      'WARNING: Clicking this may accept risky data or privacy terms.';

    createConsentHud(button);
  });
}

async function handleMessage(request, sender, sendResponse) {
  try {
    if (request && request.type === 'NEXUSKITTY_GET_PAGE_DATA') {
      const payload = await buildPagePayload(request.force_refresh === true);

      sendResponse({
        ok: true,
        ...payload
      });

      return;
    }

    if (request && request.type === 'NEXUSKITTY_GET_DOCUMENT_TEXT') {
      const result = await extractDocumentTextAsync();

      // FIX: previously this returned only {source, text, fetchedUrl}, which
      // forced popup.js to make a SECOND separate message round-trip
      // (NEXUSKITTY_GET_PAGE_DATA) just to also get trackers/consent_controls
      // /legal_surface. That second call ran extractMainText() a second,
      // fully independent time - doubling all the network fetches (legal
      // links, consent iframes) and risking the two calls seeing two
      // slightly different DOM states (e.g. banner dismissed in between),
      // so state.text and state.trackers/consent_controls could describe
      // two different moments. Computing these here (cheap, no extra
      // extraction pass) lets popup.js get everything in ONE call.
      const trackers = detectTrackers();
      const consentControls = getConsentSnapshot();
      const legalSurface = hasLegalSurface();

      let analysisText = result.text;
      let detectedLanguage = null;
      let wasTranslated = false;

      if (result.text && result.text.trim().length >= 30) {
        const translation = await translateTextToEnglish(result.text);
        analysisText = translation.text || result.text;
        detectedLanguage = translation.detectedLang;
        wasTranslated = translation.translated;
      }

      sendResponse({
        ok: true,
        source: result.source,
        text: result.text,
        analysis_text: analysisText,
        detected_language: detectedLanguage,
        translated: wasTranslated,
        trackers,
        detected_trackers: trackers,
        consent_controls: consentControls,
        legal_surface: legalSurface,
        fetchedUrl: result.fetchedUrl || null
      });

      return;
    }

    if (request && request.type === 'NEXUSKITTY_ANALYSIS_RESULT') {
      lastCategories = request.categories || [];
      lastShouldWarn = request.should_warn === true;

      await applyRiskWarning(
        lastCategories,
        lastShouldWarn
      );

      sendResponse({ ok: true });

      return;
    }

    if (request && request.type === 'NEXUSKITTY_IFRAME_CONSENT_TEXT_RELAY') {
      if (request.text && request.text.length > receivedIframeConsentText.length) {
        receivedIframeConsentText = request.text;
        console.log(
          `NexusKitty [debug]: received consent text relayed from cross-origin iframe (${request.frameUrl || 'unknown frame'}), length = ${receivedIframeConsentText.length}`
        );

        scheduleReanalysisAfterIframeRelay();
      }

      sendResponse({ ok: true });

      return;
    }

    sendResponse({
      ok: false,
      error: 'Unknown NexusKitty message type.'
    });
  } catch (error) {
    console.error('NexusKitty: Message handling failed.', error);

    sendResponse({
      ok: false,
      error: error?.message || 'Unknown content-script error.'
    });
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) {
    return false;
  }

  handleMessage(request, sender, sendResponse);

  return true;
});

const BUTTON_SELECTOR =
  'button, [role="button"], input[type="button"], input[type="submit"]';

function mutationLooksRelevant(mutation) {
  if (mutation.type !== 'childList') {
    return false;
  }

  for (const node of Array.from(mutation.addedNodes || [])) {
    if (node.nodeType !== Node.ELEMENT_NODE) {
      continue;
    }

    if (node.classList?.contains('nexuskitty-consent-hud')) {
      continue;
    }

    const consentContainers = findConsentContainersInNode(node);

    if (consentContainers.length) {
      return true;
    }

    if (node.matches?.(BUTTON_SELECTOR)) {
      if (isExplicitConsentButton(node)) {
        return true;
      }
    }

    const buttons = node.querySelectorAll?.(BUTTON_SELECTOR);

    if (buttons?.length) {
      for (const button of buttons) {
        if (isExplicitConsentButton(button)) {
          return true;
        }
      }
    }
  }

  return false;
}

let lastShouldWarn = false;
let lastCategories = [];

function scheduleConsentHudUpdate() {
  if (observerTimer) {
    clearTimeout(observerTimer);
  }

  observerTimer = setTimeout(() => {
    observerTimer = null;
    applyRiskWarning(lastCategories, lastShouldWarn);
  }, HUD_UPDATE_DELAY);
}

async function initContentScript() {
  try {
    await loadDomainSettings();

    const payload = isDomainDisabledSync()
      ? null
      : await buildPagePayload(false);

    if (payload?.text?.length > 0) {
      try {
        await chrome.storage.local.set({
          [`nexuskitty_page_${window.location.href}`]: payload.text
        });
      } catch (error) {}
    }

    pruneExpiredCache();

    const observer = new MutationObserver((mutations) => {
      if (isDomainDisabledSync()) {
        return;
      }

      const relevant = mutations.some((mutation) =>
        mutationLooksRelevant(mutation)
      );

      if (!relevant) {
        return;
      }

      scheduleConsentHudUpdate();
    });

    if (document.documentElement) {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true
      });
    }

    setTimeout(() => {
      if (!isDomainDisabledSync()) {
        scheduleConsentHudUpdate();
      }
    }, 1000);

    setTimeout(() => {
      if (!isDomainDisabledSync()) {
        scheduleConsentHudUpdate();
      }
    }, 3000);
  } catch (error) {
    console.error('NexusKitty: Content script initialization failed.', error);
  }
}

function detectOwnFrameConsentText() {
  const popup = getActiveConsentPopup();

  if (popup && popup.text && popup.text.length >= 80) {
    // Reject text that looks like minified JavaScript / SDK loader code
    // rather than actual consent UI text.
    const looksLikeJsCode = /function\s*\(\)\s*\{|var\s+\w+\s*=|postMessage\(|CookieConsentBulkSetting|handleRequest/.test(popup.text);
    if (!looksLikeJsCode) {
      return popup.text;
    }
  }

  const spNode = document.querySelector(
    '.message.type-modal, [class*="sp_choice_type"], #notice.message, [class*="message-component"]'
  );

  if (spNode) {
    const container = spNode.closest('.message, [role="dialog"], [aria-modal="true"], body') || spNode;
    const text = getNodeText(container);
    if (text && text.length >= 80) {
      const looksLikeJsCode = /function\s*\(\)\s*\{|var\s+\w+\s*=|postMessage\(|CookieConsentBulkSetting|handleRequest/.test(text);
      if (!looksLikeJsCode) {
        return text;
      }
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
      chrome.runtime.sendMessage({
        type: 'NEXUSKITTY_IFRAME_CONSENT_TEXT',
        text,
        frameUrl: window.location.href,
      }).catch(() => {});
    } else if (!text && window.location.hostname.includes('cookiebot')) {
      console.log('[NEXUSKITTY] Iframe consent text rejected (JS code / SDK):', window.location.href);
    }
  } catch (err) {}
}

if (window.self !== window.top) {
  const scheduleIframeReports = () => {
    reportIframeConsentText();
    setTimeout(reportIframeConsentText, 800);
    setTimeout(reportIframeConsentText, 2000);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleIframeReports, { once: true });
  } else {
    scheduleIframeReports();
  }
} else if (document.readyState === 'loading') {
  document.addEventListener(
    'DOMContentLoaded',
    () => {
      initContentScript();
    },
    { once: true }
  );
} else {
  initContentScript();
}