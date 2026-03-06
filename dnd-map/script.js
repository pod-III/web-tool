/* ================================================================
   Arcane Tabletop VTT – Main Script
   Performance-optimised refactor: requestAnimationFrame batching,
   cached DOM refs, throttled pointer-move, early-exit guards.
   ================================================================ */

'use strict';

// ── Initialise Lucide icons ─────────────────────────────
lucide.createIcons();

// ── Cached DOM References ───────────────────────────────
const $ = (id) => document.getElementById(id);

const modal = $('custom-modal');
const mTitle = $('modal-title');
const mMessage = $('modal-message');
const mInput = $('modal-input');
const mCancel = $('modal-cancel');
const mConfirm = $('modal-confirm');

const wrapper = $('canvas-wrapper');
const container = $('canvas-container');
const mapCanvas = $('layer-map');
const gridCanvas = $('layer-grid');
const tokenCanvas = $('layer-token');
const fogCanvas = $('layer-fog');

const mapCtx = mapCanvas.getContext('2d');
const gridCtx = gridCanvas.getContext('2d');
const tokenCtx = tokenCanvas.getContext('2d');
const fogCtx = fogCanvas.getContext('2d');

const btnUndo = $('btn-undo');
const btnRedo = $('btn-redo');
const modeToggle = $('mode-toggle');
const sidebar = $('dm-sidebar');
const mapSelect = $('map-select');
const gridSizeInput = $('grid-size-input');
const gridSizeValue = $('grid-size-value');
const ctxMenu = $('token-context-menu');

// ── Custom Modal System ─────────────────────────────────
let modalCallback = null;

function closeModals() {
    modal.classList.add('hidden');
    mInput.classList.add('hidden');
    mMessage.classList.add('hidden');
    mCancel.classList.add('hidden');
    mInput.value = '';
}

function showAlert(title, message) {
    closeModals();
    mTitle.innerText = title;
    mMessage.innerText = message;
    mMessage.classList.remove('hidden');
    modal.classList.remove('hidden');
    modalCallback = null;
}

function showPrompt(title, defaultVal, callback) {
    closeModals();
    mTitle.innerText = title;
    mInput.value = defaultVal || '';
    mInput.classList.remove('hidden');
    mCancel.classList.remove('hidden');
    modal.classList.remove('hidden');
    mInput.focus();
    modalCallback = callback;
}

function showConfirm(title, message, callback) {
    closeModals();
    mTitle.innerText = title;
    mMessage.innerText = message;
    mMessage.classList.remove('hidden');
    mCancel.classList.remove('hidden');
    modal.classList.remove('hidden');
    modalCallback = () => callback(true);
}

mCancel.onclick = closeModals;
mConfirm.onclick = () => {
    const val = mInput.value;
    const cb = modalCallback;
    closeModals();
    if (cb) cb(val);
};

// ── State Management ────────────────────────────────────
let isDMMode = true;
let currentTool = 'drag';
let mapsList = [];
let currentMapData = null;
let mapImage = null;
let tokens = [];
let fogShapes = [];
let currentDrawPoints = [];
let isGridVisible = false;

let transform = { x: 0, y: 0, scale: 1 };
let activePointers = new Map();
let lastPinchDist = null;
let lastPointerCenter = null;
let isPanning = false;

let activeToken = null;
let isDrawing = false;
let longPressTimer = null;
let gridSize = 50;

// ── Undo / Redo History ─────────────────────────────────
let history = [];
let historyIndex = -1;
const MAX_HISTORY = 50;

function snapshotState() {
    return {
        tokens: tokens.map(t => ({
            id: t.id, name: t.name, x: t.x, y: t.y, src: t.img.src, size: t.size || 1
        })),
        fogShapes: JSON.parse(JSON.stringify(fogShapes))
    };
}

function pushHistory() {
    history = history.slice(0, historyIndex + 1);
    history.push(snapshotState());
    if (history.length > MAX_HISTORY) history.shift();
    historyIndex = history.length - 1;
    updateUndoRedoButtons();
}

