import { listCommands, searchCommands, AI_COMMAND_IDS } from '../core/CommandRegistry.js';
import { aiEnabled } from '../utils/AiPrefs.js';
import { icon, iconForFile } from './Icons.js';
import { t } from '../utils/I18n.js';
import { MODES, parsePaletteInput, inputFor, parseLineQuery, filterByText } from '../utils/PaletteQuery.js';
import { buildPathTree, flattenTree } from '../utils/PathTree.js';
import { splitRelRanges } from '../utils/FileSearchRank.js';

/**
 * CommandPalette.js — one box to find anything: files, tabs, commands,
 * symbols, a line, or text across the workspace.
 *
 * The editor had five pickers, each behind its own key — Ctrl+Shift+R files,
 * Ctrl+T tabs, Ctrl+Shift+P commands, Ctrl+O symbols, Ctrl+L line — and each
 * looked and behaved a little differently. They are now modes of this one
 * palette, picked by the first character typed (see utils/PaletteQuery.js).
 * The old keys open it with their prefix already in place, and deleting the
 * prefix falls back to a file search, so nobody has to remember which picker
 * holds what.
 *
 * Commands are ranked by `CommandRegistry.searchCommands`; recently-run ones
 * float to the top of the empty query. Everything that needs the app (tabs,
 * the file index, the active view) comes in through `initCommandPalette`'s
 * `sources`, so this module never imports Editor.js and stays testable.
 */

const RECENT_KEY = 'jh_command_palette_recent_v1';
const MAX_RECENT = 8;
// The viewer's own layout: tree or list, and the size they dragged it to.
const VIEW_KEY = 'jh_command_palette_view_v1';
const MIN_W = 420;
const MIN_H = 220;
// Modes whose rows are files somewhere on disk, so a folder tree means something.
const TREE_MODES = new Set(['files', 'tabs']);

let overlay = null;
let input = null;
let listEl = null;
let chipsEl = null;
let hintEl = null;
let rows = [];           // what is currently rendered: { icon, label, detail, binding, dirty, group, run }
let activeIndex = 0;
let onRun = null;        // injected command dispatcher
let sources = {};        // injected app access, see initCommandPalette
let renderSeq = 0;       // drops the answer of a file search the user has typed past
let panelEl = null;
let treeBtn = null;
let lastResult = null;   // repainted as is when a folder is folded
let currentMode = null;
const collapsed = new Set();   // folder keys folded in the tree view, for this session
let view = loadView();

function loadView() {
    const fallback = { tree: false, w: 0, h: 0 };
    try {
        const v = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null');
        if (!v || typeof v !== 'object') return fallback;
        return { tree: !!v.tree, w: Number(v.w) || 0, h: Number(v.h) || 0 };
    } catch (_) {
        return fallback;
    }
}

function saveView() {
    try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch (_) { /* per session only */ }
}

