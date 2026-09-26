const state = {
  url: '',
  text: '',
  analysisText: '',
  trackers: [],
  consentControls: [],
  legalSurface: false,
  tabId: null,
  analysis: null,
  filter: 'all',
  isDisabled: false,
  usedSurroundingPage: false,
  jsRenderedSuspected: false,
  detectedLanguage: null,
};

const elements = {
  status: document.getElementById('statusBadge'),
  loading: document.getElementById('loadingState'),
  loadingText: document.getElementById('loadingText'),
  analysis: document.getElementById('analysisState'),
  error: document.getElementById('errorState'),
  issueCount: document.getElementById('issueCount'),
  issueBreakdown: document.getElementById('issueBreakdown'),
  riskWhy: document.getElementById('riskWhy'),
  risk: document.getElementById('riskPill'),
  summary: document.getElementById('summaryText'),
  banner: document.getElementById('hypocrisyBanner'),
  findings: document.getElementById('findingsList'),
  history: document.getElementById('historyList'),
  chat: document.getElementById('chatMessages'),
  chatForm: document.getElementById('chatForm'),
  question: document.getElementById('questionInput'),
  send: document.getElementById('sendButton'),
  gdpr: document.getElementById('gdprButton'),
  toggleSite: document.getElementById('toggleSiteButton'),
  technicalSignals: document.getElementById('technicalSignals'),
};

function setStatus(online) {
  if (!elements.status) return;
  elements.status.textContent = online ? 'Online' : 'Offline';
  elements.status.classList.toggle('online', online);
  elements.status.classList.toggle('offline', !online);
}

function showLoading(message) {
  elements.loading?.classList.remove('hidden');
  elements.analysis?.classList.add('hidden');
  elements.error?.classList.add('hidden');
  if (message && elements.loadingText) elements.loadingText.textContent = message;
}

function showError(message, allowOverride = false, allowReenable = false) {
  elements.loading?.classList.add('hidden');
  elements.analysis?.classList.add('hidden');
  elements.error?.classList.remove('hidden');
  elements.error.replaceChildren();

  const messageElement = document.createElement('div');
  messageElement.textContent = message;
  elements.error.appendChild(messageElement);

  if (allowOverride) {
    const overrideButton = document.createElement('button');
    overrideButton.className = 'error-action';
    overrideButton.type = 'button';
    overrideButton.textContent = 'Analyze this page anyway';
    overrideButton.addEventListener('click', () => analyzeCurrentPage(true));
    elements.error.appendChild(overrideButton);
  }

  if (allowReenable) {
    const reenableButton = document.createElement('button');
    reenableButton.className = 'error-action reenable-btn';
    reenableButton.type = 'button';
    reenableButton.textContent = 'Включи NexusKitty за този сайт';
    reenableButton.addEventListener('click', toggleSiteStatus);
    elements.error.appendChild(reenableButton);
  }
}

function showSurroundingPageWarning() {
  if (!elements.analysis || elements.analysis.querySelector('.fallback-warning')) return;

  const warning = document.createElement('div');
  warning.className = 'fallback-warning';
  warning.textContent =
    'Heads up: the policy text itself could not be extracted. This result is based on the surrounding page content only, so a score of 0 findings does not mean the policy is safe.';
  elements.analysis.prepend(warning);
}

function showJsRenderedWarning() {
  if (!elements.analysis || elements.analysis.querySelector('.js-rendered-warning')) return;

  const warning = document.createElement('div');
  warning.className = 'fallback-warning js-rendered-warning';
  warning.textContent =
    'The linked policy pages are rendered by JavaScript, so their text was never read. This result covers only the consent banner that was visible here — 0 findings does not mean the privacy policy or terms are safe.';
  elements.analysis.prepend(warning);
}

function showAnalysis() {
  elements.loading?.classList.add('hidden');
  elements.error?.classList.add('hidden');
  elements.analysis?.classList.remove('hidden');
}

