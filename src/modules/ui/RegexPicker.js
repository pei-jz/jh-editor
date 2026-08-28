/**
 * RegexPicker.js — the popup behind the search box's regex button.
 *
 * This was a ContextMenu holding every sample in one column: thirty-eight rows,
 * taller than the window, with the category headings scrolled off the top by the
 * time you reached the entries under them. A menu is the wrong shape for a
 * library. This is a small panel instead — a filter box, one foldable section
 * per category, and arrow keys that walk the whole thing.
 */

import { RegexPresets } from './RegexPresets.js';
import { t } from '../utils/I18n.js';

const COLLAPSE_KEY = 'settings_regexPickerCollapsed';

/**
 * Which categories start folded.
 *
 * Everything open is thirty-eight rows — a panel the height of the screen that
 * you have to scroll before you can see what the categories even are. The first
 * one is open and the rest are folded, so the panel opens at a size you can
 * read, and the filter box reaches anything that is not on show.
 *
 * Stored explicitly on first use, so a later change of default cannot silently
 * re-fold sections someone has opened.
 */
function readCollapsed() {
    try {
        const raw = localStorage.getItem(COLLAPSE_KEY);
        if (raw) return new Set(JSON.parse(raw));
    } catch (_) { /* fall through to the default */ }
    const initial = RegexPresets.categories().slice(1);
    writeCollapsed(new Set(initial));
    return new Set(initial);
}

function writeCollapsed(set) {
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set])); }
    catch (_) { /* ignore */ }
}

/** Case-insensitive match against the name and the pattern alike. */
export function matches(preset, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return true;
    // Filtering matches the TRANSLATED label as well as the English source,
    // so typing what you can see finds it in any language.
    return preset.label.toLowerCase().includes(q)
        || t(preset.label).toLowerCase().includes(q)
        || preset.pattern.toLowerCase().includes(q)
        || preset.category.toLowerCase().includes(q);
}

/**
 * What the panel shows for a query.
 *
 * While filtering, categories are FORCED open: a hit hidden inside a folded
 * section reads as no hit at all. Pure, so the behaviour is testable without a
 * DOM.
 *
 * @returns {{groups: Array<{category, items, open}>, total: number}}
 */
export function visibleGroups(grouped, query, collapsed) {
    const filtering = !!String(query || '').trim();
    const groups = grouped
        .map(({ category, items }) => ({
            category,
            items: items.filter((p) => matches(p, query)),
            open: filtering || !collapsed.has(category),
        }))
        .filter((g) => g.items.length > 0);
    return { groups, total: groups.reduce((n, g) => n + g.items.length, 0) };
}

let openPanel = null;

/** Close whatever is open. Safe to call when nothing is. */
export function closeRegexPicker() {
    if (!openPanel) return;
    const returnFocusTo = openPanel._returnFocusTo;
    openPanel.remove();
    document.removeEventListener('mousedown', onDocDown, true);
    openPanel = null;
    if (returnFocusTo && returnFocusTo.isConnected && returnFocusTo.focus) {
        returnFocusTo.focus({ preventScroll: true });
    }
}

function onDocDown(e) {
    if (openPanel && !openPanel.contains(e.target)) closeRegexPicker();
}

/**
 * Show the picker anchored to the element that triggered it.
 *
 * @param {MouseEvent|HTMLElement} anchor
 * @param {(pattern: string) => void} onPick
 */
