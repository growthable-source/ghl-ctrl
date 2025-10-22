import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import {
  BuilderProvider,
  useBuilderState,
  useBuilderActions,
  useSelectedPage,
  createWizard,
  defaultTheme
} from './context/BuilderContext';
import { BLOCK_LIBRARY, BLOCK_TYPES } from './constants';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';
import {
  fetchBootstrap,
  fetchTemplate,
  saveTemplate,
  publishTemplate,
  cloneTemplate,
  deleteTemplate,
  issueWizardLink,
  fetchLibrary,
  fetchTemplates,
  fetchVoiceAgents,
  createVoiceAgent,
  updateVoiceAgent,
  deleteVoiceAgent
} from './api';

const PageDragType = {
  PAGE: 'page',
  BLOCK: 'block'
};

const CUSTOM_FIELD_TYPES = [
  { value: 'TEXT', label: 'Text' },
  { value: 'TEXTBOX_LIST', label: 'Textbox List' },
  { value: 'NUMBER', label: 'Number' },
  { value: 'PHONE', label: 'Phone' },
  { value: 'MONETARYAMOUNT', label: 'Monetary Amount' },
  { value: 'CHECKBOX', label: 'Checkbox' },
  { value: 'DROPDOWN', label: 'Dropdown' },
  { value: 'RADIO', label: 'Radio' },
  { value: 'DATE', label: 'Date' }
];

const TEXT_BLOCK_VARIANTS = [
  { value: 'heading1', label: 'Heading 1' },
  { value: 'heading2', label: 'Heading 2' },
  { value: 'heading3', label: 'Heading 3' },
  { value: 'paragraph', label: 'Paragraph' },
  { value: 'subtitle', label: 'Subtitle / Lead' },
  { value: 'bullets', label: 'Bulleted list' },
  { value: 'numbered', label: 'Numbered list' },
  { value: 'quote', label: 'Quote' }
];

const VOICE_AI_LANGUAGES = ['en-US', 'pt-BR', 'es', 'fr', 'de', 'it', 'nl-NL', 'multi'];
const PATIENCE_LEVELS = ['low', 'medium', 'high'];
const SOCIAL_PLATFORM_OPTIONS = [
  { id: 'google', label: 'Google Business Profile', available: true },
  { id: 'facebook', label: 'Facebook', available: false },
  { id: 'instagram', label: 'Instagram', available: false },
  { id: 'linkedin', label: 'LinkedIn', available: false },
  { id: 'tiktok', label: 'TikTok', available: false },
  { id: 'youtube', label: 'YouTube', available: false }
];

const OAUTH_TOAST_MESSAGES = {
  success: {
    type: 'success',
    message: 'Marketplace app installed. Your HighLevel account is now connected.'
  },
  exchange_failed: {
    type: 'error',
    message: 'We could not complete the OAuth exchange. Try again or use a private token.'
  },
  state_mismatch: {
    type: 'error',
    message: 'The connect session expired. Please launch the marketplace install again.'
  },
  missing_code: {
    type: 'error',
    message: 'No authorization code was returned. Please restart the marketplace install.'
  },
  config_missing: {
    type: 'error',
    message: 'OAuth credentials are not configured on the server yet.'
  },
  access_denied: {
    type: 'error',
    message: 'Marketplace install was canceled before completion.'
  }
};

const CHALLENGE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function generateDeletionChallenge() {
  let word = '';
  for (let i = 0; i < 4; i += 1) {
    const index = Math.floor(Math.random() * CHALLENGE_ALPHABET.length);
    word += CHALLENGE_ALPHABET[index];
  }
  return word;
}

function App() {
  return (
    <BuilderProvider>
      <BuilderShell />
    </BuilderProvider>
  );
}

