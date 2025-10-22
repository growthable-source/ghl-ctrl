async function handleResponse(response) {
  const text = await response.text();
  const contentType = response.headers.get('content-type');
  const data =
    contentType && contentType.includes('application/json')
      ? JSON.parse(text || '{}')
      : text;
  if (!response.ok) {
    const message =
      data?.error || data?.message || response.statusText || 'Request failed';
    const error = new Error(message);
    error.status = response.status;
    error.payload = data;
    throw error;
  }
  return data;
}

export async function fetchBootstrap() {
  const response = await fetch('/api/onboarding/builder/bootstrap', {
    credentials: 'include'
  });
  return handleResponse(response);
}

export async function fetchTemplates() {
  const response = await fetch('/api/onboarding/templates', {
    credentials: 'include'
  });
  return handleResponse(response);
}

export async function fetchLibrary(locationId) {
  if (!locationId) {
    throw new Error('locationId required');
  }
  const params = new URLSearchParams({ locationId });
  const response = await fetch(
    `/api/onboarding/builder/library?${params.toString()}`,
    {
      credentials: 'include'
    }
  );
  return handleResponse(response);
}

export async function fetchTemplate(templateId) {
  if (!templateId) {
    throw new Error('Template id required');
  }
  const response = await fetch(`/api/onboarding/templates/${templateId}`, {
    credentials: 'include'
  });
  return handleResponse(response);
}

export async function saveTemplate(template) {
  const method = template.id ? 'PUT' : 'POST';
  const url = template.id
    ? `/api/onboarding/templates/${template.id}`
    : '/api/onboarding/templates';
  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json'
    },
    credentials: 'include',
    body: JSON.stringify({ template })
  });
  return handleResponse(response);
}

export async function deleteTemplate(templateId) {
  if (!templateId) {
    throw new Error('Template id required');
  }
  const response = await fetch(`/api/onboarding/templates/${templateId}`, {
    method: 'DELETE',
    credentials: 'include'
  });
  return handleResponse(response);
}

export async function publishTemplate(template) {
  if (!template.id) {
    throw new Error('Save the template before publishing');
  }
  const response = await fetch(
    `/api/onboarding/templates/${template.id}/publish`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({ template })
    }
  );
  return handleResponse(response);
}

export async function cloneTemplate(templateId, payload = {}) {
  if (!templateId) {
    throw new Error('Template id required');
  }
  const body =
    payload && typeof payload === 'object' && Object.keys(payload).length > 0
      ? JSON.stringify(payload)
      : null;
  const response = await fetch(
    `/api/onboarding/templates/${templateId}/clone`,
    {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      credentials: 'include',
      body
    }
  );
  return handleResponse(response);
}

export async function issueWizardLink(templateId, options = {}) {
  if (!templateId) {
    throw new Error('Template id required');
  }
  const payload =
    options && typeof options === 'object' && !Array.isArray(options)
      ? options
      : options
      ? { locationId: options }
      : {};
  const response = await fetch(
    `/api/onboarding/templates/${templateId}/issue`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify(payload)
    }
  );
  return handleResponse(response);
}

export async function fetchVoiceAgents(locationId) {
  if (!locationId) {
    throw new Error('locationId required');
  }
  const params = new URLSearchParams({ locationId });
  const response = await fetch(
    `/api/voice-ai/agents?${params.toString()}`,
    {
      credentials: 'include'
    }
  );
  return handleResponse(response);
}

export async function createVoiceAgent(agent) {
  if (!agent?.locationId) {
    throw new Error('locationId required to create agent');
  }
  const response = await fetch('/api/voice-ai/agents', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    credentials: 'include',
    body: JSON.stringify(agent)
  });
  return handleResponse(response);
}

export async function updateVoiceAgent(agentId, agent) {
  if (!agentId) {
    throw new Error('agentId required');
  }
  if (!agent?.locationId) {
    throw new Error('locationId required to update agent');
  }
  const response = await fetch(`/api/voice-ai/agents/${agentId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json'
    },
    credentials: 'include',
    body: JSON.stringify(agent)
  });
  return handleResponse(response);
}

export async function deleteVoiceAgent(agentId, locationId) {
  if (!agentId) {
    throw new Error('agentId required');
  }
  if (!locationId) {
    throw new Error('locationId required');
  }
  const params = new URLSearchParams({ locationId });
  const response = await fetch(
    `/api/voice-ai/agents/${agentId}?${params.toString()}`,
    {
      method: 'DELETE',
      credentials: 'include'
    }
  );
  return handleResponse(response);
}
