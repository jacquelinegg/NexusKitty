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
const BANNER_BUDGET = 1500; // max chars for banner/local text, so linked policies still fit
const CACHE_PREFIX = 'nk_cache_v4_';
const LEGAL_URL_KEYWORDS = [
  // English
  'terms', 'conditions', 'privacy', 'cookie', 'policy', 'legal', 'gdpr',
  // German
  'datenschutz', 'einwilligung', 'nutzungs',
  // French
  'politique', 'consentement',
  // Spanish
  'privacidad', 'consentimiento', 'condiciones',
  // Portuguese
  'privacidade', 'consentimento', 'condições',
  // Bulgarian
  'правила', 'поверителност', 'бисквитки', 'съгласие',
  // Russian
  'правила', 'политика', 'согласие',
  // Ukrainian
  'політика', 'згода',
  // Turkish
  'kişisel', 'çerez', 'onay', 'şartları',
  // Arabic
  'سياسة', 'خصوصية', 'موافقة',
  // Japanese
  'プライバシー', '同意', '利用規約',
  // Korean
  '개인정보', '동의', '이용',
  // Chinese
  '隐私', '同意', '使用条款',
  // Hindi
  'गोपनीयता', 'सहमति',
  // Thai
  'ความเป็น', 'การยินยอม',
  // Hebrew
  'פרטיות', 'הסכם',
  // Greek
  'προσωπικά', 'συγκατάθεση',
  // Polish
  'prywatność', 'ciasteczka', 'zgoda',
  // Czech
  'osobní', 'souhlas', 'podmínky',
];

const LEGAL_PAGE_REGEX = new RegExp(LEGAL_URL_KEYWORDS.join('|'), 'i');
const LEGAL_URL_REGEX = new RegExp(LEGAL_URL_KEYWORDS.join('|'), 'i');

/*
 * Selectors for cookie-consent overlays, modal dialogs, and CMP widgets
 * that should ALWAYS be excluded from the scraped document text.
 */
const CMP_OVERLAY_SELECTORS = [
  '[id*="onetrust" i]',
  '[class*="onetrust" i]',
  '[id*="didomi" i]',
  '[class*="didomi" i]',
  '[id*="cookielaw" i]',
  '[class*="cookielaw" i]',
  '[id*="cmp" i]',
  '[class*="cmp" i]',
  '[id*="trustarc" i]',
  '[class*="trustarc" i]',
  '[id*="evidon" i]',
  '[class*="evidon" i]',
  '[id*="quantcast" i]',
  '[class*="quantcast" i]',
  '[id*="cybot" i]',
  '[class*="cybot" i]',
  '[id*="usercentrics" i]',
  '[class*="usercentrics" i]',
  '[id*="sp_message" i]',
  '[class*="sp_message" i]',
  '[id*="iubenda" i]',
  '[class*="iubenda" i]',
  '[id*="termly" i]',
  '[class*="termly" i]',
  '[id*="cookie-script" i]',
  '[class*="cookie-script" i]',
  '[id*="axeptio" i]',
  '[class*="axeptio" i]',
  '[id*="fg-modal" i]',
  '[class*="fg-modal" i]',
  '[id*="cookie-banner" i]',
  '[class*="cookie-banner" i]',
  '[id*="consent-banner" i]',
  '[class*="consent-banner" i]',
  '[id*="cookie-wall" i]',
  '[class*="cookie-wall" i]',
  '[id*="modal-overlay" i]',
  '[class*="modal-overlay" i]',
  '[id*="lightbox" i]',
  '[class*="lightbox" i]',
  '[id*="backdrop" i]',
  '[class*="backdrop" i]',
  '[id*="flyout" i]',
  '[class*="flyout" i]',
  '[id*="drawer" i]',
  '[class*="drawer" i]',
  '[id*="interstitial" i]',
  '[class*="interstitial" i]',
  '[id*="takeover" i]',
  '[class*="takeover" i]',
  '[id*="sheet" i]',
  '[class*="sheet" i]',
  '[class*="overlay" i]',
  '[class*="modal" i]',
  '[class*="dialog" i]',
  '[class*="popup" i]',
  '[id*="modal" i]',
  '[id*="dialog" i]',
  '[id*="popup" i]',
  '[class*="notice" i]',
  '[id*="notice" i]',
  '[class*="alert" i]',
  '[id*="alert" i]',
  '[class*="disclaimer" i]',
  '[id*="disclaimer" i]',
  '[class*="banner" i]',
  '[id*="banner" i]',
  '[class*="sticky-footer" i]',
  '[id*="sticky-footer" i]',
  '[class*="bottom-bar" i]',
  '[id*="bottom-bar" i]',
  '[class*="privacy-prompt" i]',
  '[id*="privacy-prompt" i]',
  '[class*="gdpr-modal" i]',
  '[id*="gdpr-modal" i]',
  '[class*="consent-wall" i]',
  '[id*="consent-wall" i]',
  '[class*="tos-popup" i]',
  '[id*="tos-popup" i]',
  '[class*="terms-modal" i]',
  '[id*="terms-modal" i]',
  '[data-testid*="cookie" i]',
  '[data-testid*="consent" i]'
];

/* =========================================================
   ADVANCED MULTI-SOURCE EXTRACTION
   ========================================================= */