function renderFindings(findings = []) {
  const visible = state.filter === 'all'
    ? findings
    : findings.filter((finding) => finding.category === state.filter);

  if (!visible.length) {
    elements.findings.innerHTML = '<div class="finding-card"><div class="finding-explanation">No findings in this view.</div></div>';
    return;
  }

  elements.findings.innerHTML = visible.map((finding) => `
    <article class="finding-card">
      <div class="finding-header">
        <h4 class="finding-title">${escapeHtml(finding.title || 'Untitled finding')}</h4>
        <span class="finding-tag ${escapeHtml(finding.category || '')}">${escapeHtml(finding.category || 'GENERAL')}</span>
      </div>
      <div class="finding-meta">Section: ${escapeHtml(finding.section || 'Unknown')}</div>
      <div class="finding-evidence"${state.detectedLanguage ? ` lang="${escapeHtml(state.detectedLanguage)}"` : ''}>"${escapeHtml(finding.evidence || 'No evidence supplied.')}"</div>
      <div class="finding-explanation">${escapeHtml(finding.explanation || 'No explanation supplied.')}</div>
    </article>
  `).join('');
}

function updateBadgeAlert(needsAttention) {
  if (!chrome.action || !state.tabId) return;

  if (needsAttention) {
    chrome.action.setBadgeText({ text: '!', tabId: state.tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#FF3366', tabId: state.tabId });
  } else {
    chrome.action.setBadgeText({ text: '', tabId: state.tabId });
  }
}

function formatScanDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return escapeHtml(String(value));
  }
  return escapeHtml(date.toLocaleString());
}

function renderAnalysis(result) {
  state.analysis = result;
  const findings = result.findings || [];

  if (elements.gdpr) {
    elements.gdpr.classList.toggle('hidden', !(result.can_opt_out || findings.some((finding) => ['AI_USAGE', 'DATA_SALE'].includes(finding.category))));
  }

  if (result.analysis_available === false) {
    elements.issueCount.textContent = 'Review unavailable';
    elements.issueBreakdown.innerHTML = '';
    elements.risk.textContent = 'Unavailable';
    elements.risk.className = 'risk-pill warning';
    elements.riskWhy.textContent = 'The live review could not be completed.';
    elements.summary.textContent = result.summary || 'The live AI provider is unavailable.';
    elements.findings.innerHTML = '<div class="finding-card"><div class="finding-explanation">No legal findings were generated. Restore the AI provider and run the scan again.</div></div>';
    elements.banner.classList.add('hidden');
    updateBadgeAlert(false);
    showAnalysis();
    return;
  }

  const categoryLabels = {
    MONEY: 'Money',
    PRIVACY: 'Privacy',
    USER_CONTENT: 'User Content',
    AI_USAGE: 'AI Usage',
    TERMINATION: 'Termination',
    DATA_SALE: 'Data Sale',
  };

  const counts = findings.reduce((summary, finding) => {
    summary[finding.category] = (summary[finding.category] || 0) + 1;
    return summary;
  }, {});

  elements.issueCount.textContent = findings.length === 1
    ? '1 issue worth reviewing'
    : `${findings.length} issues worth reviewing`;

  elements.issueBreakdown.innerHTML = Object.entries(counts)
    .map(([category, count]) => `<span><strong>${escapeHtml(categoryLabels[category] || category)}</strong> — ${count}</span>`)
    .join('');

  elements.risk.textContent = findings.length ? 'Review' : 'Clear';
  elements.risk.className = `risk-pill ${findings.length ? 'warning' : 'safe'}`;
  elements.riskWhy.textContent = findings.length
    ? 'The document contains clauses that may have significant practical implications for users.'
    : 'No clauses requiring extra attention were detected in the extracted text.';

  elements.summary.textContent = result.summary || 'No summary available.';
  renderFindings(findings);
  renderTechnicalSignals(result);
  renderCookieBreakdown(result);

  const alert = result.hypocrisy_alert;
  const highRiskCount = findings.filter((f) => f.attention_level === 'HIGH').length;
  const criticalFinding = findings.some((finding) =>
    finding.attention_level === 'HIGH' || ['AI_USAGE', 'DATA_SALE'].includes(finding.category)
  );

  const requiresAttention = Boolean(alert?.detected || highRiskCount >= 1);
  updateBadgeAlert(requiresAttention);

  elements.banner.classList.toggle('hidden', !criticalFinding && !alert?.detected);
  if (alert?.detected) {
    elements.banner.textContent = `${alert.title} ${alert.message} ${alert.trackers.join(', ')}`;
    elements.banner.classList.remove('hidden');
  }

  const diffBox = document.getElementById('semanticDiffBox');
  if (diffBox) {
    if (result.semantic_diff) {
      diffBox.classList.remove('hidden');

      if (result.semantic_diff.has_changed) {
        const changesHtml = (result.semantic_diff.changes || [])
          .map((change) => `<div class="diff-${change.type}">${change.type === 'added' ? '+' : '-'}${escapeHtml(change.text)}</div>`)
          .join('');

        diffBox.innerHTML = `<strong>Time Machine: document changed</strong>${changesHtml}`;
      } else {
        const scanDate = formatScanDate(result.semantic_diff.previous_date);

        diffBox.innerHTML = `<strong>Time Machine: no changes detected</strong>`
          + `<div class="diff-none">Unchanged since the last scan${scanDate ? ` (${scanDate})` : ''}.</div>`;
      }
    } else {
      diffBox.classList.add('hidden');
      diffBox.innerHTML = '';
    }
  }

  if (state.tabId) {
    chrome.tabs.sendMessage(state.tabId, {
      type: 'NEXUSKITTY_ANALYSIS_RESULT',
      categories: findings.map((finding) => finding.category),
      should_warn: Boolean(alert?.detected || highRiskCount >= 2 || (result.detected_trackers || []).length >= 3),
    }).catch(() => {});
  }

  showAnalysis();
}

