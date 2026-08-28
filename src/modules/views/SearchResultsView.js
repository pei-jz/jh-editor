import { State } from '../core/Store.js';

// Renders workspace grep results as an interactive tab, grouped by file, each
// match line clickable to open the file at that line. Supports STREAMING: the
// grep-match/grep-done events are owned by the MODEL (Editor.openSearchResults,
// so results keep accumulating into file.matches even while this tab isn't
// active); when active, the model calls appendMatches()/setDone() live. On
// (re)construction the view renders whatever file.matches has accumulated.
/**
 * Send the next `openFile` to the pane the results are NOT in.
 *
 * A results list is something you work THROUGH: opening each hit over the list
 * itself replaces the very thing you are walking down. With the editor split,
 * the other pane is free, so the hit lands there and the list stays put.
 *
 * No-op when there is no split — there is nowhere else to put it.
 */
function openHitInOtherPane() {
    if (!State.splitMode) return;
    State.activePane = State.activePane === 'right' ? 'left' : 'right';
}

export class SearchResultsView {
    constructor(container, file) {
        this.container = container;
        this.file = file;
        this.query = file.query || '';
        this.options = file.options || {};
        this.searchId = file.searchId;
        this.streaming = !!file.streaming;
        this.singleFile = !!file.singleFile;
        this._groups = new Map();   // path -> { linesDiv, countEl, count, dirChain }
        this._dirNodes = new Map(); // dirRel -> { childrenEl, countEl, count }
        // Collapsed state lives on the MODEL, not the view: switching tabs
        // destroys and rebuilds the view, which used to re-expand everything
        // the user had folded away.
        if (!(file._srCollapsedDirs instanceof Set)) file._srCollapsedDirs = new Set();
        if (!(file._srCollapsedFiles instanceof Set)) file._srCollapsedFiles = new Set();
        this._collapsedDirs = file._srCollapsedDirs;
        this._collapsedFiles = file._srCollapsedFiles;
        this._total = 0;
        this._done = !!file._done;
        this._truncated = !!file._truncated;
        this._injectStyles();
        this._re = this._highlighter();
        this.render();
        if (Array.isArray(file.matches) && file.matches.length) this.appendMatches(file.matches);
    }

    setDone(truncated) {
        this._done = true;
        this._truncated = !!truncated;
        this._updateHeader();
    }

    _injectStyles() {
        if (document.getElementById('search-results-styles')) return;
        const style = document.createElement('style');
        style.id = 'search-results-styles';
        style.textContent = `
        .search-results-view { height: 100%; overflow: auto; font-size: 13px; color: var(--text-color); padding: 8px 4px; }
        .sr-header { padding: 6px 12px; opacity: 0.85; position: sticky; top: 0; background: var(--bg-color); z-index: 1; display: flex; align-items: center; gap: 8px; }
        .sr-spinner { width: 12px; height: 12px; border: 2px solid var(--border-color); border-top-color: var(--primary-color); border-radius: 50%; animation: sr-spin 0.7s linear infinite; }
        @keyframes sr-spin { to { transform: rotate(360deg); } }
        /* Directory tree: each nesting level indents via padding on its children
           container, so depth is automatic. */
        .sr-dir { margin: 0; }
        .sr-dir-head { display: flex; align-items: center; gap: 6px; padding: 3px 12px; cursor: pointer; user-select: none; font-weight: 600; opacity: 0.9; }
        .sr-dir-head:hover { background: var(--hover-color); }
        .sr-dir-name { color: var(--text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .sr-dir-name::before { content: '📁'; margin-right: 5px; font-size: 11px; opacity: 0.8; }
        .sr-dir-count { opacity: 0.5; font-weight: 400; font-size: 11px; }
        .sr-dir-children { padding-left: 12px; border-left: 1px solid var(--border-color); margin-left: 6px; }
        .sr-caret { width: 10px; display: inline-block; opacity: 0.7; flex-shrink: 0; }
        .sr-file { margin: 1px 0; }
        .sr-file-head { display: flex; align-items: center; gap: 8px; padding: 3px 12px; cursor: pointer; user-select: none; font-weight: 600; }
        .sr-file-head:hover { background: var(--hover-color); }
        .sr-file-caret { width: 10px; display: inline-block; opacity: 0.7; }
        .sr-file-path { color: var(--primary-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .sr-file-count { opacity: 0.6; font-weight: 400; }
        .sr-lines { display: block; }
        .sr-line { display: flex; gap: 10px; padding: 2px 12px 2px 22px; cursor: pointer; white-space: pre; font-family: monospace; }
        .sr-line:hover { background: var(--hover-color); }
        .sr-line-no { color: var(--text-color); opacity: 0.5; min-width: 4ch; text-align: right; user-select: none; -webkit-user-select: none; }
        .sr-line-text { overflow: hidden; text-overflow: ellipsis; }
        .sr-line-text mark { background: var(--search-highlight, #ffd54f66); color: inherit; border-radius: 2px; }
        .sr-empty { padding: 20px; opacity: 0.6; }
        `;
        document.head.appendChild(style);
    }