function restoreSnapshot(snap) {
    fogShapes = JSON.parse(JSON.stringify(snap.fogShapes));
    tokens = [];
    let pending = snap.tokens.length;
    if (pending === 0) { renderTokens(); renderFog(); saveCurrentState(); return; }
    snap.tokens.forEach(td => {
        const tImg = new Image();
        tImg.onload = () => {
            tokens.push({ id: td.id, name: td.name, x: td.x, y: td.y, img: tImg, size: td.size || 1 });
            if (--pending === 0) renderTokens();
        };
        tImg.onerror = () => { if (--pending === 0) renderTokens(); };
        tImg.src = td.src;
    });
    renderFog();
    saveCurrentState();
}

function undo() {
    if (historyIndex <= 0) return;
    historyIndex--;
    restoreSnapshot(history[historyIndex]);
    updateUndoRedoButtons();
}

function redo() {
    if (historyIndex >= history.length - 1) return;
    historyIndex++;
    restoreSnapshot(history[historyIndex]);
    updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
    btnUndo.disabled = historyIndex <= 0;
    btnRedo.disabled = historyIndex >= history.length - 1;
}

btnUndo.addEventListener('click', undo);
btnRedo.addEventListener('click', redo);

// ── Transform ───────────────────────────────────────────
let transformDirty = false;

function updateTransform() {
    if (transformDirty) return;
    transformDirty = true;
    requestAnimationFrame(() => {
        container.style.transform = `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`;
        transformDirty = false;
    });
}

// ── Tool Selection ──────────────────────────────────────
const TOOL_IDS = ['tool-drag', 'tool-pan', 'tool-fog-draw', 'tool-fog-toggle', 'tool-fog-rect'];

function setTool(tool, btnId) {
    currentTool = tool;
    for (const id of TOOL_IDS) {
        $(id)?.classList.remove('ring-2', 'ring-amber-500');
    }
    $(btnId)?.classList.add('ring-2', 'ring-amber-500');
}

// ── UI Event Listeners ──────────────────────────────────
modeToggle.addEventListener('click', (e) => {
    isDMMode = !isDMMode;
    const btn = e.currentTarget;
    btn.classList.remove('bg-amber-700', 'hover:bg-amber-600', 'bg-stone-700', 'hover:bg-stone-600');

    if (isDMMode) {
        sidebar.style.display = 'flex';
        btn.innerHTML = `<i data-lucide="user" class="w-4 h-4"></i> Enter Player View`;
        btn.classList.add('bg-amber-700', 'hover:bg-amber-600');
    } else {
        sidebar.style.display = 'none';
        btn.innerHTML = `<i data-lucide="shield" class="w-4 h-4"></i> Enter DM View`;
        btn.classList.add('bg-stone-700', 'hover:bg-stone-600');
        // Auto-center map when entering player view
        if (mapImage) {
            requestAnimationFrame(() => {
                const rect = wrapper.getBoundingClientRect();
                const scaleX = rect.width / mapImage.width;
                const scaleY = rect.height / mapImage.height;
                const newScale = Math.min(scaleX, scaleY) * 0.95;
                transform.scale = newScale;
                transform.x = (rect.width - mapImage.width * newScale) / 2;
                transform.y = (rect.height - mapImage.height * newScale) / 2;
                updateTransform();
            });
        }
    }
    lucide.createIcons();
    renderFog();
});

$('tool-drag').addEventListener('click', () => setTool('drag', 'tool-drag'));
$('tool-pan').addEventListener('click', () => setTool('pan', 'tool-pan'));
$('tool-fog-draw').addEventListener('click', () => setTool('fog-draw', 'tool-fog-draw'));
$('tool-fog-rect').addEventListener('click', () => setTool('fog-rect', 'tool-fog-rect'));
$('tool-fog-toggle').addEventListener('click', () => setTool('fog-toggle', 'tool-fog-toggle'));

$('tool-grid-toggle').addEventListener('click', () => {
    isGridVisible = !isGridVisible;
    renderGrid();
});

// ── Grid Size Customisation ─────────────────────────────
gridSizeInput.addEventListener('input', (e) => {
    gridSize = parseInt(e.target.value, 10);
    gridSizeValue.textContent = gridSize;
    renderGrid();
    renderTokens();
    if (currentMapData) {
        currentMapData.gridSize = gridSize;
        saveCurrentState();
    }
});