/* ---- Strategy 1: CMP Global Objects ---- */
function getCmpGlobalData() {
  let extraText = '';

  // Cookiebot
  if (window.Cookiebot && window.Cookiebot.decl) {
    try {
      extraText += '\n[Cookiebot Declaration]\n' + JSON.stringify(window.Cookiebot.decl, null, 2);
    } catch (e) {
      console.debug('NexusKitty: Cookiebot decl parse failed', e);
    }
  }

  // OneTrust
  if (window.OnetrustActiveGroups || window.OneTrust) {
    try {
      const otData = window.OneTrust || window.OnetrustActiveGroups;
      extraText += '\n[OneTrust Data]\n' + JSON.stringify(otData, null, 2);
    } catch (e) {
      console.debug('NexusKitty: OneTrust parse failed', e);
    }
  }

  // Usercentrics
  if (window.Usercentrics) {
    try {
      extraText += '\n[Usercentrics Data]\n' + JSON.stringify(window.Usercentrics, null, 2);
    } catch (e) {
      console.debug('NexusKitty: Usercentrics parse failed', e);
    }
  }

  // Didomi
  if (window.Didomi) {
    try {
      extraText += '\n[Didomi Data]\n' + JSON.stringify(window.Didomi, null, 2);
    } catch (e) {
      console.debug('NexusKitty: Didomi parse failed', e);
    }
  }

  // CMP generic
  if (window.CMP || window.cmpManager) {
    try {
      extraText += '\n[Generic CMP Data]\n' + JSON.stringify(window.CMP || window.cmpManager, null, 2);
    } catch (e) {
      console.debug('NexusKitty: Generic CMP parse failed', e);
    }
  }

  // Google FCS (Funding Choices)
  if (window.googlefc) {
    try {
      extraText += '\n[Google Funding Choices]\n' + JSON.stringify(window.googlefc, null, 2);
    } catch (e) {
      console.debug('NexusKitty: Google FCS parse failed', e);
    }
  }

  return extraText.slice(0, 5000);
}

/* ---- Strategy 2: Deep Shadow DOM & Iframe Traversal ---- */
function getDeepText(node, visited = new WeakSet()) {
  if (!node) return '';
  if (visited.has(node)) return ''; // Prevent cycles
  visited.add(node);

  let text = '';

  // Text nodes
  if (node.nodeType === Node.TEXT_NODE) {
    return cleanText(node.textContent);
  }

  // Element nodes
  if (node.nodeType === Node.ELEMENT_NODE) {
    // Skip script/style/noscript
    const tag = node.tagName.toLowerCase();
    if (['script', 'style', 'noscript'].includes(tag)) {
      return '';
    }

    // Traverse Shadow Root if present
    if (node.shadowRoot) {
      text += ' ' + getDeepText(node.shadowRoot, visited);
    }

    // Traverse standard child nodes
    for (const child of node.childNodes) {
      text += ' ' + getDeepText(child, visited);
    }

    // Traverse accessible same-origin iframes
    if (tag === 'iframe') {
      try {
        if (node.contentDocument && node.contentDocument.body) {
          text += ' ' + getDeepText(node.contentDocument.body, visited);
        }
      } catch (e) {
        // Cross-origin iframe, silently ignore
      }
    }
  }

  return text;
}

/* ---- Strategy 3: Enhanced Main Document Text (Combines All Sources) ---- */
function getMainDocumentText() {
  const selectors = [
    'main',
    'article',
    '[role="main"]',
    '.terms',
    '.privacy-policy',
    '.terms-of-service',
    '.cookie-policy',
    '#content',
    '.content'
  ];

  let bestText = '';

  // 1. Standard visible DOM extraction (existing logic)
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

  // 2. Deep Shadow DOM + Iframe text from body (captures CMP iframes)
  const deepBodyText = getDeepText(document.body);
  if (deepBodyText.length > bestText.length) {
    bestText = deepBodyText;
  }

  // 3. CMP Global Objects (JavaScript state)
  const cmpGlobalText = getCmpGlobalData();
  if (cmpGlobalText) {
    if (bestText) {
      bestText += '\n\n' + cmpGlobalText;
    } else {
      bestText = cmpGlobalText;
    }
  }

  // 4. Fallback: body text excluding overlays
  if (!bestText || bestText.length < 400) {
    const bodyText = getTextExcludingOverlays(document.body);
    if (bodyText.length > bestText.length) {
      bestText = bodyText;
    }
  }

  return bestText.slice(0, MAX_TEXT_LENGTH);
}

/* =========================================================
   CONSENT CONTAINER DETECTION
   ========================================================= */

const CONSENT_SELECTORS = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[aria-modal="true"]',
  'dialog[open]',
  '[id*="cookie" i]',
  '[class*="cookie" i]',
  '[id*="consent" i]',
  '[class*="consent" i]',
  '[id*="fg-modal" i]',
  '[class*="fg-modal" i]',
  '[id*="trustarc" i]',
  '[class*="trustarc" i]',
  '[id*="evidon" i]',
  '[class*="evidon" i]',
  '[id*="quantcast" i]',
  '[class*="quantcast" i]',
  '[id*="cybot" i]',
  '[class*="cybot" i]',
  '[id*="usercentrics" i]',
  '[class*="usercentrics" i]',
  '[id*="sp_message" i]',
  '[class*="sp_message" i]',
  '[id*="iubenda" i]',
  '[class*="iubenda" i]',
  '[id*="termly" i]',
  '[class*="termly" i]',
  '[id*="cookie-script" i]',
  '[class*="cookie-script" i]',
  '[id*="axeptio" i]',
  '[class*="axeptio" i]',
  '[id*="privacy" i]',
  '[class*="privacy" i]',
  '[id*="terms" i]',
  '[class*="terms" i]',
  '[id*="policy" i]',
  '[class*="policy" i]',
  '[id*="privacy-prompt" i]',
  '[class*="privacy-prompt" i]',
  '[id*="gdpr-modal" i]',
  '[class*="gdpr-modal" i]',
  '[id*="consent-wall" i]',
  '[class*="consent-wall" i]',
  '[id*="modal" i]',
  '[class*="modal" i]',
  '[id*="dialog" i]',
  '[class*="dialog" i]',
  '[id*="popup" i]',
  '[class*="popup" i]',
  '[id*="banner" i]',
  '[class*="banner" i]'
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