function loadRecent() {
    try {
        const raw = localStorage.getItem(RECENT_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string') : [];
    } catch (_) {
        return [];
    }
}

function rememberRecent(id) {
    try {
        const next = [id, ...loadRecent().filter((x) => x !== id)].slice(0, MAX_RECENT);
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch (_) {
        /* a palette must still work with storage disabled */
    }
}

/**
 * Commands for an empty query: recents first (in recency order), then the
 * registry's own category grouping.
 */
function orderForEmptyQuery(commands) {
    const recent = loadRecent();
    if (!recent.length) return commands;
    const byId = new Map(commands.map((c) => [c.id, c]));
    const head = recent.map((id) => byId.get(id)).filter(Boolean).map((c) => ({ ...c, recent: true }));
    const headIds = new Set(head.map((c) => c.id));
    return [...head, ...commands.filter((c) => !headIds.has(c.id))];
}

function call(name, ...args) {
    const fn = sources[name];
    if (typeof fn !== 'function') return undefined;
    try { return fn(...args); } catch (e) { console.error(`Palette source ${name} failed`, e); return undefined; }
}

function splitPath(path) {
    const p = String(path || '').replace(/\\/g, '/');
    const at = p.lastIndexOf('/');
    return at >= 0 ? { dir: p.slice(0, at), name: p.slice(at + 1) } : { dir: '', name: p };
}

function tabName(file) {
    if (file.path && !String(file.path).includes('://')) return splitPath(file.path).name;
    return file.name || t('Untitled');
}

function tabDir(file) {
    return file.path && !String(file.path).includes('://') ? splitPath(file.path).dir : '';
}

// ── Mode providers ──────────────────────────────────────────────────────────
// Each returns { rows, start?, hint? } or a Promise of one. `start` is the row
// highlighted first.

function commandRows(query) {
    // The AI commands only once AI is turned on (Settings → Agent).
    const ai = aiEnabled();
    const all = listCommands(t).filter((c) => ai || !AI_COMMAND_IDS.has(c.id));
    const list = query ? searchCommands(all, query) : orderForEmptyQuery(all);
    return {
        rows: list.map((cmd) => ({
            icon: cmd.icon || 'dot',
            label: cmd.label,
            binding: cmd.binding,
            // Group headers only make sense while browsing; once a query ranks
            // rows by relevance a heading would imply a grouping the order no
            // longer has.
            group: query ? null : (cmd.recent ? t('Recent') : cmd.categoryLabel),
            run: () => {
                rememberRecent(cmd.id);
                if (typeof onRun === 'function') onRun(cmd.id);
            },
        })),
        empty: t('No matching command'),
    };
}

function tabRows(query) {
    const entries = call('tabs') || [];
    const current = call('activeFile');
    const list = filterByText(entries, query, (e) => tabName(e.file), (e) => tabDir(e.file));
    return {
        rows: list.map((e) => ({
            icon: e.file.path && !String(e.file.path).includes('://') ? iconForFile(tabName(e.file)) : 'file',
            label: tabName(e.file),
            detail: tabDir(e.file),
            dir: tabDir(e.file),
            name: tabName(e.file),
            dirty: !!e.file.isDirty,
            run: () => call('activateTab', e),
        })),
        // The tab on screen heads the list; starting on the one after it makes
        // "@, Enter" a jump back to the previous tab.
        start: !query && list.length > 1 && list[0].file === current ? 1 : 0,
        empty: t('No matching tab'),
    };
}

function fileRow(path, recent = false) {
    const { dir, name } = splitPath(path);
    return {
        icon: iconForFile(name),
        label: name,
        name,
        detail: dir,
        dir,
        group: recent ? t('Recently opened') : null,
        run: () => call('openPath', path),
    };
}

function fileRows(query) {
    if (!call('hasWorkspace')) {
        // Without a workspace there is no index, but recent files still are.
        const recent = (call('recentFiles') || []).slice(0, 20);
        const list = query ? filterByText(recent, query, (p) => splitPath(p).name, (p) => p) : recent;
        return {
            rows: list.map((p) => fileRow(p, !query)),
            hint: t('Open a folder to search every file in it'),
            empty: query ? t('No matching files found') : t('No recent files'),
        };
    }
    if (!query) {
        return {
            rows: (call('recentFiles') || []).slice(0, 20).map((p) => fileRow(p, true)),
            hint: t('Type a file name · @ tabs · > commands · # symbols · : line · ? text'),
            empty: t('No recent files'),
        };
    }
    const pending = call('searchFiles', query);
    if (!pending || typeof pending.then !== 'function') return { rows: [], empty: t('No matching files found') };
    return pending.then((res) => ({
        rows: (res?.hits || []).map((hit) => {
            const path = call('hitPath', hit) || hit.item?.path || '';
            const row = fileRow(path);
            // The ranked relative path reads better than the absolute one.
            if (hit.rel && hit.name && hit.rel.length > hit.name.length) row.detail = hit.rel.slice(0, hit.rel.length - hit.name.length - 1);
            else if (hit.rel) row.detail = '';
            // Show what matched, in the name, the folder, or both (a path or
            // fuzzy-path match can span the two).
            if (hit.rel && hit.name) {
                const split = splitRelRanges(hit.relRanges || [], hit.rel, hit.name);
                row.labelRanges = hit.nameRanges?.length ? hit.nameRanges : split.nameRanges;
                row.detailRanges = split.dirRanges;
            }
            return row;
        }),
        hint: res?.partial
            ? t('Only part of this workspace is indexed — open a subfolder to search all of it')
            : null,
        empty: t('No matching files found'),
    }), () => ({ rows: [], empty: t('Error loading files') }));
}

function symbolRows(query) {
    const { items = [], isMarkdown = false } = call('outline') || {};
    if (!items.length) return { rows: [], empty: t('No headings or functions in this file') };
    const list = filterByText(items, query, (it) => it.text);
    return {
        rows: list.map((it) => ({
            icon: isMarkdown ? 'list' : (it.level === 1 ? 'file-code' : 'dot'),
            label: (isMarkdown ? '#'.repeat(it.level) + ' ' : '') + it.text,
            detail: String(it.lineIndex + 1),
            indent: query ? 0 : Math.max(0, it.level - 1),
            run: () => call('jumpOutline', it),
        })),
        empty: t('No matching symbol'),
    };
}

function lineRows(query) {
    const total = Number(call('lineCount')) || 0;
    const parsed = parseLineQuery(query, total);
    if (!parsed.error) {
        return {
            rows: [{
                icon: 'chevron-right',
                label: total ? t('Go to line {n} of {total}', { n: parsed.line, total }) : t('Go to line {n}', { n: parsed.line }),
                run: () => call('goToLine', parsed.line),
            }],
        };
    }
    const message = parsed.error === 'range'
        ? t('Out of range (1–{total})', { total })
        : parsed.error === 'invalid' ? t('Enter a valid line number')
            : (total ? t('Type a line number (1–{total})', { total }) : t('Type a line number'));
    return { rows: [], empty: message };
}

function grepRows(query) {
    return {
        rows: [{
            icon: 'search',
            label: query ? t('Search the workspace for “{q}”', { q: query }) : t('Open workspace search'),
            run: () => call('grep', query),
        }],
        hint: t('Enter opens workspace search with its folder and match options'),
    };
}

const PROVIDERS = {
    files: fileRows, tabs: tabRows, commands: commandRows,
    symbols: symbolRows, line: lineRows, grep: grepRows,
};

// ── DOM ─────────────────────────────────────────────────────────────────────

function buildDom() {
    overlay = document.createElement('div');
    overlay.className = 'cmdp-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', t('Command Palette'));

    const panel = document.createElement('div');
    panel.className = 'cmdp-panel';
    panelEl = panel;

    const inputRow = document.createElement('div');
    inputRow.className = 'cmdp-input-row';
    inputRow.innerHTML = icon('search', { size: 15, cls: 'cmdp-input-icon' });

    input = document.createElement('input');
    input.type = 'text';
    input.className = 'cmdp-input';
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', 'cmdp-list');
    input.setAttribute('aria-autocomplete', 'list');
    input.autocomplete = 'off';
    input.spellcheck = false;
    inputRow.appendChild(input);

    // One chip per mode: shows what the prefixes are without a manual, and a
    // click switches mode while keeping what was typed.
    chipsEl = document.createElement('div');
    chipsEl.className = 'cmdp-modes';
    MODES.forEach((m) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'cmdp-mode';
        chip.dataset.mode = m.id;
        chip.tabIndex = -1;
        chip.addEventListener('mousedown', (e) => e.preventDefault());   // keep focus in the input
        chip.addEventListener('click', () => {
            const { query } = parsePaletteInput(input.value);
            input.value = inputFor(m.id, query);
            render();
            input.focus();
        });
        chipsEl.appendChild(chip);
    });

    // List or folder tree, for the modes whose rows are files.
    treeBtn = document.createElement('button');
    treeBtn.type = 'button';
    treeBtn.className = 'cmdp-view-toggle';
    treeBtn.tabIndex = -1;
    treeBtn.addEventListener('mousedown', (e) => e.preventDefault());
    treeBtn.addEventListener('click', () => toggleTree());
    chipsEl.appendChild(treeBtn);

    listEl = document.createElement('div');
    listEl.className = 'cmdp-list';
    listEl.id = 'cmdp-list';
    listEl.setAttribute('role', 'listbox');

    hintEl = document.createElement('div');
    hintEl.className = 'cmdp-hint';

    panel.append(inputRow, chipsEl, listEl, hintEl);
    for (const edge of ['l', 'r', 'b', 'bl', 'br']) panel.appendChild(resizeHandle(edge));
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    applySize();

    overlay.addEventListener('mousedown', (e) => {
        if (e.target === overlay) hide();
    });
    input.addEventListener('input', () => render());
    // Capture phase: the app binds shortcuts on window with capture, so without
    // this the palette's own Enter and arrows would be eaten before arriving.
    overlay.addEventListener('keydown', onKeyDown, true);
}