function BuilderShell() {
  const state = useBuilderState();
  const actions = useBuilderActions();
  const selectedPage = useSelectedPage();
  const [view, setView] = useState('dashboard');
  const [activeTemplateId, setActiveTemplateId] = useState(null);
  const [toast, setToast] = useState(null);
  const [connectModalOpen, setConnectModalOpen] = useState(false);
  const [issueModal, setIssueModal] = useState({
    open: false,
    status: 'idle',
    link: null,
    error: null
  });
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState(null);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createForm, setCreateForm] = useState({
    name: '',
    description: '',
    locationId: ''
  });
  const [creatingTemplate, setCreatingTemplate] = useState(false);
  const [deleteModal, setDeleteModal] = useState({
    open: false,
    template: null,
    challenge: '',
    input: '',
    submitting: false
  });
  const initialTemplateParam = useRef(
    new URLSearchParams(window.location.search).get('templateId')
  );

  useEffect(() => {
    async function bootstrap() {
      try {
        actions.bootstrapRequest();
        const data = await fetchBootstrap();
        actions.bootstrapSuccess({
          locations: data.locations || [],
          library: data.library || {
            customFields: [],
            customValues: [],
            triggerLinks: [],
            tags: [],
            media: []
          },
          templates: data.templates || []
        });
        if (data.latestTemplate && initialTemplateParam.current) {
          await openBuilderById(initialTemplateParam.current);
          initialTemplateParam.current = null;
        }
      } catch (error) {
        console.error(error);
        actions.bootstrapFailure(error.message || 'Failed to load builder');
      }
    }
    bootstrap();
  }, [actions]);

  useEffect(() => {
    if (!initialTemplateParam.current || state.loading) return;
    openBuilderById(initialTemplateParam.current).finally(() => {
      initialTemplateParam.current = null;
    });
  }, [state.loading]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthStatus = params.get('oauth');
    if (!oauthStatus) return;

    const statusKey = Object.prototype.hasOwnProperty.call(OAUTH_TOAST_MESSAGES, oauthStatus)
      ? oauthStatus
      : 'access_denied';
    const payload = OAUTH_TOAST_MESSAGES[statusKey] || OAUTH_TOAST_MESSAGES.access_denied;
    setToast(payload);

    params.delete('oauth');
    if (params.get('connect')) {
      params.delete('connect');
    }
    const cleaned = params.toString();
    const newUrl = cleaned
      ? `${window.location.pathname}?${cleaned}`
      : window.location.pathname;
    window.history.replaceState({}, document.title, newUrl);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadLibrary() {
      if (view !== 'builder') {
        setLibraryLoading(false);
        setLibraryError(null);
        return;
      }
      if (!state.wizard.locationId) {
        actions.setLibrary({
          customFields: [],
          customValues: [],
          triggerLinks: [],
          tags: [],
          media: []
        });
        setLibraryLoading(false);
        setLibraryError(null);
        return;
      }
      setLibraryLoading(true);
      setLibraryError(null);
      try {
        const response = await fetchLibrary(state.wizard.locationId);
        if (!cancelled) {
          actions.setLibrary(response.library || {});
          setLibraryLoading(false);
        }
      } catch (error) {
        if (!cancelled) {
          console.error(error);
          setLibraryError(error.message || 'Failed to load location assets');
          setLibraryLoading(false);
        }
      }
    }
    loadLibrary();
    return () => {
      cancelled = true;
    };
  }, [state.wizard.locationId, view, actions]);

  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true);
    try {
      const response = await fetchTemplates();
      if (response?.templates) {
        actions.setTemplates(response.templates);
      }
    } catch (error) {
      console.error(error);
      setToast({
        type: 'error',
        message: error.message || 'Failed to refresh wizard list'
      });
    } finally {
      setTemplatesLoading(false);
    }
  }, [actions]);

  const handleCloneTemplate = useCallback(
    async (template) => {
      if (!template?.id) return;
      try {
        const response = await cloneTemplate(template.id);
        const cloned = response?.template || response;
        await loadTemplates();
        setToast({
          type: 'success',
          message:
            cloned?.name && cloned.name !== template.name
              ? `Cloned "${template.name}" as "${cloned.name}".`
              : `Cloned "${template.name}".`
        });
      } catch (error) {
        console.error(error);
        setToast({
          type: 'error',
          message: error.message || 'Failed to clone wizard'
        });
      }
    },
    [loadTemplates]
  );

  const openDeleteWizardModal = useCallback((template) => {
    if (!template) return;
    setDeleteModal({
      open: true,
      template,
      challenge: generateDeletionChallenge(),
      input: '',
      submitting: false
    });
  }, []);

  const closeDeleteModal = useCallback(() => {
    setDeleteModal({
      open: false,
      template: null,
      challenge: '',
      input: '',
      submitting: false
    });
  }, []);

  const handleDeleteInputChange = useCallback((value) => {
    setDeleteModal((prev) => ({ ...prev, input: value }));
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteModal.template?.id) return;
    const inputCode = deleteModal.input.trim().toUpperCase();
    if (inputCode !== deleteModal.challenge) return;

    setDeleteModal((prev) => ({ ...prev, submitting: true }));

    try {
      await deleteTemplate(deleteModal.template.id);
      const deletedId = deleteModal.template.id;
      const deletedName = deleteModal.template.name;
      setToast({
        type: 'success',
        message: `Deleted "${deletedName}".`
      });
      setDeleteModal({
        open: false,
        template: null,
        challenge: '',
        input: '',
        submitting: false
      });
      if (deletedId === state.wizard.id) {
        actions.setWizard(createWizard());
        actions.setDirty(false);
        setActiveTemplateId(null);
        setView('dashboard');
        window.history.replaceState({}, '', '/admin/onboarding.html');
      }
      await loadTemplates();
    } catch (error) {
      console.error(error);
      setToast({
        type: 'error',
        message: error.message || 'Failed to delete wizard'
      });
      setDeleteModal((prev) => ({ ...prev, submitting: false }));
    }
  }, [
    actions,
    deleteModal,
    loadTemplates,
    setActiveTemplateId,
    setView,
    state.wizard.id
  ]);

  const openBuilderById = useCallback(
    async (templateId) => {
      try {
        const template = await fetchTemplate(templateId);
        actions.setWizard(template);
        setActiveTemplateId(templateId);
        setView('builder');
        window.history.replaceState({}, '', `/admin/onboarding.html?templateId=${templateId}`);
      } catch (error) {
        console.error(error);
        setToast({
          type: 'error',
          message: error.message || 'Unable to load the requested template.'
        });
      }
    },
    [actions]
  );

  const handleExitBuilder = useCallback(() => {
    setView('dashboard');
    setActiveTemplateId(null);
    window.history.replaceState({}, '', '/admin/onboarding.html');
    setIssueModal({ open: false, status: 'idle', link: null, error: null });
    loadTemplates();
  }, [loadTemplates]);

  const handleNavigate = useCallback(
    (nextView) => {
      if (nextView === 'builder') return;
      setView(nextView);
      if (nextView === 'dashboard') {
        loadTemplates();
      }
    },
    [loadTemplates]
  );

  useEffect(() => {
    if (view !== 'dashboard') {
      setShowCreateModal(false);
    }
  }, [view]);

  const closeShareModal = useCallback(() => {
    setIssueModal({ open: false, status: 'idle', link: null, error: null });
  }, []);

  const handleSaveDraft = useCallback(async () => {
    try {
      actions.setSaving(true);
      const response = await saveTemplate(state.wizard);
      const savedTemplate = response.template || response;
      actions.setWizard(savedTemplate);
      actions.setDirty(false);
      setToast({ type: 'success', message: 'Draft saved' });
      await loadTemplates();
      return savedTemplate;
    } catch (error) {
      console.error(error);
      setToast({
        type: 'error',
        message: error.message || 'Failed to save template'
      });
      return null;
    } finally {
      actions.setSaving(false);
    }
  }, [actions, state.wizard, loadTemplates]);

  const handlePublish = useCallback(async () => {
    try {
      actions.setPublishing(true);
      const response = await publishTemplate(state.wizard);
      actions.setWizard(response.template || response);
      actions.setDirty(false);
      setToast({ type: 'success', message: 'Wizard published' });
      await loadTemplates();
    } catch (error) {
      console.error(error);
      setToast({
        type: 'error',
        message: error.message || 'Failed to publish wizard'
      });
    } finally {
      actions.setPublishing(false);
    }
  }, [actions, state.wizard, loadTemplates]);

  const handleIssueLink = useCallback(async () => {
    if (!state.wizard.locationId) {
      setToast({
        type: 'error',
        message: 'Select a location before sharing'
      });
      return;
    }
    setIssueModal({ open: true, status: 'loading', link: null, error: null });
    try {
      const response = await issueWizardLink(state.wizard.id, state.wizard.locationId);
      setIssueModal({
        open: true,
        status: 'success',
        link: response.publicUrl,
        error: null
      });
      await loadTemplates();
    } catch (error) {
      console.error(error);
      setIssueModal({
        open: true,
        status: 'error',
        link: null,
        error: error.message || 'Failed to generate link'
      });
    }
  }, [state.wizard.id, state.wizard.locationId, loadTemplates]);

  const handlePreview = useCallback(async () => {
    let templateId = state.wizard.id;
    if (!templateId || state.dirty) {
      const saved = await handleSaveDraft();
      templateId = saved?.id;
      if (!templateId) {
        return;
      }
    }
    const url = `/onboard.html?templateId=${encodeURIComponent(templateId)}&preview=1`;
    const previewWindow = window.open(url, '_blank', 'noopener');
    if (!previewWindow) {
      setToast({
        type: 'error',
        message: 'Allow pop-ups to view the live preview.'
      });
    }
  }, [state.wizard.id, state.dirty, handleSaveDraft]);

  const handleDragEnd = (result) => {
    const { destination, source, type } = result;
    if (!destination) return;
    if (
      destination.droppableId === source.droppableId &&
      destination.index === source.index
    ) {
      return;
    }

    if (type === PageDragType.PAGE) {
      const reordered = Array.from(state.wizard.pages);
      const [moved] = reordered.splice(source.index, 1);
      reordered.splice(destination.index, 0, moved);
      actions.reorderPages(reordered);
      return;
    }

    if (selectedPage) {
      const reordered = Array.from(selectedPage.blocks);
      const [moved] = reordered.splice(source.index, 1);
      reordered.splice(destination.index, 0, moved);
      actions.reorderBlocks(selectedPage.id, reordered);
    }
  };

  const handleCreateWizard = async (event) => {
    event.preventDefault();
    if (!createForm.name.trim()) {
      setToast({ type: 'error', message: 'Wizard name is required.' });
      return;
    }
    setCreatingTemplate(true);
    try {
      const draft = createWizard();
      draft.name = createForm.name.trim();
      draft.description = createForm.description.trim();
      draft.locationId = createForm.locationId || '';
      draft.theme = { ...defaultTheme() };
      const response = await saveTemplate(draft);
      const savedTemplate = response.template || response;
      actions.setWizard(savedTemplate);
      setActiveTemplateId(savedTemplate.id);
      setView('builder');
      window.history.replaceState({}, '', `/admin/onboarding.html?templateId=${savedTemplate.id}`);
      setShowCreateModal(false);
      setCreateForm({
        name: '',
        description: '',
        locationId: ''
      });
      await loadTemplates();
    } catch (error) {
      console.error(error);
      setToast({
        type: 'error',
        message: error.message || 'Failed to create wizard'
      });
    } finally {
      setCreatingTemplate(false);
    }
  };

  if (state.loading) {
    return (
      <div className="builder-shell">
        <div className="empty-state">Loading builder…</div>
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="builder-shell">
        <div className="empty-state">
          <strong>Something went wrong.</strong>
          <br />
          {state.error}
        </div>
      </div>
    );
  }

  if (view === 'builder') {
    return (
      <div className="builder-shell">
        <BuilderHeader
          wizard={state.wizard}
          dirty={state.dirty}
          saving={state.saving}
          publishing={state.publishing}
          locations={state.bootstrap.locations || []}
          onSaveDraft={handleSaveDraft}
          onPreview={handlePreview}
          onPublish={handlePublish}
          onIssueLink={handleIssueLink}
          onExit={handleExitBuilder}
          issuing={issueModal.open && issueModal.status === 'loading'}
        />

        <DragDropContext onDragEnd={handleDragEnd}>
          <div className="builder-main">
            <BuilderSidebar
              state={state}
              actions={actions}
              selectedPage={selectedPage}
            />
            <BuilderCanvas
              selectedPage={selectedPage}
              actions={actions}
              library={state.bootstrap.library}
              libraryStatus={{ loading: libraryLoading, error: libraryError }}
            />
          </div>
        </DragDropContext>

        <ShareLinkModal
          modal={issueModal}
          onClose={closeShareModal}
          onRetry={handleIssueLink}
        />
        {toast ? <Toast toast={toast} onDismiss={() => setToast(null)} /> : null}
      </div>
    );
  }

  return (
    <div className="builder-shell">
      <MainNavigation
        currentView={view}
        onNavigate={handleNavigate}
        onConnect={() => setConnectModalOpen(true)}
      />
      {view === 'dashboard' ? (
        <>
          <Dashboard
            templates={state.bootstrap.templates || []}
            locations={state.bootstrap.locations || []}
            loading={templatesLoading}
            onRefresh={loadTemplates}
            onCreate={() => setShowCreateModal(true)}
            onEdit={openBuilderById}
            onCopyLink={(url) => {
              if (!url) {
                setToast({ type: 'error', message: 'No share link yet. Issue a link first.' });
                return;
              }
              navigator.clipboard
                .writeText(url)
                .then(() =>
                  setToast({ type: 'success', message: 'Link copied to clipboard' })
                )
                .catch(() =>
                  setToast({ type: 'error', message: 'Unable to copy link' })
                );
            }}
            onClone={handleCloneTemplate}
            onDelete={openDeleteWizardModal}
          />

          <CreateWizardModal
            open={showCreateModal}
            onClose={() => {
              if (!creatingTemplate) setShowCreateModal(false);
            }}
            form={createForm}
            setForm={setCreateForm}
            locations={state.bootstrap.locations || []}
            onSubmit={handleCreateWizard}
            submitting={creatingTemplate}
          />

          <DeleteWizardModal
            modal={deleteModal}
            onClose={closeDeleteModal}
            onChange={handleDeleteInputChange}
            onConfirm={handleConfirmDelete}
          />
        </>
      ) : null}

      {view === 'voice-ai' ? (
        <VoiceAIDashboard
          locations={state.bootstrap.locations || []}
          onShowToast={(payload) => setToast(payload)}
        />
      ) : null}

      <ConnectCrmModal
        open={connectModalOpen}
        onClose={() => setConnectModalOpen(false)}
      />

      {toast ? <Toast toast={toast} onDismiss={() => setToast(null)} /> : null}
    </div>
  );
}

function MainNavigation({ currentView, onNavigate, onConnect }) {
  return (
    <nav className="builder-nav">
      <button
        type="button"
        className={currentView === 'dashboard' ? 'active' : ''}
        onClick={() => onNavigate('dashboard')}
      >
        Wizards
      </button>
      <button
        type="button"
        className={currentView === 'voice-ai' ? 'active' : ''}
        onClick={() => onNavigate('voice-ai')}
      >
        Voice AI
      </button>
      <button
        type="button"
        className="connect-trigger"
        onClick={() => onConnect?.()}
      >
        Connect CRM
      </button>
    </nav>
  );
}

