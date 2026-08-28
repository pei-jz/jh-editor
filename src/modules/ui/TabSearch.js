import { t } from '../utils/I18n.js';

export const TabSearch = {
    show(files, onSelect) {
        // Remove existing if any
        const existing = document.getElementById('tab-search-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'tab-search-overlay';
        overlay.className = 'tab-search-overlay';

        const container = document.createElement('div');
        container.className = 'tab-search-container';

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'tab-search-input';
        input.placeholder = t('Search tabs...');

        const list = document.createElement('ul');
        list.className = 'tab-search-list';

        let selectedIndex = 0;
        let filteredFiles = files.map((f, i) => ({ file: f, index: i }));

        /**
         * Redraw, and bring the selection back into view.
         *
         * The arrow keys moved the `.selected` class down the list but never
         * scrolled it, so past the sixth or seventh tab the highlight walked
         * off the bottom and the keys looked like they had stopped working.
         * `block: 'nearest'` keeps a visible row where it is instead of
         * re-centring the list on every keystroke.
         */
        const renderList = () => {
            list.innerHTML = '';
            let selectedEl = null;
            filteredFiles.forEach((item, i) => {
                const li = document.createElement('li');
                li.className = 'tab-search-item';
                if (i === selectedIndex) {
                    li.classList.add('selected');
                    selectedEl = li;
                }

                const pathStr = item.file.path || '';
                const name = pathStr ? pathStr.replace(/\\/g, '/').split('/').pop() : item.file.name || 'Untitled';
                const dir = pathStr ? pathStr.replace(/\\/g, '/').replace('/' + name, '') : '';

                li.innerHTML = `<span class="name">${name}</span><span class="dir">${dir}</span>`;
                li.onclick = () => selectAndClose(item.index);
                list.appendChild(li);
            });
            // Guarded: not every environment implements it, and a missing
            // scroll must not stop the list from rendering.
            if (selectedEl && typeof selectedEl.scrollIntoView === 'function') {
                selectedEl.scrollIntoView({ block: 'nearest' });
            }
        };

        const selectAndClose = (originalIndex) => {
            onSelect(originalIndex);
            overlay.remove();
        };

        input.addEventListener('input', () => {
            const query = input.value.toLowerCase();
            filteredFiles = files.map((f, i) => ({ file: f, index: i }))
                .filter(item => {
                    const name = item.file.name || '';
                    const path = item.file.path || '';
                    return name.toLowerCase().includes(query) || path.toLowerCase().includes(query);
                });
            selectedIndex = 0;
            renderList();
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                // `% 0` is NaN: with nothing matching, moving the selection
                // would put it somewhere that can never be rendered again.
                if (!filteredFiles.length) return;
                selectedIndex = (selectedIndex + 1) % filteredFiles.length;
                renderList();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (!filteredFiles.length) return;
                selectedIndex = (selectedIndex - 1 + filteredFiles.length) % filteredFiles.length;
                renderList();
            } else if (e.key === 'Home' || e.key === 'End') {
                // A long tab list is worth being able to jump.
                e.preventDefault();
                if (!filteredFiles.length) return;
                selectedIndex = e.key === 'Home' ? 0 : filteredFiles.length - 1;
                renderList();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (filteredFiles[selectedIndex]) {
                    selectAndClose(filteredFiles[selectedIndex].index);
                }
            } else if (e.key === 'Escape') {
                e.preventDefault();
                overlay.remove();
            }
        });

        // Close on click outside
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });

        container.appendChild(input);
        container.appendChild(list);
        overlay.appendChild(container);
        document.body.appendChild(overlay);

        renderList();
        input.focus();
    }
};
