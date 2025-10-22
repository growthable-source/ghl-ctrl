const API_BASE = window.location.origin + '/api';
const SOCIAL_PLATFORMS = [
    {
        id: 'google',
        name: 'Google Business Profile',
        icon: '🔍',
        available: false,
        note: 'Managed via the onboarding wizard. Send clients the published link to connect.'
    },
    { id: 'facebook', name: 'Meta (Facebook)', icon: '📘', available: false, note: 'Coming soon.' },
    { id: 'instagram', name: 'Instagram', icon: '📸', available: false, note: 'Coming soon.' },
    { id: 'linkedin', name: 'LinkedIn', icon: '💼', available: false, note: 'Coming soon.' },
    { id: 'tiktok', name: 'TikTok', icon: '🎵', available: false, note: 'Coming soon.' },
    { id: 'youtube', name: 'YouTube', icon: '▶️', available: false, note: 'Coming soon.' }
];
const OAUTH_STATUS_MESSAGES = {
    success: {
        type: 'success',
        text: 'Marketplace app installed. Your HighLevel account is now connected.'
    },
    exchange_failed: {
        type: 'error',
        text: 'We could not exchange the authorization code. Try again or use a private token.'
    },
    state_mismatch: {
        type: 'error',
        text: 'The connect session expired. Please start the OAuth flow again.'
    },
    missing_code: {
        type: 'error',
        text: 'No authorization code was returned. Please reinstall the marketplace app.'
    },
    config_missing: {
        type: 'error',
        text: 'OAuth isn’t configured for this environment yet. Add HighLevel client credentials.'
    },
    access_denied: {
        type: 'error',
        text: 'Marketplace install was canceled before completion. No changes were made.'
    }
};
const PLAN_DISPLAY_NAMES = {
    free: 'Free Plan',
    starter: 'Starter Plan',
    growth: 'Growth Plan',
    scale: 'Scale Plan',
    enterprise: 'Enterprise Plan'
};
const TAB_LABELS = {
    fields: 'Custom Fields',
    values: 'Custom Values',
    tags: 'Tags',
    triggerLinks: 'Trigger Links',
    media: 'Media Library',
    social: 'Social Profiles',
    settings: 'Location Settings'
};
const INTERCOM_APP_ID = 'q6toobgb';
let intercomBooted = false;
let intercomScriptLoading = false;
let intercomScriptCallbacks = [];
const PROFILE_STORAGE_PREFIX = 'ghlctrl.profile.';
const REFERRAL_REFRESH_INTERVAL = 1000 * 60 * 3;
let currentUser = null;
let currentLocations = [];
let selectedLocation = null;
let currentTab = 'fields';
let allFields = [];
let allValues = [];
let selectedFields = new Set();
let selectedValues = new Set();
let currentFieldsView = 'list';
let currentValuesView = 'list';
let allTriggerLinks = [];
let selectedTriggerLinks = new Set();
let allTags = [];
let selectedTags = new Set();
let filteredTags = [];
let currentSocialProfiles = { google: [] };
let referralState = {
    loading: false,
    loaded: false,
    lastFetched: 0,
    data: null,
    error: null
};
let referralCopyResetTimer = null;

function normalizeIntercomTimestamp(value) {
    if (!value && value !== 0) return null;
    if (typeof value === 'number') {
        return value > 9999999999 ? Math.floor(value / 1000) : Math.floor(value);
    }
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) return null;
    return Math.floor(parsed / 1000);
}

function buildIntercomPayload(user) {
    if (!user || !INTERCOM_APP_ID) return null;
    const payload = {
        app_id: INTERCOM_APP_ID
    };
    if (user.id) payload.user_id = user.id;
    const profile = user.profile || {};
    const name = profile.name || user.displayName || user.email || '';
    if (name) payload.name = name;
    if (user.email) payload.email = user.email;
    const createdAt =
        normalizeIntercomTimestamp(
            user.createdAt ||
            user.created_at ||
            profile.createdAt ||
            profile.created_at
        ) || null;
    if (createdAt) payload.created_at = createdAt;
    return payload;
}

function loadIntercomScript(callback) {
    if (!INTERCOM_APP_ID) return;
    if (window.Intercom && typeof window.Intercom === 'function') {
        callback?.();
        return;
    }
    if (callback) {
        intercomScriptCallbacks.push(callback);
    }
    if (intercomScriptLoading) {
        return;
    }
    intercomScriptLoading = true;
    const script = document.createElement('script');
    script.src = `https://widget.intercom.io/widget/${INTERCOM_APP_ID}`;
    script.async = true;
    script.onload = () => {
        intercomScriptLoading = false;
        const queued = intercomScriptCallbacks.slice();
        intercomScriptCallbacks = [];
        queued.forEach((cb) => {
            try {
                cb();
            } catch (error) {
                console.error('Intercom callback failed', error);
            }
        });
    };
    script.onerror = () => {
        intercomScriptLoading = false;
        intercomScriptCallbacks = [];
    };
    document.head.appendChild(script);
}

function syncIntercom(user) {
    if (!INTERCOM_APP_ID || !user) return;
    const payload = buildIntercomPayload(user);
    if (!payload) return;

    const bootIntercom = () => {
        if (!window.Intercom || typeof window.Intercom !== 'function') return;
        if (intercomBooted) {
            window.Intercom('update', payload);
        } else {
            window.Intercom('boot', payload);
            intercomBooted = true;
        }
    };

    if (!window.Intercom || typeof window.Intercom !== 'function') {
        window.intercomSettings = payload;
        loadIntercomScript(bootIntercom);
    } else {
        bootIntercom();
    }
}

function escapeHtml(text) {
    if (text === undefined || text === null) return '';
    return String(text).replace(/[&<>"']/g, (char) => {
        switch (char) {
            case '&':
                return '&amp;';
            case '<':
                return '&lt;';
            case '>':
                return '&gt;';
            case '"':
                return '&quot;';
            case '\'':
                return '&#39;';
            default:
                return char;
        }
    });
}

function getInitials(value) {
    if (!value) return 'U';
    const parts = value
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    if (parts.length === 0) return 'U';
    if (parts.length === 1) {
        return parts[0].slice(0, 2).toUpperCase();
    }
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function getProfileStorageKey(user) {
    const identifier = user?.id || user?._id || user?.email || 'default';
    return `${PROFILE_STORAGE_PREFIX}${identifier}`;
}

function loadProfileFromStorage(user) {
    try {
        const raw = localStorage.getItem(getProfileStorageKey(user));
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (error) {
        console.warn('Unable to load saved profile', error);
        return null;
    }
}

function saveProfileToStorage(user, profile) {
    try {
        localStorage.setItem(getProfileStorageKey(user), JSON.stringify(profile));
    } catch (error) {
        console.warn('Unable to persist profile', error);
    }
}

function hydrateCurrentUserProfile() {
    if (!currentUser) return;
    const storedProfile = loadProfileFromStorage(currentUser);
    currentUser.profile = { ...(currentUser.profile || {}) };
    if (storedProfile) {
        currentUser.profile = { ...currentUser.profile, ...storedProfile };
    }
    if (currentUser.profile.name) {
        currentUser.displayName = currentUser.profile.name;
    }
    if (currentUser.profile.avatar) {
        currentUser.photo = currentUser.profile.avatar;
    }
}


document.addEventListener('DOMContentLoaded', function() {
    checkAuthentication();
    setupFilterListeners();
    updateBreadcrumb();
});

async function checkAuthentication() {
    try {
        const response = await fetch(`${API_BASE}/user`);
        const data = await response.json();
        
        if (!data.success || !data.user) {
            window.location.href = '/login.html';
            return;
        }
        
        currentUser = data.user;
        hydrateCurrentUserProfile();
        displayUserInfo();
        setupProfileModal();
        syncIntercom(currentUser);
        loadLocations();
        setupFormHandlers();
        setupInputListeners();
    } catch (error) {
        console.error('Auth check failed:', error);
        window.location.href = '/login.html';
    }

    // Process query string signals (Stripe, OAuth, connect shortcuts)
    const urlParams = new URLSearchParams(window.location.search);
    let shouldUpdateUrl = false;

    if (urlParams.get('success') === 'true') {
        showMessage('Payment successful! Your plan has been upgraded.', 'success');
        loadSubscription();
        urlParams.delete('success');
        shouldUpdateUrl = true;
    } else if (urlParams.get('canceled') === 'true') {
        showMessage('Payment canceled', 'error');
        urlParams.delete('canceled');
        shouldUpdateUrl = true;
    }

    const oauthStatus = urlParams.get('oauth');
    if (oauthStatus) {
        const statusKey = Object.prototype.hasOwnProperty.call(OAUTH_STATUS_MESSAGES, oauthStatus)
            ? oauthStatus
            : 'access_denied';
        const payload = OAUTH_STATUS_MESSAGES[statusKey] || OAUTH_STATUS_MESSAGES.access_denied;
        showMessage(payload.text, payload.type);
        urlParams.delete('oauth');
        shouldUpdateUrl = true;
    }

    const connectIntent = urlParams.get('connect');
    if (connectIntent === 'private') {
        showAddLocationModal();
        urlParams.delete('connect');
        shouldUpdateUrl = true;
    } else if (connectIntent) {
        urlParams.delete('connect');
        shouldUpdateUrl = true;
    }

    if (shouldUpdateUrl) {
        const cleanedQuery = urlParams.toString();
        const newUrl = cleanedQuery
            ? `${window.location.pathname}?${cleanedQuery}`
            : window.location.pathname;
        window.history.replaceState({}, document.title, newUrl);
    }
}

function displayUserInfo() {
    const userInfoEl = document.getElementById('userInfo');
    if (!userInfoEl || !currentUser) return;

    const profile = currentUser.profile || {};
    const rawName = (profile.name || currentUser.displayName || currentUser.email || 'User').trim();
    const displayName = escapeHtml(rawName);
    const title = profile.title ? escapeHtml(profile.title) : '';
    const avatarSource = profile.avatar || currentUser.photo || '';
    const initials = escapeHtml(getInitials(rawName || currentUser.email || 'User'));
    const altText = escapeHtml((rawName || 'User') + '\'s avatar');
    
    const avatarMarkup = avatarSource
        ? `<img src="${escapeHtml(avatarSource)}" alt="${altText}" id="userAvatarImage">`
        : `<span class="user-avatar-initials">${initials}</span>`;

    userInfoEl.innerHTML = `
        <button type="button" class="user-profile" id="userProfileTrigger" aria-haspopup="dialog" aria-controls="profileModal">
            <div class="user-avatar">${avatarMarkup}</div>
            <div class="user-details">
                <span class="user-name">${displayName}</span>
                ${title ? `<span class="user-title">${title}</span>` : ''}
            </div>
        </button>
        <a href="/auth/logout" class="logout-btn">Logout</a>
    `;

    const trigger = document.getElementById('userProfileTrigger');
    if (trigger) {
        trigger.addEventListener('click', () => openProfileModal());
    }

    const avatarImg = document.getElementById('userAvatarImage');
    if (avatarImg) {
        avatarImg.addEventListener('error', () => {
            const avatarContainer = userInfoEl.querySelector('.user-avatar');
            if (!avatarContainer) return;
            avatarContainer.innerHTML = `<span class="user-avatar-initials">${initials}</span>`;
        }, { once: true });
    }
}

function openProfileModal() {
    populateProfileForm();
    const modal = document.getElementById('profileModal');
    if (!modal) return;
    modal.classList.add('show');
    const nameInput = document.getElementById('profileName');
    if (nameInput) {
        setTimeout(() => nameInput.focus(), 60);
    }

    if (referralState.loaded && referralState.data) {
        updateReferralUI(referralState.data);
    } else {
        setReferralLoadingState('loading');
    }
    loadReferralCard();
}

function setupProfileModal() {
    const form = document.getElementById('profileForm');
    const modal = document.getElementById('profileModal');
    if (!form || !modal) return;

    if (!form.dataset.bound) {
        form.addEventListener('submit', handleProfileFormSubmit);
        form.dataset.bound = 'true';
    }

    const avatarInput = document.getElementById('profileAvatarInput');
    if (avatarInput && !avatarInput.dataset.bound) {
        avatarInput.addEventListener('change', handleProfileAvatarChange);
        avatarInput.dataset.bound = 'true';
    }

    const removeBtn = document.getElementById('profileAvatarRemoveBtn');
    if (removeBtn && !removeBtn.dataset.bound) {
        removeBtn.addEventListener('click', handleProfileAvatarRemove);
        removeBtn.dataset.bound = 'true';
    }

    const copyBtn = document.getElementById('referralCopyBtn');
    if (copyBtn && !copyBtn.dataset.bound) {
        copyBtn.addEventListener('click', handleReferralCopyClick);
        copyBtn.dataset.bound = 'true';
    }

    if (!modal.dataset.bound) {
        modal.addEventListener('click', (event) => {
            if (event.target === modal) {
                closeModal('profileModal');
            }
        });
        modal.dataset.bound = 'true';
    }

    populateProfileForm();
}

function populateProfileForm() {
    const form = document.getElementById('profileForm');
    if (!form || !currentUser) return;

    const profile = currentUser.profile || {};
    const nameInput = document.getElementById('profileName');
    const titleInput = document.getElementById('profileTitle');
    const bioInput = document.getElementById('profileBio');

    const nameValue = profile.name || currentUser.displayName || '';
    if (nameInput) nameInput.value = nameValue || '';
    if (titleInput) titleInput.value = profile.title || '';
    if (bioInput) bioInput.value = profile.bio || '';

    const avatarData = profile.avatar || currentUser.photo || '';
    form.dataset.avatarDataUrl = avatarData || '';
    form.dataset.avatarRemoved = 'false';

    updateProfileAvatarPreview(avatarData, nameValue || currentUser.email || 'User');

    const avatarInput = document.getElementById('profileAvatarInput');
    if (avatarInput) {
        avatarInput.value = '';
    }
}

function updateProfileAvatarPreview(avatarSrc, name) {
    const preview = document.getElementById('profileAvatarPreview');
    if (!preview) return;

    const displayName = name || currentUser?.displayName || currentUser?.email || 'User';

    if (avatarSrc) {
        const safeSrc = escapeHtml(avatarSrc);
        const alt = escapeHtml(`${displayName}'s avatar`);
        preview.innerHTML = `<img src="${safeSrc}" alt="${alt}">`;
    } else {
        preview.innerHTML = `<span>${escapeHtml(getInitials(displayName))}</span>`;
    }

    const removeBtn = document.getElementById('profileAvatarRemoveBtn');
    if (removeBtn) {
        removeBtn.disabled = !avatarSrc;
    }
}

function handleProfileAvatarChange(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
        showMessage('Please select an image file.', 'error');
        event.target.value = '';
        return;
    }

    const maxSize = 2 * 1024 * 1024;
    if (file.size > maxSize) {
        showMessage('Image size must be under 2 MB.', 'error');
        event.target.value = '';
        return;
    }

    const reader = new FileReader();
    reader.onload = (loadEvent) => {
        const dataUrl = loadEvent.target?.result;
        if (!dataUrl) return;
        const form = document.getElementById('profileForm');
        if (form) {
            form.dataset.avatarDataUrl = dataUrl;
            form.dataset.avatarRemoved = 'false';
        }
        const nameInput = document.getElementById('profileName');
        const fallbackName = nameInput?.value || currentUser?.profile?.name || currentUser?.displayName || currentUser?.email || 'User';
        updateProfileAvatarPreview(dataUrl, fallbackName);
    };
    reader.readAsDataURL(file);
}

function handleProfileAvatarRemove(event) {
    event.preventDefault();
    const form = document.getElementById('profileForm');
    if (!form) return;
    form.dataset.avatarDataUrl = '';
    form.dataset.avatarRemoved = 'true';

    const avatarInput = document.getElementById('profileAvatarInput');
    if (avatarInput) {
        avatarInput.value = '';
    }

    const nameInput = document.getElementById('profileName');
    const fallbackName = nameInput?.value || currentUser?.profile?.name || currentUser?.displayName || currentUser?.email || 'User';
    updateProfileAvatarPreview('', fallbackName);
}

function handleProfileFormSubmit(event) {
    event.preventDefault();
    if (!currentUser) return;

    const form = event.target;
    const formData = new FormData(form);

    const name = (formData.get('profileName') || '').toString().trim();
    const title = (formData.get('profileTitle') || '').toString().trim();
    const bio = (formData.get('profileBio') || '').toString().trim();

    const avatarRemoved = form.dataset.avatarRemoved === 'true';
    let avatarData = form.dataset.avatarDataUrl || '';
    if (avatarRemoved) {
        avatarData = '';
    } else if (!avatarData) {
        avatarData = currentUser.profile?.avatar || currentUser.photo || '';
    }

    const updatedProfile = { ...(currentUser.profile || {}) };
    updatedProfile.name = name;
    updatedProfile.title = title;
    updatedProfile.bio = bio;
    updatedProfile.avatar = avatarData;

    currentUser.profile = updatedProfile;

    if (name) {
        currentUser.displayName = name;
    }

    currentUser.photo = avatarData;

    saveProfileToStorage(currentUser, updatedProfile);
    displayUserInfo();
    populateProfileForm();
    closeModal('profileModal');
    showMessage('Profile updated', 'success');
    syncIntercom(currentUser);
}

function setReferralLoadingState(state, options = {}) {
    const card = document.getElementById('profileReferralCard');
    if (!card) return;

    card.dataset.state = state;

    const linkValue = document.getElementById('referralLinkValue');
    const copyBtn = document.getElementById('referralCopyBtn');
    const statusBadge = document.getElementById('referralStatusBadge');
    const nextStep = document.getElementById('referralNextStep');
    const shareHint = document.getElementById('referralShareHint');
    const levelBadge = document.getElementById('referralLevelBadge');

    if (referralCopyResetTimer) {
        clearTimeout(referralCopyResetTimer);
        referralCopyResetTimer = null;
    }

    if (copyBtn) {
        copyBtn.disabled = state !== 'ready';
        copyBtn.classList.remove('copied');
        copyBtn.textContent = 'Copy link';
    }

    if (state === 'loading') {
        if (linkValue) {
            linkValue.textContent = options.message || 'Generating your referral link…';
            linkValue.dataset.placeholder = 'true';
        }
        if (statusBadge) statusBadge.textContent = 'Loading…';
        if (nextStep) nextStep.textContent = '';
        if (shareHint) shareHint.textContent = 'We are warming up your rewards dashboard.';
        if (levelBadge) {
            levelBadge.hidden = true;
        }
    } else if (state === 'error') {
        if (linkValue) {
            linkValue.textContent = options.message || 'Referral program is unavailable right now.';
            linkValue.dataset.placeholder = 'true';
        }
        if (statusBadge) statusBadge.textContent = 'Unavailable';
        if (nextStep) nextStep.textContent = options.detail || 'Please try again later or contact support.';
        if (shareHint) shareHint.textContent = 'Our team has been notified. No action needed from you.';
        if (levelBadge) {
            levelBadge.hidden = true;
        }
    } else if (state === 'ready') {
        if (linkValue) {
            linkValue.removeAttribute('data-placeholder');
        }
    }
}

async function loadReferralCard(force = false) {
    const now = Date.now();
    if (!force && referralState.loaded && now - referralState.lastFetched < REFERRAL_REFRESH_INTERVAL) {
        if (referralState.data) {
            updateReferralUI(referralState.data);
        }
        return;
    }

    if (referralState.loading) return;

    if (!referralState.loaded || !referralState.data || force) {
        setReferralLoadingState('loading');
    }
    referralState.loading = true;
    referralState.error = null;

    try {
        const response = await fetch(`${API_BASE}/referrals`);
        if (!response.ok) {
            throw new Error(`Request failed with status ${response.status}`);
        }
        const payload = await response.json();
        if (!payload.success || !payload.referral) {
            throw new Error(payload.error || 'Unable to load referral details');
        }

        referralState = {
            loading: false,
            loaded: true,
            lastFetched: Date.now(),
            data: payload.referral,
            error: null
        };

        updateReferralUI(payload.referral);

        if (payload.referral.planUpdated) {
            loadSubscription();
        }
    } catch (error) {
        console.error('Referral dashboard failed to load:', error);
        referralState.loading = false;
        referralState.error = error.message;
        if (referralState.loaded && referralState.data) {
            showMessage('Unable to refresh referral rewards. Showing your last saved stats.', 'error');
            updateReferralUI(referralState.data);
        } else {
            setReferralLoadingState('error', {
                message: 'Unable to load your referral rewards.',
                detail: error.message
            });
        }
    } finally {
        referralState.loading = false;
    }
}

function updateReferralUI(referral) {
    if (!referral) return;

    setReferralLoadingState('ready');

    const statusBadge = document.getElementById('referralStatusBadge');
    const linkValue = document.getElementById('referralLinkValue');
    const copyBtn = document.getElementById('referralCopyBtn');
    const paidCount = document.getElementById('referralPaidCount');
    const pendingCount = document.getElementById('referralPendingCount');
    const totalCount = document.getElementById('referralTotalCount');
    const nextStep = document.getElementById('referralNextStep');
    const shareHint = document.getElementById('referralShareHint');
    const levelBadge = document.getElementById('referralLevelBadge');
    const isDisabled = Boolean(referral.disabled);

    if (linkValue) {
        if (isDisabled) {
            linkValue.textContent = 'Referral rewards are launching soon. Your link will appear here.';
            linkValue.dataset.placeholder = 'true';
        } else {
            linkValue.textContent = referral.link;
            linkValue.removeAttribute('data-placeholder');
        }
    }

    if (copyBtn) {
        copyBtn.classList.remove('copied');
        if (isDisabled) {
            copyBtn.disabled = true;
            copyBtn.textContent = 'Coming soon';
            delete copyBtn.dataset.clipboard;
        } else {
            copyBtn.disabled = false;
            copyBtn.dataset.clipboard = referral.link;
            copyBtn.textContent = 'Copy link';
        }
    }

    if (paidCount) paidCount.textContent = referral.paidReferrals ?? 0;
    if (pendingCount) pendingCount.textContent = referral.pendingReferrals ?? 0;
    if (totalCount) totalCount.textContent = referral.totalReferrals ?? 0;

    if (statusBadge) {
        if (isDisabled) {
            statusBadge.textContent = 'Launching soon';
        } else if (referral.unlockedPlan) {
            statusBadge.textContent = `Unlocked · ${formatPlanName(referral.unlockedPlan)}`;
        } else if (referral.paidReferrals > 0) {
            statusBadge.textContent = `${referral.paidReferrals} referral${referral.paidReferrals === 1 ? '' : 's'} completed`;
        } else {
            statusBadge.textContent = 'Your journey starts here';
        }
    }

    if (nextStep) {
        if (isDisabled) {
            nextStep.textContent = 'Hang tight! We will notify you as soon as referral rewards go live.';
        } else if (referral.remainingToNext > 0 && referral.nextMilestone) {
            const planLabel = formatPlanName(referral.nextMilestone.plan);
            nextStep.innerHTML = `Only <strong>${referral.remainingToNext}</strong> more referral${referral.remainingToNext === 1 ? '' : 's'} to unlock <strong>${planLabel}</strong>.`;
        } else if (referral.unlockedPlan) {
            const planLabel = formatPlanName(referral.unlockedPlan);
            nextStep.innerHTML = `You’re enjoying <strong>${planLabel}</strong> at no cost — thank you for sharing the love!`;
        } else {
            nextStep.innerHTML = `Send your link to unlock <strong>${formatPlanName('starter')}</strong> for free.`;
        }
    }

    if (shareHint) {
        shareHint.textContent = referral.shareMessage || 'Each paid referral unlocks the next tier automatically.';
    }

    renderReferralMilestones(referral.milestones, referral.paidReferrals);

    if (levelBadge) {
        levelBadge.hidden = false;
        levelBadge.classList.remove('locked');
        if (isDisabled) {
            levelBadge.textContent = '🚧 Prelaunch';
            levelBadge.classList.add('locked');
        } else if (referral.currentLevel) {
            const levelIndex = referral.currentLevel.levelIndex || referral.milestones.find((m) => m.levelKey === referral.currentLevel.levelKey)?.levelIndex || 1;
            levelBadge.textContent = `${referral.currentLevel.icon || '⭐️'} Level ${levelIndex}: ${referral.currentLevel.levelName}`;
        } else if (referral.nextLevel) {
            const levelIndex = referral.nextLevel.levelIndex || referral.milestones.find((m) => m.levelKey === referral.nextLevel.levelKey)?.levelIndex || 1;
            levelBadge.textContent = `${referral.nextLevel.icon || '⭐️'} Level ${levelIndex}: ${referral.nextLevel.levelName}`;
            levelBadge.classList.add('locked');
        } else {
            levelBadge.textContent = '✨ Keep going!';
        }
    }
}

function renderReferralMilestones(milestones, paidReferrals = 0) {
    const container = document.getElementById('referralMilestones');
    if (!container) return;

    container.innerHTML = '';

    if (!Array.isArray(milestones) || milestones.length === 0) {
        const placeholder = document.createElement('li');
        placeholder.className = 'referral-milestones-empty';
        placeholder.textContent = 'No rewards configured yet. Check back soon!';
        container.appendChild(placeholder);
        return;
    }

    milestones.forEach((milestone) => {
        const item = document.createElement('li');
        const unlocked = Boolean(milestone.unlocked);
        item.className = `milestone ${unlocked ? 'unlocked' : 'upcoming'}`;

        const label = document.createElement('div');
        label.className = 'milestone-label';
        const levelIndex = milestone.levelIndex || milestones.indexOf(milestone) + 1;
        const icon = milestone.icon || '⭐️';
        const referralCopy = milestone.count === 1 ? 'Referral' : 'Referrals';
        label.innerHTML = `
            <span class="milestone-icon">${icon}</span>
            <div class="milestone-text">
                <strong>Level ${levelIndex}: ${milestone.levelName || ''}</strong>
                <span>${milestone.count} ${referralCopy}</span>
            </div>
        `;

        const plan = document.createElement('div');
        plan.className = 'milestone-plan';
        plan.textContent = `Unlocks ${formatPlanName(milestone.plan)}`;

        const progress = document.createElement('div');
        progress.className = 'milestone-progress';
        if (unlocked) {
            progress.textContent = 'Unlocked';
        } else {
            const remaining = Math.max(0, milestone.remaining ?? (milestone.count - paidReferrals));
            progress.textContent = `${remaining} to go`;
        }

        item.appendChild(label);
        item.appendChild(plan);
        item.appendChild(progress);

        container.appendChild(item);
    });
}

function formatPlanName(plan) {
    if (!plan) return 'Free Plan';
    const normalized = String(plan).toLowerCase();
    return PLAN_DISPLAY_NAMES[normalized] || plan;
}

function handleReferralCopyClick(event) {
    const button = event.currentTarget;
    const link = button?.dataset?.clipboard;
    if (!link) return;

    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
        const manualCopy = window.prompt('Copy your referral link and share it anywhere:', link);
        if (manualCopy !== null) {
            showMessage('Referral link ready to share!', 'success');
        }
        return;
    }

    navigator.clipboard.writeText(link).then(() => {
        button.classList.add('copied');
        button.textContent = 'Copied!';
        referralCopyResetTimer = setTimeout(() => {
            button.classList.remove('copied');
            button.textContent = 'Copy link';
        }, 2500);
    }).catch((error) => {
        console.error('Failed to copy referral link:', error);
        showMessage('Unable to copy the referral link. Please copy it manually.', 'error');
    });
}

