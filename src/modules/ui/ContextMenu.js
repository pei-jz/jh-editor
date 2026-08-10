
export const ContextMenu = {
    element: null,

    init() {
        // Create the menu element if it doesn't exist
        if (!this.element) {
            this.element = document.createElement('div');
            this.element.id = 'context-menu';
            this.element.style.display = 'none';
            document.body.appendChild(this.element);

            // Close on any mousedown outside (Use capture to catch before stopPropagation)
            window.addEventListener('mousedown', (e) => {
                if (this.element && this.element.contains(e.target)) return;
                this.hide();
            }, { capture: true });

            this.element.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
            }); // Don't hide if right clicking ON the menu itself (or maybe we should?)
        }
    },

    /**
     * @param {MouseEvent} event 
     * @param {Array<{label: string, action: Function}>} items 
     */
    show(event, items) {
        event.preventDefault();
        event.stopPropagation();
        this.init(); // Ensure init

        this.element.innerHTML = '';
        this.renderItems(this.element, items);

        // Position
        this.element.style.display = 'block';
        this.element.style.left = `${event.pageX}px`;
        this.element.style.top = `${event.pageY}px`;

        // Adjust if off-screen (basic)
        const rect = this.element.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            this.element.style.left = `${window.innerWidth - rect.width - 5}px`;
        }
        if (rect.bottom > window.innerHeight) {
            this.element.style.top = `${window.innerHeight - rect.height - 5}px`;
        }
    },

    renderItems(container, items) {
        items.forEach(item => {
            if (item.type === 'separator') {
                const hr = document.createElement('div');
                hr.className = 'context-menu-separator';
                hr.style.borderTop = '1px solid var(--border-color)';
                hr.style.margin = '4px 0';
                container.appendChild(hr);
                return;
            }

            const div = document.createElement('div');
            div.className = 'context-menu-item';
            div.textContent = item.label;

            if (item.submenu) {
                div.classList.add('has-submenu');
                const arrow = document.createElement('span');
                arrow.textContent = ' ▶';
                arrow.style.float = 'right';
                arrow.style.fontSize = '10px';
                arrow.style.marginTop = '4px';
                div.appendChild(arrow);

                const subContainer = document.createElement('div');
                subContainer.className = 'context-menu-submenu';
                // Inline styles for simplicity to ensure it works without complex CSS coupling
                subContainer.style.position = 'absolute';
                subContainer.style.display = 'none';
                subContainer.style.background = 'var(--bg-color)';
                subContainer.style.border = '1px solid var(--border-color)';
                subContainer.style.boxShadow = '0 2px 10px rgba(0,0,0,0.2)';
                subContainer.style.zIndex = '10000';
                subContainer.style.minWidth = '150px';
                subContainer.style.padding = '4px 0';
                subContainer.style.borderRadius = '4px';
                subContainer.style.userSelect = 'none';
                subContainer.style.webkitUserSelect = 'none';

                this.renderItems(subContainer, item.submenu);
                div.appendChild(subContainer);

                // JS Position adjustment on hover
                div.style.position = 'relative'; // Anchor
                div.addEventListener('mouseenter', () => {
                    subContainer.style.display = 'block';
                    const rect = div.getBoundingClientRect();
                    const subRect = subContainer.getBoundingClientRect();

                    subContainer.style.top = '0px';

                    // Check right edge
                    if (rect.right + subRect.width > window.innerWidth) {
                        subContainer.style.left = 'auto';
                        subContainer.style.right = '100%';
                    } else {
                        subContainer.style.left = '100%';
                        subContainer.style.right = 'auto';
                    }
                });

                div.addEventListener('mouseleave', () => {
                    subContainer.style.display = 'none';
                });

            } else {
                div.onclick = (e) => {
                    e.stopPropagation();
                    this.hide();
                    if (item.action) item.action();
                };
            }
            container.appendChild(div);
        });
    },

    hide() {
        if (this.element) {
            this.element.style.display = 'none';
        }
    }
};
