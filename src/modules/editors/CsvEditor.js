import { writeText, readText } from '@tauri-apps/plugin-clipboard-manager';
import { VirtualScroll } from '../utils/VirtualScroll.js';
import { shortcuts } from '../core/ShortcutManager.js';
import { SHORTCUTS } from '../core/ShortcutDefinitions.js';
import { ContextMenu } from '../ui/ContextMenu.js';
import { parseCsvAsync } from '../utils/AsyncCsvParser.js';

// --- Helpers ---
function getOsLineEnding() {
    const ua = navigator.userAgent || '';
    if (ua.indexOf('Windows') !== -1) return '\r\n';
    // Check specific Apple devices
    if (ua.indexOf('Mac') !== -1 || ua.indexOf('iPad') !== -1 || ua.indexOf('iPhone') !== -1) {
        if (ua.indexOf('iPhone') !== -1 || ua.indexOf('iPad') !== -1) return '\r';
        return '\n';
    }
    if (ua.indexOf('Linux') !== -1) return '\n';
    return '\n'; // Default fallback
}

// --- Model: Data Management ---
export class CsvModel {
    constructor(content, existingLineEnding = null) {
        this.lineEnding = existingLineEnding || getOsLineEnding();
        this.data = this.parse(content, !existingLineEnding);
        if (this.data.length === 0) this.data = [['']];
        this.history = [];
        this.future = [];
    }

    saveState() {
        this.history.push(JSON.parse(JSON.stringify(this.data)));
        if (this.history.length > 50) this.history.shift();
        this.future = [];
    }

    undo() {
        if (this.history.length > 0) {
            this.future.push(JSON.parse(JSON.stringify(this.data)));
            this.data = this.history.pop();
            return true;
        }
        return false;
    }

    redo() {
        if (this.future.length > 0) {
            this.history.push(JSON.parse(JSON.stringify(this.data)));
            this.data = this.future.pop();
            return true;
        }
        return false;
    }

    getData() { return this.data; }
    getRowCount() { return this.data.length; }
    getColCount() { return this.data[0] ? this.data[0].length : 0; }

    getValue(r, c) {
        if (r < 0 || r >= this.data.length) return '';
        return this.data[r][c] !== undefined ? this.data[r][c] : '';
    }

    setValue(r, c, val) {
        if (!this.data[r] || this.data[r][c] === val) return;
        this.saveState();
        this.data[r][c] = val;
    }

    insertRow(index) {
        this.saveState();
        const cols = this.getColCount() || 1;
        const newRow = new Array(cols).fill('');
        this.data.splice(index, 0, newRow);
    }

    insertCol(index) {
        this.saveState();
        if (this.data.length === 0) this.data.push(['']);
        this.data.forEach(row => row.splice(index, 0, ''));
    }

    // Insert multiple rows from a 2D matrix at `index`, shifting existing rows
    // down (Excel "Insert Copied Cells" for rows). Each row is padded/truncated
    // to the current column count. One undo step.
    insertRows(index, matrix) {
        if (!matrix || matrix.length === 0) return;
        this.saveState();
        const cols = this.getColCount() || 1;
        const rows = matrix.map(src => {
            const row = new Array(cols).fill('');
            for (let j = 0; j < Math.min(cols, src.length); j++) row[j] = src[j] != null ? src[j] : '';
            return row;
        });
        this.data.splice(index, 0, ...rows);
    }

    // Insert columns from a 2D matrix at `index`, shifting existing columns
    // right. The number of inserted columns is the matrix's max row width; cell
    // (i,j) of the matrix lands in data row i. One undo step.
    insertCols(index, matrix) {
        if (!matrix || matrix.length === 0) return;
        this.saveState();
        if (this.data.length === 0) this.data.push(['']);
        const width = matrix.reduce((m, r) => Math.max(m, r.length), 0) || 1;
        this.data.forEach((row, i) => {
            const ins = new Array(width).fill('');
            if (matrix[i]) {
                for (let j = 0; j < width; j++) ins[j] = matrix[i][j] != null ? matrix[i][j] : '';
            }
            row.splice(index, 0, ...ins);
        });
    }

    deleteRow(index) {
        if (this.data.length <= 1) return;
        this.saveState();
        this.data.splice(index, 1);
    }

    deleteCol(index) {
        if (this.getColCount() <= 1) return;
        this.saveState();
        this.data.forEach(row => row.splice(index, 1));
    }

    parse(text, enableDetection = true) {
        const rows = [];
        let row = [];
        let cursor = 0;
        const len = text.length;
        let detected = false;

        while (cursor < len) {
            let cell = '';
            if (text[cursor] === '"') {
                cursor++;
                while (cursor < len) {
                    if (text[cursor] === '"') {
                        if (cursor + 1 < len && text[cursor + 1] === '"') {
                            cell += '"';
                            cursor += 2;
                        } else {
                            cursor++;
                            break;
                        }
                    } else {
                        cell += text[cursor];
                        cursor++;
                    }
                }
                while (cursor < len && text[cursor] !== ',' && text[cursor] !== '\r' && text[cursor] !== '\n') cursor++;
            } else {
                let start = cursor;
                while (cursor < len && text[cursor] !== ',' && text[cursor] !== '\r' && text[cursor] !== '\n') {
                    cursor++;
                }
                cell = text.substring(start, cursor);
            }
            row.push(cell);
            if (cursor < len) {
                if (text[cursor] === ',') {
                    cursor++;
                    if (cursor === len) row.push('');
                } else if (text[cursor] === '\r' || text[cursor] === '\n') {
                    if (enableDetection && !detected) {
                        if (text[cursor] === '\r' && cursor + 1 < len && text[cursor + 1] === '\n') {
                            this.lineEnding = '\r\n';
                        } else if (text[cursor] === '\r') {
                            this.lineEnding = '\r';
                        } else {
                            this.lineEnding = '\n';
                        }
                        detected = true;
                    }

                    if (text[cursor] === '\r' && cursor + 1 < len && text[cursor + 1] === '\n') {
                        cursor += 2;
                    } else {
                        cursor++;
                    }
                    rows.push(row);
                    row = [];
                }
            }
        }
        if (row.length > 0) rows.push(row);
        if (rows.length === 0) return [['']];
        return rows;
    }

    serialize() {
        return this.data.map(row => row.map(cell => {
            if (cell.includes('"') || cell.includes(',') || cell.includes('\n') || cell.includes('\r')) {
                return `"${cell.replace(/"/g, '""')}"`;
            }
            return cell;
        }).join(',')).join(this.lineEnding);
    }

    transpose() {
        if (this.data.length === 0) return;
        this.saveState();
        const rowCount = this.data.length;
        const colCount = this.data[0].length;
        const newData = [];

        for (let c = 0; c < colCount; c++) {
            const newRow = [];
            for (let r = 0; r < rowCount; r++) {
                newRow.push(this.data[r][c] || '');
            }
            newData.push(newRow);
        }
        this.data = newData;
    }

    sort(colIndex, direction) {
        if (this.data.length <= 1) return;
        this.saveState();

        // Assume first row is header for typical CSV editing experience
        const header = this.data[0];
        const dataToSort = this.data.slice(1);
        
        dataToSort.sort((a, b) => {
            const valA = a[colIndex] || '';
            const valB = b[colIndex] || '';
            
            // Try numeric sort first
            const numA = parseFloat(valA);
            const numB = parseFloat(valB);
            
            if (!isNaN(numA) && !isNaN(numB) && valA.trim() !== '' && valB.trim() !== '') {
                return direction === 'asc' ? numA - numB : numB - numA;
            }
            
            // String sort
            return direction === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
        });
        
        this.data = [header, ...dataToSort];
    }
}