async function loadLocations() {
    try {
        const response = await fetch(`${API_BASE}/locations`);
        const data = await response.json();
        
        if (data.success) {
            currentLocations = (data.locations || []).map((loc) => ({
                ...loc,
                socialProfiles: loc.credentials?.socialProfiles || {}
            }));
            updateLocationDropdown();
            
            if (currentLocations.length > 0 && !selectedLocation) {
                selectLocation(currentLocations[0].id);
            }
        }
    } catch (error) {
        console.error('Failed to load locations:', error);
    }
}

function updateLocationDropdown() {
    const dropdown = document.getElementById('locationDropdown');
    dropdown.innerHTML = '<option value="">Select a location...</option>';
    
    currentLocations.forEach(location => {
        const option = document.createElement('option');
        option.value = location.id;
        option.textContent = location.ghlName || location.name;
        if (selectedLocation && selectedLocation.id === location.id) {
            option.selected = true;
        }
        dropdown.appendChild(option);
    });
    
    dropdown.addEventListener('change', (e) => {
        if (e.target.value) {
            selectLocation(e.target.value);
        } else {
            selectedLocation = null;
            showNoLocation();
        }
    });
}

function selectLocation(locationId) {
    selectedLocation = currentLocations.find(loc => loc.id === locationId);
    if (selectedLocation) {
        selectedLocation.socialProfiles = selectedLocation.credentials?.socialProfiles || {};
        currentSocialProfiles = selectedLocation.socialProfiles || { google: [] };
        document.getElementById('no-location').style.display = 'none';
        document.getElementById('location-content').style.display = 'block';
        
        const statusEl = document.getElementById('connectionStatus');
        statusEl.className = 'location-status status-active';
        const connectionLabel = selectedLocation.credentials?.type === 'oauth'
            ? 'HighLevel Marketplace'
            : 'Private Token';
        statusEl.textContent = `● Connected (${connectionLabel})`;
        
        if (currentTab === 'fields') {
            loadCustomFields();
        } else if (currentTab === 'values') {
            loadCustomValues();
        } else if (currentTab === 'tags') {
            loadTags();
        } else if (currentTab === 'triggerLinks') {
            loadTriggerLinks();
        } else if (currentTab === 'media') {
            loadMedia();
        } else if (currentTab === 'social') {
            loadSocialProfiles();
        } else {
            loadLocationSettings();
        }
        updateBreadcrumb();
    }
}

function showNoLocation() {
    document.getElementById('no-location').style.display = 'block';
    document.getElementById('location-content').style.display = 'none';
    document.getElementById('connectionStatus').textContent = '';
    updateBreadcrumb();
}

function updateBreadcrumb() {
    const breadcrumbEl = document.getElementById('breadcrumb');
    if (!breadcrumbEl) return;

    const crumbs = [
        { label: 'Home', href: '/' }
    ];

    if (selectedLocation) {
        const locationLabel = selectedLocation.ghlName || selectedLocation.name || 'Location';
        crumbs.push({ label: locationLabel });
        const tabLabel = TAB_LABELS[currentTab] || 'Overview';
        crumbs.push({ label: tabLabel });
    } else {
        crumbs.push({ label: 'Dashboard' });
    }

    const markup = [
        '<ol>',
        ...crumbs.map((crumb, index) => {
            const isLast = index === crumbs.length - 1;
            const safeLabel = escapeHtml(crumb.label);
            if (isLast) {
                return `<li class="current" aria-current="page">${safeLabel}</li>`;
            }
            if (crumb.href) {
                return `<li><a href="${crumb.href}">${safeLabel}</a></li>`;
            }
            return `<li>${safeLabel}</li>`;
        }),
        '</ol>'
    ].join('');

    breadcrumbEl.innerHTML = markup;
}

function switchTab(evtOrTab, maybeTab) {
    let tab = maybeTab;
    let evt = evtOrTab;
    if (typeof evtOrTab === 'string' && !maybeTab) {
        tab = evtOrTab;
        evt = null;
    }

    currentTab = tab;
    // Update body background based on tab
    document.body.className = `tab-${tab}`;
    
    document.querySelectorAll('.tab').forEach(btn => {
        btn.classList.remove('active');
    });

    if (evt?.currentTarget) {
        evt.currentTarget.classList.add('active');
    } else {
        const fallbackBtn = document.querySelector(`.tab[data-tab="${tab}"]`);
        if (fallbackBtn) {
            fallbackBtn.classList.add('active');
        }
    }
    
    document.querySelectorAll('.content-section').forEach(section => {
        section.classList.remove('active');
    });
    const activeSection = document.getElementById(`${tab}-section`);
    if (activeSection) {
        activeSection.classList.add('active');
    }
    
    if (!selectedLocation) {
        updateBreadcrumb();
        return;
    }
    
    if (tab === 'fields') {
        loadCustomFields();
    } else if (tab === 'values') {
        loadCustomValues();
    } else if (tab === 'tags') {
        loadTags();
    } else if (tab === 'triggerLinks') {
        loadTriggerLinks();
    } else if (tab === 'media') {
        loadMedia();
    } else if (tab === 'social') {
        loadSocialProfiles();
    } else {
        loadLocationSettings();
    }
    updateBreadcrumb();
}

async function loadCustomFields() {
    if (!selectedLocation) return;
    
    const listEl = document.getElementById('fieldsList');
    listEl.innerHTML = '<div class="loading">Loading custom fields...</div>';
    
    try {
        const response = await fetch(`${API_BASE}/locations/${selectedLocation.id}/custom-fields`);
        const data = await response.json();
        
        if (data.success) {
            const fields = data.customFields || data.fields || [];
            
            if (fields && fields.length > 0) {
                allFields = fields;
                document.getElementById('fieldsToolbar').style.display = 'flex';
                document.getElementById('fieldsResultsInfo').style.display = 'flex';
                renderFieldsSimple();
            } else {
                document.getElementById('fieldsToolbar').style.display = 'none';
                document.getElementById('fieldsResultsInfo').style.display = 'none';
                const clearBtn = document.getElementById('fieldsClearFilters');
                if (clearBtn) clearBtn.style.display = 'none';
                allFields = [];
                listEl.innerHTML = '<div class="empty-state">No custom fields found</div>';
            }
        } else {
            throw new Error(data.error || 'Failed to load fields');
        }
    } catch (error) {
        document.getElementById('fieldsToolbar').style.display = 'none';
        document.getElementById('fieldsResultsInfo').style.display = 'none';
        const clearBtn = document.getElementById('fieldsClearFilters');
        if (clearBtn) clearBtn.style.display = 'none';
        listEl.innerHTML = `<div class="error-message">Failed to load custom fields: ${error.message}</div>`;
    }
}

function renderFieldsSimple() {
    const listEl = document.getElementById('fieldsList');
    const searchTerm = document.getElementById('fieldsSearch')?.value?.toLowerCase() || '';
    const typeFilter = document.getElementById('fieldsTypeFilter')?.value || '';
    const modelFilter = document.getElementById('fieldsModelFilter')?.value || '';
    const sortOption = document.getElementById('fieldsSortFilter')?.value || 'name-asc';
    
    let filteredFields = allFields.filter(field => {
        if (!field) return false;
        const matchesSearch = !searchTerm || 
            (field.name && field.name.toLowerCase().includes(searchTerm)) ||
            (field.placeholder && field.placeholder.toLowerCase().includes(searchTerm));
        const matchesType = !typeFilter || field.dataType === typeFilter;
        const matchesModel = !modelFilter || field.model === modelFilter;
        return matchesSearch && matchesType && matchesModel;
    });

    filteredFields.sort((a, b) => {
        const nameA = (a?.name || '').toLowerCase();
        const nameB = (b?.name || '').toLowerCase();
        const typeA = (a?.dataType || '').toLowerCase();
        const typeB = (b?.dataType || '').toLowerCase();
        const modelA = (a?.model || '').toLowerCase();
        const modelB = (b?.model || '').toLowerCase();
        switch (sortOption) {
            case 'name-desc':
                return nameB.localeCompare(nameA);
            case 'type-asc':
                return typeA.localeCompare(typeB) || nameA.localeCompare(nameB);
            case 'type-desc':
                return typeB.localeCompare(typeA) || nameA.localeCompare(nameB);
            case 'model-asc':
                return modelA.localeCompare(modelB) || nameA.localeCompare(nameB);
            case 'model-desc':
                return modelB.localeCompare(modelA) || nameA.localeCompare(nameB);
            case 'name-asc':
            default:
                return nameA.localeCompare(nameB);
        }
    });
    
    const resultsCount = document.getElementById('fieldsResultsCount');
    if (resultsCount) resultsCount.textContent = filteredFields.length;

    const clearFiltersBtn = document.getElementById('fieldsClearFilters');
    if (clearFiltersBtn) {
        const filtersActive = Boolean(searchTerm || typeFilter || modelFilter || sortOption !== 'name-asc');
        clearFiltersBtn.style.display = filtersActive ? 'inline-flex' : 'none';
    }
    
    if (filteredFields.length === 0) {
        listEl.innerHTML = '<div class="empty-state">No custom fields found</div>';
        return;
    }
    
    listEl.innerHTML = `
        <div class="table-wrapper">
            <table class="data-table">
                <thead>
                    <tr>
                        <th class="checkbox-col">
                            <input type="checkbox" id="selectAllFields" onchange="toggleAllFields(this)">
                        </th>
                        <th class="name-col">Field Name</th>
                        <th class="type-col">Type & Details</th>
                        <th class="actions-col">Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${filteredFields.map(field => {
                        const rawId = field?.id ?? field?._id ?? field?.fieldKey ?? field?.name ?? `${field?.dataType || 'field'}-${field?.model || 'contact'}`;
                        const fieldId = String(rawId);
                        const displayName = field.name || 'Unnamed Field';
                        const displayType = field.dataType || 'TEXT';
                        const displayModel = field.model || 'contact';
                        const isSelected = selectedFields.has(fieldId);
                        
                        return `
                            <tr class="${isSelected ? 'selected' : ''}" data-field-id="${fieldId}">
                                <td class="checkbox-col">
                                    <input type="checkbox" 
                                           class="field-checkbox"
                                           ${isSelected ? 'checked' : ''}
                                           onchange="toggleFieldSelection('${fieldId}')">
                                </td>
                                <td class="name-cell">${displayName}</td>
                                <td class="type-cell">
                                    <span class="field-type-badge">${displayType}</span>
                                    <div style="margin-top: 4px; color: #9ca3af; font-size: 12px;">
                                        Model: ${displayModel}
                                        ${field.placeholder ? ` • Placeholder: ${field.placeholder}` : ''}
                                    </div>
                                </td>
                                <td class="actions-cell">
                                    <button class="btn btn-danger" onclick="deleteField('${fieldId}')">Delete</button>
                                </td>
                            </tr>
                        `;
                    }).join('')}
                </tbody>
            </table>
        </div>
    `;
    
    updateFieldsBulkActions();
}

function toggleAllFields(checkbox) {
    const checkboxes = document.querySelectorAll('.field-checkbox');
    checkboxes.forEach(cb => {
        cb.checked = checkbox.checked;
        const row = cb.closest('tr');
        const fieldId = row.dataset.fieldId;
        if (cb.checked) {
            selectedFields.add(fieldId);
            row.classList.add('selected');
        } else {
            selectedFields.delete(fieldId);
            row.classList.remove('selected');
        }
    });
    updateFieldsBulkActions();
}

function toggleFieldSelection(fieldId) {
    if (selectedFields.has(fieldId)) {
        selectedFields.delete(fieldId);
    } else {
        selectedFields.add(fieldId);
    }
    updateFieldsBulkActions();
    renderFieldsSimple();
}

function updateFieldsBulkActions() {
    const bulkBar = document.getElementById('fieldsBulkActions');
    const selectedCount = document.getElementById('fieldsSelectedCount');
    
    selectedCount.textContent = selectedFields.size;
    
    if (selectedFields.size > 0) {
        bulkBar.classList.add('show');
    } else {
        bulkBar.classList.remove('show');
    }
}

function clearFieldsFilters() {
    const searchInput = document.getElementById('fieldsSearch');
    const typeSelect = document.getElementById('fieldsTypeFilter');
    const modelSelect = document.getElementById('fieldsModelFilter');
    const sortSelect = document.getElementById('fieldsSortFilter');
    if (searchInput) searchInput.value = '';
    if (typeSelect) typeSelect.value = '';
    if (modelSelect) modelSelect.value = '';
    if (sortSelect) sortSelect.value = 'name-asc';
    renderFieldsSimple();
}

function clearTagsFilters() {
    const searchInput = document.getElementById('tagsSearch');
    const sortSelect = document.getElementById('tagsSortFilter');
    if (searchInput) searchInput.value = '';
    if (sortSelect) sortSelect.value = 'name-asc';
    renderTags();
}

async function bulkDeleteFields() {
    if (!confirm(`Are you sure you want to delete ${selectedFields.size} fields?`)) return;
    
    let deleted = 0;
    let failed = 0;
    
    for (const fieldId of selectedFields) {
        try {
            const response = await fetch(`${API_BASE}/locations/${selectedLocation.id}/custom-fields/${fieldId}`, {
                method: 'DELETE'
            });
            
            if (response.ok) {
                deleted++;
            } else {
                failed++;
            }
        } catch (error) {
            failed++;
        }
    }
    
    selectedFields.clear();
    updateFieldsBulkActions();
    
    if (deleted > 0) {
        showMessage(`Successfully deleted ${deleted} fields${failed > 0 ? `, ${failed} failed` : ''}`, 'success');
        loadCustomFields();
    } else {
        showMessage(`Failed to delete fields`, 'error');
    }
}

function deselectAllFields() {
    selectedFields.clear();
    updateFieldsBulkActions();
    renderFieldsSimple();
}

