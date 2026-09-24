function cleanText(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

/* =========================================================
   CONSTANTS
   ========================================================= */

const MAX_TEXT_LENGTH = 5000;
const MAX_LEGAL_LINKS = 3;
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
   RUNTIME STATE
   ========================================================= */

let observerTimer = null;
let domainDisabled = false;
let domainSettingsLoaded = false;

/* =========================================================
   VISIBILITY / TEXT
   ========================================================= */

function isVisible(node) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) {
    return false;
  }

  const style = window.getComputedStyle(node);

  return (
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    style.opacity !== '0' &&
    node.getClientRects().length > 0
  );
}

function getNodeText(node) {
  if (!node) {
    return '';
  }

  return cleanText(node.textContent || node.innerText || '');
}

/*
 * Clone a node, remove every CMP / overlay / modal element, and return
 * the cleaned text. This prevents cookie banners (OneTrust, Didomi, etc.)
 * from polluting the scraped document text.
 */
function getTextExcludingOverlays(node) {
  if (!node) {
    return '';
  }

  const clone = node.cloneNode(true);

  clone
    .querySelectorAll(CMP_OVERLAY_SELECTORS.join(', '))
    .forEach((el) => el.remove());

  return getNodeText(clone);
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

  if (text.length < 30 || text.length > 4000) {
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

  for (const selector of selectors) {
    const node = document.querySelector(selector);

    if (!node || !isVisible(node)) {
      continue;
    }

    const text = getTextExcludingOverlays(node);

    if (text.length >= 400) {
      return text;
    }
  }

  return '';
}

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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);

  try {
    const response = await fetch(url, {
      credentials: 'omit',
      signal: controller.signal
    });

    if (!response.ok) {
      return '';
    }

    const html = await response.text();

    if (!html) {
      return '';
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

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
  } finally {
    clearTimeout(timeoutId);
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

    const text = getNodeText(el);

    // Must contain consent-related keywords to qualify as a consent popup
    if (
      text.length >= 30 &&
      /(cookie|consent|privacy|policy|gdpr|personal data|accept|agree|close|reject|manage)/i.test(text)
    ) {
      return { node: el, text: text.slice(0, BANNER_BUDGET) };
    }
  }

  // Fall back to structural consent containers
  const containers = getConsentContainers();
  if (containers.length > 0) {
    return {
      node: containers[0].node,
      text: containers[0].text.slice(0, BANNER_BUDGET)
    };
  }

  return null;
}

async function extractMainText() {
  /*
    * PRIORITY 1: Active consent/CMP overlay or modal dialog.
    * The consent popup IS the primary document the user wants to analyze.
    */

  const activePopup = getActiveConsentPopup();

  if (activePopup) {
    const popupText = activePopup.text;

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
    // Request current page data.
    if (request && request.type === 'NEXUSKITTY_GET_PAGE_DATA') {
      const payload = await buildPagePayload(request.force_refresh === true);

      sendResponse({
        ok: true,
        ...payload
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
   START
   ========================================================= */

if (document.readyState === 'loading') {
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