// ── Size ────────────────────────────────────────────────────────────────────
// The panel is centred horizontally and hangs from a fixed top, so dragging a
// side edge grows it by twice the distance (both sides move) and the bottom
// edge grows it downwards. Double-clicking a handle goes back to the default.

function clampSize(w, h) {
    const maxW = Math.max(MIN_W, window.innerWidth * 0.96);
    const maxH = Math.max(MIN_H, window.innerHeight * 0.86);
    return {
        w: w ? Math.round(Math.min(maxW, Math.max(MIN_W, w))) : 0,
        h: h ? Math.round(Math.min(maxH, Math.max(MIN_H, h))) : 0,
    };
}

function applySize() {
    if (!panelEl) return;
    const { w, h } = clampSize(view.w, view.h);
    panelEl.style.width = w ? `${w}px` : '';
    panelEl.style.height = h ? `${h}px` : '';
    panelEl.style.maxHeight = h ? 'none' : '';
    panelEl.classList.toggle('is-sized', !!(w || h));
}

function resizeHandle(edge) {
    const handle = document.createElement('div');
    handle.className = `cmdp-resize cmdp-resize-${edge}`;
    handle.setAttribute('aria-hidden', 'true');
    handle.addEventListener('dblclick', () => {
        view.w = 0;
        view.h = 0;
        saveView();
        applySize();
        input.focus();
    });
    handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const rect = panelEl.getBoundingClientRect();
        const start = { x: e.clientX, y: e.clientY, w: rect.width, h: rect.height };
        const sideways = edge.includes('l') ? -2 : edge.includes('r') ? 2 : 0;
        const down = edge.includes('b') ? 1 : 0;
        overlay.classList.add('is-resizing');
        const onMove = (ev) => {
            const next = clampSize(
                sideways ? start.w + (ev.clientX - start.x) * sideways : (view.w || start.w),
                down ? start.h + (ev.clientY - start.y) : (view.h || 0),
            );
            if (sideways) view.w = next.w;
            if (down) view.h = next.h;
            applySize();
        };
        const onUp = () => {
            window.removeEventListener('pointermove', onMove, true);
            window.removeEventListener('pointerup', onUp, true);
            overlay.classList.remove('is-resizing');
            saveView();
            input.focus();
        };
        window.addEventListener('pointermove', onMove, true);
        window.addEventListener('pointerup', onUp, true);
    });
    return handle;
}

