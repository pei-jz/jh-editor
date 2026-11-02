/**
 * SettingsView — the settings screen as an editor tab.
 *
 * Settings take effect as they change, so the point of a tab is being able to see
 * the result beside them. The screen itself is one set of elements in index.html,
 * wired up once at startup (ui/SettingsModal.js) and found by id from then on. So
 * this does not build anything: it lends those elements to whichever pane is
 * showing the tab, and gives them back to their hidden home when it stops, which
 * keeps them in the document for the code that looks them up.
 */

const SECTIONS_KEY = 'settings_openSections';
const DEFAULT_OPEN_SECTIONS = ['appearance'];

let content = null;
let owner = null;

export class SettingsView {
    constructor(container) {
        // Held on to as well: a pane clears itself before drawing, which can leave
        // the elements out of the document for a moment, where no query finds them.
        content = document.querySelector('.settings-content') || content;
        this.container = container;
        // The tab can be redrawn in place, with the new view made before the old
        // one is destroyed: the elements belong to whichever came last.
        owner = this;
        if (content) container.appendChild(content);
    }

    destroy() {
        if (owner !== this) return;
        owner = null;
        const home = document.getElementById('settings-modal');
        if (content && home) home.appendChild(content);
    }
}

function readOpenSections() {
    try {
        const stored = JSON.parse(localStorage.getItem(SECTIONS_KEY));
        if (Array.isArray(stored)) return stored;
    } catch (_) { /* nothing usable stored */ }
    return DEFAULT_OPEN_SECTIONS;
}

/** The folding sections open as they were left, and remember being changed. */
export function initSettingsSections(root = document) {
    const sections = [...root.querySelectorAll('.settings-section')];
    const open = readOpenSections();
    for (const section of sections) {
        section.open = open.includes(section.dataset.section);
        section.addEventListener('toggle', () => {
            const now = sections.filter((s) => s.open).map((s) => s.dataset.section);
            try { localStorage.setItem(SECTIONS_KEY, JSON.stringify(now)); } catch (_) { /* ignore */ }
        });
    }
}
