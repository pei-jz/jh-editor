import { inlineHtml, inlineText } from '../utils/MarkdownInline.js';

/** Escape a cell value for insertion into the generated HTML table. */
function esc(v) {
    return String(v == null ? '' : v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** Read #rgb, #rgba, #rrggbb, #rrggbbaa or rgb()/rgba(). Null for anything else. */
function parseColor(value) {
    const text = String(value || '').trim().toLowerCase();
    const hex = text.match(/^#([0-9a-f]{3,8})$/);
    if (hex && hex[1].length !== 5 && hex[1].length !== 7) {
        const h = hex[1].length < 6 ? [...hex[1]].map((d) => d + d).join('') : hex[1];
        const at = (i) => parseInt(h.slice(i, i + 2), 16);
        return { r: at(0), g: at(2), b: at(4), a: h.length === 8 ? at(6) / 255 : 1 };
    }
    const fn = text.match(/^rgba?\(([^)]+)\)$/);
    if (fn) {
        const parts = fn[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
        if (parts.length >= 3 && parts.every(Number.isFinite)) {
            return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
        }
    }
    return null;
}

const toHex = ({ r, g, b }) => '#' + [r, g, b]
    .map((n) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0'))
    .join('');

/** Paint `top` over the opaque `under` at the given strength. */
const mix = (top, under, a) => ({
    r: top.r * a + under.r * (1 - a),
    g: top.g * a + under.g * (1 - a),
    b: top.b * a + under.b * (1 - a),
});

/**
 * The border as a solid colour that can be seen on the cell.
 *
 * Most themes draw their borders as a faint rgba(): fine on screen, nothing in
 * a spreadsheet, whose own gridlines are darker than the result. So too close
 * to the background means the border gets drawn stronger rather than faithfully.
 */
function visibleBorder(value, bg) {
    const under = parseColor(bg) || { r: 255, g: 255, b: 255 };
    const c = parseColor(value);
    const brightness = ({ r, g, b }) => (r + g + b) / 3;
    const solid = c ? mix(c, under, c.a) : null;
    if (solid && Math.abs(brightness(solid) - brightness(under)) >= 64) return toHex(solid);
    const ink = brightness(under) >= 128 ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
    return toHex(mix(ink, under, 0.35));
}

/**
 * Resolve the current theme's table colours to literal, opaque values.
 *
 * The clipboard leaves the app, so `var(--border-color)` means nothing on the
 * other side — Excel needs the colour itself, and it does not do transparency.
 */
function themeTableColors() {
    const fallback = {
        headerBg: '#f2f2f2', bg: '#ffffff', text: '#111111', border: '#a6a6a6',
    };
    try {
        const cs = getComputedStyle(document.body);
        const v = (name) => (cs.getPropertyValue(name) || '').trim();
        const over = (value, under, alt) => {
            const c = parseColor(value);
            return c ? toHex(mix(c, parseColor(under), c.a)) : alt;
        };
        const bg = over(v('--bg-color'), '#ffffff', fallback.bg);
        return {
            headerBg: over(v('--table-header-bg'), bg, fallback.headerBg),
            bg,
            text: over(v('--text-color'), bg, fallback.text),
            border: visibleBorder(v('--border-color'), bg),
        };
    } catch (_) {
        return fallback;
    }
}

/**
 * Reading and writing Markdown tables, and the forms a table takes on its way
 * to another program (tab-separated text, a styled HTML table).
 *
 * The F2 modal's cell grid used to live here too. Tables are edited in the
 * Markdown view itself now (views/MarkdownTableEdit.js), so it is gone.
 */
export const TableEditor = {
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
     *
     * `opts.formatted` reads each cell's Markdown, so `**a**` arrives as bold.
     * Without it the cell's text is kept exactly as written.
     */
    toHtml(data, opts = {}) {
        if (!Array.isArray(data) || !data.length) return '';
        const c = themeTableColors();
        const cell = opts.formatted ? inlineHtml : esc;
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

        // `opts.header === false`: a range cut out of the body has no header row.
        if (opts.header === false) {
            const rows = data.map((row) =>
                '<tr>' + (row || []).map((v) =>
                    `<td style="${cellBase}background-color:${c.bg};">${cell(v)}</td>`
                ).join('') + '</tr>'
            ).join('');
            return `<table style="border-collapse:collapse;"><tbody>${rows}</tbody></table>`;
        }

        const head = (data[0] || []).map((v) =>
            `<th style="${cellBase}background-color:${c.headerBg};font-weight:bold;text-align:center;">${cell(v)}</th>`
        ).join('');

        const body = data.slice(1).map((row) =>
            '<tr>' + (row || []).map((v) =>
                `<td style="${cellBase}background-color:${c.bg};">${cell(v)}</td>`
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
     * This is the table going to another program, so what it carries is what
     * the cells say, not their Markdown. Copying cells to paste back inside the
     * editor goes through the `copy` handler instead, which keeps the source.
     *
     * @returns {Promise<boolean>} whether anything reached the clipboard
     */
    async copyToClipboard(data, range = null) {
        const text = this.toTsv(
            (Array.isArray(data) ? data : []).map((row) => (row || []).map(inlineText)),
            range,
        );
        const html = this.toHtml(
            range
                ? data.slice(range.r1, range.r2 + 1).map((row) => row.slice(range.c1, range.c2 + 1))
                : data,
            { formatted: true },
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

    // Parse markdown string to 2D array.
    //
    // `\|` is a pipe INSIDE a cell, not a column break: splitting on every
    // pipe cut such a cell in two and shifted the rest of the row. The
    // separator row's colons (:--, --:, :-:) are the columns' alignment; they
    // ride along on the array as `data.align` so serialize() can write them
    // back instead of resetting every column to the default.
    parse(text) {
        const lines = text.trim().split('\n');
        const data = [];
        let align = null;

        lines.forEach((line, i) => {
            const trimmed = line.trim();
            // Skip separator line
            if (i === 1 && this.isSeparatorLine(trimmed)) {
                align = this._splitRow(trimmed).map((c) => {
                    const t = c.trim();
                    const l = t.startsWith(':');
                    const r = t.endsWith(':');
                    return l && r ? 'center' : r ? 'right' : l ? 'left' : null;
                });
                return;
            }

            data.push(this._splitRow(trimmed).map(cell => cell.trim()));
        });

        if (align && align.some(Boolean)) data.align = align;
        return data;
    },

    /** Cells of one table row: outer pipes dropped, `\|` kept inside its cell. */
    _splitRow(trimmed) {
        let cleanLine = trimmed;
        if (cleanLine.startsWith('|')) {
            cleanLine = cleanLine.substring(1);
        }
        if (cleanLine.endsWith('|') && !cleanLine.endsWith('\\|')) {
            cleanLine = cleanLine.substring(0, cleanLine.length - 1);
        }
        return cleanLine.split(/(?<!\\)\|/);
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

        // Separator, with each column's alignment as it was read.
        const align = Array.isArray(data.align) ? data.align : [];
        const separator = widths.map((w, i) => {
            const a = align[i];
            if (a === 'center') return ':' + '-'.repeat(Math.max(1, w - 2)) + ':';
            if (a === 'left') return ':' + '-'.repeat(Math.max(1, w - 1));
            if (a === 'right') return '-'.repeat(Math.max(1, w - 1)) + ':';
            return '-'.repeat(w);
        }).join(' | ');
        md += '| ' + separator + ' |\n';

        // Body
        for (let i = 1; i < data.length; i++) {
            md += formatRow(data[i]) + '\n';
        }

        return md.trim();
    }
};