function renderTechnicalSignals(result) {
  if (!elements.technicalSignals) return;
  const trackers = result.detected_trackers || [];
  if (!trackers.length) {
    elements.technicalSignals.classList.add('hidden');
    return;
  }
  elements.technicalSignals.classList.remove('hidden');
  elements.technicalSignals.innerHTML = `
    <div class="technical-heading">Technical layer</div>
    <div class="technical-title">Known trackers observed</div>
    <p>These known tracking or advertising domains loaded while the page was open. Compare them with the site's privacy disclosures.</p>
    <div class="tracker-list">${trackers.map((tracker) => `<span>${escapeHtml(tracker)}</span>`).join('')}</div>
  `;
}

function renderCookieBreakdown(result) {
  let box = document.getElementById('cookieBreakdownBox');
  const breakdown = result.cookie_breakdown;

  if (!breakdown || !breakdown.essential || !breakdown.all_optional) {
    box?.classList.add('hidden');
    return;
  }

  if (!box) {
    box = document.createElement('div');
    box.id = 'cookieBreakdownBox';
    box.className = 'finding-card';
    elements.findings.parentElement.insertBefore(box, elements.findings);
  }

  const option = (item) => `
    <div class="finding-meta"><strong>${escapeHtml(item.label || '')}</strong></div>
    <div class="finding-explanation">${(item.data_collected || []).map((entry) => escapeHtml(entry)).join(', ') || '—'}</div>
  `;

  box.innerHTML = `<h4 class="finding-title">What each choice means</h4>${option(breakdown.essential)}${option(breakdown.all_optional)}`;
  box.classList.remove('hidden');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

function looksLikeLegalDocument(url, text) {
  const source = `${url} ${text}`.toLowerCase();
  const markers = [
    'terms of service', 'terms and conditions', 'terms & conditions',
    'privacy policy', 'cookie policy', 'cookie settings', 'personal data',
    'data processing', 'consent', 'third parties', 'third-party',
    'data retention', 'arbitration', 'governing law', 'refund policy', 'subscription'
  ];
  const matches = markers.filter((marker) => source.includes(marker)).length;
  const legalUrl = /(terms|conditions|privacy|cookie|legal|gdpr|data-policy)/i.test(url);
  return legalUrl || matches >= 3;
}

async function resolveIsLegalPage() {
  if (state.legalSurface || state.consentControls.length > 0 || looksLikeLegalDocument(state.url, state.text)) {
    return true;
  }

  const textForClassification = (state.analysisText || state.text || '').slice(0, 4000);

  if (!textForClassification.trim()) {
    return false;
  }

  try {
    const classification = await request('/api/classify', {
      method: 'POST',
      body: JSON.stringify({ text: textForClassification }),
    });
    return classification.is_legal === true;
  } catch (error) {
    console.error('NexusKitty: /api/classify fallback check failed, keeping local heuristic result.', error);
    return false;
  }
}

// main.py requires every /api/* call to carry an X-Extension-Key header
// matching EXTENSION_API_KEY from backend/.env (see verify_extension_key()
// in backend/app/main.py). The key itself lives in config.js, which popup.html
// loads before this file, and is synced from backend/.env by
// scripts/sync_extension_config.py. Do not hardcode it here.
if (typeof EXTENSION_API_KEY === 'undefined') {
  throw new Error(
    'NexusKitty: config.js failed to load. Run "python scripts/sync_extension_config.py" to generate it.'
  );
}

// ------------------------------------------------------------------
// FIX (privacy bug): the backend's history endpoints used to return
// the same shared list to every installation of the extension, so
// opening the popup on a second Google profile showed the FIRST
// profile's scanned sites (sesame.bg, winbet.bg, ...). EXTENSION_API_KEY
// above is one fixed value baked into every copy of the extension, so
// it can never tell installations apart on its own.
//
// getClientId() generates a random UUID the very first time the
// extension runs and stores it in chrome.storage.local, so it survives
// restarts but is unique per installation/profile. It identifies a
// browser install, not a person - there is no login, name, or account
// tied to it. Every request now sends it as X-Client-Id, and the
// backend uses it to scope /api/analyze's history writes and
// /api/history's reads to this installation only.
// ------------------------------------------------------------------
async function getClientId() {
  const { nexusKittyClientId } = await chrome.storage.local.get('nexusKittyClientId');
  if (nexusKittyClientId) return nexusKittyClientId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ nexusKittyClientId: id });
  return id;
}