function exportFields() {
    const dataToExport = selectedFields.size > 0 
        ? allFields.filter(f => selectedFields.has(f.id))
        : allFields;
    
    const json = JSON.stringify(dataToExport, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `custom-fields-${selectedLocation.name}-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

async function loadCustomValues() {
    if (!selectedLocation) return;
    
    const listEl = document.getElementById('valuesList');
    listEl.innerHTML = '<div class="loading">Loading custom values...</div>';
    
    try {
        const response = await fetch(`${API_BASE}/locations/${selectedLocation.id}/custom-values`);
        const data = await response.json();
        
        if (data.success) {
            const values = data.customValues || data.values || [];
            
            if (values && values.length > 0) {
                allValues = values;
                document.getElementById('valuesToolbar').style.display = 'flex';
                document.getElementById('valuesResultsInfo').style.display = 'flex';
                renderValuesSimple();
            } else {
                document.getElementById('valuesToolbar').style.display = 'none';
                document.getElementById('valuesResultsInfo').style.display = 'none';
                allValues = [];
                listEl.innerHTML = '<div class="empty-state">No custom values found</div>';
            }
        } else {
            throw new Error(data.error || 'Failed to load values');
        }
    } catch (error) {
        document.getElementById('valuesToolbar').style.display = 'none';
        document.getElementById('valuesResultsInfo').style.display = 'none';
        listEl.innerHTML = `<div class="error-message">Failed to load custom values: ${error.message}</div>`;
    }
}

function renderValuesSimple() {
    const listEl = document.getElementById('valuesList');
    const searchTerm = document.getElementById('valuesSearch')?.value?.toLowerCase() || '';
    const sortOption = document.getElementById('valuesSortFilter')?.value || 'name-asc';
    
    let filteredValues = allValues.filter(value => {
        if (!value) return false;
        const matchesSearch = !searchTerm || 
            (value.name && value.name.toLowerCase().includes(searchTerm)) ||
            (value.value && value.value.toLowerCase().includes(searchTerm)) ||
            (value.fieldKey && value.fieldKey.toLowerCase().includes(searchTerm));
        return matchesSearch;
    });
    
    filteredValues.sort((a, b) => {
        switch(sortOption) {
            case 'name-asc':
                return (a.name || '').localeCompare(b.name || '');
            case 'name-desc':
                return (b.name || '').localeCompare(a.name || '');
            case 'value-asc':
                return (a.value || '').localeCompare(b.value || '');
            case 'value-desc':
                return (b.value || '').localeCompare(a.value || '');
            default:
                return 0;
        }
    });
    
    const resultsCount = document.getElementById('valuesResultsCount');
    if (resultsCount) resultsCount.textContent = filteredValues.length;
    
    if (filteredValues.length === 0) {
        listEl.innerHTML = '<div class="empty-state">No custom values found</div>';
        return;
    }
    
    listEl.innerHTML = `
        <div class="table-wrapper">
            <table class="data-table">
                <thead>
                    <tr>
                        <th class="checkbox-col">
                            <input type="checkbox" id="selectAllValues" onchange="toggleAllValues(this)">
                        </th>
                        <th class="name-col">Name</th>
                        <th class="fieldkey-col">Field Key</th>
                        <th class="value-col">Value</th>
                        <th class="actions-col">Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${filteredValues.map(value => {
                        const valueId = value.id || value._id || Math.random().toString(36);
                        const displayValue = value.value || '';
                        const displayName = value.name || 'Unnamed';
                        const fieldKey = value.fieldKey || '';
                        const isSelected = selectedValues.has(valueId);
                        const truncatedValue = displayValue.length > 150 ? displayValue.substring(0, 150) + '...' : displayValue;
                        
                        return `
                            <tr class="${isSelected ? 'selected' : ''}" data-value-id="${valueId}">
                                <td class="checkbox-col">
                                    <input type="checkbox" 
                                           class="value-checkbox"
                                           ${isSelected ? 'checked' : ''}
                                           onchange="toggleValueSelection('${valueId}')">
                                </td>
                                <td class="name-cell">${displayName}</td>
                                <td class="fieldkey-cell">
                                    ${fieldKey ? `
                                        <code class="field-key-code" onclick="copyToClipboard('${fieldKey.replace(/'/g, "\\'")}', event)">${fieldKey}</code>
                                        <span class="copy-hint">Click to copy</span>
                                    ` : '<span style="color: #cbd5e0;">-</span>'}
                                </td>
                                <td class="value-cell">${truncatedValue}</td>
                                <td class="actions-cell">
                                    <button class="btn btn-danger" onclick="deleteValue('${valueId}')">Delete</button>
                                </td>
                            </tr>
                        `;
                    }).join('')}
                </tbody>
            </table>
        </div>
    `;
}

function toggleValuesView(view) {
    currentValuesView = view;
    
    // Update button states
    document.getElementById('valuesListViewBtn').style.background = view === 'list' ? '#667eea' : '';
    document.getElementById('valuesListViewBtn').style.color = view === 'list' ? 'white' : '';
    document.getElementById('valuesGalleryViewBtn').style.background = view === 'gallery' ? '#667eea' : '';
    document.getElementById('valuesGalleryViewBtn').style.color = view === 'gallery' ? 'white' : '';
    
    if (view === 'gallery') {
        renderValuesGallery();
    } else {
        renderValuesSimple();
    }
}

function renderValuesGallery() {
    const listEl = document.getElementById('valuesList');
    const searchTerm = document.getElementById('valuesSearch')?.value?.toLowerCase() || '';
    
    // Filter for image URLs
    const imageValues = allValues.filter(value => {
        if (!value || !value.value) return false;
        
        const val = value.value.toLowerCase();
        const isImage = val.match(/\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?.*)?$/i) || 
                       val.startsWith('http') && (val.includes('image') || val.includes('img'));
        
        const matchesSearch = !searchTerm || 
            (value.name && value.name.toLowerCase().includes(searchTerm)) ||
            (value.value && value.value.toLowerCase().includes(searchTerm));
        
        return isImage && matchesSearch;
    });
    
    const resultsCount = document.getElementById('valuesResultsCount');
    if (resultsCount) resultsCount.textContent = imageValues.length;
    
    if (imageValues.length === 0) {
        listEl.innerHTML = '<div class="empty-state">No image custom values found. Switch to List view to see all values.</div>';
        return;
    }
    
    listEl.innerHTML = `
        <div class="gallery-grid">
            ${imageValues.map(value => {
                const valueId = value.id || value._id || Math.random().toString(36);
                const displayName = value.name || 'Unnamed';
                const imageUrl = value.value;
                const fieldKey = value.fieldKey || '';
                
                return `
                    <div class="gallery-item" data-value-id="${valueId}">
                        <div class="gallery-image-container">
                            <img src="${imageUrl}" alt="${displayName}" class="gallery-image" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%22200%22%3E%3Crect fill=%22%23e2e8f0%22 width=%22200%22 height=%22200%22/%3E%3Ctext x=%2250%25%22 y=%2250%25%22 font-size=%2216%22 text-anchor=%22middle%22 dy=%22.3em%22 fill=%22%23718096%22%3EImage Failed%3C/text%3E%3C/svg%3E'">
                        </div>
                        <div class="gallery-info">
                            <div class="gallery-name">${displayName}</div>
                            ${fieldKey ? `<code class="gallery-fieldkey" onclick="copyToClipboard('${fieldKey.replace(/'/g, "\\'")}', event)">${fieldKey}</code>` : ''}
                            <div class="gallery-actions">
                                <button class="btn-icon" onclick="copyToClipboard('${imageUrl.replace(/'/g, "\\'")}', event)" title="Copy URL">📋</button>
                                <button class="btn-icon" onclick="deleteValue('${valueId}')" title="Delete">🗑️</button>
                            </div>
                        </div>
                    </div>
                `;
            }).join('')}
        </div>
    `;
}

function toggleAllValues(checkbox) {
    const checkboxes = document.querySelectorAll('.value-checkbox');
    checkboxes.forEach(cb => {
        cb.checked = checkbox.checked;
        const row = cb.closest('tr');
        const valueId = row.dataset.valueId;
        if (cb.checked) {
            selectedValues.add(valueId);
            row.classList.add('selected');
        } else {
            selectedValues.delete(valueId);
            row.classList.remove('selected');
        }
    });
    updateValuesBulkActions();
}

function toggleValueSelection(valueId) {
    if (selectedValues.has(valueId)) {
        selectedValues.delete(valueId);
    } else {
        selectedValues.add(valueId);
    }
    updateValuesBulkActions();
    renderValuesSimple();
}

function updateValuesBulkActions() {
    const bulkBar = document.getElementById('valuesBulkActions');
    const selectedCount = document.getElementById('valuesSelectedCount');
    
    selectedCount.textContent = selectedValues.size;
    
    if (selectedValues.size > 0) {
        bulkBar.classList.add('show');
    } else {
        bulkBar.classList.remove('show');
    }
}

function clearValuesFilters() {
    document.getElementById('valuesSearch').value = '';
    renderValuesSimple();
}

async function bulkDeleteValues() {
    if (!confirm(`Are you sure you want to delete ${selectedValues.size} values?`)) return;
    
    let deleted = 0;
    let failed = 0;
    
    for (const valueId of selectedValues) {
        try {
            const response = await fetch(`${API_BASE}/locations/${selectedLocation.id}/custom-values/${valueId}`, {
                method: 'DELETE'
            });
            
            if (response.ok) {
                deleted++;
            } else {
                failed++;
            }
        } catch (error) {
            failed++;
        }
    }
    
    selectedValues.clear();
    updateValuesBulkActions();
    
    if (deleted > 0) {
        showMessage(`Successfully deleted ${deleted} values${failed > 0 ? `, ${failed} failed` : ''}`, 'success');
        loadCustomValues();
    } else {
        showMessage(`Failed to delete values`, 'error');
    }
}

function deselectAllValues() {
    selectedValues.clear();
    updateValuesBulkActions();
    renderValuesSimple();
}

function exportValues() {
    const dataToExport = selectedValues.size > 0 
        ? allValues.filter(v => selectedValues.has(v.id))
        : allValues;
    
    const json = JSON.stringify(dataToExport, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `custom-values-${selectedLocation.name}-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

function bulkExportValues() {
    const dataToExport = allValues.filter(v => selectedValues.has(v.id));
    
    const json = JSON.stringify(dataToExport, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `selected-values-${selectedLocation.name}-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

function importValues() {
    if (!selectedLocation) {
        showMessage('Please select a location first', 'error');
        return;
    }
    
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv';
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        try {
            const text = await file.text();
            const lines = text.split('\n').filter(line => line.trim());
            
            if (lines.length === 0) {
                showMessage('CSV file is empty', 'error');
                return;
            }
            
            // Check if first line is header
            const firstLine = lines[0].split(',');
            let startIndex = 0;
            
            if (firstLine[0].toLowerCase().includes('name') || 
                firstLine[1].toLowerCase().includes('value')) {
                startIndex = 1; // Skip header row
            }
            
            const items = [];
            for (let i = startIndex; i < lines.length; i++) {
                const parts = lines[i].split(',').map(p => p.trim().replace(/^"|"$/g, ''));
                if (parts.length >= 2 && parts[0] && parts[1]) {
                    items.push({ name: parts[0], value: parts[1] });
                }
            }
            
            if (items.length === 0) {
                showMessage('No valid data found in CSV', 'error');
                return;
            }
            
            // Show import modal
            showImportProgress(items);
            
        } catch (error) {
            showMessage(`Failed to read CSV: ${error.message}`, 'error');
        }
    };
    input.click();
}

async function showImportProgress(items) {
    const modal = document.createElement('div');
    modal.className = 'modal show';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h2>Import Custom Values</h2>
            </div>
            <div style="padding: 20px;">
                <p style="margin-bottom: 20px;">
                    Importing <strong>${items.length}</strong> custom values to <strong>${selectedLocation.name}</strong>
                </p>
                <div class="progress-bar" style="margin-bottom: 10px;">
                    <div class="progress-fill" id="importProgressBar"></div>
                </div>
                <div id="importStatus" style="margin-bottom: 20px; color: #4a5568;">Starting import...</div>
                <div id="importResults" style="max-height: 300px; overflow-y: auto;"></div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    
    const progressBar = document.getElementById('importProgressBar');
    const statusDiv = document.getElementById('importStatus');
    const resultsDiv = document.getElementById('importResults');
    
    let imported = 0;
    let failed = 0;
    const errors = [];
    
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const progress = ((i + 1) / items.length) * 100;
        progressBar.style.width = progress + '%';
        statusDiv.textContent = `Processing ${i + 1} of ${items.length}...`;
        
        try {
            const response = await fetch(`${API_BASE}/locations/${selectedLocation.id}/custom-values`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: item.name,
                    value: item.value
                })
            });
            
            if (response.ok) {
                imported++;
            } else {
                const data = await response.json();
                failed++;
                errors.push({
                    name: item.name,
                    error: data.error || 'Unknown error'
                });
            }
        } catch (error) {
            failed++;
            errors.push({
                name: item.name,
                error: error.message
            });
        }
    }
    
    // Show results
    statusDiv.innerHTML = `
        <strong style="color: #48bb78;">✓ ${imported} imported successfully</strong>
        ${failed > 0 ? `<strong style="color: #e53e3e; margin-left: 20px;">✗ ${failed} failed</strong>` : ''}
    `;
    
    if (errors.length > 0) {
        resultsDiv.innerHTML = `
            <div style="margin-top: 20px;">
                <strong>Errors:</strong>
                ${errors.map(err => `
                    <div style="padding: 8px; background: #fed7d7; border-radius: 4px; margin: 5px 0; font-size: 13px;">
                        <strong>${err.name}:</strong> ${err.error}
                    </div>
                `).join('')}
            </div>
        `;
    }
    
    // Add close button
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn-primary';
    closeBtn.textContent = 'Close';
    closeBtn.style.marginTop = '20px';
    closeBtn.onclick = () => {
        modal.remove();
        if (imported > 0) {
            loadCustomValues();
        }
    };
    modal.querySelector('.modal-content').appendChild(closeBtn);
}

function importFields() {
    if (!selectedLocation) {
        showMessage('Please select a location first', 'error');
        return;
    }
    
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv';
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        try {
            const text = await file.text();
            const lines = text.split('\n').filter(line => line.trim());
            
            if (lines.length === 0) {
                showMessage('CSV file is empty', 'error');
                return;
            }
            
            // Check if first line is header
            const firstLine = lines[0].split(',');
            let startIndex = 0;
            
            if (firstLine[0].toLowerCase().includes('name') || 
                firstLine[1].toLowerCase().includes('type')) {
                startIndex = 1;
            }
            
            const items = [];
            for (let i = startIndex; i < lines.length; i++) {
                const parts = lines[i].split(',').map(p => p.trim().replace(/^"|"$/g, ''));
                if (parts.length >= 2 && parts[0] && parts[1]) {
                    items.push({ 
                        name: parts[0], 
                        dataType: parts[1],
                        model: parts[2] || 'contact',
                        options: parts[3] ? parts[3].split('|').map(o => o.trim()) : []

                    });
                }
            }
            
            if (items.length === 0) {
                showMessage('No valid data found in CSV', 'error');
                return;
            }
            
            showFieldsImportProgress(items);
            
        } catch (error) {
            showMessage(`Failed to read CSV: ${error.message}`, 'error');
        }
    };
    input.click();
}

async function showFieldsImportProgress(items) {
    const modal = document.createElement('div');
    modal.className = 'modal show';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h2>Import Custom Fields</h2>
            </div>
            <div style="padding: 20px;">
                <p style="margin-bottom: 20px;">
                    Importing <strong>${items.length}</strong> custom fields to <strong>${selectedLocation.name}</strong>
                </p>
                <div class="progress-bar" style="margin-bottom: 10px;">
                    <div class="progress-fill" id="importFieldsProgressBar"></div>
                </div>
                <div id="importFieldsStatus" style="margin-bottom: 20px; color: #4a5568;">Starting import...</div>
                <div id="importFieldsResults" style="max-height: 300px; overflow-y: auto;"></div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    
    const progressBar = document.getElementById('importFieldsProgressBar');
    const statusDiv = document.getElementById('importFieldsStatus');
    const resultsDiv = document.getElementById('importFieldsResults');
    
    let imported = 0;
    let failed = 0;
    const errors = [];
    
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const progress = ((i + 1) / items.length) * 100;
        progressBar.style.width = progress + '%';
        statusDiv.textContent = `Processing ${i + 1} of ${items.length}...`;
        
        try {
            const payload = {
    name: item.name,
    dataType: item.dataType,
    model: item.model
};

// Add options for DROPDOWN and RADIO fields
if ((item.dataType === 'DROPDOWN' || item.dataType === 'RADIO') && item.options && item.options.length > 0) {
    payload.options = item.options;
}

const response = await fetch(`${API_BASE}/locations/${selectedLocation.id}/custom-fields`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
});
            
            if (response.ok) {
                imported++;
            } else {
                const data = await response.json();
                failed++;
                errors.push({
                    name: item.name,
                    error: data.error || 'Unknown error'
                });
            }
        } catch (error) {
            failed++;
            errors.push({
                name: item.name,
                error: error.message
            });
        }
    }
    
    statusDiv.innerHTML = `
        <strong style="color: #48bb78;">✓ ${imported} imported successfully</strong>
        ${failed > 0 ? `<strong style="color: #e53e3e; margin-left: 20px;">✗ ${failed} failed</strong>` : ''}
    `;
    
    if (errors.length > 0) {
        resultsDiv.innerHTML = `
            <div style="margin-top: 20px;">
                <strong>Errors:</strong>
                ${errors.map(err => `
                    <div style="padding: 8px; background: #fed7d7; border-radius: 4px; margin: 5px 0; font-size: 13px;">
                        <strong>${err.name}:</strong> ${err.error}
                    </div>
                `).join('')}
            </div>
        `;
    }
    
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn-primary';
    closeBtn.textContent = 'Close';
    closeBtn.style.marginTop = '20px';
    closeBtn.onclick = () => {
        modal.remove();
        if (imported > 0) {
            loadCustomFields();
        }
    };
    modal.querySelector('.modal-content').appendChild(closeBtn);
}

// TRIGGER LINKS FUNCTIONS
async function loadTriggerLinks() {
    if (!selectedLocation) return;
    
    const listEl = document.getElementById('triggerLinksList');
    if (!listEl) return;
    
    listEl.innerHTML = '<div class="loading">Loading trigger links...</div>';
    
    try {
        const response = await fetch(`${API_BASE}/locations/${selectedLocation.id}/links`);
        const data = await response.json();
        
        if (!data.success) {
            throw new Error(data.error || 'Failed to load trigger links');
        }
        
        const links = Array.isArray(data.triggerLinks) ? data.triggerLinks : [];
        allTriggerLinks = links.map(link => {
            const fallbackId = [link.slug, link.name, link.redirectTo].find(Boolean) || Math.random().toString(36).slice(2);
            return {
                id: fallbackId,
                rawId: link.id || link.rawId || link.uuid || link.linkId || null,
                name: link.name || '',
                slug: link.slug || '',
                redirectTo: link.redirectTo || '',
                shortUrl: link.shortUrl || link.fullUrl || '',
                createdAt: link.createdAt || link.updatedAt || link.created_at || link.updated_at || '',
                updatedAt: link.updatedAt || link.updated_at || ''
            };
        });
        
        selectedTriggerLinks.clear();
        updateTriggerLinkBulkActions();
        
        const toolbar = document.getElementById('triggerLinksToolbar');
        const resultsInfo = document.getElementById('triggerLinksResultsInfo');
        
        if (allTriggerLinks.length > 0) {
            if (toolbar) toolbar.style.display = 'flex';
            if (resultsInfo) resultsInfo.style.display = 'flex';
            renderTriggerLinks();
        } else {
            if (toolbar) toolbar.style.display = 'none';
            if (resultsInfo) resultsInfo.style.display = 'none';
            listEl.innerHTML = '<div class="empty-state">No trigger links found</div>';
        }
    } catch (error) {
        console.error('Trigger link load failed:', error);
        allTriggerLinks = [];
        selectedTriggerLinks.clear();
        updateTriggerLinkBulkActions();
        
        const toolbar = document.getElementById('triggerLinksToolbar');
        const resultsInfo = document.getElementById('triggerLinksResultsInfo');
        if (toolbar) toolbar.style.display = 'none';
        if (resultsInfo) resultsInfo.style.display = 'none';
        
        listEl.innerHTML = `<div class="error-message">Failed to load trigger links: ${error.message}</div>`;
    }
}

function renderTriggerLinks() {
    const listEl = document.getElementById('triggerLinksList');
    if (!listEl) return;
    
    const searchTerm = document.getElementById('triggerLinksSearch')?.value?.toLowerCase() || '';
    const sortOption = document.getElementById('triggerLinksSortFilter')?.value || 'name-asc';
    
    let filtered = allTriggerLinks.filter(link => {
        if (!link) return false;
        const haystack = `${link.name} ${link.slug} ${link.redirectTo} ${link.shortUrl}`.toLowerCase();
        return haystack.includes(searchTerm);
    });
    
    filtered.sort((a, b) => {
        switch (sortOption) {
            case 'name-desc':
                return (b.name || '').localeCompare(a.name || '');
            case 'created-asc':
                return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
            case 'created-desc':
                return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
            case 'name-asc':
            default:
                return (a.name || '').localeCompare(b.name || '');
        }
    });
    
    const resultsCount = document.getElementById('triggerLinksResultsCount');
    if (resultsCount) resultsCount.textContent = filtered.length;
    
    const clearBtn = document.getElementById('triggerLinksClearFilters');
    if (clearBtn) {
        if (searchTerm || sortOption !== 'name-asc') {
            clearBtn.style.display = 'inline-flex';
        } else {
            clearBtn.style.display = 'none';
        }
    }
    
    if (filtered.length === 0) {
        listEl.innerHTML = '<div class="empty-state">No trigger links found</div>';
        return;
    }
    
    listEl.innerHTML = `
        <div class="table-wrapper">
            <table class="data-table">
                <thead>
                    <tr>
                        <th class="checkbox-col">
                            <input type="checkbox" id="selectAllTriggerLinks" onchange="toggleAllTriggerLinks(this)">
                        </th>
                        <th class="name-col">Name</th>
                        <th class="value-col">Redirect URL</th>
                        <th class="fieldkey-col">Short URL</th>
                        <th class="actions-col">Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${filtered.map(link => {
                        const linkId = link.id;
                        const isSelected = selectedTriggerLinks.has(linkId);
                        const safeRedirect = link.redirectTo || '';
                        const safeShort = link.shortUrl || '';
                        return `
                            <tr class="${isSelected ? 'selected' : ''}" data-trigger-id="${linkId}">
                                <td class="checkbox-col">
                                    <input type="checkbox"
                                           class="trigger-link-checkbox"
                                           ${isSelected ? 'checked' : ''}
                                           onchange="toggleTriggerLinkSelection('${linkId.replace(/'/g, "\\'")}')">
                                </td>
                                <td class="name-cell">
                                    <div>${link.name || 'Unnamed Link'}</div>
                                    ${link.slug ? `<div style="color: #718096; font-size: 12px; margin-top: 4px;">/${link.slug}</div>` : ''}
                                </td>
                                <td class="value-cell">
                                    ${safeRedirect ? `<code class="field-key-code" onclick="copyToClipboard('${safeRedirect.replace(/'/g, "\\'")}', event)">${safeRedirect}</code>` : '<span style="color: #cbd5e0;">-</span>'}
                                </td>
                                <td class="fieldkey-cell">
                                    ${safeShort ? `<code class="field-key-code" onclick="copyToClipboard('${safeShort.replace(/'/g, "\\'")}', event)">${safeShort}</code>` : '<span style="color: #cbd5e0;">-</span>'}
                                </td>
                                <td class="actions-cell">
                                    <button class="btn btn-secondary" onclick="copyToClipboard('${(safeShort || safeRedirect).replace(/'/g, "\\'")}', event)">Copy Link</button>
                                    <button class="btn btn-danger" onclick="deleteTriggerLink('${linkId.replace(/'/g, "\\'")}')">Delete</button>
                                </td>
                            </tr>
                        `;
                    }).join('')}
                </tbody>
            </table>
        </div>
    `;
}