// ── Fit & Rotate Map ────────────────────────────────────
$('btn-fit-map').addEventListener('click', () => {
    if (!mapImage) return;
    const rect = wrapper.getBoundingClientRect();
    const scaleX = rect.width / mapImage.width;
    const scaleY = rect.height / mapImage.height;
    const newScale = Math.min(scaleX, scaleY) * 0.95;
    transform.scale = newScale;
    transform.x = (rect.width - mapImage.width * newScale) / 2;
    transform.y = (rect.height - mapImage.height * newScale) / 2;
    updateTransform();
});

$('btn-rotate-map').addEventListener('click', () => {
    if (!mapImage || !currentMapData) return;
    const oldW = mapImage.width;
    const oldH = mapImage.height;
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = oldH;
    tempCanvas.height = oldW;
    const tCtx = tempCanvas.getContext('2d');

    tCtx.translate(tempCanvas.width / 2, tempCanvas.height / 2);
    tCtx.rotate(Math.PI / 2);
    tCtx.drawImage(mapImage, -oldW / 2, -oldH / 2);

    if (currentMapData.tokens) {
        currentMapData.tokens.forEach(t => {
            const nx = oldH - t.y;
            t.y = t.x;
            t.x = nx;
        });
    }
    if (currentMapData.fogShapes) {
        currentMapData.fogShapes.forEach(shape => {
            shape.points = shape.points.map(p => ({ x: oldH - p.y, y: p.x }));
        });
    }
    currentMapData.data = tempCanvas.toDataURL();
    saveCurrentState();
    loadMap(currentMapData.id);
});

// ── Map Delete ──────────────────────────────────────────
$('btn-delete-map').addEventListener('click', () => {
    if (!currentMapData) {
        showAlert('No Map', 'No map is currently selected to delete.');
        return;
    }
    showConfirm('Delete Map', `Are you sure you want to delete "${currentMapData.name}"? This cannot be undone.`, () => {
        const idToDelete = currentMapData.id;
        const tx = db.transaction('maps', 'readwrite');
        tx.objectStore('maps').delete(idToDelete);
        tx.oncomplete = () => {
            mapsList = mapsList.filter(m => m.id !== idToDelete);
            currentMapData = null;
            mapImage = null;
            tokens = [];
            fogShapes = [];
            [mapCanvas, gridCanvas, tokenCanvas, fogCanvas].forEach(c => {
                c.getContext('2d').clearRect(0, 0, c.width, c.height);
            });
            updateMapDropdown();
            if (mapsList.length > 0) loadMap(mapsList[0].id);
            else showAlert('Deleted', 'Map has been removed.');
        };
    });
});

// ── IndexedDB & Multi-Map ───────────────────────────────
const DB_NAME = 'ArcaneVTT_DB';
let db;

const request = indexedDB.open(DB_NAME, 1);
request.onupgradeneeded = (e) => {
    db = e.target.result;
    if (!db.objectStoreNames.contains('maps')) {
        db.createObjectStore('maps', { keyPath: 'id' });
    }
};
request.onsuccess = (e) => {
    db = e.target.result;
    loadMapList();
};

function saveCurrentState() {
    if (!currentMapData) return;
    currentMapData.tokens = tokens.map(t => ({
        id: t.id, name: t.name, x: t.x, y: t.y, src: t.img.src, size: t.size || 1
    }));
    currentMapData.fogShapes = fogShapes;
    currentMapData.gridSize = gridSize;
    const tx = db.transaction('maps', 'readwrite');
    tx.objectStore('maps').put(currentMapData);
}

function loadMapList() {
    const tx = db.transaction('maps', 'readonly');
    const req = tx.objectStore('maps').getAll();
    req.onsuccess = () => {
        mapsList = req.result || [];
        updateMapDropdown();
        if (mapsList.length > 0 && !currentMapData) {
            loadMap(mapsList[0].id);
        }
    };
}

function updateMapDropdown() {
    mapSelect.innerHTML = '<option value="">-- Select Map --</option>';
    const frag = document.createDocumentFragment();
    mapsList.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name;
        frag.appendChild(opt);
    });
    mapSelect.appendChild(frag);
    mapSelect.value = currentMapData ? currentMapData.id : '';
}