// A hung backend left the popup on the spinner forever with no way to tell
// "still working" from "never coming back". Every call now has a deadline.
const REQUEST_TIMEOUT_MS = 180000;

async function request(path, options = {}) {
  if (!EXTENSION_API_KEY) {
    throw new Error(
      'EXTENSION_API_KEY is empty. Re-run "python scripts/sync_extension_config.py" to sync it from backend/.env.'
    );
  }
  const clientId = await getClientId();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Extension-Key': EXTENSION_API_KEY,
        'X-Client-Id': clientId,
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`The backend did not answer ${path} within ${Math.round((options.timeoutMs || REQUEST_TIMEOUT_MS) / 1000)}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      detail = body?.detail || '';
    } catch {}
    throw new Error(`Backend returned ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  return response.json();
}

// Mirrors the popup's own progress into the service worker console, which is
// the console the user is already watching. Without it a failure inside the
// popup (its own devtools context) is invisible from here.
function popupLog(stage, detail) {
  try {
    chrome.runtime.sendMessage({ type: 'NEXUSKITTY_POPUP_LOG', stage, detail: detail ?? '' }).catch(() => {});
  } catch (error) {}
}

// One poll of the content script. A tab that was loaded before the extension
// was installed or reloaded has NO content script at all, and sendMessage then
// throws "Could not establish connection. Receiving end does not exist". That
// used to abort getPageData(), which returned an empty object, and the popup
// reported "No readable legal document text found" on a page that was perfectly
// analysable - the user had to hit refresh in devtools to make it work.
async function requestPageData(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'NEXUSKITTY_GET_PAGE_DATA', force_refresh: true });
  } catch (error) {
    popupLog('page-data request failed', error?.message || String(error));
    return null;
  }
}

// Re-inject the content script into a tab that has none. Errors are ignored on
// purpose: if an instance is already alive but busy, the re-declaration throws
// and the existing instance keeps answering, so polling succeeds either way.
async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['scripts/content.js'] });
    return true;
  } catch (error) {
    return false;
  }
}