// --- View: Virtualized Renderer ---
class CsvView {
    constructor(container, model, inputs) {
        this.container = container;
        this.model = model;
        this.inputController = inputs; // Circular dep resolved by passing logic
        this.rowHeight = 28; // px (Reduced for 10pt font)

        // Master Wrapper
        this.masterWrapper = document.createElement('div');
        this.masterWrapper.className = 'csv-editor-wrapper';
        this.masterWrapper.style.display = 'flex';
        this.masterWrapper.style.height = '100%';
        this.masterWrapper.style.width = '100%';
        this.masterWrapper.style.overflow = 'hidden';

        // 1. Row Indices Strip (Fixed width)
        this.rowStrip = document.createElement('div');
        this.rowStrip.className = 'csv-row-strip';
        this.rowStrip.style.flex = '0 0 auto';
        this.rowStrip.style.display = 'flex';
        this.rowStrip.style.flexDirection = 'column';
        this.rowStrip.style.overflow = 'hidden'; // Y sync handled by JS

        this.corner = document.createElement('div');
        this.corner.className = 'csv-corner';
        this.corner.style.height = '28px'; // headerHeight
        this.corner.style.background = 'var(--bg-active)';
        this.corner.style.borderRight = '1px solid var(--border-color)';
        this.corner.style.borderBottom = '1px solid var(--border-color)';
        this.rowStrip.appendChild(this.corner);

        this.rowIndicesHost = document.createElement('div');
        this.rowIndicesHost.className = 'csv-row-indices-host';
        this.rowIndicesHost.style.flex = '1';
        this.rowIndicesHost.style.position = 'relative';
        this.rowIndicesHost.style.overflow = 'hidden';
        
        this.rowIndicesSpacer = document.createElement('div');
        this.rowIndicesSpacer.className = 'virtual-spacer';
        this.rowIndicesSpacer.style.position = 'absolute';
        this.rowIndicesSpacer.style.top = '0';
        this.rowIndicesSpacer.style.left = '0';
        this.rowIndicesSpacer.style.width = '1px';
        this.rowIndicesHost.appendChild(this.rowIndicesSpacer);
        
        this.rowIndicesTable = document.createElement('table');
        this.rowIndicesTable.className = 'csv-grid row-indices-table';
        this.rowIndicesTable.style.position = 'absolute';
        this.rowIndicesTable.style.left = '0';
        this.rowIndicesTable.style.tableLayout = 'fixed';
        this.rowIndicesHost.appendChild(this.rowIndicesTable);
        this.rowStrip.appendChild(this.rowIndicesHost);

        this.masterWrapper.appendChild(this.rowStrip);

        // 2. Data Container (Master Scroll Area)
        this.gridContainer = document.createElement('div');
        this.gridContainer.className = 'csv-grid-virtual-container';
        this.gridContainer.tabIndex = 0;
        this.gridContainer.style.outline = 'none';
        this.gridContainer.style.flex = '1';
        this.gridContainer.style.overflow = 'auto'; // Master scroll
        this.gridContainer.style.position = 'relative';

        this.spacer = document.createElement('div');
        this.spacer.className = 'virtual-spacer';
        this.spacer.style.position = 'absolute';
        this.spacer.style.top = '0';
        this.spacer.style.left = '0';
        this.spacer.style.width = '1px';
        this.gridContainer.appendChild(this.spacer);

        this.headerTable = document.createElement('table');
        this.headerTable.className = 'csv-grid csv-header-fixed';
        this.headerTable.style.position = 'sticky';
        this.headerTable.style.top = '0';
        this.headerTable.style.zIndex = '10';
        this.headerTable.style.tableLayout = 'fixed';
        this.headerTableTHead = document.createElement('thead');
        this.headerTable.appendChild(this.headerTableTHead);
        this.gridContainer.appendChild(this.headerTable);

        this.contentTable = document.createElement('table');
        this.contentTable.className = 'csv-grid';
        this.contentTable.style.position = 'absolute';
        this.contentTable.style.left = '0';
        this.contentTable.style.tableLayout = 'fixed';
        this.contentTableTBody = document.createElement('tbody');
        this.contentTable.appendChild(this.contentTableTBody);
        
        // Event delegation for table cells
        this.contentTableTBody.addEventListener('mousedown', (e) => {
            const td = e.target.closest('td');
            if (td && td.dataset.r !== undefined) {
                this.inputController.handleCellDown(parseInt(td.dataset.r, 10), parseInt(td.dataset.c, 10), e);
            }
        });
        this.contentTableTBody.addEventListener('mouseover', (e) => {
            const td = e.target.closest('td');
            if (td && td.dataset.r !== undefined) {
                this.inputController.handleCellOver(parseInt(td.dataset.r, 10), parseInt(td.dataset.c, 10), e);
            }
        });
        this.contentTableTBody.addEventListener('dblclick', (e) => {
            const td = e.target.closest('td');
            if (td && td.dataset.r !== undefined) {
                this.inputController.handleCellDblClick(parseInt(td.dataset.r, 10), parseInt(td.dataset.c, 10), td, e);
            }
        });
        this.contentTableTBody.addEventListener('contextmenu', (e) => {
            const td = e.target.closest('td');
            if (td && td.dataset.r !== undefined) {
                this.inputController.handleContextMenu(parseInt(td.dataset.r, 10), parseInt(td.dataset.c, 10), e);
            }
        });

        this.gridContainer.appendChild(this.contentTable);

        this.masterWrapper.appendChild(this.gridContainer);
        this.container.appendChild(this.masterWrapper);

        // Sync Scrolling
        this.lastScrollLeft = 0;
        this.gridContainer.addEventListener('scroll', () => {
            // Y Sync
            this.rowIndicesHost.scrollTop = this.gridContainer.scrollTop;
            
            // X Sync (Horizontal Virtualization Trigger)
            const sx = this.gridContainer.scrollLeft;
            if (Math.abs(sx - this.lastScrollLeft) > 100) {
                this.lastScrollLeft = sx;
                if (this.scroller) this.scroller.onScroll(); // Re-trigger Y-render which now handles X
                this.renderHeader(); // Re-trigger Header X-render
            }
        });

        // State
        // `selection` is the highlighted rectangle (anchor `start` → focus `end`).
        // `cursor` is the ACTIVE cell — where typing/F2/insert act, and where
        // unshifted arrow keys walk from. It is deliberately separate from
        // selection.end so that selecting a whole row/column (Shift+Space /
        // Ctrl+Space) doesn't drag the active cell to the row/column end.
        this.selection = { start: { r: 0, c: 0 }, end: { r: 0, c: 0 } };
        this.cursor = { r: 0, c: 0 };
        this.rowHeaderWidth = this.calcRowHeaderWidth();
        this.renderState = { startR: 0, endR: 0 };
        this.visibleCols = { start: 0, end: 50 }; // Added for X Virtualization
        this.rowHeights = {}; // Index -> px

        // Initial Widths (Calculated ONCE)
        this.colWidths = this.calculateColumnWidths();

        // Init Virtual Scroll
        this.scroller = new VirtualScroll(
            this.gridContainer,
            this.model.getRowCount(),
            (index) => this.getRowHeight(index),
            this.renderRows.bind(this)
        );

        // Initial Header Render
        this.renderHeader();
        
        // Final structural binding
        this.renderColGroup(this.rowIndicesTable);
        this.renderColGroup(this.headerTable);
        this.renderColGroup(this.contentTable);
    }

    showLoading(message = 'Loading...') {
        this.loadingOverlay = document.createElement('div');
        this.loadingOverlay.className = 'loading-overlay';
        this.loadingOverlay.style.cssText = 'position:absolute; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); color:white; display:flex; align-items:center; justify-content:center; z-index:100;';
        this.loadingOverlay.textContent = message;
        this.gridContainer.appendChild(this.loadingOverlay);
    }

    hideLoading() {
        if (this.loadingOverlay) {
            this.loadingOverlay.remove();
            this.loadingOverlay = null;
        }
    }

    getRowHeight(index) {
        return this.rowHeights[index] !== undefined ? this.rowHeights[index] : this.rowHeight; // Fallback to default
    }

    updateData() {
        // Recalculate widths/structural info
        this.colWidths = this.calculateColumnWidths();
        this.rowHeaderWidth = this.calcRowHeaderWidth();
        
        this.renderColGroup(this.rowIndicesTable);
        this.renderColGroup(this.headerTable);
        this.renderColGroup(this.contentTable);
        this.renderHeader();

        if (this.scroller) {
            this.scroller.update(this.model.getRowCount()); 
        } else {
            // Initial render before scroller is set up
            this.renderRows({ startIndex: 0, endIndex: 50, offsetY: 0, totalHeight: this.model.getRowCount() * 28 });
        }
    }

    calculateColumnWidths() {
        // Sample first 50 rows + Header
        const limit = 50;
        const counts = this.model.getColCount();
        const widths = new Array(counts).fill(100); // Min 100

        // Measure Canvas
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        context.font = "12px 'HackGen Console', 'HackGen', 'JetBrains Mono', 'Consolas', monospace";

        // Headers
        for (let c = 0; c < counts; c++) {
            const label = this.getColumnLabel(c);
            const w = Math.ceil(context.measureText(label).width + 30); // Padding + Resizer space
            if (w > widths[c]) widths[c] = w;
        }

        // Rows
        const rowCount = Math.min(this.model.getRowCount(), limit);
        // If there are an extreme number of columns (e.g. after transpose), measureText is too slow.
        // We will fallback to rough estimation if total measured cells > 5000.
        const useEstimation = (rowCount * counts) > 5000;

        for (let r = 0; r < rowCount; r++) {
            for (let c = 0; c < counts; c++) {
                const padding = 12; // 4px padding * 2 + some buffer for borders
                const val = this.model.getValue(r, c);
                if (val) {
                    let w = 0;
                    if (useEstimation) {
                        // Rough monospace estimation (6.5px for ascii, 12px for full-width)
                        w = padding;
                        for (let i = 0; i < val.length && i < 100; i++) { 
                            w += val.charCodeAt(i) > 255 ? 12 : 6.5; 
                        }
                        if (val.length > 100) w += (val.length - 100) * 6.5;
                        w = Math.ceil(w);
                    } else {
                        w = Math.ceil(context.measureText(val).width + padding);
                    }
                    if (w > widths[c]) widths[c] = Math.min(w, 400); // Max 400
                }
            }
        }
        return widths;
    }

