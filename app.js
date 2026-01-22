const SHEETS_CSV_URL = 'https://docs.google.com/spreadsheets/d/1NrYADsW4s7wRYTE91Z0EFHbXcHaswuuMzG9a2WyGG0A/export?format=csv&gid=2010162056';
const STORAGE_KEY_DATA = 'ad_ec_tracker_completed_v1';
const STORAGE_KEY_SETTINGS = 'ad_ec_tracker_settings_v1';
const STORAGE_KEY_HINT_DISMISSED = 'ad_ec_tracker_hint_dismissed';

let currentItems = [];
let defaultItems = [];
let isModified = false;
let cascadeAllPreviousEnabled = false;

// Drag State globals
let dragGhost = null;
let dragSourceEl = null; // The real element being moved
let touchOffsetX = 0;
let touchOffsetY = 0;
let autoScrollInterval = null;
let longPressTimer = null;

// Trash zone height when visible (bottom: 15px + height: 48px + some margin)
const TRASH_ZONE_HEIGHT = 90;
const LONG_PRESS_DURATION = 300; // ms for long press to trigger drag

async function init() {
    const listContainer = document.getElementById('challenge-list');
    const loadingEl = document.getElementById('loading');
    const errorContainer = document.getElementById('error-container');

    try {
        const response = await fetch(SHEETS_CSV_URL);
        if (!response.ok) throw new Error('Failed to fetch data from Google Sheets');
        const text = await response.text();

        const rawData = parseCSV(text);
        defaultItems = [];
        for (let i = 2; i < rawData.length; i++) {
            const row = rawData[i];
            if (row.length >= 3 && row[1]) {
                defaultItems.push({
                    id: `row-${i}`,
                    task: row[1].trim(),
                    tree: row[2] ? row[2].trim() : '',
                    done: false
                });
            }
        }

        const stored = localStorage.getItem(STORAGE_KEY_DATA);
        if (stored) {
            const parsed = JSON.parse(stored);

            // Check if this is OLD format (array of integer IDs like [2, 5, 7])
            if (Array.isArray(parsed) && (parsed.length === 0 || typeof parsed[0] === 'number')) {
                // MIGRATE: Old format was just an array of completed row indices
                const completedIndices = new Set(parsed);
                currentItems = defaultItems.map(item => ({
                    ...item,
                    // Old IDs were integers like 2, new IDs are strings like "row-2"
                    done: completedIndices.has(parseInt(item.id.replace('row-', '')))
                }));
                // Save in new format
                saveData();
            } else {
                // New format - array of item objects
                currentItems = parsed;
            }
        } else {
            currentItems = JSON.parse(JSON.stringify(defaultItems));
        }

        renderList();
        setupControls();
        checkModified();
        loadingEl.style.display = 'none';
        scrollToProgress();
        checkMobileHint();

    } catch (err) {
        loadingEl.style.display = 'none';
        errorContainer.innerHTML = `<div class="error">Error: ${err.message}</div>`;
    }
}

function setupControls() {
    const clearBtn = document.getElementById('clear-checkboxes');
    const cascadeToggle = document.getElementById('cascade-toggle');

    const storedSettings = localStorage.getItem(STORAGE_KEY_SETTINGS);
    if (storedSettings) {
        try {
            const settings = JSON.parse(storedSettings);
            cascadeAllPreviousEnabled = !!settings.cascadeAllPreviousEnabled;
        } catch { cascadeAllPreviousEnabled = false; }
    }
    if (cascadeToggle) cascadeToggle.checked = cascadeAllPreviousEnabled;

    if (clearBtn) {
        clearBtn.onclick = () => {
            currentItems.forEach(item => item.done = false);
            renderList();
            saveData();
        };
    }

    if (cascadeToggle) {
        cascadeToggle.onchange = (e) => {
            cascadeAllPreviousEnabled = !!e.target.checked;
            localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify({
                cascadeAllPreviousEnabled
            }));
        };
    }
}

