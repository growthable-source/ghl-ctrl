const API_BASE = window.location.origin + '/api';
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

document.addEventListener('DOMContentLoaded', function() {
    checkAuthentication();
    setupFilterListeners();
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
        displayUserInfo();
        loadLocations();
        setupFormHandlers();
        setupInputListeners();
    } catch (error) {
        console.error('Auth check failed:', error);
        window.location.href = '/login.html';
    }
}

function displayUserInfo() {
    const userInfoEl = document.getElementById('userInfo');
    userInfoEl.innerHTML = `
        <span style="color: #555; font-size: 14px;">${currentUser.displayName || currentUser.email}</span>
        <img src="${currentUser.photo || ''}" alt="Profile">
        <a href="/auth/logout" class="logout-btn">Logout</a>
    `;
}

async function loadLocations() {
    try {
        const response = await fetch(`${API_BASE}/locations`);
        const data = await response.json();
        
        if (data.success) {
            currentLocations = data.locations;
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
        option.textContent = location.name;
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
        document.getElementById('no-location').style.display = 'none';
        document.getElementById('location-content').style.display = 'block';
        
        const statusEl = document.getElementById('connectionStatus');
        statusEl.className = 'location-status status-active';
        statusEl.textContent = '● Connected';
        
        if (currentTab === 'fields') {
            loadCustomFields();
        } else if (currentTab === 'values') {
            loadCustomValues();
        } else {
            loadLocationSettings();
        }
    }
}

function showNoLocation() {
    document.getElementById('no-location').style.display = 'block';
    document.getElementById('location-content').style.display = 'none';
    document.getElementById('connectionStatus').textContent = '';
}

function switchTab(tab) {
    currentTab = tab;
    
    document.querySelectorAll('.tab').forEach(btn => {
        btn.classList.remove('active');
    });
    event.target.classList.add('active');
    
    document.querySelectorAll('.content-section').forEach(section => {
        section.classList.remove('active');
    });
    document.getElementById(`${tab}-section`).classList.add('active');
    
    if (!selectedLocation) return;
    
    if (tab === 'fields') {
        loadCustomFields();
    } else if (tab === 'values') {
        loadCustomValues();
    } else {
        loadLocationSettings();
    }
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
                allFields = [];
                listEl.innerHTML = '<div class="empty-state">No custom fields found</div>';
            }
        } else {
            throw new Error(data.error || 'Failed to load fields');
        }
    } catch (error) {
        document.getElementById('fieldsToolbar').style.display = 'none';
        document.getElementById('fieldsResultsInfo').style.display = 'none';
        listEl.innerHTML = `<div class="error-message">Failed to load custom fields: ${error.message}</div>`;
    }
}