    calcRowHeaderWidth() {
        const digits = this.model.getRowCount().toString().length;
        // Return number for easier calculation, match CSS sticky logic
        return Math.max(32, digits * 9 + 10);
    }

    getColumnLabel(index) {
        let label = '';
        let i = index;
        while (i >= 0) {
            label = String.fromCharCode(65 + (i % 26)) + label;
            i = Math.floor(i / 26) - 1;
        }
        return label;
    }

    calculateVisibleColumns() {
        const scrollLeft = this.gridContainer.scrollLeft;
        const viewWidth = this.gridContainer.clientWidth || 1000;
        const colCount = this.model.getColCount();
        
        let startCol = 0;
        let currentX = 0;
        
        // Find start column
        for (let i = 0; i < colCount; i++) {
            const w = this.colWidths[i] || 100;
            if (currentX + w > scrollLeft) {
                startCol = i;
                break;
            }
            currentX += w;
        }
        
        // Find end column
        let tempX = currentX;
        let endCol = startCol;
        for (let i = startCol; i < colCount; i++) {
            const w = this.colWidths[i] || 100;
            tempX += w;
            endCol = i;
            if (tempX > currentX + viewWidth) break;
        }

        // Buffer columns (render standard buffer offscreen for smooth scroll)
        const buffer = 10;
        startCol = Math.max(0, startCol - buffer);
        endCol = Math.min(colCount - 1, endCol + buffer);
        
        this.visibleCols = { start: startCol, end: endCol };
    }

    // Main Virtual Render Loop
    renderRows({ startIndex, endIndex, offsetY, totalHeight }) {
        this.renderState = { startR: startIndex, endR: endIndex };

        this.spacer.style.height = totalHeight + 'px';
        
        // Add padding to rowIndicesSpacer to ensure it can scroll as much as the gridContainer
        // The gridContainer might have a horizontal scrollbar, reducing its clientHeight.
        const scrollbarHeight = this.gridContainer.offsetHeight - this.gridContainer.clientHeight;
        this.rowIndicesSpacer.style.height = (totalHeight + scrollbarHeight) + 'px';

        const headerHeight = 28;
        // The Y position must be exactly aligned
        const topPos = (offsetY + headerHeight);
        this.contentTable.style.top = topPos + 'px';
        this.rowIndicesTable.style.top = offsetY + 'px'; // Fix: Aligned with data, no header offset needed here

        const colCount = this.model.getColCount();
        const dataFragment = document.createDocumentFragment();
        const indexFragment = document.createDocumentFragment();

        this.calculateVisibleColumns();
        const startCol = this.visibleCols.start;
        const endCol = this.visibleCols.end;

        for (let r = startIndex; r <= endIndex; r++) {
            const rowHeight = this.getRowHeight(r);
            
            // 1. Data Row
            const tr = document.createElement('tr');
            tr.style.height = rowHeight + 'px';

            if (startCol > 0) {
                let remaining = startCol;
                while (remaining > 0) {
                    const span = Math.min(1000, remaining);
                    const padTD = document.createElement('td');
                    padTD.colSpan = span;
                    padTD.style.border = 'none';
                    padTD.style.pointerEvents = 'none';
                    tr.appendChild(padTD);
                    remaining -= span;
                }
            }

            for (let c = startCol; c <= endCol; c++) {
                const td = document.createElement('td');
                td.textContent = this.model.getValue(r, c);
                td.title = this.model.getValue(r, c);
                // Force height and alignment to avoid CSS interference
                td.style.height = rowHeight + 'px';
                td.style.lineHeight = (rowHeight - 2) + 'px';
                td.style.boxSizing = 'border-box';
                
                if (this.isSelected(r, c)) td.classList.add('selected-cell');
                if (this.cursor.r === r && this.cursor.c === c) td.classList.add('active-cell');
                td.dataset.r = r;
                td.dataset.c = c;
                tr.appendChild(td);
            }
            dataFragment.appendChild(tr);

            // 2. Index Row
            const itr = document.createElement('tr');
            itr.style.height = rowHeight + 'px';
            const th = document.createElement('th');
            th.className = 'row-header';
            th.style.height = rowHeight + 'px';
            th.style.lineHeight = (rowHeight - 2) + 'px';
            th.style.boxSizing = 'border-box';
            
            th.textContent = r + 1; // Row 1 = Data[0] (Header), Row 2 = Data[1]...
            // mousedown + mouseover (not click) so rows can be range-selected by
            // dragging across the numbers, and extended with Shift+click.
            th.onmousedown = (e) => this.inputController.handleRowHeaderDown(r, e);
            th.onmouseover = (e) => this.inputController.handleRowHeaderOver(r, e);
            if (this.isRowSelected(r)) th.classList.add('selected-header');

            const resizer = document.createElement('div');
            resizer.className = 'row-resizer';
            resizer.onmousedown = (e) => this.initRowResize(r, e);
            resizer.onclick = (e) => e.stopPropagation();
            th.appendChild(resizer);
            itr.appendChild(th);
            indexFragment.appendChild(itr);
        }
        
        this.contentTableTBody.replaceChildren(dataFragment);
        this.rowIndicesTable.replaceChildren(indexFragment);
    }

    renderHeader() {
        this.headerTableTHead.innerHTML = '';
        this.corner.onclick = () => this.inputController.selectAll();
        this.corner.style.width = this.rowHeaderWidth + 'px';
        this.corner.textContent = ''; // Clear corner

        const tr = document.createElement('tr');
        tr.style.height = this.rowHeight + 'px';

        this.calculateVisibleColumns();
        const startCol = this.visibleCols.start;
        const endCol = this.visibleCols.end;

        if (startCol > 0) {
            let remaining = startCol;
            while (remaining > 0) {
                const span = Math.min(1000, remaining);
                const padTH = document.createElement('th');
                padTH.colSpan = span;
                padTH.style.border = 'none';
                padTH.style.pointerEvents = 'none';
                tr.appendChild(padTH);
                remaining -= span;
            }
        }

        for (let c = startCol; c <= endCol; c++) {
            const th = document.createElement('th');
            th.className = 'col-header';
            
            const labelSpan = document.createElement('span');
            labelSpan.textContent = this.getColumnLabel(c);
            labelSpan.style.marginRight = '8px';
            th.appendChild(labelSpan);

            const sortControls = document.createElement('div');
            sortControls.className = 'csv-sort-controls';
            sortControls.style.display = 'inline-flex';
            sortControls.style.flexDirection = 'row';
            sortControls.style.fontSize = '10px';
            sortControls.style.opacity = '0.4';
            sortControls.style.transition = 'opacity 0.2s';
            sortControls.style.pointerEvents = 'auto'; // allow click

            const upArrow = document.createElement('span');
            upArrow.textContent = '▲';
            upArrow.style.cursor = 'pointer';
            upArrow.style.padding = '0 2px';
            upArrow.title = 'Ascending';
            upArrow.onmousedown = (e) => {
                e.stopPropagation(); // prevent column selection
                this.inputController.sortColumn(c, 'asc');
            };

            const downArrow = document.createElement('span');
            downArrow.textContent = '▼';
            downArrow.style.cursor = 'pointer';
            downArrow.style.padding = '0 2px';
            downArrow.title = 'Descending';
            downArrow.onmousedown = (e) => {
                e.stopPropagation(); // prevent column selection
                this.inputController.sortColumn(c, 'desc');
            };

            sortControls.appendChild(upArrow);
            sortControls.appendChild(downArrow);
            th.appendChild(sortControls);

            th.onmouseenter = () => sortControls.style.opacity = '1';
            th.onmouseleave = () => sortControls.style.opacity = '0.4';

            // Click empty area to select column; drag across headers (or
            // Shift+click) to select a range of columns.
            th.onmousedown = (e) => this.inputController.handleColHeaderDown(c, e);
            th.onmouseover = (e) => this.inputController.handleColHeaderOver(c, e);
            th.oncontextmenu = (e) => this.inputController.handleContextMenu(-1, c, e);

            const resizer = document.createElement('div');
            resizer.className = 'col-resizer';
            resizer.onmousedown = (e) => this.initColResize(c, e);
            resizer.onclick = (e) => e.stopPropagation();
            th.appendChild(resizer);

            if (this.isColSelected(c)) th.classList.add('selected-header');
            tr.appendChild(th);
        }
        this.headerTableTHead.appendChild(tr);
    }