function renderList() {
    const container = document.getElementById('challenge-list');
    container.innerHTML = '';

    currentItems.forEach((item) => {
        const card = document.createElement('div');
        const formatted = formatTaskText(item.task);
        const ecClass = formatted.ecNum ? `ec-themed ec-${formatted.ecNum}` : '';
        card.className = `card ${item.done ? 'done' : ''} ${ecClass}`.trim();
        if (formatted.ecNum) {
            card.dataset.ec = String(formatted.ecNum);
        }
        card.dataset.id = item.id; // Store ID in DOM

        // HTML Structure
        card.innerHTML = `
        <div class="card-header">
            <div class="drag-handle">⠿</div>
            <div class="checkbox-wrapper">
                <input type="checkbox" ${item.done ? 'checked' : ''}>
            </div>
            <div class="task-text" contenteditable="true" spellcheck="false">${formatted.html}</div>
        </div>
        ${item.tree ? `
        <div class="actions">
            <div class="tree-preview" contenteditable="true" spellcheck="false">${escapeHtml(item.tree)}</div>
            <button class="copy-btn" aria-label="Copy tree" title="Copy tree">⧉</button>
        </div>` : ''}
    `;

        // Bind Events (Using Closures correctly with ID lookup)
        const checkbox = card.querySelector('input[type="checkbox"]');
        checkbox.onchange = (e) => toggleStatus(item.id, e.target.checked);

        const textDiv = card.querySelector('.task-text');
        textDiv.onblur = (e) => updateText(item.id, e.target.innerText);
        textDiv.onkeydown = (e) => {
            if (e.key === 'Enter') { e.preventDefault(); textDiv.blur(); }
        };

        const dragHandle = card.querySelector('.drag-handle');

        // Set up BOTH handlers - let the input type determine which fires
        // Desktop: pointer events on drag handle
        if (dragHandle) {
            setupPointerDrag(dragHandle, card);
        }
        // Mobile: touch events on the whole card (long-press)
        setupLongPressDrag(card);

        if (item.tree) {
            const treeDiv = card.querySelector('.tree-preview');
            treeDiv.onblur = (e) => updateTree(item.id, e.target.innerText);
            treeDiv.onkeydown = (e) => {
                if (e.key === 'Enter') { e.preventDefault(); treeDiv.blur(); }
            };
            const copyBtn = card.querySelector('.copy-btn');
            copyBtn.onclick = () => copyToClipboard(treeDiv.innerText.trim(), copyBtn);
        }

        container.appendChild(card);
    });
}

// --- Robust Document-Based Drag ---
function setupPointerDrag(handle, card) {
    handle.onpointerdown = function (e) {
        e.preventDefault();
        // e.stopPropagation(); // Removed to allow safe bubbling

        dragSourceEl = card;
        const rect = card.getBoundingClientRect();
        touchOffsetX = e.clientX - rect.left;
        touchOffsetY = e.clientY - rect.top;

        // 1. Create Ghost
        dragGhost = card.cloneNode(true);
        dragGhost.classList.add('dragging-ghost');
        dragGhost.style.width = rect.width + 'px';
        dragGhost.style.height = rect.height + 'px';
        // Disable editing on ghost
        dragGhost.querySelector('.task-text').removeAttribute('contenteditable');
        const ghostTree = dragGhost.querySelector('.tree-preview');
        if (ghostTree) ghostTree.removeAttribute('contenteditable');
        document.body.appendChild(dragGhost);

        // 2. Mark Original as Placeholder
        card.classList.add('placeholder');

        // 3. Show Trash
        document.getElementById('trash-zone').classList.add('visible');

        // 4. Initial Position
        moveGhost(e.clientX, e.clientY);

        // 5. BIND TO DOCUMENT (Fixes the freeze issue)
        document.addEventListener('pointermove', onPointerMove, { passive: false });
        document.addEventListener('pointerup', onPointerUp);
        document.addEventListener('pointercancel', onPointerUp);
    };

    function onPointerMove(e) {
        e.preventDefault(); // Prevent scrolling
        moveGhost(e.clientX, e.clientY);

        const trashZone = document.getElementById('trash-zone');
        const trashRect = trashZone.getBoundingClientRect();

        // Check Trash Collision
        if (e.clientY > trashRect.top) {
            trashZone.classList.add('active');
            dragGhost.classList.add('deleting');
            // Hide placeholder when over trash (we're deleting, not reordering)
            dragSourceEl.style.display = 'none';
            // Stop scrolling when over trash
            clearInterval(autoScrollInterval);
        } else {
            trashZone.classList.remove('active');
            dragGhost.classList.remove('deleting');
            // Show placeholder again
            dragSourceEl.style.display = '';

            // --- Geometric Reordering ---
            const container = document.getElementById('challenge-list');
            const siblings = Array.from(container.children);

            let closestElement = null;
            let minDistance = Infinity;

            // Find element we are hovering over
            siblings.forEach(sibling => {
                if (sibling === dragSourceEl) return; // Skip self

                const box = sibling.getBoundingClientRect();
                const boxCenterY = box.top + box.height / 2;
                const distance = e.clientY - boxCenterY;

                // If we are within the vertical bounds of the item
                if (e.clientY > box.top && e.clientY < box.bottom) {
                    if (Math.abs(distance) < minDistance) {
                        minDistance = Math.abs(distance);
                        closestElement = sibling;
                    }
                }
            });

            if (closestElement) {
                const rect = closestElement.getBoundingClientRect();
                const midY = rect.top + rect.height / 2;

                if (e.clientY < midY) {
                    // Insert before
                    if (dragSourceEl.nextElementSibling !== closestElement) {
                        container.insertBefore(dragSourceEl, closestElement);
                    }
                } else {
                    // Insert after
                    if (dragSourceEl.previousElementSibling !== closestElement) {
                        container.insertBefore(dragSourceEl, closestElement.nextSibling);
                    }
                }
            }

            handleAutoScroll(e.clientY);
        }
    }

    function onPointerUp(e) {
        // Remove Global Listeners immediately
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', onPointerUp);
        document.removeEventListener('pointercancel', onPointerUp);

        const trashZone = document.getElementById('trash-zone');
        const isTrash = trashZone.classList.contains('active');

        // Cleanup UI
        if (dragGhost) dragGhost.remove();
        dragGhost = null;
        if (dragSourceEl) dragSourceEl.classList.remove('placeholder');

        trashZone.classList.remove('visible', 'active');
        clearInterval(autoScrollInterval);

        if (isTrash && dragSourceEl) {
            // Delete
            dragSourceEl.remove(); // Remove from DOM
            rebuildAndSave();
        } else {
            // Just Save Order
            rebuildAndSave();
        }
        dragSourceEl = null;
    }
}

