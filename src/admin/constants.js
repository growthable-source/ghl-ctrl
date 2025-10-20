export const BLOCK_TYPES = {
  CUSTOM_FIELD: 'custom_field',
  CUSTOM_VALUE: 'custom_value',
  TRIGGER_LINK: 'trigger_link',
  TAG: 'tag',
  MEDIA: 'media',
  TEXT: 'text',
  VOICE_AGENT: 'voice_agent',
  SOCIAL_PROFILE: 'social_profile'
};

export const BLOCK_LIBRARY = [
  {
    type: BLOCK_TYPES.CUSTOM_FIELD,
    name: 'Custom Field',
    description: 'Collect or update a custom field in GoHighLevel'
  },
  {
    type: BLOCK_TYPES.CUSTOM_VALUE,
    name: 'Custom Value',
    description: 'Capture multi-purpose settings or snippets'
  },
  {
    type: BLOCK_TYPES.MEDIA,
    name: 'Media Upload',
    description: 'Request files or logos from your client'
  },
  {
    type: BLOCK_TYPES.TRIGGER_LINK,
    name: 'Trigger Link',
    description: 'Collect or create trigger links'
  },
  {
    type: BLOCK_TYPES.VOICE_AGENT,
    name: 'Voice AI Agent',
    description: 'Let clients choose or assign a Voice AI agent'
  },
  {
    type: BLOCK_TYPES.SOCIAL_PROFILE,
    name: 'Social Profiles',
    description: 'Guide clients to connect social media accounts'
  },
  {
    type: BLOCK_TYPES.TAG,
    name: 'Tag Selector',
    description: 'Let clients pick existing tags or add new ones'
  },
  {
    type: BLOCK_TYPES.TEXT,
    name: 'Content / Instructions',
    description: 'Provide guidance, headings, or descriptions'
  }
];