    renderColGroup(table) {
        let colgroup = table.querySelector('colgroup');
        if (!colgroup) {
            colgroup = document.createElement('colgroup');
            table.insertBefore(colgroup, table.firstChild);
        } else {
            colgroup.innerHTML = '';
        }

        const isIndexTable = table.classList.contains('row-indices-table');
        const rw = this.rowHeaderWidth;
        
        if (isIndexTable) {
            const col = document.createElement('col');
            col.style.width = rw + 'px';
            colgroup.appendChild(col);
            table.style.width = rw + 'px';
            table.style.minWidth = rw + 'px';
        } else {
            let totalWidth = 0;
            const count = this.model.getColCount();
            const frag = document.createDocumentFragment();
            for (let i = 0; i < count; i++) {
                const col = document.createElement('col');
                const w = (this.colWidths && this.colWidths[i] !== undefined) ? this.colWidths[i] : 100;
                col.style.width = w + 'px';
                frag.appendChild(col);
                totalWidth += w;
            }
            colgroup.appendChild(frag);
            table.style.width = totalWidth + 'px';
            table.style.minWidth = totalWidth + 'px';
        }
        table.style.tableLayout = 'fixed';
    }

    // Selection Helpers
    getNormalizedRange() {
        const { start, end } = this.selection;
        return {
            r1: Math.min(start.r, end.r),
            r2: Math.max(start.r, end.r),
            c1: Math.min(start.c, end.c),
            c2: Math.max(start.c, end.c)
        };
    }

    isSelected(r, c) {
        const { r1, r2, c1, c2 } = this.getNormalizedRange();
        return r >= r1 && r <= r2 && c >= c1 && c <= c2;
    }
    isRowSelected(r) {
        const { r1, r2 } = this.getNormalizedRange();
        return r >= r1 && r <= r2;
    }
    isColSelected(c) {
        const { c1, c2 } = this.getNormalizedRange();
        return c >= c1 && c <= c2;
    }

    refreshSelection() {
        // Full rerender is expensive? In virtual DOM it's fast enough for visible rows (e.g. 50 rows).
        // For optimal perf, we could just toggle classes.
        // But renderRows is called on scroll anyway.
        // Let's call renderRows with current window.
        // scroller.onScroll() triggers callback.
        this.scroller.onScroll();
        this.renderHeader(); // Update header highlights
    }

    /**
     * Bring cell (r, c) into view.
     *
     * `axis` restricts which direction may scroll: 'v' / 'h' / 'both'.
     * Extending a selection vertically must not touch the horizontal scroll —
     * after Shift+Space the selection's focus column is the LAST column, so
     * scrolling to it flung the grid to the far right on every Shift+↑/↓.
     */
    scrollToCell(r, c, axis = 'both') {
        // Calculate position
        // Row pos
        const top = r * this.rowHeight;
        // Col pos (harder if not fixed width, but we use auto-layout for cols? Excel uses fixed capable).
        // Our cells are dynamic width... this breaks Virtualization if we don't know widths.
        // Implementation Plan said "Fixed Height". Width?
        // Standard table layout: Width is determined by content...
        // For Virtual Column scroll, we need fixed widths.
        // For now, only Row Virtualization. Brower handles X scroll.
        // We just need to ensure container scrolls Y.

        const currentTop = this.gridContainer.scrollTop;
        const currentHeight = this.gridContainer.clientHeight;
        const headerOffset = 32;

        if (axis !== 'h') {
            if (top < currentTop) {
                this.gridContainer.scrollTop = top;
            } else if (top + this.rowHeight + headerOffset > currentTop + currentHeight) {
                this.gridContainer.scrollTop = top + this.rowHeight + headerOffset - currentHeight;
            }
        }

        if (axis === 'v') return;

        // Horizontal scroll
        let colX = 0;
        for (let i = 0; i < c; i++) {
            colX += this.colWidths[i] || 100;
        }
        const colW = this.colWidths[c] || 100;
        
        const currentLeft = this.gridContainer.scrollLeft;
        const viewWidth = this.gridContainer.clientWidth;
        
        if (colX < currentLeft) {
            this.gridContainer.scrollLeft = colX;
        } else if (colX + colW > currentLeft + viewWidth) {
            this.gridContainer.scrollLeft = colX + colW - viewWidth;
        }
    }


    /* --- Resize Logic --- */
    initColResize(index, e) {
        e.stopPropagation();
        this.isResizing = true;
        this.resizeType = 'col';
        this.resizeIndex = index;
        this.resizeStart = e.clientX;
        this.resizeStartSize = this.colWidths[index];

        this.resizeMoveBound = this.resizeMove.bind(this);
        this.resizeUpBound = this.resizeUp.bind(this);

        document.addEventListener('mousemove', this.resizeMoveBound);
        document.addEventListener('mouseup', this.resizeUpBound);
        document.body.style.cursor = 'col-resize';
    }

    initRowResize(index, e) {
        e.stopPropagation();
        this.isResizing = true;
        this.resizeType = 'row';
        this.resizeIndex = index;
        this.resizeStart = e.clientY;
        this.resizeStartSize = this.getRowHeight(index); // Use specific height

        this.resizeMoveBound = this.resizeMove.bind(this);
        this.resizeUpBound = this.resizeUp.bind(this);

        document.addEventListener('mousemove', this.resizeMoveBound);
        document.addEventListener('mouseup', this.resizeUpBound);
        document.body.style.cursor = 'row-resize';
    }

    resizeMove(e) {
        if (!this.isResizing) return;

        if (this.resizeType === 'col') {
            const dx = e.clientX - this.resizeStart;
            const newW = Math.max(30, this.resizeStartSize + dx);
            this.colWidths[this.resizeIndex] = newW;
            this.updateColWidths();
        } else {
            // Row Resize (Specific)
            const dy = e.clientY - this.resizeStart;
            // Limit min height
            const newH = Math.max(16, this.resizeStartSize + dy);

            // Update specific row height
            if (!this.rowHeights) this.rowHeights = {};
            this.rowHeights[this.resizeIndex] = newH;

            // Re-init/Update scroller
            if (this.scroller) {
                // Force update. 
                // Since total height changes, onScroll needs to run.
                this.scroller.onScroll();
            }
            this.renderHeader(); // Widths/Layout might need update if we had row-headers that depended on height (unlikely)
            // But we need to update the grid layout immediately
        }
    }

    resizeUp() {
        this.isResizing = false;
        document.removeEventListener('mousemove', this.resizeMoveBound);
        document.removeEventListener('mouseup', this.resizeUpBound);
        document.body.style.cursor = 'default';
        // Trigger layout update
        this.scroller.onScroll();
    }

    updateColWidths() {
        this.updateTableColGroup(this.headerTable);
        this.updateTableColGroup(this.contentTable);
    }

    updateTableColGroup(table) {
        if (!table) return;
        let cg = table.querySelector('colgroup');
        if (!cg) return;

        const isIndexTable = table.classList.contains('row-indices-table');
        
        if (isIndexTable) {
            const rw = this.rowHeaderWidth;
            if (cg.children[0]) cg.children[0].style.width = rw + 'px';
            table.style.width = rw + 'px';
        } else {
            let totalWidth = 0;
            for (let i = 0; i < this.colWidths.length; i++) {
                const col = cg.children[i];
                const w = this.colWidths[i];
                if (col) col.style.width = w + 'px';
                totalWidth += w;
            }
            table.style.width = totalWidth + 'px';
        }
    }
}

