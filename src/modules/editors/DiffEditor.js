import { highlightCode, escapeHtml } from '../utils/CMHighlighter.js';
import { t } from '../utils/I18n.js';
import * as Diff from 'diff';

export class DiffEditor {
    constructor(container, originalContent, modifiedContent, filePath, onApply, options = {}) {
        this.container = container;
        // Guard against null/undefined content (e.g. created-only files whose
        // `original` is null): downstream code calls .length on both strings.
        this.originalContent = originalContent ?? '';
        this.modifiedContent = modifiedContent ?? '';
        this.filePath = filePath || '';
        this.onApply = onApply;
        // Fired on every accept/reject so the source editing file can mirror the
        // decision live (see openDiffEditor / compareWithDisk).
        this.onChange = options.onChange || null;
        // compareMode: free-form text comparison (no file to apply to). Hides the
        // Accept/Reject/Apply affordances and uses neutral pane labels.
        this.compareMode = !!options.compareMode;
        this.leftLabel = options.leftLabel || 'Original';
        this.rightLabel = options.rightLabel || 'Modified (Select to Apply)';
        this.onBack = typeof options.onBack === 'function' ? options.onBack : null;

        // Determine the language for the highlighter
        this.lang = this.filePath.split('.').pop() || 'javascript';


		
        // Ignore-whitespace toggle. Persisted so the choice survives reopening a
        // diff / restarting the app (per user request).
        this.ignoreWhitespace = localStorage.getItem('diff_ignoreWhitespace') === 'true';
        // Render spaces/tabs as visible marks (persisted the same way).
        this.showWhitespace = localStorage.getItem('diff_showWhitespace') === 'true';

        // State
        this.diffState = [];
        this.hunks = [];
        this.isSyncingLeft = false;
        this.isSyncingRight = false;
        this.modHtmlLines = [];
        this.viewMode = 'split'; // 'split' or 'inline'
        this.currentHunkIndex = -1;

        // Alt+Arrow navigation (block + inline). Bound once so destroy() can
        // detach it; scoped to events that originate while this diff is visible.
        this._boundKeyHandler = this._onKeyDown.bind(this);
        window.addEventListener('keydown', this._boundKeyHandler, true);

        this.init();
    }

