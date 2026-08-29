import { listCommands, searchCommands } from '../core/CommandRegistry.js';
import { icon } from './Icons.js';
import { t } from '../utils/I18n.js';

/**
 * CommandPalette.js — type what you want to do, press Enter.
 *
 * The editor had four pickers for NOUNS — Ctrl+P files, Ctrl+T tabs, Ctrl+O
 * symbols, Ctrl+G workspace text — and none for verbs. F1 came closest, but it
 * is a reference table: it tells you that Ctrl+Alt+B is Book Mode and then
 * makes you close it and press the key. For anything without a key bound to it
 * there was no route at all.
 *
 * Ranked by `CommandRegistry.searchCommands`, which is a plain function over
 * plain data — the ordering rules are unit-tested there rather than being
 * observed through the DOM.
 *
 * Recently-run commands float to the top of the empty query. That is the whole
 * personalisation story: a palette people use twice a minute should put the two
 * things they actually run within one keystroke, and anything cleverer would be
 * guessing.
 */

const RECENT_KEY = 'jh_command_palette_recent_v1';
const MAX_RECENT = 8;

let overlay = null;
let input = null;
let listEl = null;
let items = [];          // the commands currently rendered
let activeIndex = 0;
let onRun = null;        // injected dispatcher

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

function buildDom() {
    overlay = document.createElement('div');
    overlay.className = 'cmdp-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', t('Command Palette'));

    const panel = document.createElement('div');
    panel.className = 'cmdp-panel';

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

    listEl = document.createElement('div');
    listEl.className = 'cmdp-list';
    listEl.id = 'cmdp-list';
    listEl.setAttribute('role', 'listbox');

    const hint = document.createElement('div');
    hint.className = 'cmdp-hint';
    hint.textContent = t('↑↓ to move · Enter to run · Esc to close');

    panel.append(inputRow, listEl, hint);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    overlay.addEventListener('mousedown', (e) => {
        if (e.target === overlay) hide();
    });
    input.addEventListener('input', () => render(input.value));
    // Capture phase: the app binds shortcuts on window with capture, so without
    // this the palette's own Enter and arrows would be eaten before arriving.
    overlay.addEventListener('keydown', onKeyDown, true);
}

function onKeyDown(e) {
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
            if (!input.value) { e.preventDefault(); setActive(0); }
            return;
        case 'End':
            if (!input.value) { e.preventDefault(); setActive(items.length - 1); }
            return;
        case 'Enter':
            e.preventDefault();
            e.stopPropagation();
            runActive();
            return;
        default:
            // Every other key belongs to the text field. Stopping propagation
            // keeps the app's global shortcuts from firing while typing — "g"
            // in a query must not open workspace grep.
            e.stopPropagation();
    }
}

function move(delta) {
    if (!items.length) return;
    // Wraps, because a list you can walk off the end of makes people
    // arrow back up through twenty rows to reach the first one.
    const next = (activeIndex + delta + items.length) % items.length;
    setActive(next);
}

function setActive(index) {
    activeIndex = Math.max(0, Math.min(index, items.length - 1));
    const rows = listEl.querySelectorAll('.cmdp-item');
    rows.forEach((row, i) => {
        const on = i === activeIndex;
        row.classList.toggle('is-active', on);
        row.setAttribute('aria-selected', on ? 'true' : 'false');
        if (on) {
            row.scrollIntoView({ block: 'nearest' });
            input.setAttribute('aria-activedescendant', row.id);
        }
    });
}

function render(query) {
    const all = listCommands(t);
    items = query.trim() ? searchCommands(all, query) : orderForEmptyQuery(all);

    listEl.replaceChildren();

    if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'cmdp-empty';
        empty.textContent = t('No matching command');
        listEl.appendChild(empty);
        input.removeAttribute('aria-activedescendant');
        return;
    }

    let lastGroup = null;
    items.forEach((cmd, i) => {
        // Group headers only make sense while browsing. Once a query is
        // ranking rows by relevance, a category heading would imply a grouping
        // the order no longer has.
        const group = query.trim() ? null : (cmd.recent ? t('Recent') : cmd.categoryLabel);
        if (group && group !== lastGroup) {
            const h = document.createElement('div');
            h.className = 'cmdp-group';
            h.textContent = group;
            listEl.appendChild(h);
            lastGroup = group;
        }

        const row = document.createElement('div');
        row.className = 'cmdp-item';
        row.id = `cmdp-item-${i}`;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', 'false');

        const ico = document.createElement('span');
        ico.className = 'cmdp-item-icon';
        ico.innerHTML = icon(cmd.icon || 'dot', { size: 15 });

        const label = document.createElement('span');
        label.className = 'cmdp-item-label';
        label.textContent = cmd.label;

        row.append(ico, label);

        if (cmd.binding) {
            const kbd = document.createElement('kbd');
            kbd.className = 'cmdp-item-key';
            kbd.textContent = cmd.binding;
            row.appendChild(kbd);
        }

        row.addEventListener('mousemove', () => setActive(i));
        row.addEventListener('click', () => { setActive(i); runActive(); });
        listEl.appendChild(row);
    });

    setActive(0);
}

function runActive() {
    const cmd = items[activeIndex];
    if (!cmd) return;
    rememberRecent(cmd.id);
    // Hidden BEFORE running: most commands open a modal or move focus, and a
    // palette still on screen would steal the focus they just took.
    hide();
    try {
        if (typeof onRun === 'function') onRun(cmd.id);
    } catch (e) {
        console.error(`Command failed: ${cmd.id}`, e);
    }
}

/** Wire the palette to the app's command dispatcher. Call once at startup. */
export function initCommandPalette(dispatcher) {
    onRun = dispatcher;
}

export function isOpen() {
    return !!overlay && overlay.classList.contains('is-open');
}

export function show() {
    if (!overlay) buildDom();
    // The label and the hint are built once, so a language change since then
    // has to be picked up here.
    overlay.setAttribute('aria-label', t('Command Palette'));
    input.placeholder = t('Type a command…');
    const hint = overlay.querySelector('.cmdp-hint');
    if (hint) hint.textContent = t('↑↓ to move · Enter to run · Esc to close');

    overlay.classList.add('is-open');
    input.value = '';
    render('');
    input.focus();
}

export function hide() {
    if (!overlay) return;
    overlay.classList.remove('is-open');
}

export function toggle() {
    if (isOpen()) hide();
    else show();
}

export const CommandPalette = { show, hide, toggle, isOpen, initCommandPalette };
export default CommandPalette;