function toggleTree() {
    view.tree = !view.tree;
    saveView();
    if (currentMode) paintMode(currentMode);
    if (lastResult) paintRows(lastResult, rows[activeIndex]);
    input.focus();
}

function onKeyDown(e) {
    if (e.isComposing) { e.stopPropagation(); return; }
    switch (e.key) {
        case 'Escape':
            e.preventDefault();
            e.stopPropagation();
            hide();
            return;
        case 'ArrowDown':
            e.preventDefault();
            e.stopPropagation();
            move(1);
            return;
        case 'ArrowUp':
            e.preventDefault();
            e.stopPropagation();
            move(-1);
            return;
        case 'Home':
            if (!parsePaletteInput(input.value).query) { e.preventDefault(); setActive(0); }
            e.stopPropagation();
            return;
        case 'End':
            if (!parsePaletteInput(input.value).query) { e.preventDefault(); setActive(rows.length - 1); }
            e.stopPropagation();
            return;
        case 'Enter':
            e.preventDefault();
            e.stopPropagation();
            runActive();
            return;
        default:
            // Ctrl+Alt+T flips list / tree without leaving the keyboard.
            if ((e.key === 't' || e.key === 'T') && e.ctrlKey && e.altKey) {
                e.preventDefault();
                e.stopPropagation();
                if (currentMode && TREE_MODES.has(currentMode.id)) toggleTree();
                return;
            }
            // Every other key belongs to the text field. Stopping propagation
            // keeps the app's global shortcuts from firing while typing — "g"
            // in a query must not open workspace grep.
            e.stopPropagation();
    }
}

function move(delta) {
    if (!rows.length) return;
    // Wraps, because a list you can walk off the end of makes people
    // arrow back up through twenty rows to reach the first one.
    setActive((activeIndex + delta + rows.length) % rows.length);
}

function setActive(index) {
    activeIndex = Math.max(0, Math.min(index, rows.length - 1));
    listEl.querySelectorAll('.cmdp-item').forEach((row, i) => {
        const on = i === activeIndex;
        row.classList.toggle('is-active', on);
        row.setAttribute('aria-selected', on ? 'true' : 'false');
        if (on) {
            if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
            input.setAttribute('aria-activedescendant', row.id);
        }
    });
}