function isConsentContainer(node) {
  if (!isVisible(node)) {
    return false;
  }

  const text = getNodeText(node);

  // FIX: The original upper bound of 4000 chars silently rejected large,
  // detailed GDPR/CMP notices (e.g. Sourcepoint-style banners that list
  // 100+ third parties, legal-basis text, article references, etc.).
  // Those legitimately exceed 4000 characters. We still reject only the
  // "too short to be meaningful" case; the final extracted text is
  // truncated later anyway via BANNER_BUDGET / MAX_TEXT_LENGTH, so no
  // need for an artificial ceiling here.
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

/*
 * Only inspect elements likely to be consent/legal containers
 * instead of scanning every node in the body.
 */
function getConsentContainers() {
  const nodes = new Set();

  for (const selector of CONSENT_SELECTORS) {
    document.querySelectorAll(selector).forEach((node) => {
      nodes.add(node);
    });
  }

  return Array.from(nodes)
    .filter((node) => isConsentContainer(node))
    .map((node) => ({
      node,
      text: getNodeText(node)
    }))
    .sort((left, right) => left.text.length - right.text.length);
}

/*
 * Used only by MutationObserver: inspect only the newly inserted subtree.
 */
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

  return Array.from(results).filter((node) => isConsentContainer(node));
}

/* =========================================================
   LEGAL PAGE DETECTION
   ========================================================= */

function hasLegalSurface() {
  if (LEGAL_URL_REGEX.test(window.location.href)) {
    return true;
  }

  // Avoid a full body scan; structural consent detection is enough here.
  return getConsentContainers().length > 0;
}

/* =========================================================
   LEGAL LINKS
   ========================================================= */

function findLegalLinks() {
  const links = Array.from(document.querySelectorAll('a[href]'));
  const legalRegex =
    /(terms|condition|privacy|cookie|legal|policy|gdpr|data-protection)/i;

  const uniqueLinks = [];
  const seen = new Set();

  for (const link of links) {
    const href = link.href;
    const text = link.textContent || link.getAttribute('aria-label') || '';

    if (
      !href ||
      href.startsWith('javascript:') ||
      href.startsWith('#') ||
      !legalRegex.test(`${href} ${text}`) ||
      seen.has(href)
    ) {
      continue;
    }

    seen.add(href);

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

/* =========================================================
   LEGAL PAGE FETCH
   ========================================================= */

async function fetchLegalPageText(url) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'NEXUSKITTY_FETCH_URL',
      url
    });

    if (!response?.ok || !response.html) {
      console.debug('NexusKitty: background fetch returned no html for', url, response);
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
    console.debug('NexusKitty: Could not fetch legal page:', url, err);
    return '';
  }
}

/* =========================================================
   CROSS-ORIGIN CONSENT IFRAME RECOVERY
   ---------------------------------------------------------
   Many CMPs (Sourcepoint and similar vendors) render the actual
   consent/cookie banner inside a cross-origin <iframe>. The Same-Origin
   Policy blocks contentDocument access to it entirely - it is invisible
   to getDeepText()/getActiveConsentPopup() even though it's clearly on
   screen. The iframe's `src` attribute string is always readable though,
   so fetch that URL's HTML through the background relay instead.

   NOTE: This raw-fetch approach only recovers server-rendered HTML. Many
   modern CMPs (including Sourcepoint's "Notice Message App") render an
   almost-empty HTML shell and build the actual banner text client-side
   via JS after load. For those, this fetch will come back empty/short,
   and the ONLY reliable source of the banner text is the content-script
   instance running inside the iframe itself (see
   "CROSS-ORIGIN IFRAME CONSENT DETECTION" section near the bottom of this
   file), which sees the fully hydrated DOM and relays it up via
   chrome.runtime messaging. That's why extractMainText() below checks
   receivedIframeConsentText FIRST, before falling back to this fetch.
   ========================================================= */

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

      // Fallback heuristic: a sizeable, overlay-positioned iframe is
      // likely a consent/paywall dialog even if its host isn't recognized.
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
      console.debug('NexusKitty: background fetch returned no html for consent iframe', url, response);
      return '';
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(response.html, 'text/html');

    doc.querySelectorAll('script, style, svg, noscript').forEach((el) => el.remove());

    return cleanText(doc.body ? (doc.body.textContent || doc.body.innerText || '') : '');
  } catch (err) {
    console.debug('NexusKitty: Could not fetch consent iframe:', url, err);
    return '';
  }
}

/* =========================================================
    MAIN TEXT EXTRACTION
    ========================================================= */

/*
  * Detect an active consent / CMP overlay or modal that is currently
  * visible on the page. Returns { node, text } or null.
  * The consent popup IS the primary document the user wants to analyze.
  */
/* =========================================================
   CMP DETAIL EXTRACTION
   ========================================================= */

