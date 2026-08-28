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
                const input = cell.querySelector('input');
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

                const input = cell.querySelector('input');
                const textSpan = cell.querySelector('.cell-text');
                if (input && !edit) input.style.display = 'none';
                if (textSpan) textSpan.style.display = (edit && cell.classList.contains('active-cell')) ? 'none' : 'block';
            });

            const target = table.querySelector(`[data-row="${this._state.activeRow}"][data-col="${this._state.activeCol}"]`);
            if (target) {
                if (this._state.isEditing) {
                    const input = target.querySelector('input');
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
                updateSelection(r, c, false, e.shiftKey);
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

            let copyText = "";
            for (let r = r1; r <= r2; r++) {
                let rowText = [];
                for (let c = c1; c <= c2; c++) {
                    rowText.push(data[r][c] || "");
                }
                copyText += rowText.join("\t") + (r === r2 ? "" : "\n");
            }
            e.clipboardData.setData('text/plain', copyText);
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

        // Initial Selection or restore previous
        const startR = this._state ? this._state.activeRow : 0;
        const startC = this._state ? this._state.activeCol : 0;
        setTimeout(() => updateSelection(startR, startC, false, this._state && this._state.activeRow !== this._state.selectionEndRow), 0);

        const hints = document.createElement('div');
        hints.className = 'table-editor-hints';
        hints.innerHTML = `
            <span><strong>Type characters:</strong> Edit</span>
            <span><strong>Shift+Arrows:</strong> Select Range</span>
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