// TAG MANAGEMENT FUNCTIONS
async function loadTags() {
    if (!selectedLocation) {
        const listEl = document.getElementById('tagsList');
        if (listEl) listEl.innerHTML = '<div class="empty-state">Please select a location</div>';
        return;
    }
    const listEl = document.getElementById('tagsList');
    if (!listEl) return;
    listEl.innerHTML = '<div class="loading">Loading tags...</div>';

    try {
        const response = await fetch(`${API_BASE}/locations/${selectedLocation.id}/tags`);
        const data = await response.json();

        if (!data.success) {
            throw new Error(data.error || 'Failed to load tags');
        }

        filteredTags = [];
        allTags = Array.isArray(data.tags) ? data.tags.map(tag => ({
            id: tag?.id || tag?._id || tag?.tagId || tag?.uuid || tag?.name,
            name: (tag?.name || '').trim(),
            createdAt: tag?.createdAt || tag?.created_at || tag?.timestamp || null,
            updatedAt: tag?.updatedAt || tag?.updated_at || null,
            raw: tag
        })) : [];
        selectedTags.clear();

        const toolbar = document.getElementById('tagsToolbar');
        const resultsInfo = document.getElementById('tagsResultsInfo');
        if (allTags.length > 0) {
            if (toolbar) toolbar.style.display = 'flex';
            if (resultsInfo) resultsInfo.style.display = 'flex';
        } else {
            if (toolbar) toolbar.style.display = 'none';
            if (resultsInfo) resultsInfo.style.display = 'none';
            const clearBtn = document.getElementById('tagsClearFilters');
            if (clearBtn) clearBtn.style.display = 'none';
        }

        renderTags();
    } catch (error) {
        console.error('Load tags error:', error);
        filteredTags = [];
        allTags = [];
        selectedTags.clear();
        const toolbar = document.getElementById('tagsToolbar');
        const resultsInfo = document.getElementById('tagsResultsInfo');
        if (toolbar) toolbar.style.display = 'none';
        if (resultsInfo) resultsInfo.style.display = 'none';
        const clearBtn = document.getElementById('tagsClearFilters');
        if (clearBtn) clearBtn.style.display = 'none';
        listEl.innerHTML = `<div class="error-message">Failed to load tags: ${error.message}</div>`;
    }
}

function renderTags() {
    const listEl = document.getElementById('tagsList');
    if (!listEl) return;

    const searchTerm = document.getElementById('tagsSearch')?.value?.toLowerCase() || '';
    const sortOption = document.getElementById('tagsSortFilter')?.value || 'name-asc';

    filteredTags = allTags.filter(tag => {
        if (!tag) return false;
        const haystack = `${tag.name}`.toLowerCase();
        return haystack.includes(searchTerm);
    }).sort((a, b) => {
        const nameA = (a?.name || '').toLowerCase();
        const nameB = (b?.name || '').toLowerCase();
        const createdA = new Date(a?.createdAt || 0);
        const createdB = new Date(b?.createdAt || 0);
        switch (sortOption) {
            case 'name-desc':
                return nameB.localeCompare(nameA);
            case 'created-desc':
                return createdB - createdA;
            case 'created-asc':
                return createdA - createdB;
            case 'name-asc':
            default:
                return nameA.localeCompare(nameB);
        }
    });

    const resultsCount = document.getElementById('tagsResultsCount');
    if (resultsCount) resultsCount.textContent = filteredTags.length;

    const clearBtn = document.getElementById('tagsClearFilters');
    if (clearBtn) {
        const filtersActive = Boolean(searchTerm || sortOption !== 'name-asc');
        clearBtn.style.display = filtersActive ? 'inline-flex' : 'none';
    }

    if (filteredTags.length === 0) {
        listEl.innerHTML = '<div class="empty-state">No tags found</div>';
        updateTagsBulkActions();
        return;
    }

    listEl.innerHTML = `
        <div class="table-wrapper">
            <table class="data-table">
                <thead>
                    <tr>
                        <th class="checkbox-col"><input type="checkbox" id="selectAllTags" onchange="toggleAllTags(this)"></th>
                        <th class="name-col">Tag Name</th>
                        <th class="fieldkey-col">Identifier</th>
                        <th class="actions-col">Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${filteredTags.map(tag => {
                        const tagId = tag.id ? String(tag.id) : tag.name;
                        const isSelected = selectedTags.has(tagId);
                        return `
                            <tr class="${isSelected ? 'selected' : ''}" data-tag-id="${tagId}">
                                <td class="checkbox-col">
                                    <input type="checkbox" class="tag-checkbox" ${isSelected ? 'checked' : ''} onchange="toggleTagSelection('${tagId.replace(/'/g, "\\'")}')">
                                </td>
                                <td class="name-cell">${tag.name || 'Untitled Tag'}</td>
                                <td class="fieldkey-cell"><code>${tagId}</code></td>
                                <td class="actions-cell">
                                    <button class="btn" onclick="editTag('${tagId.replace(/'/g, "\\'")}')">Edit</button>
                                    <button class="btn btn-danger" onclick="deleteTag('${tagId.replace(/'/g, "\\'")}')">Delete</button>
                                </td>
                            </tr>
                        `;
                    }).join('')}
                </tbody>
            </table>
        </div>
    `;

    updateTagsBulkActions();
}

function toggleTagSelection(tagId) {
    if (!tagId) return;
    const normalizedId = String(tagId);
    if (selectedTags.has(normalizedId)) {
        selectedTags.delete(normalizedId);
    } else {
        selectedTags.add(normalizedId);
    }
    updateTagsBulkActions();
    renderTags();
}

function toggleAllTags(checkbox) {
    const shouldSelect = checkbox.checked;
    const currentIds = Array.from(new Set((filteredTags || []).map(tag => tag.id ? String(tag.id) : tag.name).filter(Boolean)));
    if (shouldSelect) {
        currentIds.forEach(id => selectedTags.add(id));
    } else {
        currentIds.forEach(id => selectedTags.delete(id));
    }
    updateTagsBulkActions();
    renderTags();
}

function updateTagsBulkActions() {
    const bulkBar = document.getElementById('tagsBulkActions');
    const selectedCount = document.getElementById('tagsSelectedCount');
    if (selectedCount) selectedCount.textContent = selectedTags.size;
    if (bulkBar) {
        if (selectedTags.size > 0) {
            bulkBar.classList.add('show');
        } else {
            bulkBar.classList.remove('show');
        }
    }
    const selectAll = document.getElementById('selectAllTags');
    if (selectAll) {
        const ids = Array.from(new Set((filteredTags || []).map(tag => tag.id ? String(tag.id) : tag.name).filter(Boolean)));
        if (ids.length === 0) {
            selectAll.checked = false;
            selectAll.indeterminate = false;
        } else {
            const allSelected = ids.every(id => selectedTags.has(id));
            const someSelected = ids.some(id => selectedTags.has(id));
            selectAll.checked = allSelected;
            selectAll.indeterminate = !allSelected && someSelected;
        }
    }
}

function deselectAllTags() {
    selectedTags.clear();
    updateTagsBulkActions();
    renderTags();
}

async function deleteTag(tagId) {
    if (!selectedLocation || !tagId) return;
    const normalizedId = String(tagId);
    if (!confirm('Are you sure you want to delete this tag?')) return;
    try {
        const response = await fetch(`${API_BASE}/locations/${selectedLocation.id}/tags/${encodeURIComponent(normalizedId)}`, {
            method: 'DELETE'
        });
        let data = null;
        try {
            data = await response.json();
        } catch (_) {
            data = null;
        }
        if (response.ok && (data?.success ?? true)) {
            showMessage('Tag deleted successfully', 'success');
            selectedTags.delete(normalizedId);
            await loadTags();
        } else {
            showMessage(data?.error || 'Failed to delete tag', 'error');
        }
    } catch (error) {
        showMessage(`Error: ${error.message}`, 'error');
    }
}

async function bulkDeleteTags() {
    if (!selectedLocation) {
        showMessage('Please select a location first', 'error');
        return;
    }
    if (selectedTags.size === 0) {
        showMessage('Select at least one tag to delete.', 'error');
        return;
    }
    if (!confirm(`Delete ${selectedTags.size} tag(s)? This cannot be undone.`)) {
        return;
    }
    let deleted = 0;
    let failed = 0;
    for (const tagId of Array.from(selectedTags)) {
        try {
            const response = await fetch(`${API_BASE}/locations/${selectedLocation.id}/tags/${encodeURIComponent(tagId)}`, {
                method: 'DELETE'
            });
            if (response.ok) {
                deleted++;
            } else {
                failed++;
            }
        } catch (error) {
            failed++;
        }
    }
    selectedTags.clear();
    updateTagsBulkActions();
    await loadTags();
    if (deleted > 0) {
        showMessage(`Deleted ${deleted} tag(s)${failed ? `, ${failed} failed` : ''}`, 'success');
    } else {
        showMessage('Failed to delete selected tags.', 'error');
    }
}