const CMP_DETAIL_SELECTORS = [
  // Cookiebot
  '#CookiebotWidget',
  '#CybotCookiebotDialog',
  '.cc-btn',
  '.cc-link',
  '[id*="cookiebot"]',
  '[class*="cookiebot"]',
  // OneTrust
  '#onetrust-policy',
  '#onetrust-consent-sdk',
  '.ot-pc-footer',
  '.ot-pc-header',
  '[id*="onetrust"]',
  '[class*="onetrust"]',
  // Didomi
  '#didomi-popup',
  '[id*="didomi"]',
  '[class*="didomi"]',
  // Usercentrics
  '[data-testid*="uc-"]',
  '[class*="usercentrics"]',
  // iubenda
  '[class*="iubenda"]',
  '[id*="iubenda"]',
  // Termly
  '[class*="termly"]',
  '[id*="termly"]',
  // Generic detail/accordion patterns
  '[id*="details"]',
  '[class*="details"]',
  '[id*="accordion"]',
  '[class*="accordion"]',
  '[id*="vendor"]',
  '[class*="vendor"]',
  '[id*="purpose"]',
  '[class*="purpose"]',
  '[id*="category"]',
  '[class*="category"]',
  '[id*="cookie-table"]',
  '[class*="cookie-table"]',
  '[id*="cookie-list"]',
  '[class*="cookie-list"]',
  '[id*="partner"]',
  '[class*="partner"]',
  '[id*="third-party"]',
  '[class*="third-party"]',
  '.cookie-consent-details',
  '.consent-details',
  '.vendor-list',
  '.purpose-list',
  '.cookie-policy-details',
  '[role="tabpanel"]',
  '[aria-hidden="true"]',
  'details > summary',
  'details[open]',
  '[data-tab]', '[data-panel]'
];