async function getPageData(tabId) {
  try {
    let best = await requestPageData(tabId);
    if (!best) {
      const injected = await ensureContentScript(tabId);
      popupLog('content script missing, injection attempted', String(injected));
    }
    popupLog('first sample', JSON.stringify({
      chars: String(best?.text || '').length,
      jsRendered: best?.js_rendered_suspected === true,
      surrounding: best?.used_surrounding_page === true,
    }));

    // FIX (round 2): the previous version required BOTH text length >= 3000
    // AND a non-empty consent_controls array before it would exit early.
    // That works fine for cookie-banner-style pages, but a dedicated legal
    // document page (e.g. a standalone /privacy-policy or /terms-of-use
    // page) legitimately has NO consent buttons on it at all -
    // consent_controls stays [] for the entire polling window. So on those
    // pages the loop could never exit early and always burned through all
    // 6 attempts (2.1s), while content.js kept re-fetching the same legal
    // URLs over the network on every single force_refresh call (see the
    // matching fix in content.js's fetchLegalPageText), turning one popup
    // open into 6x the network traffic for no benefit and occasionally
    // resolving on a thin/incomplete candidate.
    //
    // Now: exit early once we have a clearly substantial amount of text,
    // regardless of consent_controls. Additionally, if the extracted text
    // length stops growing between polling ticks (a strong signal that
    // content.js has already converged on its best result), stop after two
    // consecutive "stable" ticks instead of waiting out the full budget.
    const candidateLength = (value) => String(value?.text || '').length;
    const seenCandidates = [best];

    // A page whose text only exists after JavaScript needs a real browser
    // render: window creation, navigation, hydration and a settle delay add up
    // to 5-20s. The old budget was 6 x 350ms = 2.1s, so the popup always gave
    // up first and reported "no readable legal document" while the render was
    // still running - that is the message that kept appearing on sesame.bg.
    // When a render is known to be needed, poll on a much longer, ramping
    // schedule and stop the moment real text shows up.
    // Anything shorter than a real policy gets the long schedule: a legal
    // document is never 200 characters, so a thin payload means "content.js has
    // not finished", not "that is all there is". The loop still exits on
    // >= 3000 chars or after 5 rounds without growth.
    const needsRender = (value) => !value || value?.js_rendered_suspected === true || candidateLength(value) < 3000;
    const longRun = needsRender(best);
    const maxAttempts = longRun ? 26 : 6;
    const delayFor = (attempt) => (longRun ? Math.min(350 + attempt * 350, 2000) : 350);

    let stableRounds = 0;
    let previousLength = candidateLength(best);
    // A discovery + fetch + render pass on a JS-driven site takes 15-25s, and
    // every poll blocks behind it, so the long budget is sized in wall-clock
    // terms rather than in attempts: 26 attempts ramping to 2s is ~40s.
    const deadline = longRun ? Date.now() + 40000 : Date.now() + 8000;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (longRun && Date.now() > deadline) {
        popupLog('polling deadline reached', JSON.stringify({ chars: candidateLength(best) }));
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, delayFor(attempt)));
      const candidate = await requestPageData(tabId);
      if (candidate) {
        seenCandidates.push(candidate);
        if (candidateLength(candidate) > candidateLength(best)) best = candidate;
      }

      const bestLen = candidateLength(best);

      // Substantial content is substantial, whether or not this page has
      // any consent_controls (dedicated privacy/terms pages usually don't).
      if (bestLen >= 3000) break;

      // FIX: an unchanged length used to mean "content.js has converged", and
      // on sesame.bg it meant the exact opposite. The payload sat at 57 chars
      // (the "no text" fallback) while content.js was still discovering the
      // legal URL, fetching it and running the browser render - 15s more work
      // that produced 9171 chars. Five quiet rounds ended the poll after ~4s
      // and the popup gave up before the extraction had even started. Quiet
      // rounds now only count as convergence when there is real text to be
      // stable about; a page that is still nothing gets the whole long budget.
      if (bestLen === previousLength && bestLen >= 300) {
        stableRounds += 1;
        if (stableRounds >= (longRun ? 4 : 2)) break;
      } else {
        stableRounds = 0;
      }
      previousLength = bestLen;
    }
    popupLog('polling finished', JSON.stringify({
      longRun,
      chars: candidateLength(best),
      rounds: seenCandidates.length,
    }));

    // FIX: `best` is chosen purely by text length, so a STALE cached payload
    // (written by a previous extraction pass, or by an older version of the
    // extension before these flags existed) can win the comparison and its
    // missing js_rendered_suspected / used_surrounding_page flags would hide
    // the warning. Merge the flags across every candidate instead: if any
    // extraction pass saw the problem, the popup must hear about it.
    if (best) {
      if (seenCandidates.some((c) => c?.js_rendered_suspected === true)) best.js_rendered_suspected = true;
      if (seenCandidates.some((c) => c?.used_surrounding_page === true)) best.used_surrounding_page = true;
    }

    if (best?.consent_controls) {
      best.consent_controls = best.consent_controls.filter((ctrl) => {
        const text = (ctrl.text || ctrl.label || '').toLowerCase();
        return /accept|agree|consent|allow|reject|decline|refuse|customise|customize|manage|preference|settings|приемам|съгласен|позволи|отказ|настройки|cookie/i.test(text);
      });
    }

    return best;
  } catch (error) {
    return { text: '', analysis_text: '', trackers: [], consent_controls: [], legal_surface: false };
  }
}