async function editTag(tagId) {
    if (!selectedLocation || !tagId) return;
    const normalizedId = String(tagId);
    const tag = allTags.find(t => (t.id ? String(t.id) : t.name) === normalizedId);
    if (!tag) {
        showMessage('Tag not found in current list', 'error');
        return;
    }
    const newNameRaw = prompt('Update tag name:', tag.name || '');
    if (newNameRaw === null) return;
    const newName = newNameRaw.trim();
    if (!newName) {
        showMessage('Tag name cannot be empty.', 'error');
        return;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(newName)) {
        showMessage('Tag name may only contain letters, numbers, underscores, or hyphens (no spaces).', 'error');
        return;
    }
    try {
        const response = await fetch(`${API_BASE}/locations/${selectedLocation.id}/tags/${encodeURIComponent(normalizedId)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName })
        });
        const data = await response.json();
        if (response.ok && data.success) {
            showMessage('Tag updated successfully', 'success');
            await loadTags();
        } else {
            showMessage(data.error || 'Failed to update tag', 'error');
        }
    } catch (error) {
        showMessage(`Error: ${error.message}`, 'error');
    }
}

function clearTriggerLinksFilters() {
    const searchInput = document.getElementById('triggerLinksSearch');
    const sortSelect = document.getElementById('triggerLinksSortFilter');
    
    if (searchInput) searchInput.value = '';
    if (sortSelect) sortSelect.value = 'name-asc';
    
    renderTriggerLinks();
}

function toggleAllTriggerLinks(checkbox) {
    const checkboxes = document.querySelectorAll('.trigger-link-checkbox');
    selectedTriggerLinks.clear();
    
    checkboxes.forEach(cb => {
        cb.checked = checkbox.checked;
        const row = cb.closest('tr');
        const linkId = row.dataset.triggerId;
        if (checkbox.checked) {
            selectedTriggerLinks.add(linkId);
            row.classList.add('selected');
        } else {
            row.classList.remove('selected');
        }
    });
    
    updateTriggerLinkBulkActions();
}

function toggleTriggerLinkSelection(linkId) {
    if (selectedTriggerLinks.has(linkId)) {
        selectedTriggerLinks.delete(linkId);
    } else {
        selectedTriggerLinks.add(linkId);
    }
    updateTriggerLinkBulkActions();
    renderTriggerLinks();
}

function updateTriggerLinkBulkActions() {
    const bulkBar = document.getElementById('triggerLinksBulkActions');
    const selectedCount = document.getElementById('triggerLinksSelectedCount');
    
    if (selectedCount) selectedCount.textContent = selectedTriggerLinks.size;
    
    if (bulkBar) {
        if (selectedTriggerLinks.size > 0) {
            bulkBar.classList.add('show');
        } else {
            bulkBar.classList.remove('show');
        }
    }
}

function deselectAllTriggerLinks() {
    selectedTriggerLinks.clear();
    updateTriggerLinkBulkActions();
    renderTriggerLinks();
}

async function deleteTriggerLink(linkId) {
    if (!selectedLocation) return;
    
    const link = allTriggerLinks.find(l => l.id === linkId);
    if (!link) {
        showMessage('Trigger link not found in current list', 'error');
        return;
    }
    
    const apiId = link.rawId || link.id;
    if (!apiId) {
        showMessage('Cannot delete this trigger link because it is missing an identifier from the API.', 'error');
        return;
    }
    
    if (!confirm('Are you sure you want to delete this trigger link?')) {
        return;
    }
    
    try {
        const response = await fetch(`${API_BASE}/locations/${selectedLocation.id}/links/${encodeURIComponent(apiId)}`, {
            method: 'DELETE'
        });
        const result = await response.json();
        
        if (result.success) {
            showMessage('Trigger link deleted successfully', 'success');
            selectedTriggerLinks.delete(linkId);
            await loadTriggerLinks();
        } else {
            showMessage(result.error || 'Failed to delete trigger link', 'error');
        }
    } catch (error) {
        showMessage(`Error: ${error.message}`, 'error');
    }
}

async function bulkDeleteTriggerLinks() {
    if (selectedTriggerLinks.size === 0) return;
    if (!confirm(`Delete ${selectedTriggerLinks.size} trigger link(s)? This cannot be undone.`)) return;
    
    let deleted = 0;
    let failed = 0;
    
    for (const linkId of Array.from(selectedTriggerLinks)) {
        const link = allTriggerLinks.find(l => l.id === linkId);
        if (!link) {
            failed++;
            continue;
        }
        
        const apiId = link.rawId || link.id;
        if (!apiId) {
            failed++;
            continue;
        }
        
        try {
            const response = await fetch(`${API_BASE}/locations/${selectedLocation.id}/links/${encodeURIComponent(apiId)}`, {
                method: 'DELETE'
            });
            if (response.ok) {
                deleted++;
            } else {
                failed++;
            }
        } catch (error) {
            failed++;
        }
    }
    
    if (deleted > 0) {
        showMessage(`Deleted ${deleted} trigger link(s)${failed ? `, ${failed} failed` : ''}`, 'success');
    } else {
        showMessage('Failed to delete selected trigger links', 'error');
    }
    
    selectedTriggerLinks.clear();
    await loadTriggerLinks();
}

function exportTriggerLinks() {
    const data = allTriggerLinks.map(link => ({
        id: link.rawId || link.id,
        name: link.name,
        slug: link.slug,
        redirectTo: link.redirectTo,
        shortUrl: link.shortUrl,
        createdAt: link.createdAt,
        updatedAt: link.updatedAt
    }));
    
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `links-${selectedLocation?.name || 'location'}-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

function loadLocationSettings() {
    if (!selectedLocation) return;
    
    const settingsEl = document.getElementById('locationSettings');
    settingsEl.innerHTML = `
        <div class="location-card">
            <div class="location-card-header">
                <div class="location-card-title">${selectedLocation.name}</div>
            </div>
            <div class="location-card-meta">
                <p><strong>Location ID:</strong> ${selectedLocation.locationId}</p>
                <p><strong>GHL Name:</strong> ${selectedLocation.ghlName || 'N/A'}</p>
                <p><strong>Email:</strong> ${selectedLocation.email || 'N/A'}</p>
                <p><strong>Added:</strong> ${new Date(selectedLocation.addedAt).toLocaleString()}</p>
                <p><strong>Last Used:</strong> ${selectedLocation.lastUsed ? new Date(selectedLocation.lastUsed).toLocaleString() : 'Never'}</p>
                <p><strong>Token:</strong> ***hidden***</p>
            </div>
        </div>
    `;
}

async function loadSocialProfiles() {
    const grid = document.getElementById('socialProfilesBody');
    if (!grid) return;

    if (!selectedLocation) {
        grid.innerHTML = '<div class="empty-state">Select a location to manage social profiles.</div>';
        return;
    }

    currentSocialProfiles = selectedLocation.credentials?.socialProfiles || {};
    selectedLocation.socialProfiles = currentSocialProfiles;
    renderSocialProfiles();
}

function renderSocialProfiles() {
    const grid = document.getElementById('socialProfilesBody');
    if (!grid) return;

    if (!selectedLocation) {
        grid.innerHTML = '<div class="empty-state">Select a location to manage social profiles.</div>';
        return;
    }

    const socialProfiles = currentSocialProfiles || {};
    const cards = SOCIAL_PLATFORMS.map((platform) => {
        const profilesForPlatform = Array.isArray(socialProfiles[platform.id])
            ? socialProfiles[platform.id]
            : [];
        const statusLabel = profilesForPlatform.length > 0 ? 'Connected' : 'Not connected';
        const accountsMarkup =
            profilesForPlatform.length > 0
                ? `<div class="social-accounts-list">
                        ${profilesForPlatform
                            .map(
                                (account) => `
                                    <div class="social-account-item">
                                        <div class="social-account-details">
                                            <span class="social-account-name">${escapeHtml(account.displayName || account.accountId)}</span>
                                            <span>${account.locations?.length || 0} linked locations</span>
                                        </div>
                                    </div>
                                `
                            )
                            .join('')}
                   </div>`
                : `<div class="social-empty">
                        <strong>${platform.note || 'Not available yet.'}</strong>
                   </div>`;

        return `
        <div class="social-platform-card">
            <div class="social-platform-head">
                <div style="display:flex;align-items:center;gap:10px;">
                    <span>${platform.icon}</span>
                    <h3>${platform.name}</h3>
                </div>
                <div class="social-status">${statusLabel}</div>
            </div>
            ${accountsMarkup}
        </div>`;
    }).join('');

    grid.innerHTML = cards;
}



function setupInputListeners() {
    const nameInput = document.getElementById('valueName');
    const warningEl = document.getElementById('nameWarning');
    
    if (nameInput) {
        nameInput.addEventListener('input', (e) => {
            const value = e.target.value;
            if (value && /[\s\W]/.test(value)) {
                warningEl.classList.add('show');
            } else {
                warningEl.classList.remove('show');
            }
        });
    }
}

function launchConfetti() {
    const canvas = document.getElementById('confettiCanvas');
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    
    const pieces = [];
    const colors = ['#667eea', '#764ba2', '#48bb78', '#f59e0b', '#ef4444'];
    
    for (let i = 0; i < 150; i++) {
        pieces.push({
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height - canvas.height,
            w: Math.random() * 10 + 5,
            h: Math.random() * 5 + 3,
            color: colors[Math.floor(Math.random() * colors.length)],
            vx: Math.random() * 2 - 1,
            vy: Math.random() * 5 + 3,
            rotation: Math.random() * 360,
            rotationSpeed: Math.random() * 10 - 5
        });
    }
    
    function animate() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        pieces.forEach((piece, index) => {
            piece.y += piece.vy;
            piece.x += piece.vx;
            piece.rotation += piece.rotationSpeed;
            
            if (piece.y > canvas.height) {
                pieces.splice(index, 1);
            }
            
            ctx.save();
            ctx.translate(piece.x + piece.w/2, piece.y + piece.h/2);
            ctx.rotate(piece.rotation * Math.PI / 180);
            ctx.fillStyle = piece.color;
            ctx.fillRect(-piece.w/2, -piece.h/2, piece.w, piece.h);
            ctx.restore();
        });
        
        if (pieces.length > 0) {
            requestAnimationFrame(animate);
        } else {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
    }
    
    animate();
}

function updateProgress(percent, status) {
    const progressFill = document.getElementById('progressFill');
    const progressStatus = document.getElementById('progressStatus');
    
    if (progressFill) progressFill.style.width = percent + '%';
    if (progressStatus) progressStatus.textContent = status;
}

function updateTriggerLinksProgress(percent, status) {
    const progressFill = document.getElementById('triggerLinksProgressFill');
    const progressStatus = document.getElementById('triggerLinksProgressStatus');
    
    if (progressFill) progressFill.style.width = percent + '%';
    if (progressStatus) progressStatus.textContent = status;
}

async function uploadImageToMediaLibrary(file, fileName) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('name', fileName || file.name);
    
    try {
        const response = await fetch(`${API_BASE}/locations/${selectedLocation.id}/media`, {
            method: 'POST',
            body: formData
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            const message = data?.error || `Upload failed (status ${response.status})`;
            throw new Error(message);
        }
        
        if (!data?.success) {
            const message = data?.error || 'Upload succeeded but returned no success flag.';
            throw new Error(message);
        }
        
        let mediaUrl = data?.url || '';
        
        try {
            const params = new URLSearchParams({
                sortBy: 'createdAt',
                sortOrder: 'desc',
                limit: '1'
            });
            
            const latestResponse = await fetch(`${API_BASE}/locations/${selectedLocation.id}/media?${params.toString()}`);
            const latestData = await latestResponse.json();
            
            if (latestResponse.ok && latestData?.success && Array.isArray(latestData.files) && latestData.files.length > 0) {
                mediaUrl = latestData.files[0]?.url || latestData.files[0]?.fileUrl || mediaUrl;
            }
        } catch (latestError) {
            console.warn('Failed to fetch latest media file:', latestError);
        }
        
        if (!mediaUrl) {
            throw new Error('Upload succeeded but no media URL was returned.');
        }
        
        return mediaUrl;
    } catch (error) {
        console.error('Media upload failed:', error);
        throw error;
    }
}

function setupFilterListeners() {
    const fieldsSearch = document.getElementById('fieldsSearch');
    if (fieldsSearch) {
        fieldsSearch.addEventListener('input', () => {
            if (allFields && allFields.length > 0) {
                renderFieldsSimple();
            }
        });
    }
    
    const fieldsTypeFilter = document.getElementById('fieldsTypeFilter');
    if (fieldsTypeFilter) {
        fieldsTypeFilter.addEventListener('change', () => {
            if (allFields && allFields.length > 0) {
                renderFieldsSimple();
            }
        });
    }
    
    const fieldsModelFilter = document.getElementById('fieldsModelFilter');
    if (fieldsModelFilter) {
        fieldsModelFilter.addEventListener('change', () => {
            if (allFields && allFields.length > 0) {
                renderFieldsSimple();
            }
        });
    }

    const fieldsSortFilter = document.getElementById('fieldsSortFilter');
    if (fieldsSortFilter) {
        fieldsSortFilter.addEventListener('change', () => {
            if (allFields && allFields.length > 0) {
                renderFieldsSimple();
            }
        });
    }
    
    const valuesSearch = document.getElementById('valuesSearch');
    if (valuesSearch) {
        valuesSearch.addEventListener('input', () => {
            if (allValues && allValues.length > 0) {
                renderValuesSimple();
            }
        });
    }
    
    const valuesSortFilter = document.getElementById('valuesSortFilter');
    if (valuesSortFilter) {
        valuesSortFilter.addEventListener('change', () => {
            if (allValues && allValues.length > 0) {
                renderValuesSimple();
            }
        });
    }

    const tagsSearch = document.getElementById('tagsSearch');
    if (tagsSearch) {
        tagsSearch.addEventListener('input', () => {
            if (allTags && allTags.length > 0) {
                renderTags();
            }
        });
    }

    const tagsSortFilter = document.getElementById('tagsSortFilter');
    if (tagsSortFilter) {
        tagsSortFilter.addEventListener('change', () => {
            if (allTags && allTags.length > 0) {
                renderTags();
            }
        });
    }

    const triggerLinksSearch = document.getElementById('triggerLinksSearch');
    if (triggerLinksSearch) {
        triggerLinksSearch.addEventListener('input', () => {
            if (allTriggerLinks && allTriggerLinks.length > 0) {
                renderTriggerLinks();
            }
        });
    }
    
    const triggerLinksSortFilter = document.getElementById('triggerLinksSortFilter');
    if (triggerLinksSortFilter) {
        triggerLinksSortFilter.addEventListener('change', () => {
            if (allTriggerLinks && allTriggerLinks.length > 0) {
                renderTriggerLinks();
            }
        });
    }
}

function setupFormHandlers() {
    document.getElementById('valueType').addEventListener('change', (e) => {
        const textGroup = document.getElementById('textValueGroup');
        const imageGroup = document.getElementById('imageUploadGroup');
        const textArea = document.getElementById('valueContent');
        const imageInput = document.getElementById('imageUpload');
        
        if (e.target.value === 'image') {
            textGroup.style.display = 'none';
            imageGroup.style.display = 'block';
            textArea.removeAttribute('required');
            imageInput.setAttribute('required', 'required');
        } else {
            textGroup.style.display = 'block';
            imageGroup.style.display = 'none';
            textArea.setAttribute('required', 'required');
            imageInput.removeAttribute('required');
        }
    });

    document.getElementById('imageUpload').addEventListener('change', (e) => {
        const file = e.target.files[0];
        const preview = document.getElementById('imagePreview');
        const previewImg = document.getElementById('previewImg');
        const imageInput = document.getElementById('imageUpload');
        const urlDisplay = document.getElementById('imageUrlDisplay');
        
        if (!file) {
            preview.style.display = 'none';
            imageInput.dataset.imageUrl = '';
            imageInput.dataset.imageName = '';
            if (urlDisplay) urlDisplay.textContent = '';
            return;
        }
        
        previewImg.src = URL.createObjectURL(file);
        preview.style.display = 'block';
        imageInput.dataset.imageUrl = '';
        imageInput.dataset.imageName = file.name;
        if (urlDisplay) urlDisplay.textContent = '';
    });
    
   
    
    document.getElementById('addLocationForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const formData = new FormData(e.target);
        const data = Object.fromEntries(formData);
        
        try {
            const testResponse = await fetch(`${API_BASE}/test-location`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    locationId: data.locationId,
                    token: data.token
                })
            });
            
            const testResult = await testResponse.json();
            
            if (!testResult.success) {
                showMessage(`Connection failed: ${testResult.error}`, 'error');
                return;
            }
            
            const response = await fetch(`${API_BASE}/locations`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            
            const result = await response.json();
            
            if (result.success) {
                showMessage('Location added successfully!', 'success');
                e.target.reset();
                closeModal('addLocationModal');
                await loadLocations();
                selectLocation(result.location.id);
            } else {
                showMessage(`Failed to add location: ${result.error}`, 'error');
            }
        } catch (error) {
            showMessage(`Error: ${error.message}`, 'error');
        }
    });
    
    document.getElementById('createFieldForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        
        if (!selectedLocation) {
            showMessage('Please select a location first', 'error');
            return;
        }
        
        const formData = new FormData(e.target);
        const data = Object.fromEntries(formData);
        
        try {
            const response = await fetch(`${API_BASE}/locations/${selectedLocation.id}/custom-fields`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            
            const result = await response.json();
            
            if (result.success) {
                showMessage('Custom field created successfully!', 'success');
                e.target.reset();
                loadCustomFields();
            } else {
                showMessage(`Failed to create field: ${result.error}`, 'error');
            }
        } catch (error) {
            showMessage(`Error: ${error.message}`, 'error');
        }
    });
    
    document.getElementById('createValueForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        
        if (!selectedLocation) {
            showMessage('Please select a location first', 'error');
            return;
        }
        
        const formData = new FormData(e.target);
        const valueType = document.getElementById('valueType').value;
        
        let data = {
            name: formData.get('name')
        };
        
        const imageInput = document.getElementById('imageUpload');
        if (valueType === 'image') {
            const hasFileSelected = imageInput.files && imageInput.files.length > 0;
            if (!imageInput.dataset.imageUrl && !hasFileSelected) {
                showMessage('Please choose an image file to upload.', 'error');
                return;
            }
        }
        
        const progressContainer = document.getElementById('progressContainer');
        const successResult = document.getElementById('successResult');
        const createBtn = document.getElementById('createValueBtn');
        
        successResult.classList.remove('show');
        progressContainer.classList.add('show');
        createBtn.disabled = true;
        
        updateProgress(10, 'Validating input...');
        await new Promise(resolve => setTimeout(resolve, 300));
        
        const originalName = data.name;
        const systemKey = originalName.toLowerCase().replace(/\s+/g, '_').replace(/[^\w]/g, '');
        
        try {
            let imageUrl = null;
            
            if (valueType === 'image') {
                imageUrl = imageInput.dataset.imageUrl;
                if (!imageUrl) {
                    const file = imageInput.files[0];
                    if (!file) {
                        throw new Error('No image file selected');
                    }
                    updateProgress(30, 'Uploading image to media library...');
                    imageUrl = await uploadImageToMediaLibrary(file, file.name);
                    imageInput.dataset.imageUrl = imageUrl;
                    const urlDisplay = document.getElementById('imageUrlDisplay');
                    if (urlDisplay) urlDisplay.textContent = imageUrl;
                } else {
                    updateProgress(30, 'Preparing to create custom value...');
                }
                data.value = imageUrl;
            } else {
                updateProgress(30, 'Connecting to GoHighLevel...');
                data.value = formData.get('value');
            }
            
            updateProgress(50, 'Creating custom value...');
            
            const response = await fetch(`${API_BASE}/locations/${selectedLocation.id}/custom-values`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            
            updateProgress(70, 'Processing response...');
            
            const result = await response.json();
            
            if (result.success) {
                updateProgress(100, 'Success! Custom value created.');
                
                setTimeout(() => {
                    progressContainer.classList.remove('show');
                    successResult.classList.add('show');
                    
                    document.getElementById('resultKey').textContent = result.customValue?.name || systemKey;
                    document.getElementById('resultValue').textContent = result.customValue?.value || data.value;
                    
                    launchConfetti();
                    
                    e.target.reset();
                    document.getElementById('nameWarning').classList.remove('show');
                    document.getElementById('imagePreview').style.display = 'none';
                    document.getElementById('imageUpload').value = '';
                    document.getElementById('imageUpload').dataset.imageUrl = '';
                    document.getElementById('imageUpload').dataset.imageName = '';
                    const urlDisplay = document.getElementById('imageUrlDisplay');
                    if (urlDisplay) urlDisplay.textContent = '';
                    document.getElementById('valueType').value = 'text';
                    document.getElementById('textValueGroup').style.display = 'block';
                    document.getElementById('imageUploadGroup').style.display = 'none';
                    document.getElementById('valueContent').setAttribute('required', 'required');
                    
                    loadCustomValues();
                    createBtn.disabled = false;
                    
                    setTimeout(() => {
                        successResult.classList.remove('show');
                    }, 5000);
                }, 500);
                
            } else {
                progressContainer.classList.remove('show');
                createBtn.disabled = false;
                
                let errorHtml = `<div class="error-message">
                    <strong>Failed to create custom value</strong>
                    <div class="error-details">`;
                
                if (result.error?.includes('space') || result.error?.includes('invalid')) {
                    errorHtml += `The name "${originalName}" may contain invalid characters. Try using "${systemKey}" instead.`;
                } else {
                    errorHtml += result.error || 'Unknown error occurred';
                }
                
                errorHtml += `</div></div>`;
                
                const errorEl = document.createElement('div');
                errorEl.innerHTML = errorHtml;
                e.target.insertBefore(errorEl.firstChild, createBtn.nextSibling);
                
                setTimeout(() => {
                    errorEl.firstChild?.remove();
                }, 5000);
            }
        } catch (error) {
            progressContainer.classList.remove('show');
            createBtn.disabled = false;
            console.error('Failed to create custom value:', error);
            showMessage(error.message ? `Error: ${error.message}` : 'An unexpected error occurred', 'error');
        }
    });
    
    const triggerLinkForm = document.getElementById('createTriggerLinkForm');
    if (triggerLinkForm) {
        triggerLinkForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            if (!selectedLocation) {
                showMessage('Please select a location first', 'error');
                return;
            }
            
            const formData = new FormData(e.target);
            const name = formData.get('name')?.trim();
            const redirectTo = formData.get('redirectTo')?.trim();
            
            if (!name || !redirectTo) {
                showMessage('Name and redirect URL are required', 'error');
                return;
            }
            
            const progressContainer = document.getElementById('triggerLinksProgressContainer');
            const successResult = document.getElementById('triggerLinksSuccessResult');
            const createBtn = document.getElementById('createTriggerLinkBtn');
            
            successResult?.classList.remove('show');
            progressContainer?.classList.add('show');
            if (createBtn) createBtn.disabled = true;
            
            updateTriggerLinksProgress(15, 'Validating link details...');
            await new Promise(resolve => setTimeout(resolve, 250));
            
            try {
                updateTriggerLinksProgress(45, 'Communicating with GoHighLevel...');
                
                const response = await fetch(`${API_BASE}/locations/${selectedLocation.id}/links`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, redirectTo })
                });
                
                const result = await response.json();
                
                if (result.success) {
                    updateTriggerLinksProgress(100, 'Trigger link created successfully!');
                    
                    setTimeout(async () => {
                        progressContainer?.classList.remove('show');
                        successResult?.classList.add('show');
                        
                        const resultName = document.getElementById('triggerLinksResultName');
                        const resultRedirect = document.getElementById('triggerLinksResultRedirect');
                        const resultShortWrapper = document.getElementById('triggerLinksResultShortWrapper');
                        const resultShort = document.getElementById('triggerLinksResultShort');
                        
                        if (resultName) resultName.textContent = result.triggerLink?.name || name;
                        if (resultRedirect) resultRedirect.textContent = result.triggerLink?.redirectTo || redirectTo;
                        
                        if (result.triggerLink?.shortUrl || result.triggerLink?.fullUrl) {
                            if (resultShortWrapper) resultShortWrapper.style.display = 'flex';
                            if (resultShort) resultShort.textContent = result.triggerLink.shortUrl || result.triggerLink.fullUrl;
                        } else if (resultShortWrapper) {
                            resultShortWrapper.style.display = 'none';
                        }
                        
                        launchConfetti();
                        e.target.reset();
                        await loadTriggerLinks();
                        
                        if (createBtn) createBtn.disabled = false;
                        
                        setTimeout(() => {
                            successResult?.classList.remove('show');
                        }, 4000);
                    }, 400);
                } else {
                    progressContainer?.classList.remove('show');
                    if (createBtn) createBtn.disabled = false;
                    showMessage(result.error || 'Failed to create trigger link', 'error');
                }
            } catch (error) {
                progressContainer?.classList.remove('show');
                if (createBtn) createBtn.disabled = false;
                showMessage(`Error: ${error.message}`, 'error');
            }
        });
    }

    const createTagForm = document.getElementById('createTagForm');
    if (createTagForm) {
        createTagForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!selectedLocation) {
                showMessage('Please select a location first', 'error');
                return;
            }
            const formData = new FormData(e.target);
            const name = (formData.get('name') || '').trim();
            if (!name) {
                showMessage('Tag name is required', 'error');
                return;
            }
            if (!/^[A-Za-z0-9_-]+$/.test(name)) {
                showMessage('Tag name may only contain letters, numbers, underscores, or hyphens (no spaces).', 'error');
                return;
            }
            const createBtn = document.getElementById('createTagBtn');
            if (createBtn) createBtn.disabled = true;
            try {
                const response = await fetch(`${API_BASE}/locations/${selectedLocation.id}/tags`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name })
                });
                const data = await response.json();
                if (response.ok && data.success) {
                    showMessage('Tag created successfully', 'success');
                    e.target.reset();
                    await loadTags();
                } else {
                    showMessage(data.error || 'Failed to create tag', 'error');
                }
            } catch (error) {
                showMessage(`Error: ${error.message}`, 'error');
            } finally {
                if (createBtn) createBtn.disabled = false;
            }
        });
    }
}

async function deleteField(fieldId) {
    if (!selectedLocation) return;
    if (!confirm('Are you sure you want to delete this custom field?')) return;
    
    try {
        const response = await fetch(`${API_BASE}/locations/${selectedLocation.id}/custom-fields/${fieldId}`, {
            method: 'DELETE'
        });
        
        const result = await response.json();
        
        if (result.success) {
            showMessage('Field deleted successfully!', 'success');
            loadCustomFields();
        } else {
            showMessage(`Failed to delete field: ${result.error}`, 'error');
        }
    } catch (error) {
        showMessage(`Error: ${error.message}`, 'error');
        selectedMedia.clear();
        updateMediaBulkActions();
    }
}

async function deleteValue(valueId) {
    if (!selectedLocation) return;
    if (!confirm('Are you sure you want to delete this custom value?')) return;
    
    try {
        const response = await fetch(`${API_BASE}/locations/${selectedLocation.id}/custom-values/${valueId}`, {
            method: 'DELETE'
        });
        
        const result = await response.json();
        
        if (result.success) {
            showMessage('Value deleted successfully!', 'success');
            loadCustomValues();
        } else {
            showMessage(`Failed to delete value: ${result.error}`, 'error');
        }
    } catch (error) {
        showMessage(`Error: ${error.message}`, 'error');
    }
}

function openConnectCrmModal() {
    const modal = document.getElementById('connectCrmModal');
    if (modal) {
        modal.classList.add('show');
    }
}

function startMarketplaceInstall() {
    const returnTo = `${window.location.pathname}${window.location.search}`;
    closeModal('connectCrmModal');
    window.location.href = `/oauth/leadconnector/start?returnTo=${encodeURIComponent(returnTo)}`;
}

function beginPrivateTokenFlow() {
    closeModal('connectCrmModal');
    showAddLocationModal();
}

function showAddLocationModal() {
    document.getElementById('addLocationModal').classList.add('show');
}

function openConnectFromManage() {
    closeModal('manageLocationsModal');
    openConnectCrmModal();
}

async function showLocationSettings() {
    const modal = document.getElementById('manageLocationsModal');
    const listEl = document.getElementById('locationsList');
    
    if (currentLocations.length === 0) {
        listEl.innerHTML = '<div class="empty-state">No locations added yet</div>';
    } else {
        listEl.innerHTML = '<div class="loading">Loading location stats...</div>';
        
        // Load stats for each location
        const locationsWithStats = await Promise.all(
            currentLocations.map(async (location) => {
                const defaultStats = {
                    fieldsCount: 0,
                    valuesCount: 0,
                    tagsCount: 0,
                    linksCount: 0,
                    mediaCount: 0
                };
                try {
                    const response = await fetch(`${API_BASE}/locations/${location.id}/stats`);
                    const data = await response.json();
                    const stats = data.success ? data.stats : defaultStats;
                    const displayName = stats.displayName || stats.ghlName || location.ghlName || location.name;
                    return {
                        ...location,
                        name: displayName || location.name,
                        ghlName: displayName || location.ghlName,
                        stats
                    };
                } catch (error) {
                    return {
                        ...location,
                        stats: defaultStats
                    };
                }
            })
        );

        currentLocations = currentLocations.map((loc) => {
            const enriched = locationsWithStats.find((item) => item.id === loc.id);
            return enriched ? { ...enriched } : loc;
        });
        updateLocationDropdown();
        if (selectedLocation) {
            const updatedSelected = currentLocations.find((loc) => loc.id === selectedLocation.id);
            if (updatedSelected) {
                selectedLocation = updatedSelected;
            }
        }
        
        listEl.innerHTML = `
            <div class="manage-locations-toolbar">
                <button class="btn btn-primary" onclick="openConnectFromManage()">+ Connect Another Location</button>
            </div>
            ${locationsWithStats.map(location => {
                const stats = location.stats || {};
                const connectionLabel = stats.connectionType === 'oauth' || location.credentials?.type === 'oauth'
                    ? 'HighLevel Marketplace'
                    : 'Private Token';
                const displayName = stats.displayName || stats.ghlName || location.ghlName || location.name;
                const business = stats.business || {};
                return `
                <div class="location-card">
                    <div class="location-card-row">
                        <div class="location-card-info">
                            <div class="location-card-title">
                                ${displayName}
                                <span class="location-connection-badge">${connectionLabel}</span>
                            </div>
                            <div class="location-card-meta">
                                <div><span class="meta-label">Location ID</span><span class="meta-value">${location.locationId}</span></div>
                                <div><span class="meta-label">Added</span><span class="meta-value">${new Date(location.addedAt).toLocaleString()}</span></div>
                                ${business.email ? `<div><span class="meta-label">Email</span><span class="meta-value">${business.email}</span></div>` : ''}
                            </div>
                        </div>
                        <div class="location-card-stats">
                            <div class="location-stats-grid">
                                <div class="stat-item">
                                    <span class="stat-number">${stats.fieldsCount ?? 0}</span>
                                    <span class="stat-label">Fields</span>
                                </div>
                                <div class="stat-item">
                                    <span class="stat-number">${stats.valuesCount ?? 0}</span>
                                    <span class="stat-label">Values</span>
                                </div>
                                <div class="stat-item">
                                    <span class="stat-number">${stats.tagsCount ?? 0}</span>
                                    <span class="stat-label">Tags</span>
                                </div>
                                <div class="stat-item">
                                    <span class="stat-number">${stats.linksCount ?? 0}</span>
                                    <span class="stat-label">Links</span>
                                </div>
                                <div class="stat-item">
                                    <span class="stat-number">${stats.mediaCount ?? 0}</span>
                                    <span class="stat-label">Media</span>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="location-card-actions">
                        <button class="btn btn-primary" onclick="switchToLocationFromModal('${location.id}')">Switch</button>
                        <button class="btn btn-danger" onclick="deleteLocation('${location.id}')">Remove</button>
                    </div>
                </div>`;
            }).join('')}
        `;
    }
    
    modal.classList.add('show');
}

async function deleteLocation(locationId) {
    if (!confirm('Are you sure you want to remove this location? This action cannot be undone.')) return;
    
    try {
        const response = await fetch(`${API_BASE}/locations/${locationId}`, {
            method: 'DELETE'
        });
        
        const result = await response.json();
        
        if (result.success) {
            showMessage('Location removed successfully!', 'success');
            await loadLocations();
            
            if (selectedLocation && selectedLocation.id === locationId) {
                selectedLocation = null;
                showNoLocation();
            }
            
            closeModal('manageLocationsModal');
        } else {
            showMessage(`Failed to remove location: ${result.error}`, 'error');
        }
    } catch (error) {
        showMessage(`Error: ${error.message}`, 'error');
    }
}

function showCloneFieldsModal() {
    if (!selectedLocation) {
        showMessage('Please select a location first', 'error');
        return;
    }
    
    if (selectedFields.size === 0) {
        showMessage('Please select at least one field to copy', 'error');
        return;
    }
    
    const modal = document.getElementById('cloneFieldsModal');
    document.getElementById('cloneFieldsCount').textContent = selectedFields.size;
    document.getElementById('cloneFieldsSource').textContent = selectedLocation.name;
    
    const targetsDiv = document.getElementById('cloneFieldsTargets');
    targetsDiv.innerHTML = '';
    
    const availableLocations = currentLocations.filter(loc => loc.id !== selectedLocation.id);
    
    if (availableLocations.length === 0) {
        targetsDiv.innerHTML = '<div style="padding: 20px; text-align: center; color: #718096;">No other locations available. Please add more locations first.</div>';
    } else {
        availableLocations.forEach(location => {
            const checkbox = document.createElement('div');
            checkbox.style.cssText = 'padding: 10px; margin: 5px 0; border: 1px solid #e2e8f0; border-radius: 6px; cursor: pointer; transition: all 0.2s;';
            checkbox.innerHTML = `
                <label style="cursor: pointer; display: flex; align-items: center; gap: 10px;">
                    <input type="checkbox" class="clone-target-checkbox" value="${location.id}" style="width: 18px; height: 18px;">
                    <span style="font-weight: 500;">${location.name}</span>
                    <span style="color: #718096; font-size: 12px;">(${location.locationId})</span>
                </label>
            `;
            checkbox.addEventListener('mouseenter', () => checkbox.style.background = '#f7fafc');
            checkbox.addEventListener('mouseleave', () => checkbox.style.background = 'white');
            targetsDiv.appendChild(checkbox);
        });
    }
    
    document.getElementById('cloneFieldsProgress').style.display = 'none';
    document.getElementById('cloneFieldsResults').style.display = 'none';
    const btn = document.getElementById('cloneFieldsBtn');
    btn.disabled = false;
    btn.textContent = 'Start Copying';
    btn.onclick = executeCloneFields;
    
    modal.classList.add('show');
}