    _onKeyDown(e) {
        if (!this.container || !this.container.isConnected || this.container.offsetParent === null) return;
        // If focus sits in a different editable region, let that own the keys.
        const ae = document.activeElement;
        if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') && !this.container.contains(ae)) return;

        // Ctrl+Down / Ctrl+Up: navigate between diff files (Git diff context)
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                e.stopPropagation();
                const nav = window.app && window.app._gitDiffNav;
                if (nav) {
                    if (e.key === 'ArrowDown') nav.onNextFile();
                    else nav.onPrevFile();
                }
                return;
            }
        }

        if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;

        switch (e.key) {
            case 'ArrowUp':    e.preventDefault(); e.stopPropagation(); this.navigateBlock(-1); break;
            case 'ArrowDown':  e.preventDefault(); e.stopPropagation(); this.navigateBlock(1); break;
            case 'ArrowRight': e.preventDefault(); e.stopPropagation(); this.navigateInlineCross(1); break;
            case 'ArrowLeft':  e.preventDefault(); e.stopPropagation(); this.navigateInlineCross(-1); break;
            // Alt+I: ignore whitespace when comparing. Alt+W: show whitespace.
            case 'i': case 'I': e.preventDefault(); e.stopPropagation(); this.toggleIgnoreWhitespace(); break;
            case 'w': case 'W': e.preventDefault(); e.stopPropagation(); this.toggleShowWhitespace(); break;
        }
    }

    /** Recompute the diff with/without whitespace sensitivity. */
    toggleIgnoreWhitespace() {
        this.ignoreWhitespace = !this.ignoreWhitespace;
        localStorage.setItem('diff_ignoreWhitespace', this.ignoreWhitespace ? 'true' : 'false');
        if (this.wsBtn) this.wsBtn.classList.toggle('active', this.ignoreWhitespace);
        // Recompute from source, then redraw. Accept/reject choices are keyed to
        // hunks that no longer exist, so they reset — same as reopening.
        this.diffState = this.computeLineDiff(this.originalContent, this.modifiedContent);
        this.currentHunkIndex = -1;
        this.render();
    }

    /** Show/hide the space & tab markers (pure overlay, no recompute). */
    toggleShowWhitespace() {
        this.showWhitespace = !this.showWhitespace;
        localStorage.setItem('diff_showWhitespace', this.showWhitespace ? 'true' : 'false');
        if (this.wsViewBtn) this.wsViewBtn.classList.toggle('active', this.showWhitespace);
        if (this.showWhitespace) this._applyWhitespaceMarkers();
        else this._removeWhitespaceMarkers();
    }

    destroy() {
        if (this._boundKeyHandler) {
            window.removeEventListener('keydown', this._boundKeyHandler, true);
            this._boundKeyHandler = null;
        }
    }

    async init() {
        this.container.innerHTML = '<div style="padding: 20px; color: var(--text-secondary);">Initializing Diff View and Syntax Highlighter...</div>';
        this.container.style.display = 'flex';
        this.container.style.flexDirection = 'column';
        this.container.style.height = '100%';
        this.container.style.backgroundColor = 'var(--bg-color)';
        this.container.style.padding = '0'; // Override global layout paddings
        this.container.style.overflow = 'hidden'; // Prevent outer scrollbars completely

        // Large files: skip highlighting entirely (tokenizing the whole file is the
        // dominant cost) and render escaped plain text instead. Unchanged blocks
        // are also collapsed in renderSame() to cut the DOM node count.
        const LARGE_DIFF_BYTES = 300 * 1024;
        this.plainMode = (this.originalContent.length + this.modifiedContent.length) > LARGE_DIFF_BYTES;

        let origHtml, modHtml;
        if (this.plainMode) {
            origHtml = escapeHtml(this.originalContent);
            modHtml = escapeHtml(this.modifiedContent);
        } else {
            // Synchronous, and themed by CSS rather than by picking a palette
            // here. Choosing one used to be its own bug: the default light
            // theme adds no body class, so a naive !contains('theme-light')
            // test always forced the dark palette onto a light background.
            // `tok-*` classes take their colour from the active theme, so there
            // is no palette to choose and nothing to get wrong.
            origHtml = highlightCode(this.originalContent, this.lang);
            modHtml = highlightCode(this.modifiedContent, this.lang);
        }

        this.origHtmlLines = origHtml.split('\n');
        this.modHtmlLines = modHtml.split('\n');

        this.buildUI();
        
        // Compute and Render
        this.diffState = this.computeLineDiff(this.originalContent, this.modifiedContent);
        this.render();
    }

    buildUI() {
        this.container.innerHTML = '';

        // Toolbar
        const toolbar = document.createElement('div');
        toolbar.className = 'diff-toolbar';

        const title = document.createElement('div');
        title.className = 'diff-toolbar-title';
        title.innerHTML = this.compareMode
            ? `<span><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M1 2.5A2.5 2.5 0 013.5 0h8.75a.75.75 0 01.75.75v14.5a.75.75 0 01-1.5 0v-1.5H3.5a2.5 2.5 0 01-2.5-2.5V2.5zm2.5-1A1.5 1.5 0 002 3.5v8.75c0 .828.672 1.5 1.5 1.5h8V1.5H3.5z"></path></svg></span> <strong>Comparison</strong>`
            : `<span><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M1 2.5A2.5 2.5 0 013.5 0h8.75a.75.75 0 01.75.75v14.5a.75.75 0 01-1.5 0v-1.5H3.5a2.5 2.5 0 01-2.5-2.5V2.5zm2.5-1A1.5 1.5 0 002 3.5v8.75c0 .828.672 1.5 1.5 1.5h8V1.5H3.5z"></path></svg></span> Review Changes: <strong>${this.filePath.split(/[\\/]/).pop()}</strong>`;

        const actions = document.createElement('div');
        actions.className = 'diff-toolbar-actions';

        // Optional "back to edit" affordance (used by the free-form CompareView so
        // the diff can occupy the full height while still being reversible).
        if (this.onBack) {
            const backBtn = document.createElement('button');
            backBtn.className = 'diff-btn';
            backBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="margin-right:4px;vertical-align:text-bottom"><path fill-rule="evenodd" d="M9.78 12.78a.75.75 0 01-1.06 0L4.47 8.53a.75.75 0 010-1.06l4.25-4.25a.75.75 0 011.06 1.06L6.06 8l3.72 3.72a.75.75 0 010 1.06z"></path></svg> Back to Edit';
            backBtn.onclick = () => this.onBack();
            actions.appendChild(backBtn);
        }

        // Change summary (+added / -removed / N blocks) — gives an at-a-glance
        // sense of scale before scrolling through the diff.
        this.summaryEl = document.createElement('div');
        this.summaryEl.className = 'diff-summary';
        actions.appendChild(this.summaryEl);

        const navContainer = document.createElement('div');
        navContainer.style.display = 'flex';
        navContainer.style.alignItems = 'center';
        navContainer.style.marginRight = '8px';
        navContainer.style.color = 'var(--text-secondary)';
        navContainer.style.fontSize = '12px';
        navContainer.style.gap = '4px';

        // 1. Block Navigation
        const prevBlockBtn = document.createElement('button');
        prevBlockBtn.className = 'diff-btn';
        prevBlockBtn.title = t('Previous change (Alt+Up)');
        prevBlockBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M3.22 9.78a.75.75 0 010-1.06l4.25-4.25a.75.75 0 011.06 0l4.25 4.25a.75.75 0 01-1.06 1.06L8 6.06 4.28 9.78a.75.75 0 01-1.06 0z"></path></svg>';
        prevBlockBtn.onclick = () => this.navigateBlock(-1);

        const nextBlockBtn = document.createElement('button');
        nextBlockBtn.className = 'diff-btn';
        nextBlockBtn.title = t('Next change (Alt+Down)');
        nextBlockBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M12.78 6.22a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06 0L3.22 7.28a.75.75 0 011.06-1.06L8 9.94l3.72-3.72a.75.75 0 011.06 0z"></path></svg>';
        nextBlockBtn.onclick = () => this.navigateBlock(1);

        this.blockLabel = document.createElement('span');
        this.blockLabel.style.margin = '0 4px';
        this.blockLabel.style.fontWeight = '500';
        this.blockLabel.textContent = 'Changes: 0/0';

        const divider = document.createElement('span');
        divider.style.margin = '0 6px';
        divider.style.color = 'var(--border-color)';
        divider.textContent = '|';

        // 2. Inline Navigation
        const prevInlineBtn = document.createElement('button');
        prevInlineBtn.className = 'diff-btn';
        prevInlineBtn.title = t('Previous inline change');
        prevInlineBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M9.78 12.78a.75.75 0 01-1.06 0L4.47 8.53a.75.75 0 010-1.06l4.25-4.25a.75.75 0 011.06 1.06L6.06 8l3.72 3.72a.75.75 0 010 1.06z"></path></svg>';
        prevInlineBtn.onclick = () => this.navigateInline(-1);

        const nextInlineBtn = document.createElement('button');
        nextInlineBtn.className = 'diff-btn';
        nextInlineBtn.title = t('Current inline change (F4)');
        nextInlineBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M6.22 3.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 010-1.06z"></path></svg>';
        nextInlineBtn.onclick = () => this.navigateInline(1);

        this.inlineLabel = document.createElement('span');
        this.inlineLabel.style.margin = '0 4px';
        this.inlineLabel.textContent = 'Inline: 0/0';

        navContainer.appendChild(prevBlockBtn);
        navContainer.appendChild(this.blockLabel);
        navContainer.appendChild(nextBlockBtn);
        navContainer.appendChild(divider);
        navContainer.appendChild(prevInlineBtn);
        navContainer.appendChild(this.inlineLabel);
        navContainer.appendChild(nextInlineBtn);

        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'diff-btn';
        toggleBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="margin-right:4px;vertical-align:text-bottom"><path d="M2 3.5A1.5 1.5 0 013.5 2h9A1.5 1.5 0 0114 3.5v9a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12.5v-9zM3.5 3.5v9h3.75v-9H3.5zm5.25 0v9H12.5v-9H8.75z"/></svg> Toggle View';
        toggleBtn.onclick = () => {
            this.viewMode = this.viewMode === 'split' ? 'inline' : 'split';
            this.render();
        };

        // Ignore-whitespace toggle. Recomputes the diff (not just the rendering),
        // so indentation-only churn collapses into "same" lines.
        const wsBtn = document.createElement('button');
        wsBtn.className = 'diff-btn diff-ws-btn' + (this.ignoreWhitespace ? ' active' : '');
        wsBtn.title = t('Ignore whitespace differences (indentation, trailing spaces, run length) — Alt+I');
        wsBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="margin-right:4px;vertical-align:text-bottom"><path d="M3 8.5a1 1 0 112 0 1 1 0 01-2 0zm4 0a1 1 0 112 0 1 1 0 01-2 0zm4 0a1 1 0 112 0 1 1 0 01-2 0z"/></svg> Ignore WS <span class="diff-btn-key">Alt+I</span>';
        wsBtn.onclick = () => this.toggleIgnoreWhitespace();
        this.wsBtn = wsBtn;

        // Whitespace visualisation (·  →). Purely a rendering overlay, so it can
        // be toggled without recomputing the diff or losing accept/reject state.
        const wsViewBtn = document.createElement('button');
        wsViewBtn.className = 'diff-btn diff-ws-view-btn' + (this.showWhitespace ? ' active' : '');
        wsViewBtn.title = 'Show whitespace characters (spaces / tabs) — Alt+W';
        wsViewBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="margin-right:4px;vertical-align:text-bottom"><path d="M2 11h1.5v1.5H2zm3.25 0h1.5v1.5h-1.5zm3.25 0H10v1.5H8.5zM11.75 11h1.5v1.5h-1.5z"/><path d="M2 4h8.5v1.5H2z" opacity=".55"/></svg> Show WS <span class="diff-btn-key">Alt+W</span>';
        wsViewBtn.onclick = () => this.toggleShowWhitespace();
        this.wsViewBtn = wsViewBtn;

        actions.appendChild(navContainer);
        actions.appendChild(wsBtn);
        actions.appendChild(wsViewBtn);
        actions.appendChild(toggleBtn);

        if (!this.compareMode) {
            const applyBtn = document.createElement('button');
            applyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"></path></svg> Apply & Save';
            applyBtn.className = 'diff-primary-btn';
            applyBtn.onclick = () => this.handleApply();
            actions.appendChild(applyBtn);
        }
        toolbar.appendChild(title);
        toolbar.appendChild(actions);

        // Diff Container
        const diffContainer = document.createElement('div');
        diffContainer.id = 'diff-container';

        // Left Pane (Original)
        const leftPane = document.createElement('div');
        leftPane.className = 'diff-pane original';

        // Right Pane (Modified)
        const rightPane = document.createElement('div');
        rightPane.className = 'diff-pane modified';

        const leftContent = document.createElement('div');
        leftContent.className = 'diff-content';

        const rightContent = document.createElement('div');
        rightContent.className = 'diff-content';

        leftPane.appendChild(leftContent);
        rightPane.appendChild(rightContent);

        diffContainer.appendChild(leftPane);
        diffContainer.appendChild(rightPane);

        // Minimap: a thin strip showing where every change sits in the file, so
        // the distribution is visible at a glance on long files. Click to jump.
        this.minimapEl = document.createElement('div');
        this.minimapEl.className = 'diff-minimap';
        this.minimapEl.title = t('Distribution of changes (click to jump)');
        this.minimapViewportEl = document.createElement('div');
        this.minimapViewportEl.className = 'diff-minimap-viewport';
        this.minimapEl.appendChild(this.minimapViewportEl);
        this.minimapEl.onclick = (e) => {
            if (!this._minimapScrollHeight) return;
            const rect = this.minimapEl.getBoundingClientRect();
            const ratio = (e.clientY - rect.top) / Math.max(1, rect.height);
            const pane = this.viewMode === 'inline' ? this.leftPane : this.rightPane;
            const target = ratio * this._minimapScrollHeight - pane.clientHeight / 2;
            pane.scrollTop = Math.max(0, target);
        };
        diffContainer.appendChild(this.minimapEl);

        this.container.appendChild(toolbar);
        
        // Header row
        this.headerRow = document.createElement('div');
        this.headerRow.className = 'diff-panes-header';
        this.headerRow.innerHTML = `
            <div class="diff-header-pane diff-header-left">${this.leftLabel}</div>
            <div class="diff-header-pane diff-header-right">${this.rightLabel}</div>
        `;
        this.container.appendChild(this.headerRow);
        this.container.appendChild(diffContainer);

        this.leftPane = leftPane;
        this.rightPane = rightPane;
        this.leftContent = leftContent;
        this.rightContent = rightContent;

        // Sync Scrolling
        this.setupScrollSync();
    }

    setupScrollSync() {
        this.leftPane.onscroll = () => {
            if (!this.isSyncingLeft) {
                this.isSyncingRight = true;
                this.rightPane.scrollTop = this.leftPane.scrollTop;
                this.rightPane.scrollLeft = this.leftPane.scrollLeft;
            }
            this.isSyncingLeft = false;
            this._updateMinimapViewport();
        };

        this.rightPane.onscroll = () => {
            this._updateMinimapViewport();
            if (!this.isSyncingRight) {
                this.isSyncingLeft = true;
                this.leftPane.scrollTop = this.rightPane.scrollTop;
                this.leftPane.scrollLeft = this.rightPane.scrollLeft;
            }
            this.isSyncingRight = false;
        };
    }

    computeLineDiff(original, modified) {
        const originalLines = original.split(/\r?\n/);
        const modifiedLines = modified.split(/\r?\n/);

        // When ignoring whitespace, compare lines by a normalised key (leading /
        // trailing whitespace stripped, internal runs collapsed) but keep the
        // ORIGINAL text for display. jsdiff's `comparator` does exactly this: it
        // decides equality without altering the values it hands back.
        const changes = this.ignoreWhitespace
            ? Diff.diffArrays(originalLines, modifiedLines, {
                comparator: (a, b) => this._wsKey(a) === this._wsKey(b),
            })
            : Diff.diffArrays(originalLines, modifiedLines);

        let i = 0;
        let j = 0;
        const diffStream = [];

        changes.forEach(part => {
            part.value.forEach(lineText => {
                if (part.added) {
                    diffStream.push({ type: 'add', text: lineText, lNum: null, rNum: j });
                    j++;
                } else if (part.removed) {
                    diffStream.push({ type: 'remove', text: lineText, lNum: i, rNum: null });
                    i++;
                } else {
                    diffStream.push({ type: 'same', text: lineText, lNum: i, rNum: j });
                    i++;
                    j++;
                }
            });
        });

        return diffStream;
    }

    /** Whitespace-insensitive comparison key for a line. */
    _wsKey(line) {
        return String(line).replace(/\s+/g, ' ').trim();
    }

    /**
     * Similarity of two lines in [0,1] — Dice coefficient over character
     * bigrams, which handles reordered/edited code better than prefix matching
     * and is cheap enough to run for every candidate pair in a hunk.
     */
    _lineSimilarity(a, b) {
        const s1 = this._wsKey(a);
        const s2 = this._wsKey(b);
        if (!s1.length && !s2.length) return 1;
        if (!s1.length || !s2.length) return 0;
        if (s1 === s2) return 1;
        if (s1.length < 2 || s2.length < 2) return s1 === s2 ? 1 : 0;

        const bigrams = new Map();
        for (let i = 0; i < s1.length - 1; i++) {
            const g = s1.slice(i, i + 2);
            bigrams.set(g, (bigrams.get(g) || 0) + 1);
        }
        let hits = 0;
        for (let i = 0; i < s2.length - 1; i++) {
            const g = s2.slice(i, i + 2);
            const n = bigrams.get(g) || 0;
            if (n > 0) { bigrams.set(g, n - 1); hits++; }
        }
        return (2 * hits) / (s1.length - 1 + s2.length - 1);
    }

    /**
     * Decide which removed line corresponds to which added line, and in what
     * order the rows should be laid out.
     *
     * Previously this was positional (removes[i] ↔ adds[i], and only when the
     * two sides had the *same* count), so any hunk where the line counts
     * differed lost word-level highlighting entirely and unrelated lines got
     * paired up. This runs a max-weight non-crossing matching (LCS-style DP)
     * over the similarity matrix instead, so only genuinely similar lines are
     * paired and the original order is preserved.
     *
     * @returns {Array<{remove: object|null, add: object|null}>} row plan
     */
    _planRows(removes, adds) {
        const n = removes.length, m = adds.length;
        if (n === 0 || m === 0) {
            return [
                ...removes.map(r => ({ remove: r, add: null })),
                ...adds.map(a => ({ remove: null, add: a })),
            ];
        }

        // Guard: the DP is O(n*m); fall back to positional pairing for very
        // large hunks so a pathological diff can't lock up the UI.
        const MAX_CELLS = 40000;
        if (n * m > MAX_CELLS) {
            const plan = [];
            for (let i = 0; i < Math.max(n, m); i++) {
                plan.push({ remove: removes[i] || null, add: adds[i] || null });
            }
            return plan;
        }

        const MIN_SIM = 0.5; // below this, treat the lines as unrelated
        const sim = [];
        for (let i = 0; i < n; i++) {
            sim[i] = [];
            for (let j = 0; j < m; j++) {
                const s = this._lineSimilarity(removes[i].text, adds[j].text);
                sim[i][j] = s >= MIN_SIM ? s : 0;
            }
        }

        // dp[i][j] = best total similarity pairing removes[i..] with adds[j..]
        const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
        for (let i = n - 1; i >= 0; i--) {
            for (let j = m - 1; j >= 0; j--) {
                const pair = sim[i][j] > 0 ? sim[i][j] + dp[i + 1][j + 1] : -Infinity;
                dp[i][j] = Math.max(pair, dp[i + 1][j], dp[i][j + 1]);
            }
        }

        // Backtrack into a row plan, emitting unmatched lines as one-sided rows.
        const plan = [];
        let i = 0, j = 0;
        while (i < n && j < m) {
            const pair = sim[i][j] > 0 ? sim[i][j] + dp[i + 1][j + 1] : -Infinity;
            if (pair >= dp[i + 1][j] && pair >= dp[i][j + 1]) {
                plan.push({ remove: removes[i], add: adds[j] });
                i++; j++;
            } else if (dp[i + 1][j] >= dp[i][j + 1]) {
                plan.push({ remove: removes[i], add: null });
                i++;
            } else {
                plan.push({ remove: null, add: adds[j] });
                j++;
            }
        }
        while (i < n) plan.push({ remove: removes[i++], add: null });
        while (j < m) plan.push({ remove: null, add: adds[j++] });
        return plan;
    }

    render() {
        this.leftContent.innerHTML = '';
        this.rightContent.innerHTML = '';

        if (this.viewMode === 'inline') {
            this.rightPane.style.display = 'none';
            this.headerRow.children[1].style.display = 'none';
            this.headerRow.children[0].textContent = this.compareMode ? 'Unified Diff' : 'Unified Diff (Select to Apply)';
            this.headerRow.children[0].style.borderRight = 'none';
        } else {
            this.rightPane.style.display = 'flex';
            this.headerRow.children[1].style.display = 'block';
            this.headerRow.children[0].textContent = this.leftLabel;
            this.headerRow.children[0].style.borderRight = '';
        }

        this.hunks = this.groupIntoHunks(this.diffState);
        this.changeHunks = this.hunks.filter(h => h.type !== 'same');
        this.currentHunkIndex = -1;

        this.hunks.forEach((hunk, index) => {
            if (hunk.type === 'same') {
                this.renderSame(hunk);
            } else {
                const changeHunkIndex = this.changeHunks.indexOf(hunk);
                this.renderChangeHunk(hunk, changeHunkIndex);
            }
        });

        this.updateNavLabel();
        this._updateSummary();
        this._applyWhitespaceMarkers();
        // The minimap needs final row geometry, so build it after layout.
        requestAnimationFrame(() => this._buildMinimap());

        // Auto scroll to first diff block
        if (this.changeHunks.length > 0) {
            setTimeout(() => {
                this.navigateBlock(1);
            }, 50);
        }
    }

    /** Toolbar summary: +added / -removed / N blocks. */
    _updateSummary() {
        if (!this.summaryEl) return;
        let added = 0, removed = 0;
        for (const d of (this.diffState || [])) {
            if (d.type === 'add') added++;
            else if (d.type === 'remove') removed++;
        }
        const blocks = this.changeHunks ? this.changeHunks.length : 0;
        if (added === 0 && removed === 0) {
            this.summaryEl.innerHTML = '<span class="diff-sum-none">No differences</span>';
            return;
        }
        this.summaryEl.innerHTML =
            `<span class="diff-sum-add">+${added}</span>` +
            `<span class="diff-sum-del">-${removed}</span>` +
            `<span class="diff-sum-blocks">${blocks} blocks</span>`;
        this.summaryEl.title = `${added} lines added / ${removed} lines removed / ${blocks} changed blocks`;
    }

    /**
     * Wrap spaces/tabs in marker spans so they can be seen.
     *
     * Operates on TEXT NODES only — the row HTML comes from the highlighter and must not
     * be re-parsed or string-replaced (that would corrupt the token markup and
     * shift the word-diff offsets). The span keeps the real whitespace as its
     * content and CSS paints the glyph via ::before, so column alignment and
     * copy/paste are unaffected.
     */
    _applyWhitespaceMarkers() {
        if (!this.showWhitespace) return;
        const codes = this.container.querySelectorAll('.diff-code');
        // Bound the work on huge diffs.
        const MAX_ROWS = 4000;
        let processed = 0;
        for (const code of codes) {
            if (processed++ > MAX_ROWS) break;
            if (code.dataset.wsMarked === '1') continue;
            const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
            const targets = [];
            let node;
            while ((node = walker.nextNode())) {
                if (/[ \t]/.test(node.nodeValue)) targets.push(node);
            }
            for (const textNode of targets) {
                const parts = textNode.nodeValue.split(/([ \t]+)/);
                if (parts.length < 2) continue;
                const frag = document.createDocumentFragment();
                for (const part of parts) {
                    if (!part) continue;
                    if (/^[ \t]+$/.test(part)) {
                        // One span per char so every space gets its own glyph.
                        for (const ch of part) {
                            const s = document.createElement('span');
                            s.className = 'diff-ws-mark ' + (ch === '\t' ? 'is-tab' : 'is-space');
                            s.textContent = ch;
                            frag.appendChild(s);
                        }
                    } else {
                        frag.appendChild(document.createTextNode(part));
                    }
                }
                textNode.parentNode.replaceChild(frag, textNode);
            }
            code.dataset.wsMarked = '1';
        }
    }

    /** Undo _applyWhitespaceMarkers, restoring plain text nodes. */
    _removeWhitespaceMarkers() {
        const marks = this.container.querySelectorAll('.diff-ws-mark');
        for (const m of marks) {
            m.parentNode.replaceChild(document.createTextNode(m.textContent), m);
        }
        this.container.querySelectorAll('.diff-code[data-ws-marked]').forEach(el => {
            delete el.dataset.wsMarked;
            el.normalize();
        });
    }

    /** Draw one tick per changed row, positioned proportionally to its offset. */
    _buildMinimap() {
        if (!this.minimapEl) return;
        // Drop the old ticks but keep the viewport indicator element.
        this.minimapEl.querySelectorAll('.diff-minimap-mark').forEach(el => el.remove());

        const pane = this.viewMode === 'inline' ? this.leftPane : this.rightPane;
        const content = this.viewMode === 'inline' ? this.leftContent : this.rightContent;
        if (!pane || !content) return;

        const total = content.scrollHeight || pane.scrollHeight || 0;
        this._minimapScrollHeight = total;
        if (total <= 0) { this.minimapEl.style.display = 'none'; return; }
        this.minimapEl.style.display = '';

        // Collect changed rows from BOTH panes so removals show up in split view
        // even though the right pane only holds the additions.
        const rows = [
            ...this.leftContent.querySelectorAll('.diff-line.diff-remove'),
            ...(this.viewMode === 'split' ? this.rightContent.querySelectorAll('.diff-line.diff-add') : this.leftContent.querySelectorAll('.diff-line.diff-add')),
        ];

        const frag = document.createDocumentFragment();
        for (const row of rows) {
            const top = row.offsetTop;
            const h = row.offsetHeight || 20;
            const mark = document.createElement('div');
            mark.className = 'diff-minimap-mark ' + (row.classList.contains('diff-add') ? 'is-add' : 'is-del');
            mark.style.top = `${(top / total) * 100}%`;
            mark.style.height = `${Math.max(0.4, (h / total) * 100)}%`;
            frag.appendChild(mark);
        }
        this.minimapEl.appendChild(frag);
        this._updateMinimapViewport();
    }

    /** Move the translucent "you are here" box on the minimap. */
    _updateMinimapViewport() {
        if (!this.minimapViewportEl || !this._minimapScrollHeight) return;
        const pane = this.viewMode === 'inline' ? this.leftPane : this.rightPane;
        if (!pane) return;
        const total = this._minimapScrollHeight;
        this.minimapViewportEl.style.top = `${(pane.scrollTop / total) * 100}%`;
        this.minimapViewportEl.style.height = `${Math.min(100, (pane.clientHeight / total) * 100)}%`;
    }

    updateNavLabel() {
        if (!this.changeHunks || this.changeHunks.length === 0) {
            this.blockLabel.textContent = 'Changes: 0/0';
            this.inlineLabel.textContent = 'Inline: 0/0';
            return;
        }

        const hunkDisplay = this.currentHunkIndex < 0 ? 0 : this.currentHunkIndex;
        this.blockLabel.textContent = `Changes: ${hunkDisplay + 1}/${this.changeHunks.length}`;

        const hunk = this.changeHunks[this.currentHunkIndex];
        if (!hunk || !hunk.navTargets || hunk.navTargets.length === 0) {
            this.inlineLabel.textContent = 'Inline: 0/0';
            return;
        }

        const inlineDisplay = hunk.currentInlineIndex < 0 ? 0 : hunk.currentInlineIndex;
        this.inlineLabel.textContent = `Inline: ${inlineDisplay + 1}/${hunk.navTargets.length}`;
    }

    /**
     * Focus a specific inline target (hunkIndex wraps; inlineIndex is clamped or
     * 'last'). Clears the previously focused target, applies the highlight class,
     * scrolls it into view, and refreshes the nav labels.
     */
    _setActiveTarget(hunkIndex, inlineIndex) {
        const n = this.changeHunks ? this.changeHunks.length : 0;
        if (n === 0) return;

        // Unfocus the currently active target.
        const cur = this.changeHunks[this.currentHunkIndex];
        if (cur && cur.navTargets && cur.currentInlineIndex >= 0 && cur.currentInlineIndex < cur.navTargets.length) {
            const el = cur.navTargets[cur.currentInlineIndex].element;
            if (el) el.classList.remove('diff-focus-active');
        }

        // Wrap the block index.
        hunkIndex = ((hunkIndex % n) + n) % n;
        this.currentHunkIndex = hunkIndex;
        const hunk = this.changeHunks[hunkIndex];
        const len = hunk.navTargets ? hunk.navTargets.length : 0;

        if (len === 0) {
            hunk.currentInlineIndex = -1;
            this.updateNavLabel();
            return;
        }

        if (inlineIndex === 'last') inlineIndex = len - 1;
        inlineIndex = Math.max(0, Math.min(inlineIndex, len - 1));
        hunk.currentInlineIndex = inlineIndex;

        const target = hunk.navTargets[inlineIndex];
        if (target && target.element) {
            target.element.classList.add('diff-focus-active');
            this.scrollToElement(target.element);
        }
        this.updateNavLabel();
    }

    /** Move to the next/previous diff block (Alt+Up / Alt+Down). */
    navigateBlock(direction) {
        const n = this.changeHunks ? this.changeHunks.length : 0;
        if (n === 0) return;
        const idx = this.currentHunkIndex < 0 ? (direction > 0 ? 0 : n - 1) : this.currentHunkIndex + direction;
        this._setActiveTarget(idx, 0);
    }

    /**
     * Move to the next/previous inline (word) diff. At the end of a block's inline
     * diffs, cross into the next block's first inline diff; at the start, cross
     * into the previous block's last inline diff (Alt+Right / Alt+Left).
     */
    navigateInlineCross(direction) {
        const n = this.changeHunks ? this.changeHunks.length : 0;
        if (n === 0) return;
        if (this.currentHunkIndex < 0) { this.navigateBlock(direction > 0 ? 1 : -1); return; }

        const hunk = this.changeHunks[this.currentHunkIndex];
        const len = hunk && hunk.navTargets ? hunk.navTargets.length : 0;
        const next = (hunk ? hunk.currentInlineIndex : 0) + direction;

        if (len === 0 || next < 0) {
            // Cross to the previous block, landing on its last inline diff.
            this._setActiveTarget(this.currentHunkIndex - 1, 'last');
        } else if (next >= len) {
            // Cross to the next block, landing on its first inline diff.
            this._setActiveTarget(this.currentHunkIndex + 1, 0);
        } else {
            this._setActiveTarget(this.currentHunkIndex, next);
        }
    }

    // Backwards-compatible alias (kept for any external callers).
    navigateInline(direction) {
        this.navigateInlineCross(direction);
    }

    scrollToElement(element) {
        if (!element) return;
        const pane = element.closest('.diff-pane');
        if (pane) {
            const paneRect = pane.getBoundingClientRect();
            const elemRect = element.getBoundingClientRect();
            const relativeTop = elemRect.top - paneRect.top + pane.scrollTop;
            const targetScrollTop = relativeTop - (paneRect.height / 2) + (elemRect.height / 2);
            
            pane.scrollTo({
                top: targetScrollTop,
                behavior: 'smooth'
            });
        } else {
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    groupIntoHunks(diffStream) {
        const hunks = [];
        let currentHunk = null;

        diffStream.forEach(item => {
            if (item.type === 'same') {
                if (currentHunk) {
                    hunks.push(currentHunk);
                    currentHunk = null;
                }
                if (hunks.length > 0 && hunks[hunks.length - 1].type === 'same') {
                    hunks[hunks.length - 1].lines.push(item);
                } else {
                    hunks.push({ type: 'same', lines: [item] });
                }
            } else {
                if (!currentHunk) {
                    currentHunk = { type: 'change', lines: [item], accepted: true };
                } else {
                    currentHunk.lines.push(item);
                }
            }
        });
        if (currentHunk) hunks.push(currentHunk);
        return hunks;
    }

    renderSame(hunk) {
        // Collapse long unchanged runs: keep a few context lines at each edge and
        // hide the middle behind an expandable gap. This is the main win for big
        // files, which are mostly unchanged lines — rendering every one is what
        // makes the diff heavy.
        const CONTEXT = 3;
        const COLLAPSE_MIN = 20; // only collapse blocks big enough to matter
        const lines = hunk.lines;

        if (lines.length <= CONTEXT * 2 + COLLAPSE_MIN) {
            lines.forEach(item => this._appendSameRow(item));
            return;
        }

        for (let k = 0; k < CONTEXT; k++) this._appendSameRow(lines[k]);
        this._appendCollapsedGap(lines.slice(CONTEXT, lines.length - CONTEXT));
        for (let k = lines.length - CONTEXT; k < lines.length; k++) this._appendSameRow(lines[k]);
    }

    _appendSameRow(item) {
        const htmlText = this.origHtmlLines[item.lNum] !== undefined ? this.origHtmlLines[item.lNum] : item.text;
        if (this.viewMode === 'inline') {
            this.leftContent.appendChild(this.createRow(item.lNum + 1, htmlText, true));
        } else {
            this.leftContent.appendChild(this.createRow(item.lNum + 1, htmlText, true));
            this.rightContent.appendChild(this.createRow(item.rNum + 1, htmlText, true));
        }
    }

    _appendCollapsedGap(hidden) {
        const makeGap = () => {
            const row = document.createElement('div');
            row.className = 'diff-line diff-collapsed-gap';
            row.style.cssText = 'cursor:pointer; background:var(--bg-color-secondary, rgba(127,127,127,0.08)); color:var(--text-secondary);';
            row.innerHTML = `<div class="diff-gutter">⋯</div><div class="diff-code" style="font-size:12px; opacity:0.8;">⋯ expand ${hidden.length} lines ⋯</div>`;
            return row;
        };
        const gapL = makeGap();
        let gapR = null;
        if (this.viewMode === 'inline') {
            this.leftContent.appendChild(gapL);
        } else {
            gapR = makeGap();
            this.leftContent.appendChild(gapL);
            this.rightContent.appendChild(gapR);
        }

        // Expand in place (insert the hidden rows before the gap on both panes,
        // then remove the gaps). This does not re-render, so accept/reject
        // decisions and scroll sync are preserved.
        const expand = () => {
            hidden.forEach(item => {
                const htmlText = this.origHtmlLines[item.lNum] !== undefined ? this.origHtmlLines[item.lNum] : item.text;
                if (this.viewMode === 'inline') {
                    this.leftContent.insertBefore(this.createRow(item.lNum + 1, htmlText, true), gapL);
                } else {
                    this.leftContent.insertBefore(this.createRow(item.lNum + 1, htmlText, true), gapL);
                    this.rightContent.insertBefore(this.createRow(item.rNum + 1, htmlText, true), gapR);
                }
            });
            gapL.remove();
            if (gapR) gapR.remove();
        };
        gapL.onclick = expand;
        if (gapR) gapR.onclick = expand;
    }

    renderChangeHunk(hunk, index) {
        hunk.navTargets = [];
        hunk.currentInlineIndex = -1;
        hunk.hunkIndex = index;

        const hunkContainerL = document.createElement('div');
        hunkContainerL.className = 'diff-hunk-container ' + (hunk.accepted ? 'accepted' : 'rejected');

        let hunkContainerR = null;
        if (this.viewMode === 'split') {
            hunkContainerR = document.createElement('div');
            hunkContainerR.className = 'diff-hunk-container ' + (hunk.accepted ? 'accepted' : 'rejected');
        }

        const removes = hunk.lines.filter(l => l.type === 'remove');
        const adds = hunk.lines.filter(l => l.type === 'add');
        
        // Pair up changed lines by SIMILARITY (not position) and compute
        // *word-level* diff regions for each pair, so only the words that
        // actually changed are highlighted — and so hunks whose two sides have
        // different line counts still get word-level highlighting.
        const rowPlan = this._planRows(removes, adds);
        const pairs = new Map();
        for (const row of rowPlan) {
            if (!row.remove || !row.add) continue;
            const { removeRegions, addRegions } = this.computeWordRegions(row.remove.text, row.add.text);
            pairs.set(row.remove, removeRegions);
            pairs.set(row.add, addRegions);
        }

        if (this.viewMode === 'inline') {
            let currentAddBlock = null;
            let currentRemoveBlock = null;

            hunk.lines.forEach(item => {
                if (item.type === 'remove') {
                    let htmlText = this.origHtmlLines[item.lNum] !== undefined ? this.origHtmlLines[item.lNum] : item.text;
                    if (pairs.has(item)) {
                        htmlText = this._applyRegions(htmlText, pairs.get(item), 'diff-word-remove');
                    }
                    const rowL = this.createRow(item.lNum + 1, htmlText, true, 'diff-remove');
                    hunkContainerL.appendChild(rowL);

                    currentAddBlock = null;
                    const wordRemoves = pairs.has(item) ? Array.from(rowL.querySelectorAll('.diff-word-remove')) : [];
                    if (wordRemoves.length > 0) {
                        currentRemoveBlock = null;
                        wordRemoves.forEach(span => hunk.navTargets.push({ element: span, type: 'word', hunkIndex: index }));
                    } else if (!currentRemoveBlock) {
                        currentRemoveBlock = rowL;
                        hunk.navTargets.push({ element: rowL, type: 'block', hunkIndex: index });
                    }
                } else if (item.type === 'add') {
                    let htmlText = this.modHtmlLines[item.rNum] !== undefined ? this.modHtmlLines[item.rNum] : item.text;
                    if (pairs.has(item)) {
                        htmlText = this._applyRegions(htmlText, pairs.get(item), 'diff-word-add');
                    }
                    const row = this.createRow(item.rNum + 1, htmlText, true, 'diff-add');
                    hunkContainerL.appendChild(row);

                    currentRemoveBlock = null;
                    const wordAdds = pairs.has(item) ? Array.from(row.querySelectorAll('.diff-word-add')) : [];
                    if (wordAdds.length > 0) {
                        currentAddBlock = null;
                        wordAdds.forEach(span => hunk.navTargets.push({ element: span, type: 'word', hunkIndex: index }));
                    } else if (!currentAddBlock) {
                        currentAddBlock = row;
                        hunk.navTargets.push({ element: row, type: 'block', hunkIndex: index });
                    }
                }
            });
        } else {
            let currentAddBlock = null;
            let currentRemoveBlock = null;

            for (const planRow of rowPlan) {
                const removeItem = planRow.remove;
                const addItem = planRow.add;

                let rowL = null;
                let rowR = null;

                if (removeItem) {
                    let htmlText = this.origHtmlLines[removeItem.lNum] !== undefined ? this.origHtmlLines[removeItem.lNum] : removeItem.text;
                    if (pairs.has(removeItem)) {
                        htmlText = this._applyRegions(htmlText, pairs.get(removeItem), 'diff-word-remove');
                    }
                    rowL = this.createRow(removeItem.lNum + 1, htmlText, true, 'diff-remove');
                    hunkContainerL.appendChild(rowL);
                } else {
                    rowL = this.createRow('', '', false, 'empty-line');
                    hunkContainerL.appendChild(rowL);
                }

                if (addItem) {
                    let htmlText = this.modHtmlLines[addItem.rNum] !== undefined ? this.modHtmlLines[addItem.rNum] : addItem.text;
                    if (pairs.has(addItem)) {
                        htmlText = this._applyRegions(htmlText, pairs.get(addItem), 'diff-word-add');
                    }
                    rowR = this.createRow(addItem.rNum + 1, htmlText, true, 'diff-add');
                    hunkContainerR.appendChild(rowR);
                } else {
                    rowR = this.createRow('', '', false, 'empty-line');
                    hunkContainerR.appendChild(rowR);
                }

                const isReplace = removeItem && addItem;
                const isAdd = !removeItem && addItem;
                const isRemove = removeItem && !addItem;

                if (isReplace) {
                    currentAddBlock = null;
                    currentRemoveBlock = null;
                    // One nav stop per changed word (prefer the modified side). Falls
                    // back to a whole-line stop only when no word-level change was
                    // detected (e.g. whitespace-only differences).
                    const wordAdds = Array.from(rowR.querySelectorAll('.diff-word-add'));
                    const wordRemoves = Array.from(rowL.querySelectorAll('.diff-word-remove'));
                    if (wordAdds.length > 0) {
                        wordAdds.forEach(span => hunk.navTargets.push({ element: span, type: 'word', hunkIndex: index }));
                    } else if (wordRemoves.length > 0) {
                        wordRemoves.forEach(span => hunk.navTargets.push({ element: span, type: 'word', hunkIndex: index }));
                    } else {
                        hunk.navTargets.push({ element: rowR, type: 'line', hunkIndex: index });
                    }
                } else if (isAdd) {
                    currentRemoveBlock = null;
                    if (!currentAddBlock) {
                        currentAddBlock = rowR;
                        hunk.navTargets.push({ element: rowR, type: 'block', hunkIndex: index });
                    }
                } else if (isRemove) {
                    currentAddBlock = null;
                    if (!currentRemoveBlock) {
                        currentRemoveBlock = rowL;
                        hunk.navTargets.push({ element: rowL, type: 'block', hunkIndex: index });
                    }
                }
            }
        }

        const actionBar = document.createElement('div');
        actionBar.className = 'diff-action-bar';

        const updateUI = () => {
            if (hunk.accepted) {
                hunkContainerL.classList.remove('rejected');
                hunkContainerL.classList.add('accepted');
                if (hunkContainerR) {
                    hunkContainerR.classList.remove('rejected');
                    hunkContainerR.classList.add('accepted');
                }
            } else {
                hunkContainerL.classList.remove('accepted');
                hunkContainerL.classList.add('rejected');
                if (hunkContainerR) {
                    hunkContainerR.classList.remove('accepted');
                    hunkContainerR.classList.add('rejected');
                }
            }
            acceptBtn.className = hunk.accepted ? 'diff-btn accept-btn active' : 'diff-btn accept-btn';
            rejectBtn.className = !hunk.accepted ? 'diff-btn reject-btn active' : 'diff-btn reject-btn';
        };

        const acceptBtn = document.createElement('button');
        acceptBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="margin-right:4px; vertical-align:text-top;"><path fill-rule="evenodd" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"></path></svg> Accept';
        acceptBtn.className = 'diff-btn accept-btn';
        acceptBtn.onclick = () => { hunk.accepted = true; updateUI(); this._fireChange(); };

        const rejectBtn = document.createElement('button');
        rejectBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="margin-right:4px; vertical-align:text-top;"><path fill-rule="evenodd" d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"></path></svg> Reject';
        rejectBtn.className = 'diff-btn reject-btn';
        rejectBtn.onclick = () => { hunk.accepted = false; updateUI(); this._fireChange(); };

        actionBar.appendChild(acceptBtn);
        actionBar.appendChild(rejectBtn);

        // Free-form comparison has no file to apply to — skip the Accept/Reject bar.
        if (!this.compareMode) {
            const actionRow = document.createElement('div');
            actionRow.className = 'diff-hunk-actions';
            actionRow.appendChild(actionBar);

            if (this.viewMode === 'split') {
                hunkContainerR.insertBefore(actionRow, hunkContainerR.firstChild);
                // The action bar only exists on the right, yet it occupies
                // vertical space — without an equally tall counterpart on the
                // left the panes drift apart a little at EVERY hunk.
                // A same-class empty div is not enough: with border-box the
                // empty box collapses to min-height (28px) while the real one is
                // padding + the 28px bar = 30px. Cloning the whole row and
                // hiding it guarantees identical geometry, whatever the CSS.
                const spacer = actionRow.cloneNode(true);
                spacer.classList.add('diff-hunk-actions-spacer');
                spacer.setAttribute('aria-hidden', 'true');
                hunkContainerL.insertBefore(spacer, hunkContainerL.firstChild);
            } else {
                hunkContainerL.insertBefore(actionRow, hunkContainerL.firstChild);
            }
        }

        if (this.viewMode === 'split') {
            this.rightContent.appendChild(hunkContainerR);
        }

        this.leftContent.appendChild(hunkContainerL);

        updateUI();
    }

    createRow(num, textOrHtml, isHtml = false, className = '') {
        const row = document.createElement('div');
        row.className = 'diff-line ' + className;

        const gutter = document.createElement('div');
        gutter.className = 'diff-gutter';
        // Show colored +/- sign for add/remove lines alongside the line number
        if (className.includes('diff-add')) {
            const sign = document.createElement('span');
            sign.className = 'diff-gutter-sign diff-sign-add';
            sign.textContent = '+';
            gutter.appendChild(sign);
            const numEl = document.createElement('span');
            numEl.className = 'diff-gutter-num';
            numEl.textContent = num || '';
            gutter.appendChild(numEl);
        } else if (className.includes('diff-remove')) {
            const sign = document.createElement('span');
            sign.className = 'diff-gutter-sign diff-sign-remove';
            sign.textContent = '\u2212';
            gutter.appendChild(sign);
            const numEl = document.createElement('span');
            numEl.className = 'diff-gutter-num';
            numEl.textContent = num || '';
            gutter.appendChild(numEl);
        } else {
            gutter.textContent = num || '';
        }

        const code = document.createElement('div');
        code.className = 'diff-code';
        
        // Left over from shiki, which wrapped each line in <span class="line">.
        // CMHighlighter emits the token spans directly, so this now matches
        // nothing — kept because a line that IS exactly one such span (from an
        // older cached render) should still unwrap rather than show the markup.
        let finalHtml = textOrHtml || ' ';
        if (isHtml && typeof textOrHtml === 'string') {
            const match = textOrHtml.match(/^<span class="line">(.*)<\/span>$/);
            if (match) {
                finalHtml = match[1] || ' ';
            }
        }

        if (isHtml) {
            code.innerHTML = finalHtml;
        } else {
            code.textContent = finalHtml;
        }

        row.appendChild(gutter);
        row.appendChild(code);
        return row;
    }

    // Merge the current accept/reject decisions into the resulting text:
    // accepted hunks contribute their added lines, rejected hunks keep the
    // original (removed) lines, unchanged hunks pass through.
    getMergedContent() {
        const finalContent = [];
        this.hunks.forEach(hunk => {
            if (hunk.type === 'same') {
                hunk.lines.forEach(line => finalContent.push(line.text));
            } else if (hunk.accepted) {
                hunk.lines.forEach(line => { if (line.type === 'add') finalContent.push(line.text); });
            } else {
                hunk.lines.forEach(line => { if (line.type === 'remove') finalContent.push(line.text); });
            }
        });
        return finalContent.join('\n');
    }

    handleApply() {
        if (!this.onApply) return;
        this.onApply(this.getMergedContent());
    }

    // Notify the host (e.g. the source editing tab) whenever an accept/reject
    // decision changes, so the edited file gets the feedback live.
    _fireChange() {
        if (typeof this.onChange === 'function') this.onChange(this.getMergedContent(), this.hasRejections());
    }

    /** Return true when at least one change hunk has been rejected. */
    hasRejections() {
        if (!this.hunks) return false;
        return this.hunks.some(h => h.type !== 'same' && !h.accepted);
    }

    getDiagnostics() {
        return [];
    }

    /**
     * Word-level diff between two line strings. Returns character ranges (in each
     * line's own text) that actually changed, so highlighting marks only the
     * changed words and unchanged tokens are neither highlighted nor counted.
     */
    computeWordRegions(origTxt, modTxt) {
        // Always diffWordsWithSpace: its parts concatenate back to the exact
        // inputs, which is what the offset arithmetic below relies on.
        // (diffWords normalises whitespace, so the running offsets drift and the
        // highlight lands on the wrong characters.) To honour "ignore
        // whitespace" we instead drop regions that are purely whitespace.
        const parts = Diff.diffWordsWithSpace(origTxt, modTxt);
        const removeRegions = [];
        const addRegions = [];
        const skip = (v) => this.ignoreWhitespace && /^\s*$/.test(v);
        let oi = 0, mi = 0;
        for (const p of parts) {
            const len = p.value.length;
            if (p.added) {
                if (!skip(p.value)) addRegions.push({ start: mi, length: len });
                mi += len;
            } else if (p.removed) {
                if (!skip(p.value)) removeRegions.push({ start: oi, length: len });
                oi += len;
            } else {
                oi += len;
                mi += len;
            }
        }
        return { removeRegions, addRegions };
    }

    /** Wrap every region (non-overlapping char ranges) in a highlight span. */
    _applyRegions(htmlText, regions, className) {
        if (!regions || regions.length === 0) return htmlText;
        // Span insertion never changes textContent length, so the char offsets of
        // other (non-overlapping) regions stay valid regardless of order.
        for (const r of regions) {
            htmlText = this.applyInlineHighlightToHtml(htmlText, r.start, r.length, className);
        }
        return htmlText;
    }

    applyInlineHighlightToHtml(htmlText, startIdx, length, className) {
        if (length <= 0 || !htmlText) return htmlText;
        // Optimization: if it doesn't look like html, just slice it
        if (!htmlText.includes('<')) {
            return htmlText.substring(0, startIdx) + 
                   `<span class="${className}">${htmlText.substring(startIdx, startIdx + length)}</span>` + 
                   htmlText.substring(startIdx + length);
        }

        const temp = document.createElement('div');
        temp.innerHTML = htmlText;
        
        // Use standard DOM TreeWalker to find text nodes
        const walker = document.createTreeWalker(temp, 4 /* NodeFilter.SHOW_TEXT */, null, false);
        let node;
        let currentIdx = 0;
        const nodesToWrap = [];

        while ((node = walker.nextNode())) {
            const nodeLen = node.nodeValue.length;
            const nodeStart = currentIdx;
            const nodeEnd = currentIdx + nodeLen;

            const overlapStart = Math.max(nodeStart, startIdx);
            const overlapEnd = Math.min(nodeEnd, startIdx + length);

            if (overlapStart < overlapEnd) {
                nodesToWrap.push({
                    node,
                    startOffset: overlapStart - nodeStart,
                    endOffset: overlapEnd - nodeStart
                });
            }
            currentIdx += nodeLen;
        }

        // Process in reverse to avoid messing up offsets when splitting a single node
        for (let i = nodesToWrap.length - 1; i >= 0; i--) {
            const item = nodesToWrap[i];
            let targetNode = item.node;
            
            if (item.endOffset < targetNode.nodeValue.length) {
                targetNode.splitText(item.endOffset);
            }
            if (item.startOffset > 0) {
                targetNode = targetNode.splitText(item.startOffset);
            }
            
            const wrapper = document.createElement('span');
            wrapper.className = className;
            targetNode.parentNode.insertBefore(wrapper, targetNode);
            wrapper.appendChild(targetNode);
        }

        return temp.innerHTML;
    }
}
