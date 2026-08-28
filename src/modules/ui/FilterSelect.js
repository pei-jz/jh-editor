import { t } from '../utils/I18n.js';
/**
 * FilterSelect.js — a <select> you can type into.
 *
 * A repository with dozens of branches turns a native dropdown into a scroll
 * hunt, and `<select>` cannot be filtered. This is an input plus a filtered
 * list: typing narrows the options, ↑/↓ walks them, Enter picks. The value is
 * always one of the supplied options — free text reverts on blur — so callers
 * can treat it like the select it replaces.
 *
 *     const picker = createFilterSelect({
 *         groups: [{ label: 'Local', items: ['main', 'dev'] }],
 *         value: 'main',
 *         onChange: (v) => checkout(v),
 *     });
 *     row.appendChild(picker.element);
 *     picker.getValue();
 */

let _styleInjected = false;

function _injectStyles() {
    if (_styleInjected) return;
    _styleInjected = true;
    const style = document.createElement('style');
    style.id = 'filter-select-styles';
    style.textContent = `
    .filter-select { position: relative; display: inline-block; min-width: 0; }
    .filter-select-input {
        width: 100%; box-sizing: border-box;
        padding: 4px 20px 4px 7px;
        font-family: inherit; font-size: 12px;
        background: var(--bg-color-secondary);
        color: var(--text-color);
        border: 1px solid var(--border-color);
        border-radius: 4px; outline: none;
        text-overflow: ellipsis;
    }
    .filter-select-input:focus { border-color: var(--primary-color); }
    /* A caret so the control still reads as a dropdown, not a text field. */
    .filter-select::after {
        content: '';
        position: absolute; right: 7px; top: 50%;
        transform: translateY(-50%);
        width: 0; height: 0;
        border-left: 4px solid transparent;
        border-right: 4px solid transparent;
        border-top: 5px solid currentColor;
        font-size: 9px; opacity: 0.6; pointer-events: none;
        color: var(--text-color);
    }
    .filter-select-list {
        position: absolute; left: 0; right: 0; top: calc(100% + 2px);
        z-index: 1000;
        max-height: 260px; overflow-y: auto;
        background: var(--bg-color);
        border: 1px solid var(--border-color);
        border-radius: 4px;
        box-shadow: var(--shadow-md, 0 4px 12px rgba(0,0,0,0.3));
        display: none;
    }
    .filter-select-list.open { display: block; }
    .filter-select-group {
        padding: 4px 8px 2px;
        font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em;
        color: var(--text-secondary); opacity: 0.85;
    }
    .filter-select-option {
        padding: 4px 9px;
        font-size: 12px; cursor: pointer;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .filter-select-option:hover,
    .filter-select-option.active { background: var(--hover-color); }
    .filter-select-option.selected { color: var(--primary-color); font-weight: 600; }
    .filter-select-empty {
        padding: 7px 9px; font-size: 11px; color: var(--text-secondary);
    }
    `;
    document.head.appendChild(style);
}

/**
 * @param {object} o
 * @param {Array<{label: string, items: string[]}>} [o.groups]  grouped options
 * @param {string[]} [o.items]        flat options (shorthand for one unnamed group)
 * @param {string} [o.value]          initially selected option
 * @param {string} [o.placeholder]
 * @param {string} [o.title]          tooltip / aria label
 * @param {(value: string) => void} [o.onChange]  fired only on a real change
 * @returns {{element: HTMLElement, getValue: () => string, setValue: (v: string) => void,
 *            setOptions: (groups: Array<{label: string, items: string[]}>) => void}}
 */
