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
  chatHistory: [],
};

const elements = {
  status: document.getElementById('statusBadge'),
  loading: document.getElementById('loadingState'),
  analysis: document.getElementById('analysisState'),
  error: document.getElementById('errorState'),
  score: document.getElementById('scoreValue'),
  scoreLabel: document.getElementById('scoreLabel'),
  issueCount: document.getElementById('issueCount'),
  issueBreakdown: document.getElementById('issueBreakdown'),
  riskWhy: document.getElementById('riskWhy'),
  risk: document.getElementById('riskPill'),
  summary: document.getElementById('summaryText'),
  ring: document.querySelector('.score-ring'),
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

function riskMeta(score) {
  if (score >= 80) return { label: 'Very safe', className: 'safe' };
  if (score >= 50) return { label: 'Moderate risk', className: 'warning' };
  return { label: 'High risk', className: 'danger' };
}

function renderScore(score) {
  const meta = riskMeta(score);
  const angle = Math.max(0, Math.min(score, 100)) * 3.6;
  if (elements.score) elements.score.textContent = score;
  if (elements.scoreLabel) elements.scoreLabel.textContent = meta.label;
  if (elements.risk) {
    elements.risk.textContent = meta.label;
    elements.risk.className = `risk-pill ${meta.className}`;
  }
  if (elements.ring) {
    elements.ring.style.background = `conic-gradient(var(--acid) 0deg ${angle}deg, rgba(255,255,255,0.08) ${angle}deg 360deg)`;
  }
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

  const diffBox = document.getElementById('semanticDiffBox');
  if (diffBox && result.semantic_diff?.has_changed) {
    diffBox.classList.remove('hidden');
    diffBox.innerHTML = `<strong>Time Machine: document changed</strong>${result.semantic_diff.changes.map((change) => `<div class="diff-${change.type}">${change.type === 'added' ? '+' : '-'}${escapeHtml(change.text)}</div>`).join('')}`;
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
    <div class="technical-title">Observed website signals</div>
    <p>These domains were observed while the page was open. Compare them with the site's privacy disclosures.</p>
    <div class="tracker-list">${trackers.map((tracker) => `<span>✓ ${escapeHtml(tracker)}</span>`).join('')}</div>
  `;
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

function detectLanguage(text) {
  if (/\u3040-\u30FF/.test(text)) return 'ja';
  if (/[\uAC00-\uD7AF]/.test(text)) return 'ko';
  if (/[\u4E00-\u9FFF]/.test(text)) return 'zh';
  if (/[\u0600-\u06FF]/.test(text)) return 'ar';
  if (/[\u0590-\u05FF]/.test(text)) return 'he';
  if (/[\u0370-\u03FF]/.test(text)) return 'el';
  if (/[\u0900-\u097F]/.test(text)) return 'hi';
  if (/[\u0E00-\u0E7F]/.test(text)) return 'th';
  if (/[\u0400-\u04FF]/.test(text)) {
    if (/[іїєґ]/.test(text)) return 'uk';
    if (/[ыэё]/.test(text)) return 'ru';
    return 'bg';
  }
  return 'en';
}

const ERROR_MESSAGES = {
  bg: 'Възникна грешка при връзката с модела. Моля, опитайте пак.',
  ru: 'Возникла ошибка при подключении к модели. Попробуйте позже.',
  uk: 'Виникла помилка під час підключення до моделі. Спробуйте пізніше.',
  ja: 'モデルへの接続中にエラーが発生しました。後でもう一度試してください。',
  en: 'An error occurred while connecting to the AI model. Please try again shortly.',
};

const UI_ERRORS = {
  bg: {
    noText: 'Не е намерен четим текст за правен документ на тази страница. Отворете Terms, Conditions, Privacy или Cookies и опитайте отново.',
    notLegal: 'Изглежда като обикновена уеб страница, а не правен документ. Отворете Terms, Privacy или Cookie Policy страницата и опитайте отново.',
    backendDown: 'Бекендът е недостъпен. Проверете https://nexuskitty.onrender.com и презаредете разширението.',
    disabled: 'NexusKitty е изключен за',
  },
  en: {
    noText: 'No readable legal document text found on this page. Open Terms, Conditions, Privacy, or Cookies and try again.',
    notLegal: 'This looks like a regular webpage, not a legal document. Open its Terms, Privacy, or Cookie Policy page to analyze it.',
    backendDown: 'The backend is unavailable. Check https://nexuskitty.onrender.com and reload the extension.',
    disabled: 'NexusKitty is disabled for',
  },
};

function getUiLanguage() {
  const lang = (navigator.language || 'en').split('-')[0].toLowerCase();
  if (Object.keys(UI_ERRORS).includes(lang)) return lang;
  return 'en';
}

function getUiError(key) {
  const lang = getUiLanguage();
  return UI_ERRORS[lang][key] || UI_ERRORS.en[key];
}

function getErrorMessage(text) {
  const lang = detectLanguage(text);
  return ERROR_MESSAGES[lang] || ERROR_MESSAGES.en;
}

function looksLikeLegalDocument(url, text) {
  const source = `${url} ${text}`.toLowerCase();
  const markers = [
    // English
    'terms of service', 'terms and conditions', 'terms & conditions',
    'privacy policy', 'cookie policy', 'cookie settings', 'personal data',
    'data processing', 'consent', 'third parties', 'third-party',
    'data retention', 'arbitration', 'governing law', 'refund policy', 'subscription',
    // Bulgarian
    'правила за поверителност', 'политика по поверителност', 'бисквитки',
    'съгласие', 'лични данни', 'обработка на данни', 'трети страни',
    'правила и условия', 'арбитраж', 'данъчно задържане', 'абонамент',
    // Russian
    'политика конфиденциальности', 'файлы cookie', 'согласие',
    'личные данные', 'обработка данных', 'третьи стороны',
    'условия', 'арбитраж', 'подписка', 'договор', ' возврат',
    // Ukrainian
    'політика конфіденційності', ' файли cookie', 'згода',
    'особисті дані', 'обробка даних', 'треті сторони',
    'умови', 'арбітраж', 'підписка',
    // German
    'datenschutz', 'cookies', 'einwilligung', 'nutzungsbedingungen',
    'vertrag', 'widerruf', 'abonnement',
    // French
    'politique de confidentialité', 'cookies', 'consentement',
    'conditions générales', 'données personnelles', 'abonnement',
    // Spanish
    'política de privacidad', 'cookies', 'consentimiento',
    'términos y condiciones', 'datos personales', 'suscripción',
    // Italian
    'politica sulla privacy', 'cookie', 'consenso',
    'condizioni generali', 'dati personali', 'abbonamento',
    // Portuguese
    'política de privacidade', 'cookies', 'consentimento',
    'condições gerais', 'dados pessoais', 'assinatura',
    // Dutch
    'privacybeleid', 'cookies', 'toestemming',
    'gebruiksvoorwaarden', 'persoonsgegevens', 'abonnement',
    // Polish
    'polityka prywatności', 'ciasteczka', 'zgoda',
    'warunki korzystania', 'dane osobowe', 'abonament',
    // Czech
    'zásady ochrany osobních údajů', 'cookies', 'souhlas',
    'podmínky použití', 'osobní údaje',
    // Hungarian
    'adatvédelmi nyilatkozat', 'sütik', 'hozzájárulás',
    'használati feltételek', 'személyes adatok', 'előfizetés',
    // Romanian
    'politica de confidențialitate', 'cookie-uri', 'consimțământ',
    'condiții generale', 'date personale', 'abonament',
    // Turkish
    'kişisel verilerin korunması', 'çerezler', 'onay',
    'kullanım şartları', 'abone olma',
    // Greek
    'πολιτική απορρήου', 'cookie', 'συγκατάθεση',
    'όροι χρήσης', 'προσωπικά δεδομένα',
    // Arabic
    'سياسة الخصوصية', 'ملفات ارتساعية', 'موافقة',
    'شروط الاستخدام', 'بيانات شخصية',
    // Japanese
    'プライバシーポリシー', 'クッキー', '同意', '利用規約', '個人データ',
    // Korean
    '개인정보 처리방침', '쿠키', '동의', '이용 약관',
    // Chinese (Simplified)
    '隐私政策', 'cookie', '同意', '使用条款', '个人信息',
    // Hindi
    'गोपनीयता नीति', 'कूकीज', 'सहमति', 'उपयोग conditions', 'व्यक्तिगत डेटा',
    // Thai
    'นโยบายความเป็นส่วนตัว', 'คุกกี้', 'การยินยอม', 'ข้อกำหนดการใช้',
    // Hebrew
    'מדיניות פרטיות', 'עוגיות', 'הסכם', 'תנאי שירות',
  ];
  const matches = markers.filter((marker) => source.includes(marker)).length;
  const legalUrl = /(terms|conditions|privacy|cookie|legal|gdpr|data-policy|политика|бисквитки|съгласие|правила|datenschutz|politique|privacidad|confidențialitate|kişisel|προσωπικά|سياسة|使用|개인|गोपनीयता|ความเป็น|מדיניות)/i.test(url);
  return legalUrl || matches >= 2;
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
        showError(`${getUiError('disabled')} ${domain}.`, false, true);
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
      showError(getUiError('noText'));
      return;
    }

    if (!looksLikeLegalDocument(state.url, state.text) && !state.consentControls.length && !state.legalSurface) {
      // Secondary AI check: classify via backend to catch multilingual/legal text
      // that the word-based heuristic missed.
      try {
        const classifyResp = await request('/api/classify', {
          method: 'POST',
          body: JSON.stringify({ text: state.text.slice(0, 2000) }),
        });

        if (!classifyResp.is_legal) {
          showError(getUiError('notLegal'), true);
          return;
        }
      } catch {
        // If the classify endpoint is unreachable, proceed with analysis
        // (conservative: don't block potentially legal content).
      }
    }

    await analyzeCurrentPage();
  } catch (error) {
    setStatus(false);
    showError(getUiError('backendDown'));
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
        consent_controls: state.consentControls || []
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
    elements.history.innerHTML = history.length ? history.map((item) => {
      const score = Number(item.safety_score) || 0;
      const label = item.safety_prediction || safetyLabel(score);
      const riskClass = score >= 65 ? 'safe' : score >= 40 ? 'warning' : 'danger';
      return `
      <article class="history-item">
        <div class="history-domain">${escapeHtml(item.domain || 'Unknown domain')}</div>
        <div class="history-score">
          <span class="history-score-badge ${riskClass}">${escapeHtml(label)}</span>
          <span class="history-score-num">${score}/100</span>
        </div>
        <div class="history-summary">${escapeHtml((item.summary || '').slice(0, 400))}</div>
      </article>
      `;
    }).join('') : '<div class="history-item">No scans yet.</div>';
  } catch (error) {
    elements.history.innerHTML = '<div class="history-item">History is unavailable.</div>';
  }
}

function safetyLabel(score) {
  if (score >= 85) return 'Very safe';
  if (score >= 65) return 'Mostly safe';
  if (score >= 40) return 'Use with caution';
  if (score >= 20) return 'Risky';
  return 'High risk';
}

function appendChat(role, text) {
  const message = document.createElement('div');
  message.className = `chat-message ${role}`;
  message.textContent = text;
  elements.chat.appendChild(message);
  elements.chat.scrollTop = elements.chat.scrollHeight;

  // Track chat history for context — keep the full conversation alive
  // so follow-up questions can reference earlier messages.
  state.chatHistory.push({
    sender: role === 'bot' ? 'assistant' : 'user',
    text,
  });
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
        body: JSON.stringify({
          url: state.url,
          question,
          context_text: state.text,
          history: state.chatHistory,
        }),
      });
      appendChat('bot', answer.answer || 'No answer returned.');
    } catch (error) {
      console.error('Ask Kitty failed:', error);
      appendChat('bot', getErrorMessage(question));
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