// --- Long Press Drag for Mobile (using touch events) ---
function setupLongPressDrag(card) {
    let startX, startY;
    let lastX, lastY; // Track current position
    let isDragging = false;
    let touchedEditable = false; // Track if we started on an editable element
    let shouldPreventDefault = false;

    // Prevent context menu on long press
    card.addEventListener('contextmenu', function (e) {
        e.preventDefault();
    });

    card.addEventListener('touchstart', function (e) {
        // Don't trigger on checkbox or buttons
        if (e.target.matches('input, button, .copy-btn')) {
            return;
        }

        // Check if we touched an editable element
        touchedEditable = e.target.matches('.task-text, .tree-preview') ||
            e.target.closest('.task-text, .tree-preview') !== null;

        const touch = e.touches[0];
        startX = touch.clientX;
        startY = touch.clientY;
        lastX = startX;
        lastY = startY;
        isDragging = false;
        shouldPreventDefault = false;

        // Start long press timer
        longPressTimer = setTimeout(() => {
            isDragging = true;
            shouldPreventDefault = true;

            // Prevent text from being focused - blur any focused element
            document.activeElement?.blur();

            // Clear any text selection that might have started
            window.getSelection()?.removeAllRanges();

            // Haptic feedback if available
            if (navigator.vibrate) navigator.vibrate(50);

            // Start drag
            dragSourceEl = card;
            const rect = card.getBoundingClientRect();
            touchOffsetX = lastX - rect.left;
            touchOffsetY = lastY - rect.top;

            // Create Ghost
            dragGhost = card.cloneNode(true);
            dragGhost.classList.add('dragging-ghost');
            dragGhost.style.width = rect.width + 'px';
            dragGhost.style.height = rect.height + 'px';
            const ghostText = dragGhost.querySelector('.task-text');
            if (ghostText) ghostText.removeAttribute('contenteditable');
            const ghostTree = dragGhost.querySelector('.tree-preview');
            if (ghostTree) ghostTree.removeAttribute('contenteditable');
            document.body.appendChild(dragGhost);

            // Mark as placeholder
            card.classList.add('placeholder');

            // Show trash
            document.getElementById('trash-zone').classList.add('visible');

            // Position ghost at current touch position
            moveGhost(lastX, lastY);
        }, LONG_PRESS_DURATION);

        // If on editable, we need to be able to prevent default after timer fires
        // We'll handle this via a short delay check
        if (touchedEditable) {
            // Set up a check slightly before the long press triggers
            setTimeout(() => {
                // If timer is still active (not cancelled by movement), 
                // we're about to enter drag mode
                if (longPressTimer) {
                    shouldPreventDefault = true;
                }
            }, LONG_PRESS_DURATION - 50);
        }
    }, { passive: true }); // Keep passive for initial touch

    // Use a separate listener on editable elements to prevent focus on long press
    const editables = card.querySelectorAll('.task-text, .tree-preview');
    editables.forEach(editable => {
        let editableTouchStart = 0;

        editable.addEventListener('touchstart', function (e) {
            editableTouchStart = Date.now();
        }, { passive: true });

        editable.addEventListener('touchend', function (e) {
            const touchDuration = Date.now() - editableTouchStart;

            // If this was a long press (or drag was triggered), prevent the tap from focusing
            // But DON'T stopPropagation - we need the card's touchend to fire to complete the drag
            if (touchDuration >= LONG_PRESS_DURATION || isDragging) {
                e.preventDefault();
                // Don't stop propagation - let the card's touchend handler run
            }
            // Short tap: allow normal behavior (focus for editing)
        }, { passive: false });

        // Prevent focus during drag
        editable.addEventListener('focus', function (e) {
            if (isDragging) {
                e.preventDefault();
                editable.blur();
            }
        });
    });

    card.addEventListener('touchmove', function (e) {
        const touch = e.touches[0];

        // Always update last position
        lastX = touch.clientX;
        lastY = touch.clientY;

        // Cancel long press if moved too much before it triggered
        if (longPressTimer && !isDragging) {
            const dx = Math.abs(touch.clientX - startX);
            const dy = Math.abs(touch.clientY - startY);
            if (dx > 10 || dy > 10) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
            return;
        }

        // If dragging, handle the drag
        if (isDragging && dragGhost) {
            e.preventDefault(); // Prevent scroll during drag

            const touch = e.touches[0];
            moveGhost(touch.clientX, touch.clientY);

            const trashZone = document.getElementById('trash-zone');
            const trashRect = trashZone.getBoundingClientRect();

            if (touch.clientY > trashRect.top) {
                trashZone.classList.add('active');
                dragGhost.classList.add('deleting');
                dragSourceEl.style.display = 'none';
                clearInterval(autoScrollInterval);
            } else {
                trashZone.classList.remove('active');
                dragGhost.classList.remove('deleting');
                dragSourceEl.style.display = '';

                // Geometric reordering
                const container = document.getElementById('challenge-list');
                const siblings = Array.from(container.children);

                let closestElement = null;
                let minDistance = Infinity;

                siblings.forEach(sibling => {
                    if (sibling === dragSourceEl) return;

                    const box = sibling.getBoundingClientRect();
                    const boxCenterY = box.top + box.height / 2;
                    const distance = touch.clientY - boxCenterY;

                    if (touch.clientY > box.top && touch.clientY < box.bottom) {
                        if (Math.abs(distance) < minDistance) {
                            minDistance = Math.abs(distance);
                            closestElement = sibling;
                        }
                    }
                });

                if (closestElement) {
                    const rect = closestElement.getBoundingClientRect();
                    const midY = rect.top + rect.height / 2;

                    if (touch.clientY < midY) {
                        if (dragSourceEl.nextElementSibling !== closestElement) {
                            container.insertBefore(dragSourceEl, closestElement);
                        }
                    } else {
                        if (dragSourceEl.previousElementSibling !== closestElement) {
                            container.insertBefore(dragSourceEl, closestElement.nextSibling);
                        }
                    }
                }

                handleAutoScroll(touch.clientY);
            }
        }
    }, { passive: false });

    card.addEventListener('touchend', function (e) {
        if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }

        if (isDragging) {
            e.preventDefault();
            finishDrag();
        }
        isDragging = false;
    });

    card.addEventListener('touchcancel', function () {
        if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }

        if (isDragging) {
            finishDrag();
        }
        isDragging = false;
    });

    function finishDrag() {
        const trashZone = document.getElementById('trash-zone');
        const isTrash = trashZone.classList.contains('active');

        if (dragGhost) dragGhost.remove();
        dragGhost = null;
        if (dragSourceEl) {
            dragSourceEl.classList.remove('placeholder');
            dragSourceEl.style.display = '';
        }

        trashZone.classList.remove('visible', 'active');
        clearInterval(autoScrollInterval);

        if (isTrash && dragSourceEl) {
            dragSourceEl.remove();
            rebuildAndSave();
        } else {
            rebuildAndSave();
        }
        dragSourceEl = null;
    }
}