function Dashboard({
  templates,
  locations,
  loading,
  onCreate,
  onEdit,
  onCopyLink,
  onRefresh,
  onClone,
  onDelete
}) {
  return (
    <div className="wizard-dashboard">
      <div className="dashboard-header">
        <div>
          <h1>Your Onboarding Wizards</h1>
          <p>Issue branded onboarding flows, track submissions, and share links instantly.</p>
        </div>
        <div className="dashboard-actions">
          <button className="secondary" onClick={onRefresh}>
            Refresh
          </button>
          <button className="primary" onClick={onCreate}>
            + New Wizard
          </button>
        </div>
      </div>

      {loading ? (
        <div className="empty-state">Loading wizards…</div>
      ) : templates.length === 0 ? (
        <div className="empty-state">
          <h3>No wizards yet</h3>
          <p>Create your first onboarding wizard to start collecting submissions.</p>
          <button className="primary" onClick={onCreate}>
            Create Wizard
          </button>
        </div>
      ) : (
        <div className="wizard-table">
          <div className="wizard-table-header">
            <span>Name</span>
            <span>Status</span>
            <span>Location</span>
            <span>Issued</span>
            <span>Submissions</span>
            <span>Last submission</span>
            <span>Actions</span>
          </div>
          <div className="wizard-table-body">
            {templates.map((template) => (
              <WizardRow
                key={template.id}
                template={template}
                locations={locations}
                onEdit={onEdit}
                onCopyLink={onCopyLink}
                onClone={onClone}
                onDelete={onDelete}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ConnectCrmModal({ open, onClose }) {
  const handleMarketplaceInstall = useCallback(() => {
    if (onClose) onClose();
    const returnTo = `${window.location.pathname}${window.location.search}`;
    window.location.href = `/oauth/leadconnector/start?returnTo=${encodeURIComponent(returnTo)}`;
  }, [onClose]);

  const handlePrivateToken = useCallback(() => {
    if (onClose) onClose();
    window.location.href = '/?connect=private';
  }, [onClose]);

  return (
    <div className={`modal ${open ? 'show' : ''}`}>
      <div className="modal-content connect-crm-modal">
        <div className="modal-header">
          <h2>Connect your CRM</h2>
          <button type="button" className="close-modal" onClick={() => onClose?.()}>
            ×
          </button>
        </div>
        <div className="connect-modal-body">
          <div className="connect-option primary">
            <div className="option-icon" aria-hidden="true">
              🧩
            </div>
            <h3>Install Marketplace App</h3>
            <p>
              Launch the HighLevel OAuth flow to create a refreshable connection for your agency or sub-account.
            </p>
            <button type="button" className="btn btn-primary" onClick={handleMarketplaceInstall}>
              Install Marketplace App
            </button>
            <small>Recommended for long-lived connections and agency-level installs.</small>
          </div>
          <div className="connect-option">
            <div className="option-icon" aria-hidden="true">
              🔐
            </div>
            <h3>Use Private Integration Token</h3>
            <p>
              Keep using the existing private token workflow for quick tests or legacy locations.
            </p>
            <button type="button" className="btn btn-secondary" onClick={handlePrivateToken}>
              Use Private Integration Token
            </button>
            <small>Scopes required: locations, custom fields, custom values.</small>
          </div>
        </div>
      </div>
    </div>
  );
}

function VoiceAIDashboard({ locations, onShowToast }) {
  const [selectedLocationId, setSelectedLocationId] = useState(
    () => locations?.[0]?.locationId || ''
  );
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [modalState, setModalState] = useState({ open: false, agent: null });
  const [modalSubmitting, setModalSubmitting] = useState(false);

  useEffect(() => {
    if (!selectedLocationId && locations?.length) {
      setSelectedLocationId(locations[0].locationId);
    }
  }, [locations, selectedLocationId]);

  const loadAgents = useCallback(
    async (locationId) => {
      if (!locationId) return;
      setLoading(true);
      try {
        const response = await fetchVoiceAgents(locationId);
        const list = Array.isArray(response?.agents)
          ? response.agents
          : Array.isArray(response?.data)
          ? response.data
          : Array.isArray(response)
          ? response
          : [];
        setAgents(list);
      } catch (error) {
        console.error(error);
        onShowToast?.({
          type: 'error',
          message: error.message || 'Failed to load Voice AI agents'
        });
      } finally {
        setInitialized(true);
        setLoading(false);
      }
    },
    [onShowToast]
  );

  useEffect(() => {
    if (selectedLocationId) {
      loadAgents(selectedLocationId);
    }
  }, [selectedLocationId, loadAgents]);

  const handleDelete = async (agent) => {
    if (!agent?.id || !selectedLocationId) return;
    const confirmed = window.confirm(
      `Delete Voice AI agent “${agent.agentName || agent.name || agent.id}”?`
    );
    if (!confirmed) return;
    try {
      await deleteVoiceAgent(agent.id, selectedLocationId);
      onShowToast?.({ type: 'success', message: 'Voice AI agent deleted' });
      loadAgents(selectedLocationId);
    } catch (error) {
      console.error(error);
      onShowToast?.({
        type: 'error',
        message: error.message || 'Failed to delete Voice AI agent'
      });
    }
  };

  const handleModalSubmit = async (payload) => {
    if (!payload?.locationId) return;
    setModalSubmitting(true);
    try {
      if (modalState.agent) {
        await updateVoiceAgent(modalState.agent.id, payload);
        onShowToast?.({ type: 'success', message: 'Voice AI agent updated' });
      } else {
        await createVoiceAgent(payload);
        onShowToast?.({ type: 'success', message: 'Voice AI agent created' });
      }
      setModalState({ open: false, agent: null });
      loadAgents(payload.locationId);
    } catch (error) {
      console.error(error);
      onShowToast?.({
        type: 'error',
        message: error.message || 'Failed to save Voice AI agent'
      });
    } finally {
      setModalSubmitting(false);
    }
  };

  const locationOptions = useMemo(
    () =>
      (locations || []).map((loc) => ({
        id: loc.locationId,
        name: loc.name || loc.locationId
      })),
    [locations]
  );

  const activeLocationName = locationOptions.find(
    (loc) => loc.id === selectedLocationId
  )?.name;

  return (
    <div className="voice-ai-dashboard">
      <div className="voice-ai-header">
        <div>
          <h1>Voice AI agents</h1>
          <p>
            Manage conversational agents for each location. Create new configurations, update
            prompts, and control post-call automations.
          </p>
        </div>
        <div className="voice-ai-actions">
          <div className="voice-ai-location">
            <label htmlFor="voiceAiLocation">Location</label>
            <select
              id="voiceAiLocation"
              value={selectedLocationId}
              onChange={(event) => setSelectedLocationId(event.target.value)}
            >
              {locationOptions.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {loc.name}
                </option>
              ))}
            </select>
          </div>
          <button
            className="primary"
            type="button"
            onClick={() => setModalState({ open: true, agent: null })}
            disabled={!selectedLocationId}
          >
            + New Voice AI agent
          </button>
        </div>
      </div>

      <div className="voice-ai-table">
        <div className="voice-ai-table-header">
          <span>Name</span>
          <span>Language</span>
          <span>Voice</span>
          <span>Max duration</span>
          <span>Idle reminders</span>
          <span>Inbound number</span>
          <span>Actions</span>
        </div>
        <div className="voice-ai-table-body">
          {loading && !initialized ? (
            <div className="voice-ai-empty">Loading agents…</div>
          ) : agents.length === 0 ? (
            <div className="voice-ai-empty">
              {selectedLocationId
                ? 'No agents yet. Create your first agent for this location.'
                : 'Select a location to view agents.'}
            </div>
          ) : (
            agents.map((agent) => (
              <div key={agent.id} className="voice-ai-row">
                <div className="voice-ai-primary">
                  <strong>{agent.agentName || agent.name || agent.id}</strong>
                  <span className="voice-ai-subtext">
                    {agent.businessName || activeLocationName || '—'}
                  </span>
                </div>
                <span>{agent.language || '—'}</span>
                <span>{agent.voiceId || '—'}</span>
                <span>{formatSeconds(agent.maxCallDuration)}</span>
                <span>
                  {agent.sendUserIdleReminders ? `Yes · ${agent.reminderAfterIdleTimeSeconds || 8}s` : 'No'}
                </span>
                <span>{agent.inboundNumber || '—'}</span>
                <div className="voice-ai-row-actions">
                  <button type="button" onClick={() => setModalState({ open: true, agent })}>
                    Edit
                  </button>
                  <button type="button" className="danger" onClick={() => handleDelete(agent)}>
                    Delete
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <VoiceAgentModal
        open={modalState.open}
        agent={modalState.agent}
        locationId={selectedLocationId}
        submitting={modalSubmitting}
        onClose={() => {
          if (!modalSubmitting) {
            setModalState({ open: false, agent: null });
          }
        }}
        onSubmit={handleModalSubmit}
      />
    </div>
  );
}

function formatSeconds(value) {
  if (!value) return '—';
  const seconds = Number(value);
  if (Number.isNaN(seconds)) return '—';
  const minutes = Math.round(seconds / 60);
  return `${minutes} min`;
}

function VoiceAgentModal({ open, onClose, onSubmit, agent, locationId, submitting }) {
  const defaultForm = useMemo(
    () => ({
      agentName: agent?.agentName || '',
      businessName: agent?.businessName || '',
      welcomeMessage: agent?.welcomeMessage || '',
      agentPrompt: agent?.agentPrompt || '',
      voiceId: agent?.voiceId || '',
      language: agent?.language || 'en-US',
      patienceLevel: agent?.patienceLevel || 'high',
      maxCallDuration: agent?.maxCallDuration || 300,
      sendUserIdleReminders:
        agent?.sendUserIdleReminders !== undefined ? agent.sendUserIdleReminders : true,
      reminderAfterIdleTimeSeconds: agent?.reminderAfterIdleTimeSeconds || 8,
      inboundNumber: agent?.inboundNumber || '',
      numberPoolId: agent?.numberPoolId || '',
      callEndWorkflowIds: Array.isArray(agent?.callEndWorkflowIds)
        ? agent.callEndWorkflowIds.join(', ')
        : '',
      notifyAdmins: agent?.sendPostCallNotificationTo?.admins ?? true,
      notifyAllUsers: agent?.sendPostCallNotificationTo?.allUsers ?? false,
      notifyAssigned: agent?.sendPostCallNotificationTo?.contactAssignedUser ?? false,
      notifySpecificUsers: Array.isArray(agent?.sendPostCallNotificationTo?.specificUsers)
        ? agent.sendPostCallNotificationTo.specificUsers.join(', ')
        : '',
      notifyCustomEmails: Array.isArray(agent?.sendPostCallNotificationTo?.customEmails)
        ? agent.sendPostCallNotificationTo.customEmails.join(', ')
        : '',
      isAgentAsBackupDisabled: agent?.isAgentAsBackupDisabled ?? false,
      translationEnabled: agent?.translation?.enabled ?? false,
      translationLanguage: agent?.translation?.language || agent?.language || 'en-US'
    }),
    [agent]
  );

  const [form, setForm] = useState(defaultForm);

  useEffect(() => {
    if (open) {
      setForm(defaultForm);
    }
  }, [open, defaultForm]);

  useEffect(() => {
    if (form.language === 'en-US' && form.translationEnabled) {
      setForm((prev) => ({ ...prev, translationEnabled: false }));
    }
  }, [form.language, form.translationEnabled]);

  if (!open) {
    return null;
  }

  const handleChange = (field) => (event) => {
    const value =
      event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    const payload = buildVoiceAgentPayload(form, locationId);
    onSubmit(payload);
  };

  const languageOptionsForTranslation = form.language === 'en-US'
    ? ['en-US']
    : [form.language, 'en-US'];

  return (
    <div className={`modal ${open ? 'show' : ''}`}>
      <div className="modal-content large">
        <div className="modal-header">
          <h2>{agent ? 'Edit Voice AI agent' : 'New Voice AI agent'}</h2>
          <button className="close-modal" type="button" onClick={onClose} disabled={submitting}>
            &times;
          </button>
        </div>
        <form className="modal-form voice-agent-form" onSubmit={handleSubmit}>
          <div className="voice-agent-location-note">
            Location: <code>{locationId || '—'}</code>
          </div>
          <div className="voice-agent-field-grid">
            <div className="form-row">
              <label>Agent name</label>
              <input
                value={form.agentName}
                onChange={handleChange('agentName')}
                maxLength={40}
                required
              />
            </div>
            <div className="form-row">
              <label>Business name</label>
              <input
                value={form.businessName}
                onChange={handleChange('businessName')}
              />
            </div>
          </div>
          <div className="form-row">
            <label>Welcome message</label>
            <textarea
              value={form.welcomeMessage}
              onChange={handleChange('welcomeMessage')}
              rows={3}
              maxLength={190}
            />
          </div>
          <div className="form-row">
            <label>Agent prompt</label>
            <textarea
              value={form.agentPrompt}
              onChange={handleChange('agentPrompt')}
              rows={4}
            />
          </div>
          <div className="voice-agent-field-grid">
            <div className="form-row">
              <label>Language</label>
              <select value={form.language} onChange={handleChange('language')}>
                {VOICE_AI_LANGUAGES.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-row">
              <label>Voice ID</label>
              <input value={form.voiceId} onChange={handleChange('voiceId')} />
            </div>
            <div className="form-row">
              <label>Patience level</label>
              <select value={form.patienceLevel} onChange={handleChange('patienceLevel')}>
                {PATIENCE_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-row">
              <label>Max call duration (seconds)</label>
              <input
                type="number"
                min={180}
                max={900}
                value={form.maxCallDuration}
                onChange={handleChange('maxCallDuration')}
              />
            </div>
          </div>
          <div className="voice-agent-field-grid">
            <div className="form-row">
              <label>Send idle reminders</label>
              <input
                type="checkbox"
                checked={form.sendUserIdleReminders}
                onChange={handleChange('sendUserIdleReminders')}
              />
            </div>
            <div className="form-row">
              <label>Reminder after idle (seconds)</label>
              <input
                type="number"
                min={1}
                max={20}
                value={form.reminderAfterIdleTimeSeconds}
                onChange={handleChange('reminderAfterIdleTimeSeconds')}
                disabled={!form.sendUserIdleReminders}
              />
            </div>
            <div className="form-row">
              <label>Inbound number</label>
              <input value={form.inboundNumber} onChange={handleChange('inboundNumber')} />
            </div>
            <div className="form-row">
              <label>Number pool ID</label>
              <input value={form.numberPoolId} onChange={handleChange('numberPoolId')} />
            </div>
          </div>
          <div className="form-row">
            <label>Call-end workflow IDs</label>
            <input
              value={form.callEndWorkflowIds}
              onChange={handleChange('callEndWorkflowIds')}
              placeholder="wf_123, wf_456"
            />
            <small style={{ color: '#6b7280' }}>
              Separate multiple workflow IDs with commas. Up to 10 workflows.
            </small>
          </div>
          <fieldset className="voice-agent-section">
            <legend>Post-call notifications</legend>
            <div className="voice-agent-notifications">
              <label>
                <input
                  type="checkbox"
                  checked={form.notifyAdmins}
                  onChange={handleChange('notifyAdmins')}
                />
                Admins
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={form.notifyAllUsers}
                  onChange={handleChange('notifyAllUsers')}
                />
                All users
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={form.notifyAssigned}
                  onChange={handleChange('notifyAssigned')}
                />
                Contact&apos;s assigned user
              </label>
            </div>
            <div className="form-row">
              <label>Specific user IDs</label>
              <input
                value={form.notifySpecificUsers}
                onChange={handleChange('notifySpecificUsers')}
                placeholder="user_123, user_456"
              />
            </div>
            <div className="form-row">
              <label>Custom email addresses</label>
              <input
                value={form.notifyCustomEmails}
                onChange={handleChange('notifyCustomEmails')}
                placeholder="name@example.com"
              />
            </div>
          </fieldset>
          <fieldset className="voice-agent-section">
            <legend>Advanced settings</legend>
            <div className="voice-agent-field-grid">
              <label className="inline">
                <input
                  type="checkbox"
                  checked={form.isAgentAsBackupDisabled}
                  onChange={handleChange('isAgentAsBackupDisabled')}
                />
                Disable as backup agent
              </label>
              <label className="inline">
                <input
                  type="checkbox"
                  checked={form.translationEnabled}
                  onChange={handleChange('translationEnabled')}
                  disabled={form.language === 'en-US'}
                />
                Enable translation
              </label>
            </div>
            {form.translationEnabled ? (
              <div className="form-row">
                <label>Translation language</label>
                <select
                  value={form.translationLanguage}
                  onChange={handleChange('translationLanguage')}
                >
                  {languageOptionsForTranslation.map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
          </fieldset>
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={submitting}>
              {submitting ? 'Saving…' : 'Save agent'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function buildVoiceAgentPayload(form, locationId) {
  const parseCommaSeparated = (value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 10);

  const clamp = (value, min, max, fallback) => {
    const num = Number(value);
    if (Number.isNaN(num)) return fallback;
    return Math.min(Math.max(num, min), max);
  };

  const payload = {
    locationId,
    agentName: form.agentName || undefined,
    businessName: form.businessName || undefined,
    welcomeMessage: form.welcomeMessage || undefined,
    agentPrompt: form.agentPrompt || undefined,
    voiceId: form.voiceId || undefined,
    language: form.language || 'en-US',
    patienceLevel: form.patienceLevel || 'high',
    maxCallDuration: clamp(form.maxCallDuration, 180, 900, 300),
    sendUserIdleReminders: Boolean(form.sendUserIdleReminders),
    reminderAfterIdleTimeSeconds: clamp(form.reminderAfterIdleTimeSeconds, 1, 20, 8),
    inboundNumber: form.inboundNumber ? form.inboundNumber : null,
    numberPoolId: form.numberPoolId ? form.numberPoolId : null,
    callEndWorkflowIds: parseCommaSeparated(form.callEndWorkflowIds || ''),
    sendPostCallNotificationTo: {
      admins: Boolean(form.notifyAdmins),
      allUsers: Boolean(form.notifyAllUsers),
      contactAssignedUser: Boolean(form.notifyAssigned),
      specificUsers: parseCommaSeparated(form.notifySpecificUsers || ''),
      customEmails: parseCommaSeparated(form.notifyCustomEmails || '')
    },
    isAgentAsBackupDisabled: Boolean(form.isAgentAsBackupDisabled),
    translation: {
      enabled: Boolean(form.translationEnabled),
      language: form.translationEnabled
        ? form.translationLanguage || form.language || 'en-US'
        : undefined
    }
  };

  if (!payload.translation.enabled || payload.language === 'en-US') {
    payload.translation = { enabled: false };
  }

  return payload;
}

function ShareLinkModal({ modal, onClose, onRetry }) {
  const { open, status, link, error } = modal;
  const [copied, setCopied] = useState(false);
  const [burstKey, setBurstKey] = useState(0);

  useEffect(() => {
    if (open && status === 'success') {
      setBurstKey((prev) => prev + 1);
    }
  }, [open, status]);

  useEffect(() => {
    if (!open) {
      setCopied(false);
    }
  }, [open, link]);

  if (!open) {
    return null;
  }

  const handleCopy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error(err);
    }
  };

  const canClose = status !== 'loading';

  return (
    <div className={`modal ${open ? 'show' : ''}`}>
      <div className="modal-content share-modal">
        {status === 'success' ? <ConfettiBurst key={burstKey} /> : null}
        <div className="modal-header">
          <h2>{status === 'success' ? 'Share link ready' : 'Generating share link'}</h2>
          <button
            className="close-modal"
            type="button"
            onClick={onClose}
            disabled={!canClose}
          >
            &times;
          </button>
        </div>

        {status === 'loading' ? (
          <div className="share-status">
            <div className="share-loading-spinner" />
            <p>Hold tight! We&apos;re preparing your share link.</p>
          </div>
        ) : null}

        {status === 'success' ? (
          <div className="share-status success">
            <p>Your wizard is ready to share. Copy the link or open it in a new tab.</p>
            <div className="share-link-box">
              <a href={link} target="_blank" rel="noopener noreferrer">
                {link}
              </a>
            </div>
            <div className="share-actions">
              <button type="button" className="secondary" onClick={handleCopy}>
                {copied ? 'Copied!' : 'Copy link'}
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => link && window.open(link, '_blank', 'noopener,noreferrer')}
                disabled={!link}
              >
                Open link
              </button>
            </div>
          </div>
        ) : null}

        {status === 'error' ? (
          <div className="share-status error">
            <p>{error || 'We couldn’t generate the link. Please try again.'}</p>
            <div className="share-actions">
              <button type="button" className="secondary" onClick={onClose}>
                Close
              </button>
              <button type="button" className="primary" onClick={onRetry}>
                Try again
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ConfettiBurst({ count = 28 }) {
  const colors = useMemo(
    () => ['#6366f1', '#f97316', '#10b981', '#facc15', '#ec4899'],
    []
  );
  const pieces = useMemo(
    () =>
      Array.from({ length: count }).map(() => ({
        left: Math.random() * 100,
        delay: Math.random() * 0.3,
        duration: 1.2 + Math.random() * 0.8,
        size: 6 + Math.random() * 8,
        color: colors[Math.floor(Math.random() * colors.length)],
        rotation: Math.random() * 360
      })),
    [count, colors]
  );

  return (
    <div className="confetti-burst" aria-hidden="true">
      {pieces.map((piece, index) => (
        <span
          key={index}
          className="confetti-piece"
          style={{
            left: `${piece.left}%`,
            animationDelay: `${piece.delay}s`,
            animationDuration: `${piece.duration}s`,
            width: piece.size,
            height: piece.size,
            background: piece.color,
            transform: `rotate(${piece.rotation}deg)`
          }}
        />
      ))}
    </div>
  );
}

function WizardRow({ template, locations, onEdit, onCopyLink, onClone, onDelete }) {
  const stats = template.stats || {};
  const updated = template.metadata?.updatedAt || template.updatedAt;
  const locationName =
    locations.find((loc) => loc.locationId === template.locationId)?.name ||
    template.locationId ||
    '—';
  const lastSubmission = stats.lastSubmittedAt
    ? formatRelativeTime(stats.lastSubmittedAt)
    : '—';
  const issued = stats.issuedCount || 0;
  const submitted = stats.submittedCount || 0;
  const publicUrl = stats.latestPublicUrl;

  return (
    <div className="wizard-row">
      <div className="wizard-cell wizard-name">
        <div className="wizard-name-main">
          <span className="wizard-title">{template.name}</span>
          <span className="wizard-updated">
            {updated ? `Updated ${formatRelativeTime(updated)}` : 'Never updated'}
          </span>
        </div>
        {template.description ? (
          <div className="wizard-description">{template.description}</div>
        ) : null}
      </div>
      <div className="wizard-cell wizard-status">
        <span className={`wizard-status-badge status-${template.status}`}>
          {template.status === 'published' ? 'Published' : 'Draft'}
        </span>
      </div>
      <div className="wizard-cell wizard-location">{locationName}</div>
      <div className="wizard-cell wizard-stat">{issued}</div>
      <div className="wizard-cell wizard-stat">{submitted}</div>
      <div className="wizard-cell wizard-last">{lastSubmission}</div>
      <div className="wizard-cell wizard-actions">
        <button className="secondary" onClick={() => onEdit(template.id)}>
          Edit Wizard
        </button>
        <button
          className="secondary"
          onClick={() => onClone?.(template)}
        >
          Clone Wizard
        </button>
        <button
          className="secondary"
          onClick={() => onCopyLink(publicUrl)}
          disabled={!publicUrl}
        >
          Copy Link
        </button>
        {publicUrl ? (
          <a
            className="link-button"
            href={publicUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open Link
          </a>
        ) : null}
        <button
          className="danger"
          onClick={() => onDelete?.(template)}
        >
          Delete Wizard
        </button>
      </div>
    </div>
  );
}

function CreateWizardModal({ open, onClose, form, setForm, locations, onSubmit, submitting }) {
  return (
    <div className={`modal ${open ? 'show' : ''}`}>
      <div className="modal-content">
        <div className="modal-header">
          <h2>New Onboarding Wizard</h2>
          <button className="close-modal" onClick={onClose}>&times;</button>
        </div>
        <form onSubmit={onSubmit} className="modal-form">
          <div className="form-row">
            <label htmlFor="wizardName">Wizard name</label>
            <input
              id="wizardName"
              type="text"
              value={form.name}
              onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
              required
            />
          </div>
          <div className="form-row">
            <label htmlFor="wizardDescription">Description</label>
            <textarea
              id="wizardDescription"
              rows={3}
              value={form.description}
              onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
            />
          </div>
          <div className="form-row">
            <label htmlFor="wizardLocation">Location</label>
            <select
              id="wizardLocation"
              value={form.locationId}
              onChange={(event) =>
                setForm((prev) => ({
                  ...prev,
                  locationId: event.target.value || ''
                }))
              }
            >
              <option value="">Select a location (optional)</option>
              {locations.map((loc) => (
                <option
                  key={loc.locationId}
                  value={loc.locationId}
                >
                  {loc.name || loc.locationId}
                </option>
              ))}
            </select>
          </div>
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={submitting}>
              {submitting ? 'Creating…' : 'Create wizard'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function DeleteWizardModal({ modal, onClose, onChange, onConfirm }) {
  const { open, template, challenge, input, submitting } = modal || {};
  if (!open || !template) return null;

  const confirmationCode = (challenge || '').toUpperCase();
  const normalizedInput = (input || '').trim().toUpperCase();
  const disableDelete = submitting || normalizedInput !== confirmationCode;

  return (
    <div className={`modal ${open ? 'show' : ''}`}>
      <div className="modal-content delete-modal">
        <div className="modal-header">
          <h2>Delete Wizard</h2>
          <button className="close-modal" onClick={onClose} disabled={submitting}>
            &times;
          </button>
        </div>
        <div className="modal-body">
          <p>
            Deleting <strong>{template.name}</strong> removes the wizard configuration and cannot
            be undone.
          </p>
          <p>
            Type{' '}
            <span className="challenge-code" aria-label="Confirmation code">
              {confirmationCode}
            </span>{' '}
            to confirm this action.
          </p>
          <input
            type="text"
            value={input}
            onChange={(event) => onChange(event.target.value)}
            placeholder="Enter confirmation code"
            spellCheck={false}
            autoComplete="off"
            disabled={submitting}
          />
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            className="danger"
            onClick={onConfirm}
            disabled={disableDelete}
          >
            {submitting ? 'Deleting…' : 'Delete wizard'}
          </button>
        </div>
      </div>
    </div>
  );
}

function BuilderHeader({
  wizard,
  dirty,
  saving,
  publishing,
  locations = [],
  onSaveDraft,
  onPreview,
  onPublish,
  onIssueLink,
  onExit,
  issuing = false
}) {
  const linkedLocation =
    locations.find((loc) => loc.locationId === wizard.locationId) || null;
  const locationLabel = linkedLocation?.name || wizard.locationId || '';
  return (
    <header className="builder-header">
      <div>
        <h1 style={{ color: '#f9fafb' }}>{wizard.name || 'Untitled Wizard'}</h1>
        <div
          style={{
            fontSize: 13,
            color: 'rgba(249, 250, 251, 0.82)'
          }}
        >
          {locationLabel
            ? `Linked location: ${locationLabel}`
            : 'Select a location to begin'}
          {dirty ? ' • Unsaved changes' : ''}
        </div>
      </div>
      <div className="builder-header-actions">
        {onExit ? (
          <button className="secondary" onClick={onExit}>
            ← Back to Wizards
          </button>
        ) : null}
        <button
          className="secondary"
          onClick={onSaveDraft}
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Save Draft'}
        </button>
        <button
          className="secondary"
          onClick={onPreview}
        >
          Preview
        </button>
        <button
          className="secondary"
          onClick={onIssueLink}
          disabled={!wizard.id || !wizard.locationId || issuing}
        >
          {issuing ? 'Generating…' : 'Share Link'}
        </button>
        <button
          className="primary"
          onClick={onPublish}
          disabled={publishing || !wizard.locationId}
        >
          {publishing ? 'Publishing…' : 'Publish'}
        </button>
      </div>
    </header>
  );
}

function BuilderSidebar({ state, actions, selectedPage }) {
  const [newPageTitle, setNewPageTitle] = useState('');
  const locations = state.bootstrap.locations || [];
  const [renameModal, setRenameModal] = useState({
    open: false,
    pageId: null,
    value: ''
  });
  const renameInputRef = useRef(null);

  const addPage = () => {
    const title = newPageTitle.trim() || `Page ${state.wizard.pages.length + 1}`;
    actions.addPage({ title });
    setNewPageTitle('');
  };

  const handleLocationChange = (event) => {
    actions.updateWizardMeta({
      locationId: event.target.value || ''
    });
  };

  useEffect(() => {
    if (renameModal.open && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renameModal.open]);

  const openRenameModal = (page) => {
    setRenameModal({
      open: true,
      pageId: page.id,
      value: page.title || ''
    });
  };

  const closeRenameModal = () => {
    setRenameModal({
      open: false,
      pageId: null,
      value: ''
    });
  };

  const handleRenameSubmit = (event) => {
    event.preventDefault();
    const nextTitle = renameModal.value.trim();
    if (renameModal.pageId && nextTitle) {
      actions.updatePage(renameModal.pageId, { title: nextTitle });
    }
    closeRenameModal();
  };

  const selectedLocationValue = state.wizard.locationId || '';

  return (
    <>
      <aside className="builder-sidebar">
        <section className="sidebar-section">
          <h2>Wizard details</h2>
        <div className="form-row">
          <label>Wizard name</label>
          <input
            value={state.wizard.name}
            onChange={(event) => actions.updateWizardMeta({ name: event.target.value })}
            placeholder="Acme onboarding"
          />
        </div>
        <div className="form-row">
          <label>Description</label>
          <textarea
            value={state.wizard.description || ''}
            onChange={(event) => actions.updateWizardMeta({ description: event.target.value })}
            placeholder="Explain the purpose of this wizard"
            rows={3}
          />
        </div>
        <div className="form-row">
          <label>Location</label>
          <select
            value={selectedLocationValue}
            onChange={handleLocationChange}
          >
            <option value="">Select a location</option>
            {locations.map((loc) => (
              <option
                key={loc.locationId}
                value={loc.locationId}
              >
                {loc.name || loc.locationId}
              </option>
            ))}
          </select>
        </div>
        </section>

        <section className="sidebar-section">
          <h2>Pages</h2>
        <Droppable droppableId="pages" type={PageDragType.PAGE}>
          {(provided) => (
            <ul
              className="page-list"
              ref={provided.innerRef}
              {...provided.droppableProps}
            >
              {state.wizard.pages.map((page, index) => (
                <Draggable draggableId={page.id} index={index} key={page.id}>
                  {(draggableProvided, snapshot) => (
                    <li
                      ref={draggableProvided.innerRef}
                      {...draggableProvided.draggableProps}
                      {...draggableProvided.dragHandleProps}
                      className={`page-item ${
                        state.selectedPageId === page.id ? 'active' : ''
                      } ${snapshot.isDragging ? 'dragging' : ''}`}
                      onClick={() => actions.selectPage(page.id)}
                    >
                      <span>{page.title}</span>
                      <div className="page-actions">
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            openRenameModal(page);
                          }}
                        >
                          ✎
                        </button>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            if (state.wizard.pages.length === 1) return;
                            if (window.confirm('Remove this page and all of its blocks?')) {
                              actions.removePage(page.id);
                            }
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    </li>
                  )}
                </Draggable>
              ))}
              {provided.placeholder}
            </ul>
          )}
        </Droppable>
        <div className="form-row">
          <label htmlFor="newPage">Add page</label>
          <div className="add-page-row">
            <input
              id="newPage"
              value={newPageTitle}
              onChange={(event) => setNewPageTitle(event.target.value)}
              placeholder="Page title"
            />
            <button type="button" className="add-page-btn" onClick={addPage}>
              + Add page
            </button>
          </div>
        </div>
        </section>

        <section className="sidebar-section">
          <h2>Add blocks</h2>
        <div className="palette-grid">
          {BLOCK_LIBRARY.map((item) => (
            <button
              key={item.type}
              type="button"
              className="palette-item"
              onClick={() =>
                selectedPage
                  ? actions.addBlock(selectedPage.id, item.type)
                  : null
              }
              disabled={!selectedPage}
            >
              <strong>{item.name}</strong>
              <span>{item.description}</span>
            </button>
          ))}
        </div>
        </section>

        <section className="sidebar-section">
          <ThemeDesigner wizard={state.wizard} onChange={actions.setTheme} />
        </section>
      </aside>

      <div className={`modal ${renameModal.open ? 'show' : ''}`}>
        <div className="modal-content">
          <div className="modal-header">
            <h2>Rename page</h2>
            <button className="close-modal" type="button" onClick={closeRenameModal}>
              &times;
            </button>
          </div>
          <form className="modal-form" onSubmit={handleRenameSubmit}>
            <div className="form-row">
              <label htmlFor="renamePageInput">Page name</label>
              <input
                id="renamePageInput"
                ref={renameInputRef}
                value={renameModal.value}
                onChange={(event) =>
                  setRenameModal((prev) => ({ ...prev, value: event.target.value }))
                }
                placeholder="Enter a page title"
              />
            </div>
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={closeRenameModal}>
                Cancel
              </button>
              <button
                type="submit"
                className="primary"
                disabled={!renameModal.value.trim()}
              >
                Save
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}

function BuilderCanvas({ selectedPage, actions, library, libraryStatus }) {
  const [expandedBlockId, setExpandedBlockId] = useState(null);

  useEffect(() => {
    if (!selectedPage) {
      setExpandedBlockId(null);
    } else if (!selectedPage.blocks.find((block) => block.id === expandedBlockId)) {
      setExpandedBlockId(null);
    }
  }, [selectedPage, expandedBlockId]);

  if (!selectedPage) {
    return (
      <section className="builder-canvas">
        <div className="canvas-header">
          <h2>No page selected</h2>
        </div>
        <div className="empty-state">
          Create a page from the sidebar to start designing your wizard.
        </div>
      </section>
    );
  }

  return (
    <section className="builder-canvas">
      <div className="canvas-header">
        <div>
          <h2>{selectedPage.title}</h2>
          <small style={{ color: '#6b7280' }}>
            {selectedPage.blocks.length} block
            {selectedPage.blocks.length === 1 ? '' : 's'}
          </small>
        </div>
        <button
          type="button"
          className="add-block-btn"
          onClick={() => actions.addBlock(selectedPage.id, BLOCK_TYPES.TEXT)}
        >
          + Add instructions
        </button>
      </div>
      {libraryStatus?.loading ? (
        <div style={{ color: '#6b7280', fontSize: 13 }}>Loading location assets…</div>
      ) : null}
      {!libraryStatus?.loading && libraryStatus?.error ? (
        <div style={{ color: '#dc2626', fontSize: 13 }}>{libraryStatus.error}</div>
      ) : null}
      <Droppable
        droppableId={`blocks-${selectedPage.id}`}
        type={PageDragType.BLOCK}
      >
        {(provided) => (
          <div
            className="canvas-stage"
            ref={provided.innerRef}
            {...provided.droppableProps}
          >
            {selectedPage.blocks.length === 0 ? (
              <div className="empty-state">
                Use the palette to add fields, uploads, trigger links, or
                instruction blocks.
              </div>
            ) : null}
            {selectedPage.blocks.map((block, index) => (
              <Draggable draggableId={block.id} index={index} key={block.id}>
                {(draggableProvided, snapshot) => (
                  <div
                    ref={draggableProvided.innerRef}
                    {...draggableProvided.draggableProps}
                    {...draggableProvided.dragHandleProps}
                    className={`block-card ${
                      snapshot.isDragging ? 'dragging' : ''
                    }`}
                  >
                    <BlockCard
                      block={block}
                      onUpdate={(patch) =>
                        actions.updateBlock(selectedPage.id, block.id, patch)
                      }
                      onRemove={() =>
                        actions.removeBlock(selectedPage.id, block.id)
                      }
                      library={library}
                      expanded={expandedBlockId === block.id}
                      onToggleExpand={() =>
                        setExpandedBlockId((prev) =>
                          prev === block.id ? null : block.id
                        )
                      }
                    />
                  </div>
                )}
              </Draggable>
            ))}
            {provided.placeholder}
          </div>
        )}
      </Droppable>
    </section>
  );
}

function BlockCard({
  block,
  onUpdate,
  onRemove,
  library,
  expanded,
  onToggleExpand
}) {
  const toggleRequired = () => {
    onUpdate({ required: !block.required });
  };
  const isTextBlock = block.type === BLOCK_TYPES.TEXT;
  const isVoiceAgentBlock = block.type === BLOCK_TYPES.VOICE_AGENT;
  const isSocialBlock = block.type === BLOCK_TYPES.SOCIAL_PROFILE;
  const blockSummary =
    isTextBlock
      ? summariseTextContent(block.content)
      : isVoiceAgentBlock
      ? summariseVoiceAgent(block)
      : isSocialBlock
      ? summariseSocialProfileBlock(block)
      : block.helperText || 'Click edit to configure this block';

  return (
    <>
      <div className="block-card-header">
        <span>
          {block.title}{' '}
          <span style={{ color: '#9ca3af', fontSize: 12 }}>
            ({formatBlockType(block.type)})
          </span>
        </span>
        <div className="block-card-actions">
          {!isTextBlock ? (
            <button type="button" onClick={toggleRequired}>
              {block.required ? 'Required' : 'Optional'}
            </button>
          ) : null}
          <button type="button" onClick={onToggleExpand}>
            {expanded ? 'Collapse' : 'Edit'}
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => {
              if (window.confirm('Remove this block?')) onRemove();
            }}
          >
            Delete
          </button>
        </div>
      </div>
      {expanded ? (
        <BlockForm block={block} onUpdate={onUpdate} library={library} />
      ) : (
        <div className="block-meta">{blockSummary}</div>
      )}
    </>
  );
}

function BlockForm({ block, onUpdate, library }) {
  const handleChange = (field) => (event) => {
    const value =
      event.target.type === 'checkbox'
        ? event.target.checked
        : event.target.value;
    onUpdate({ [field]: value });
  };

  const updateNewEntity = (key, value) => {
    const next = { ...(block.newEntity || {}), [key]: value };
    onUpdate({ newEntity: next });
  };

  const handleModeChange = (event) => {
    onUpdate({
      mode: event.target.value,
      referenceId: null,
      newEntity: {}
    });
  };

  const availableOptions = useMemo(() => {
    switch (block.type) {
      case BLOCK_TYPES.CUSTOM_FIELD:
        return (library.customFields || []).map((item, index) => ({
          id: item.id || item.fieldKey || `field-${index}`,
          label: item.name,
          raw: item
        }));
      case BLOCK_TYPES.CUSTOM_VALUE:
        return (library.customValues || []).map((item, index) => ({
          id: item.id || item.name || `value-${index}`,
          label: item.name,
          raw: item
        }));
      case BLOCK_TYPES.TRIGGER_LINK:
        return (library.triggerLinks || []).map((item, index) => ({
          id: item.id || item.name || `link-${index}`,
          label: item.name,
          raw: item
        }));
      case BLOCK_TYPES.TAG:
        return (library.tags || []).map((item, index) => ({
          id: item.id || item.name || `tag-${index}`,
          label: item.name,
          raw: item
        }));
      case BLOCK_TYPES.VOICE_AGENT:
        return (library.voiceAgents || []).map((item, index) => ({
          id: item.id || `voice-agent-${index}`,
          label: item.agentName || item.name || `Agent ${index + 1}`,
          raw: item
        }));
      case BLOCK_TYPES.MEDIA:
      default:
        return [];
    }
  }, [block.type, library]);

  const isTextBlock = block.type === BLOCK_TYPES.TEXT;
  const textVariant = block.textVariant || 'paragraph';

  if (isTextBlock) {
    return (
      <div className="block-form">
        <div className="form-row">
          <label>Title (builder only)</label>
          <input value={block.title} onChange={handleChange('title')} placeholder="Content block" />
          <small style={{ color: '#6b7280' }}>
            This title helps you recognise the block inside the builder. It isn&apos;t shown to customers.
          </small>
        </div>
        <div className="form-row">
          <label>Content style</label>
          <select
            value={textVariant}
            onChange={(event) => onUpdate({ textVariant: event.target.value })}
          >
            {TEXT_BLOCK_VARIANTS.map((variant) => (
              <option key={variant.value} value={variant.value}>
                {variant.label}
              </option>
            ))}
          </select>
          <small style={{ color: '#6b7280' }}>
            Choose how this content should appear inside the wizard.
          </small>
        </div>
        <div className="form-row">
          <label>Content</label>
          <textarea
            value={block.content || ''}
            onChange={handleChange('content')}
            rows={textVariant === 'paragraph' ? 4 : 6}
          />
          <small style={{ color: '#6b7280' }}>
            Use line breaks to create separate items for bullet or numbered lists.
          </small>
        </div>
      </div>
    );
  }

  if (block.type === BLOCK_TYPES.VOICE_AGENT) {
    const selectedAgents = block.settings?.voiceAgents || [];
    const allowMultiple = Boolean(block.settings?.allowMultiple);
    const selectedIds = new Set(selectedAgents.map((agent) => agent.id));
    const toggleAgent = (option) => {
      const optionId = option.id || option.label;
      const existing = selectedAgents.find((item) => item.id === optionId);
      const next = existing
        ? selectedAgents.filter((item) => item.id !== optionId)
        : [
            ...(allowMultiple ? selectedAgents : []),
            {
              id: optionId,
              agentName: option.raw?.agentName || option.label,
              language: option.raw?.language || 'en-US',
              voiceId: option.raw?.voiceId || ''
            }
          ];
      onUpdate({
        settings: {
          ...block.settings,
          voiceAgents: next
        }
      });
    };

    return (
      <div className="block-form">
        <div className="form-row">
          <label>Label</label>
          <input
            value={block.title}
            onChange={handleChange('title')}
            placeholder="Voice AI Agent"
          />
        </div>
        <div className="form-row">
          <label>Helper text</label>
          <textarea
            value={block.helperText}
            onChange={handleChange('helperText')}
            rows={2}
            placeholder="Explain how the client should choose a Voice AI agent."
          />
        </div>
        <div className="form-row">
          <label>Allow multiple selections</label>
          <input
            type="checkbox"
            checked={Boolean(block.settings?.allowMultiple)}
            onChange={(event) =>
              onUpdate({
                settings: {
                  ...block.settings,
                  allowMultiple: event.target.checked
                }
              })
            }
          />
        </div>
        <div className="form-row">
          <label>Voice AI agents</label>
          {availableOptions.length === 0 ? (
            <div className="empty-state small">
              No voice AI agents available yet. Create them from the Voice AI tab.
            </div>
          ) : (
            <div className="voice-agent-options">
              {availableOptions.map((option) => {
                const optionId = option.id || option.label;
                const isChecked = selectedIds.has(optionId);
                return (
                  <label key={optionId} className="voice-agent-option">
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => toggleAgent(option)}
                    />
                    <div>
                      <strong>{option.label}</strong>
                      <div className="voice-agent-meta">
                        <span>{option.raw?.language || '—'}</span>
                        {option.raw?.voiceId ? <span>Voice {option.raw.voiceId}</span> : null}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (block.type === BLOCK_TYPES.SOCIAL_PROFILE) {
    const selectedPlatforms = Array.isArray(block.settings?.platforms)
      ? block.settings.platforms
      : ['google'];
    const instructionsValue = block.settings?.instructions || '';
    const ctaLabel = block.settings?.ctaLabel || 'Connect account';

    const togglePlatform = (platformId) => {
      const available = SOCIAL_PLATFORM_OPTIONS.find((option) => option.id === platformId);
      if (!available || !available.available) return;
      const has = selectedPlatforms.includes(platformId);
      let next = [];
      if (has) {
        next = selectedPlatforms.filter((item) => item !== platformId);
        if (next.length === 0) {
          next = ['google'];
        }
      } else {
        next = [...selectedPlatforms, platformId];
      }
      onUpdate({
        settings: {
          ...block.settings,
          platforms: next
        }
      });
    };

    return (
      <div className="block-form">
        <div className="form-row">
          <label>Label</label>
          <input
            value={block.title}
            onChange={handleChange('title')}
            placeholder="Connect Social Profiles"
          />
        </div>
        <div className="form-row">
          <label>Platforms</label>
          <div className="checkbox-grid">
            {SOCIAL_PLATFORM_OPTIONS.map((option) => {
              const checked = selectedPlatforms.includes(option.id);
              return (
                <label
                  key={option.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    opacity: option.available ? 1 : 0.5,
                    cursor: option.available ? 'pointer' : 'not-allowed'
                  }}
                >
                  <input
                    type="checkbox"
                    disabled={!option.available}
                    checked={checked}
                    onChange={() => togglePlatform(option.id)}
                  />
                  <span>{option.label}{!option.available ? ' (coming soon)' : ''}</span>
                </label>
              );
            })}
          </div>
          <small style={{ color: '#6b7280' }}>
            Choose which platforms should be displayed inside the onboarding wizard.
          </small>
        </div>
        <div className="form-row">
          <label>Instructions</label>
          <textarea
            value={instructionsValue}
            onChange={(event) =>
              onUpdate({
                settings: {
                  ...block.settings,
                  instructions: event.target.value
                }
              })
            }
            rows={3}
            placeholder="Let clients know why you need access or how it will be used."
          />
        </div>
        <div className="form-row">
          <label>Button label</label>
          <input
            value={ctaLabel}
            onChange={(event) =>
              onUpdate({
                settings: {
                  ...block.settings,
                  ctaLabel: event.target.value
                }
              })
            }
            placeholder="Connect account"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="block-form">
      <div className="form-row">
        <label>Label</label>
        <input value={block.title} onChange={handleChange('title')} />
      </div>
      <div className="form-row">
        <label>Helper text</label>
        <textarea
          value={block.helperText}
          onChange={handleChange('helperText')}
          rows={2}
        />
      </div>
      {block.type !== BLOCK_TYPES.TEXT && block.type !== BLOCK_TYPES.MEDIA ? (
        <>
          <div className="form-row">
            <label>Source</label>
            <select value={block.mode} onChange={handleModeChange}>
              <option value="existing">Use existing</option>
              <option value="create">Create new</option>
            </select>
          </div>
          {block.mode === 'existing' ? (
            <div className="form-row">
              <label>Choose item</label>
              <select
                value={block.referenceId || ''}
                onChange={(event) =>
                  onUpdate({ referenceId: event.target.value })
                }
              >
                <option value="">Select an item</option>
                {availableOptions.map((option, index) => {
                  const optionValue = option.id || option.label || `option-${index}`;
                  return (
                    <option key={`${optionValue}-${index}`} value={optionValue}>
                      {option.label || optionValue}
                    </option>
                  );
                })}
              </select>
            </div>
          ) : (
            <>
              <div className="form-row">
                <label>New item name</label>
                <input
                  value={block.newEntity?.name || ''}
                  onChange={(event) => updateNewEntity('name', event.target.value)}
                />
              </div>
              {block.type === BLOCK_TYPES.CUSTOM_FIELD ? (
                <>
                  <div className="form-row">
                    <label>Data type</label>
                    <select
                      value={block.newEntity?.dataType || 'TEXT'}
                      onChange={(event) => updateNewEntity('dataType', event.target.value)}
                    >
                      {CUSTOM_FIELD_TYPES.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-row">
                    <label>Placeholder</label>
                    <input
                      value={block.newEntity?.placeholder || ''}
                      onChange={(event) => updateNewEntity('placeholder', event.target.value)}
                    />
                  </div>
                </>
              ) : null}
              {block.type === BLOCK_TYPES.TRIGGER_LINK ? (
                <div className="form-row">
                  <label>Default redirect URL</label>
                  <input
                    value={block.newEntity?.redirectTo || ''}
                    onChange={(event) => updateNewEntity('redirectTo', event.target.value)}
                    placeholder="https://example.com/"
                  />
                </div>
              ) : null}
            </>
          )}
        </>
      ) : null}
      {block.type === BLOCK_TYPES.MEDIA ? (
        <>
          <div className="form-row">
            <label>Allow multiple files</label>
            <input
              type="checkbox"
              checked={Boolean(block.settings?.multiple)}
              onChange={(event) =>
                onUpdate({
                  settings: {
                    ...block.settings,
                    multiple: event.target.checked
                  }
                })
              }
            />
          </div>
          <div className="form-row">
            <label>Allowed file types</label>
            <select
              value={block.settings?.accept || '*/*'}
              onChange={(event) =>
                onUpdate({
                  settings: {
                    ...block.settings,
                    accept: event.target.value
                  }
                })
              }
            >
              <option value="image/*">Images only</option>
              <option value="*/*">Any file</option>
            </select>
          </div>
        </>
      ) : null}
    </div>
  );
}

function ThemeDesigner({ wizard, onChange }) {
  const theme = wizard.theme || {};
  const [uploading, setUploading] = useState(false);
  const coalesceColor = (value, fallback) => {
    if (!value) return fallback;
    const trimmed = String(value).trim();
    return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed.toLowerCase() : fallback;
  };
  const defaults = {
    primaryColor: '#4f46e5',
    accentColor: '#6366f1',
    backgroundColor: '#ffffff'
  };
  const isDefaultColor = (field) =>
    coalesceColor(theme[field], defaults[field]) === defaults[field];
  const [colorInputs, setColorInputs] = useState({
    primaryColor: coalesceColor(theme.primaryColor, defaults.primaryColor),
    accentColor: coalesceColor(theme.accentColor, defaults.accentColor),
    backgroundColor: coalesceColor(theme.backgroundColor, defaults.backgroundColor)
  });

  useEffect(() => {
    setColorInputs({
      primaryColor: coalesceColor(theme.primaryColor, defaults.primaryColor),
      accentColor: coalesceColor(theme.accentColor, defaults.accentColor),
      backgroundColor: coalesceColor(theme.backgroundColor, defaults.backgroundColor)
    });
  }, [theme.primaryColor, theme.accentColor, theme.backgroundColor]);

  const handleChange = (field) => (event) => {
    onChange({ [field]: event.target.value });
  };

  const handleNumberChange = (field) => (event) => {
    onChange({ [field]: event.target.value });
  };

  const handleToggleProgress = (event) => {
    onChange({ showProgress: event.target.checked });
  };

  const handleLogoUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    setUploading(true);
    try {
      const res = await fetch('/api/onboarding/builder/logo', {
        method: 'POST',
        body: formData
      });
      if (!res.ok) {
        throw new Error('Logo upload failed');
      }
      const data = await res.json();
      onChange({
        logoUrl: data.url,
        logoStorageKey: data.storageKey
      });
    } catch (error) {
      console.error(error);
      alert(error.message || 'Logo upload failed');
    } finally {
      setUploading(false);
      event.target.value = '';
    }
  };

  const handleRemoveLogo = () => {
    onChange({ logoUrl: '', logoStorageKey: '', logoWidth: '', logoHeight: '' });
  };

  const handleColorPicker = (field) => (event) => {
    const value = event.target.value;
    setColorInputs((prev) => ({ ...prev, [field]: value }));
    onChange({ [field]: value });
  };

  const handleColorHexChange = (field) => (event) => {
    let value = event.target.value.trim();
    if (value && !value.startsWith('#')) {
      value = `#${value}`;
    }
    value = value.replace(/[^#0-9a-fA-F]/g, '').slice(0, 7).toLowerCase();
    setColorInputs((prev) => ({ ...prev, [field]: value }));
    if (/^#[0-9a-f]{6}$/i.test(value)) {
      onChange({ [field]: value });
    }
  };

  const handleColorHexBlur = (field) => () => {
    setColorInputs((prev) => {
      const current = prev[field];
      if (/^#[0-9a-f]{6}$/i.test(current)) {
        return prev;
      }
      const resetValue = theme[field] || defaults[field];
      return { ...prev, [field]: resetValue };
    });
  };

  const handleColorReset = (field) => () => {
    const resetValue = defaults[field];
    setColorInputs((prev) => ({ ...prev, [field]: resetValue }));
    onChange({ [field]: resetValue });
  };

  return (
    <>
      <h2>Branding</h2>
      <div className="theme-logo-upload">
        {theme.logoUrl ? (
          <img src={theme.logoUrl} alt="Logo preview" />
        ) : (
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: 16,
              display: 'grid',
              placeItems: 'center',
              background: theme.primaryColor || '#4f46e5',
              color: '#ffffff',
              fontWeight: 700
            }}
          >
            LOGO
          </div>
        )}
        <div className="theme-logo-actions">
          <label>
            <span>{uploading ? 'Uploading…' : theme.logoUrl ? 'Replace logo' : 'Upload logo'}</span>
            <input
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={handleLogoUpload}
              disabled={uploading}
            />
          </label>
          {theme.logoUrl ? (
            <button type="button" className="remove" onClick={handleRemoveLogo}>
              Remove
            </button>
          ) : null}
        </div>
      </div>
      <div className="form-row">
        <label>Logo URL (optional)</label>
        <input
          value={theme.logoUrl || ''}
          onChange={handleChange('logoUrl')}
          placeholder="https://..."
        />
        <small style={{ color: '#6b7280' }}>
          Upload above or paste a direct image URL.
        </small>
      </div>
      <div className="form-row">
        <label>Logo fit</label>
        <select value={theme.logoFit || 'contain'} onChange={handleChange('logoFit')}>
          <option value="contain">Contain</option>
          <option value="cover">Cover</option>
          <option value="fill">Fill</option>
          <option value="auto">Original</option>
        </select>
      </div>
      <div className="form-row">
        <label>Logo dimensions (px)</label>
        <div style={{ display: 'flex', gap: 10 }}>
          <input
            type="number"
            min="0"
            placeholder="Width"
            value={theme.logoWidth || ''}
            onChange={handleNumberChange('logoWidth')}
          />
          <input
            type="number"
            min="0"
            placeholder="Height"
            value={theme.logoHeight || ''}
            onChange={handleNumberChange('logoHeight')}
          />
        </div>
        <small style={{ color: '#6b7280' }}>
          Leave blank to use the image&apos;s natural size.
        </small>
      </div>
      <div className="form-row">
        <label>Primary color</label>
        <div className="color-input-group">
          <input
            type="color"
            className="color-picker"
            value={colorInputs.primaryColor}
            onChange={handleColorPicker('primaryColor')}
          />
          <input
            type="text"
            className="color-hex"
            value={colorInputs.primaryColor}
            onChange={handleColorHexChange('primaryColor')}
            onBlur={handleColorHexBlur('primaryColor')}
            placeholder="#4f46e5"
          />
          <button
            type="button"
            className="color-reset"
            onClick={handleColorReset('primaryColor')}
            disabled={isDefaultColor('primaryColor')}
          >
            Reset
          </button>
        </div>
      </div>
      <div className="form-row">
        <label>Accent color</label>
        <div className="color-input-group">
          <input
            type="color"
            className="color-picker"
            value={colorInputs.accentColor}
            onChange={handleColorPicker('accentColor')}
          />
          <input
            type="text"
            className="color-hex"
            value={colorInputs.accentColor}
            onChange={handleColorHexChange('accentColor')}
            onBlur={handleColorHexBlur('accentColor')}
            placeholder="#6366f1"
          />
          <button
            type="button"
            className="color-reset"
            onClick={handleColorReset('accentColor')}
            disabled={isDefaultColor('accentColor')}
          >
            Reset
          </button>
        </div>
      </div>
      <div className="form-row">
        <label>Background color</label>
        <div className="color-input-group">
          <input
            type="color"
            className="color-picker"
            value={colorInputs.backgroundColor}
            onChange={handleColorPicker('backgroundColor')}
          />
          <input
            type="text"
            className="color-hex"
            value={colorInputs.backgroundColor}
            onChange={handleColorHexChange('backgroundColor')}
            onBlur={handleColorHexBlur('backgroundColor')}
            placeholder="#ffffff"
          />
          <button
            type="button"
            className="color-reset"
            onClick={handleColorReset('backgroundColor')}
            disabled={isDefaultColor('backgroundColor')}
          >
            Reset
          </button>
        </div>
      </div>
      <div className="form-row">
        <label>Show progress indicator</label>
        <input
          type="checkbox"
          checked={Boolean(theme.showProgress)}
          onChange={handleToggleProgress}
        />
      </div>
    </>
  );
}

function Toast({ toast, onDismiss }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 4000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 24,
        right: 24,
        padding: '14px 18px',
        borderRadius: 12,
        background:
          toast.type === 'error' ? 'rgba(248,113,113,0.92)' : 'rgba(34,197,94,0.92)',
        color: '#ffffff',
        boxShadow: '0 20px 40px rgba(15,23,42,0.25)',
        fontWeight: 600
      }}
    >
      {toast.message}
    </div>
  );
}

function summariseTextContent(text) {
  if (!text) return 'Click edit to add content';
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return 'Click edit to add content';
  return firstLine.length > 90 ? `${firstLine.slice(0, 87)}…` : firstLine;
}

function summariseVoiceAgent(block) {
  const selected = Array.isArray(block.settings?.voiceAgents)
    ? block.settings.voiceAgents
    : [];
  if (selected.length === 0) {
    return 'No agents selected yet. Click edit to choose Voice AI agents.';
  }
  const names = selected.map((agent) => agent.agentName || agent.name || agent.id);
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} · ${names[1]}`;
  return `${names[0]}, ${names[1]} +${names.length - 2} more`;
}

function summariseSocialProfileBlock(block) {
  const platforms = Array.isArray(block.settings?.platforms)
    ? block.settings.platforms
    : [];
  if (platforms.length === 0) {
    return 'No platforms selected yet. Click edit to choose platforms.';
  }
  const labels = SOCIAL_PLATFORM_OPTIONS.filter((option) =>
    platforms.includes(option.id)
  ).map((option) => option.label);
  if (labels.length === 0) return 'Click edit to choose social platforms.';
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} · ${labels[1]}`;
  return `${labels[0]}, ${labels[1]} +${labels.length - 2} more`;
}

function formatBlockType(type) {
  switch (type) {
    case BLOCK_TYPES.CUSTOM_FIELD:
      return 'Custom field';
    case BLOCK_TYPES.CUSTOM_VALUE:
      return 'Custom value';
    case BLOCK_TYPES.MEDIA:
      return 'Media upload';
    case BLOCK_TYPES.TRIGGER_LINK:
      return 'Trigger link';
    case BLOCK_TYPES.TAG:
      return 'Tag';
    case BLOCK_TYPES.VOICE_AGENT:
      return 'Voice AI agent';
    case BLOCK_TYPES.SOCIAL_PROFILE:
      return 'Social profile';
    case BLOCK_TYPES.TEXT:
    default:
      return 'Content';
  }
}

function formatRelativeTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diff = Date.now() - date.getTime();
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return date.toLocaleDateString();
}

export default App;
