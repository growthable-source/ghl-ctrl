import React, {
  createContext,
  useContext,
  useMemo,
  useReducer,
  useCallback
} from 'react';
import { nanoid } from 'nanoid';
import { BLOCK_TYPES } from '../constants';

const BuilderStateContext = createContext();
const BuilderActionsContext = createContext();

const defaultTheme = () => ({
  logoUrl: '',
  logoStorageKey: '',
  logoFit: 'contain',
  logoWidth: '',
  logoHeight: '',
  primaryColor: '#4f46e5',
  accentColor: '#6366f1',
  backgroundColor: '#ffffff',
  textColor: '#1f2937',
  fontFamily: 'Inter',
  showProgress: true
});

const createPage = (overrides = {}) => ({
  id: nanoid(8),
  title: overrides.title || 'New Page',
  description: overrides.description || '',
  layout: overrides.layout || 'single',
  blocks: overrides.blocks || []
});

const defaultTitleByType = {
  [BLOCK_TYPES.CUSTOM_FIELD]: 'Custom Field',
  [BLOCK_TYPES.CUSTOM_VALUE]: 'Custom Value',
  [BLOCK_TYPES.TRIGGER_LINK]: 'Trigger Link',
  [BLOCK_TYPES.TAG]: 'Tags',
  [BLOCK_TYPES.MEDIA]: 'Upload Files',
  [BLOCK_TYPES.TEXT]: 'Content Block',
  [BLOCK_TYPES.VOICE_AGENT]: 'Voice AI Agent',
  [BLOCK_TYPES.SOCIAL_PROFILE]: 'Social Profile Connect'
};

const createBlock = (type, overrides = {}) => {
  const base = {
    id: nanoid(10),
    type,
    title: overrides.title || defaultTitleByType[type] || 'Block',
    helperText: overrides.helperText || '',
    required: Boolean(overrides.required),
    mode: overrides.mode || 'existing',
    referenceId: overrides.referenceId || null,
    newEntity: overrides.newEntity || {},
    layout: overrides.layout || { width: 'full' },
    settings:
      overrides.settings ||
      (type === BLOCK_TYPES.MEDIA
        ? { accept: '*/*', multiple: false }
        : type === BLOCK_TYPES.VOICE_AGENT
        ? { voiceAgents: [], allowMultiple: false }
        : type === BLOCK_TYPES.SOCIAL_PROFILE
        ? { platforms: ['google'], instructions: '', allowMultiple: false }
        : {}),
    content: overrides.content || (type === BLOCK_TYPES.TEXT ? 'Add instructions here…' : ''),
    textVariant:
      type === BLOCK_TYPES.TEXT
        ? overrides.textVariant || 'paragraph'
        : overrides.textVariant || null
  };
  if (type === BLOCK_TYPES.VOICE_AGENT && !base.helperText) {
    base.helperText = 'Select the Voice AI agent you want to use.';
  }
  return base;
};

const createWizard = () => {
  const firstPage = createPage({ title: 'Welcome' });
  return {
    id: null,
    name: 'Untitled Wizard',
    status: 'draft',
    locationId: '',
    description: '',
    theme: defaultTheme(),
    pages: [firstPage],
    metadata: {
      version: 1,
      createdAt: new Date().toISOString()
    }
  };
};

const seedWizard = createWizard();

const initialState = {
  loading: true,
  saving: false,
  publishing: false,
  error: null,
  bootstrap: {
    locations: [],
    library: {
      customFields: [],
      customValues: [],
      triggerLinks: [],
      tags: [],
      media: [],
      voiceAgents: [],
      socialProfiles: []
    },
    templates: []
  },
  wizard: seedWizard,
  selectedPageId: seedWizard.pages[0].id,
  dirty: false
};

function setSelectedPageIdFromWizard(wizard) {
  return wizard.pages?.[0]?.id || null;
}

