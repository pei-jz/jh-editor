import { SHORTCUTS } from '../core/ShortcutDefinitions.js';
import { t } from '../utils/I18n.js';
import { icon as svgIcon } from './Icons.js';
import { shortcuts } from '../core/ShortcutManager.js';

// Friendly, purpose-oriented labels for each shortcut scope, in display order.
// Scopes found in SHORTCUTS but missing here still show up (with their raw name).
const SCOPE_META = [
    { scope: 'GLOBAL',          label: t('General'),        hint: 'Works anywhere' },
    { scope: 'EDITOR',          label: t('Editor'),         hint: 'Code & text editing' },
    { scope: 'EXPLORER',        label: t('Explorer'),       hint: 'File tree' },
    { scope: 'SEARCH',          label: t('Search Panel'),   hint: 'Find & replace' },
    { scope: 'MARKDOWN',        label: t('Markdown Edit'),  hint: 'Editing a block' },
    { scope: 'MARKDOWN_TABLE',  label: t('Markdown Table'), hint: 'Table editor' },
    { scope: 'MARKDOWN_BLOCK',  label: t('Markdown Select'), hint: 'Block selected' },
    { scope: 'CSV',             label: t('CSV Grid'),       hint: 'Cell selection' },
    { scope: 'CSV_EDIT',        label: t('CSV Cell Edit'),  hint: 'Editing a cell' },
    { scope: 'STRUCTURE_EDIT',  label: t('Structure Edit'), hint: 'XML/JSON tree' },
    { scope: 'AI_REVIEW',       label: t('AI Review'),      hint: 'Diff review' },
];

// How many category chips per row. Chips are laid out on a fixed grid so the
// columns line up instead of ragged-wrapping.
const CHIPS_PER_ROW = 6;

// Legacy: callers pass a mode ('text' | 'table' | 'csv') to preselect a category.
const modeMapping = {
    'text': 'MARKDOWN',
    'table': 'MARKDOWN_TABLE',
    'csv': 'CSV'
};

function formatKey(item) {
    let parts = [];
    if (item.ctrl) parts.push('Ctrl');
    if (item.alt) parts.push('Alt');
    if (item.shift) parts.push('Shift');
    parts.push(item.key.toUpperCase());
    return parts.join('+');
}

// Category access keys: 1-9 then A, B, C… so every chip stays a SINGLE
// keystroke (Alt+10 isn't typable).
function badgeFor(index1) {
    return index1 <= 9 ? String(index1) : String.fromCharCode(65 + (index1 - 10));
}
// Inverse of badgeFor: returns the 1-based index for a pressed key, or 0 for
// "All", or -1 when the key isn't a category accessor.
function indexForKey(key) {
    if (key === '0') return 0;
    if (/^[1-9]$/.test(key)) return parseInt(key, 10);
    if (/^[a-z]$/i.test(key)) return 10 + (key.toUpperCase().charCodeAt(0) - 65);
    return -1;
}

// Track collapsed state per scope
const collapsedState = {};
// null = show every category
let selectedScope = null;
let _guideKeyHandler = null;

function _injectStyles() {
    if (document.getElementById('shortcut-guide-cat-styles')) return;
    const style = document.createElement('style');
    style.id = 'shortcut-guide-cat-styles';
    style.textContent = `
    .sg-cat-bar {
        padding: 8px 0 10px; border-bottom: 1px solid var(--border-color); margin-bottom: 8px;
    }
    .sg-cat-grid {
        display: grid; grid-template-columns: repeat(${CHIPS_PER_ROW}, minmax(0, 1fr)); gap: 6px;
    }
    .sg-cat {
        display: inline-flex; align-items: center; gap: 6px; min-width: 0;
        padding: 5px 9px; font-size: 12px; line-height: 1.2; cursor: pointer; text-align: left;
        background: var(--bg-color); color: var(--text-color);
        border: 1px solid var(--border-color); border-radius: 6px;
        transition: background .12s, border-color .12s, color .12s;
    }
    .sg-cat:hover { background: var(--hover-color); border-color: var(--primary-color); }
    .sg-cat.active {
        background: var(--primary-color); color: #fff; border-color: var(--primary-color);
    }
    .sg-cat-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sg-cat-badge {
        flex-shrink: 0; font-size: 10px; opacity: .8; font-family: var(--editor-font-family, monospace);
        border: 1px solid currentColor; border-radius: 3px; padding: 0 4px; line-height: 1.4;
    }
    .sg-cat-count { flex-shrink: 0; font-size: 10px; opacity: .7; }
    .sg-cat.is-current .sg-cat-label::after { content: ' •'; opacity: .9; }
    .sg-cat-help { font-size: 11px; opacity: .65; margin-top: 8px; }
    .sg-group-hint { font-size: 11px; opacity: .6; margin-left: 6px; font-weight: normal; }
    `;
    document.head.appendChild(style);
}

