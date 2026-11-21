(function () {
  const API_BASE_URL = window.JEFF_API_BASE_URL || window.API_BASE_URL ||
    (window.location.hostname === 'localhost' && window.location.port === '8080'
      ? 'http://localhost:8012'
      : window.location.origin);
  let authToken = window.JEFF_JWT || localStorage.getItem('jeff_jwt') || '';
  const userId = localStorage.getItem('jeff_user_id') || crypto.randomUUID();
  localStorage.setItem('jeff_user_id', userId);

  const MODES = ['general', 'investor', 'customer', 'business_model', 'campaign_builder', 'financial'];
  const PERSONA_TO_MODE = {
    orb: 'general',
    investor: 'investor',
    customer: 'customer',
    business: 'business_model',
    campaign: 'campaign_builder',
    financial: 'financial',
  };
  const MODE_TO_PERSONA = Object.fromEntries(Object.entries(PERSONA_TO_MODE).map(([persona, mode]) => [mode, persona]));
  const MODE_LABELS = {
    general: 'General',
    investor: 'Investor',
    customer: 'Customer',
    business_model: 'Business Model',
    campaign_builder: 'Campaign Builder',
    financial: 'Financial',
  };
  const WELCOME_MESSAGES = {
    general: "Hi, I'm Jeff. Tell me what you're building and where you're stuck.",
    investor: "Hi, I'm Jeff. Let's build your investor story. What stage are you at, and who are you trying to reach?",
    customer: "Hi, I'm Jeff. Let's get inside your customer's head. Who is the person whose life you're trying to make better?",
    business_model: "Hi, I'm Jeff. Let's design your business model. Tell me what you're building and who pays for it.",
    campaign_builder: "Hi, I'm Jeff. Let's turn your startup into a JustStartUp campaign. Tell me what you're building and what outcome you want.",
    financial: "Hi, I'm Jeff. Let's run the numbers. What's your current MRR, burn rate, or financial question?",
  };
  const PERSONAS = {
    orb: { name: 'Nova', role: 'general assistant' },
    investor: { name: 'Aldric', role: 'investor mode · due diligence' },
    customer: { name: 'Mira', role: 'customer mode · the buyer' },
    business: { name: 'Axle', role: 'business model mode · unit economics' },
    campaign: { name: 'Volt', role: 'campaign builder mode · launch plan' },
    financial: { name: 'Ledger', role: 'financial mode · numbers only' },
  };

  const savedModeSessions = (() => {
    try { return JSON.parse(localStorage.getItem('jeff_mode_sessions') || '{}') || {}; }
    catch (_) { return {}; }
  })();
  const modeSessions = { ...savedModeSessions };
  MODES.forEach((mode) => { if (!modeSessions[mode]) modeSessions[mode] = crypto.randomUUID(); });
  localStorage.setItem('jeff_mode_sessions', JSON.stringify(modeSessions));
  const modeChatCache = Object.fromEntries(MODES.map((mode) => [mode, null]));
  const savedMode = localStorage.getItem('jeff_active_mode');
  let currentMode = MODES.includes(savedMode) ? savedMode : 'general';
  let persona = MODE_TO_PERSONA[currentMode];
  let sessionId = modeSessions[currentMode];
  let isStreaming = false;
  let personaLoading = false;
  let quotaRemaining = null;
  let campaignInputs = {};

  const app = document.querySelector('.app');
  const log = document.getElementById('log');
  const input = document.getElementById('input');
  const sendButton = document.getElementById('send');
  const tokenChip = document.getElementById('tokenChip');
  const tokenLeft = document.getElementById('tokLeft');
  const tokenLimit = document.getElementById('tokLimit');
  const tokenBar = document.getElementById('tokBar');
  const tokenReset = document.getElementById('tokReset');
  const uploadButton = document.getElementById('campaignUploadBtn');
  const uploadModal = document.getElementById('campaignUploadModal');
  const uploadStatus = document.getElementById('campaignUploadStatus');
  const uploadFile = document.getElementById('campaignUploadFile');
  const uploadSubmit = document.getElementById('campaignUploadSubmit');
  const closeOverlay = document.getElementById('closeOverlay');

  const personaButtons = {
    investor: document.getElementById('btnInvestor'),
    customer: document.getElementById('btnCustomer'),
    business: document.getElementById('btnBusiness'),
    campaign: document.getElementById('btnCampaign'),
    financial: document.getElementById('btnFinancial'),
  };
  const orbButton = document.getElementById('btnOrb');
  const modeButtons = document.querySelectorAll('.modebtn');
  const nameElement = document.getElementById('agentName');
  const roleElement = document.getElementById('agentRole');
  const avatar = document.getElementById('av');
  const contextFilter = document.getElementById('disp');
  const turbulence = document.getElementById('turb');

  const frameSets = {
    investor: JSON.parse(document.getElementById('frames').textContent),
    customer: JSON.parse(document.getElementById('framesC').textContent),
    business: JSON.parse(document.getElementById('framesB').textContent),
    campaign: JSON.parse(document.getElementById('framesK').textContent),
    financial: JSON.parse(document.getElementById('framesF').textContent),
  };
  const frameImages = Object.fromEntries(Object.keys(frameSets).map((key) => [key, null]));
  const frameLoads = {};
  const sceneUrls = {
    investor: '/ui-assets/images/scenes/investor-e4e3fc8121.webp',
    customer: '/ui-assets/images/scenes/customer-b29dc3a280.webp',
    business: '/ui-assets/images/scenes/business-30d970e38a.webp',
    campaign: '/ui-assets/images/scenes/campaign-70837fcaa4.webp',
    financial: '/ui-assets/images/scenes/financial-68d8aa4913.webp',
  };
  const sceneLoads = {};
  const avatarFrameCount = frameSets.investor.length;
  let animationQueue = [];
  let animationStep = null;
  let animationStart = 0;
  const animationDuration = 1700;

  function ensureFrames(key) {
    if (frameImages[key]) return Promise.resolve(frameImages[key]);
    if (frameLoads[key]) return frameLoads[key];
    frameLoads[key] = Promise.all(frameSets[key].map((src) => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`Avatar frame failed to load: ${src}`));
      image.src = src;
    }))).then((images) => {
      frameImages[key] = images;
      return images;
    }).catch((error) => {
      frameLoads[key] = null;
      throw error;
    });
    return frameLoads[key];
  }

  function ensureScene(key) {
    if (key === 'orb' || sceneLoads[key]) return sceneLoads[key] || Promise.resolve();
    sceneLoads[key] = new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = resolve;
      image.onerror = () => reject(new Error(`Scene failed to load: ${sceneUrls[key]}`));
      image.src = sceneUrls[key];
    }).catch((error) => {
      sceneLoads[key] = null;
      throw error;
    });
    return sceneLoads[key];
  }

  function drawAvatar(set, frameIndex) {
    if (!frameImages[set]) return;
    const context = avatar.getContext('2d');
    const image = frameImages[set][frameIndex];
    context.clearRect(0, 0, avatar.width, avatar.height);
    const scale = Math.min(avatar.width / image.width, avatar.height / image.height);
    context.drawImage(image, (avatar.width - image.width * scale) / 2, (avatar.height - image.height * scale) / 2, image.width * scale, image.height * scale);
  }

  function applyPersonaScene(target) {
    app.style.setProperty('--jeff-theme-scene', target === 'orb' ? 'none' : `url("${sceneUrls[target]}")`);
    ['investor', 'customer', 'business', 'campaign', 'financial'].forEach((key) => {
      app.classList.toggle(key, target === key);
    });
  }

  function updateModeButtons() {
    modeButtons.forEach((button) => {
      const active = button.dataset.persona === persona;
      button.classList.toggle('on', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function setControlsDisabled(disabled) {
    input.disabled = disabled;
    uploadButton.disabled = disabled || quotaRemaining === 0;
    sendButton.disabled = disabled || quotaRemaining === 0;
    Object.values(personaButtons).forEach((button) => { button.disabled = disabled; });
    orbButton.disabled = disabled;
  }

  function nextAnimationStep(now) {
    animationStep = animationQueue.shift() || null;
    animationStart = now;
    if (!animationStep) {
      personaLoading = false;
      setControlsDisabled(isStreaming);
    }
  }

  function animateAvatar(now) {
    const elapsed = now - animationStart;
    let scale;
    if (animationStep) {
      const progress = Math.min(elapsed / animationDuration, 1);
      const surge = Math.sin(progress * Math.PI);
      scale = 3 + surge * 13;
      turbulence.setAttribute('baseFrequency', `${(0.018 + surge * 0.016).toFixed(4)} ${(0.026 + surge * 0.020).toFixed(4)}`);
      const frameProgress = animationStep.dir > 0 ? progress : 1 - progress;
      drawAvatar(animationStep.set, Math.round(frameProgress * (avatarFrameCount - 1)));
      if (progress >= 1) nextAnimationStep(now);
    } else if (persona === 'orb') {
      const blink = (Math.sin(elapsed / 760) + 1) / 2;
      scale = 2.5 + blink * 4.5;
      turbulence.setAttribute('baseFrequency', `${(0.018 + 0.006 * Math.sin(elapsed / 2700)).toFixed(4)} ${(0.028 + 0.006 * Math.cos(elapsed / 3200)).toFixed(4)}`);
    } else {
      const blink = (Math.sin(elapsed / 1000) + 1) / 2;
      scale = 1 + blink * 1.8;
      turbulence.setAttribute('baseFrequency', `${(0.012 + 0.003 * Math.sin(elapsed / 3500)).toFixed(4)} ${(0.016 + 0.003 * Math.cos(elapsed / 4000)).toFixed(4)}`);
    }
    contextFilter.setAttribute('scale', scale.toFixed(2));
    requestAnimationFrame(animateAvatar);
  }

  function scrollToBottom() { log.scrollTop = log.scrollHeight; }
  function escapeHTML(text) {
    const div = document.createElement('div');
    div.textContent = String(text ?? '');
    return div.innerHTML;
  }
  function renderMarkdown(text) {
    if (typeof marked !== 'undefined') {
      marked.setOptions({ breaks: true, gfm: true });
      return marked.parse(text);
    }
    return escapeHTML(text).replace(/\n/g, '<br>');
  }

  function addSystemMessage(text) {
    const message = document.createElement('div');
    message.className = 'sys';
    message.textContent = text;
    log.appendChild(message);
    scrollToBottom();
  }

  function addUserMessage(text) {
    const message = document.createElement('div');
    message.className = 'msg user';
    message.innerHTML = '<span class="tag"></span><div class="body"></div>';
    message.querySelector('.tag').textContent = 'you';
    message.querySelector('.body').textContent = text;
    log.appendChild(message);
    scrollToBottom();
    return message;
  }

  function addJeffMessage(text, mode = currentMode, exportable = true) {
    const message = document.createElement('div');
    message.className = 'msg agent';
    message.dataset.mode = mode;
    message.innerHTML = '<span class="tag"></span><div class="body"></div>';
    message.querySelector('.tag').textContent = PERSONAS[MODE_TO_PERSONA[mode]].name.toLowerCase();
    message.querySelector('.body').innerHTML = renderMarkdown(text);
    log.appendChild(message);
    if (exportable) attachExportActions(message, text, mode);
    scrollToBottom();
    return message;
  }

  function renderHistory(messages, mode) {
    log.innerHTML = '';
    if (!Array.isArray(messages) || messages.length === 0) {
      addJeffMessage(WELCOME_MESSAGES[mode], mode, false);
      return;
    }
    messages.forEach((message) => {
      if (message.role === 'user') addUserMessage(message.content);
      else if (message.role === 'assistant') addJeffMessage(message.content, mode);
    });
  }

  function showTypingIndicator() {
    const message = document.createElement('div');
    message.className = 'msg agent';
    message.dataset.mode = currentMode;
    message.innerHTML = `<span class="tag">${PERSONAS[persona].name.toLowerCase()}</span><div class="body"><span class="typing"><i></i><i></i><i></i></span></div>`;
    log.appendChild(message);
    scrollToBottom();
    return message;
  }

  function setQuota(remaining, limit, reset) {
    if (!Number.isFinite(remaining) || !Number.isFinite(limit) || limit <= 0) {
      quotaRemaining = null;
      tokenLeft.textContent = '—';
      tokenLimit.textContent = '—';
      tokenReset.textContent = 'unavailable';
      tokenBar.style.width = '0%';
      tokenChip.classList.remove('warn', 'crit');
      setControlsDisabled(isStreaming || personaLoading);
      return;
    }
    quotaRemaining = Math.max(0, remaining);
    const fraction = Math.max(0, Math.min(1, quotaRemaining / limit));
    tokenLeft.textContent = quotaRemaining.toLocaleString();
    tokenLimit.textContent = limit.toLocaleString();
    tokenBar.style.width = `${(fraction * 100).toFixed(1)}%`;
    tokenReset.textContent = Number.isFinite(reset)
      ? new Date(reset * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : 'later';
    tokenChip.classList.toggle('warn', fraction <= 0.2 && fraction > 0.05);
    tokenChip.classList.toggle('crit', fraction <= 0.05);
    setControlsDisabled(isStreaming || personaLoading);
  }

  function updateQuotaFromHeaders(headers) {
    const remaining = Number(headers.get('X-Tokens-Remaining'));
    const limit = Number(headers.get('X-Tokens-Limit'));
    const reset = Number(headers.get('X-Tokens-Reset'));
    if (Number.isFinite(remaining) && Number.isFinite(limit)) setQuota(remaining, limit, reset);
  }

  async function refreshAuthToken() {
    if (!window.JEFF_REFRESH_URL || !window.JEFF_WP_NONCE) throw new Error('Jeff token refresh configuration is missing.');
    const response = await fetch(window.JEFF_REFRESH_URL, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-WP-Nonce': window.JEFF_WP_NONCE },
    });
    if (!response.ok) throw new Error(`Token refresh failed: HTTP ${response.status}.`);
    const data = await response.json();
    if (!data.token) throw new Error('Token refresh response did not contain a token.');
    authToken = data.token;
    window.JEFF_JWT = data.token;
    localStorage.setItem('jeff_jwt', data.token);
  }

  async function apiFetch(url, options = {}) {
    let refreshed = false;
    while (true) {
      const headers = new Headers(options.headers || {});
      if (authToken) headers.set('Authorization', `Bearer ${authToken}`);
      const response = await fetch(url, { ...options, headers });
      if (response.status === 401 && !refreshed && window.JEFF_REFRESH_URL) {
        refreshed = true;
        await refreshAuthToken();
        continue;
      }
      return response;
    }
  }

  async function fetchQuota() {
    try {
      const url = authToken ? `${API_BASE_URL}/quota` : `${API_BASE_URL}/quota?user_id=${encodeURIComponent(userId)}`;
      const response = await apiFetch(url);
      if (!response.ok) throw new Error(`Quota request failed: HTTP ${response.status}`);
      const quota = await response.json();
      setQuota(Number(quota.remaining), Number(quota.limit), Number(quota.reset));
    } catch (error) {
      console.warn('Unable to load Jeff quota:', error.message);
      setQuota(NaN, NaN, NaN);
    }
  }

  async function fetchHistory(mode) {
    try {
      const response = await apiFetch(`${API_BASE_URL}/history/${encodeURIComponent(modeSessions[mode])}`);
      if (!response.ok) throw new Error(`History request failed: HTTP ${response.status}`);
      const data = await response.json();
      renderHistory(data.messages || [], mode);
    } catch (error) {
      console.warn('Unable to restore Jeff history:', error.message);
      renderHistory([], mode);
    }
  }

  function syncModeButtons() {
    modeButtons.forEach((button) => {
      const active = button.dataset.persona === persona;
      button.classList.toggle('on', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function updateCampaignControls() { uploadButton.hidden = currentMode !== 'campaign_builder'; }

  async function switchConversation(mode) {
    if (mode === currentMode || isStreaming) return;
    modeChatCache[currentMode] = log.innerHTML;
    currentMode = mode;
    sessionId = modeSessions[mode];
    localStorage.setItem('jeff_active_mode', mode);
    updateCampaignControls();
    log.classList.add('fade-out');
    await new Promise((resolve) => setTimeout(resolve, 180));
    if (modeChatCache[mode] !== null) {
      log.innerHTML = modeChatCache[mode];
      scrollToBottom();
    } else {
      await fetchHistory(mode);
    }
    addSystemMessage(mode === 'general' ? '— back to general mode —' : `— ${MODE_LABELS[mode]} engaged —`);
    log.classList.remove('fade-out');
    input.focus();
  }

  async function setPersona(target) {
    if (isStreaming || personaLoading || target === persona) return;
    const previous = persona;
    personaLoading = true;
    setControlsDisabled(true);
    try {
      await Promise.all([ensureFrames(target === 'orb' ? 'investor' : target), ensureScene(target)]);
      animationQueue = [];
      if (previous !== 'orb') animationQueue.push({ set: previous, dir: -1 });
      if (target !== 'orb') animationQueue.push({ set: target, dir: 1 });
      persona = target;
      applyPersonaScene(target);
      syncModeButtons();
      const button = personaButtons[target] || orbButton;
      const strip = document.getElementById('modes');
      if (button && strip) strip.scrollTo({ left: button.offsetLeft - (strip.clientWidth - button.offsetWidth) / 2, behavior: 'smooth' });
      nameElement.textContent = PERSONAS[target].name;
      roleElement.textContent = PERSONAS[target].role;
      await switchConversation(PERSONA_TO_MODE[target]);
      animationStep = animationQueue.shift() || null;
      animationStart = performance.now();
      if (!animationStep) {
        personaLoading = false;
        setControlsDisabled(false);
      }
    } catch (error) {
      console.warn('Unable to switch Jeff persona:', error.message);
      persona = previous;
      applyPersonaScene(previous);
      syncModeButtons();
      personaLoading = false;
      setControlsDisabled(false);
    }
  }

  function campaignJsonFromText(text) {
    const stripped = text.trim();
    const fenced = stripped.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const candidate = fenced ? fenced[1].trim() : stripped;
    const starts = [...candidate].map((char, index) => ({ char, index })).filter(({ char }) => char === '{' || char === '[');
    for (const { char, index } of starts) {
      const end = candidate.lastIndexOf(char === '{' ? '}' : ']');
      if (end <= index) continue;
      try { return JSON.parse(candidate.slice(index, end + 1)); } catch (_) { /* try the next candidate */ }
    }
    return null;
  }

  function structuredPayloadFromText(text, mode) {
    const block = text.match(/```json\s*([\s\S]*?)```/i);
    if (block) {
      try { return JSON.parse(block[1]); } catch (_) { /* fall through */ }
    }
    return campaignJsonFromText(text) || { content: text, mode, exported_at: new Date().toISOString() };
  }

  function attachExportActions(message, text, mode) {
    message.dataset.exportText = text;
    if (message.querySelector('.message-actions')) return;
    const campaign = mode === 'campaign_builder' ? campaignJsonFromText(text) : null;
    message.dataset.campaignJson = campaign ? JSON.stringify(campaign) : '';
    const actions = document.createElement('div');
    actions.className = 'message-actions';
    actions.innerHTML = `<button class="export-btn" type="button" data-export="xlsx">Excel</button><button class="export-btn" type="button" data-export="pdf">PDF</button>${campaign ? '<button class="export-btn" type="button" data-export="campaign">Campaign JSON</button>' : ''}`;
    message.appendChild(actions);
  }

  async function downloadExport(endpoint, extension, text, mode) {
    const response = await apiFetch(`${API_BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: structuredPayloadFromText(text, mode), content: text, filename: `jeff-${mode}-${Date.now()}`, title: `Jeff ${MODE_LABELS[mode]} export` }),
    });
    if (!response.ok) throw new Error(`Export failed: HTTP ${response.status}`);
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = `jeff-${mode}.${extension}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function showBackendError(bubble, message) { bubble.textContent = `Jeff is unavailable right now.\n\n${message}`; }

  async function streamFromBackend(mode, message, bubble, campaignInputsForRequest = null) {
    const body = { message, mode, session_id: modeSessions[mode], ...(authToken ? {} : { user_id: userId }) };
    if (mode === 'campaign_builder' && campaignInputsForRequest && Object.keys(campaignInputsForRequest).length) body.campaign_inputs = campaignInputsForRequest;
    try {
      const response = await apiFetch(`${API_BASE_URL}/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      updateQuotaFromHeaders(response.headers);
      if (!response.ok) throw new Error(`HTTP ${response.status}. ${await response.text()}`);
      const returnedSessionId = response.headers.get('X-Session-Id');
      if (returnedSessionId) {
        modeSessions[mode] = returnedSessionId;
        if (mode === currentMode) sessionId = returnedSessionId;
        localStorage.setItem('jeff_mode_sessions', JSON.stringify(modeSessions));
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullResponse = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fullResponse += decoder.decode(value, { stream: true });
        bubble.textContent = fullResponse;
        scrollToBottom();
      }
      fullResponse += decoder.decode();
      if (fullResponse) {
        bubble.innerHTML = renderMarkdown(fullResponse);
        attachExportActions(bubble.closest('.msg'), fullResponse, mode);
      } else {
        bubble.textContent = 'Jeff returned an empty response.';
      }
    } catch (error) {
      console.warn('Jeff chat request failed:', error.message);
      showBackendError(bubble, error.message);
    } finally {
      await fetchQuota();
    }
  }

  async function streamResponse(mode, message, campaignInputsForRequest = null) {
    isStreaming = true;
    setControlsDisabled(true);
    const assistantMessage = showTypingIndicator();
    const bubble = assistantMessage.querySelector('.body');
    await streamFromBackend(mode, message, bubble, campaignInputsForRequest);
    isStreaming = false;
    setControlsDisabled(personaLoading);
    input.focus();
  }

  function sendMessage() {
    if (isStreaming || personaLoading || quotaRemaining === 0) return;
    const message = input.value.trim();
    if (!message) return;
    addUserMessage(message);
    input.value = '';
    input.style.height = 'auto';
    streamResponse(currentMode, message, currentMode === 'campaign_builder' ? campaignInputs : null);
  }

  function collectCampaignInputs() {
    const fields = {
      business_model: document.getElementById('campaignBusinessModel').value.trim(),
      target_users: document.getElementById('campaignTargetUsers').value.trim(),
      demographics: document.getElementById('campaignDemographics').value.trim(),
      financial_plan: document.getElementById('campaignFinancialPlan').value.trim(),
    };
    return Object.fromEntries(Object.entries(fields).filter(([, value]) => value));
  }

  let mammothPromise;
  function loadMammoth() {
    if (window.mammoth) return Promise.resolve(window.mammoth);
    if (!mammothPromise) {
      mammothPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/mammoth/mammoth.browser.min.js';
        script.onload = () => window.mammoth ? resolve(window.mammoth) : reject(new Error('DOCX reader failed to load.'));
        script.onerror = () => reject(new Error('DOCX reader failed to load.'));
        document.head.appendChild(script);
      });
    }
    return mammothPromise;
  }

  async function readCampaignFile(file) {
    if (!file) return '';
    const name = file.name.toLowerCase();
    if (name.endsWith('.txt') || name.endsWith('.md')) return file.text();
    if (name.endsWith('.docx')) {
      const mammoth = await loadMammoth();
      return (await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value || '';
    }
    throw new Error('Upload .md, .txt, or .docx only.');
  }

  function campaignUploadMessage(inputs, fileName, fileText) {
    const labels = { business_model: 'Business Model', target_users: 'Target Users', demographics: 'Demographics', financial_plan: 'Financial Plan' };
    const lines = ['[CAMPAIGN_INPUTS_UPLOAD]'];
    Object.entries(labels).forEach(([key, label]) => { if (inputs[key]) lines.push(`${label}:\n${inputs[key]}`); });
    if (fileText) lines.push(`Uploaded File: ${fileName}`, fileText);
    return lines.join('\n\n');
  }

  async function closeInterface() {
    if (isStreaming) return;
    for (const mode of MODES) {
      try {
        await apiFetch(`${API_BASE_URL}/clear`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode, ...(authToken ? {} : { user_id: userId }) }),
        });
      } catch (_) { /* close continues if one mode clear fails */ }
    }
    MODES.forEach((mode) => { modeSessions[mode] = crypto.randomUUID(); modeChatCache[mode] = null; });
    sessionId = modeSessions[currentMode];
    localStorage.setItem('jeff_mode_sessions', JSON.stringify(modeSessions));
    log.innerHTML = '';
    closeOverlay.classList.add('visible');
    closeOverlay.setAttribute('aria-hidden', 'false');
  }

  function reopenInterface() {
    closeOverlay.classList.remove('visible');
    closeOverlay.setAttribute('aria-hidden', 'true');
    addJeffMessage(WELCOME_MESSAGES[currentMode], currentMode, false);
    input.focus();
  }

  function renderGraph(which) {
    const host = document.getElementById(which === 'u' ? 'uGraph' : 'vGraph');
    host.innerHTML = '<div class="empty">No readings yet</div>';
  }

  document.getElementById('statsHead').addEventListener('click', () => document.getElementById('stats').classList.toggle('open'));
  [['u', document.getElementById('statU')], ['v', document.getElementById('statV')]].forEach(([which, stat]) => {
    stat.querySelector('.row').addEventListener('click', (event) => {
      event.stopPropagation();
      stat.classList.toggle('open');
      renderGraph(which);
    });
  });
  modeButtons.forEach((button) => button.addEventListener('click', () => setPersona(button.dataset.persona)));
  sendButton.addEventListener('click', sendMessage);
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 110)}px`;
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); }
  });
  document.getElementById('closeBtn').addEventListener('click', closeInterface);
  document.getElementById('reopenBtn').addEventListener('click', reopenInterface);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (closeOverlay.classList.contains('visible')) reopenInterface();
      else closeInterface();
    }
  });
  uploadButton.addEventListener('click', () => { uploadStatus.textContent = ''; uploadModal.hidden = false; });
  document.getElementById('campaignUploadCancel').addEventListener('click', () => { uploadModal.hidden = true; });
  uploadModal.addEventListener('click', (event) => { if (event.target === uploadModal) uploadModal.hidden = true; });
  uploadSubmit.addEventListener('click', async () => {
    if (isStreaming) return;
    uploadSubmit.disabled = true;
    uploadStatus.textContent = '';
    try {
      const inputs = collectCampaignInputs();
      const file = uploadFile.files[0];
      const fileText = await readCampaignFile(file);
      if (!Object.keys(inputs).length && !fileText.trim()) throw new Error('Add at least one input or file.');
      campaignInputs = inputs;
      uploadModal.hidden = true;
      addUserMessage('Uploaded campaign inputs.');
      await streamResponse('campaign_builder', campaignUploadMessage(inputs, file ? file.name : '', fileText.trim()), inputs);
    } catch (error) {
      uploadStatus.textContent = error.message;
    } finally {
      uploadSubmit.disabled = false;
    }
  });
  log.addEventListener('click', async (event) => {
    const button = event.target.closest('.export-btn');
    if (!button) return;
    const message = button.closest('.msg');
    const text = message?.dataset.exportText || message?.querySelector('.body')?.innerText || '';
    const mode = message?.dataset.mode || currentMode;
    button.disabled = true;
    try {
      const kind = button.dataset.export;
      await downloadExport(kind === 'xlsx' ? '/export/xlsx' : kind === 'pdf' ? '/export/pdf' : '/export/campaign', kind === 'campaign' ? 'json' : kind, kind === 'campaign' ? message?.dataset.campaignJson || text : text, mode);
    } catch (error) {
      console.warn(error.message);
    } finally {
      button.disabled = false;
    }
  });

  async function init() {
    applyPersonaScene(persona);
    nameElement.textContent = PERSONAS[persona].name;
    roleElement.textContent = PERSONAS[persona].role;
    syncModeButtons();
    updateCampaignControls();
    renderGraph('u');
    renderGraph('v');
    fetchQuota();
    fetchHistory(currentMode).then(() => input.focus());
    try {
      const assetSet = persona === 'orb' ? 'investor' : persona;
      await Promise.all([ensureFrames(assetSet), ensureScene(persona)]);
      drawAvatar(assetSet, 0);
      animationStart = performance.now();
      requestAnimationFrame(animateAvatar);
    } catch (error) {
      console.error('Unable to load initial avatar assets:', error.message);
    }
  }

  init();
})();