export function showRegexPicker(anchor, onPick) {
    closeRegexPicker();

    const el = anchor instanceof Event ? anchor.currentTarget || anchor.target : anchor;
    const rect = el && el.getBoundingClientRect
        ? el.getBoundingClientRect()
        : { left: 40, bottom: 60, top: 60 };

    const panel = document.createElement('div');
    panel.className = 'regex-picker';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Regex samples');
    panel._returnFocusTo = document.activeElement;

    const head = document.createElement('div');
    head.className = 'regex-picker-head';
    const filter = document.createElement('input');
    filter.type = 'text';
    filter.className = 'regex-picker-filter';
    filter.placeholder = t('Filter samples…');
    // The search modal listens for keys on the document; this input owns its own.
    filter.dataset.dialogKeys = 'own';
    const count = document.createElement('span');
    count.className = 'regex-picker-count';
    head.append(filter, count);

    const list = document.createElement('div');
    list.className = 'regex-picker-list';

    /** Everything the arrow keys can land on, in the order it is drawn. */
    const rows = () => [...list.querySelectorAll('.regex-group-head, .regex-item')];

    /**
     * The heading for a category.
     *
     * A scan, not a selector: category names are typed by the user and can hold
     * quotes or brackets that no attribute selector survives. `CSS.escape`
     * would cover that where it exists — and it does not exist everywhere,
     * which is how this threw and left the arrow keys looking dead.
     */
    const headFor = (category) => [...list.querySelectorAll('.regex-group-head')]
        .find((h) => h.dataset.category === category) || null;

    /** Focus stops that Tab may reach: the filter box, then the rows. */
    const focusables = () => [filter, ...rows()];

    const focusRow = (row) => {
        if (!row) return;
        row.focus({ preventScroll: true });
        // Guarded: not every environment the tests run in implements it, and a
        // missing scroll is not a reason for the keyboard to stop working.
        if (typeof row.scrollIntoView === 'function') {
            row.scrollIntoView({ block: 'nearest' });
        }
    };

    const step = (delta) => {
        const all = rows();
        if (!all.length) return;
        const i = all.indexOf(document.activeElement);
        // From the filter box, Down enters at the top and Up at the bottom.
        const next = i === -1
            ? (delta > 0 ? 0 : all.length - 1)
            : Math.min(all.length - 1, Math.max(0, i + delta));
        focusRow(all[next]);
    };

    const setOpen = (category, open) => {
        const now = readCollapsed();
        if (open) now.delete(category);
        else now.add(category);
        writeCollapsed(now);
    };

    const render = (focusCategory = null) => {
        const collapsed = readCollapsed();
        const { groups, total } = visibleGroups(RegexPresets.grouped(), filter.value, collapsed);
        list.innerHTML = '';
        count.textContent = total ? `${total}` : '';

        if (!groups.length) {
            const empty = document.createElement('div');
            empty.className = 'regex-picker-empty';
            empty.textContent = t('No sample matches that.');
            list.appendChild(empty);
            return;
        }

        for (const { category, items, open } of groups) {
            const section = document.createElement('div');
            section.className = 'regex-group';

            const header = document.createElement('button');
            header.type = 'button';
            header.className = 'regex-group-head';
            header.tabIndex = -1;
            header.dataset.category = category;
            header.dataset.open = String(open);
            header.setAttribute('aria-expanded', String(open));

            const arrow = document.createElement('span');
            arrow.className = 'regex-group-arrow';
            arrow.textContent = open ? '▼' : '▶';
            const name = document.createElement('span');
            name.className = 'regex-group-name';
            name.textContent = category;
            const n = document.createElement('span');
            n.className = 'regex-group-count';
            n.textContent = items.length;
            header.append(arrow, name, n);

            header.onclick = () => {
                setOpen(category, !open);
                render(category);
            };

            const body = document.createElement('div');
            body.className = 'regex-group-body';

            // A folded group builds NO rows. Hiding them with display:none left
            // them in the document, and the arrow keys then stepped onto a
            // button that cannot take focus — so Down did nothing at all while
            // any section above the caret was folded.
            for (const preset of (open ? items : [])) {
                const row = document.createElement('button');
                row.type = 'button';
                row.className = 'regex-item';
                row.tabIndex = -1;
                row.dataset.category = category;
                row.title = preset.pattern;

                const label = document.createElement('span');
                label.className = 'regex-item-label';
                label.textContent = t(preset.label);
                const pat = document.createElement('code');
                pat.className = 'regex-item-pattern';
                pat.textContent = preset.pattern;
                row.append(label, pat);

                row.onclick = () => {
                    // Not through closeRegexPicker: focus belongs in the search
                    // box now, not back on the button that opened this.
                    panel._returnFocusTo = null;
                    closeRegexPicker();
                    onPick(preset.pattern);
                };
                body.appendChild(row);
            }

            section.append(header, body);
            list.appendChild(section);
        }

        // Toggling a section keeps the keyboard on its heading rather than
        // dumping focus back to the top of the panel.
        if (focusCategory) focusRow(headFor(focusCategory));
    };

    /**
     * Arrow keys walk the panel: Up/Down through headings and rows alike,
     * Right/Left to open and close a section, Enter to take one.
     */
    panel.addEventListener('keydown', (e) => {
        const active = document.activeElement;
        const isHeader = active && active.classList.contains('regex-group-head');
        const isItem = active && active.classList.contains('regex-item');

        // Tab used to leave the panel entirely and land in the window behind
        // it, toggling the explorer. A popup owns the keyboard while it is up.
        if (e.key === 'Tab') {
            e.preventDefault();
            const all = focusables();
            const i = all.indexOf(active);
            const next = (i === -1 ? 0 : i + (e.shiftKey ? -1 : 1) + all.length) % all.length;
            if (all[next] === filter) filter.focus();
            else focusRow(all[next]);
            return;
        }

        switch (e.key) {
        case 'Escape':
            e.preventDefault();
            e.stopPropagation();
            closeRegexPicker();
            return;
        case 'ArrowDown':
            e.preventDefault();
            step(1);
            return;
        case 'ArrowUp':
            e.preventDefault();
            step(-1);
            return;
        case 'Home':
            if (active === filter) return;   // let the caret move in the input
            e.preventDefault();
            focusRow(rows()[0]);
            return;
        case 'End':
            if (active === filter) return;
            e.preventDefault();
            focusRow(rows().pop());
            return;
        case 'ArrowRight':
            if (!isHeader) return;
            e.preventDefault();
            if (active.dataset.open === 'true') step(1);   // already open: go in
            else { setOpen(active.dataset.category, true); render(active.dataset.category); }
            return;
        case 'ArrowLeft':
            if (isItem) {
                e.preventDefault();
                focusRow(headFor(active.dataset.category));
                return;
            }
            if (!isHeader) return;
            e.preventDefault();
            setOpen(active.dataset.category, false);
            render(active.dataset.category);
            return;
        case 'Enter':
            if (active === filter) {
                e.preventDefault();
                const first = list.querySelector('.regex-item');
                if (first) first.click();
            }
            return;
        default:
            // Any other printable key belongs in the filter box, wherever the
            // focus happens to be.
            if (active !== filter && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                filter.focus();
            }
        }
    });

    filter.addEventListener('input', () => render());

    panel.append(head, list);
    document.body.appendChild(panel);
    render();

    // Position after measuring: below the button, flipped up when there is no
    // room, and pulled back inside the right edge.
    const pad = 8;
    const box = panel.getBoundingClientRect();
    const left = Math.max(pad, Math.min(rect.left, window.innerWidth - box.width - pad));
    const below = rect.bottom + 6;
    const top = below + box.height + pad <= window.innerHeight
        ? below
        : Math.max(pad, rect.top - box.height - 6);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;

    openPanel = panel;
    document.addEventListener('mousedown', onDocDown, true);
    filter.focus();
    return panel;
}