    _relPath(p) {
        const root = String(State.currentDir || '').replace(/\\/g, '/').replace(/\/+$/, '');
        const np = String(p || '').replace(/\\/g, '/');
        if (root && np.toLowerCase().startsWith(root.toLowerCase() + '/')) return np.slice(root.length + 1);
        return np;
    }

    _highlighter() {
        const { query, options } = this;
        if (!query) return null;
        try {
            let src = options && options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (options && options.wholeWord) src = `\\b(?:${src})\\b`;
            return new RegExp(src, options && options.caseSensitive ? 'g' : 'gi');
        } catch (_) { return null; }
    }

    _renderLineText(text) {
        const span = document.createElement('span');
        span.className = 'sr-line-text';
        const re = this._re;
        if (!re) { span.textContent = text; return span; }
        re.lastIndex = 0;
        let last = 0, m, any = false;
        while ((m = re.exec(text)) !== null) {
            any = true;
            if (m.index > last) span.appendChild(document.createTextNode(text.slice(last, m.index)));
            const mark = document.createElement('mark');
            mark.textContent = m[0];
            span.appendChild(mark);
            last = m.index + m[0].length;
            if (m[0].length === 0) re.lastIndex++;
        }
        if (last < text.length) span.appendChild(document.createTextNode(text.slice(last)));
        if (!any) span.textContent = text;
        return span;
    }

    render() {
        this.container.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'search-results-view';

        this._headerEl = document.createElement('div');
        this._headerEl.className = 'sr-header';
        root.appendChild(this._headerEl);

        this._bodyEl = document.createElement('div');
        root.appendChild(this._bodyEl);

        this.container.appendChild(root);
        this._updateHeader();
    }

    _updateHeader() {
        if (!this._headerEl) return;
        this._headerEl.innerHTML = '';
        if (this.streaming && !this._done) {
            const sp = document.createElement('span');
            sp.className = 'sr-spinner';
            this._headerEl.appendChild(sp);
        }
        const txt = document.createElement('span');
        const base = `${this._total} matches in ${this._groups.size} files  —  "${this.query}"`;
        txt.textContent = (this.streaming && !this._done) ? `Searching…  ${base}`
            : (this._total === 0 ? `No results for "${this.query}"` : base)
              + (this._truncated ? ' (truncated — result limit reached)' : '');
        this._headerEl.appendChild(txt);
    }

    /** Cumulative ancestor dir paths of a dirRel, e.g. "a/b/c" → ["a","a/b","a/b/c"]. */
    _dirChain(dirRel) {
        if (!dirRel) return [];
        const parts = dirRel.split('/');
        const chain = [];
        for (let i = 0; i < parts.length; i++) chain.push(parts.slice(0, i + 1).join('/'));
        return chain;
    }