function extractCMPDetails(cmpElement) {
  if (!cmpElement) return '';

  let combinedText = getNodeText(cmpElement);

  // Find and extract text from detail/accordion sections
  const detailElements = cmpElement.querySelectorAll(CMP_DETAIL_SELECTORS.join(', '));

  for (const detailEl of detailElements) {
    // Skip if it's the main container itself
    if (detailEl === cmpElement) continue;

    const detailText = getNodeText(detailEl);
    if (detailText && detailText.length > 20) {
      // Avoid duplicates
      if (!combinedText.includes(detailText.slice(0, 50))) {
        combinedText += '\n\n[CMP Detail Section]\n' + detailText;
      }
    }
  }

  // Also check for hidden tab panels / accordion content that might be collapsed
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

    // Extract full CMP text including detail sections
    const fullCmpText = extractCMPDetails(el);

    // Must contain consent-related keywords to qualify as a consent popup
    if (
      fullCmpText.length >= 30 &&
      /(cookie|consent|privacy|policy|gdpr|personal data|accept|agree|close|reject|manage)/i.test(fullCmpText)
    ) {
      return { node: el, text: fullCmpText };
    }
  }

  // Fall back to structural consent containers
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
  /*
   * PRIORITY 0: Dedicated legal page URL takes absolute precedence.
   * If user is on a Privacy Policy / Terms / Legal page, we want the FULL document,
   * not just the cookie banner at the top.
   */
  const DEDICATED_LEGAL_URL_KEYWORDS = [
    'privacy', 'terms', 'conditions', 'cookie-policy', 'cookie_policy',
    'legal', 'gdpr', 'tos', 'obshti-usloviya', 'polzovatelsko-soglashenie',
    'usloviya-polzovaniya', 'politika-konfidentsialnosti', 'privacy-policy',
    'terms-of-service', 'terms-of-use', 'data-protection', 'data_policy',
    'legal-notice', 'impressum', 'aviso-legal', 'mentions-legales',
    'datenschutz', 'nutzungsbedingungen', 'allgemeine-geschaeftsbedingungen',
    'cookies', 'consent', 'user-agreement', 'service-terms'
  ];

  function isDedicatedLegalPage() {
    const url = window.location.href.toLowerCase();
    return DEDICATED_LEGAL_URL_KEYWORDS.some(kw => url.includes(kw));
  }

  if (isDedicatedLegalPage()) {
    console.log('NexusKitty: Dedicated legal page URL detected. Extracting full page content.');

    // Get the main document text (excluding CMP overlays)
    let baseText = getMainDocumentText();

    // Fallback: if structured extraction fails, use body text excluding overlays
    if (!baseText || baseText.length <= 400) {
      const bodyText = getTextExcludingOverlays(document.body);
      if (bodyText && bodyText.length > 400) {
        baseText = bodyText;
      }
    }

    if (baseText && baseText.length > 100) {
      // Some "Terms" pages are just an index/router that points to the real
      // documents ("please read them carefully here", linking out to
      // UK/US/German Terms and a separate Privacy Notice). Follow those
      // legal-looking links too, so the analysis sees the actual substantive
      // text instead of just the router page.
      const legalLinks = findLegalLinks();
      console.log('NexusKitty [debug]: dedicated legal page, found links:', legalLinks);

      let fetchedPagesText = '';

      if (legalLinks.length > 0) {
        const pageTexts = await Promise.all(
          legalLinks.map(async (link) => {
            const text = await fetchLegalPageText(link.href);
            console.log(`NexusKitty [debug]: fetched "${link.href}" -> ${text.length} chars`);
            return text;
          })
        );

        fetchedPagesText = pageTexts
          .filter((text) => text.length > 200)
          .join('\n\n--- NEXT LEGAL SECTION ---\n\n');
      } else {
        console.log('NexusKitty [debug]: no legal-looking <a href> links found on this page (anchors and javascript: links are excluded).');
      }

      console.log(`NexusKitty [debug]: fetchedPagesText total length = ${fetchedPagesText.length}`);

      const combined = fetchedPagesText
        ? `${baseText}\n\n[Linked legal documents]\n${fetchedPagesText}`
        : baseText;

      return combined.slice(0, MAX_TEXT_LENGTH);
    }
  }

  /*
   * PRIORITY 1: Active consent/CMP overlay or modal dialog.
   * The consent popup IS the primary document the user wants to analyze.
   */

  const activePopup = getActiveConsentPopup();

  let popupText = activePopup?.text || '';

  // FIX: Prefer text already relayed up from a cross-origin CMP iframe's
  // OWN content-script instance (see "CROSS-ORIGIN IFRAME CONSENT
  // DETECTION" near the bottom of this file). That instance runs inside
  // the iframe's real execution context and sees the fully JS-rendered/
  // hydrated DOM. This is critical for CMPs like Sourcepoint's "Notice
  // Message App", which ship an almost-empty server-rendered HTML shell
  // and build the actual banner text client-side - a raw fetch() of the
  // iframe URL (fetchIframeConsentText, below) will NOT see that text at
  // all, only the empty shell.
  if (receivedIframeConsentText.length > popupText.length) {
    popupText = receivedIframeConsentText;
  }

  // Many CMPs (Sourcepoint, some OneTrust/Usercentrics setups, etc.) render
  // the actual consent banner inside a CROSS-ORIGIN <iframe>. The browser's
  // Same-Origin Policy blocks contentDocument access to that iframe entirely
  // - getDeepText()/getActiveConsentPopup() silently return nothing for it,
  // even though the banner is clearly visible on screen. The iframe's `src`
  // URL string itself is always readable though, so fetch that page's HTML
  // through the background relay (extension fetches bypass CORS on read).
  //
  // FIX: This raw fetch is now just a fallback for CMPs that DO
  // server-render their text into the initial HTML. It runs only if the
  // iframe-relay text above wasn't good enough.
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

  if (popupText) {
    // Treat consent text as valid legal content even when short (150+ chars).
    if (popupText.length >= 150) {
      // If popup text is brief (< 400 chars), combine with page context
      // so the backend has full visibility into what the user is agreeing to.
      if (popupText.length < 400) {
        const pageText = getMainDocumentText();
        if (pageText && pageText.length > 100) {
          return (
            '[Active Consent Popup / Cookie Banner]\n' +
            popupText + '\n\n' +
            '[Page context]\n' +
            pageText.slice(0, BANNER_BUDGET) + '\n\n'
          ).slice(0, MAX_TEXT_LENGTH);
        }
      }

      return ('[Active Consent Popup / Cookie Banner]\n' + popupText).slice(0, MAX_TEXT_LENGTH);
    }
  }

  /*
    * 2. Fallback to structured consent detection + main document.
    */

  const structuralConsent = getConsentContainers();

  const extractedBannerText = structuralConsent.length
    ? structuralConsent[0].text.slice(0, BANNER_BUDGET)
    : '';

  const documentText = getMainDocumentText();

  // Match URL, title and top headings only: matching the whole body text
  // flagged any article that merely mentions "policy" or "privacy".
  const headingText = Array.from(document.querySelectorAll('h1, h2'))
    .slice(0, 5)
    .map((heading) => getNodeText(heading))
    .join(' ');

  const isLegalPage = LEGAL_PAGE_REGEX.test(
    `${window.location.href} ${document.title} ${headingText}`
  );

  if (isLegalPage && documentText.length > 400) {
    if (extractedBannerText) {
      return (
        `${extractedBannerText}\n\n` +
        `[Underlying legal document]\n` +
        `${documentText}`
      ).slice(0, MAX_TEXT_LENGTH);
    }

    return documentText.slice(0, MAX_TEXT_LENGTH);
  }

  /*
   * 2. Look for local cookie/consent/modal candidates.
   *    body is intentionally NOT included (too expensive on large sites).
   */

  const selectors = [
    '[role="dialog"]',
    '[aria-modal="true"]',
    '[id*="cookie" i]',
    '[class*="cookie" i]',
    '[id*="consent" i]',
    '[class*="consent" i]',
    '[data-testid*="cookie" i]',
    '[id*="privacy" i]',
    '[class*="privacy" i]',
    'main',
    'article',
    '[role="main"]',
    '.terms',
    '.privacy-policy',
    '.terms-of-service',
    '.cookie-policy',
    '#content',
    '.content'
  ];

  const candidates = [];
  const seenNodes = new Set();

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

  let bestLocalText = '';

  if (cookieCandidate) {
    const linksTextLength = Array.from(
      cookieCandidate.node.querySelectorAll('a, button')
    ).reduce((acc, el) => acc + (el.textContent || '').length, 0);

    // Avoid normal navigation menus.
    if (
      !(
        linksTextLength / Math.max(cookieCandidate.text.length, 1) > 0.6 &&
        !isLegalPage
      )
    ) {
      bestLocalText = cookieCandidate.text.slice(0, BANNER_BUDGET);
    }
  }

  /*
   * 3. Fetch linked legal pages ONLY when the current page appears relevant.
   */

  let fetchedPagesText = '';

  const shouldFetchLegalPages = Boolean(
    isLegalPage ||
      extractedBannerText ||
      bestLocalText ||
      /(terms|privacy|cookie|legal|policy|gdpr)/i.test(window.location.href)
  );

  if (shouldFetchLegalPages) {
    const legalLinks = findLegalLinks();

    if (legalLinks.length > 0) {
      const pageTexts = await Promise.all(
        legalLinks.map((link) => fetchLegalPageText(link.href))
      );

      fetchedPagesText = pageTexts
        .filter((text) => text.length > 200)
        .join('\n\n--- NEXT LEGAL SECTION ---\n\n');
    }
  }

  /*
   * 4. Combine everything.
   */

  let combinedResult = '';

  if (extractedBannerText) {
    combinedResult +=
      `[Cookie Banner / Consent Dialog]\n` + `${extractedBannerText}\n\n`;
  } else if (bestLocalText) {
    combinedResult += `[Extracted Local Section]\n` + `${bestLocalText}\n\n`;
  }

  if (fetchedPagesText) {
    combinedResult += `[Auto-Fetched Linked Policies]\n` + fetchedPagesText;
  }

  combinedResult = combinedResult.trim();

  if (combinedResult.length > 100) {
    return combinedResult.slice(0, MAX_TEXT_LENGTH);
  }

  /*
   * Final fallback: kept so ordinary pages can still be analyzed.
   */

  const fallback = cleanText(
    document.body?.innerText || document.body?.textContent || ''
  );

  return fallback.length > 300
    ? fallback.slice(0, MAX_TEXT_LENGTH)
    : 'No readable text found on this page.';
}