async function toggleSiteStatus() {
  if (!state.url) return;
  try {
    const domain = new URL(state.url).hostname;
    const { disabledDomains = [] } = await chrome.storage.local.get('disabledDomains');

    let updated;
    if (disabledDomains.includes(domain)) {
      updated = disabledDomains.filter((d) => d !== domain);
    } else {
      updated = [...disabledDomains, domain];
    }

    await chrome.storage.local.set({ disabledDomains: updated });
    window.location.reload();
  } catch (e) {
    console.error('Не можа да се промени състоянието за сайта:', e);
  }
}

// The UI is a normal action popup, so `currentWindow` is the browser window the
// user clicked in - exactly the page to analyse. The fallbacks only matter if
// the popup was opened some other way.
async function findAnalysedTab() {
  const isExtensionPage = (url) => typeof url === 'string' && url.startsWith('chrome-extension://');
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.url && !isExtensionPage(active.url)) return active;

  const candidates = await chrome.tabs.query({ active: true, windowType: 'normal' });
  const usable = candidates.filter((tab) => tab.url && !isExtensionPage(tab.url));
  if (usable.length) return usable[0];

  return active || null;
}

async function initialize() {
  showLoading();
  try {
    await request('/api/health', { timeoutMs: 10000 });
    setStatus(true);
    popupLog('health ok');

    const tab = await findAnalysedTab();
    state.url = tab?.url || '';
    state.tabId = tab?.id ?? null;
    popupLog('tab resolved', JSON.stringify({ tabId: state.tabId, url: state.url }));

    if (state.url) {
      const domain = new URL(state.url).hostname;
      const { disabledDomains = [] } = await chrome.storage.local.get('disabledDomains');

      if (disabledDomains.includes(domain)) {
        state.isDisabled = true;
        showError(`NexusKitty е изключен за ${domain}.`, false, true);
        updateBadgeAlert(false);
        return;
      }
    }

    const page = tab?.id ? await getPageData(tab.id) : { text: '', analysis_text: '', trackers: [], consent_controls: [], legal_surface: false };
    state.text = page.text || '';
    state.analysisText = page.analysis_text || page.text || '';
    state.trackers = page.trackers || [];
    state.consentControls = page.consent_controls || [];
    state.legalSurface = page.legal_surface === true;
    state.usedSurroundingPage = page.used_surrounding_page === true;
    state.jsRenderedSuspected = page.js_rendered_suspected === true;
    // Language of the DOCUMENT (not the browser) - tells the backend which
    // language the evidence quotes are expected to be in.
    state.detectedLanguage = page.detected_language || null;
    popupLog('page data ready', JSON.stringify({
      chars: state.text.length,
      analysisChars: String(state.analysisText || '').length,
      trackers: state.trackers.length,
      jsRendered: state.jsRenderedSuspected,
      surrounding: state.usedSurroundingPage,
      language: state.detectedLanguage,
    }));

    if (state.text.trim().length < 30 || state.text.startsWith('Legal analysis fallback for site: ')) {
      // A page whose text only exists after JavaScript needs a real browser
      // render, which takes seconds. Reporting "no readable text" at that point
      // is wrong and reads as a failure - say what is actually happening and
      // keep polling instead of giving up. getPageData() has already waited
      // through one long schedule, so this is the second and last pass.
      if (state.jsRenderedSuspected) {
        showLoading('Страницата се зарежда през JavaScript. Изчакваме пълния текст…');
        const retry = await getPageData(state.tabId);
        if ((retry?.text || '').trim().length >= 30) {
          state.text = retry.text || '';
          state.analysisText = retry.analysis_text || retry.text || '';
          state.detectedLanguage = retry.detected_language || state.detectedLanguage;
          state.jsRenderedSuspected = retry.js_rendered_suspected === true;
        }
        if (state.text.trim().length < 30) {
          popupLog('giving up: JS text never became readable');
          showError('The text of this page is rendered by JavaScript and did not become readable in time. Open the Privacy Policy, Terms or Cookies page itself and try again.', true);
          return;
        }
      } else {
        popupLog('giving up: no text after polling', JSON.stringify({ chars: state.text.length }));
        showError('No readable legal document text found on this page. Open Terms, Conditions, Privacy, or Cookies and try again.');
        return;
      }
    }

    // FIX: content.js could not extract the policy itself and fell back to the
    // raw text of the surrounding page (typical for a client-side-rendered
    // consent-settings page, whose static HTML is just a loading template).
    // Analyzing that would hand the LLM an unrelated marketing page, so say so
    // plainly instead of returning a confident 0-findings result.
    if (state.usedSurroundingPage) {
      popupLog('stopping: used_surrounding_page');
      showError(
        'Could not extract the actual policy text — only the surrounding page was found. The linked policy is likely rendered by JavaScript, so open the Privacy Policy, Legal Notice or Cookie Settings page directly and analyze it from there.',
        true
      );
      return;
    }

    // FIX: legal URLs were found and fetched with 200 OK, but every body came
    // back empty - the site renders its policy client-side. A plain fetch()
    // cannot execute JS, so the only text left is the cookie banner. Analyze
    // that, but say plainly that the policy itself was never read, otherwise
    // "0 issues" reads as "the policy is clean".
    if (state.jsRenderedSuspected) {
      popupLog('stopping: js_rendered_suspected');
      showError(
        'The linked privacy/terms pages are rendered by JavaScript, so their text could not be read. Only the visible consent banner can be analyzed. Open the Privacy Policy page itself and run NexusKitty from there for a full analysis.',
        true
      );
      return;
    }

    const isLegal = await resolveIsLegalPage();
    popupLog('legal page check', JSON.stringify({ isLegal, legalSurface: state.legalSurface }));

    if (!isLegal) {
      showError('This looks like a regular webpage, not a legal document. Open its Terms, Privacy, or Cookie Policy page to analyze it.', true);
      return;
    }

    await analyzeCurrentPage();
  } catch (error) {
    setStatus(false);
    popupLog('initialize failed', error?.message || String(error));
    showError(`The request to the backend failed: ${error?.message || error}. Check that FastAPI runs on 127.0.0.1:8000 and reload the extension.`);
    console.error('NexusKitty initialization failed:', error);
  }
}

