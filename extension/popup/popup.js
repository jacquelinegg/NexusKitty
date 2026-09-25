const state = {
  url: '',
  text: '',
  trackers: [],
  consentControls: [],
  legalSurface: false,
  tabId: null,
  analysis: null,
  filter: 'all',
  isDisabled: false,
  historyCache: [],
};

const elements = {
  status: document.getElementById('statusBadge'),
  loading: document.getElementById('loadingState'),
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

function showLoading() {
  elements.loading?.classList.remove('hidden');
  elements.analysis?.classList.add('hidden');
  elements.error?.classList.add('hidden');
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
      <div class="finding-evidence">"${escapeHtml(finding.evidence || 'No evidence supplied.')}"</div>
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

  // Актуализация на значката (Badge) при задължителен преглед
  const requiresAttention = Boolean(alert?.detected || highRiskCount >= 1);
  updateBadgeAlert(requiresAttention);

  elements.banner.classList.toggle('hidden', !criticalFinding && !alert?.detected);
  if (alert?.detected) {
    elements.banner.textContent = `${alert.title} ${alert.message} ${alert.trackers.join(', ')}`;
    elements.banner.classList.remove('hidden');
  }

  // Time Machine: keep this panel visible whenever we have a previous
  // snapshot to compare against, not only when the document changed.
  // Previously the box only appeared on a real diff and silently stayed
  // hidden (or stale) on every later scan of an unchanged document.
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
      // No previous snapshot exists yet for this domain (first-ever scan).
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

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
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

async function getPageData(tabId) {
  try {
    let best = await chrome.tabs.sendMessage(tabId, { type: 'NEXUSKITTY_GET_PAGE_DATA', force_refresh: true });

    // Филтрация: Търсим изрично маркери за съгласие/условия
    const legalScore = (value) => (
      String(value || '').match(/cookie|cookies|куки|файлы куки|consent|соглас|personal data|персональн.{0,12}данн|advertising partner|similar technolog|terms|условия|conditions|privacy|конфиденциаль|policy|политик|legal|accept|принять|agree|согласен|acknowledge/gi) || []
    ).length;

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 350));
      const candidate = await chrome.tabs.sendMessage(tabId, { type: 'NEXUSKITTY_GET_PAGE_DATA', force_refresh: true });
      if (legalScore(candidate?.text) > legalScore(best?.text)) best = candidate;
      if (legalScore(best?.text) >= 4 && (best?.consent_controls || []).length) break;
    }

    // Изчистване на бутоните, които не отговарят на условия за съгласие
    if (best?.consent_controls) {
      best.consent_controls = best.consent_controls.filter((ctrl) => {
        const text = (ctrl.text || ctrl.label || '').toLowerCase();
        return /accept|agree|consent|allow|приемам|съгласен|позволи|cookie/i.test(text);
      });
    }

    return best;
  } catch (error) {
    return { text: '', trackers: [], consent_controls: [], legal_surface: false };
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

async function initialize() {
  showLoading();
  try {
    await request('/api/health');
    setStatus(true);

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    state.url = tab?.url || '';
    state.tabId = tab?.id || null;

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

    const page = tab?.id ? await getPageData(tab.id) : { text: '', trackers: [], consent_controls: [], legal_surface: false };
    state.text = page.text || '';
    state.trackers = page.trackers || [];
    state.consentControls = page.consent_controls || [];
    state.legalSurface = page.legal_surface === true;

    if (state.text.trim().length < 30) {
      showError('No readable legal document text found on this page. Open Terms, Conditions, Privacy, or Cookies and try again.');
      return;
    }

    if (!looksLikeLegalDocument(state.url, state.text) && !state.consentControls.length && !state.legalSurface) {
      showError('This looks like a regular webpage, not a legal document. Open its Terms, Privacy, or Cookie Policy page to analyze it.', true);
      return;
    }

    await analyzeCurrentPage();
  } catch (error) {
    setStatus(false);
    showError('The local backend is unavailable. Start FastAPI on 127.0.0.1:8000 and reload the extension.');
    console.error('NexusKitty initialization failed:', error);
  }
}

async function analyzeCurrentPage(override = false) {
  showLoading();
  try {
    const result = await request('/api/analyze', {
      method: 'POST',
      body: JSON.stringify({
        url: state.url,
        text: state.text,
        detected_trackers: state.trackers || [],
        consent_controls: state.consentControls || [],
        language: (navigator.language || 'en').split('-')[0],
      }),
    });
    renderAnalysis(result);
  } catch (error) {
    showError('The analysis request failed. Check the backend and try again.');
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
    if (!history.length) {
      elements.history.innerHTML = '<div class="history-item">No scans yet.</div>';
      return;
    }

    state.historyCache = history;

    elements.history.innerHTML = history.map((item, index) => `
      <article class="history-item" data-history-index="${index}">
        <div class="history-domain">${escapeHtml(item.domain || 'Unknown domain')}</div>
        <div class="history-score">${(item.findings || []).length} issue(s) found</div>
        <div class="history-summary">${escapeHtml((item.summary || '').slice(0, 160))}</div>
      </article>
    `).join('');

    elements.history.querySelectorAll('.history-item').forEach((el) => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.historyIndex, 10);
        const item = state.historyCache?.[idx];
        if (item) {
          renderAnalysis(item);
          switchTab('analysis');
        }
      });
    });
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
        body: JSON.stringify({ url: state.url, question, context_text: state.text }),
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