mapSelect.addEventListener('change', (e) => {
    if (e.target.value) {
        saveCurrentState();
        loadMap(parseInt(e.target.value, 10));
    }
});

// ── Map Upload ──────────────────────────────────────────
$('map-upload').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const defaultName = file.name.replace(/\.[^/.]+$/, '').replace(/_/g, ' ');
    showPrompt('Name this map:', defaultName, (mapName) => {
        if (!mapName) return;
        const reader = new FileReader();
        reader.onload = (event) => {
            const newMap = {
                id: Date.now(),
                name: mapName,
                data: event.target.result,
                tokens: [],
                fogShapes: [],
                gridSize
            };
            saveCurrentState();
            const tx = db.transaction('maps', 'readwrite');
            tx.objectStore('maps').put(newMap);
            tx.oncomplete = () => {
                mapsList.push(newMap);
                updateMapDropdown();
                loadMap(newMap.id);
            };
        };
        reader.readAsDataURL(file);
    });
    e.target.value = '';
});

// ── Load Map ────────────────────────────────────────────
function loadMap(id) {
    currentMapData = mapsList.find(m => m.id === id);
    if (!currentMapData) return;
    mapSelect.value = id;

    tokens = [];
    fogShapes = currentMapData.fogShapes || [];
    gridSize = currentMapData.gridSize || 50;
    gridSizeInput.value = gridSize;
    gridSizeValue.textContent = gridSize;
    transform = { x: 50, y: 50, scale: 1 };
    updateTransform();

    const img = new Image();
    img.onload = () => {
        mapImage = img;
        const w = img.width;
        const h = img.height;
        container.style.width = w + 'px';
        container.style.height = h + 'px';
        [mapCanvas, gridCanvas, tokenCanvas, fogCanvas].forEach(c => {
            c.width = w;
            c.height = h;
        });

        if (currentMapData.tokens) {
            let pending = currentMapData.tokens.length;
            currentMapData.tokens.forEach(td => {
                const tImg = new Image();
                tImg.onload = () => {
                    tokens.push({ id: td.id, name: td.name, x: td.x, y: td.y, img: tImg, size: td.size || 1 });
                    if (--pending === 0) renderTokens();
                };
                tImg.onerror = () => {
                    console.warn(`Failed to load token image: ${td.name}`);
                    if (--pending === 0) renderTokens();
                };
                tImg.src = td.src;
            });
        }
        renderMap();
        renderGrid();
        renderTokens();
        renderFog();
        // Initialise undo history for this map
        history = [snapshotState()];
        historyIndex = 0;
        updateUndoRedoButtons();
    };
    img.onerror = () => showAlert('Error', `Failed to load map image for "${currentMapData.name}".`);
    img.src = currentMapData.data;
}

// ── Export / Import ─────────────────────────────────────
$('btn-export').addEventListener('click', () => {
    if (currentMapData) {
        currentMapData.tokens = tokens.map(t => ({
            id: t.id, name: t.name, x: t.x, y: t.y, src: t.img.src, size: t.size || 1
        }));
        currentMapData.fogShapes = fogShapes;
        currentMapData.gridSize = gridSize;
    }
    const saveTx = db.transaction('maps', 'readwrite');
    if (currentMapData) saveTx.objectStore('maps').put(currentMapData);
    saveTx.oncomplete = () => {
        const readTx = db.transaction('maps', 'readonly');
        const req = readTx.objectStore('maps').getAll();
        req.onsuccess = () => {
            const blob = new Blob([JSON.stringify(req.result)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `ArcaneVTT_Backup_${new Date().toISOString().split('T')[0]}.json`;
            a.click();
            URL.revokeObjectURL(url);
        };
    };
});

$('campaign-import').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
        try {
            const importedMaps = JSON.parse(event.target.result);
            if (!Array.isArray(importedMaps)) throw new Error('Invalid format');
            const tx = db.transaction('maps', 'readwrite');
            importedMaps.forEach(m => tx.objectStore('maps').put(m));
            tx.oncomplete = () => {
                showAlert('Success', 'Campaign data imported successfully!');
                loadMapList();
            };
        } catch (err) {
            showAlert('Error', 'Failed to parse campaign file.');
        }
    };
    reader.readAsText(file);
    e.target.value = '';
});