async function analyzeCurrentPage(override = false) {
  showLoading();
  try {
    // FIX: the request used to send state.analysisText (the English machine
    // translation) as THE document, so every `evidence` quote came back in
    // English even though the prompt and the schema both demand a verbatim
    // quote in the document's original language. Send the ORIGINAL text as
    // the document - that is what gets quoted - and pass the translation
    // separately so the model can still reason in English.
    const originalText = state.text || '';
    const translatedText = state.analysisText && state.analysisText !== originalText ? state.analysisText : null;

    const result = await request('/api/analyze', {
      method: 'POST',
      body: JSON.stringify({
        url: state.url,
        text: originalText,
        translated_text: translatedText,
        detected_language: state.detectedLanguage || null,
        detected_trackers: state.trackers || [],
        consent_controls: state.consentControls || [],
        language: (navigator.language || 'en').split('-')[0],
      }),
    });
    popupLog('analysis response', JSON.stringify({
      findings: result?.findings?.length ?? null,
      score: result?.score ?? result?.risk_score ?? null,
      keys: Object.keys(result || {}).join(','),
    }));
    renderAnalysis(result);
    popupLog('analysis rendered');
    if (override && state.usedSurroundingPage) showSurroundingPageWarning();
    if (override && state.jsRenderedSuspected) showJsRenderedWarning();
  } catch (error) {
    popupLog('analysis failed', error?.message || String(error));
    showError(`The analysis request failed: ${error?.message || error}`);
    console.error('NexusKitty analysis failed:', error);
  }
}