function reducer(state, action) {
  switch (action.type) {
    case 'BOOTSTRAP_REQUEST':
      return { ...state, loading: true, error: null };
    case 'BOOTSTRAP_SUCCESS':
      return {
        ...state,
        loading: false,
        bootstrap: { ...state.bootstrap, ...action.payload },
        error: null
      };
    case 'BOOTSTRAP_FAILURE':
      return { ...state, loading: false, error: action.payload };
    case 'SET_WIZARD': {
      const wizard = action.payload || createWizard();
      return {
        ...state,
        wizard,
        selectedPageId: setSelectedPageIdFromWizard(wizard),
        dirty: false
      };
    }
    case 'UPDATE_WIZARD_META':
      return {
        ...state,
        wizard: { ...state.wizard, ...action.payload },
        dirty: true
      };
    case 'SET_THEME':
      return {
        ...state,
        wizard: {
          ...state.wizard,
          theme: { ...state.wizard.theme, ...action.payload }
        },
        dirty: true
      };
    case 'SELECT_PAGE':
      return { ...state, selectedPageId: action.payload };
    case 'ADD_PAGE': {
      const newPage = createPage(action.payload);
      return {
        ...state,
        wizard: { ...state.wizard, pages: [...state.wizard.pages, newPage] },
        selectedPageId: newPage.id,
        dirty: true
      };
    }
    case 'UPDATE_PAGE': {
      const { pageId, patch } = action.payload;
      const pages = state.wizard.pages.map((page) =>
        page.id === pageId ? { ...page, ...patch } : page
      );
      return {
        ...state,
        wizard: { ...state.wizard, pages },
        dirty: true
      };
    }
    case 'REMOVE_PAGE': {
      const pages = state.wizard.pages.filter(
        (page) => page.id !== action.payload
      );
      const selectedPageId =
        state.selectedPageId === action.payload
          ? pages[0]?.id || null
          : state.selectedPageId;
      return {
        ...state,
        wizard: { ...state.wizard, pages },
        selectedPageId,
        dirty: true
      };
    }
    case 'REORDER_PAGES': {
      return {
        ...state,
        wizard: { ...state.wizard, pages: action.payload },
        dirty: true
      };
    }
    case 'ADD_BLOCK': {
      const { pageId, blockType, overrides } = action.payload;
      const block = createBlock(blockType, overrides);
      const pages = state.wizard.pages.map((page) =>
        page.id === pageId
          ? { ...page, blocks: [...page.blocks, block] }
          : page
      );
      return {
        ...state,
        wizard: { ...state.wizard, pages },
        dirty: true
      };
    }
    case 'UPDATE_BLOCK': {
      const { pageId, blockId, patch } = action.payload;
      const pages = state.wizard.pages.map((page) => {
        if (page.id !== pageId) return page;
        return {
          ...page,
          blocks: page.blocks.map((block) =>
            block.id === blockId ? { ...block, ...patch } : block
          )
        };
      });
      return {
        ...state,
        wizard: { ...state.wizard, pages },
        dirty: true
      };
    }
    case 'REMOVE_BLOCK': {
      const { pageId, blockId } = action.payload;
      const pages = state.wizard.pages.map((page) => {
        if (page.id !== pageId) return page;
        return {
          ...page,
          blocks: page.blocks.filter((block) => block.id !== blockId)
        };
      });
      return {
        ...state,
        wizard: { ...state.wizard, pages },
        dirty: true
      };
    }
    case 'REORDER_BLOCKS': {
      const { pageId, blocks } = action.payload;
      const pages = state.wizard.pages.map((page) =>
        page.id === pageId ? { ...page, blocks } : page
      );
      return {
        ...state,
        wizard: { ...state.wizard, pages },
        dirty: true
      };
    }
    case 'SET_LIBRARY':
      return {
        ...state,
        bootstrap: { ...state.bootstrap, library: action.payload || {} }
      };
    case 'SET_TEMPLATES':
      return {
        ...state,
        bootstrap: { ...state.bootstrap, templates: action.payload || [] }
      };
    case 'SET_DIRTY':
      return { ...state, dirty: action.payload };
    case 'SET_SAVING':
      return { ...state, saving: action.payload };
    case 'SET_PUBLISHING':
      return { ...state, publishing: action.payload };
    default:
      return state;
  }
}