/** Ordered scopes that actually have documented shortcuts. */
function _scopeList() {
    const known = SCOPE_META.filter(m => (SHORTCUTS[m.scope] || []).some(i => i.description));
    const extras = Object.keys(SHORTCUTS)
        .filter(s => !SCOPE_META.some(m => m.scope === s))
        .filter(s => (SHORTCUTS[s] || []).some(i => i.description))
        .map(s => ({ scope: s, label: s, hint: '' }));
    return [...known, ...extras];
}

export function showShortcutGuide(mode) {
    const overlay = document.getElementById('shortcut-guide-overlay');
    const container = document.getElementById('shortcut-guide');
    const list = document.getElementById('shortcut-list');
    const closeBtn = document.getElementById('close-shortcut-btn');
    const searchInput = document.getElementById('shortcut-search-input');

    if (!overlay || !container || !list) return;
    _injectStyles();

    // Preselect: explicit mode > the scope currently in effect > all.
    const preset = (mode && modeMapping[mode]) || null;
    selectedScope = preset || _currentScope() || null;

    overlay.onclick = (e) => { if (e.target === overlay) hideShortcutGuide(); };
    if (closeBtn) closeBtn.onclick = hideShortcutGuide;

    const rerender = () => {
        renderCategoryBar(list, searchInput ? searchInput.value.trim().toLowerCase() : '', rerender);
    };
    rerender();

    if (searchInput) {
        searchInput.value = '';
        searchInput.oninput = rerender;
        setTimeout(() => searchInput.focus(), 100);
    }

    // Alt+<key> picks a category (Alt so it never collides with typing in the
    // search box); Alt+0 shows everything. Escape closes.
    if (_guideKeyHandler) document.removeEventListener('keydown', _guideKeyHandler, true);
    _guideKeyHandler = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            hideShortcutGuide();
            return;
        }
        if (!e.altKey || e.ctrlKey || e.metaKey) return;
        const n = indexForKey(e.key);
        if (n < 0) return;
        const scopes = _scopeList();
        if (n === 0) selectedScope = null;
        else if (scopes[n - 1]) selectedScope = scopes[n - 1].scope;
        else return;
        e.preventDefault();
        rerender();
    };
    document.addEventListener('keydown', _guideKeyHandler, true);

    overlay.style.display = 'flex';
}

function _currentScope() {
    try {
        const s = shortcuts && shortcuts.currentScope;
        return s && SHORTCUTS[s] ? s : null;
    } catch (e) {
        return null;
    }
}

/** Render the category chips above the list, then the (filtered) list itself. */
function renderCategoryBar(list, filter, rerender) {
    const host = list.parentElement || list;
    let bar = host.querySelector('.sg-cat-bar');
    if (!bar) {
        bar = document.createElement('div');
        bar.className = 'sg-cat-bar';
        host.insertBefore(bar, list);
    }
    bar.innerHTML = '';

    const grid = document.createElement('div');
    grid.className = 'sg-cat-grid';
    bar.appendChild(grid);

    const scopes = _scopeList();
    const current = _currentScope();

    const mkChip = (label, scopeOrNull, badge, count, isCurrent, hint) => {
        const chip = document.createElement('button');
        chip.className = 'sg-cat';
        if (selectedScope === scopeOrNull) chip.classList.add('active');
        if (isCurrent) chip.classList.add('is-current');
        chip.title = `${label}${hint ? ' — ' + hint : ''}${isCurrent ? ' (current mode)' : ''}\nAlt+${badge}`;
        chip.innerHTML =
            `<span class="sg-cat-badge">${badge}</span>` +
            `<span class="sg-cat-label">${label}</span>` +
            (count != null ? `<span class="sg-cat-count">${count}</span>` : '');
        chip.onclick = () => { selectedScope = scopeOrNull; rerender(); };
        grid.appendChild(chip);
    };

    const totalAll = scopes.reduce((n, s) => n + _countFor(s.scope, filter), 0);
    mkChip('All', null, '0', totalAll, false, 'Every category');
    scopes.forEach((s, i) => {
        mkChip(s.label, s.scope, badgeFor(i + 1), _countFor(s.scope, filter), s.scope === current, s.hint);
    });

    const help = document.createElement('div');
    help.className = 'sg-cat-help';
    help.textContent = t('Alt + key to switch category · type to filter · • marks the current mode · Esc to close');
    bar.appendChild(help);

    renderShortcutList(list, filter, rerender);
}