function switchTab(tabName) {
  document.querySelectorAll('.tab-button').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === tabName);
  });
  document.querySelectorAll('.panel').forEach((panel) => {
    panel.classList.toggle('hidden', panel.id !== `panel-${tabName}`);
  });
  if (tabName === 'history') loadHistory();
}

async function loadHistory() {
  try {
    const history = await request('/api/history?limit=5');
    elements.history.innerHTML = history.length ? history.map((item) => `
      <article class="history-item">
        <div class="history-domain">${escapeHtml(item.domain || 'Unknown domain')}</div>
        <div class="history-score">${(item.findings || []).length} issue(s) found</div>
        <div class="history-summary">${escapeHtml((item.summary || '').slice(0, 160))}</div>
      </article>
    `).join('') : '<div class="history-item">No scans yet.</div>';
  } catch (error) {
    elements.history.innerHTML = '<div class="history-item">History is unavailable.</div>';
  }
}

function appendChat(role, text) {
  const message = document.createElement('div');
  message.className = `chat-message ${role}`;
  message.textContent = text;
  elements.chat.appendChild(message);
  elements.chat.scrollTop = elements.chat.scrollHeight;
}

function attachEvents() {
  document.querySelectorAll('.tab-button').forEach((button) => {
    button.addEventListener('click', () => switchTab(button.dataset.tab));
  });

  document.querySelectorAll('.filter-btn').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach((item) => item.classList.remove('active'));
      button.classList.add('active');
      state.filter = button.dataset.category;
      renderFindings(state.analysis?.findings || []);
    });
  });

  if (elements.toggleSite) {
    elements.toggleSite.addEventListener('click', toggleSiteStatus);
  }

  elements.gdpr?.addEventListener('click', () => {
    const recipient = state.analysis?.privacy_email || '';
    const subject = encodeURIComponent('Formal Objection to Data Processing / AI Training under GDPR Art. 21');
    const body = encodeURIComponent(
      'Dear Data Protection Officer,\n\n'
      + 'I hereby exercise my right to object under Article 21 of the GDPR to the processing, profiling, sale, sharing, and monetization of my personal data. '
      + 'Where applicable, I also request erasure under Article 17 and immediate exclusion of my data and content from AI model training datasets.\n\n'
      + 'Please confirm the measures taken, the categories of data processed, the recipients or partners involved, and the legal basis for any continued processing.\n\n'
      + 'Regards,'
    );
    window.open(`mailto:${encodeURIComponent(recipient)}?subject=${subject}&body=${body}`, '_blank');
  });

  elements.chatForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const question = elements.question.value.trim();
    if (!question) return;
    appendChat('user', question);
    elements.question.value = '';
    elements.send.disabled = true;
    try {
      const answer = await request('/api/ask', {
        method: 'POST',
        // Same reasoning as analyzeCurrentPage: ask against the ORIGINAL
        // document so `evidence_quote` can be quoted verbatim in the page's
        // own language.
        body: JSON.stringify({ url: state.url, question, context_text: state.text || '' }),
      });
      appendChat('bot', answer.answer || 'No answer returned.');
    } catch (error) {
      console.error('Ask Kitty failed:', error);
      appendChat('bot', 'Kitty could not get an answer. Please try again.');
    } finally {
      elements.send.disabled = false;
    }
  });

  appendChat('bot', 'Ask me about the terms on this page.');
}

document.addEventListener('DOMContentLoaded', () => {
  attachEvents();
  initialize();
});