function paintMode(mode) {
    currentMode = mode;
    input.placeholder = t(mode.placeholder);
    chipsEl.querySelectorAll('.cmdp-mode').forEach((chip) => {
        const m = MODES.find((x) => x.id === chip.dataset.mode);
        chip.textContent = `${m.prefix || '·'} ${t(m.label)}`;
        chip.classList.toggle('is-active', m.id === mode.id);
    });
    treeBtn.hidden = !TREE_MODES.has(mode.id);
    treeBtn.replaceChildren();
    treeBtn.insertAdjacentHTML('afterbegin', icon(view.tree ? 'list' : 'folder', { size: 13 }));
    const label = document.createElement('span');
    label.textContent = view.tree ? t('List') : t('Tree');
    treeBtn.appendChild(label);
    treeBtn.title = `${view.tree ? t('Show as a list') : t('Show as a folder tree')} (Ctrl+Alt+T)`;
    treeBtn.setAttribute('aria-pressed', view.tree ? 'true' : 'false');
}

/**
 * Fill `parent` with `text`, the [start, end) `ranges` wrapped in a highlight
 * span. Text nodes only, so a file name is never parsed as markup.
 */
function appendMarked(parent, text, ranges) {
    let at = 0;
    for (const [start, end] of ranges || []) {
        if (start < at || end <= start || end > text.length) continue;
        if (start > at) parent.appendChild(document.createTextNode(text.slice(at, start)));
        const mark = document.createElement('span');
        mark.className = 'cmdp-hit';
        mark.textContent = text.slice(start, end);
        parent.appendChild(mark);
        at = end;
    }
    if (at < text.length) parent.appendChild(document.createTextNode(text.slice(at)));
}

function itemEl(r, i, depth = 0, inTree = false) {
    const row = document.createElement('div');
    row.className = 'cmdp-item';
    row.id = `cmdp-item-${i}`;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', 'false');
    const indent = inTree ? depth : (r.indent || 0);
    if (indent) row.style.paddingLeft = `${14 + indent * 16}px`;

    const ico = document.createElement('span');
    ico.className = 'cmdp-item-icon';
    ico.innerHTML = icon(r.icon || 'dot', { size: 15 });

    const label = document.createElement('span');
    label.className = 'cmdp-item-label';
    appendMarked(label, String(r.label ?? ''), r.labelRanges);
    row.append(ico, label);

    if (r.dirty) {
        const dot = document.createElement('span');
        dot.className = 'cmdp-item-dirty';
        dot.textContent = '●';
        dot.title = t('Unsaved changes');
        row.appendChild(dot);
    }
    // In the tree the folder is the row above; repeating it is noise.
    if (r.detail && !inTree) {
        const detail = document.createElement('span');
        detail.className = 'cmdp-item-detail';
        // <bdi>: the CSS shows a long path's END (rtl ellipsis) without
        // reordering the path itself.
        const bdi = document.createElement('bdi');
        bdi.dir = 'ltr';
        appendMarked(bdi, r.detail, r.detailRanges);
        detail.title = r.detail;
        detail.appendChild(bdi);
        row.appendChild(detail);
    }
    if (r.binding) {
        const kbd = document.createElement('kbd');
        kbd.className = 'cmdp-item-key';
        kbd.textContent = r.binding;
        row.appendChild(kbd);
    }

    row.addEventListener('mousemove', () => { if (activeIndex !== i) setActive(i); });
    row.addEventListener('click', () => { setActive(i); runActive(); });
    return row;
}

function folderEl(node) {
    const head = document.createElement('div');
    head.className = 'cmdp-folder';
    head.style.paddingLeft = `${14 + node.depth * 16}px`;
    head.setAttribute('aria-expanded', node.open ? 'true' : 'false');
    head.title = node.path || '';
    head.insertAdjacentHTML('beforeend', icon(node.open ? 'chevron-down' : 'chevron-right', { size: 11, cls: 'cmdp-folder-chevron' }));
    head.insertAdjacentHTML('beforeend', icon(node.other ? 'layout-columns' : (node.open ? 'folder-open' : 'folder'), { size: 14, cls: 'cmdp-folder-icon' }));
    const label = document.createElement('span');
    label.className = 'cmdp-folder-label';
    label.textContent = node.label;
    const count = document.createElement('span');
    count.className = 'cmdp-folder-count';
    count.textContent = String(node.count);
    head.append(label, count);
    head.addEventListener('mousedown', (e) => e.preventDefault());   // keep focus in the input
    head.addEventListener('click', () => {
        const keep = rows[activeIndex];
        if (collapsed.has(node.key)) collapsed.delete(node.key);
        else collapsed.add(node.key);
        paintRows(lastResult, keep);
    });
    return head;
}