// ── Token Upload ────────────────────────────────────────
$('token-upload').addEventListener('change', (e) => {
    const file = e.target.files[0];
    const nameInput = $('token-name').value;
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
            const rect = wrapper.getBoundingClientRect();
            const viewX = (rect.width / 2 - transform.x) / transform.scale;
            const viewY = (rect.height / 2 - transform.y) / transform.scale;
            tokens.push({ id: Date.now(), img, name: nameInput, x: viewX, y: viewY, size: 1 });
            renderTokens();
            pushHistory();
            saveCurrentState();
        };
        img.onerror = () => showAlert('Error', 'Failed to load the token image.');
        img.src = event.target.result;
    };
    reader.readAsDataURL(file);
    $('token-name').value = '';
    e.target.value = '';
});

// ── Rendering (rAF batched) ─────────────────────────────
let renderFlags = { map: false, grid: false, tokens: false, fog: false };
let renderScheduled = false;

function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
        if (renderFlags.map) _renderMap();
        if (renderFlags.grid) _renderGrid();
        if (renderFlags.tokens) _renderTokens();
        if (renderFlags.fog) _renderFog();
        renderFlags.map = renderFlags.grid = renderFlags.tokens = renderFlags.fog = false;
        renderScheduled = false;
    });
}

function renderMap() { renderFlags.map = true; scheduleRender(); }
function renderGrid() { renderFlags.grid = true; scheduleRender(); }
function renderTokens() { renderFlags.tokens = true; scheduleRender(); }
function renderFog() { renderFlags.fog = true; scheduleRender(); }

function _renderMap() {
    if (!mapImage) return;
    mapCtx.clearRect(0, 0, mapCanvas.width, mapCanvas.height);
    mapCtx.drawImage(mapImage, 0, 0);
}

function _renderGrid() {
    gridCtx.clearRect(0, 0, gridCanvas.width, gridCanvas.height);
    if (!isGridVisible || !mapImage) return;

    gridCtx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
    gridCtx.lineWidth = 1;
    gridCtx.beginPath();

    const w = gridCanvas.width;
    const h = gridCanvas.height;
    for (let x = 0; x <= w; x += gridSize) {
        gridCtx.moveTo(x, 0);
        gridCtx.lineTo(x, h);
    }
    for (let y = 0; y <= h; y += gridSize) {
        gridCtx.moveTo(0, y);
        gridCtx.lineTo(w, y);
    }
    gridCtx.stroke();
}

function _renderTokens() {
    tokenCtx.clearRect(0, 0, tokenCanvas.width, tokenCanvas.height);
    const sizeLabels = { 2: 'L', 3: 'H', 4: 'G' };

    for (const t of tokens) {
        const tSize = (t.size || 1) * gridSize;
        const radius = tSize / 2;

        // Clipped token image
        tokenCtx.save();
        tokenCtx.beginPath();
        tokenCtx.arc(t.x, t.y, radius, 0, Math.PI * 2);
        tokenCtx.closePath();
        tokenCtx.clip();
        tokenCtx.drawImage(t.img, t.x - radius, t.y - radius, tSize, tSize);
        tokenCtx.restore();

        // Border ring
        tokenCtx.strokeStyle = '#d97706';
        tokenCtx.lineWidth = 3;
        tokenCtx.beginPath();
        tokenCtx.arc(t.x, t.y, radius, 0, Math.PI * 2);
        tokenCtx.stroke();

        // Size badge for non-standard sizes
        if ((t.size || 1) > 1) {
            const label = sizeLabels[t.size] || '';
            tokenCtx.fillStyle = 'rgba(217, 119, 6, 0.9)';
            tokenCtx.beginPath();
            tokenCtx.arc(t.x + radius - 8, t.y - radius + 8, 10, 0, Math.PI * 2);
            tokenCtx.fill();
            tokenCtx.fillStyle = '#fff';
            tokenCtx.font = 'bold 11px Cinzel, serif';
            tokenCtx.textAlign = 'center';
            tokenCtx.textBaseline = 'middle';
            tokenCtx.fillText(label, t.x + radius - 8, t.y - radius + 8);
        }

        // Name label
        if (t.name) {
            tokenCtx.fillStyle = 'rgba(12, 10, 9, 0.9)';
            tokenCtx.font = '12px Lora, serif';
            const textWidth = tokenCtx.measureText(t.name).width;
            tokenCtx.roundRect(t.x - textWidth / 2 - 6, t.y + radius + 4, textWidth + 12, 20, 4);
            tokenCtx.fill();
            tokenCtx.strokeStyle = '#78350f';
            tokenCtx.lineWidth = 1;
            tokenCtx.stroke();
            tokenCtx.fillStyle = '#fde68a';
            tokenCtx.textAlign = 'center';
            tokenCtx.fillText(t.name, t.x, t.y + radius + 18);
        }
    }
}