function showCloneValuesModal() {
    if (!selectedLocation) {
        showMessage('Please select a location first', 'error');
        return;
    }
    
    if (selectedValues.size === 0) {
        showMessage('Please select at least one value to copy', 'error');
        return;
    }
    
    const modal = document.getElementById('cloneValuesModal');
    document.getElementById('cloneValuesCount').textContent = selectedValues.size;
    document.getElementById('cloneValuesSource').textContent = selectedLocation.name;
    
    const targetsDiv = document.getElementById('cloneValuesTargets');
    targetsDiv.innerHTML = '';
    
    const availableLocations = currentLocations.filter(loc => loc.id !== selectedLocation.id);
    
    if (availableLocations.length === 0) {
        targetsDiv.innerHTML = '<div style="padding: 20px; text-align: center; color: #718096;">No other locations available. Please add more locations first.</div>';
    } else {
        availableLocations.forEach(location => {
            const checkbox = document.createElement('div');
            checkbox.style.cssText = 'padding: 10px; margin: 5px 0; border: 1px solid #e2e8f0; border-radius: 6px; cursor: pointer; transition: all 0.2s;';
            checkbox.innerHTML = `
                <label style="cursor: pointer; display: flex; align-items: center; gap: 10px;">
                    <input type="checkbox" class="clone-target-checkbox" value="${location.id}" style="width: 18px; height: 18px;">
                    <span style="font-weight: 500;">${location.name}</span>
                    <span style="color: #718096; font-size: 12px;">(${location.locationId})</span>
                </label>
            `;
            checkbox.addEventListener('mouseenter', () => checkbox.style.background = '#f7fafc');
            checkbox.addEventListener('mouseleave', () => checkbox.style.background = 'white');
            targetsDiv.appendChild(checkbox);
        });
    }
    
    document.getElementById('cloneValuesProgress').style.display = 'none';
    document.getElementById('cloneValuesResults').style.display = 'none';
    const btn = document.getElementById('cloneValuesBtn');
    btn.disabled = false;
    btn.textContent = 'Start Copying';
    btn.onclick = executeCloneValues;
    
    modal.classList.add('show');
}

async function executeCloneFields() {
    const checkboxes = document.querySelectorAll('#cloneFieldsTargets .clone-target-checkbox:checked');
    const targetLocationIds = Array.from(checkboxes).map(cb => cb.value);
    
    if (targetLocationIds.length === 0) {
        showMessage('Please select at least one destination location', 'error');
        return;
    }
    
    const progressDiv = document.getElementById('cloneFieldsProgress');
    const progressBar = document.getElementById('cloneFieldsProgressBar');
    const statusDiv = document.getElementById('cloneFieldsStatus');
    const resultsDiv = document.getElementById('cloneFieldsResults');
    const resultsContent = document.getElementById('cloneFieldsResultsContent');
    const btn = document.getElementById('cloneFieldsBtn');
    
    progressDiv.style.display = 'block';
    resultsDiv.style.display = 'none';
    btn.disabled = true;
    
    progressBar.style.width = '20%';
    statusDiv.textContent = 'Preparing to copy fields...';
    statusDiv.style.color = '#718096';
    
    try {
        const response = await fetch(`${API_BASE}/locations/${selectedLocation.id}/clone-fields`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                targetLocationIds: targetLocationIds,
                fieldIds: Array.from(selectedFields)
            })
        });
        
        progressBar.style.width = '70%';
        statusDiv.textContent = 'Processing response...';
        
        const result = await response.json();
        
        progressBar.style.width = '100%';
        
        if (result.success) {
            statusDiv.textContent = `Complete! Successfully copied ${result.results.success} field(s)${result.results.failed > 0 ? `, ${result.results.failed} failed` : ''}`;
            
            setTimeout(() => {
                progressDiv.style.display = 'none';
                resultsDiv.style.display = 'block';
                
                let resultsHTML = `
                    <div style="background: white; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
                        <div style="display: flex; gap: 20px; margin-bottom: 10px;">
                            <div style="flex: 1;">
                                <div style="font-size: 24px; font-weight: 700; color: #48bb78;">${result.results.success}</div>
                                <div style="font-size: 12px; color: #718096; text-transform: uppercase;">Successful</div>
                            </div>
                            <div id="fieldsFailedCounter" style="flex: 1; cursor: ${result.results.failed > 0 ? 'pointer' : 'default'};">
                                <div style="font-size: 24px; font-weight: 700; color: ${result.results.failed > 0 ? '#e53e3e' : '#718096'};">${result.results.failed}</div>
                                <div style="font-size: 12px; color: #718096; text-transform: uppercase;">Failed ${result.results.failed > 0 ? '(click to view)' : ''}</div>
                            </div>
                            <div style="flex: 1;">
                                <div style="font-size: 24px; font-weight: 700; color: #667eea;">${targetLocationIds.length}</div>
                                <div style="font-size: 12px; color: #718096; text-transform: uppercase;">Locations</div>
                            </div>
                        </div>
                    </div>
                `;
                
                if (result.results.locationResults) {
                    Object.values(result.results.locationResults).forEach(locResult => {
                        const hasErrors = locResult.failed > 0;
                        resultsHTML += `
                            <div style="background: white; padding: 15px; border-radius: 8px; margin-bottom: 10px; border-left: 4px solid ${hasErrors ? '#e53e3e' : '#48bb78'};">
                                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                                    <div style="flex: 1;">
                                        <div style="font-weight: 600; color: #2d3748; margin-bottom: 4px;">${locResult.locationName}</div>
                                        <div style="font-size: 13px; color: #718096;">
                                            ✓ ${locResult.success} succeeded
                                            ${locResult.failed > 0 ? `• ✗ ${locResult.failed} failed` : ''}
                                        </div>
                                    </div>
                                    <button class="btn btn-primary" onclick="switchToLocation('${locResult.locationId}')" style="padding: 8px 16px; font-size: 14px; white-space: nowrap;">
                                        Switch to Location →
                                    </button>
                                </div>
                        `;
                        
                        if (locResult.errors && locResult.errors.length > 0) {
                            resultsHTML += `
                                <div class="field-error-details" style="display: none; margin-top: 10px; padding: 10px; background: #fff5f5; border-radius: 6px; border: 1px solid #fed7d7;">
                                    <div style="font-weight: 600; color: #c53030; margin-bottom: 8px; font-size: 13px;">Error Details:</div>
                            `;
                            
                            locResult.errors.forEach(error => {
                                resultsHTML += `
                                    <div style="padding: 8px; background: white; border-radius: 4px; margin-bottom: 6px; border-left: 3px solid #e53e3e;">
                                        <div style="font-weight: 500; color: #2d3748; font-size: 13px; margin-bottom: 2px;">${error.itemName}</div>
                                        <div style="color: #c53030; font-size: 12px;">${error.error}</div>
                                    </div>
                                `;
                            });
                            
                            resultsHTML += `</div>`;
                        }
                        
                        resultsHTML += `</div>`;
                    });
                }
                
                resultsContent.innerHTML = resultsHTML;
                
                if (result.results.failed > 0) {
                    const failedCounter = document.getElementById('fieldsFailedCounter');
                    if (failedCounter) {
                        failedCounter.addEventListener('click', toggleAllFieldErrors);
                    }
                }
                
                btn.textContent = 'Close';
                btn.onclick = () => {
                    closeModal('cloneFieldsModal');
                    selectedFields.clear();
                    updateFieldsBulkActions();
                    renderFieldsSimple();
                };
            }, 500);
            
            if (result.results.success > 0) {
                showMessage(`Successfully copied ${result.results.success} field(s)`, 'success');
            }
        } else {
            throw new Error(result.error || 'Clone operation failed');
        }
    } catch (error) {
        statusDiv.textContent = `Error: ${error.message}`;
        statusDiv.style.color = '#c53030';
        btn.disabled = false;
        showMessage(`Clone failed: ${error.message}`, 'error');
    }
}

async function executeCloneValues() {
    const checkboxes = document.querySelectorAll('#cloneValuesTargets .clone-target-checkbox:checked');
    const targetLocationIds = Array.from(checkboxes).map(cb => cb.value);
    
    if (targetLocationIds.length === 0) {
        showMessage('Please select at least one destination location', 'error');
        return;
    }
    
    const progressDiv = document.getElementById('cloneValuesProgress');
    const progressBar = document.getElementById('cloneValuesProgressBar');
    const statusDiv = document.getElementById('cloneValuesStatus');
    const resultsDiv = document.getElementById('cloneValuesResults');
    const resultsContent = document.getElementById('cloneValuesResultsContent');
    const btn = document.getElementById('cloneValuesBtn');
    
    progressDiv.style.display = 'block';
    resultsDiv.style.display = 'none';
    btn.disabled = true;
    
    progressBar.style.width = '20%';
    statusDiv.textContent = 'Preparing to copy values...';
    statusDiv.style.color = '#718096';
    
    try {
        const response = await fetch(`${API_BASE}/locations/${selectedLocation.id}/clone-values`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                targetLocationIds: targetLocationIds,
                valueIds: Array.from(selectedValues)
            })
        });
        
        progressBar.style.width = '70%';
        statusDiv.textContent = 'Processing response...';
        
        const result = await response.json();
        
        progressBar.style.width = '100%';
        
        if (result.success) {
            statusDiv.textContent = `Complete! Successfully copied ${result.results.success} value(s)${result.results.failed > 0 ? `, ${result.results.failed} failed` : ''}`;
            
            setTimeout(() => {
                progressDiv.style.display = 'none';
                resultsDiv.style.display = 'block';
                
                let resultsHTML = `
                    <div style="background: white; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
                        <div style="display: flex; gap: 20px; margin-bottom: 10px;">
                            <div style="flex: 1;">
                                <div style="font-size: 24px; font-weight: 700; color: #48bb78;">${result.results.success}</div>
                                <div style="font-size: 12px; color: #718096; text-transform: uppercase;">Successful</div>
                            </div>
                            <div id="valuesFailedCounter" style="flex: 1; cursor: ${result.results.failed > 0 ? 'pointer' : 'default'};">
                                <div style="font-size: 24px; font-weight: 700; color: ${result.results.failed > 0 ? '#e53e3e' : '#718096'};">${result.results.failed}</div>
                                <div style="font-size: 12px; color: #718096; text-transform: uppercase;">Failed ${result.results.failed > 0 ? '(click to view)' : ''}</div>
                            </div>
                            <div style="flex: 1;">
                                <div style="font-size: 24px; font-weight: 700; color: #667eea;">${targetLocationIds.length}</div>
                                <div style="font-size: 12px; color: #718096; text-transform: uppercase;">Locations</div>
                            </div>
                        </div>
                    </div>
                `;
                
                if (result.results.locationResults) {
                    Object.values(result.results.locationResults).forEach(locResult => {
                        const hasErrors = locResult.failed > 0;
                        resultsHTML += `
                            <div style="background: white; padding: 15px; border-radius: 8px; margin-bottom: 10px; border-left: 4px solid ${hasErrors ? '#e53e3e' : '#48bb78'};">
                                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                                    <div style="flex: 1;">
                                        <div style="font-weight: 600; color: #2d3748; margin-bottom: 4px;">${locResult.locationName}</div>
                                        <div style="font-size: 13px; color: #718096;">
                                            ✓ ${locResult.success} succeeded
                                            ${locResult.failed > 0 ? `• ✗ ${locResult.failed} failed` : ''}
                                        </div>
                                    </div>
                                    <button class="btn btn-primary" onclick="switchToLocation('${locResult.locationId}')" style="padding: 8px 16px; font-size: 14px; white-space: nowrap;">
                                        Switch to Location →
                                    </button>
                                </div>
                        `;
                        
                        if (locResult.errors && locResult.errors.length > 0) {
                            resultsHTML += `
                                <div class="value-error-details" style="display: none; margin-top: 10px; padding: 10px; background: #fff5f5; border-radius: 6px; border: 1px solid #fed7d7;">
                                    <div style="font-weight: 600; color: #c53030; margin-bottom: 8px; font-size: 13px;">Error Details:</div>
                            `;
                            
                            locResult.errors.forEach(error => {
                                resultsHTML += `
                                    <div style="padding: 8px; background: white; border-radius: 4px; margin-bottom: 6px; border-left: 3px solid #e53e3e;">
                                        <div style="font-weight: 500; color: #2d3748; font-size: 13px; margin-bottom: 2px;">${error.itemName}</div>
                                        <div style="color: #c53030; font-size: 12px;">${error.error}</div>
                                    </div>
                                `;
                            });
                            
                            resultsHTML += `</div>`;
                        }
                        
                        resultsHTML += `</div>`;
                    });
                }
                
                resultsContent.innerHTML = resultsHTML;
                
                if (result.results.failed > 0) {
                    const failedCounter = document.getElementById('valuesFailedCounter');
                    if (failedCounter) {
                        failedCounter.addEventListener('click', toggleAllValueErrors);
                    }
                }
                
                btn.textContent = 'Close';
                btn.onclick = () => {
                    closeModal('cloneValuesModal');
                    selectedValues.clear();
                    updateValuesBulkActions();
                    renderValuesSimple();
                };
            }, 500);
            
            if (result.results.success > 0) {
                showMessage(`Successfully copied ${result.results.success} value(s)`, 'success');
            }
        } else {
            throw new Error(result.error || 'Clone operation failed');
        }
    } catch (error) {
        statusDiv.textContent = `Error: ${error.message}`;
        statusDiv.style.color = '#c53030';
        btn.disabled = false;
        showMessage(`Clone failed: ${error.message}`, 'error');
    }
}

function closeModal(modalId) {
    document.getElementById(modalId).classList.remove('show');
}

function showMessage(message, type) {
    const messageEl = document.createElement('div');
    messageEl.className = type === 'error' ? 'error-message' : 'success-message';
    messageEl.textContent = message;
    messageEl.style.position = 'fixed';
    messageEl.style.top = '20px';
    messageEl.style.right = '20px';
    messageEl.style.zIndex = '2000';
    messageEl.style.maxWidth = '400px';
    
    document.body.appendChild(messageEl);
    
    setTimeout(() => messageEl.remove(), 5000);
}
// Added the FieldKey to the table data
function copyToClipboard(text, event) {
    event.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
        const button = event.target;
        const originalText = button.textContent;
        button.textContent = '✓ Copied!';
        button.style.background = '#48bb78';
        setTimeout(() => {
            button.textContent = originalText;
            button.style.background = '';
        }, 2000);
    }).catch(err => {
        showMessage('Failed to copy to clipboard', 'error');
    });
}

function syncCustomValues() {
    if (!selectedLocation) {
        showMessage('Please select a location first', 'error');
        return;
    }
    
    showMessage('Syncing values...', 'success');
    
    fetch(`${API_BASE}/locations/${selectedLocation.id}/sync-values`, {
        method: 'POST'
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            showMessage('Values synced successfully!', 'success');
            loadCustomValues();
        } else {
            showMessage(`Sync failed: ${data.error}`, 'error');
        }
    })
    .catch(error => {
        showMessage(`Error: ${error.message}`, 'error');
    });
}

function switchToLocation(locationId) {
    document.querySelectorAll('.modal').forEach(modal => {
        modal.classList.remove('show');
    });
    
    selectLocation(locationId);
    
    const dropdown = document.getElementById('locationDropdown');
    dropdown.value = locationId;
    
    showMessage('Switched to destination location', 'success');
}

function toggleAllFieldErrors() {
    const errorDivs = document.querySelectorAll('.field-error-details');
    const allVisible = Array.from(errorDivs).every(div => div.style.display !== 'none');
    
    errorDivs.forEach(div => {
        div.style.display = allVisible ? 'none' : 'block';
    });
}

function toggleAllValueErrors() {
    const errorDivs = document.querySelectorAll('.value-error-details');
    const allVisible = Array.from(errorDivs).every(div => div.style.display !== 'none');
    
    errorDivs.forEach(div => {
        div.style.display = allVisible ? 'none' : 'block';
    });
}

window.onclick = function(event) {
    if (event.target.classList.contains('modal')) {
        event.target.classList.remove('show');
    }
}

// Subscription Management
let currentSubscription = null;

async function loadSubscription() {
    try {
        const response = await fetch(`${API_BASE}/subscription`);
        const data = await response.json();
        
        if (data.success) {
            currentSubscription = data.subscription;
            updateSubscriptionUI();
        }
    } catch (error) {
        console.error('Failed to load subscription:', error);
    }
}

function updateSubscriptionUI() {
    if (!currentSubscription) return;
    
    const subBar = document.getElementById('subscription-bar');
    const planBadge = document.getElementById('planBadge');
    const locationUsage = document.getElementById('locationUsage');
    const upgradeBtn = document.getElementById('upgradeBtn');
    const manageBillingBtn = document.getElementById('manageBillingBtn');
    
    subBar.style.display = 'flex';
    
    const planNames = {
        free: 'Free Plan',
        starter: 'Starter Plan',
        growth: 'Growth Plan',
        scale: 'Scale Plan',
        enterprise: 'Enterprise Plan'
    };
    
    planBadge.textContent = planNames[currentSubscription.plan_type] || 'Free Plan';
    planBadge.className = `plan-badge ${currentSubscription.plan_type}`;
    
    const locationCount = currentLocations.length;
    locationUsage.textContent = `${locationCount} / ${currentSubscription.max_locations} locations`;
    
    if (currentSubscription.plan_type === 'free') {
        upgradeBtn.style.display = 'inline-block';
        manageBillingBtn.style.display = 'none';
    } else {
        upgradeBtn.textContent = 'Upgrade Plan';
        upgradeBtn.style.display = 'inline-block';
        manageBillingBtn.style.display = 'inline-block';
    }
}

function showPricingModal() {
    document.getElementById('pricingModal').classList.add('show');
}

async function selectPlan(planType) {
    try {
        const response = await fetch(`${API_BASE}/create-checkout-session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ planType })
        });
        
        const data = await response.json();
        
        if (data.success) {
            window.location.href = data.url;
        } else {
            showMessage('Failed to create checkout session', 'error');
        }
    } catch (error) {
        showMessage(`Error: ${error.message}`, 'error');
    }
}

async function manageBilling() {
    try {
        const response = await fetch(`${API_BASE}/create-portal-session`, {
            method: 'POST'
        });
        
        const data = await response.json();
        
        if (data.success) {
            window.location.href = data.url;
        } else {
            showMessage('Failed to open billing portal', 'error');
        }
    } catch (error) {
        showMessage(`Error: ${error.message}`, 'error');
    }
}

function showPricingModalFromLimit() {
    closeModal('upgradeLimitModal');
    showPricingModal();
}

// Modify the existing loadLocations function - ADD THIS AT THE END
async function loadLocationsOriginal() {
    // ... existing code stays the same
}

// REPLACE the loadLocations function with this version:
async function loadLocations() {
    try {
        const response = await fetch(`${API_BASE}/locations`);
        const data = await response.json();
        
        if (data.success) {
            currentLocations = data.locations;
            updateLocationDropdown();
            loadSubscription(); // ADD THIS LINE
            
            if (currentLocations.length > 0 && !selectedLocation) {
                selectLocation(currentLocations[0].id);
            }
        }
    } catch (error) {
        console.error('Failed to load locations:', error);
    }
}

// UPDATE the setupFormHandlers addLocationForm handler - FIND this section and REPLACE with:
document.getElementById('addLocationForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData);
    
    try {
        const testResponse = await fetch(`${API_BASE}/test-location`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                locationId: data.locationId,
                token: data.token
            })
        });
        
        const testResult = await testResponse.json();
        
        if (!testResult.success) {
            showMessage(`Connection failed: ${testResult.error}`, 'error');
            return;
        }
        
        const response = await fetch(`${API_BASE}/locations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        
        const result = await response.json();
        
        if (result.success) {
            showMessage('Location added successfully!', 'success');
            e.target.reset();
            closeModal('addLocationModal');
            await loadLocations();
            selectLocation(result.location.id);
        } else if (result.needsUpgrade) {
            // Show upgrade modal
            document.getElementById('currentPlanName').textContent = result.planType || 'Free';
            document.getElementById('currentUsage').textContent = `${result.current} / ${result.max}`;
            closeModal('addLocationModal');
            document.getElementById('upgradeLimitModal').classList.add('show');
        } else {
            showMessage(`Failed to add location: ${result.error}`, 'error');
        }
    } catch (error) {
        showMessage(`Error: ${error.message}`, 'error');
    }
});

// Comparison Feature
let comparisonData = null;
let currentCompareType = 'values';
let currentCompView = 'all';

function showCompareModal(type) {
    if (currentLocations.length < 2) {
        showMessage('You need at least 2 locations to compare', 'error');
        return;
    }
    
    currentCompareType = type;
    
    const selectA = document.getElementById('compareLocationA');
    const selectB = document.getElementById('compareLocationB');
    
    selectA.innerHTML = currentLocations.map(loc => 
        `<option value="${loc.id}">${loc.name}</option>`
    ).join('');
    
    selectB.innerHTML = currentLocations.map(loc => 
        `<option value="${loc.id}">${loc.name}</option>`
    ).join('');
    
    if (currentLocations.length >= 2) {
        selectB.selectedIndex = 1;
    }
    
    // Set active tab
    document.querySelectorAll('.comparison-tab').forEach(tab => {
        tab.classList.remove('active');
        if (tab.dataset.type === type) {
            tab.classList.add('active');
        }
    });
    
    document.getElementById('comparisonResults').style.display = 'none';
    document.getElementById('comparisonModal').classList.add('show');
}