function moveGhost(x, y) {
    if (dragGhost) {
        // Use simple styles for maximum performance
        dragGhost.style.left = (x - touchOffsetX) + 'px';
        dragGhost.style.top = (y - touchOffsetY) + 'px';
    }
}

function handleAutoScroll(y) {
    const threshold = 100;
    const maxScrollSpeed = 20;
    clearInterval(autoScrollInterval);

    // Bottom scroll zone ends before the trash zone area
    const bottomScrollLimit = window.innerHeight - TRASH_ZONE_HEIGHT;

    if (y < threshold) {
        autoScrollInterval = setInterval(() => window.scrollBy(0, -maxScrollSpeed), 16);
    } else if (y > bottomScrollLimit && y < window.innerHeight - TRASH_ZONE_HEIGHT + threshold) {
        // Only scroll when in the zone above the trash, not at the very bottom
        autoScrollInterval = setInterval(() => window.scrollBy(0, maxScrollSpeed), 16);
    }
}

// --- Data Logic (ID Based) ---

// Reconstruct currentItems array from the DOM order
function rebuildAndSave() {
    const list = document.getElementById('challenge-list');
    const newOrderIds = Array.from(list.children).map(el => el.dataset.id);

    // Map current items by ID
    const idToItemMap = new Map(currentItems.map(i => [i.id, i]));

    // Create new sorted array
    currentItems = newOrderIds
        .map(id => idToItemMap.get(id))
        .filter(item => item !== undefined);

    saveData();
}