// --- Controller: Logic & Input ---
class CsvController {
    constructor(host, content, onSave) {
        this.host = host; // Container
        this.onSave = onSave;

        this.debouncedSave = (() => {
            let timer = null;
            return () => {
                if (timer) clearTimeout(timer);
                timer = setTimeout(() => {
                    if (this.onSave && this.model) {
                        this.onSave(this.model.serialize());
                    }
                }, 500);
            };
        })();

        // Setup Dual View Containers
        this.host.innerHTML = '';
        this.host.style.position = 'relative'; // Ensure absolute children are contained
        this.host.className = 'csv-editor-container';

        this.viewContainer = document.createElement('div');
        this.viewContainer.tabIndex = 0;
        this.viewContainer.style.outline = 'none';
        this.viewContainer.style.height = '100%';

        this.mode = 'grid';

        // 1. Initial Empty Model
        this.model = new CsvModel('', null);

        // 2. View
        this.view = new CsvView(this.viewContainer, this.model, this);

        // 3. Load Async
        if (content) {
            this.view.showLoading();
            parseCsvAsync(content).then(rows => {
                this.model = new CsvModel('', null);
                this.model.data = rows && rows.length > 0 ? rows : [['']];
                this.view.model = this.model;
                this.view.hideLoading();
                this.view.updateData();
            }).catch(err => {
                console.error('Failed to parse CSV:', err);
                this.view.hideLoading();
                // Fallback to basic model if async fails
                this.model = new CsvModel(content);
                this.view.model = this.model;
                this.view.updateData();
            });
        }

        // 3. Jump State
        this.jumpState = { active: false, buffer: '', timer: null };
        this.jumpDisplay = document.createElement('div');
        this.jumpDisplay.className = 'csv-jump-display';
        this.jumpDisplay.style.cssText = 'position:fixed; bottom:50px; right:20px; padding:10px; background:var(--bg-color-secondary); color:var(--text-color); border:1px solid var(--border-color); display:none; z-index:1000; font-family:monospace;';
        this.host.appendChild(this.jumpDisplay);

        // Overlay Editor for Cell Editing
        this.overlayEditor = document.createElement('textarea');
        this.overlayEditor.className = 'csv-overlay-editor';

        // Auto-save on blur
        this.overlayEditor.addEventListener('blur', () => this.finishEditing());
        this.overlayEditor.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { 
                e.preventDefault();
                this.finishEditing();
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                this.cancelEditing();
            }
        });

        this.host.appendChild(this.viewContainer);
        this.view.gridContainer.appendChild(this.overlayEditor);

        document.body.appendChild(this.jumpDisplay);

        this.mode = 'grid';
        this.isDragging = false;
        // Header range-selection state (row numbers / column headers).
        this.isRowDragging = false;
        this.isColDragging = false;
        this.rowAnchor = null;
        this.colAnchor = null;
        this.jumpState = { active: false, buffer: '', timer: null };

        this.bindEvents();

        // Register CSV Shortcuts
        this.registerShortcuts();

        // Initial Focus
        setTimeout(() => {
            // Check if focus is in Explorer (Sidebar)
            const active = document.activeElement;
            const isExplorerFocused = active && (
                active.closest('#file-explorer') ||
                active.closest('.virtual-explorer-host') ||
                active.classList.contains('explorer-item')
            );

            if (!isExplorerFocused && this.viewContainer.isConnected) {
                this.viewContainer.focus();
            }
        }, 50);
    }

    bindEvents() {
        this.keyDownHandler = this.onKeyDown.bind(this);
        this.mouseUpHandler = () => {
            this.isDragging = false;
            this.isRowDragging = false;
            this.isColDragging = false;
        };
        this.copyHandler = this.onCopy.bind(this);
        this.pasteHandler = this.onPaste.bind(this);
        this.inputHandler = (e) => {
            if (this.mode === 'text') {
                const val = this.textEditor.value;
                // Preserve line ending behavior:
                // Normalize mixed/browser endings to \n then to target
                const normalized = val.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, this.model.lineEnding);
                this.onSave(normalized);
            }
        };

        // document.addEventListener('keydown', this.keyDownHandler); // Migrated to ShortcutManager
        document.addEventListener('mouseup', this.mouseUpHandler);
        document.addEventListener('copy', this.copyHandler);
        document.addEventListener('paste', this.pasteHandler);
    }

    registerShortcuts() {
        // Shortcuts are now registered globally in App.js via delegateToView
    }

    destroy() {
        // document.removeEventListener('keydown', this.keyDownHandler);
        document.removeEventListener('mouseup', this.mouseUpHandler);
        document.removeEventListener('copy', this.copyHandler);
        document.removeEventListener('paste', this.pasteHandler);
        if (this.jumpDisplay) this.jumpDisplay.remove();
        if (this.view.scroller) this.view.scroller.destroy();
    }

    // handleShortcut is defined later in this class (line ~883)

    // toggleMode deleted as per user instruction. 
    // Handled by global viewMode system now.

    // --- Inputs ---

    handleCellDown(r, c, e) {
        if (e.button === 2) return; // Right click
        if (e.target.isContentEditable) return;

        // Ensure container has focus so valid global key events will fire from now on
        if (document.activeElement !== this.viewContainer) {
            this.viewContainer.focus({ preventScroll: true });
        }

        this.isDragging = true;
        this.view.cursor = { r, c };
        this.view.selection.start = { r, c };
        this.view.selection.end = { r, c };
        this.view.refreshSelection();
    }

    handleCellOver(r, c, e) {
        // Failsafe: check if primary button is actually pressed
        if (e.buttons !== 1) {
            this.isDragging = false;
            return;
        }

        if (this.isDragging) {
            this.view.selection.end = { r, c };
            this.view.refreshSelection();
        }
    }

    // ── Row / column header selection ────────────────────────────────────────
    // Anchored like the cell grid: a plain press sets the anchor, Shift+click
    // extends from it, and dragging across headers extends continuously.

    handleRowHeaderDown(r, e) {
        if (e.button === 2) return; // right-click → context menu
        if (document.activeElement !== this.viewContainer) {
            this.viewContainer.focus({ preventScroll: true });
        }
        if (!(e.shiftKey && this.rowAnchor != null)) this.rowAnchor = r;
        this.isRowDragging = true;
        // Active cell goes to the first column of the clicked row.
        this.view.cursor = { r, c: 0 };
        this._selectRowRange(this.rowAnchor, r);
    }

    handleRowHeaderOver(r, e) {
        if (e.buttons !== 1) { this.isRowDragging = false; return; }
        if (!this.isRowDragging || this.rowAnchor == null) return;
        // refreshSelection() rebuilds the rows, so only redraw on a real change.
        if (this.view.selection.end.r === r) return;
        this._selectRowRange(this.rowAnchor, r);
    }

    handleColHeaderDown(c, e) {
        if (e.button === 2) return; // right-click → context menu
        if (document.activeElement !== this.viewContainer) {
            this.viewContainer.focus({ preventScroll: true });
        }
        if (!(e.shiftKey && this.colAnchor != null)) this.colAnchor = c;
        this.isColDragging = true;
        // Active cell goes to the first row of the clicked column.
        this.view.cursor = { r: 0, c };
        this._selectColRange(this.colAnchor, c);
    }

    handleColHeaderOver(c, e) {
        if (e.buttons !== 1) { this.isColDragging = false; return; }
        if (!this.isColDragging || this.colAnchor == null) return;
        // renderHeader() rebuilds the header, so only redraw on a real change.
        if (this.view.selection.end.c === c) return;
        this._selectColRange(this.colAnchor, c);
    }

    _selectRowRange(fromRow, toRow) {
        this.view.selection.start = { r: fromRow, c: 0 };
        this.view.selection.end = { r: toRow, c: this.model.getColCount() - 1 };
        this.view.refreshSelection();
    }

    _selectColRange(fromCol, toCol) {
        this.view.selection.start = { r: 0, c: fromCol };
        this.view.selection.end = { r: this.model.getRowCount() - 1, c: toCol };
        this.view.refreshSelection();
    }

    handleShortcut(command, e) {
        // Delegate to onKeyDown or handle specific commands
        if (command === 'csv:undo' || command === 'app:undo') {
            if (this.model.undo()) {
                this.view.updateData();
                this.view.refreshSelection();
                this.debouncedSave();
            }
            return true;
        }
        if (command === 'csv:redo' || command === 'app:redo') {
            if (this.model.redo()) {
                this.view.updateData();
                this.view.refreshSelection();
                this.debouncedSave();
            }
            return true;
        }
        if (command === 'csv:select-row') {
            if (e) Object.defineProperty(e, 'code', { value: 'Space', configurable: true });
            this.onKeyDown(e);
            return true;
        }
        if (command === 'csv:select-rows') {
            if (e) Object.defineProperty(e, 'code', { value: 'Space', configurable: true });
            this.onKeyDown(e);
            return true;
        }
        if (command === 'csv:insert-copied-rows') {
            if (e) e.preventDefault();
            const { r1 } = this.view.getNormalizedRange();
            this.insertCopiedRows(r1);
            return true;
        }
        if (command === 'csv:insert-copied-cols') {
            if (e) e.preventDefault();
            const { c1 } = this.view.getNormalizedRange();
            this.insertCopiedCols(c1);
            return true;
        }
        if (command.startsWith('csv:')) {
            this.onKeyDown(e);
            return true;
        }
        // For global commands like app:toggle-view-mode, app:copy, app:paste, etc.
        // return false so delegateToView falls through to globalActions
        return false;
    }

    selectAll() {
        this.view.cursor = { r: 0, c: 0 };
        this.view.selection.start = { r: 0, c: 0 };
        this.view.selection.end = { r: this.model.getRowCount() - 1, c: this.model.getColCount() - 1 };
        this.view.refreshSelection();
    }

    handleCellDblClick(r, c, td, e) {
        this.startEditing(r, c);
    }

    startEditing(r, c, initialVal = null) {
        // Editing always moves the active cell to the edited cell.
        this.view.cursor = { r, c };
        if (this.mode === 'text') return;

        // Ensure visible
        this.view.scrollToCell(r, c);

        // Defer to allow scroll
        setTimeout(() => {
            this.editingState = { r, c };
            const val = initialVal !== null ? initialVal : this.model.getValue(r, c);

            // Find the rendered cell DOM element
            const cells = this.view.contentTableTBody.querySelectorAll('tr td');
            // Since we know the render range startR, we can find the exact index
            const visibleRowIdx = r - this.view.renderState.startR;
            const tdIdx = visibleRowIdx * this.model.getColCount() + c;
            const td = cells[tdIdx];

            if (!td) {
                console.warn('CsvEditor: Target TD not found for editing, aborting.');
                return;
            }

            // Calc Position using getBoundingClientRect relative to gridContainer
            const containerRect = this.view.gridContainer.getBoundingClientRect();
            const tdRect = td.getBoundingClientRect();

            // Overlay is absolute child of gridContainer, which is position:relative.
            // Absolute positioning is relative to the top-left of the scrollable box (content origin).
            // So we add current scroll position to the viewport-relative offset.
            const top = tdRect.top - containerRect.top + this.view.gridContainer.scrollTop;
            const left = tdRect.left - containerRect.left + this.view.gridContainer.scrollLeft;

            // Apply to overlay
            this.overlayEditor.style.display = 'block';
            this.overlayEditor.style.top = (top - 1) + 'px'; // -1 for border overlap
            this.overlayEditor.style.left = (left - 1) + 'px'; // -1 for border overlap
            this.overlayEditor.style.width = (tdRect.width + 1) + 'px';
            this.overlayEditor.style.minHeight = (tdRect.height + 1) + 'px';
            this.overlayEditor.style.height = (tdRect.height + 1) + 'px';
            this.overlayEditor.value = val;

            this.overlayEditor.focus();
        }, 10);
    }

    finishEditing() {
        if (this.overlayEditor.style.display === 'none') return;
        const { r, c } = this.editingState;
        const newVal = this.overlayEditor.value;

        this.model.setValue(r, c, newVal);
        this.view.updateData(); // Refresh grid
        this.debouncedSave();

        this.overlayEditor.style.display = 'none';

        // Phase 13: Robust focus recovery - focus gridContainer directly
        shortcuts.setScope('CSV');
        setTimeout(() => {
            if (this.view && this.view.gridContainer && this.view.gridContainer.isConnected) {
                this.view.gridContainer.focus({ preventScroll: true });
                // Double check
                if (document.activeElement !== this.view.gridContainer) {
                    this.view.gridContainer.focus({ preventScroll: true });
                }
            }
        }, 50);
    }

    cancelEditing() {
        this.overlayEditor.style.display = 'none';
        shortcuts.setScope('CSV');
        setTimeout(() => {
            if (this.view && this.view.gridContainer && this.view.gridContainer.isConnected) {
                this.view.gridContainer.focus({ preventScroll: true });
            }
        }, 50);
    }


    handleContextMenu(r, c, e) {
        e.preventDefault();
        e.stopPropagation();
        
        let menuItems = [];

        if (r === -1) {
            // Column Header Context Menu
            menuItems = [
                { label: 'Sort Ascending', action: () => this.sortColumn(c, 'asc') },
                { label: 'Sort Descending', action: () => this.sortColumn(c, 'desc') },
                { type: 'separator' },
                { label: 'Insert Column Left', action: () => { this.model.insertCol(c); this.view.updateData(); } },
                { label: 'Insert Column Right', action: () => { this.model.insertCol(c + 1); this.view.updateData(); } },
                { label: 'Insert Copied Columns Left', action: () => this.insertCopiedCols(c) },
                { label: 'Insert Copied Columns Right', action: () => this.insertCopiedCols(c + 1) },
                { label: 'Delete Column', action: () => { this.model.deleteCol(c); this.view.updateData(); } }
            ];
        } else {
            // Standard cell context menu
            menuItems = [
                { label: 'Refresh', action: () => this.view.refreshSelection() },
                { type: 'separator' },
                { label: 'Transpose', action: () => this.transpose() },
                { type: 'separator' },
                { label: 'Insert Row Above', action: () => { this.model.insertRow(r); this.view.updateData(); } },
                { label: 'Insert Row Below', action: () => { this.model.insertRow(r + 1); this.view.updateData(); } },
                { label: 'Insert Copied Rows Above', action: () => this.insertCopiedRows(r) },
                { label: 'Insert Copied Rows Below', action: () => this.insertCopiedRows(r + 1) },
                { type: 'separator' },
                { label: 'Insert Column Left', action: () => { this.model.insertCol(c); this.view.updateData(); } },
                { label: 'Insert Column Right', action: () => { this.model.insertCol(c + 1); this.view.updateData(); } },
                { label: 'Insert Copied Columns Left', action: () => this.insertCopiedCols(c) },
                { label: 'Insert Copied Columns Right', action: () => this.insertCopiedCols(c + 1) },
                { type: 'separator' },
                { label: 'Delete Row', action: () => { this.model.deleteRow(r); this.view.updateData(); } },
                { label: 'Delete Column', action: () => { this.model.deleteCol(c); this.view.updateData(); } }
            ];
        }
        ContextMenu.show(e, menuItems);
    }

    sortColumn(c, direction) {
        this.view.showLoading('Sorting...');
        setTimeout(() => {
            try {
                this.model.sort(c, direction);
                this.view.updateData();
                this.view.refreshSelection();
                this.debouncedSave();
            } finally {
                this.view.hideLoading();
            }
        }, 20);
    }

    onKeyDown(e) {
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'e') {
            // Handled by global shortcut manager now
            return;
        }

        if (this.mode === 'text') return;

        // Focus Check: Only respond if we have meaningful focus.
        // Allow if:
        // 1. Focus is within our host (viewContainer, textarea, etc)
        // 2. Focus is on BODY (initial load or blur) AND we are visible
        const active = document.activeElement;

        // Explicitly ignore if Explorer has focus
        if (active && active.closest && (active.closest('#explorer') || active.closest('#file-list'))) return;

        const hasFocus = this.host.contains(active);

        if (!hasFocus) return;

        if (!hasFocus) return;

        // Editing check
        if (this.overlayEditor.style.display === 'block') {
            if (e.key === 'Escape') {
                this.cancelEditing();
                return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                this.finishEditing();
                // Allow fall-through to moveSelection
            } else {
                return; // Let editor handle other events (typing)
            }
        }

        // Column Selection (Ctrl+Space)
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.code === 'Space') {
            e.preventDefault();
            this.view.selection.start.r = 0;
            this.view.selection.end.r = this.model.getRowCount() - 1;
            this.view.refreshSelection();
            return;
        }

        // Add Row and Paste (Ctrl+Shift+; or Ctrl+Shift++ or Ctrl+Shift+:)
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === ';' || e.key === '+' || e.key === ':' || e.code === 'Semicolon' || e.code === 'NumpadAdd')) {
            e.preventDefault();
            this.handleAddRowWithPaste();
            return;
        }

        // Undo / Redo
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
            e.preventDefault();
            if (e.shiftKey) {
                if (this.model.redo()) { this.view.updateData(); this.debouncedSave(); }
            } else {
                if (this.model.undo()) { this.view.updateData(); this.debouncedSave(); }
            }
            return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
            e.preventDefault();
            if (this.model.redo()) { this.view.updateData(); this.debouncedSave(); }
            return;
        }

        // Row Selection
        if (e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'Space') {
            e.preventDefault();
            this.view.selection.start.c = 0;
            this.view.selection.end.c = this.model.getColCount() - 1;
            this.view.refreshSelection();
            return;
        }

        // Jump Mode
        if (this.jumpState.active) {
            this.handleJumpInput(e);
            return;
        }

        // 1. Jump Mode (j -> D1 etc)
        if (e.key === 'j') {
            e.preventDefault();
            this.startJump();
            return;
        }

        // 2. Row/Col Modification Shortcuts (Alt based)
        // Alt + ; (or +) -> Insert Row Below / Col Right
        // Alt + - (or =) -> Delete Row / Col
        if (e.altKey) {
            const k = e.key;
            if (k === ';' || k === '+') {
                e.preventDefault();
                const { r, c } = this.view.cursor;
                if (e.shiftKey) this.model.insertCol(c + 1);
                else this.model.insertRow(r + 1);
                this.view.updateData();
                return;
            }
            if (k === '-' || k === '=') {
                e.preventDefault();
                const { r, c } = this.view.cursor;
                if (e.shiftKey) this.model.deleteCol(c);
                else this.model.deleteRow(r);
                this.view.updateData();
                return;
            }
        }

        if (e.key.startsWith('Arrow') || e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            // Prevent native selection bleeding
            const sel = window.getSelection();
            if (sel) sel.removeAllRanges();

            this.moveSelection(e.key, e.shiftKey, e.ctrlKey || e.metaKey);
        }
        else if (e.key === 'PageUp' || e.key === 'PageDown') {
            e.preventDefault();
            // Paging logic
            const dir = e.key === 'PageUp' ? -1 : 1;
            const pageSize = 20; // Approx rows
            const maxR = this.model.getRowCount() - 1;
            // Shift pages the focus and keeps the anchor; otherwise page from
            // the active cell. (The previous version overwrote selection.start
            // before the shift check, so Shift+PageUp never kept its anchor.)
            const fromR = e.shiftKey ? this.view.selection.end.r : this.view.cursor.r;
            const c = e.shiftKey ? this.view.selection.end.c : this.view.cursor.c;
            const nextR = Math.max(0, Math.min(fromR + dir * pageSize, maxR));

            if (e.shiftKey) {
                this.view.selection.end = { r: nextR, c };
            } else {
                this.view.cursor = { r: nextR, c };
                this.view.selection.start = { r: nextR, c };
                this.view.selection.end = { r: nextR, c };
            }

            this.view.refreshSelection();
            this.view.scrollToCell(nextR, c, e.shiftKey ? 'v' : 'both');
        }
        else if (e.key === 'Delete' || e.key === 'Backspace') {
            this.model.saveState(); // Save state before bulk delete
            this.deleteSelection();
            this.debouncedSave();
        }
        else if (e.key === 'F2') {
            // Edit current cell
            // Need ref to TD.
            // Virtual Grid: TD might not exist if out of view!
            // If out of view, we jump to it first.
            // F2 edits the ACTIVE cell, not the selection's focus corner.
            const end = this.view.cursor;
            this.view.scrollToCell(end.r, end.c);
            // Wait for scroll/render?
            setTimeout(() => {
                // Find cell
                const r = end.r - this.view.renderState.startR; // Relative index in rendered rows
                // Logic is complex because renderRows clears table.
                // We can traverse contentTable.
                // This is tricky with virtualization.
                // Let's rely on standard events if possible or querySelector efficiently.
                // Row index in contentTable is r.
                // contentTable.children[r] ?
                // No, contentTable children are only the visible rows.
                // So index is `end.r - renderedStart`.

                const rowIndex = end.r - this.view.renderState.startR;
                if (rowIndex >= 0 && rowIndex < this.view.contentTable.rows.length) {
                    const tr = this.view.contentTable.rows[rowIndex];
                    const td = tr.children[end.c]; // 0 is header? No, row header is 0. Data start 1.
                    // Assuming we have Row Header in content table? Yes.
                    if (tr.children[end.c + 1]) {
                        const cell = tr.children[end.c + 1];
                        // Trigger edit
                        this.handleCellDblClick(end.r, end.c, cell, {});
                    }
                }
            }, 50);
        }
    }

    moveSelection(key, shift, ctrl) {
        const rows = this.model.getRowCount();
        const cols = this.model.getColCount();

        // Shift extends the existing rectangle from its focus (selection.end);
        // an unshifted move walks from the ACTIVE cell. Walking from
        // selection.end when unshifted is what used to fling the caret to the
        // row/column end after Shift+Space / Ctrl+Space.
        let currR = shift ? this.view.selection.end.r : this.view.cursor.r;
        let currC = shift ? this.view.selection.end.c : this.view.cursor.c;

        let dr = 0, dc = 0;
        if (key === 'ArrowUp') dr = -1;
        else if (key === 'ArrowDown') dr = 1;
        else if (key === 'ArrowLeft') dc = -1;
        else if (key === 'ArrowRight') dc = 1;
        else if (key === 'Enter') dr = shift ? -1 : 1;
        else if (key === 'Tab') dc = shift ? -1 : 1;

        if (ctrl && key.startsWith('Arrow')) {
            // Ctrl Jump Logic
            // ... implementation of findNextBoundary ...
            // Simplified here for brevity, reuse logic if needed
            let nextR = currR, nextC = currC;
            while (true) {
                nextR += dr; nextC += dc;
                if (nextR < 0 || nextR >= rows || nextC < 0 || nextC >= cols) {
                    nextR -= dr; nextC -= dc; break;
                }
                const val = this.model.getValue(nextR, nextC);
                if (val) {
                    // Found value? 
                    // Logic: if start was empty, jump to first val.
                    // If start was val, jump to last val before empty.
                    // This is complex logic.
                    // Detailed logic from previous session should be copied.
                }
                // Simple Skip: Jump 10 for now in Prototype, or reimplement full logic?
                // Let's implement full logic to satisfy requirements.
                break; // Placeholder: Single step for safety if not implementing complex logic now.
            }
            // Actually, let's just do single step + clamp vs boundary.
            // Full standard Ctrl+Arrow is:
            // If Current is Empty -> Jump to next Non-Empty
            // If Current is Data -> Jump to last Data before Empty

            // Quick implementation:
            const isCellFilled = (r, c) => !!this.model.getValue(r, c);
            const startFilled = isCellFilled(currR, currC);

            let r = currR + dr;
            let c = currC + dc;

            // Bounds check helper
            const inBounds = (r, c) => r >= 0 && r < rows && c >= 0 && c < cols;

            if (!inBounds(r, c)) { /* At edge already */ }
            else {
                if (startFilled) {
                    if (isCellFilled(r, c)) {
                        // Slide until empty or edge
                        while (inBounds(r + dr, c + dc) && isCellFilled(r + dr, c + dc)) {
                            r += dr; c += dc;
                        }
                    } else {
                        // Slide until data or edge
                        // Wait, Excel behavior: if next is empty, we stop at edge of data? 
                        // No, Ctrl+Arrow from data edge -> jumps over empty -> lands on next data.
                        while (inBounds(r, c) && !isCellFilled(r, c)) {
                            r += dr; c += dc;
                        }
                        // If we went off edge, step back
                        if (!inBounds(r, c)) { r -= dr; c -= dc; }
                    }
                } else {
                    // From empty, find next data
                    while (inBounds(r, c) && !isCellFilled(r, c)) {
                        r += dr; c += dc;
                    }
                    if (!inBounds(r, c)) { r -= dr; c -= dc; }
                }
                currR = r; currC = c;
            }
        } else {
            currR += dr;
            currC += dc;
        }

        currR = Math.max(0, Math.min(currR, rows - 1));
        currC = Math.max(0, Math.min(currC, cols - 1));

        if (shift) {
            // Extend the rectangle; the active cell stays put (Excel behaviour).
            this.view.selection.end = { r: currR, c: currC };
        } else {
            this.view.cursor = { r: currR, c: currC };
            this.view.selection.start = { r: currR, c: currC };
            this.view.selection.end = { r: currR, c: currC };
        }

        this.view.refreshSelection();
        if (shift && (dr !== 0 || dc !== 0)) {
            // Extending a range: follow the focus only along the axis it moved
            // on. Keeps the viewport put on a full-row selection (Shift+Space)
            // walked up/down, and on a full-column selection walked left/right.
            this.view.scrollToCell(currR, currC, dr !== 0 ? 'v' : 'h');
        } else {
            this.view.scrollToCell(currR, currC);
        }
    }

    deleteSelection() {
        // Clear data in range
        const { r1, r2, c1, c2 } = this.view.getNormalizedRange();
        for (let r = r1; r <= r2; r++) {
            for (let c = c1; c <= c2; c++) {
                this.model.setValue(r, c, '');
            }
        }
        this.view.updateData(); // Rerender
        this.debouncedSave();
    }

    async copy() {
        if (this.mode === 'text') {
            // Text mode handled by system or manual execCommand if needed?
            // Actually app:copy prevents default, so we must handle it.
            const text = window.getSelection().toString();
            if (text) await writeText(text);
            return;
        }
        if (this.isEditingField()) return; // Let native input copy work? verify.

        const { r1, r2, c1, c2 } = this.view.getNormalizedRange();

        // Performance Optimization: Use map efficiently without excessive slice allocations
        const lines = [];
        for (let r = r1; r <= r2; r++) {
            const row = this.model.data[r];
            if (!row) continue;
            let rowText = '';
            for (let c = c1; c <= c2; c++) {
                rowText += (row[c] || '') + (c < c2 ? '\t' : '');
            }
            lines.push(rowText);
            // Break loop intentionally if taking too long? 
            // In practical terms Array.push is very fast, faster than intermediate array slices
        }
        
        await writeText(lines.join('\n'));
    }

    async transpose() {
        this.view.showLoading('Transposing...');
        // yield to allow UI update
        await new Promise(r => setTimeout(r, 20));
        
        try {
            this.model.transpose();
            // Recalculate everything
            this.view.colWidths = this.view.calculateColumnWidths();
            this.view.rowHeaderWidth = this.view.calcRowHeaderWidth();
            this.view.renderColGroup(this.view.headerTable);
            this.view.renderColGroup(this.view.contentTable);
            this.view.scroller.update(this.model.getRowCount());
            this.view.renderHeader();
            this.view.refreshSelection();
            this.debouncedSave();
        } finally {
            this.view.hideLoading();
        }
    }

    async cut() {
        if (this.mode === 'text') {
            document.execCommand('cut');
            return;
        }
        if (this.isEditingField()) return;

        await this.copy();
        this.deleteSelection();
    }

    async paste() {
        if (this.mode === 'text') {
            // Text mode paste
            try {
                const text = await readText();
                if (text) document.execCommand('insertText', false, text);
            } catch (err) {
                console.warn('CsvEditor (text) paste failed:', err);
            }
            return;
        }
        if (this.isEditingField()) return;

        let text = '';
        try {
            text = await readText();
        } catch (err) {
            console.warn('CsvEditor (grid) paste failed:', err);
        }
        if (!text) return;

        const rows = text.split(/\r?\n/);
        // If single cell selected, paste relative to it.
        // If range selected? Excel behavior: paste into range (tile) or just top-left?
        // Simple: Paste starting at top-left of selection.
        let startR = this.view.selection.start.r;
        let startC = this.view.selection.start.c;

        // If selection is a range, we should probably stick to functionality where we paste FROM the start cell.
        // We ignore the end of selection for paste dimension usually, unless we implement tiling.
        // Let's use Normalized Range Start.
        const header = this.view.getNormalizedRange();
        startR = header.r1;
        startC = header.c1;

        for (let i = 0; i < rows.length; i++) {
            const rowStr = rows[i];
            if (i === rows.length - 1 && !rowStr) continue; // Skip trailing newline

            const cells = rowStr.split('\t');
            for (let j = 0; j < cells.length; j++) {
                const val = cells[j];
                // Expand rows
                if (startR + i >= this.model.getRowCount()) {
                    this.model.insertRow(this.model.getRowCount());
                }
                // Expand cols?
                if (startC + j >= this.model.getColCount()) {
                    // Model doesn't support auto-expand col easily without filling others
                    // Let's Skip for now or try insertCol
                    // this.model.insertCol(this.model.getColCount());
                }
                this.model.setValue(startR + i, startC + j, val);
            }
        }
        this.view.updateData();
        this.debouncedSave();
    }

    // Read the clipboard as a TSV matrix (rows split by newline, cells by tab).
    // Returns [] when the clipboard is empty/unreadable.
    async _readClipboardMatrix() {
        let text = '';
        try {
            text = await readText();
        } catch (err) {
            console.warn('CsvEditor: clipboard read failed:', err);
        }
        if (!text) return [];
        const lines = text.split(/\r?\n/);
        // Drop a single trailing empty line from a terminal newline.
        if (lines.length && lines[lines.length - 1] === '') lines.pop();
        if (!lines.length) return [];
        return lines.map(l => l.split('\t'));
    }

    // Excel "Insert Copied Cells" for rows: insert the clipboard rows at `index`,
    // pushing existing rows down. With an empty clipboard, inserts one blank row.
    async insertCopiedRows(index) {
        if (this.mode === 'text' || this.isEditingField()) return;
        const matrix = await this._readClipboardMatrix();
        if (matrix.length) this.model.insertRows(index, matrix);
        else this.model.insertRow(index);

        const count = matrix.length || 1;
        this.view.updateData();
        this.view.cursor = { r: index, c: 0 };
        this.view.selection.start = { r: index, c: 0 };
        this.view.selection.end = { r: index + count - 1, c: this.model.getColCount() - 1 };
        this.view.refreshSelection();
        this.view.scrollToCell(index, 0);
        this.debouncedSave();
    }

    // Excel "Insert Copied Cells" for columns: insert the clipboard columns at
    // `index`, pushing existing columns right. Empty clipboard → one blank column.
    async insertCopiedCols(index) {
        if (this.mode === 'text' || this.isEditingField()) return;
        const matrix = await this._readClipboardMatrix();
        let width = 1;
        if (matrix.length) {
            width = matrix.reduce((m, r) => Math.max(m, r.length), 0) || 1;
            this.model.insertCols(index, matrix);
        } else {
            this.model.insertCol(index);
        }

        this.view.updateData();
        this.view.cursor = { r: 0, c: index };
        this.view.selection.start = { r: 0, c: index };
        this.view.selection.end = { r: this.model.getRowCount() - 1, c: index + width - 1 };
        this.view.refreshSelection();
        this.view.scrollToCell(0, index);
        this.debouncedSave();
    }

    // --- Grid search (used by the global Search panel) ---
    // Scan every cell with `pred(value)` and return the matching cell coords.
    collectCsvMatches(pred) {
        const matches = [];
        const data = this.model.getData();
        for (let r = 0; r < data.length; r++) {
            const row = data[r];
            if (!row) continue;
            for (let c = 0; c < row.length; c++) {
                const v = row[c] == null ? '' : String(row[c]);
                if (pred(v)) matches.push({ r, c });
            }
        }
        return matches;
    }

    // Select + scroll to a matched cell (Excel-style Find selects the hit).
    gotoCsvMatch(m) {
        if (this.mode !== 'grid' || !m) return;
        this.view.cursor = { r: m.r, c: m.c };
        this.view.selection.start = { r: m.r, c: m.c };
        this.view.selection.end = { r: m.r, c: m.c };
        this.view.scrollToCell(m.r, m.c);
        this.view.refreshSelection();
    }

    async handleAddRowWithPaste() {
        const { r, c } = this.view.cursor;
        const insertPos = r + 1;
        const startC = 0; // Paste copied row starting from column 0
        
        let text = '';
        try {
            text = await readText();
        } catch (err) {
            console.warn('Clipboard read failed:', err);
        }

        if (text && text.trim()) {
            const rows = text.split(/\r?\n/).filter(line => line);
            
            // Insert necessary rows
            for (let i = 0; i < rows.length; i++) {
                this.model.insertRow(insertPos + i);
                const cells = rows[i].split('\t');
                for (let j = 0; j < cells.length; j++) {
                    this.model.setValue(insertPos + i, startC + j, cells[j]);
                }
            }
            
            this.view.selection.start = { r: insertPos, c: startC };
            this.view.selection.end = { r: insertPos + rows.length - 1, c: startC + (rows[0].split('\t').length - 1) };
        } else {
            // Just insert an empty row
            this.model.insertRow(insertPos);
            this.view.selection.start = { r: insertPos, c: 0 };
            this.view.selection.end = { r: insertPos, c: this.model.getColCount() - 1 };
        }
        
        this.view.updateData();
        this.view.refreshSelection();
        this.view.scrollToCell(insertPos, c); // keep original column in view
        this.debouncedSave();
    }

    onCopy(e) {
        if (this.mode === 'text') return;
        if (this.isEditingField()) return;
        e.preventDefault();
        this.copy();
    }

    onPaste(e) {
        if (this.mode === 'text') return;
        if (this.isEditingField()) return;
        e.preventDefault();
        this.paste();
    }

    isEditingField() {
        const el = document.activeElement;
        if (!el) return false;
        // F2 / double-click editing happens in the overlay <textarea>, not in a
        // contentEditable TD any more. Without this the document-level copy /
        // paste handlers below hijacked Ctrl+C / Ctrl+V while a cell was being
        // edited and clobbered the grid selection instead of the typed text.
        if (this.overlayEditor && el === this.overlayEditor) return true;
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
        return el.isContentEditable === true;
    }

    // --- Jump ---
    startJump() {
        this.jumpState.active = true;
        this.jumpState.buffer = '';
        this.jumpDisplay.textContent = 'Jump: ';
        this.jumpDisplay.style.display = 'block';

        clearTimeout(this.jumpState.timer);
        this.jumpState.timer = setTimeout(() => {
            if (!this.jumpState.buffer) this.cancelJump(); // timeout inactivity
        }, 5000);
    }

    handleJumpInput(e) {
        e.preventDefault();
        e.stopPropagation();

        if (e.key === 'Escape') {
            this.cancelJump();
            return;
        }

        if (e.key === 'Backspace') {
            this.jumpState.buffer = this.jumpState.buffer.slice(0, -1);
            this.jumpDisplay.textContent = 'Jump: ' + this.jumpState.buffer;
        } else if (e.key.length === 1 && /[a-zA-Z0-9]/.test(e.key)) {
            this.jumpState.buffer += e.key.toUpperCase();
            this.jumpDisplay.textContent = 'Jump: ' + this.jumpState.buffer;
        }

        clearTimeout(this.jumpState.timer);
        this.jumpState.timer = setTimeout(() => this.executeJump(), 500);
    }

    executeJump() {
        const addr = this.jumpState.buffer;
        this.cancelJump(); // Close UI

        if (!addr) return;

        // Parse Logic
        const match = addr.match(/^([A-Z]+)([0-9]+)$/);
        if (!match) return;

        const colStr = match[1];
        const rowStr = match[2];

        let col = 0;
        for (let i = 0; i < colStr.length; i++) {
            col = col * 26 + (colStr.charCodeAt(i) - 64);
        }
        col -= 1;
        const row = parseInt(rowStr) - 1;

        if (row >= 0 && row < this.model.getRowCount() /* && col check */) {
            this.view.cursor = { r: row, c: col };
            this.view.selection.start = { r: row, c: col };
            this.view.selection.end = { r: row, c: col };
            this.view.refreshSelection();
            this.view.scrollToCell(row, col);
        }
    }

    cancelJump() {
        this.jumpState.active = false;
        this.jumpDisplay.style.display = 'none';
        clearTimeout(this.jumpState.timer);
    }
}

export const CsvEditor = {
    activeInstance: null,

    render(container, content, onSave) {
        if (this.activeInstance) {
            this.activeInstance.destroy(); // Cleanup previous if same module usage
            this.activeInstance = null;
        }
        this.activeInstance = new CsvController(container, content, onSave);
    }
};
