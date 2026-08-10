import { invoke } from '@tauri-apps/api/core';

/**
 * DirDiffView — the result of comparing two folders.
 *
 * One row per differing file. Clicking a row opens the appropriate view:
 *   M  both sides exist and differ → side-by-side diff
 *   A  right only                  → open the file (it is entirely new)
 *   D  left only                   → open the file (it is entirely gone)
 *
 * The comparison itself happens in Rust (see fs::diff_directories) because it
 * has to read every file; only the resulting list crosses the IPC boundary.
 */
export class DirDiffView {
    constructor(container, file) {
        this.container = container;
        this.file = file;
        this.leftRoot = file.leftRoot;
        this.rightRoot = file.rightRoot;
        this._injectStyles();
        this.render();
        this.load();
    }

    _injectStyles() {
        if (document.getElementById('dir-diff-styles')) return;
        const style = document.createElement('style');
        style.id = 'dir-diff-styles';
        style.textContent = `
        .dd-view { height: 100%; overflow: auto; font-size: 13px; color: var(--text-color); }
        .dd-head {
            position: sticky; top: 0; z-index: 1; background: var(--bg-color);
            padding: 10px 14px; border-bottom: 1px solid var(--border-color);
            display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
        }
        .dd-roots { font-size: 11px; opacity: 0.75; font-family: var(--editor-font-family, monospace); }
        .dd-sum { display: inline-flex; gap: 10px; font-weight: 600; font-size: 12px; }
        .dd-sum .m { color: #d29922; }
        .dd-sum .a { color: #3fb950; }
        .dd-sum .d { color: #f85149; }
        .dd-filter { margin-left: auto; display: inline-flex; gap: 10px; font-size: 11px; user-select: none; }
        .dd-filter label { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
        .dd-row {
            display: flex; align-items: center; gap: 10px;
            padding: 4px 14px; cursor: pointer; white-space: nowrap;
        }
        .dd-row:hover { background: var(--hover-color); }
        .dd-badge {
            width: 16px; text-align: center; font-weight: 700; font-size: 11px;
            border-radius: 3px; flex-shrink: 0;
        }
        .dd-badge.M { color: #d29922; }
        .dd-badge.A { color: #3fb950; }
        .dd-badge.D { color: #f85149; }
        .dd-badge.S { color: var(--text-secondary); opacity: 0.6; }
        .dd-path { overflow: hidden; text-overflow: ellipsis; font-family: var(--editor-font-family, monospace); }
        .dd-row.S .dd-path { opacity: 0.55; }
        .dd-empty { padding: 24px; opacity: 0.7; text-align: center; }
        `;
        document.head.appendChild(style);
    }

    render() {
        this.container.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'dd-view';

        this.headEl = document.createElement('div');
        this.headEl.className = 'dd-head';
        root.appendChild(this.headEl);

        this.listEl = document.createElement('div');
        root.appendChild(this.listEl);

        this.container.appendChild(root);
        this.listEl.innerHTML = '<div class="dd-empty">Comparing…</div>';
        this._renderHead();
    }

    _renderHead() {
        this.headEl.innerHTML = '';
        const roots = document.createElement('div');
        roots.className = 'dd-roots';
        roots.textContent = `${this.leftRoot}  ⇄  ${this.rightRoot}`;
        roots.title = roots.textContent;

        const sum = document.createElement('div');
        sum.className = 'dd-sum';
        const e = this.entries || [];
        const n = (s) => e.filter(x => x.status === s).length;
        sum.innerHTML = `<span class="m">± ${n('M')}</span><span class="a">+ ${n('A')}</span><span class="d">− ${n('D')}</span>`;

        const filter = document.createElement('div');
        filter.className = 'dd-filter';
        const same = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!this.showSame;
        cb.onchange = () => { this.showSame = cb.checked; this.load(); };
        same.append(cb, document.createTextNode('Show identical files'));
        filter.appendChild(same);

        this.headEl.append(roots, sum, filter);
    }

    async load() {
        try {
            this.entries = await invoke('diff_directories', {
                leftRoot: this.leftRoot,
                rightRoot: this.rightRoot,
                includeSame: !!this.showSame,
            });
        } catch (err) {
            console.error('diff_directories failed', err);
            this.listEl.innerHTML = `<div class="dd-empty">Comparison failed: ${String(err && err.message ? err.message : err)}</div>`;
            return;
        }
        this._renderHead();
        this._renderList();
    }

    _renderList() {
        this.listEl.innerHTML = '';
        if (!this.entries || this.entries.length === 0) {
            this.listEl.innerHTML = '<div class="dd-empty">No differences</div>';
            return;
        }
        const frag = document.createDocumentFragment();
        for (const e of this.entries) {
            const row = document.createElement('div');
            row.className = `dd-row ${e.status}`;
            const badge = document.createElement('span');
            badge.className = `dd-badge ${e.status}`;
            badge.textContent = e.status === 'M' ? '±' : e.status === 'A' ? '+' : e.status === 'D' ? '−' : '=';
            const path = document.createElement('span');
            path.className = 'dd-path';
            path.textContent = e.path;
            path.title = e.path;
            row.append(badge, path);
            row.onclick = () => this._open(e);
            frag.appendChild(row);
        }
        this.listEl.appendChild(frag);
    }

    async _open(entry) {
        try {
            if (entry.left && entry.right) {
                await window.app.compareTwoFiles(entry.left, entry.right);
            } else {
                // One-sided: there is nothing to diff against, so just show it.
                await window.app.openFile(entry.right || entry.left, false, null, true);
            }
        } catch (err) {
            console.error('failed to open diff entry', err);
        }
    }

    destroy() {
        if (this.container) this.container.innerHTML = '';
    }

    getDiagnostics() { return []; }
}