function _renderFog() {
    fogCtx.clearRect(0, 0, fogCanvas.width, fogCanvas.height);
    for (const shape of fogShapes) {
        if (shape.isHidden || isDMMode) {
            fogCtx.beginPath();
            fogCtx.moveTo(shape.points[0].x, shape.points[0].y);
            for (const p of shape.points) fogCtx.lineTo(p.x, p.y);
            fogCtx.closePath();
            if (shape.isHidden) {
                fogCtx.fillStyle = isDMMode ? 'rgba(0,0,0,0.6)' : '#000000';
                fogCtx.fill();
            } else if (isDMMode) {
                fogCtx.strokeStyle = 'rgba(217, 119, 6, 0.5)';
                fogCtx.lineWidth = 2;
                fogCtx.stroke();
            }
        }
    }
    if (isDrawing && currentDrawPoints.length > 0) {
        fogCtx.beginPath();
        fogCtx.moveTo(currentDrawPoints[0].x, currentDrawPoints[0].y);
        for (const p of currentDrawPoints) fogCtx.lineTo(p.x, p.y);
        fogCtx.strokeStyle = '#d97706';
        fogCtx.lineWidth = 3;
        fogCtx.stroke();
    }
}

// ── Interaction Engine ──────────────────────────────────
function getPointerPos(evt) {
    const rect = wrapper.getBoundingClientRect();
    return {
        x: (evt.clientX - rect.left - transform.x) / transform.scale,
        y: (evt.clientY - rect.top - transform.y) / transform.scale,
        rawX: evt.clientX,
        rawY: evt.clientY
    };
}

function createPing(pos) {
    const ping = document.createElement('div');
    ping.className = 'ping-ring';
    ping.style.left = pos.rawX + 'px';
    ping.style.top = pos.rawY + 'px';
    wrapper.appendChild(ping);
    setTimeout(() => ping.remove(), 1000);
}

wrapper.addEventListener('wheel', (e) => {
    e.preventDefault();
    const zoomAmount = e.deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.min(Math.max(transform.scale * zoomAmount, 0.1), 5);
    const rect = wrapper.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    transform.x = mouseX - (mouseX - transform.x) * (newScale / transform.scale);
    transform.y = mouseY - (mouseY - transform.y) * (newScale / transform.scale);
    transform.scale = newScale;
    updateTransform();
}, { passive: false });

// ── Context Menu ────────────────────────────────────────
let ctxTargetToken = null;

function showContextMenu(x, y, token) {
    ctxTargetToken = token;
    ctxMenu.style.left = x + 'px';
    ctxMenu.style.top = y + 'px';
    ctxMenu.classList.remove('hidden');
    requestAnimationFrame(() => {
        const menuRect = ctxMenu.getBoundingClientRect();
        if (menuRect.right > window.innerWidth) ctxMenu.style.left = (x - menuRect.width) + 'px';
        if (menuRect.bottom > window.innerHeight) ctxMenu.style.top = (y - menuRect.height) + 'px';
    });
}

function hideContextMenu() {
    ctxMenu.classList.add('hidden');
    ctxTargetToken = null;
}

document.addEventListener('click', (e) => {
    if (!ctxMenu.contains(e.target)) hideContextMenu();
});