/* =========================================================
   TRACKER DETECTION
   ========================================================= */

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

// Only KNOWN tracking/advertising domains are reported. Fonts, CDNs and the
// consent manager itself (e.g. cookielaw.org) are not trackers.
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
      // Ignore malformed URLs.
    }
  }

  return [...found];
}

/* =========================================================
   CONSENT BUTTON DETECTION
   ========================================================= */

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

  // A consent button only matters when it sits inside a real consent/legal
  // context. Without this, ordinary UI buttons ("Decline", "Accept", "OK")
  // on unrelated pages get tagged with NK badges.
  const pageIsLegal = LEGAL_URL_REGEX.test(window.location.href);
  const inConsentContainer = Boolean(
    element.closest(CONSENT_SELECTORS.join(',')) ||
    element.closest('[role="dialog"], [aria-modal="true"]')
  );

  // Strong consent phrases.
  const strictConsentPhrases =
    /(i agree|accept terms|accept all|agree to terms|accept privacy|accept policy|accept cookies|reject all|decline|refuse|manage cookies|cookie settings|privacy settings|policy settings|allow all|allow essential cookies|allow cookies|essential cookies)/i;

  if (strictConsentPhrases.test(text)) {
    return inConsentContainer || pageIsLegal;
  }

  // Short labels.
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
    'button',
    'input[type="button"]',
    'input[type="submit"]',
    '[role="button"]',
    'a'
  ];

  /*
   * PASS 1: Structural containers.
   */

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

  /*
   * PASS 2: Legal-page forms.
   */

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

  /*
   * PASS 3: Full button scan, only after structural detection fails.
   */

  return Array.from(document.querySelectorAll(selectors.join(','))).filter(
    (element) => isExplicitConsentButton(element)
  );
}

/* =========================================================
   CONSENT SNAPSHOT
   ========================================================= */

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

/* =========================================================
   MODULE STATE
   ---------------------------------------------------------
   These were referenced (loadDomainSettings, isDomainDisabledSync,
   scheduleConsentHudUpdate) without ever being declared, which threw
   "ReferenceError: domainSettingsLoaded is not defined" at the very
   start of initContentScript() and aborted the whole content script
   before any page text extraction or link-following could run.
   ========================================================= */
let domainDisabled = false;
let domainSettingsLoaded = false;
let observerTimer = null;

// Populated when a content-script instance running INSIDE a cross-origin
// CMP iframe (e.g. Sourcepoint) detects and relays its own rendered consent
// text up to this (top-frame) instance via background.js. Same-Origin Policy
// makes it impossible to read that iframe's DOM directly from here.
let receivedIframeConsentText = '';

// FIX: Debounced re-analysis trigger. When a relayed iframe consent text
// arrives, it usually does so AFTER the top frame's initial
// buildPagePayload() already ran (the iframe needs time to load and
// hydrate). Without this, receivedIframeConsentText would sit unused until
// some unrelated event (like a DOM mutation) happened to trigger another
// analysis pass. This makes the relay itself trigger a fresh, forced
// (non-cached) analysis once enough text has arrived.
let iframeRelayReanalysisTimer = null;
let lastReanalyzedIframeTextLength = 0;

