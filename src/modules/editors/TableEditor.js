import { icon as svgIcon } from '../ui/Icons.js';
import { t } from '../utils/I18n.js';

/**
 * The editing control inside a cell.
 *
 * It is a <textarea> (so a long cell wraps instead of scrolling sideways
 * through a letterbox). `querySelector('input')` does NOT match a textarea,
 * and when the tag changed, three call sites kept asking for 'input' and
 * silently got null: the box was never shown, never focused and never
 * hidden again — while the display span WAS hidden, so a double-clicked
 * cell just went blank and could not be typed into.
 *
 * Selecting both tags means the same mistake cannot happen twice.
 */
function cellEditor(cell) {
    return cell ? cell.querySelector('textarea, input') : null;
}

/** Escape a cell value for insertion into the generated HTML table. */
function esc(v) {
    return String(v == null ? '' : v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Resolve the current theme's table colours to literal values.
 *
 * The clipboard leaves the app, so `var(--border-color)` means nothing on the
 * other side — Excel needs the colour itself. Custom properties compute to
 * their declared value, which in every theme here is a literal, so reading
 * them off the body is enough.
 */
function themeTableColors() {
    const fallback = {
        headerBg: '#f2f2f2', bg: '#ffffff', text: '#111111', border: '#c9c9c9',
    };
    try {
        const cs = getComputedStyle(document.body);
        const v = (name, alt) => ((cs.getPropertyValue(name) || '').trim() || alt);
        return {
            headerBg: v('--table-header-bg', fallback.headerBg),
            bg: v('--bg-color', fallback.bg),
            text: v('--text-color', fallback.text),
            border: v('--border-color', fallback.border),
        };
    } catch (_) {
        return fallback;
    }
}

export const TableEditor = {
    /**
     * Undo history for the visual table editor.
     *
     * `data` is a 2D array the editor mutates IN PLACE (the caller keeps the
     * same reference and serialises it on every change), so the history stores
     * JSON snapshots and restores them into that same array rather than
     * swapping it out.
     *
     * Keyed on the array identity: internal re-renders pass the same `data`
     * and must not reset anything, while opening another table passes a fresh
     * array from parse() and should start over.
     */
    _history: null,

    /**
     * The table as tab-separated text — what a spreadsheet reads when it gets
     * plain text, and what the existing cell-range copy already produced.
     */
    toTsv(data, range = null) {
        if (!Array.isArray(data) || !data.length) return '';
        const r1 = range ? range.r1 : 0;
        const r2 = range ? range.r2 : data.length - 1;
        const c1 = range ? range.c1 : 0;
        const c2 = range ? range.c2 : (data[0] ? data[0].length - 1 : 0);

        const rows = [];
        for (let r = r1; r <= r2 && r < data.length; r++) {
            const cells = [];
            for (let c = c1; c <= c2; c++) cells.push((data[r] && data[r][c]) || '');
            rows.push(cells.join('\t'));
        }
        return rows.join('\n');
    },

    /**
     * The table as a styled HTML table.
     *
     * Excel, Word and Google Sheets all prefer `text/html` off the clipboard
     * when it is there, and they honour INLINE styles on the cells — so this
     * is how the paste arrives formatted rather than as bare text. The colours
     * are the current theme's, resolved to literals, because a paste that
     * looks like what was on screen is the point of the exercise.
     *
     * First row is treated as the header, matching Markdown's own table rule.
     */
    toHtml(data, opts = {}) {
        if (!Array.isArray(data) || !data.length) return '';
        const c = themeTableColors();
        // SINGLE quotes around the family names. The stack goes inside a
        // style="..." attribute, so a double quote here closes the attribute
        // early and the rest of the declaration becomes stray markup — the
        // table arrived in Excel unstyled and malformed.
        const font = opts.fontFamily
            || "Calibri, 'Segoe UI', 'Yu Gothic UI', Meiryo, sans-serif";

        const cellBase = `border:1px solid ${c.border};padding:4px 8px;`
            + `color:${c.text};font-family:${font};font-size:11pt;`
            // Long cells should wrap in the spreadsheet the way they wrap here,
            // rather than spilling across neighbouring columns.
            + 'vertical-align:top;white-space:normal;';

        const head = (data[0] || []).map((v) =>
            `<th style="${cellBase}background-color:${c.headerBg};font-weight:bold;text-align:center;">${esc(v)}</th>`
        ).join('');

        const body = data.slice(1).map((row) =>
            '<tr>' + (row || []).map((v) =>
                `<td style="${cellBase}background-color:${c.bg};">${esc(v)}</td>`
            ).join('') + '</tr>'
        ).join('');

        return `<table style="border-collapse:collapse;">`
            + `<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    },

    /**
     * Put the whole table on the clipboard as both HTML and text.
     *
     * Two routes, because neither is universally available: the async
     * Clipboard API needs a secure context and a permission the webview does
     * not always grant, and `execCommand` is deprecated but still the only
     * thing that reliably carries multiple flavours from a button click. The
     * fallback selects a detached node and lets a one-shot `copy` listener
     * fill in both types, so the user never sees the scratch markup.
     *
     * @returns {Promise<boolean>} whether anything reached the clipboard
     */
    async copyToClipboard(data, range = null) {
        const text = this.toTsv(data, range);
        const html = this.toHtml(
            range
                ? data.slice(range.r1, range.r2 + 1).map((row) => row.slice(range.c1, range.c2 + 1))
                : data,
        );
        if (!text) return false;

        try {
            if (navigator.clipboard && typeof navigator.clipboard.write === 'function'
                && typeof ClipboardItem !== 'undefined') {
                await navigator.clipboard.write([new ClipboardItem({
                    'text/html': new Blob([html], { type: 'text/html' }),
                    'text/plain': new Blob([text], { type: 'text/plain' }),
                })]);
                return true;
            }
        } catch (_) {
            /* fall through to the execCommand route */
        }

        try {
            const onCopy = (e) => {
                e.clipboardData.setData('text/html', html);
                e.clipboardData.setData('text/plain', text);
                e.preventDefault();
            };
            document.addEventListener('copy', onCopy, { once: true, capture: true });

            // Something has to be selected for execCommand('copy') to fire at
            // all; the listener above replaces whatever this node contains.
            const scratch = document.createElement('div');
            scratch.setAttribute('aria-hidden', 'true');
            scratch.style.cssText = 'position:fixed;left:-9999px;top:0;white-space:pre;';
            scratch.textContent = text;
            document.body.appendChild(scratch);

            const sel = window.getSelection();
            const saved = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
            const r = document.createRange();
            r.selectNodeContents(scratch);
            sel.removeAllRanges();
            sel.addRange(r);

            const ok = document.execCommand('copy');

            sel.removeAllRanges();
            if (saved) sel.addRange(saved);
            scratch.remove();
            document.removeEventListener('copy', onCopy, { capture: true });
            return ok;
        } catch (e) {
            console.error('Table copy failed', e);
            return false;
        }
    },

    _ensureHistory(data) {
        if (this._history && this._history.data === data) return this._history;
        this._history = { data, stack: [JSON.stringify(data)], index: 0 };
        return this._history;
    },

    /**
     * Record the state AFTER a mutation. No-op when nothing actually changed.
     *
     * `coalesceKey` collapses a run of related changes into ONE entry — typing
     * in a cell fires per keystroke, and an undo per character is not what
     * anybody means by undo. The first keystroke pushes a new entry (so undo
     * returns to the text as it was); the rest overwrite it.
     */
    _pushHistory(data, coalesceKey = null) {
        const h = this._ensureHistory(data);
        const snap = JSON.stringify(data);
        if (h.stack[h.index] === snap) return;
        // Editing after an undo discards the redo tail, as everywhere else.
        h.stack.length = h.index + 1;
        if (coalesceKey && h.coalesceKey === coalesceKey && h.index > 0) {
            h.stack[h.index] = snap;
        } else {
            h.stack.push(snap);
            h.index = h.stack.length - 1;
        }
        h.coalesceKey = coalesceKey;
        if (h.stack.length > 200) { h.stack.shift(); h.index--; }
    },

    /** Copy a snapshot back into `data` without replacing the array itself. */
    _restore(data, snapshot) {
        data.length = 0;
        for (const row of snapshot) data.push(row.slice());
    },

    _step(container, data, onChange, delta) {
        const h = this._ensureHistory(data);
        const next = h.index + delta;
        if (next < 0 || next >= h.stack.length) return false;
        h.index = next;
        this._restore(data, JSON.parse(h.stack[next]));
        this.render(container, data, onChange);
        if (onChange) onChange();
        return true;
    },

    undo(container, data, onChange) { return this._step(container, data, onChange, -1); },
    redo(container, data, onChange) { return this._step(container, data, onChange, 1); },

    // Helper to identify if a line is a markdown table separator
    isSeparatorLine(line) {
        if (!line) return false;
        const isValidChars = /^\s*\|?[\s\:\-\|]+\|?\s*$/.test(line);
        const hasHyphen = /-/.test(line);
        const hasPipe = /\|/.test(line);
        return isValidChars && hasHyphen && hasPipe;
    },

    // Check if the text is a markdown table
    isTable(text) {
        const lines = text.trim().split('\n');
        if (lines.length < 2) return false;
        
        // 1. Standard check: look for a valid separator row at line index 1
        if (this.isSeparatorLine(lines[1].trim())) {
            return true;
        }

        // 2. Fallback check: if there is no separator row, 
        // treat it as a table if every line contains at least one pipe '|'.
        let isAllTableRows = true;
        for (let i = 0; i < lines.length; i++) {
            const trimmedLine = lines[i].trim();
            if (!trimmedLine) continue; // ignore empty lines
            
            const pipeCount = (trimmedLine.match(/\|/g) || []).length;
            if (pipeCount < 1) {
                isAllTableRows = false;
                break;
            }
        }
        
        return isAllTableRows;
    },

    // Parse markdown string to 2D array
    parse(text) {
        const lines = text.trim().split('\n');
        const data = [];

        lines.forEach((line, i) => {
            const trimmed = line.trim();
            // Skip separator line
            if (i === 1 && this.isSeparatorLine(trimmed)) {
                return;
            }

            // Remove leading/trailing pipes and split
            let cleanLine = trimmed;
            if (cleanLine.startsWith('|')) {
                cleanLine = cleanLine.substring(1);
            }
            if (cleanLine.endsWith('|')) {
                cleanLine = cleanLine.substring(0, cleanLine.length - 1);
            }

            const row = cleanLine.split('|');
            data.push(row.map(cell => cell.trim()));
        });

        return data;
    },

    // Convert 2D array back to markdown string
    serialize(data) {
        if (data.length === 0) return '';

        // Helper to pad strings
        const widths = new Array(data[0].length).fill(3); // Min width

        // Calculate max width per column
        data.forEach(row => {
            row.forEach((cell, i) => {
                if (i < widths.length) {
                    widths[i] = Math.max(widths[i], (cell || '').length);
                }
            });
        });

        const formatRow = (row) => {
            return '| ' + row.map((cell, i) => {
                const w = widths[i] || 3;
                return (cell || '').padEnd(w);
            }).join(' | ') + ' |';
        };

        let md = formatRow(data[0]) + '\n';

        // Separator
        const separator = widths.map(w => '-'.repeat(w)).join(' | ');
        md += '| ' + separator + ' |\n';

        // Body
        for (let i = 1; i < data.length; i++) {
            md += formatRow(data[i]) + '\n';
        }

        return md.trim();
    },

    // Focus helper
    focusCell(container, row, col, editMode = false) {
        const table = container.querySelector('table');
        if (!table) return;
        
        const cell = table.querySelector(`[data-row="${row}"][data-col="${col}"]`);
        if (cell) {
            cell.focus();
            if (editMode) {
                const input = cellEditor(cell);
                if (input) {
                    input.style.display = 'block';
                    input.style.height = 'auto';
                    input.style.height = `${input.scrollHeight}px`;
                    input.focus();
                    input.select();
                }
            }
        }
    },

    // Render interactive UI
    render(container, data, onChange) {
        // Seeds on a fresh table; a no-op for the re-renders that follow every
        // mutation (same `data` reference).
        this._ensureHistory(data);

        // Every mutation path ends by telling the caller the table changed, so
        // the history records itself there — a push per handler would be one
        // more thing to forget when a handler is added.
        const notify = (coalesceKey = null) => {
            this._pushHistory(data, coalesceKey);
            if (onChange) onChange();
        };

        container.innerHTML = '';
        const table = document.createElement('table');
        table.className = 'visual-table-editor';
        table.tabIndex = -1; 

        // Dragging across cells extends the selection. Shift+Arrow already
        // did this from the keyboard; the mouse had no equivalent, so selecting
        // a block of cells meant clicking one corner and shift-clicking the
        // other — which is not what anyone tries first.
        //
        // Tracked on the instance rather than in a closure so a re-render
        // (insert row, sort) cannot leave a drag half-finished.
        this._drag = this._drag || { active: false };

        // Initialize state if not present
        if (!this._state) {
            this._state = {
                activeRow: 0,
                activeCol: 0,
                selectionEndRow: 0,
                selectionEndCol: 0,
                isEditing: false
            };
        }

        const updateSelection = (r, c, edit = false, extend = false) => {
            const rowCount = data.length;
            const colCount = data[0] ? data[0].length : 0;

            if (!extend) {
                this._state.activeRow = Math.max(0, Math.min(r, rowCount - 1));
                this._state.activeCol = Math.max(0, Math.min(c, colCount - 1));
                this._state.selectionEndRow = this._state.activeRow;
                this._state.selectionEndCol = this._state.activeCol;
            } else {
                this._state.selectionEndRow = Math.max(0, Math.min(r, rowCount - 1));
                this._state.selectionEndCol = Math.max(0, Math.min(c, colCount - 1));
            }
            
            this._state.isEditing = edit;

            const r1 = Math.min(this._state.activeRow, this._state.selectionEndRow);
            const r2 = Math.max(this._state.activeRow, this._state.selectionEndRow);
            const c1 = Math.min(this._state.activeCol, this._state.selectionEndCol);
            const c2 = Math.max(this._state.activeCol, this._state.selectionEndCol);

            table.querySelectorAll('td, th').forEach(cell => {
                cell.classList.remove('active-cell', 'editing-cell', 'range-selected');
                const row = parseInt(cell.dataset.row);
                const col = parseInt(cell.dataset.col);
                
                if (row >= r1 && row <= r2 && col >= c1 && col <= c2) {
                    cell.classList.add('range-selected');
                }

                if (row === this._state.activeRow && col === this._state.activeCol) {
                    cell.classList.add('active-cell');
                    if (this._state.isEditing) cell.classList.add('editing-cell');
                }

                const input = cellEditor(cell);
                const textSpan = cell.querySelector('.cell-text');
                if (input && !edit) input.style.display = 'none';
                if (textSpan) textSpan.style.display = (edit && cell.classList.contains('active-cell')) ? 'none' : 'block';
            });

            const target = table.querySelector(`[data-row="${this._state.activeRow}"][data-col="${this._state.activeCol}"]`);
            if (target) {
                if (this._state.isEditing) {
                        const input = cellEditor(target);
                    if (input) {
                        input.style.display = 'block';
                        input.style.height = 'auto';
                        input.style.height = `${input.scrollHeight}px`;
                        input.focus();
                        input.select(); 
                    }
                } else {
                    target.focus();
                }
            }
        };

        /** Match the box to its content, so nothing is hidden below the fold. */
        const autoGrow = (el) => {
            el.style.height = 'auto';
            el.style.height = `${el.scrollHeight}px`;
        };

        const createCellInstance = (r, c, value, isHeader = false) => {
            const cell = document.createElement(isHeader ? 'th' : 'td');
            cell.dataset.row = r;
            cell.dataset.col = c;
            cell.tabIndex = 0;
            
            const textSpan = document.createElement('span');
            textSpan.className = 'cell-text';
            textSpan.textContent = value || '';
            cell.appendChild(textSpan);

            // A TEXTAREA, not an input. An <input type="text"> is single-line
            // by definition, so a long cell scrolled sideways through a narrow
            // column and you edited it through a letterbox — while the display
            // span right beside it wrapped. This wraps the same way, and grows
            // to fit, so editing looks like what you were just reading.
            //
            // Enter still COMMITS (see handleTableKey): a Markdown table cell
            // cannot hold a real newline, so there is nothing for a newline to
            // mean here.
            const input = document.createElement('textarea');
            input.rows = 1;
            input.value = value || '';
            input.style.display = 'none';
            input.addEventListener('input', () => autoGrow(input));
            cell.appendChild(input);

            cell.onmousedown = (e) => {
                e.stopPropagation();
                if (e.button !== 0) return;          // right-click opens the menu
                if (this._state.isEditing && this._state.activeRow === r
                    && this._state.activeCol === c) {
                    return;                          // let the caret land in the editor
                }
                updateSelection(r, c, false, e.shiftKey);
                this._drag.active = true;
                // The browser would otherwise start a text selection across the
                // cells as the pointer moves, which fights the cell highlight.
                table.classList.add('is-dragging');
            };

            // `mouseenter` on each cell, not `mousemove` on the table: it fires
            // once per cell crossed rather than on every pixel, so a drag across
            // a wide table is a handful of updates instead of hundreds.
            cell.onmouseenter = () => {
                if (!this._drag.active) return;
                updateSelection(r, c, false, true);
            };
            cell.ondblclick = (e) => {
                e.stopPropagation();
                updateSelection(r, c, true);
            };
            cell.onkeydown = (e) => handleTableKey(e, r, c);
            
            cell.addEventListener('copy', (e) => handleTableCopy(e));
            cell.addEventListener('paste', (e) => handleTablePaste(e));

            input.oninput = (e) => {
                data[r][c] = e.target.value;
                textSpan.textContent = e.target.value;
                notify(`cell:${r}:${c}`);
            };

            input.onkeydown = (e) => {
                if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'Escape') {
                    e.preventDefault();
                    if (e.key === 'Enter') {
                         updateSelection(r, c, false);
                         updateSelection(r + 1, c);
                    } else if (e.key === 'Tab') {
                         updateSelection(r, c, false);
                         updateSelection(r, c + 1);
                    } else {
                         updateSelection(r, c, false);
                    }
                }
            };

            return cell;
        };

        const handleTableKey = (e, r, c) => {
            if (this._state.isEditing) return;

            const isAlt = e.altKey;
            const isShift = e.shiftKey;
            const isCtrl = e.ctrlKey || e.metaKey;

            if (isAlt) {
                if (e.key === ';' || e.code === 'Semicolon') {
                    e.preventDefault();
                    if (isShift) {
                        data.forEach(row => row.splice(this._state.activeCol + 1, 0, ''));
                        this.render(container, data, onChange);
                        setTimeout(() => updateSelection(this._state.activeRow, this._state.activeCol + 1), 0);
                    } else {
                        const cols = data[0] ? data[0].length : 1;
                        data.splice(this._state.activeRow + 1, 0, new Array(cols).fill(''));
                        this.render(container, data, onChange);
                        setTimeout(() => updateSelection(this._state.activeRow + 1, this._state.activeCol), 0);
                    }
                    notify();
                    return;
                }
                if (e.key === '-' || e.code === 'Minus') {
                    e.preventDefault();
                    if (isShift) {
                        if (data[0].length > 1) {
                            data.forEach(row => row.splice(this._state.activeCol, 1));
                            this.render(container, data, onChange);
                            updateSelection(this._state.activeRow, Math.min(this._state.activeCol, data[0].length - 1));
                            notify();
                        }
                    } else {
                        if (data.length > 1) {
                            data.splice(this._state.activeRow, 1);
                            this.render(container, data, onChange);
                            updateSelection(Math.min(this._state.activeRow, data.length - 1), this._state.activeCol);
                            notify();
                        }
                    }
                    return;
                }
            }

            // Ctrl+Z / Ctrl+Y (and Ctrl+Shift+Z). ShortcutManager lets these
            // through in the MARKDOWN_TABLE scope precisely so the grid can
            // undo its own edits — app:undo would reach for the document
            // instead, which is why nothing happened here at all.
            if (isCtrl && e.key && e.key.toLowerCase() === 'z') {
                e.preventDefault();
                e.stopPropagation();
                if (isShift) this.redo(container, data, onChange);
                else this.undo(container, data, onChange);
                setTimeout(() => this.focusCell(container,
                    Math.min(this._state.activeRow, data.length - 1),
                    Math.min(this._state.activeCol, (data[0] || []).length - 1)), 0);
                return;
            }
            if (isCtrl && e.key && e.key.toLowerCase() === 'y') {
                e.preventDefault();
                e.stopPropagation();
                this.redo(container, data, onChange);
                setTimeout(() => this.focusCell(container,
                    Math.min(this._state.activeRow, data.length - 1),
                    Math.min(this._state.activeCol, (data[0] || []).length - 1)), 0);
                return;
            }

            if (isCtrl && e.code === 'Space') {
                e.preventDefault();
                this.selectRow(container, this._state.activeRow);
                return;
            }

            if (e.key.startsWith('Arrow')) {
                e.preventDefault();
                let nextR = isShift ? this._state.selectionEndRow : this._state.activeRow;
                let nextC = isShift ? this._state.selectionEndCol : this._state.activeCol;
                if (e.key === 'ArrowUp') nextR--;
                if (e.key === 'ArrowDown') nextR++;
                if (e.key === 'ArrowLeft') nextC--;
                if (e.key === 'ArrowRight') nextC++;
                updateSelection(nextR, nextC, false, isShift);
                return;
            }

            if (e.key === 'Tab') {
                e.preventDefault();
                if (isShift) updateSelection(this._state.activeRow, this._state.activeCol - 1);
                else {
                    if (this._state.activeCol === data[0].length - 1 && this._state.activeRow === data.length - 1) {
                        const cols = data[0].length;
                        data.push(new Array(cols).fill(''));
                        this.render(container, data, onChange);
                        setTimeout(() => updateSelection(this._state.activeRow + 1, 0), 0);
                        notify();
                    } else if (this._state.activeCol === data[0].length - 1) {
                        updateSelection(this._state.activeRow + 1, 0);
                    } else {
                        updateSelection(this._state.activeRow, this._state.activeCol + 1);
                    }
                }
                return;
            }

            if (e.key === 'Enter') {
                e.preventDefault();
                updateSelection(this._state.activeRow + 1, this._state.activeCol);
                return;
            }

            if (e.key === 'F2' || e.code === 'F2') {
                // e.code fallback: WebView2 sometimes reports Unidentified
                // for function keys, same as in ShortcutManager.
                e.preventDefault();
                updateSelection(this._state.activeRow, this._state.activeCol, true);
                return;
            }

            if (e.key.length === 1 && !isCtrl && !isAlt && e.key !== 'Escape') {
                e.preventDefault();
                data[this._state.activeRow][this._state.activeCol] = ""; 
                updateSelection(this._state.activeRow, this._state.activeCol, true);
                const target = table.querySelector(`[data-row="${this._state.activeRow}"][data-col="${this._state.activeCol}"] input`);
                if (target) {
                    target.value = e.key;
                    data[this._state.activeRow][this._state.activeCol] = e.key;
                    notify();
                }
                return;
            }

            e.stopPropagation();
        };

        const handleTableCopy = (e) => {
            const r1 = Math.min(this._state.activeRow, this._state.selectionEndRow);
            const r2 = Math.max(this._state.activeRow, this._state.selectionEndRow);
            const c1 = Math.min(this._state.activeCol, this._state.selectionEndCol);
            const c2 = Math.max(this._state.activeCol, this._state.selectionEndCol);

            const range = { r1, r2, c1, c2 };
            const copyText = this.toTsv(data, range);
            e.clipboardData.setData('text/plain', copyText);
            // The same selection as styled HTML, so pasting a range into Excel
            // arrives formatted instead of as bare tab-separated text. Plain
            // text is still there for editors that want it.
            try {
                const slice = data.slice(r1, r2 + 1).map((row) => row.slice(c1, c2 + 1));
                e.clipboardData.setData('text/html', this.toHtml(slice));
            } catch (_) { /* text/plain is enough on its own */ }
            e.preventDefault();
            e.stopPropagation();
        };

        const handleTablePaste = (e) => {
            if (this._state.isEditing) return;
            const pasteData = e.clipboardData.getData('text/plain');
            if (!pasteData) return;

            const rows = pasteData.split(/\r?\n/);
            let modified = false;
            rows.forEach((rowStr, i) => {
                const r = this._state.activeRow + i;
                if (r >= data.length) {
                    const cols = data[0] ? data[0].length : 1;
                    data.push(new Array(cols).fill(''));
                }
                const cells = rowStr.split('\t');
                cells.forEach((val, j) => {
                    const c = this._state.activeCol + j;
                    if (c >= data[r].length) {
                        data.forEach(row => row.push(''));
                    }
                    data[r][c] = val;
                    modified = true;
                });
            });

            if (modified) {
                this.render(container, data, onChange);
                notify();
            }
            e.preventDefault();
            e.stopPropagation();
        };

        const thead = document.createElement('thead');
        const headerTr = document.createElement('tr');
        const noHeader = document.createElement('th');
        noHeader.className = 'column-no-header';
        noHeader.textContent = '';
        headerTr.appendChild(noHeader);

        if (data.length > 0) {
            data[0].forEach((val, c) => {
                headerTr.appendChild(createCellInstance(0, c, val, true));
            });
        }
        thead.appendChild(headerTr);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        for (let r = 1; r < data.length; r++) {
            const tr = document.createElement('tr');
            const noCell = document.createElement('td');
            noCell.className = 'column-no';
            noCell.textContent = r;
            tr.appendChild(noCell);

            data[r].forEach((val, c) => {
                tr.appendChild(createCellInstance(r, c, val, false));
            });
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        container.appendChild(table);

        // The drag ends wherever the button comes up — including outside the
        // table, or outside the window. Bound on document for that reason, and
        // torn down on the next render so instances do not accumulate.
        if (this._endDrag) {
            document.removeEventListener('mouseup', this._endDrag, true);
        }
        this._endDrag = () => {
            if (!this._drag.active) return;
            this._drag.active = false;
            table.classList.remove('is-dragging');
        };
        document.addEventListener('mouseup', this._endDrag, true);

        // Initial Selection or restore previous
        const startR = this._state ? this._state.activeRow : 0;
        const startC = this._state ? this._state.activeCol : 0;
        setTimeout(() => updateSelection(startR, startC, false, this._state && this._state.activeRow !== this._state.selectionEndRow), 0);

        // One click copies the WHOLE table, formatted. Distinct from the cell
        // range copy (Ctrl+C), which copies what is selected: wanting the table
        // out of here — into a spreadsheet, usually — should not start with
        // selecting every cell.
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'table-copy-btn';
        copyBtn.title = t('Copy the whole table (paste into Excel with formatting)');
        copyBtn.setAttribute('aria-label', t('Copy the whole table'));
        copyBtn.innerHTML = svgIcon('copy-table', { size: 13 });
        copyBtn.onmousedown = (e) => e.preventDefault();   // keep the cell focus
        copyBtn.onclick = async () => {
            const ok = await this.copyToClipboard(data);
            // Feedback on the button itself: a toast for something this small
            // and this local reads as an interruption.
            copyBtn.classList.add(ok ? 'is-done' : 'is-failed');
            copyBtn.innerHTML = svgIcon(ok ? 'check' : 'x', { size: 13 });
            setTimeout(() => {
                copyBtn.classList.remove('is-done', 'is-failed');
                copyBtn.innerHTML = svgIcon('copy-table', { size: 13 });
            }, 1400);
        };
        // The host is the non-scrolling wrapper; falling back to the
        // container keeps this working for any caller that has no host.
        const copyHost = (container.closest && container.closest('.table-editor-host'))
            || container.parentElement || container;
        copyHost.appendChild(copyBtn);

        const hints = document.createElement('div');
        hints.className = 'table-editor-hints';
        hints.innerHTML = `
            <span><strong>Type characters:</strong> Edit</span>
            <span><strong>Shift+Arrows / Drag:</strong> Select Range</span>
            <span><strong>Alt+; / -</strong> Add/Del Line</span>
            <span><strong>Ctrl+C / V:</strong> Copy/Paste</span>
        `;
        container.appendChild(hints);
    },

    selectRow(container, rowIndex) {
        const table = container.querySelector('table');
        if (!table) return;
        const rows = table.querySelectorAll('tr');
        if (rowIndex >= 0 && rowIndex < rows.length) {
            rows[rowIndex].classList.toggle('selected-row');
        }
    }
};