function toggleStatus(id, isChecked) {
    const item = currentItems.find(i => i.id === id);
    if (item) {
        item.done = isChecked;
        saveData();
        // Update visual class
        const card = document.querySelector(`.card[data-id="${id}"]`);
        if (card) isChecked ? card.classList.add('done') : card.classList.remove('done');
    }
    if (isChecked && cascadeAllPreviousEnabled) {
        cascadePreviousChecks(id);
    }
    if (isChecked) {
        cascadeEcChecks(id);
    }
}

function updateText(id, newText) {
    const item = currentItems.find(i => i.id === id);
    if (item && item.task !== newText) {
        item.task = newText;
        saveData();
    }
    applyEcStyling(id, newText);
}

function updateTree(id, newText) {
    const item = currentItems.find(i => i.id === id);
    if (item && item.tree !== newText) {
        item.tree = newText;
        saveData();
    }
}

function extractEcInfo(text) {
    const match = String(text || '').match(/^EC(\d+)x(\d+)\b/i);
    if (!match) return null;
    return { ec: parseInt(match[1], 10), level: parseInt(match[2], 10) };
}

function cascadeEcChecks(id) {
    const item = currentItems.find(i => i.id === id);
    const info = item ? extractEcInfo(item.task) : null;
    if (!info || !Number.isFinite(info.ec) || !Number.isFinite(info.level)) return;

    currentItems.forEach((other) => {
        if (other.id === id) return;
        const otherInfo = extractEcInfo(other.task);
        if (!otherInfo) return;
        if (otherInfo.ec === info.ec && otherInfo.level < info.level) {
            other.done = true;
            const card = document.querySelector(`.card[data-id="${other.id}"]`);
            if (card) {
                card.classList.add('done');
                const checkbox = card.querySelector('input[type="checkbox"]');
                if (checkbox) checkbox.checked = true;
            }
        }
    });
    saveData();
}

function cascadePreviousChecks(id) {
    const index = currentItems.findIndex(i => i.id === id);
    if (index <= 0) return;

    for (let i = 0; i < index; i++) {
        const other = currentItems[i];
        if (!other.done) {
            other.done = true;
            const card = document.querySelector(`.card[data-id="${other.id}"]`);
            if (card) {
                card.classList.add('done');
                const checkbox = card.querySelector('input[type="checkbox"]');
                if (checkbox) checkbox.checked = true;
            }
        }
    }
    saveData();
}