function scheduleReanalysisAfterIframeRelay() {
  if (isDomainDisabledSync()) {
    return;
  }

  // Avoid re-triggering repeatedly for the same (or shorter) text.
  if (receivedIframeConsentText.length <= lastReanalyzedIframeTextLength) {
    return;
  }

  if (iframeRelayReanalysisTimer) {
    clearTimeout(iframeRelayReanalysisTimer);
  }

  // Small debounce: multiple relay messages can arrive in quick succession
  // (see scheduleIframeReports at the bottom of this file, which reports at
  // 0ms/800ms/2000ms), so wait briefly for them to settle before
  // re-running the (potentially expensive) extraction + backend analysis.
  iframeRelayReanalysisTimer = setTimeout(async () => {
    iframeRelayReanalysisTimer = null;

    if (isDomainDisabledSync()) {
      return;
    }

    lastReanalyzedIframeTextLength = receivedIframeConsentText.length;

    try {
      // force_refresh: bypass the cache, since the cached payload was built
      // before the iframe text was available.
      const payload = await buildPagePayload(true);

      // Keep compatibility with the existing page-text storage, same as
      // initContentScript() does on first load.
      if (payload?.text?.length > 0) {
        try {
          await chrome.storage.local.set({
            [`nexuskitty_page_${window.location.href}`]: payload.text
          });
        } catch (error) {
          console.debug('NexusKitty: Could not save page text after iframe relay.', error);
        }
      }

      // Notify background.js so it can (re-)send the updated payload to the
      // backend for analysis, same as the initial page load flow.
      try {
        await chrome.runtime.sendMessage({
          type: 'NEXUSKITTY_PAGE_DATA_UPDATED',
          payload
        });
      } catch (error) {
        console.debug('NexusKitty: Could not notify background of updated payload.', error);
      }
    } catch (error) {
      console.debug('NexusKitty: Re-analysis after iframe relay failed.', error);
    }
  }, 400);
}

/* =========================================================
   DOMAIN SETTINGS
   ========================================================= */

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
    console.debug('NexusKitty: Could not read disabledDomains.', error);
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

// React to the domain being enabled/disabled from the popup without a reload.
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
    // Re-apply the last known verdict for the newly enabled domain.
    applyRiskWarning(lastCategories, lastShouldWarn);
  }
});

/* =========================================================
   HUD
   ========================================================= */

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

function injectConsentHud() {
  // The NK badge is now only rendered after the backend confirms a real
  // data-privacy risk. Scanning the DOM here used to tag every consent
  // button on every page, even when the analysis found no danger.
  return;
}

/* =========================================================
   CACHE
   ========================================================= */

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
  } catch (error) {
    console.debug('NexusKitty: Could not read page cache.', error);
  }

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
  } catch (error) {
    console.debug('NexusKitty: Could not write page cache.', error);
  }
}

/*
 * Expired entries were only ignored on read, never deleted, so storage
 * grew forever. Prune at most once per TTL.
 */
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
  } catch (error) {
    console.debug('NexusKitty: Could not prune cache.', error);
  }
}

/* =========================================================
   ZERO-FAILURE ASYNC EXTRACTION PIPELINE
   ========================================================= */

async function extractDocumentTextAsync() {
  let extractedText = "";

  // 1. Direct Cookiebot / CMP Text Aggregation (DOM + Shadow DOM + Iframes)
  const cmpNodes = document.querySelectorAll('#CybotCookiebotDialog, #CookiebotWidget, [id*="Cookiebot"], [id*="cmpbox"], [class*="cookie"]');
  cmpNodes.forEach(node => {
    extractedText += " " + (node.innerText || node.textContent || "");
  });

  // 2. JS Global Object Inspection (Cookiebot state)
  try {
    if (window.Cookiebot && window.Cookiebot.decl) {
      extractedText += "\n\nCookiebot Declaration Data: " + JSON.stringify(window.Cookiebot.decl);
    }
  } catch (e) {
    console.warn("Could not read window.Cookiebot", e);
  }

  // 3. Background Link Fetching (If DOM text is under 100 characters)
  if (extractedText.trim().length < 100) {
    const legalLink = Array.from(document.querySelectorAll('a[href]')).find(a => {
      const h = a.href.toLowerCase();
      const t = a.innerText.toLowerCase();
      return ['privacy', 'poveritelnost', 'terms', 'usloviya', 'cookie', 'biskvitki'].some(kw => h.includes(kw) || t.includes(kw));
    });
    if (legalLink && legalLink.href.startsWith('http')) {
      try {
        const html = await fetchLegalPageText(legalLink.href);
        if (html) {
          extractedText += "\n\n" + html;
        }
      } catch (err) {
        console.warn("Background fetch failed:", err);
      }
    }
  }

  // 4. HARD FALLBACK: If EVERYTHING else is short, use document.body.innerText
  if (extractedText.trim().length < 20) {
    extractedText = document.body.innerText || "Legal analysis fallback for site: " + window.location.hostname;
  }

  // ALWAYS RETURN TEXT (NEVER NULL OR EMPTY)
  return { source: 'zero_failure', text: extractedText };
}

/* =========================================================
   PAGE PAYLOAD
   ========================================================= */

async function buildPagePayload(forceRefresh = false) {
  /*
   * Cache is used only when explicitly allowed.
   * force_refresh=true always analyzes the current DOM.
   */

  if (!forceRefresh) {
    const cached = await readPageCache();

    if (cached) {
      return cached;
    }
  }

  const text = await extractMainText();
  const trackers = detectTrackers();
  const consentControls = getConsentSnapshot();
  const legalSurface = hasLegalSurface();

  const payload = {
    text,
    trackers,
    detected_trackers: trackers,
    consent_controls: consentControls,
    legal_surface: legalSurface,
    url: window.location.href,
    hostname: window.location.hostname,
    title: document.title || ''
  };

  await writePageCache(payload);

  return payload;
}

/* =========================================================
   RISK WARNING
   ========================================================= */

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

/* =========================================================
   MESSAGE HANDLING
   ========================================================= */