export function createFilterSelect({
    groups = null, items = null, value = '', placeholder = '', title = '', onChange = null,
} = {}) {
    _injectStyles();

    let optionGroups = groups || [{ label: '', items: items || [] }];
    let current = value;
    let activeIndex = -1;
    let visible = [];   // flat list of the option values currently rendered

    const element = document.createElement('div');
    element.className = 'filter-select';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'filter-select-input';
    input.spellcheck = false;
    input.autocomplete = 'off';
    if (placeholder) input.placeholder = placeholder;
    if (title) input.title = title;
    input.value = current;

    const list = document.createElement('div');
    list.className = 'filter-select-list';

    element.append(input, list);

    const allValues = () => optionGroups.flatMap((g) => g.items);

    const render = (filter) => {
        const needle = String(filter || '').trim().toLowerCase();
        list.innerHTML = '';
        visible = [];

        for (const group of optionGroups) {
            const matches = group.items.filter(
                (it) => !needle || it.toLowerCase().includes(needle)
            );
            if (!matches.length) continue;
            if (group.label) {
                const head = document.createElement('div');
                head.className = 'filter-select-group';
                head.textContent = group.label;
                list.appendChild(head);
            }
            for (const it of matches) {
                const row = document.createElement('div');
                row.className = 'filter-select-option' + (it === current ? ' selected' : '');
                row.textContent = it;
                row.dataset.index = String(visible.length);
                // mousedown, not click: blur would close the list first.
                row.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    commit(it);
                });
                list.appendChild(row);
                visible.push(it);
            }
        }

        if (!visible.length) {
            const empty = document.createElement('div');
            empty.className = 'filter-select-empty';
            empty.textContent = t('No match');
            list.appendChild(empty);
        }
        setActive(visible.indexOf(current) >= 0 ? visible.indexOf(current) : (visible.length ? 0 : -1));
    };

    const setActive = (i) => {
        activeIndex = i;
        list.querySelectorAll('.filter-select-option').forEach((el) => {
            const on = Number(el.dataset.index) === i;
            el.classList.toggle('active', on);
            // Guarded: jsdom (and any non-layout host) has no scrollIntoView.
            if (on && typeof el.scrollIntoView === 'function') {
                el.scrollIntoView({ block: 'nearest' });
            }
        });
    };

    const open = () => {
        render(''); // always start from the full list, like a dropdown
        list.classList.add('open');
        // While the list is open Enter picks an option and Escape closes the
        // list — neither belongs to a surrounding dialog. See Dialog.js.
        element.dataset.dialogKeys = 'own';
    };

    const close = () => {
        list.classList.remove('open');
        delete element.dataset.dialogKeys;
        // Free text is not a value: snap back to whatever is actually selected.
        input.value = current;
    };

    const commit = (val) => {
        const changed = val !== current;
        current = val;
        input.value = val;
        close();
        if (changed && onChange) onChange(val);
    };

    input.addEventListener('focus', () => { open(); input.select(); });
    input.addEventListener('mousedown', () => { if (!list.classList.contains('open')) open(); });
    input.addEventListener('input', () => {
        list.classList.add('open');
        element.dataset.dialogKeys = 'own';
        render(input.value);
    });

    input.addEventListener('keydown', (e) => {
        const isOpen = list.classList.contains('open');
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            e.stopPropagation();
            if (!isOpen) { open(); return; }
            if (!visible.length) return;
            const step = e.key === 'ArrowDown' ? 1 : -1;
            setActive((activeIndex + step + visible.length) % visible.length);
            return;
        }
        if (e.key === 'Enter') {
            if (!isOpen) return;
            e.preventDefault();
            e.stopPropagation();
            if (activeIndex >= 0 && visible[activeIndex]) commit(visible[activeIndex]);
            return;
        }
        if (e.key === 'Escape' && isOpen) {
            // Only the list closes — the dialog around it stays put.
            e.preventDefault();
            e.stopPropagation();
            close();
        }
    });

    input.addEventListener('blur', () => setTimeout(close, 0));

    return {
        element,
        getValue: () => current,
        setValue: (v) => { current = v; input.value = v; },
        setOptions: (nextGroups) => {
            optionGroups = nextGroups;
            if (!allValues().includes(current)) current = allValues()[0] || '';
            input.value = current;
        },
    };
}