ctxMenu.querySelectorAll('.ctx-item').forEach(item => {
    item.addEventListener('click', () => {
        if (!ctxTargetToken) return;
        const action = item.dataset.action;
        if (action === 'rename') {
            showPrompt('Rename Token', ctxTargetToken.name || '', (newName) => {
                if (newName !== null) {
                    ctxTargetToken.name = newName;
                    renderTokens();
                    pushHistory();
                    saveCurrentState();
                }
            });
        } else if (action === 'resize-up') {
            ctxTargetToken.size = Math.min((ctxTargetToken.size || 1) + 1, 4);
            renderTokens(); pushHistory(); saveCurrentState();
        } else if (action === 'resize-down') {
            ctxTargetToken.size = Math.max((ctxTargetToken.size || 1) - 1, 1);
            renderTokens(); pushHistory(); saveCurrentState();
        } else if (action === 'delete') {
            tokens = tokens.filter(t => t.id !== ctxTargetToken.id);
            renderTokens(); pushHistory(); saveCurrentState();
        }
        hideContextMenu();
    });
});

fogCanvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!isDMMode) return;
    const pos = getPointerPos(e);
    for (let i = tokens.length - 1; i >= 0; i--) {
        const t = tokens[i];
        const radius = ((t.size || 1) * gridSize) / 2;
        if (Math.hypot(pos.x - t.x, pos.y - t.y) < radius) {
            showContextMenu(e.clientX, e.clientY, t);
            return;
        }
    }
});

// ── Keyboard Shortcuts ──────────────────────────────────
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if (!isDMMode) return;
    if (e.ctrlKey && e.key === 'z') { e.preventDefault(); undo(); return; }
    if (e.ctrlKey && e.key === 'y') { e.preventDefault(); redo(); return; }
    switch (e.key.toLowerCase()) {
        case 'd': setTool('drag', 'tool-drag'); break;
        case 'p': setTool('pan', 'tool-pan'); break;
        case 'f': setTool('fog-draw', 'tool-fog-draw'); break;
        case 'r': setTool('fog-rect', 'tool-fog-rect'); break;
        case 't': setTool('fog-toggle', 'tool-fog-toggle'); break;
        case 'g': isGridVisible = !isGridVisible; renderGrid(); break;
    }
});

// ── Pointer Handling ────────────────────────────────────
fogCanvas.addEventListener('pointerdown', (e) => {
    if (e.button === 2) return;
    hideContextMenu();
    activePointers.set(e.pointerId, e);
    fogCanvas.setPointerCapture(e.pointerId);

    // Two-finger pinch start
    if (activePointers.size === 2) {
        isDrawing = false; activeToken = null; isPanning = false;
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
        const pts = Array.from(activePointers.values());
        lastPinchDist = Math.hypot(pts[0].clientX - pts[1].clientX, pts[0].clientY - pts[1].clientY);
        lastPointerCenter = {
            x: (pts[0].clientX + pts[1].clientX) / 2,
            y: (pts[0].clientY + pts[1].clientY) / 2
        };
        return;
    }

    const pos = getPointerPos(e);
    lastPointerCenter = { x: e.clientX, y: e.clientY };

    if (e.button === 1 || currentTool === 'pan') { isPanning = true; return; }

    let tokenHit = null;
    if (!isDMMode || currentTool === 'drag') {
        for (let i = tokens.length - 1; i >= 0; i--) {
            const t = tokens[i];
            const radius = ((t.size || 1) * gridSize) / 2;
            if (Math.hypot(pos.x - t.x, pos.y - t.y) < radius) {
                tokenHit = t;
                activeToken = tokenHit;
                break;
            }
        }
    }

    if (!tokenHit && currentTool === 'drag' && e.button !== 2) { isPanning = true; return; }

    longPressTimer = setTimeout(() => {
        longPressTimer = null;
        if (tokenHit && isDMMode) {
            showContextMenu(e.clientX, e.clientY, tokenHit);
        } else if (!tokenHit) {
            createPing(pos);
        }
        activeToken = null;
    }, 800);

    if (tokenHit) return;

    if (isDMMode) {
        if (currentTool === 'fog-draw' || currentTool === 'fog-rect') {
            isDrawing = true;
            currentDrawPoints = [pos];
        } else if (currentTool === 'fog-toggle') {
            processFogTap(pos);
        }
    }
});