function applyEcStyling(id, taskText) {
    const card = document.querySelector(`.card[data-id="${id}"]`);
    if (!card) return;
    const formatted = formatTaskText(taskText);
    const textDiv = card.querySelector('.task-text');
    if (textDiv) textDiv.innerHTML = formatted.html;

    card.classList.remove('ec-themed');
    card.classList.forEach((cls) => {
        if (cls.startsWith('ec-')) card.classList.remove(cls);
    });

    if (formatted.ecNum) {
        card.classList.add('ec-themed', `ec-${formatted.ecNum}`);
        card.dataset.ec = String(formatted.ecNum);
    } else {
        delete card.dataset.ec;
    }
}

function saveData() {
    localStorage.setItem(STORAGE_KEY_DATA, JSON.stringify(currentItems));
    checkModified();
}

function checkModified() {
    const btnContainer = document.getElementById('reset-container');
    const currentStr = JSON.stringify(currentItems.map(i => ({ t: i.task, tree: i.tree, id: i.id })));
    const defaultStr = JSON.stringify(defaultItems.map(i => ({ t: i.task, tree: i.tree, id: i.id })));

    // Show reset if anything fundamental changed (ignoring done status)
    if (currentStr !== defaultStr || currentItems.length !== defaultItems.length) {
        btnContainer.style.display = 'block';
    } else {
        btnContainer.style.display = 'none';
    }
}

function confirmReset() {
    if (confirm("Are you sure? This will reset order, text, and deleted items to default.")) {
        currentItems = JSON.parse(JSON.stringify(defaultItems));
        saveData();
        renderList();
    }
}

function parseCSV(text) {
    const rows = [];
    let currentRow = [];
    let currentVal = '';
    let insideQuotes = false;
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const nextChar = text[i + 1];
        if (char === '"') {
            if (insideQuotes && nextChar === '"') { currentVal += '"'; i++; }
            else { insideQuotes = !insideQuotes; }
        } else if (char === ',' && !insideQuotes) {
            currentRow.push(currentVal); currentVal = '';
        } else if (char === '\n' && !insideQuotes) {
            currentRow.push(currentVal); rows.push(currentRow); currentRow = []; currentVal = '';
        } else { currentVal += char; }
    }
    if (currentVal || currentRow.length > 0) { currentRow.push(currentVal); rows.push(currentRow); }
    return rows;
}

function escapeHtml(text) {
    if (text == null) return '';
    return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatTaskText(text) {
    const safeText = text == null ? '' : String(text);
    const match = safeText.match(/^(EC(\d+)x\d+)(.*)$/);
    if (!match) {
        return { html: escapeHtml(safeText), ecNum: null };
    }
    const ecNum = parseInt(match[2], 10);
    const rest = match[3] || '';
    const html = `<span class="ec-prefix">${escapeHtml(match[1])}</span>${escapeHtml(rest)}`;
    return { html, ecNum: Number.isFinite(ecNum) ? ecNum : null };
}

function scrollToProgress() {
    // Find the last item that is marked 'done'
    let lastDoneId = null;
    for (let i = currentItems.length - 1; i >= 0; i--) {
        if (currentItems[i].done) {
            lastDoneId = currentItems[i].id;
            break;
        }
    }

    if (lastDoneId) {
        const el = document.querySelector(`.card[data-id="${lastDoneId}"]`);
        if (el) {
            setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
        }
    }
}

async function copyToClipboard(text, btnElement) {
    try {
        await navigator.clipboard.writeText(text);
        const originalText = btnElement.textContent;
        btnElement.textContent = '✓';
        btnElement.classList.add('copied');
        setTimeout(() => {
            btnElement.textContent = originalText;
            btnElement.classList.remove('copied');
        }, 1500);
    } catch (err) { alert('Manual copy needed'); }
}

function checkMobileHint() {
    const hint = document.getElementById('mobile-hint');
    if (!hint) return;

    // If user has dismissed the hint before, hide it
    if (localStorage.getItem(STORAGE_KEY_HINT_DISMISSED) === 'true') {
        hint.classList.add('hidden');
    }
}

function dismissHint() {
    const hint = document.getElementById('mobile-hint');
    if (hint) {
        hint.classList.add('hidden');
        localStorage.setItem(STORAGE_KEY_HINT_DISMISSED, 'true');
    }
}

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => { });
    });
}

init();