    /** Ensure the collapsible directory node for `dirRel` exists; return the
        container that its files/subdirs should be appended into. */
    _ensureDir(dirRel) {
        if (!dirRel) return this._bodyEl; // root
        const existing = this._dirNodes.get(dirRel);
        if (existing) return existing.childrenEl;

        const slash = dirRel.lastIndexOf('/');
        const parentRel = slash === -1 ? '' : dirRel.slice(0, slash);
        const name = slash === -1 ? dirRel : dirRel.slice(slash + 1);
        const parentChildren = this._ensureDir(parentRel);

        const dirDiv = document.createElement('div');
        dirDiv.className = 'sr-dir';
        const head = document.createElement('div');
        head.className = 'sr-dir-head';
        const caret = document.createElement('span');
        caret.className = 'sr-caret';
        caret.textContent = '▾';
        const nameEl = document.createElement('span');
        nameEl.className = 'sr-dir-name';
        nameEl.textContent = name;
        nameEl.title = dirRel;
        const countEl = document.createElement('span');
        countEl.className = 'sr-dir-count';
        countEl.textContent = '0';
        head.append(caret, nameEl, countEl);
        const childrenEl = document.createElement('div');
        childrenEl.className = 'sr-dir-children';
        const applyDirState = () => {
            const collapsed = this._collapsedDirs.has(dirRel);
            childrenEl.style.display = collapsed ? 'none' : 'block';
            caret.textContent = collapsed ? '▸' : '▾';
        };
        head.onclick = () => {
            if (this._collapsedDirs.has(dirRel)) this._collapsedDirs.delete(dirRel);
            else this._collapsedDirs.add(dirRel);
            applyDirState();
        };
        applyDirState();
        dirDiv.append(head, childrenEl);
        parentChildren.appendChild(dirDiv);
        this._dirNodes.set(dirRel, { childrenEl, countEl, count: 0 });
        return childrenEl;
    }

    _ensureGroup(path) {
        let g = this._groups.get(path);
        if (g) return g;

        // Split the (relative) path into its directory chain + file name so the
        // results can be browsed as a collapsible directory tree.
        const rel = this._relPath(path);
        const slash = rel.lastIndexOf('/');
        // singleFile mode: no workspace root, so an absolute path would build a
        // pointless deep tree — show just the basename at the root instead.
        const dirRel = this.singleFile ? '' : (slash === -1 ? '' : rel.slice(0, slash));
        const fileName = slash === -1 ? rel : rel.slice(slash + 1);
        const parentChildren = this._ensureDir(dirRel);

        const fileDiv = document.createElement('div');
        fileDiv.className = 'sr-file';
        const head = document.createElement('div');
        head.className = 'sr-file-head';
        const caret = document.createElement('span');
        caret.className = 'sr-file-caret';
        caret.textContent = '▾';
        const pathEl = document.createElement('span');
        pathEl.className = 'sr-file-path';
        pathEl.textContent = fileName;
        pathEl.title = path;
        const countEl = document.createElement('span');
        countEl.className = 'sr-file-count';
        countEl.textContent = '0';
        head.append(caret, pathEl, countEl);
        const linesDiv = document.createElement('div');
        linesDiv.className = 'sr-lines';
        const applyFileState = () => {
            const collapsed = this._collapsedFiles.has(path);
            linesDiv.style.display = collapsed ? 'none' : 'block';
            caret.textContent = collapsed ? '▸' : '▾';
        };
        head.onclick = () => {
            if (this._collapsedFiles.has(path)) this._collapsedFiles.delete(path);
            else this._collapsedFiles.add(path);
            applyFileState();
        };
        applyFileState();
        fileDiv.append(head, linesDiv);
        parentChildren.appendChild(fileDiv);
        g = { linesDiv, countEl, count: 0, dirChain: this._dirChain(dirRel) };
        this._groups.set(path, g);
        return g;
    }

    appendMatches(matches) {
        if (!matches || !matches.length) return;
        for (const m of matches) {
            const g = this._ensureGroup(m.path);
            const lineEl = document.createElement('div');
            lineEl.className = 'sr-line';
            const noEl = document.createElement('span');
            noEl.className = 'sr-line-no';
            noEl.textContent = String(m.line);
            lineEl.appendChild(noEl);
            lineEl.appendChild(this._renderLineText(m.text));
            // forcePlainText: grep reports line numbers, and only the plain-text
            // editor can jump to one (structure/CSV views aren't line-addressable).
            lineEl.onclick = () => {
                try {
                    openHitInOtherPane();
                    window.app.openFile(m.path, false, m.line, true);
                } catch (e) { console.warn(e); }
            };
            g.linesDiv.appendChild(lineEl);
            g.count += 1;
            g.countEl.textContent = String(g.count);
            // Roll the count up through every ancestor directory.
            for (const dirRel of g.dirChain) {
                const d = this._dirNodes.get(dirRel);
                if (d) { d.count += 1; d.countEl.textContent = String(d.count); }
            }
            this._total += 1;
        }
        this._updateHeader();
    }

    destroy() {
        // Streaming listeners live on the model (see Editor.openSearchResults),
        // not the view, so they survive tab switches — nothing to tear down here.
        if (this.container) this.container.innerHTML = '';
    }
}