function renderFieldsSimple() {
    const listEl = document.getElementById('fieldsList');
    const searchTerm = document.getElementById('fieldsSearch')?.value?.toLowerCase() || '';
    const typeFilter = document.getElementById('fieldsTypeFilter')?.value || '';
    const modelFilter = document.getElementById('fieldsModelFilter')?.value || '';
    
    let filteredFields = allFields.filter(field => {
        if (!field) return false;
        const matchesSearch = !searchTerm || 
            (field.name && field.name.toLowerCase().includes(searchTerm)) ||
            (field.placeholder && field.placeholder.toLowerCase().includes(searchTerm));
        const matchesType = !typeFilter || field.dataType === typeFilter;
        const matchesModel = !modelFilter || field.model === modelFilter;
        return matchesSearch && matchesType && matchesModel;
    });
    
    const resultsCount = document.getElementById('fieldsResultsCount');
    if (resultsCount) resultsCount.textContent = filteredFields.length;
    
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
                        const fieldId = field.id || field._id || Math.random().toString(36);
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
    document.getElementById('fieldsSearch').value = '';
    document.getElementById('fieldsTypeFilter').value = '';
    document.getElementById('fieldsModelFilter').value = '';
    renderFieldsSimple();
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
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        try {
            const text = await file.text();
            const values = JSON.parse(text);
            
            if (!Array.isArray(values)) {
                throw new Error('Invalid format: expected an array of values');
            }
            
            let imported = 0;
            let failed = 0;
            
            for (const value of values) {
                if (!value.name || !value.value) {
                    failed++;
                    continue;
                }
                
                try {
                    const response = await fetch(`${API_BASE}/locations/${selectedLocation.id}/custom-values`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            name: value.name,
                            value: value.value
                        })
                    });
                    
                    if (response.ok) {
                        imported++;
                    } else {
                        failed++;
                    }
                } catch (error) {
                    failed++;
                }
            }
            
            showMessage(`Imported ${imported} values${failed > 0 ? `, ${failed} failed` : ''}`, 'success');
            loadCustomValues();
        } catch (error) {
            showMessage(`Import failed: ${error.message}`, 'error');
        }
    };
    input.click();
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
    
    document.getElementById('imageUpload').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        const allowedTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];
        if (!allowedTypes.includes(file.type)) {
            showMessage('Please select a valid image file (PNG, JPG, GIF, WEBP)', 'error');
            e.target.value = '';
            return;
        }
        
        if (file.size > 5 * 1024 * 1024) {
            showMessage('Image size must be less than 5MB', 'error');
            e.target.value = '';
            return;
        }
        
        const reader = new FileReader();
        reader.onload = function(event) {
            document.getElementById('previewImg').src = event.target.result;
            document.getElementById('imagePreview').style.display = 'block';
        };
        reader.readAsDataURL(file);
        
        if (!selectedLocation) {
            showMessage('Please select a location first', 'error');
            return;
        }
        
        showMessage('Uploading image...', 'success');
        
        try {
            const formData = new FormData();
            formData.append('image', file);
            
            const response = await fetch(`${API_BASE}/locations/${selectedLocation.id}/upload-image`, {
                method: 'POST',
                body: formData
            });
            
            const result = await response.json();
            
            if (result.success) {
                document.getElementById('imageUpload').dataset.imageUrl = result.imageUrl;
                document.getElementById('imageUrlDisplay').textContent = `URL: ${result.imageUrl}`;
                showMessage('Image uploaded successfully!', 'success');
            } else {
                showMessage(`Upload failed: ${result.error}`, 'error');
                e.target.value = '';
                document.getElementById('imagePreview').style.display = 'none';
            }
        } catch (error) {
            showMessage(`Upload error: ${error.message}`, 'error');
            e.target.value = '';
            document.getElementById('imagePreview').style.display = 'none';
        }
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
        
        if (valueType === 'image') {
            const imageUrl = document.getElementById('imageUpload').dataset.imageUrl;
            if (!imageUrl) {
                showMessage('Please upload an image first', 'error');
                return;
            }
            data.value = imageUrl;
        } else {
            data.value = formData.get('value');
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
        
        updateProgress(30, 'Connecting to GoHighLevel...');
        
        try {
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
            showMessage(`Network error: ${error.message}`, 'error');
        }
    });
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

function showAddLocationModal() {
    document.getElementById('addLocationModal').classList.add('show');
}

function showLocationSettings() {
    const modal = document.getElementById('manageLocationsModal');
    const listEl = document.getElementById('locationsList');
    
    if (currentLocations.length === 0) {
        listEl.innerHTML = '<div class="empty-state">No locations added yet</div>';
    } else {
        listEl.innerHTML = currentLocations.map(location => `
            <div class="location-card">
                <div class="location-card-header">
                    <div class="location-card-title">${location.name}</div>
                </div>
                <div class="location-card-meta">
                    <p><strong>Location ID:</strong> ${location.locationId}</p>
                    <p><strong>Added:</strong> ${new Date(location.addedAt).toLocaleString()}</p>
                </div>
                <div class="location-card-actions">
                    <button class="btn btn-danger" onclick="deleteLocation('${location.id}')">Remove Location</button>
                </div>
            </div>
        `).join('');
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