export function BuilderProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const actions = useMemo(() => {
    return {
      bootstrapRequest: () => dispatch({ type: 'BOOTSTRAP_REQUEST' }),
      bootstrapSuccess: (payload) =>
        dispatch({ type: 'BOOTSTRAP_SUCCESS', payload }),
      bootstrapFailure: (payload) =>
        dispatch({ type: 'BOOTSTRAP_FAILURE', payload }),
      setWizard: (payload) => dispatch({ type: 'SET_WIZARD', payload }),
      updateWizardMeta: (patch) =>
        dispatch({ type: 'UPDATE_WIZARD_META', payload: patch }),
      setTheme: (patch) => dispatch({ type: 'SET_THEME', payload: patch }),
      selectPage: (pageId) => dispatch({ type: 'SELECT_PAGE', payload: pageId }),
      addPage: (overrides) =>
        dispatch({ type: 'ADD_PAGE', payload: overrides || {} }),
      updatePage: (pageId, patch) =>
        dispatch({ type: 'UPDATE_PAGE', payload: { pageId, patch } }),
      removePage: (pageId) =>
        dispatch({ type: 'REMOVE_PAGE', payload: pageId }),
      reorderPages: (pages) =>
        dispatch({ type: 'REORDER_PAGES', payload: pages }),
      addBlock: (pageId, blockType, overrides = {}) =>
        dispatch({
          type: 'ADD_BLOCK',
          payload: { pageId, blockType, overrides }
        }),
      updateBlock: (pageId, blockId, patch) =>
        dispatch({
          type: 'UPDATE_BLOCK',
          payload: { pageId, blockId, patch }
        }),
      removeBlock: (pageId, blockId) =>
        dispatch({ type: 'REMOVE_BLOCK', payload: { pageId, blockId } }),
      reorderBlocks: (pageId, blocks) =>
        dispatch({ type: 'REORDER_BLOCKS', payload: { pageId, blocks } }),
      setDirty: (value) => dispatch({ type: 'SET_DIRTY', payload: value }),
      setSaving: (value) => dispatch({ type: 'SET_SAVING', payload: value }),
      setPublishing: (value) =>
        dispatch({ type: 'SET_PUBLISHING', payload: value }),
      setLibrary: (library) =>
        dispatch({ type: 'SET_LIBRARY', payload: library }),
      setTemplates: (templates) =>
        dispatch({ type: 'SET_TEMPLATES', payload: templates })
    };
  }, []);

  const stateValue = useMemo(
    () => ({ ...state }),
    [state]
  );

  return (
    <BuilderStateContext.Provider value={stateValue}>
      <BuilderActionsContext.Provider value={actions}>
        {children}
      </BuilderActionsContext.Provider>
    </BuilderStateContext.Provider>
  );
}

export function useBuilderState() {
  const ctx = useContext(BuilderStateContext);
  if (!ctx) {
    throw new Error('useBuilderState must be used within BuilderProvider');
  }
  return ctx;
}

export function useBuilderActions() {
  const ctx = useContext(BuilderActionsContext);
  if (!ctx) {
    throw new Error('useBuilderActions must be used within BuilderProvider');
  }
  return ctx;
}

export function useBuilder() {
  return [useBuilderState(), useBuilderActions()];
}

export const useSelectedPage = () => {
  const { wizard, selectedPageId } = useBuilderState();
  return useMemo(
    () => wizard.pages.find((page) => page.id === selectedPageId) || null,
    [wizard.pages, selectedPageId]
  );
};

export const useBlockById = (pageId, blockId) => {
  const page = useSelectedPage();
  return useMemo(() => {
    if (!page || page.id !== pageId) return null;
    return page.blocks.find((block) => block.id === blockId) || null;
  }, [page, pageId, blockId]);
};

export { createBlock, createPage, createWizard, defaultTheme };