// Tab switching for comparison type
document.addEventListener('click', (e) => {
    if (e.target.classList.contains('comparison-tab')) {
        document.querySelectorAll('.comparison-tab').forEach(t => t.classList.remove('active'));
        e.target.classList.add('active');
        currentCompareType = e.target.dataset.type;
    }
});

async function runComparison() {
    const locationIdA = document.getElementById('compareLocationA').value;
    const locationIdB = document.getElementById('compareLocationB').value;
    
    if (locationIdA === locationIdB) {
        showMessage('Please select two different locations', 'error');
        return;
    }
    
    const btn = document.getElementById('runComparisonBtn');
    btn.disabled = true;
    btn.textContent = 'Comparing...';
    
    try {
        const response = await fetch(`${API_BASE}/locations/compare`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                locationIdA,
                locationIdB,
                compareType: currentCompareType
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            comparisonData = data.comparison;
            displayComparisonResults();
            document.getElementById('comparisonResults').style.display = 'block';
        } else {
            showMessage(`Comparison failed: ${data.error}`, 'error');
        }
    } catch (error) {
        showMessage(`Error: ${error.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Run Comparison';
    }
}

function displayComparisonResults() {
    if (!comparisonData) return;
    
    const statsDiv = document.querySelector('.comparison-stats');
    const contentDiv = document.getElementById('comparisonContent');
    
    // Determine what to display
    let dataType = 'values';
    if (currentCompareType === 'fields') {
        dataType = 'fields';
    } else if (currentCompareType === 'links') {
        dataType = 'triggerLinks';
    } else if (currentCompareType === 'tags') {
        dataType = 'tags';
    }
    const data = comparisonData[dataType];
    
    if (!data) {
        contentDiv.innerHTML = '<p>No comparison data available</p>';
        return;
    }
    
    // Display stats
    statsDiv.innerHTML = `
        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-value">${data.stats.onlyInA}</div>
                <div class="stat-label">Only in ${comparisonData.locationA.name}</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${data.stats.matches}</div>
                <div class="stat-label">Exact Matches</div>
            </div>
        <div class="stat-card">
                <div class="stat-value">${data.stats.netVariance || 0}</div>
                <div class="stat-label">Net Difference</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${data.stats.onlyInB}</div>
                <div class="stat-label">Only in ${comparisonData.locationB.name}</div>
            </div>
        </div>
    `;
    
    // Display items based on view filter
    let itemsToShow = [];
    
    if (currentCompView === 'all' || currentCompView === 'differences') {
        itemsToShow = [...data.onlyInA.map(i => ({...i, category: 'onlyInA'})),
                       ...data.onlyInB.map(i => ({...i, category: 'onlyInB'})),
                       ...data.variances.map(i => ({...i, category: 'variance'}))];
    }
    
    if (currentCompView === 'all' || currentCompView === 'matches') {
        itemsToShow = [...itemsToShow, ...data.matches.map(i => ({...i, category: 'match'}))];
    }
    
    if (itemsToShow.length === 0) {
        contentDiv.innerHTML = '<div class="empty-state">No items match the current filter</div>';
        return;
    }
    
    // Render comparison table
    if (dataType === 'values') {
        contentDiv.innerHTML = `
            <table class="comparison-table">
                <thead>
                    <tr>
                        <th>Field Key</th>
                        <th>Name (A / B)</th>
                        <th>Value (A)</th>
                        <th>Value (B)</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody>
                    ${itemsToShow.map(item => {
    // Escape HTML function
    const escapeHtml = (text) => {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    };
    
    if (item.category === 'onlyInA') {
        return `
            <tr class="only-in-a">
                <td><code>${item.fieldKey ? escapeHtml(item.fieldKey) : '-'}</code></td>
                <td>${escapeHtml(item.name)}</td>
                <td>${escapeHtml(item.value)}</td>
                <td class="empty-cell">-</td>
                <td><span class="status-badge only-a">Only in A</span></td>
            </tr>
        `;
    } else if (item.category === 'onlyInB') {
        return `
            <tr class="only-in-b">
                <td><code>${item.fieldKey ? escapeHtml(item.fieldKey) : '-'}</code></td>
                <td>${escapeHtml(item.name)}</td>
                <td class="empty-cell">-</td>
                <td>${escapeHtml(item.value)}</td>
                <td><span class="status-badge only-b">Only in B</span></td>
            </tr>
        `;
    } else if (item.category === 'variance') {
        return `
            <tr class="variance-item">
                <td><code>${item.fieldKey ? escapeHtml(item.fieldKey) : '-'}</code></td>
                <td>${escapeHtml(item.nameA)}${item.nameA !== item.nameB ? ` / <span class="diff">${escapeHtml(item.nameB)}</span>` : ''}</td>
                <td>${escapeHtml(item.valueA)}</td>
                <td>${escapeHtml(item.valueB)}</td>
                <td><span class="status-badge variance">Different</span></td>
            </tr>
        `;
    } else {
        return `
            <tr class="match-item">
                <td><code>${item.fieldKey ? escapeHtml(item.fieldKey) : '-'}</code></td>
                <td>${escapeHtml(item.nameA)}</td>
                <td>${escapeHtml(item.valueA)}</td>
                <td>${escapeHtml(item.valueB)}</td>
                <td><span class="status-badge match">Match</span></td>
            </tr>
        `;
    }
}).join('')}
                </tbody>
            </table>
        `;
    }

    else if (dataType === 'fields') {
    contentDiv.innerHTML = `
        <table class="comparison-table">
            <thead>
                <tr>
                    <th>Field Key</th>
                    <th>Name (A / B)</th>
                    <th>Data Type (A)</th>
                    <th>Data Type (B)</th>
                    <th>Model (A / B)</th>
                    <th>Status</th>
                </tr>
            </thead>
            <tbody>
                ${itemsToShow.map(item => {
                    const escapeHtml = (text) => {
                        const div = document.createElement('div');
                        div.textContent = text;
                        return div.innerHTML;
                    };
                    
                    if (item.category === 'onlyInA') {
                        return `
                            <tr class="only-in-a">
                                <td><code>${item.fieldKey ? escapeHtml(item.fieldKey) : '-'}</code></td>
                                <td>${escapeHtml(item.name)}</td>
                                <td>${escapeHtml(item.dataType)}</td>
                                <td class="empty-cell">-</td>
                                <td>${escapeHtml(item.model)}</td>
                                <td><span class="status-badge only-a">Only in A</span></td>
                            </tr>
                        `;
                    } else if (item.category === 'onlyInB') {
                        return `
                            <tr class="only-in-b">
                                <td><code>${item.fieldKey ? escapeHtml(item.fieldKey) : '-'}</code></td>
                                <td>${escapeHtml(item.name)}</td>
                                <td class="empty-cell">-</td>
                                <td>${escapeHtml(item.dataType)}</td>
                                <td>${escapeHtml(item.model)}</td>
                                <td><span class="status-badge only-b">Only in B</span></td>
                            </tr>
                        `;
                    } else if (item.category === 'variance') {
                        return `
                            <tr class="variance-item">
                                <td><code>${item.fieldKey ? escapeHtml(item.fieldKey) : '-'}</code></td>
                                <td>${escapeHtml(item.nameA)}${item.nameA !== item.nameB ? ` / <span class="diff">${escapeHtml(item.nameB)}</span>` : ''}</td>
                                <td>${escapeHtml(item.dataTypeA)}</td>
                                <td>${escapeHtml(item.dataTypeB)}</td>
                                <td>${escapeHtml(item.modelA)}${item.modelA !== item.modelB ? ` / <span class="diff">${escapeHtml(item.modelB)}</span>` : ''}</td>
                                <td><span class="status-badge variance">Different</span></td>
                            </tr>
                        `;
                    } else {
                        return `
                            <tr class="match-item">
                                <td><code>${item.fieldKey ? escapeHtml(item.fieldKey) : '-'}</code></td>
                                <td>${escapeHtml(item.nameA)}</td>
                                <td>${escapeHtml(item.dataTypeA)}</td>
                                <td>${escapeHtml(item.dataTypeB)}</td>
                                <td>${escapeHtml(item.modelA)}</td>
                                <td><span class="status-badge match">Match</span></td>
                            </tr>
                        `;
                    }
                }).join('')}
            </tbody>
        </table>
    `;
            }
    else if (dataType === 'triggerLinks') {
        contentDiv.innerHTML = `
        <table class="comparison-table">
            <thead>
                <tr>
                    <th>Name (A / B)</th>
                    <th>Redirect URL (A)</th>
                    <th>Redirect URL (B)</th>
                    <th>Link (A / B)</th>
                    <th>Status</th>
                </tr>
            </thead>
            <tbody>
                ${itemsToShow.map(item => {
                    const escapeHtml = (text) => {
                        const div = document.createElement('div');
                        div.textContent = text || '';
                        return div.innerHTML;
                    };
                    
                    if (item.category === 'onlyInA') {
                        return `
                            <tr class="only-in-a">
                                <td>${escapeHtml(item.name)}</td>
                                <td>${escapeHtml(item.redirectTo)}</td>
                                <td class="empty-cell">-</td>
                                <td>${item.shortUrl ? `<code>${escapeHtml(item.shortUrl)}</code>` : '<span style="color:#cbd5e0;">-</span>'}</td>
                                <td><span class="status-badge only-a">Only in A</span></td>
                            </tr>
                        `;
                    } else if (item.category === 'onlyInB') {
                        return `
                            <tr class="only-in-b">
                                <td>${escapeHtml(item.name)}</td>
                                <td class="empty-cell">-</td>
                                <td>${escapeHtml(item.redirectTo)}</td>
                                <td>${item.shortUrl ? `<code>${escapeHtml(item.shortUrl)}</code>` : '<span style="color:#cbd5e0;">-</span>'}</td>
                                <td><span class="status-badge only-b">Only in B</span></td>
                            </tr>
                        `;
                    } else if (item.category === 'variance') {
                        return `
                            <tr class="variance-item">
                                <td>${escapeHtml(item.nameA)}${item.nameA !== item.nameB ? ` / <span class="diff">${escapeHtml(item.nameB)}</span>` : ''}</td>
                                <td>${escapeHtml(item.redirectA)}</td>
                                <td>${escapeHtml(item.redirectB)}</td>
                                <td>
                                    ${item.urlA ? `<code>${escapeHtml(item.urlA)}</code>` : '<span style="color:#cbd5e0;">-</span>'}
                                    ${item.urlA !== item.urlB ? ` / <span class="diff">${item.urlB ? escapeHtml(item.urlB) : '-'}</span>` : ''}
                                </td>
                                <td><span class="status-badge variance">Different</span></td>
                            </tr>
                        `;
                    } else {
                        return `
                            <tr class="match-item">
                                <td>${escapeHtml(item.nameA)}</td>
                                <td>${escapeHtml(item.redirectA)}</td>
                                <td>${escapeHtml(item.redirectB)}</td>
                                <td>${item.urlA ? `<code>${escapeHtml(item.urlA)}</code>` : '<span style="color:#cbd5e0;">-</span>'}</td>
                                <td><span class="status-badge match">Match</span></td>
                            </tr>
                        `;
                    }
                }).join('')}
            </tbody>
        </table>
    `;
    }
    else if (dataType === 'tags') {
        contentDiv.innerHTML = `
        <table class="comparison-table">
            <thead>
                <tr>
                    <th>Name (A)</th>
                    <th>Name (B)</th>
                    <th>Status</th>
                </tr>
            </thead>
            <tbody>
                ${itemsToShow.map(item => {
                    const escapeHtml = (text) => {
                        const div = document.createElement('div');
                        div.textContent = text || '';
                        return div.innerHTML;
                    };
                    if (item.category === 'onlyInA') {
                        return `
                            <tr class="only-in-a">
                                <td>${escapeHtml(item.name)}</td>
                                <td class="empty-cell">-</td>
                                <td><span class="status-badge only-a">Only in A</span></td>
                            </tr>
                        `;
                    } else if (item.category === 'onlyInB') {
                        return `
                            <tr class="only-in-b">
                                <td class="empty-cell">-</td>
                                <td>${escapeHtml(item.name)}</td>
                                <td><span class="status-badge only-b">Only in B</span></td>
                            </tr>
                        `;
                    } else if (item.category === 'variance') {
                        return `
                            <tr class="variance-item">
                                <td>${escapeHtml(item.nameA)}</td>
                                <td>${escapeHtml(item.nameB)}</td>
                                <td><span class="status-badge variance">Different</span></td>
                            </tr>
                        `;
                    } else {
                        return `
                            <tr class="match-item">
                                <td>${escapeHtml(item.nameA)}</td>
                                <td>${escapeHtml(item.nameB)}</td>
                                <td><span class="status-badge match">Match</span></td>
                            </tr>
                        `;
                    }
                }).join('')}
            </tbody>
        </table>
    `;
    }
        }




function switchCompView(view) {
    currentCompView = view;
    document.querySelectorAll('.comp-view-tab').forEach(t => t.classList.remove('active'));
    event.target.classList.add('active');
    displayComparisonResults();
}

function exportComparison() {
    if (!comparisonData) return;
    
    let dataType = 'values';
    if (currentCompareType === 'fields') {
        dataType = 'fields';
    } else if (currentCompareType === 'links') {
        dataType = 'triggerLinks';
    } else if (currentCompareType === 'tags') {
        dataType = 'tags';
    }
    
    const data = comparisonData[dataType];
    if (!data) return;
    
    const rows = [];
    
    if (dataType === 'values') {
        rows.push(['Status', 'Field Key', 'Name (A)', 'Name (B)', 'Value (A)', 'Value (B)']);
        
        data.onlyInA.forEach(item => {
            rows.push(['Only in A', item.fieldKey || '', item.name, '', item.value, '']);
        });
        data.onlyInB.forEach(item => {
            rows.push(['Only in B', item.fieldKey || '', '', item.name, '', item.value]);
        });
        data.matches.forEach(item => {
            rows.push(['Match', item.fieldKey || '', item.nameA, item.nameB, item.valueA, item.valueB]);
        });
        data.variances.forEach(item => {
            rows.push(['Different', item.fieldKey || '', item.nameA, item.nameB, item.valueA, item.valueB]);
        });
    } else if (dataType === 'fields') {
        rows.push(['Status', 'Name', 'Data Type (A)', 'Data Type (B)', 'Model (A)', 'Model (B)', 'Placeholder (A)', 'Placeholder (B)']);
        
        data.onlyInA.forEach(item => {
            rows.push(['Only in A', item.name, item.dataType, '', item.model, '', item.placeholder || '', '']);
        });
        data.onlyInB.forEach(item => {
            rows.push(['Only in B', item.name, '', item.dataType, '', item.model, '', item.placeholder || '']);
        });
        data.matches.forEach(item => {
            rows.push(['Match', item.name, item.dataTypeA, item.dataTypeB, item.modelA, item.modelB, item.placeholderA || '', item.placeholderB || '']);
        });
        data.variances.forEach(item => {
            rows.push(['Different', item.name, item.dataTypeA, item.dataTypeB, item.modelA, item.modelB, item.placeholderA || '', item.placeholderB || '']);
        });
    } else if (dataType === 'triggerLinks') {
        rows.push(['Status', 'Name (A)', 'Name (B)', 'Redirect (A)', 'Redirect (B)', 'URL (A)', 'URL (B)']);
        
        data.onlyInA.forEach(item => {
            rows.push(['Only in A', item.name, '', item.redirectTo, '', item.shortUrl || '', '']);
        });
        data.onlyInB.forEach(item => {
            rows.push(['Only in B', '', item.name, '', item.redirectTo, '', item.shortUrl || '']);
        });
        data.matches.forEach(item => {
            rows.push(['Match', item.nameA, item.nameB, item.redirectA, item.redirectB, item.urlA || '', item.urlB || '']);
        });
        data.variances.forEach(item => {
            rows.push(['Different', item.nameA, item.nameB, item.redirectA, item.redirectB, item.urlA || '', item.urlB || '']);
        });
    } else if (dataType === 'tags') {
        rows.push(['Status', 'Name (A)', 'Name (B)']);

        data.onlyInA.forEach(item => {
            rows.push(['Only in A', item.name, '']);
        });
        data.onlyInB.forEach(item => {
            rows.push(['Only in B', '', item.name]);
        });
        data.matches.forEach(item => {
            rows.push(['Match', item.nameA, item.nameB]);
        });
        data.variances.forEach(item => {
            rows.push(['Different', item.nameA, item.nameB]);
        });
    }
    
    const csvContent = rows.map(row => 
        row.map(cell => {
            const str = String(cell || '');
            if (str.includes(',') || str.includes('"') || str.includes('\n')) {
                return `"${str.replace(/"/g, '""')}"`;
            }
            return str;
        }).join(',')
    ).join('\n');
    
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `comparison-${comparisonData.locationA.name}-vs-${comparisonData.locationB.name}-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

function showSyncOptions() {
    showMessage('Sync functionality coming soon!', 'success');
}

function showImportFieldsModal() {
    if (!selectedLocation) {
        showMessage('Please select a location first', 'error');
        return;
    }
    document.getElementById('importFieldsInstructionsModal').classList.add('show');
}

function showImportValuesModal() {
    if (!selectedLocation) {
        showMessage('Please select a location first', 'error');
        return;
    }
    document.getElementById('importValuesInstructionsModal').classList.add('show');
}

function downloadFieldsTemplate() {
    const csv = 'Name,DataType,Model,Options\nEmail Address,TEXT,contact,\nPhone Number,PHONE,contact,\nLead Source,DROPDOWN,contact,Website|Referral|Social Media|Cold Call\nPriority Level,RADIO,opportunity,Low|Medium|High|Urgent\nWebsite,TEXT,contact,';
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'custom-fields-template.csv';
    a.click();
    URL.revokeObjectURL(url);
}

function downloadValuesTemplate() {
    const csv = 'Name,Value\ncompany_logo,https://example.com/logo.png\nwelcome_text,Welcome to our platform!\nsupport_email,support@example.com\ndefault_color,#667eea\nmax_users,100';
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'custom-values-template.csv';
    a.click();
    URL.revokeObjectURL(url);
}
let currentAudit = null;

async function startFieldAudit() {
    if (!selectedLocation) {
        showMessage('Please select a location first', 'error');
        return;
    }
    
    document.getElementById('fieldAuditModal').classList.add('show');
    document.getElementById('auditProgress').style.display = 'block';
    document.getElementById('auditResults').style.display = 'none';
    
    try {
        const response = await fetch(`${API_BASE}/locations/${selectedLocation.id}/audit-fields`, {
            method: 'POST'
        });
        
        const data = await response.json();
        
        if (data.success) {
            currentAudit = data.audit;
            displayAuditResults();
        } else {
            showMessage(`Audit failed: ${data.error}`, 'error');
            closeModal('fieldAuditModal');
        }
    } catch (error) {
        showMessage(`Error: ${error.message}`, 'error');
        closeModal('fieldAuditModal');
    }
}

function displayAuditResults() {
    if (!currentAudit) return;
    
    document.getElementById('auditProgress').style.display = 'none';
    document.getElementById('auditResults').style.display = 'block';
    
    const summaryDiv = document.querySelector('.audit-summary');
    const chartsDiv = document.querySelector('.audit-charts');
    const unusedDiv = document.querySelector('.audit-unused-section');
    
    // Sampling warning banner
    let samplingBanner = '';
    if (currentAudit.samplingUsed) {
        const samplingPercentage = ((currentAudit.recordsScanned / currentAudit.totalRecords) * 100).toFixed(1);
        samplingBanner = `
            <div style="background: #fef3c7; border: 2px solid #f59e0b; border-radius: 12px; padding: 20px; margin-bottom: 30px;">
                <div style="display: flex; align-items: start; gap: 15px;">
                    <div style="font-size: 32px;">⚠️</div>
                    <div style="flex: 1;">
                        <h3 style="margin: 0 0 10px 0; color: #92400e;">Statistical Sampling Used</h3>
                        <p style="margin: 0 0 10px 0; color: #78350f; font-size: 15px; line-height: 1.6;">
                            Due to the large dataset size, this audit analyzed a <strong>sample of ${currentAudit.recordsScanned.toLocaleString()} out of ${currentAudit.totalRecords.toLocaleString()} total records (${samplingPercentage}%)</strong>.
                        </p>
                        <p style="margin: 0; color: #78350f; font-size: 14px;">
                            Results are statistically representative. Fields shown as "unused" have no data in any of the ${currentAudit.recordsScanned.toLocaleString()} records scanned.
                        </p>
                    </div>
                </div>
            </div>
        `;
    } else {
        samplingBanner = `
            <div style="background: #d1fae5; border: 2px solid #10b981; border-radius: 12px; padding: 15px; margin-bottom: 30px;">
                <div style="display: flex; align-items: center; gap: 10px;">
                    <div style="font-size: 24px;">✓</div>
                    <p style="margin: 0; color: #065f46; font-weight: 600;">
                        Full Scan: All ${currentAudit.recordsScanned.toLocaleString()} records analyzed
                    </p>
                </div>
            </div>
        `;
    }
    
    // Summary stats
    summaryDiv.innerHTML = samplingBanner + `
        <div class="stats-grid" style="margin-bottom: 30px;">
            <div class="stat-card">
                <div class="stat-value">${currentAudit.totalFields}</div>
                <div class="stat-label">Total Fields</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" style="color: #48bb78;">${currentAudit.usedFields.length}</div>
                <div class="stat-label">Used Fields</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" style="color: #e53e3e;">${currentAudit.unusedFields.length}</div>
                <div class="stat-label">Unused Fields</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${currentAudit.recordsScanned.toLocaleString()}</div>
                <div class="stat-label">Records Scanned</div>
            </div>
        </div>
    `;
    
    // Rest of the function stays the same...
    const usedCount = currentAudit.usedFields.length;
    const unusedCount = currentAudit.unusedFields.length;
    const usedPercentage = ((usedCount / currentAudit.totalFields) * 100).toFixed(1);
    
    chartsDiv.innerHTML = `
        <h3 style="margin-bottom: 20px;">Usage Overview</h3>
        <div style="display: flex; gap: 30px; margin-bottom: 30px;">
            <div style="flex: 1;">
                <svg viewBox="0 0 200 200" style="max-width: 300px; margin: 0 auto; display: block;">
                    <circle cx="100" cy="100" r="80" fill="none" stroke="#e2e8f0" stroke-width="40"/>
                    <circle cx="100" cy="100" r="80" fill="none" stroke="#48bb78" stroke-width="40"
                            stroke-dasharray="${usedPercentage * 5.024} 502.4" 
                            transform="rotate(-90 100 100)"/>
                    <text x="100" y="100" text-anchor="middle" dy=".3em" font-size="24" font-weight="bold" fill="#2d3748">
                        ${usedPercentage}%
                    </text>
                    <text x="100" y="125" text-anchor="middle" font-size="12" fill="#718096">
                        Used
                    </text>
                </svg>
            </div>
            <div style="flex: 1; display: flex; flex-direction: column; justify-content: center;">
                <div style="margin-bottom: 15px;">
                    <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 5px;">
                        <div style="width: 20px; height: 20px; background: #48bb78; border-radius: 4px;"></div>
                        <span style="font-weight: 600;">Used Fields: ${usedCount}</span>
                    </div>
                    <p style="color: #718096; font-size: 14px; margin-left: 30px;">Have data in at least one record</p>
                </div>
                <div>
                    <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 5px;">
                        <div style="width: 20px; height: 20px; background: #e2e8f0; border-radius: 4px;"></div>
                        <span style="font-weight: 600;">Unused Fields: ${unusedCount}</span>
                    </div>
                    <p style="color: #718096; font-size: 14px; margin-left: 30px;">Never populated with data</p>
                </div>
            </div>
        </div>
    `;
    
    // Unused fields section (same as before)
    if (unusedCount > 0) {
        unusedDiv.innerHTML = `
            <h3 style="margin-bottom: 20px; color: #e53e3e;">Unused Fields (${unusedCount})</h3>
            <div style="background: #fff5f5; padding: 15px; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid #e53e3e;">
                <strong>Warning:</strong> These fields have never been used${currentAudit.samplingUsed ? ' in the scanned sample' : ''}. Consider deleting them to keep your location clean.
            </div>
            <div style="margin-bottom: 15px;">
                <button class="btn btn-secondary" onclick="selectAllUnusedFields()">Select All</button>
                <button class="btn btn-secondary" onclick="deselectAllUnusedFields()">Deselect All</button>
                <button class="btn btn-danger" onclick="bulkDeleteUnusedFields()">Delete Selected</button>
            </div>
            <div style="max-height: 400px; overflow-y: auto;">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th style="width: 40px;">
                                <input type="checkbox" id="selectAllUnused" onchange="toggleAllUnused(this)">
                            </th>
                            <th>Field Name</th>
                            <th>Field Key</th>
                            <th>Type</th>
                            <th>Model</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${currentAudit.unusedFields.map(field => `
                            <tr>
                                <td>
                                    <input type="checkbox" class="unused-field-checkbox" data-field-id="${field.id}">
                                </td>
                                <td>${field.name}</td>
                                <td><code style="font-size: 11px;">${field.fieldKey || '-'}</code></td>
                                <td>${field.dataType}</td>
                                <td>${field.model}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
    } else {
        unusedDiv.innerHTML = `
            <div style="text-align: center; padding: 40px; background: #f0fdf4; border-radius: 12px;">
                <div style="font-size: 48px; margin-bottom: 10px;">✓</div>
                <h3 style="color: #22543d;">All Fields Are Being Used!</h3>
                <p style="color: #718096;">Every custom field has data in at least one record${currentAudit.samplingUsed ? ' in the sample' : ''}.</p>
            </div>
        `;
    }
}

function toggleAllUnused(checkbox) {
    document.querySelectorAll('.unused-field-checkbox').forEach(cb => {
        cb.checked = checkbox.checked;
    });
}

function selectAllUnusedFields() {
    document.querySelectorAll('.unused-field-checkbox').forEach(cb => {
        cb.checked = true;
    });
    document.getElementById('selectAllUnused').checked = true;
}

function deselectAllUnusedFields() {
    document.querySelectorAll('.unused-field-checkbox').forEach(cb => {
        cb.checked = false;
    });
    document.getElementById('selectAllUnused').checked = false;
}

async function bulkDeleteUnusedFields() {
    const checkboxes = document.querySelectorAll('.unused-field-checkbox:checked');
    
    if (checkboxes.length === 0) {
        showMessage('Please select fields to delete', 'error');
        return;
    }
    
    if (!confirm(`Are you sure you want to delete ${checkboxes.length} unused field(s)? This cannot be undone.`)) {
        return;
    }
    
    let deleted = 0;
    let failed = 0;
    
    for (const checkbox of checkboxes) {
        const fieldId = checkbox.dataset.fieldId;
        
        try {
            const response = await fetch(`${API_BASE}/locations/${selectedLocation.id}/custom-fields/${fieldId}`, {
                method: 'DELETE'
            });
            
            if (response.ok) {
                deleted++;
            } else {
                failed++;
            }
        } catch (error) {
            failed++;
        }
    }
    
    showMessage(`Deleted ${deleted} fields${failed > 0 ? `, ${failed} failed` : ''}`, 'success');
    closeModal('fieldAuditModal');
    loadCustomFields();
}
function switchToLocationFromModal(locationId) {
    closeModal('manageLocationsModal');
    selectLocation(locationId);
    
    const dropdown = document.getElementById('locationDropdown');
    dropdown.value = locationId;
    
    showMessage('Switched to location successfully', 'success');
}

// MEDIA LIBRARY FUNCTIONS
let currentMediaView = 'grid';
let allMedia = [];
let filteredMedia = [];
let selectedMedia = new Set();

async function loadMedia() {
    if (!selectedLocation) {
        document.getElementById('mediaList').innerHTML = '<div class="empty-state">Please select a location</div>';
        return;
    }
    
    try {
        const response = await fetch(`${API_BASE}/locations/${selectedLocation.id}/media?limit=1000`);
        const data = await response.json();
        
        if (data.success) {
            allMedia = data.files || [];
            selectedMedia.clear();
            
            // Show/hide toolbar
            const toolbar = document.getElementById('mediaToolbar');
            const resultsInfo = document.getElementById('mediaResultsInfo');
            if (allMedia.length > 0) {
                toolbar.style.display = 'flex';
                resultsInfo.style.display = 'block';
            } else {
                toolbar.style.display = 'none';
                resultsInfo.style.display = 'none';
            }
            
            renderMedia();
            updateMediaBulkActions();
        } else {
            showMessage('Failed to load media', 'error');
        }
    } catch (error) {
        showMessage(`Error: ${error.message}`, 'error');
    }
}

function renderMedia() {
    const listEl = document.getElementById('mediaList');
    const searchTerm = document.getElementById('mediaSearch')?.value?.toLowerCase() || '';

    // Remove any selections that no longer exist in the dataset
    if (selectedMedia.size > 0) {
        const existingIds = new Set(
            allMedia
                .map(file => file?.id || file?._id || file?.fileId || file?.uuid)
                .filter(Boolean)
                .map(id => String(id))
        );
        selectedMedia.forEach(id => {
            if (!existingIds.has(id)) {
                selectedMedia.delete(id);
            }
        });
    }

    filteredMedia = allMedia.filter(file => {
        return !searchTerm || 
            (file.name && file.name.toLowerCase().includes(searchTerm)) ||
            (file.url && file.url.toLowerCase().includes(searchTerm));
    });

    const resultsCount = document.getElementById('mediaResultsCount');
    if (resultsCount) resultsCount.textContent = filteredMedia.length;
    
    if (filteredMedia.length === 0) {
        listEl.innerHTML = '<div class="empty-state">No files found</div>';
        updateMediaBulkActions();
        return;
    }

    if (currentMediaView === 'gallery') {
        renderMediaGallery(filteredMedia, listEl);
    } else if (currentMediaView === 'grid') {
        renderMediaGrid(filteredMedia, listEl);
    } else {
        renderMediaList(filteredMedia, listEl);
    }
    updateMediaBulkActions();
}

function renderMediaList(files, container) {
    container.innerHTML = `
        <table class="data-table">
            <thead>
                <tr>
                    <th class="checkbox-col">
                        <input type="checkbox" id="selectAllMedia" onchange="toggleAllMedia(this)">
                    </th>
                    <th>Preview</th>
                    <th>Name</th>
                    <th>Type</th>
                    <th>URL</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody>
                ${files.map(file => {
                    const fileId = file?.id || file?._id || file?.fileId || file?.uuid || '';
                    const isImage = file.url && file.url.match(/\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?.*)?$/i);
                    const fileType = file.url ? file.url.split('.').pop().split('?')[0].toUpperCase() : 'FILE';
                    const hasId = Boolean(fileId);
                    const normalizedId = hasId ? String(fileId) : '';
                    const isSelected = hasId && selectedMedia.has(normalizedId);
                    const rowClass = isSelected ? 'selected' : '';
                    const safeId = hasId ? normalizedId.replace(/'/g, "\\'") : '';
                    const checkboxHtml = hasId
                        ? `<input type="checkbox" class="media-checkbox" ${isSelected ? 'checked' : ''} onclick="toggleMediaSelection('${safeId}', event)">`
                        : '<span style="display: inline-block; width: 16px; height: 16px;"></span>';
                    const rowClick = hasId ? `onclick="handleMediaRowClick('${safeId}', event)"` : '';
                    const deleteButton = hasId
                        ? `<button class="btn-icon" onclick="deleteMedia('${safeId}', event)" title="Delete">🗑️</button>`
                        : '';
                    return `
                        <tr class="${rowClass}" ${rowClick}>
                            <td class="checkbox-col">
                                ${checkboxHtml}
                            </td>
                            <td style="width: 80px;">
                                ${isImage ? `<img src="${file.url}" style="max-width: 60px; max-height: 60px; border-radius: 4px;">` : '📄'}
                            </td>
                            <td>${file.name || 'Unnamed'}</td>
                            <td><span style="background: #e2e8f0; padding: 4px 8px; border-radius: 4px; font-size: 11px;">${fileType}</span></td>
                            <td><a href="${file.url}" target="_blank" style="color: #667eea; text-decoration: none;">View</a></td>
                            <td>
                                <button class="btn-icon" onclick="copyToClipboard('${file.url.replace(/'/g, "\\'")}', event)" title="Copy URL">📋</button>
                                ${deleteButton}
                            </td>
                        </tr>
                    `;
                }).join('')}
            </tbody>
        </table>
    `;
}

function renderMediaGrid(files, container) {
    container.innerHTML = `
        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 20px;">
            ${files.map(file => {
                const fileId = file?.id || file?._id || file?.fileId || file?.uuid || '';
                const isImage = file.url && file.url.match(/\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?.*)?$/i);
                const fileType = file.url ? file.url.split('.').pop().split('?')[0].toUpperCase() : 'FILE';
                const hasId = Boolean(fileId);
                const normalizedId = hasId ? String(fileId) : '';
                const isSelected = hasId && selectedMedia.has(normalizedId);
                const safeId = hasId ? normalizedId.replace(/'/g, "\\'") : '';
                const checkboxHtml = hasId
                    ? `<input type="checkbox" class="media-checkbox" ${isSelected ? 'checked' : ''} onclick="toggleMediaSelection('${safeId}', event)">`
                    : '<span style="display: inline-block; width: 16px; height: 16px;"></span>';
                const cardClick = hasId ? `onclick="handleMediaCardClick('${safeId}', event)"` : '';
                const cursorStyle = hasId ? 'pointer' : 'default';
                const deleteButton = hasId
                    ? `<button class="btn-icon" style="flex: 1;" onclick="deleteMedia('${safeId}', event)">🗑️</button>`
                    : '';
                
                return `
                    <div class="media-card" ${cardClick} style="background: white; position: relative; border: 2px solid ${isSelected ? '#667eea' : '#e2e8f0'}; border-radius: 12px; overflow: hidden; box-shadow: ${isSelected ? '0 0 0 3px rgba(102,126,234,0.3)' : 'none'}; cursor: ${cursorStyle};">
                        <div style="position: absolute; top: 10px; left: 10px; z-index: 2;">
                            ${checkboxHtml}
                        </div>
                        <div style="height: 150px; background: #f7fafc; display: flex; align-items: center; justify-content: center;">
                            ${isImage ? 
                                `<img src="${file.url}" style="max-width: 100%; max-height: 100%; object-fit: cover;">` : 
                                `<div style="font-size: 48px;">📄</div>`
                            }
                        </div>
                        <div style="padding: 15px;">
                            <div style="font-weight: 600; margin-bottom: 8px; word-break: break-word;">${file.name || 'Unnamed'}</div>
                            <div style="font-size: 11px; color: #718096; margin-bottom: 10px;">${fileType}</div>
                            <div style="display: flex; gap: 8px;">
                                <button class="btn-icon" style="flex: 1;" onclick="copyToClipboard('${file.url.replace(/'/g, "\\'")}', event)">📋</button>
                                <a href="${file.url}" target="_blank" class="btn-icon" style="flex: 1; text-decoration: none;">👁️</a>
                                ${deleteButton}
                            </div>
                        </div>
                    </div>
                `;
            }).join('')} 
        </div>
    `;
}

function renderMediaGallery(files, container) {
    const imageFiles = files.filter(file => 
        file.url && file.url.match(/\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?.*)?$/i)
    );
    
    if (imageFiles.length === 0) {
        container.innerHTML = '<div class="empty-state">No image files found. Switch to Grid or List view to see all files.</div>';
        return;
    }
    
    container.innerHTML = `
        <div class="gallery-grid">
            ${imageFiles.map(file => {
                const fileId = file?.id || file?._id || file?.fileId || file?.uuid || '';
                const hasId = Boolean(fileId);
                const normalizedId = hasId ? String(fileId) : '';
                const isSelected = hasId && selectedMedia.has(normalizedId);
                const safeId = hasId ? normalizedId.replace(/'/g, "\\'") : '';
                const checkboxHtml = hasId
                    ? `<input type="checkbox" class="media-checkbox" ${isSelected ? 'checked' : ''} onclick="toggleMediaSelection('${safeId}', event)">`
                    : '<span style="display: inline-block; width: 16px; height: 16px;"></span>';
                const cardClick = hasId ? `onclick="handleMediaCardClick('${safeId}', event)"` : '';
                const cursorStyle = hasId ? 'pointer' : 'default';
                const deleteButton = hasId
                    ? `<button class="btn-icon" onclick="deleteMedia('${safeId}', event)" title="Delete">🗑️</button>`
                    : '';
                return `
                <div class="gallery-item ${isSelected ? 'selected' : ''}" ${cardClick} style="position: relative; border: 2px solid ${isSelected ? '#667eea' : 'transparent'}; cursor: ${cursorStyle};">
                    <div style="position: absolute; top: 10px; left: 10px; z-index: 2;">
                        ${checkboxHtml}
                    </div>
                    <div class="gallery-image-container">
                        <img src="${file.url}" alt="${file.name}" class="gallery-image">
                    </div>
                    <div class="gallery-info">
                        <div class="gallery-name">${file.name || 'Unnamed'}</div>
                        <div class="gallery-actions">
                            <button class="btn-icon" onclick="copyToClipboard('${file.url.replace(/'/g, "\\'")}', event)" title="Copy URL">📋</button>
                            <a href="${file.url}" target="_blank" class="btn-icon" title="View">👁️</a>
                            ${deleteButton}
                        </div>
                    </div>
                </div>`;
            }).join('')}
        </div>
    `;
}

function toggleMediaSelection(mediaId, event) {
    if (event) {
        event.stopPropagation();
        if (event.target && event.target.classList && event.target.classList.contains('media-checkbox')) {
            // allow checkbox to toggle naturally
        }
    }
    if (!mediaId) {
        return;
    }
    const normalizedId = String(mediaId);
    if (selectedMedia.has(normalizedId)) {
        selectedMedia.delete(normalizedId);
    } else {
        selectedMedia.add(normalizedId);
    }
    renderMedia();
}

function handleMediaRowClick(mediaId, event) {
    if (event.target.closest('button') || event.target.closest('a') || event.target.classList.contains('media-checkbox')) {
        return;
    }
    toggleMediaSelection(mediaId, event);
}

function handleMediaCardClick(mediaId, event) {
    if (event.target.closest('.media-checkbox') || event.target.closest('.btn-icon') || event.target.tagName === 'A') {
        return;
    }
    toggleMediaSelection(mediaId, event);
}

function toggleAllMedia(checkbox) {
    const shouldSelect = checkbox.checked;
    if (!Array.isArray(filteredMedia)) {
        return;
    }
    if (shouldSelect) {
        filteredMedia.forEach(file => {
            const id = file?.id || file?._id || file?.fileId || file?.uuid;
            if (id) {
                selectedMedia.add(String(id));
            }
        });
    } else {
        filteredMedia.forEach(file => {
            const id = file?.id || file?._id || file?.fileId || file?.uuid;
            if (id) {
                selectedMedia.delete(String(id));
            }
        });
    }
    renderMedia();
}

function updateMediaBulkActions() {
    const bulkBar = document.getElementById('mediaBulkActions');
    const selectedCount = document.getElementById('mediaSelectedCount');
    if (selectedCount) {
        selectedCount.textContent = selectedMedia.size;
    }
    if (bulkBar) {
        if (selectedMedia.size > 0) {
            bulkBar.classList.add('show');
        } else {
            bulkBar.classList.remove('show');
        }
    }
    const selectAll = document.getElementById('selectAllMedia');
    if (selectAll) {
        if (filteredMedia.length === 0) {
            selectAll.checked = false;
            selectAll.indeterminate = false;
        } else {
            const idList = filteredMedia
                .map(file => file?.id || file?._id || file?.fileId || file?.uuid)
                .filter(Boolean);
            if (idList.length === 0) {
                selectAll.checked = false;
                selectAll.indeterminate = false;
            } else {
                const allSelected = idList.every(id => selectedMedia.has(id));
                const someSelected = idList.some(id => selectedMedia.has(id));
                selectAll.checked = allSelected;
                selectAll.indeterminate = !allSelected && someSelected;
            }
        }
    }
}

function deselectAllMedia() {
    selectedMedia.clear();
    renderMedia();
}

async function bulkDeleteMedia() {
    if (!selectedLocation) {
        showMessage('Please select a location first', 'error');
        return;
    }
    if (selectedMedia.size === 0) {
        showMessage('Select files to delete first.', 'error');
        return;
    }
    if (!confirm(`Delete ${selectedMedia.size} file(s)? This cannot be undone.`)) {
        return;
    }
    try {
        const response = await fetch(`${API_BASE}/locations/${selectedLocation.id}/media/bulk-delete`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fileIds: Array.from(selectedMedia),
                status: 'deleted'
            })
        });
        const data = await response.json();
        if (response.ok && data.success) {
            showMessage('Selected files deleted', 'success');
            selectedMedia.clear();
            await loadMedia();
        } else {
            showMessage(`Bulk delete failed: ${data.error || 'Unknown error'}`, 'error');
        }
    } catch (error) {
        showMessage(`Error: ${error.message}`, 'error');
    }
}

function toggleMediaView(view) {
    currentMediaView = view;
    
    document.getElementById('mediaListViewBtn').style.background = view === 'list' ? '#667eea' : '';
    document.getElementById('mediaListViewBtn').style.color = view === 'list' ? 'white' : '';
    document.getElementById('mediaGridViewBtn').style.background = view === 'grid' ? '#667eea' : '';
    document.getElementById('mediaGridViewBtn').style.color = view === 'grid' ? 'white' : '';
    document.getElementById('mediaGalleryViewBtn').style.background = view === 'gallery' ? '#667eea' : '';
    document.getElementById('mediaGalleryViewBtn').style.color = view === 'gallery' ? 'white' : '';
    
    renderMedia();
}

function filterMedia() {
    renderMedia();
}

function uploadMedia() {
    if (!selectedLocation) {
        showMessage('Please select a location first', 'error');
        return;
    }
    
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '*/*';
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        if (file.size > 25 * 1024 * 1024) {
            showMessage('File too large. Maximum size is 25MB', 'error');
            return;
        }
        
        const formData = new FormData();
        formData.append('file', file);
        formData.append('name', file.name);
        
        try {
            showMessage('Uploading...', 'info');
            
            const response = await fetch(`${API_BASE}/locations/${selectedLocation.id}/media`, {
                method: 'POST',
                body: formData
            });
            
            const data = await response.json();
            
            if (data.success) {
                showMessage('File uploaded successfully', 'success');
                loadMedia();
            } else {
                showMessage(`Upload failed: ${data.error}`, 'error');
            }
        } catch (error) {
            showMessage(`Error: ${error.message}`, 'error');
        }
    };
    input.click();
}

async function deleteMedia(fileId, event) {
    if (event) {
        event.stopPropagation();
    }
    if (!selectedLocation) {
        showMessage('Please select a location first', 'error');
        return;
    }
    if (!fileId) {
        showMessage('Unable to delete file: missing identifier.', 'error');
        return;
    }
    if (!confirm('Are you sure you want to delete this file?')) {
        return;
    }
    
    try {
        const response = await fetch(`${API_BASE}/locations/${selectedLocation.id}/media/${fileId}`, {
            method: 'DELETE'
        });
        
        const data = await response.json();
        
        if (data.success) {
            showMessage('File deleted', 'success');
            selectedMedia.delete(String(fileId));
            updateMediaBulkActions();
            await loadMedia();
        } else {
            showMessage(`Delete failed: ${data.error}`, 'error');
        }
    } catch (error) {
        showMessage(`Error: ${error.message}`, 'error');
    }
}