fogCanvas.addEventListener('pointermove', (e) => {
    if (!activePointers.has(e.pointerId)) return;
    activePointers.set(e.pointerId, e);

    if (activePointers.size === 2) {
        const pts = Array.from(activePointers.values());
        const currentDist = Math.hypot(pts[0].clientX - pts[1].clientX, pts[0].clientY - pts[1].clientY);
        const currentCenter = {
            x: (pts[0].clientX + pts[1].clientX) / 2,
            y: (pts[0].clientY + pts[1].clientY) / 2
        };
        if (lastPinchDist && lastPointerCenter) {
            transform.x += currentCenter.x - lastPointerCenter.x;
            transform.y += currentCenter.y - lastPointerCenter.y;
            const zoomAmount = currentDist / lastPinchDist;
            const newScale = Math.min(Math.max(transform.scale * zoomAmount, 0.1), 5);
            transform.x = currentCenter.x - (currentCenter.x - transform.x) * (newScale / transform.scale);
            transform.y = currentCenter.y - (currentCenter.y - transform.y) * (newScale / transform.scale);
            transform.scale = newScale;
        }
        lastPinchDist = currentDist;
        lastPointerCenter = currentCenter;
        updateTransform();
        return;
    }

    if (longPressTimer && activePointers.size === 1) {
        const deltaMove = Math.hypot(e.clientX - lastPointerCenter.x, e.clientY - lastPointerCenter.y);
        if (deltaMove > 5) { clearTimeout(longPressTimer); longPressTimer = null; }
    }

    if (isPanning && activePointers.size === 1) {
        transform.x += e.clientX - lastPointerCenter.x;
        transform.y += e.clientY - lastPointerCenter.y;
        lastPointerCenter = { x: e.clientX, y: e.clientY };
        updateTransform();
        return;
    }

    const pos = getPointerPos(e);
    if (activeToken) {
        activeToken.x = pos.x;
        activeToken.y = pos.y;
        renderTokens();
    } else if (isDMMode && isDrawing) {
        if (currentTool === 'fog-draw') {
            const lastPos = currentDrawPoints[currentDrawPoints.length - 1];
            if (Math.hypot(pos.x - lastPos.x, pos.y - lastPos.y) > 5) {
                currentDrawPoints.push(pos);
                renderFog();
            }
        } else if (currentTool === 'fog-rect') {
            const startPos = currentDrawPoints[0];
            currentDrawPoints = [
                startPos,
                { x: pos.x, y: startPos.y },
                pos,
                { x: startPos.x, y: pos.y }
            ];
            renderFog();
        }
    }
});

fogCanvas.addEventListener('pointerup', (e) => {
    activePointers.delete(e.pointerId);
    fogCanvas.releasePointerCapture(e.pointerId);
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }

    if (activePointers.size < 2) lastPinchDist = null;
    if (activePointers.size === 0) isPanning = false;

    if (activePointers.size === 1) {
        const remaining = Array.from(activePointers.values())[0];
        lastPointerCenter = { x: remaining.clientX, y: remaining.clientY };
    }

    if (activeToken) {
        activeToken = null;
        pushHistory();
        saveCurrentState();
    } else if (isDMMode && isDrawing) {
        isDrawing = false;
        if ((currentTool === 'fog-draw' && currentDrawPoints.length > 3) ||
            (currentTool === 'fog-rect' && currentDrawPoints.length === 4)) {
            fogShapes.push({ id: Date.now(), points: currentDrawPoints, isHidden: true });
            pushHistory();
            saveCurrentState();
        }
        currentDrawPoints = [];
        renderFog();
    }
});

function processFogTap(pos) {
    for (let i = fogShapes.length - 1; i >= 0; i--) {
        const shape = fogShapes[i];
        fogCtx.beginPath();
        fogCtx.moveTo(shape.points[0].x, shape.points[0].y);
        for (const p of shape.points) fogCtx.lineTo(p.x, p.y);
        fogCtx.closePath();
        if (fogCtx.isPointInPath(pos.x, pos.y)) {
            shape.isHidden = !shape.isHidden;
            renderFog();
            pushHistory();
            saveCurrentState();
            break;
        }
    }
}