/**
 * Draw `result`. `keepRow` (a row object) stays highlighted if it is still
 * visible — folding a folder must not throw the selection back to the top.
 */
function paintRows(result, keepRow = null) {
    lastResult = result;
    const all = result.rows || [];
    listEl.replaceChildren();
    hintEl.textContent = result.hint || t('↑↓ to move · Enter to open · Esc to close');

    if (!all.length) {
        rows = [];
        const empty = document.createElement('div');
        empty.className = 'cmdp-empty';
        empty.textContent = result.empty || '';
        listEl.appendChild(empty);
        input.removeAttribute('aria-activedescendant');
        return;
    }

    const startRow = keepRow || all[result.start || 0];
    const tree = view.tree && currentMode && TREE_MODES.has(currentMode.id) && all.every((r) => 'dir' in r);
    listEl.classList.toggle('is-tree', !!tree);

    if (tree) {
        const nodes = buildPathTree(all, (r) => r.dir, {
            workspace: call('workspace') || '',
            // Tabs read like an explorer; search hits keep their ranking, a
            // folder sitting where its best hit would.
            order: currentMode.id === 'tabs' ? 'name' : 'rank',
            otherLabel: t('Other Tabs'),
        });
        rows = [];
        for (const node of flattenTree(nodes, collapsed)) {
            if (node.type === 'dir') {
                listEl.appendChild(folderEl(node));
            } else {
                listEl.appendChild(itemEl(node.item, rows.length, node.depth, true));
                rows.push(node.item);
            }
        }
    } else {
        rows = all;
        let lastGroup = null;
        rows.forEach((r, i) => {
            if (r.group && r.group !== lastGroup) {
                const h = document.createElement('div');
                h.className = 'cmdp-group';
                h.textContent = r.group;
                listEl.appendChild(h);
            }
            lastGroup = r.group || null;
            listEl.appendChild(itemEl(r, i));
        });
    }

    const at = rows.indexOf(startRow);
    setActive(at >= 0 ? at : 0);
}

function render() {
    const { mode, query } = parsePaletteInput(input.value);
    paintMode(mode);
    const seq = ++renderSeq;
    const result = PROVIDERS[mode.id](query);
    if (result && typeof result.then === 'function') {
        // Keep the old rows up while the index answers, rather than flashing
        // an empty list on every keystroke; just say a search is running.
        hintEl.textContent = t('Searching…');
        result.then((r) => { if (seq === renderSeq && isOpen()) paintRows(r); });
        return;
    }
    paintRows(result);
}

function runActive() {
    const row = rows[activeIndex];
    if (!row || typeof row.run !== 'function') return;
    // Hidden BEFORE running: most targets open a modal or move focus, and a
    // palette still on screen would steal the focus they just took.
    hide();
    try {
        row.run();
    } catch (e) {
        console.error('Palette action failed', e);
    }
}

/**
 * Wire the palette to the app. Call once at startup.
 *
 * `dispatcher(cmdId)` runs a command. `appSources` gives the other modes what
 * they read and do: tabs() / activeFile() / activateTab(entry),
 * hasWorkspace() / searchFiles(q) / hitPath(hit) / recentFiles() /
 * openPath(path), outline() / jumpOutline(item), lineCount() / goToLine(n),
 * grep(q). A missing one only leaves its mode empty.
 */
export function initCommandPalette(dispatcher, appSources = {}) {
    onRun = dispatcher;
    sources = appSources || {};
}

export function isOpen() {
    return !!overlay && overlay.classList.contains('is-open');
}

/** Open on `prefix` (one of '', '@', '>', '#', ':', '?'); commands by default. */
export function show(prefix = '>') {
    if (!overlay) buildDom();
    // Built once, so a language change since then is picked up here.
    overlay.setAttribute('aria-label', t('Command Palette'));
    overlay.classList.add('is-open');
    applySize();   // the window may have shrunk since the size was dragged
    input.value = prefix;
    render();
    input.focus();
    call('preload');
}

export function hide() {
    if (!overlay) return;
    overlay.classList.remove('is-open');
}

/** Same key again closes it; a different mode's key switches to that mode. */
export function toggle(prefix = '>') {
    if (isOpen() && parsePaletteInput(input.value).mode.prefix === prefix) hide();
    else show(prefix);
}

export const CommandPalette = { show, hide, toggle, isOpen, initCommandPalette };
export default CommandPalette;