function _entriesFor(scope, filter) {
    const items = SHORTCUTS[scope] || [];
    const grouped = new Map();
    items.forEach(item => {
        if (!item.description) return;
        if (!grouped.has(item.description)) grouped.set(item.description, []);
        grouped.get(item.description).push(formatKey(item));
    });
    const out = [];
    grouped.forEach((keys, desc) => {
        if (filter) {
            const keysStr = keys.join(' ').toLowerCase();
            if (!desc.toLowerCase().includes(filter) && !keysStr.includes(filter)) return;
        }
        out.push({ desc, keys });
    });
    return out;
}

function _countFor(scope, filter) {
    return _entriesFor(scope, filter).length;
}

function renderShortcutList(list, filter, rerender) {
    list.innerHTML = '';

    const scopes = _scopeList().filter(s => selectedScope === null || s.scope === selectedScope);

    for (const meta of scopes) {
        const filteredEntries = _entriesFor(meta.scope, filter);
        if (filteredEntries.length === 0) continue;

        const isCollapsed = collapsedState[meta.scope] === true;

        const header = document.createElement('li');
        header.className = 'shortcut-group-header';
        header.innerHTML = `
            <span class="group-toggle-icon jh-icon-rotate${isCollapsed ? '' : ' is-open'}">${svgIcon('chevron-right', { size: 11 })}</span>
            <span class="group-title">${meta.label}</span>
            ${meta.hint ? `<span class="sg-group-hint">${meta.hint}</span>` : ''}
            <span class="group-count">${filteredEntries.length}</span>
        `;
        header.onclick = () => {
            collapsedState[meta.scope] = !collapsedState[meta.scope];
            rerender();
        };
        list.appendChild(header);

        if (!isCollapsed) {
            const gridContainer = document.createElement('div');
            gridContainer.className = 'shortcut-items-grid';
            filteredEntries.forEach(({ desc, keys }) => {
                const li = document.createElement('div');
                li.className = 'shortcut-item';
                li.innerHTML = `
                    <span class="shortcut-desc">${highlightMatch(desc, filter)}</span>
                    <div class="shortcut-key-wrapper">
                        ${keys.map(k => `<span class="shortcut-key">${highlightMatch(k, filter)}</span>`).join('')}
                    </div>
                `;
                gridContainer.appendChild(li);
            });
            list.appendChild(gridContainer);
        }
    }

    if (list.children.length === 0) {
        const noResult = document.createElement('li');
        noResult.className = 'shortcut-no-results';
        noResult.textContent = filter
            ? `No shortcuts match "${filter}"`
            : 'No shortcuts in this category';
        list.appendChild(noResult);
    }
}

function highlightMatch(text, filter) {
    if (!filter) return text;
    const idx = text.toLowerCase().indexOf(filter);
    if (idx === -1) return text;
    const before = text.slice(0, idx);
    const match = text.slice(idx, idx + filter.length);
    const after = text.slice(idx + filter.length);
    return `${before}<mark>${match}</mark>${after}`;
}

export function hideShortcutGuide() {
    const overlay = document.getElementById('shortcut-guide-overlay');
    if (overlay) overlay.style.display = 'none';
    if (_guideKeyHandler) {
        document.removeEventListener('keydown', _guideKeyHandler, true);
        _guideKeyHandler = null;
    }
}

export function toggleShortcutGuide(mode) {
    const overlay = document.getElementById('shortcut-guide-overlay');
    if (!overlay) return;

    if (overlay.style.display === 'none' || !overlay.style.display) {
        showShortcutGuide(mode);
    } else {
        hideShortcutGuide();
    }
}
