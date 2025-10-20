(() => {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  const templateId = params.get('templateId');
  if (!token && !templateId) {
    document.body.innerHTML =
      '<p style="text-align:center;font-size:18px;margin-top:60px;">Invalid onboarding link.</p>';
    return;
  }

  const elements = {
    container: document.querySelector('.wizard-container'),
    title: document.getElementById('wizardTitle'),
    subtitle: document.getElementById('wizardSubtitle'),
    logo: document.getElementById('wizardLogo'),
    progress: document.getElementById('wizardProgress'),
    steps: document.getElementById('wizardSteps'),
    status: document.getElementById('wizardStatus'),
    backBtn: document.getElementById('backBtn'),
    nextBtn: document.getElementById('nextBtn'),
    submitBtn: document.getElementById('submitBtn')
  };

  let template = null;
  let wizard = null;
  let currentPageIndex = 0;
  const pageResponses = new Map();
  const saveTimers = new Map();
  let statusTimer = null;
  let isSubmitting = false;
  let isPreviewMode = false;
  let pendingSocialConnect = null;
  let socialPopup = null;
  let socialPopupMonitor = null;
  let socialMessageBound = false;

  init().catch((error) => {
    console.error(error);
    setStatus(error.message || 'Failed to load wizard', true, true);
  });

  async function init() {
    const payload = await loadPayload();
    template = payload.template;
    wizard = payload.wizard;
    isPreviewMode = Boolean(payload.preview || (!token && templateId));

    hydrateResponses(wizard.responses || {});
    applyTheme(template.theme || {});
    renderPage();
    updateProgress();
    wireNavigation();
  }

  function hydrateResponses(existingResponses) {
    (template.pages || []).forEach((page, index) => {
      const stored = existingResponses[page.id] || {};
      pageResponses.set(page.id, {
        blocks: stored.blocks || {},
        meta: {
          completedAt: stored.completedAt || stored.completed_at || null,
          order: index
        }
      });
    });
  }

  async function loadPayload() {
    if (token) {
      const res = await fetch(`/edge/onboard/payload?token=${encodeURIComponent(token)}`);
      if (!res.ok) {
        throw new Error('Wizard unavailable');
      }
      return res.json();
    }
    const res = await fetch(
      `/edge/onboard/preview-template?templateId=${encodeURIComponent(templateId)}`,
      { credentials: 'include' }
    );
    if (!res.ok) {
      if (res.status === 401) {
        throw new Error('Sign in to preview this wizard');
      }
      throw new Error('Preview unavailable');
    }
    return res.json();
  }

  function applyTheme(theme) {
    if (!elements.container) return;
    const primary = theme.primaryColor || '#4f46e5';
    const accent = theme.accentColor || '#6366f1';
    const background = theme.backgroundColor || '#ffffff';
    const textColor = theme.textColor || '#111827';

    document.body.style.background = background;
    elements.container.style.borderColor = accent;
    elements.container.style.boxShadow = '0 30px 80px rgba(79,70,229,0.2)';
    elements.container.style.color = textColor;

    if (elements.title) {
      elements.title.textContent = template.name || 'Onboarding Wizard';
      elements.title.style.color = textColor;
    }
    if (elements.subtitle) {
      elements.subtitle.textContent = template.description || '';
    }
    if (elements.logo) {
      if (theme.logoUrl) {
        elements.logo.src = theme.logoUrl;
        elements.logo.style.display = 'block';
        const fit = (theme.logoFit || 'contain').toLowerCase();
        elements.logo.style.objectFit = fit === 'auto' ? 'initial' : fit;
        elements.logo.style.width = theme.logoWidth ? `${theme.logoWidth}px` : 'auto';
        elements.logo.style.height = theme.logoHeight ? `${theme.logoHeight}px` : 'auto';
      } else {
        elements.logo.style.display = 'none';
      }
    }

    if (elements.submitBtn) {
      elements.submitBtn.style.background = primary;
    }
    if (elements.nextBtn) {
      elements.nextBtn.style.background = accent;
    }
  }

  function wireNavigation() {
    elements.backBtn.addEventListener('click', () => {
      if (currentPageIndex > 0) {
        navigateTo(currentPageIndex - 1);
      }
    });

    elements.nextBtn.addEventListener('click', () => {
      if (currentPageIndex < (template.pages?.length || 0) - 1) {
        navigateTo(currentPageIndex + 1);
      }
    });

    elements.submitBtn.addEventListener('click', submitWizard);
  }

  function navigateTo(index) {
    if (index < 0 || index >= (template.pages?.length || 0)) return;
    currentPageIndex = index;
    renderPage();
    updateProgress();
  }

  function renderPage() {
    const page = template.pages?.[currentPageIndex];
    if (!page) return;
    const pageState = getPageState(page.id);

    const totalPages = template.pages?.length || 0;
    if (elements.subtitle) {
      elements.subtitle.textContent = `${page.description || ''}`;
    }

    elements.backBtn.style.display = currentPageIndex === 0 ? 'none' : 'inline-flex';
    elements.nextBtn.style.display =
      currentPageIndex >= totalPages - 1 ? 'none' : 'inline-flex';
    elements.submitBtn.style.display =
      currentPageIndex === totalPages - 1 ? 'inline-flex' : 'none';
    elements.submitBtn.disabled = isPreviewMode;

    elements.steps.innerHTML = '';

    const pageHeading = document.createElement('div');
    pageHeading.className = 'wizard-page-heading';
    pageHeading.innerHTML = `
      <div class="wizard-page-index">Step ${currentPageIndex + 1} of ${totalPages}</div>
      <h2>${escapeHtml(page.title || `Page ${currentPageIndex + 1}`)}</h2>
      ${page.description ? `<p>${escapeHtml(page.description)}</p>` : ''}
    `;
    elements.steps.appendChild(pageHeading);

    (page.blocks || []).forEach((block) => {
      const blockEl = renderBlock(page, block, pageState.blocks[block.id]);
      elements.steps.appendChild(blockEl);
    });
  }

  function renderBlock(page, block, blockState = {}) {
    const wrapper = document.createElement('div');
    wrapper.className = `wizard-block block-${block.type}`;

    if (block.type === 'text') {
      const variant = (block.textVariant || 'paragraph').toLowerCase();
      const content = String(block.content || '').trim();
      wrapper.classList.add('wizard-block-static', 'wizard-content-block', `wizard-content-${variant}`);
      let html = '';

      const renderList = (ordered = false) => {
        const items = content
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        if (items.length === 0) {
          return `<p class="wizard-text-paragraph">${formatRichText(content)}</p>`;
        }
        const tag = ordered ? 'ol' : 'ul';
        const listClass = ordered ? 'wizard-text-list wizard-text-list--numbered' : 'wizard-text-list';
        return `<${tag} class="${listClass}">${items
          .map((item) => `<li>${escapeHtml(item)}</li>`)
          .join('')}</${tag}>`;
      };

      switch (variant) {
        case 'heading1':
          html = `<h2 class="wizard-text-heading1">${escapeHtml(content) || 'Content block'}</h2>`;
          break;
        case 'heading2':
          html = `<h3 class="wizard-text-heading2">${escapeHtml(content) || 'Content block'}</h3>`;
          break;
        case 'heading3':
          html = `<h4 class="wizard-text-heading3">${escapeHtml(content) || 'Content block'}</h4>`;
          break;
        case 'subtitle':
          html = `<p class="wizard-text-subtitle">${escapeHtml(content) || 'Add supporting copy…'}</p>`;
          break;
        case 'bullets':
          html = renderList(false);
          break;
        case 'numbered':
          html = renderList(true);
          break;
        case 'quote':
          html = `<blockquote class="wizard-text-quote">${escapeHtml(content) || 'Add a quote…'}</blockquote>`;
          break;
        case 'paragraph':
        default:
          html = `<p class="wizard-text-paragraph">${formatRichText(content)}</p>`;
          break;
      }

      wrapper.innerHTML = html;
      return wrapper;
    }

    const labelId = `${page.id}_${block.id}`;
    const label = document.createElement('label');
    label.htmlFor = labelId;
    label.className = 'wizard-block-label';
    label.textContent = block.title || 'Untitled';
    if (block.required) {
      const requiredMark = document.createElement('span');
      requiredMark.className = 'wizard-block-required';
      requiredMark.textContent = '*';
      label.appendChild(requiredMark);
    }

    const helper = document.createElement('div');
    helper.className = 'wizard-block-helper';
    helper.textContent = block.helperText || helperTextByType(block.type);

    wrapper.appendChild(label);
    if (helper.textContent) {
      wrapper.appendChild(helper);
    }

    if (block.type === 'media') {
      const uploadWrapper = document.createElement('div');
      uploadWrapper.className = 'wizard-upload-wrapper';

      const input = document.createElement('input');
      input.type = 'file';
      input.id = labelId;
      input.accept = block.settings?.accept || '*/*';
      if (block.settings?.multiple) {
        input.multiple = true;
      }

      if (isPreviewMode) {
        input.disabled = true;
      } else {
        input.addEventListener('change', (event) => {
          handleUpload(page.id, block, event).catch((error) => {
            console.error(error);
            setStatus('Upload failed', true, true);
          });
        });
      }

      uploadWrapper.appendChild(input);

      const list = document.createElement('div');
      list.className = 'wizard-upload-list';
      (blockState.uploads || []).forEach((file) => {
        const item = document.createElement('a');
        item.href = file.previewUrl;
        item.target = '_blank';
        item.rel = 'noopener noreferrer';
        item.textContent = `${file.name} (${formatFileSize(file.size)})`;
        list.appendChild(item);
      });

      uploadWrapper.appendChild(list);
      wrapper.appendChild(uploadWrapper);
      return wrapper;
    }

    if (block.type === 'voice_agent') {
      const options = Array.isArray(block.settings?.voiceAgents)
        ? block.settings.voiceAgents
        : [];
      if (options.length === 0) {
        const notice = document.createElement('div');
        notice.className = 'wizard-block-helper';
        notice.textContent = 'No Voice AI agents are configured. Contact your administrator.';
        wrapper.appendChild(notice);
        return wrapper;
      }

      const allowMultiple = Boolean(block.settings?.allowMultiple);
      const currentValue = blockState.value;
      const selectedValues = Array.isArray(currentValue)
        ? currentValue
        : currentValue
        ? [currentValue]
        : [];

      if (allowMultiple) {
        const list = document.createElement('div');
        list.className = 'wizard-voice-options';
        options.forEach((agent) => {
          const optionId = agent.id || agent.agentName || agent.name;
          const label = document.createElement('label');
          label.className = 'wizard-voice-option';
          const input = document.createElement('input');
          input.type = 'checkbox';
          input.checked = selectedValues.includes(optionId);
          if (!isPreviewMode) {
            input.addEventListener('change', () => {
              updateBlockResponse(page.id, block.id, (current) => {
                const existing = Array.isArray(current.value) ? [...current.value] : [];
                let next;
                if (input.checked) {
                  next = existing.includes(optionId) ? existing : [...existing, optionId];
                } else {
                  next = existing.filter((id) => id !== optionId);
                }
                return { ...current, value: next };
              });
              queueAutosave(page.id);
              updateProgress();
            });
          } else {
            input.disabled = true;
          }
          const text = document.createElement('span');
          text.textContent = agent.agentName || agent.name || optionId;
          label.appendChild(input);
          label.appendChild(text);
          list.appendChild(label);
        });
        wrapper.appendChild(list);
        return wrapper;
      }

      const select = document.createElement('select');
      select.id = labelId;
      select.className = 'wizard-input';
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = block.helperText ? 'Select an option' : 'Select a Voice AI agent';
      select.appendChild(placeholder);
      options.forEach((agent) => {
        const option = document.createElement('option');
        option.value = agent.id || agent.agentName;
        option.textContent = agent.agentName || agent.name || agent.id;
        select.appendChild(option);
      });
      select.value = selectedValues[0] || '';
      if (!isPreviewMode) {
        const updateValue = () => {
          updateBlockResponse(page.id, block.id, (current) => ({
            ...current,
            value: select.value
          }));
          queueAutosave(page.id);
          updateProgress();
        };
        select.addEventListener('change', updateValue);
        select.addEventListener('input', updateValue);
      }
      wrapper.appendChild(select);
      return wrapper;
    }

    if (block.type === 'social_profile') {
      const platforms = Array.isArray(block.settings?.platforms)
        ? block.settings.platforms
        : ['google'];
      const instructions =
        block.settings?.instructions ||
        'Connect the social accounts that should be managed for this location.';
      const ctaLabel = block.settings?.ctaLabel || 'Connect Google Account';
      const connectedAccounts = Array.isArray(blockState.value)
        ? blockState.value
        : [];

      const info = document.createElement('div');
      info.className = 'wizard-block-helper';
      info.textContent = instructions;
      wrapper.appendChild(info);

      if (platforms.length > 0) {
        const list = document.createElement('ul');
        list.className = 'wizard-social-platforms';
        platforms.forEach((platform) => {
          const item = document.createElement('li');
          item.textContent = platformLabel(platform);
          list.appendChild(item);
        });
        wrapper.appendChild(list);
      }

      const accountsContainer = document.createElement('div');
      accountsContainer.className = 'wizard-social-accounts';

      if (connectedAccounts.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'wizard-block-helper';
        empty.textContent = 'No accounts connected yet.';
        accountsContainer.appendChild(empty);
      } else {
        connectedAccounts.forEach((account) => {
          const row = document.createElement('div');
          row.className = 'wizard-social-account';

          const details = document.createElement('div');
          details.className = 'wizard-social-account-details';

          const name = document.createElement('span');
          name.className = 'wizard-social-account-name';
          name.textContent = account.displayName || account.accountId;
          details.appendChild(name);

          const meta = document.createElement('span');
          const locationsCount = Array.isArray(account.locations)
            ? account.locations.length
            : 0;
          meta.textContent = `${locationsCount} linked locations`;
          details.appendChild(meta);

          row.appendChild(details);

          if (!isPreviewMode) {
            const actions = document.createElement('div');
            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'btn btn-secondary';
            removeBtn.textContent = 'Remove';
            removeBtn.addEventListener('click', () => {
              removeWizardSocialAccount(page.id, block.id, account.accountId);
            });
            actions.appendChild(removeBtn);
            row.appendChild(actions);
          }

          accountsContainer.appendChild(row);
        });
      }

      wrapper.appendChild(accountsContainer);

      const allowGoogle = platforms.includes('google');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-primary';
      button.textContent = allowGoogle ? ctaLabel : 'Connect';
      if (isPreviewMode || !token || !allowGoogle) {
        button.disabled = true;
        button.classList.add('disabled');
        if (!allowGoogle) {
          button.textContent = 'Only Google is supported right now';
        } else if (isPreviewMode) {
          button.textContent = 'Available in live mode';
        }
      } else {
        button.addEventListener('click', () => {
          startSocialConnect('google', page.id, block.id);
        });
      }
      wrapper.appendChild(button);

      return wrapper;
    }

    let input;
    const value = normaliseValue(blockState.value);

    if (block.type === 'custom_value' || block.type === 'trigger_link') {
      input = document.createElement('textarea');
      input.rows = block.type === 'trigger_link' ? 2 : 3;
      input.value = value || '';
    } else if (block.type === 'tag') {
      input = document.createElement('input');
      input.type = 'text';
      input.value = Array.isArray(value) ? value.join(', ') : value || '';
      input.placeholder = 'Separate tags with commas';
    } else {
      input = document.createElement('input');
      input.type = 'text';
      input.value = value || '';
    }

    input.id = labelId;
    input.className = 'wizard-input';

    if (!isPreviewMode) {
      input.addEventListener('input', () => {
        updateBlockResponse(page.id, block.id, (current) => {
          const next = { ...current };
          if (block.type === 'tag') {
            next.value = input.value
              .split(',')
              .map((tag) => tag.trim())
              .filter(Boolean);
          } else {
            next.value = input.value;
          }
          return next;
        });
        queueAutosave(page.id);
        updateProgress();
      });
    }

    wrapper.appendChild(input);
    return wrapper;
  }

  function getPageState(pageId) {
    return (
      pageResponses.get(pageId) || {
        blocks: {},
        meta: {}
      }
    );
  }

  function setPageState(pageId, state) {
    pageResponses.set(pageId, {
      blocks: state.blocks || {},
      meta: state.meta || {}
    });
  }

  function updateBlockResponse(pageId, blockId, updater) {
    if (isPreviewMode) return;
    const pageState = getPageState(pageId);
    const currentBlock = pageState.blocks[blockId] || { value: '', uploads: [], meta: {} };
    const nextBlock = updater({ ...currentBlock }) || currentBlock;
    const nextBlocks = { ...pageState.blocks, [blockId]: nextBlock };
    setPageState(pageId, { blocks: nextBlocks, meta: pageState.meta });
  }

  function queueAutosave(pageId) {
    if (isPreviewMode) return;
    const existing = saveTimers.get(pageId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      autosavePage(pageId).catch((error) => {
        console.error(error);
        setStatus('Autosave failed', true, true);
      });
    }, 1000);
    saveTimers.set(pageId, timer);
  }

  async function autosavePage(pageId) {
    saveTimers.delete(pageId);
    if (isPreviewMode) return;
    const pageState = getPageState(pageId);
    const res = await fetch('/edge/onboard/answer', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        pageId,
        blocks: pageState.blocks,
        completed: isPageCompleted(pageId)
      })
    });
    if (!res.ok) {
      throw new Error('Autosave error');
    }
    const data = await res.json();
    if (data.page) {
      setPageState(pageId, {
        blocks: data.page.blocks || {},
        meta: {
          ...getPageState(pageId).meta,
          completedAt: data.page.completedAt || null
        }
      });
      if (pageId === template.pages?.[currentPageIndex]?.id) {
        renderPage();
      }
      updateProgress();
    }
    setStatus('Saved', false);
  }

  function isPageCompleted(pageId) {
    const page = template.pages?.find((p) => p.id === pageId);
    if (!page) return false;
    const state = getPageState(pageId);
    const requiredBlocks = (page.blocks || []).filter(
      (block) => block.required && block.type !== 'text'
    );
    if (requiredBlocks.length === 0) return false;
    return requiredBlocks.every((block) => isBlockSatisfied(block, state.blocks[block.id]));
  }

  function isBlockSatisfied(block, state = {}) {
    if (!block.required) return true;
    if (block.type === 'media') {
      return Array.isArray(state.uploads) && state.uploads.length > 0;
    }
    if (block.type === 'social_profile') {
      const accounts = Array.isArray(state.value) ? state.value : [];
      return accounts.length > 0;
    }
    const value = state.value;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'string') return value.trim().length > 0;
    return value != null && value !== '';
  }

  function updateProgress() {
    const pages = template.pages || [];
    const dots = pages.map((page, idx) => {
      const state = getPageState(page.id);
      const completed = isBlockSatisfiedPage(page, state);
      const active = idx === currentPageIndex;
      const classes = ['progress-dot'];
      if (completed) classes.push('completed');
      if (active) classes.push('active');
      return `<span class="${classes.join(' ')}"></span>`;
    });
    elements.progress.innerHTML = dots.join('');
  }

  function isBlockSatisfiedPage(page, state) {
    if (state.meta?.completedAt) return true;
    const requiredBlocks = (page.blocks || []).filter(
      (block) => block.required && block.type !== 'text'
    );
    if (requiredBlocks.length === 0) return false;
    return requiredBlocks.every((block) => isBlockSatisfied(block, state.blocks[block.id]));
  }

  async function handleUpload(pageId, block, event) {
    if (isPreviewMode) {
      event.target.value = '';
      return;
    }
    const files = Array.from(event.target.files || []);
    if (!files.length) return;

    for (const file of files) {
      const formData = new FormData();
      formData.append('token', token);
      formData.append('pageId', pageId);
      formData.append('blockId', block.id);
      formData.append('file', file);

      setStatus('Uploading…', false, true);
      const res = await fetch('/edge/onboard/upload', {
        method: 'POST',
        body: formData
      });
      if (!res.ok) {
        throw new Error('Upload failed');
      }
      const data = await res.json();
      if (data.page) {
        setPageState(pageId, {
          blocks: data.page.blocks || {},
          meta: getPageState(pageId).meta
        });
        renderPage();
        updateProgress();
        queueAutosave(pageId);
        setStatus('Uploaded', false);
      }
    }
    event.target.value = '';
  }

  async function submitWizard() {
    if (isSubmitting || isPreviewMode) return;
    const incompletePages = (template.pages || []).filter((page) => {
      const state = getPageState(page.id);
      return !isBlockSatisfiedPage(page, state);
    });
    if (incompletePages.length > 0) {
      setStatus('Please complete all required sections before submitting.', true, true);
      return;
    }

    isSubmitting = true;
    setStatus('Submitting…', false, true);
    elements.submitBtn.disabled = true;
    elements.backBtn.disabled = true;
    elements.nextBtn.disabled = true;

    const res = await fetch('/edge/onboard/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });

    if (!res.ok) {
      elements.submitBtn.disabled = false;
      elements.backBtn.disabled = false;
      elements.nextBtn.disabled = false;
      isSubmitting = false;
      setStatus('Submit failed', true, true);
      return;
    }

    disableAllInputs();
    setStatus('All done! We will sync shortly.', false, true);
  }

  function disableAllInputs() {
    elements.steps.querySelectorAll('input, textarea, button').forEach((el) => {
      el.disabled = true;
    });
  }

  function setStatus(message, error, persist) {
    if (!elements.status) return;
    if (statusTimer) {
      clearTimeout(statusTimer);
      statusTimer = null;
    }
    elements.status.textContent = message;
    elements.status.className = error ? 'wizard-status error' : 'wizard-status';
    if (!error && message && !persist) {
      statusTimer = setTimeout(() => {
        elements.status.textContent = '';
        elements.status.className = 'wizard-status';
        statusTimer = null;
      }, 3000);
    }
  }

  function helperTextByType(type) {
    switch (type) {
      case 'custom_field':
        return 'Provide the value we should use for this custom field.';
      case 'custom_value':
        return 'Set the content that should be stored in this custom value.';
      case 'trigger_link':
        return 'Enter the URL or instructions for this trigger link.';
      case 'tag':
        return 'List the tags separated by commas.';
      case 'media':
        return 'Upload any related files or assets.';
      case 'voice_agent':
        return 'Choose which Voice AI agent should be used.';
      default:
        return '';
    }
  }

  function normaliseValue(value) {
    if (value == null) return '';
    return value;
  }

  function formatRichText(text) {
    return escapeHtml(text).replace(/\n/g, '<br>');
  }

  function platformLabel(platformId) {
    switch ((platformId || '').toLowerCase()) {
      case 'google':
        return 'Google Business Profile';
      case 'instagram':
        return 'Instagram';
      case 'facebook':
        return 'Facebook';
      case 'linkedin':
        return 'LinkedIn';
      case 'tiktok':
        return 'TikTok';
      case 'youtube':
        return 'YouTube';
      default:
        return platformId || 'Social platform';
    }
  }

  async function startSocialConnect(platform, pageId, blockId) {
    if (isPreviewMode) {
      setStatus('Connections are disabled in preview mode.', true, true);
      return;
    }
    if (!token) {
      setStatus('Missing onboarding token. Refresh the page and try again.', true, true);
      return;
    }
    if (platform !== 'google') {
      setStatus('Only Google connections are supported right now.', true, true);
      return;
    }

    pendingSocialConnect = { platform, pageId, blockId };

    if (socialPopup && !socialPopup.closed) {
      socialPopup.close();
    }

    let launchUrl = null;
    try {
      const response = await fetch(`/edge/social/google/start?token=${encodeURIComponent(token)}`);
      const data = await response.json();
      if (!response.ok || !data.success || !data.url) {
        throw new Error(data.error || 'Failed to start Google OAuth');
      }
      launchUrl = data.url;
    } catch (error) {
      console.error('Wizard failed to start Google OAuth:', error);
      pendingSocialConnect = null;
      setStatus(error.message || 'Failed to start Google OAuth.', true, true);
      return;
    }

    const width = 520;
    const height = 720;
    const left = window.screenX + (window.outerWidth - width) / 2;
    const top = window.screenY + (window.outerHeight - height) / 2;

    socialPopup = window.open(
      launchUrl,
      'ghl-social-google',
      `toolbar=no,location=no,status=no,menubar=no,scrollbars=yes,resizable=yes,width=${width},height=${height},top=${top},left=${left}`
    );

    if (!socialPopup) {
      pendingSocialConnect = null;
      setStatus('Please allow pop-ups to continue.', true, true);
      return;
    }

    socialPopup.focus?.();

    if (!socialMessageBound) {
      window.addEventListener('message', handleWizardSocialMessage, false);
      socialMessageBound = true;
    }

    if (socialPopupMonitor) {
      clearInterval(socialPopupMonitor);
    }
    socialPopupMonitor = setInterval(() => {
      if (!socialPopup || socialPopup.closed) {
        cleanupWizardSocialPopup();
      }
    }, 600);

    setStatus('Launching Google connection…', false);
  }

  function handleWizardSocialMessage(event) {
    const data = event.data;
    if (!pendingSocialConnect || !data) return;
    const pageName = data.page || data.pageId;
    if (pageName !== 'social-media-posting' && pageName !== 'social_media_posting') {
      return;
    }
    const platform = (data.platform || '').toLowerCase();
    if (platform !== pendingSocialConnect.platform) {
      return;
    }
    if (!data.accountId) {
      setStatus('Google connection closed without selecting an account.', true, true);
      cleanupWizardSocialPopup(true);
      return;
    }
    registerWizardSocialAccount(data);
  }

  async function registerWizardSocialAccount(payload) {
    if (!pendingSocialConnect) return;
    try {
      const response = await fetch('/edge/social/google/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          accountId: payload.accountId,
          payload
        })
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to connect Google account');
      }
      const profile = data.profile || { accountId: payload.accountId };
      finalizeWizardSocialAccountUpdate(
        pendingSocialConnect.pageId,
        pendingSocialConnect.blockId,
        profile
      );
      setStatus('Google account connected.', false);
    } catch (error) {
      console.error('Wizard Google connection failed:', error);
      setStatus(error.message || 'Failed to connect Google account', true, true);
    } finally {
      cleanupWizardSocialPopup(true);
    }
  }

  function finalizeWizardSocialAccountUpdate(pageId, blockId, profile) {
    const account = {
      platform: 'google',
      accountId: profile.accountId || profile.id,
      displayName: profile.displayName || profile.accountName || profile.accountId,
      locations: Array.isArray(profile.locations) ? profile.locations : []
    };

    updateBlockResponse(pageId, blockId, (current) => {
      const existing = Array.isArray(current.value) ? [...current.value] : [];
      const idx = existing.findIndex((item) => item.accountId === account.accountId);
      if (idx >= 0) {
        existing[idx] = account;
      } else {
        existing.push(account);
      }
      return { ...current, value: existing };
    });
    queueAutosave(pageId);
    renderPage();
    updateProgress();
  }

  async function removeWizardSocialAccount(pageId, blockId, accountId) {
    if (isPreviewMode) return;
    if (!token) return;
    if (!window.confirm('Remove this Google account?')) return;

    try {
      const response = await fetch(
        `/edge/social/google/connections/${encodeURIComponent(accountId)}?token=${encodeURIComponent(token)}`,
        { method: 'DELETE' }
      );
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to remove Google account');
      }
      updateBlockResponse(pageId, blockId, (current) => {
        const existing = Array.isArray(current.value) ? current.value : [];
        return {
          ...current,
          value: existing.filter((item) => item.accountId !== accountId)
        };
      });
      queueAutosave(pageId);
      renderPage();
      updateProgress();
      setStatus('Google account removed.', false);
    } catch (error) {
      console.error('Wizard Google removal failed:', error);
      setStatus(error.message || 'Failed to remove Google account', true, true);
    }
  }

  function cleanupWizardSocialPopup(suppressNotice) {
    if (socialPopup && !socialPopup.closed) {
      socialPopup.close();
    }
    socialPopup = null;
    if (!suppressNotice && pendingSocialConnect) {
      setStatus('Google connection window closed.', true, true);
    }
    pendingSocialConnect = null;
    if (socialPopupMonitor) {
      clearInterval(socialPopupMonitor);
      socialPopupMonitor = null;
    }
    if (socialMessageBound) {
      window.removeEventListener('message', handleWizardSocialMessage, false);
      socialMessageBound = false;
    }
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatFileSize(bytes) {
    if (!bytes && bytes !== 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
})();