async function handleMessage(request, sender, sendResponse) {
  try {
    // Request current page data (legacy).
    if (request && request.type === 'NEXUSKITTY_GET_PAGE_DATA') {
      const payload = await buildPagePayload(request.force_refresh === true);

      sendResponse({
        ok: true,
        ...payload
      });

      return;
    }

    // NEW: Async multi-layer document text extraction.
    if (request && request.type === 'NEXUSKITTY_GET_DOCUMENT_TEXT') {
      const result = await extractDocumentTextAsync();

      sendResponse({
        ok: true,
        source: result.source,
        text: result.text,
        fetchedUrl: result.fetchedUrl || null
      });

      return;
    }

    // Receive analysis result.
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

    // Consent text relayed from a cross-origin CMP iframe running its own
    // content-script instance (see background.js NEXUSKITTY_IFRAME_CONSENT_TEXT).
    if (request && request.type === 'NEXUSKITTY_IFRAME_CONSENT_TEXT_RELAY') {
      if (request.text && request.text.length > receivedIframeConsentText.length) {
        receivedIframeConsentText = request.text;
        console.log(
          `NexusKitty [debug]: received consent text relayed from cross-origin iframe (${request.frameUrl || 'unknown frame'}), length = ${receivedIframeConsentText.length}`
        );

        // FIX: Previously this text was only stored and never consumed
        // again unless some unrelated DOM mutation happened to trigger a
        // fresh analysis. Now the relay itself schedules a forced
        // re-analysis so the newly-arrived banner text actually reaches
        // extractMainText() / the backend.
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

// Register listener BEFORE initialization.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) {
    return false;
  }

  handleMessage(request, sender, sendResponse);

  // Required because the response is asynchronous.
  return true;
});

/* =========================================================
   MUTATION OBSERVER
   ========================================================= */

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

    // Ignore our own HUD.
    if (node.classList?.contains('nexuskitty-consent-hud')) {
      continue;
    }

    // Check the newly inserted subtree only.
    const consentContainers = findConsentContainersInNode(node);

    if (consentContainers.length) {
      return true;
    }

    // Direct button check.
    if (node.matches?.(BUTTON_SELECTOR)) {
      if (isExplicitConsentButton(node)) {
        return true;
      }
    }

    // If the subtree contains likely buttons, inspect only those.
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

// Tracks the last analysis verdict so the HUD/outlines can be re-applied
// when the DOM changes (e.g. a consent banner renders after analysis).
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

/* =========================================================
   INITIALIZATION
   ========================================================= */

async function initContentScript() {
  try {
    // Read disabledDomains only once.
    await loadDomainSettings();

    // Initial page analysis (skipped on disabled domains; the observer stays
    // registered so re-enabling the domain works without a reload).
    const payload = isDomainDisabledSync()
      ? null
      : await buildPagePayload(false);

    // Keep compatibility with the existing page-text storage.
    if (payload?.text?.length > 0) {
      try {
        await chrome.storage.local.set({
          [`nexuskitty_page_${window.location.href}`]: payload.text
        });
      } catch (error) {
        console.debug('NexusKitty: Could not save page text.', error);
      }
    }

    // Housekeeping (throttled to once per TTL).
    pruneExpiredCache();

    /*
     * Observe only childList changes (not attributes / characterData)
     * to avoid a huge number of callbacks on React/Vue/Angular pages.
     */
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

    // Delayed scans for consent managers that appear after page load.
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
    // Never allow one initialization error to destroy the content script.
    console.error('NexusKitty: Content script initialization failed.', error);
  }
}

/* =========================================================
   CROSS-ORIGIN IFRAME CONSENT DETECTION (this frame IS an iframe)
   ---------------------------------------------------------
   With "all_frames": true in the manifest, this script also runs inside
   every iframe on the page - including cross-origin CMP iframes (e.g.
   Sourcepoint) that the TOP frame's JavaScript can never read directly
   because of the Same-Origin Policy. Running here, inside the iframe's own
   execution context, sidesteps that restriction entirely: we see the fully
   JS-rendered DOM, not just the empty server-sent HTML shell a plain
   fetch() would return. If this looks like a consent/CMP surface, relay the
   extracted text up to the top frame via background.js.
   ========================================================= */

function detectOwnFrameConsentText() {
  const popup = getActiveConsentPopup();
  if (popup && popup.text && popup.text.length >= 80) {
    return popup.text;
  }

  // Fallback: recognizable CMP markup (e.g. Sourcepoint's sp_choice_type_*
  // buttons) even when it doesn't match a known container selector.
  const spNode = document.querySelector(
    '.message.type-modal, [class*="sp_choice_type"], #notice.message, [class*="message-component"]'
  );

  if (spNode) {
    const container = spNode.closest('.message, [role="dialog"], [aria-modal="true"], body') || spNode;
    const text = getNodeText(container);
    if (text && text.length >= 80) {
      return text;
    }
  }

  return '';
}

function reportIframeConsentText() {
  try {
    const text = detectOwnFrameConsentText();

    if (text) {
      chrome.runtime.sendMessage({
        type: 'NEXUSKITTY_IFRAME_CONSENT_TEXT',
        text,
        frameUrl: window.location.href,
      }).catch(() => {});
    }
  } catch (err) {
    console.debug('NexusKitty: iframe consent detection failed', err);
  }
}

/* =========================================================
   START
   ========================================================= */

if (window.self !== window.top) {
  // Inside an iframe: only try to detect and relay consent/CMP content.
  // Never run the full page pipeline (mutation observer, badge, cache,
  // domain settings, etc.) inside an arbitrary third-party iframe.
  const scheduleIframeReports = () => {
    reportIframeConsentText();
    // CMP content is frequently rendered asynchronously after the iframe's
    // own load event, so check again a couple of times.
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