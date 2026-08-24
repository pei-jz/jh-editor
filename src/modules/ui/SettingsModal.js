import { shortcuts } from '../core/ShortcutManager.js';
import * as Layout from '../core/Layout.js';
import { EL } from '../core/Constants.js';
import { State } from '../core/Store.js';
import { Toast } from './Toast.js';
import { terminalManager } from './TerminalManager.js';
import { MarkdownTemplates } from '../utils/MarkdownTemplates.js';
import { showConfirm } from './Dialog.js';

export function initSettingsModal() {
    const modal = EL.settingsModal.overlay;
    const openBtn = EL.settingsBtn;
    const closeBtn = EL.settingsModal.closeBtn;
    const themeSelector = EL.settingsModal.themeSelector;
    const { tabs, panes, agent } = EL.settingsModal;


    if (!modal) return;

    // Inject Styles for Layout
    const styleId = 'settings-layout-style';
    if (!document.getElementById(styleId)) {
        const style = document.createElement('style');
        style.id = styleId;
        style.innerHTML = `
            .settings-content.sidebar-layout {
                display: flex;
                width: 850px !important;
                height: 600px !important;
                max-width: 95vw !important;
                padding: 0 !important; /* Sidebar handles padding */
                overflow: hidden;
                background: var(--bg-color);
                border: 1px solid var(--border-color);
                border-radius: 8px;
                box-shadow: var(--shadow-lg);
            }

            /* Sidebar */
            .settings-sidebar {
                width: 220px;
                background: var(--bg-secondary);
                border-right: 1px solid var(--border-color);
                display: flex;
                flex-direction: column;
                flex-shrink: 0;
            }
            .sidebar-header {
                padding: 12px 20px; /* Reduced from 20px */
                border-bottom: 1px solid var(--border-color);
            }
            .sidebar-header h3 {
                margin: 0;
                font-size: 1.1em;
            }
            .settings-tabs {
                display: flex;
                flex-direction: column;
                padding: 5px 0;
            }
            .settings-tab {
                padding: 10px 20px;
                cursor: pointer;
                transition: all 0.2s;
                font-size: 0.9em;
                border-left: 3px solid transparent;
                opacity: 0.7;
            }
            .settings-tab:hover {
                background: rgba(255,255,255,0.05);
                opacity: 1;
            }
            .settings-tab.active {
                background: rgba(var(--primary-color-rgb), 0.1);
                border-left-color: var(--primary-color);
                color: var(--primary-color);
                font-weight: bold;
                opacity: 1;
            }

            /* Main Content Area */
            .settings-main {
                flex: 1;
                display: flex;
                flex-direction: column;
                min-width: 0;
                background: var(--bg-color);
            }
            .settings-main-header {
                padding: 10px 20px; /* Reduced from 15px 25px */
                border-bottom: 1px solid var(--border-color);
                display: flex;
                justify-content: space-between;
                align-items: center;
                background: var(--bg-secondary);
            }
            .settings-main-header h4 {
                margin: 0;
                font-size: 1.0em;
            }
            .close-btn {
                background: none;
                border: none;
                font-size: 20px;
                color: var(--text-color);
                opacity: 0.5;
                cursor: pointer;
                line-height: 1;
            }
            .close-btn:hover {
                opacity: 1;
            }

            .settings-panes {
                flex: 1;
                overflow-y: auto;
                padding: 20px;
            }
            
            .settings-main-footer {
                padding: 15px 20px;
                border-top: 1px solid var(--border-color);
                background: var(--bg-secondary);
                display: flex;
                justify-content: flex-end;
            }

            .settings-option {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 20px;
            }
            .settings-option label {
                flex: 1;
                margin-right: 20px;
                font-size: 0.95em;
            }
            .settings-option input:not([type="checkbox"]), 
            .settings-option select {
                width: 400px !important;
                box-sizing: border-box;
                padding: 8px;
                background: var(--bg-tertiary);
                color: var(--text-color);
                border: 1px solid var(--border-color);
                border-radius: 4px;
            }
            .settings-description {
                font-size: 0.85em;
                opacity: 0.7;
                margin-top: -15px;
                margin-bottom: 20px;
            }
        `;
        document.head.appendChild(style);
    }

    // Load saved theme
    const savedTheme = localStorage.getItem('theme') || 'light';
    applyTheme(savedTheme);
    if (themeSelector) themeSelector.value = savedTheme;

    // View Mode Selector
    const viewModeSelector = document.getElementById('view-mode-selector');
    const fontSizeInput = document.getElementById('font-size-input');
    const fontFamilySelector = document.getElementById('font-family-selector');

    // Load saved font family
    const savedFont = localStorage.getItem('settings_fontFamily') || 'consolas';
    applyFontFamily(savedFont);
    if (fontFamilySelector) fontFamilySelector.value = savedFont;

    // Font Size Logic
    if (fontSizeInput) {
        const currentSize = localStorage.getItem('settings_fontSize') || '11.5';
        fontSizeInput.value = currentSize;

        fontSizeInput.addEventListener('change', (e) => {
            const newSize = e.target.value;
            Layout.saveFontSize(newSize);
        });
    }

    // Tab Switching
    if (tabs) {
        tabs.forEach(tab => {
            tab.onclick = () => {
                const target = tab.dataset.tab;
                
                // Update Pane Title
                const titleEl = document.getElementById('settings-pane-title');
                if (titleEl) titleEl.textContent = tab.textContent;

                // Update UI state
                tabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');

                // Hide all panes
                Object.values(panes).forEach(p => {
                    if (p) p.style.display = 'none';
                });

                // Show target pane
                if (panes[target]) {
                    panes[target].style.display = 'block';

                    // Specific logic when tab opens
                    // Only load if not already initialized to prevent wiping unsaved changes
                    if (target === 'agent' && !agent.container.innerHTML) loadAgentSettings();
                    if (target === 'keybindings' && !document.getElementById('shortcut-list-container').innerHTML) loadKeybindingSettings();
                    if (target === 'templates') renderTemplateSettings();
                }
            };
        });
    }



    // --- Agent Settings ---
    const loadAgentSettings = () => {
        renderAgentSettings();
    };

    const renderAgentSettings = () => {
        const container = agent.container;
        if (!container) return;

        container.innerHTML = `
            <div style="font-weight:bold; margin-bottom:15px; font-size:1.1em; color:var(--primary-color);">Agent Integration</div>

            <div id="agent-conn-status" style="margin-bottom:15px; padding:10px 12px; border-radius:6px; background:rgba(0,180,255,0.07); border:1px solid rgba(0,180,255,0.25); font-size:12px;">
                <strong>🔍 Discovering connection…</strong>
            </div>

            <div class="settings-description" style="margin-bottom:15px; padding:8px; background:rgba(0,200,150,0.05); border-left:3px solid rgba(0,200,150,0.5); font-size:12px;">
                ℹ️ <strong>Auto-discovery is preferred.</strong> In J.H AI Agent → Settings → General, click <strong>📤 Export Connection</strong>.
                The settings below are <em>manual overrides</em> — leave them blank to use whatever JH AI Agent exported.
            </div>

            <div class="settings-option">
                <label>Agent URL (override)</label>
                <input type="text" id="ai-agent-url" value="${localStorage.getItem('settings_aiAgentUrl') || localStorage.getItem('settings_aiExternalAgentUrl') || ''}" placeholder="http://localhost:14300" style="width:300px !important;">
            </div>
            <div class="settings-description" style="margin-bottom:15px;">
                Manual override for the agent URL. Leave blank to auto-discover from the standard JH config path.
            </div>

            <div class="settings-option">
                <label>Connection Token (override)</label>
                <input type="password" id="ai-agent-token" value="${localStorage.getItem('settings_aiAgentToken') || localStorage.getItem('settings_aiExternalAgentToken') || ''}" placeholder="(auto-discovered)" style="width:300px !important;">
            </div>
            <div class="settings-description" style="margin-bottom:20px;">
                Manual override for the auth token. Leave blank to auto-discover.
            </div>
        `;

        // Run discovery probe + display result so the user can tell at a glance
        // whether the agent is reachable and which config source is active.
        (async () => {
            try {
                const { getConnectionConfig, isAgentReachable } = await import('../ai/ConnectionConfig.js');
                const cfg = await getConnectionConfig({ force: true });
                const reachable = await isAgentReachable(2000);
                const status = container.querySelector('#agent-conn-status');
                if (!status) return;
                const sourceLabel = cfg.source === 'localStorage'
                    ? 'localStorage override'
                    : cfg.source === 'fallback'
                        ? 'fallback (no config found)'
                        : `auto-discovered (${cfg.source})`;
                const dotColor = reachable ? '#3cb371' : '#d9534f';
                const stateLabel = reachable ? '✅ Reachable' : '❌ Not responding';
                status.innerHTML = `
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span style="width:10px;height:10px;border-radius:50%;background:${dotColor};display:inline-block;"></span>
                        <strong>${stateLabel}</strong>
                        <span style="opacity:0.7; font-size:11px;">— ${sourceLabel}</span>
                    </div>
                    <div style="margin-top:4px; font-family:monospace; font-size:11px; opacity:0.75; word-break:break-all;">
                        ${cfg.hostUrl}
                    </div>
                `;
            } catch (e) {
                const status = container.querySelector('#agent-conn-status');
                if (status) {
                    status.innerHTML = `<span style="color:#d9534f;">⚠ Discovery failed: ${e.message || e}</span>`;
                }
            }
        })();
    };

    const saveAgentSettings = () => {
        // Persist Agent Settings to localStorage
        const agentUrl = document.getElementById('ai-agent-url');
        if (agentUrl) {
            const urlVal = agentUrl.value.trim();
            localStorage.setItem('settings_aiAgentUrl', urlVal);
            localStorage.setItem('settings_aiExternalAgentUrl', urlVal); // Compatibility
        }
        const agentToken = document.getElementById('ai-agent-token');
        if (agentToken) {
            const tokenVal = agentToken.value.trim();
            localStorage.setItem('settings_aiAgentToken', tokenVal);
            localStorage.setItem('settings_aiExternalAgentToken', tokenVal); // Compatibility
        }

        // Invalidate the AI Agent connection cache so the next call re-discovers
        // settings (picks up the new override / cleared override immediately).
        (async () => {
            try {
                const { refreshConnectionConfig } = await import('../ai/ConnectionConfig.js');
                refreshConnectionConfig();
                const aiAgentModule = await import('../ai/AIAgent.js');
                aiAgentModule.default?.refreshClient?.();
            } catch (e) {
                console.warn('Failed to refresh AI agent client cache:', e);
            }
        })();

        // Notify other modules that Settings updated
        window.dispatchEvent(new CustomEvent('aiSettingsChanged'));
        Toast.success(`Agent Settings Saved!`);
    };

    // Modal Actions
    if (openBtn) {
        openBtn.onclick = () => {
            if (viewModeSelector) {
                const isCompact = document.body.classList.contains('display-mode-compact');
                viewModeSelector.value = isCompact ? 'compact' : 'normal';
            }
            if (themeSelector) {
                themeSelector.value = localStorage.getItem('theme') || 'light';
            }

            // Reset to General Tab
            if (tabs && tabs[0]) tabs[0].click();

            // Force reload for first open? Or just leave it?
            // Let's clear to ensure fresh load when modal opens
            if (agent && agent.container) agent.container.innerHTML = '';
            const shortcutList = document.getElementById('shortcut-list-container');
            if (shortcutList) shortcutList.innerHTML = '';

            modal.style.display = 'flex';
        };
    }

    if (closeBtn) {
        closeBtn.onclick = () => {
            modal.style.display = 'none';
        };
    }

    const globalSaveBtn = document.getElementById('save-all-settings-btn');
    if (globalSaveBtn) {
        globalSaveBtn.onclick = () => {
            const activeTab = document.querySelector('.settings-tab.active')?.dataset.tab;
            if (activeTab === 'agent') saveAgentSettings();
            else if (activeTab === 'keybindings') {
                Toast.info('Keybindings are saved automatically as you record them.');
            } else {
                Toast.success('Settings Applied');
            }
        };
    }

    // Explicit Closure: Prevent clicking outside from closing
    if (modal) {
        modal.onclick = (e) => {
            if (e.target === modal) {
                // Do nothing
                e.preventDefault();
                e.stopPropagation();
            }
        };

        // Esc key listener
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal.style.display === 'flex') {
                modal.style.display = 'none';
            }
        });
    }

    if (themeSelector) {
        themeSelector.onchange = (e) => {
            const theme = e.target.value;
            applyTheme(theme);
            localStorage.setItem('theme', theme);
        };
    }

    if (viewModeSelector) {
        viewModeSelector.onchange = (e) => {
            const mode = e.target.value;
            setCompactMode(mode === 'compact');
        };
    }

    if (fontFamilySelector) {
        fontFamilySelector.onchange = (e) => {
            const font = e.target.value;
            applyFontFamily(font);
            localStorage.setItem('settings_fontFamily', font);
        };
    }

    // --- Keybindings ---
    let recordingSession = null;

    const stopRecording = () => {
        if (!recordingSession) return;
        window.removeEventListener('keydown', recordingSession.onKey, true);
        window.removeEventListener('mousedown', recordingSession.onClickOutside, true);
        window._isRecordingShortcut = false;
        recordingSession = null;
    };

    const startRecording = (shortcut, rowEl) => {
        if (recordingSession) stopRecording();

        const targetCell = rowEl.children[2];
        const originalContent = targetCell.innerHTML;
        targetCell.innerHTML = '<span style="background:var(--accent-color); color:white; padding:2px 6px; border-radius:3px;">Press keys...</span>';

        window._isRecordingShortcut = true;

        const onKey = (e) => {
            e.preventDefault();
            e.stopPropagation();

            // Ignore single modifier presses
            if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;

            const newMapping = {
                key: e.key,
                ctrl: e.ctrlKey || e.metaKey,
                shift: e.shiftKey,
                alt: e.altKey
            };

            shortcuts.updateShortcut(shortcut.id, newMapping);
            stopRecording();
            renderKeybindings(document.getElementById('shortcut-search')?.value);
        };

        const onClickOutside = (e) => {
            if (!rowEl.contains(e.target)) {
                targetCell.innerHTML = originalContent;
                stopRecording();
            }
        };

        recordingSession = { onKey, onClickOutside, targetCell, originalContent };

        window.addEventListener('keydown', onKey, true);
        window.addEventListener('mousedown', onClickOutside, true);
    };

    const renderKeybindings = (filter = '') => {
        const container = document.getElementById('shortcut-list-container');
        if (!container) return;

        container.innerHTML = '';

        const list = shortcuts.shortcuts.filter(s => {
            const term = filter.toLowerCase();
            return (
                (s.description || '').toLowerCase().includes(term) ||
                (s.cmd || '').toLowerCase().includes(term) ||
                (s.key || '').toLowerCase().includes(term) ||
                (s.scope || '').toLowerCase().includes(term)
            );
        });

        if (list.length === 0) {
            container.innerHTML = '<div style="padding:20px; text-align:center; opacity:0.5;">No shortcuts found.</div>';
            return;
        }

        const table = document.createElement('table');
        table.style.width = '100%';
        table.style.borderCollapse = 'collapse';
        table.innerHTML = `
            <thead style="position:sticky; top:0; background:var(--bg-color-secondary); z-index:1;">
                <tr>
                    <th style="padding:10px; border-bottom:1px solid var(--border-color); text-align:left;">Action</th>
                    <th style="padding:10px; border-bottom:1px solid var(--border-color); text-align:left;">Scope</th>
                    <th style="padding:10px; border-bottom:1px solid var(--border-color); text-align:left;">Shortcut</th>
                </tr>
            </thead>
            <tbody id="shortcut-table-body"></tbody>
        `;

        const tbody = table.querySelector('tbody');

        list.forEach(s => {
            const tr = document.createElement('tr');
            tr.style.cursor = 'pointer';
            tr.onmouseover = () => tr.style.background = 'rgba(255,255,255,0.05)';
            tr.onmouseout = () => tr.style.background = 'none';

            const keyText = [
                s.ctrl ? 'Ctrl' : '',
                s.alt ? 'Alt' : '',
                s.shift ? 'Shift' : '',
                s.key
            ].filter(Boolean).join(' + ');

            tr.innerHTML = `
                <td style="padding:8px; border-bottom:1px solid var(--border-color);">${s.description || s.cmd}</td>
                <td style="padding:8px; border-bottom:1px solid var(--border-color); font-size:0.8em; opacity:0.7;">${s.scope}</td>
                <td style="padding:8px; border-bottom:1px solid var(--border-color); font-family:monospace; color:var(--accent-color);">${keyText}</td>
            `;

            tr.onclick = () => startRecording(s, tr);
            tbody.appendChild(tr);
        });

        container.appendChild(table);
    };

    // --- Markdown Templates ---
    const renderTemplateSettings = () => {
        const container = document.getElementById('md-template-settings-container');
        if (!container) return;

        container.innerHTML = `
            <div style="font-weight:bold; margin-bottom:8px; font-size:1.05em; color:var(--primary-color);">Markdown Templates</div>
            <div class="settings-description" style="margin-bottom:14px; font-size:12px; opacity:0.8;">
                Templates are offered when creating a new Markdown file (Ctrl+N → Markdown).
                Every template except Blank can be deleted; deleted built-ins can be restored below.
                Your own templates are stored in this browser/profile.
            </div>
            <div style="margin-bottom:16px;">
                <button id="md-tpl-toggle-btn" class="primary-btn" style="padding:6px 18px;">+ Add Template</button>
            </div>
            <div id="md-tpl-form" style="display:none; margin-bottom:16px;">
                <div style="font-weight:bold; margin-bottom:6px; font-size:0.95em;">Register a new template</div>
                <div style="margin-bottom:10px;">
                    <label for="md-tpl-name" style="display:block; font-size:12px; margin-bottom:4px; opacity:0.8;">Name</label>
                    <input type="text" id="md-tpl-name" maxlength="60" placeholder="e.g. Weekly Report" style="width:100%; max-width:520px; box-sizing:border-box; padding:8px; background:var(--bg-color); color:var(--text-color); border:1px solid var(--border-color); border-radius:4px;">
                </div>
                <div style="margin-bottom:10px;">
                    <label for="md-tpl-content" style="display:block; font-size:12px; margin-bottom:4px; opacity:0.8;">Content</label>
                    <textarea id="md-tpl-content" placeholder="# Title\n\n…" style="width:100%; max-width:520px; min-height:160px; font-family:var(--font-mono, monospace); font-size:12px; padding:8px; background:var(--bg-color); color:var(--text-color); border:1px solid var(--border-color); border-radius:4px; resize:vertical; box-sizing:border-box;"></textarea>
                </div>
                <div style="display:flex; gap:8px;">
                    <button id="md-tpl-add-btn" class="primary-btn" style="padding:6px 18px;">Register</button>
                    <button id="md-tpl-cancel-btn" class="primary-btn" style="padding:6px 18px; background:none; color:var(--text-color); border:1px solid var(--border-color);">Cancel</button>
                </div>
            </div>
            <div style="font-weight:bold; margin-bottom:6px; font-size:0.95em;">Templates</div>
            <div id="md-tpl-list" style="display:flex; flex-direction:column; gap:6px; margin-bottom:12px;"></div>
            <div id="md-tpl-hidden-wrap" style="display:none;">
                <div style="font-weight:bold; margin-bottom:6px; font-size:0.9em; opacity:0.8;">Deleted built-in templates</div>
                <div id="md-tpl-hidden-list" style="display:flex; flex-direction:column; gap:6px;"></div>
            </div>
        `;

        const listEl = container.querySelector('#md-tpl-list');
        const renderList = () => {
            const all = MarkdownTemplates.getAll();
            listEl.innerHTML = '';
            all.forEach(t => {
                const row = document.createElement('div');
                row.style.cssText = 'display:flex; align-items:center; gap:10px; padding:8px 10px; border:1px solid var(--border-color); border-radius:6px; background:var(--bg-color-secondary, var(--bg-color));';
                const firstLine = (t.content.split('\n').find(l => l.trim()) || '(blank)').slice(0, 60);
                row.innerHTML = `
                    <span style="font-weight:600; font-size:12px;">${t.name}</span>
                    <span style="font-size:10px; opacity:0.6; border:1px solid currentColor; border-radius:3px; padding:0 5px;">${t.builtin ? 'built-in' : 'user'}</span>
                    <span style="flex:1; font-size:11px; opacity:0.6; font-family:var(--font-mono, monospace); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${firstLine.replace(/</g, '&lt;')}</span>
                `;
                if (MarkdownTemplates.isDeletable(t.id)) {
                    const del = document.createElement('button');
                    del.textContent = 'Delete';
                    del.style.cssText = 'padding:3px 10px; font-size:11px; cursor:pointer; background:none; color:#d9534f; border:1px solid #d9534f; border-radius:4px;';
                    del.onclick = () => {
                        MarkdownTemplates.remove(t.id);
                        renderList();
                        Toast.info(`Template "${t.name}" deleted.`);
                    };
                    row.appendChild(del);
                }
                listEl.appendChild(row);
            });
            renderHiddenList();
        };

        // Built-in templates the user deleted can be brought back here.
        const hiddenWrap = container.querySelector('#md-tpl-hidden-wrap');
        const hiddenListEl = container.querySelector('#md-tpl-hidden-list');
        const renderHiddenList = () => {
            const hidden = MarkdownTemplates.getHiddenBuiltinTemplates();
            hiddenWrap.style.display = hidden.length ? '' : 'none';
            hiddenListEl.innerHTML = '';
            hidden.forEach(t => {
                const row = document.createElement('div');
                row.style.cssText = 'display:flex; align-items:center; gap:10px; padding:6px 10px; border:1px dashed var(--border-color); border-radius:6px; opacity:0.8;';
                row.innerHTML = `
                    <span style="font-weight:600; font-size:12px;">${t.name}</span>
                    <span style="font-size:10px; opacity:0.6; border:1px solid currentColor; border-radius:3px; padding:0 5px;">built-in</span>
                    <span style="flex:1;"></span>
                `;
                const restore = document.createElement('button');
                restore.textContent = 'Restore';
                restore.style.cssText = 'padding:3px 10px; font-size:11px; cursor:pointer; background:none; color:var(--primary-color); border:1px solid var(--primary-color); border-radius:4px;';
                restore.onclick = () => {
                    MarkdownTemplates.restoreBuiltin(t.id);
                    renderList();
                    Toast.success(`Template "${t.name}" restored.`);
                };
                row.appendChild(restore);
                hiddenListEl.appendChild(row);
            });
        };
        renderList();

        const nameInput = container.querySelector('#md-tpl-name');
        const contentInput = container.querySelector('#md-tpl-content');
        const formWrap = container.querySelector('#md-tpl-form');
        const toggleBtn = container.querySelector('#md-tpl-toggle-btn');

        // The register form is collapsed by default; the "+ Add Template"
        // button reveals it (and hides itself), Cancel collapses it again.
        toggleBtn.onclick = () => {
            formWrap.style.display = '';
            toggleBtn.style.display = 'none';
            nameInput.focus();
        };
        container.querySelector('#md-tpl-cancel-btn').onclick = () => {
            nameInput.value = '';
            contentInput.value = '';
            formWrap.style.display = 'none';
            toggleBtn.style.display = '';
        };
        container.querySelector('#md-tpl-add-btn').onclick = () => {
            try {
                const saved = MarkdownTemplates.add(nameInput.value, contentInput.value);
                nameInput.value = '';
                contentInput.value = '';
                formWrap.style.display = 'none';
                toggleBtn.style.display = '';
                renderList();
                Toast.success(`Template "${saved.name}" registered.`);
            } catch (err) {
                Toast.error(err.message || String(err));
            }
        };
    };

    const loadKeybindingSettings = () => {
        renderKeybindings();

        const searchInput = document.getElementById('shortcut-search');
        if (searchInput) {
            searchInput.oninput = (e) => renderKeybindings(e.target.value);
        }

        const resetBtn = document.getElementById('reset-shortcuts-btn');
        if (resetBtn) {
            resetBtn.onclick = async () => {
                if (await showConfirm('Reset all shortcuts to default?', { title: 'Shortcuts' })) {
                    shortcuts.resetToDefaults();
                    renderKeybindings();
                }
            };
        }
    };

    window.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.style.display = 'none';
        }
    });

}

export function applyTheme(theme) {
    document.body.classList.remove('theme-dark', 'theme-midnight', 'theme-latte', 'theme-solarized-dark', 'theme-solarized-light', 'theme-paper', 'theme-bamboo-ancient',
        'theme-sumi-e', 'theme-nord', 'theme-kakejiku');
    if (theme && theme !== 'light') {
        document.body.classList.add(`theme-${theme}`);
    }

    // CodeMirror resolves its syntax palette when the view is BUILT, so without
    // this the open editors keep the previous theme's token colours until the
    // tab is reopened. CodeMirrorView listens and reconfigures in place.
    window.dispatchEvent(new CustomEvent('themeChanged', { detail: { theme } }));
    
    // Update terminal theme if initialized (with a small delay to ensure CSS classes are applied)
    setTimeout(() => {
        try {
            terminalManager.applyTheme();
        } catch (e) {
            console.warn('Failed to update terminal theme:', e);
        }
    }, 10);
}

function setCompactMode(isCompact) {
    document.body.classList.toggle('display-mode-compact', isCompact);
}

export function applyFontFamily(font) {
    let fontString = "'Consolas', 'Monaco', 'Courier New', 'BIZ UDGothic', 'BIZ UDゴシック', 'Meiryo', 'メイリオ', 'MS Gothic', 'ＭＳ ゴシック', 'Yu Gothic', '游ゴシック', monospace";
    if (font === 'hackgen') {
        fontString = "'HackGen', 'HackGen Console', 'Consolas', 'Meiryo', monospace";
    } else if (font === 'consolas') {
        fontString = "'JetBrains Mono', 'Consolas', 'Monaco', 'Courier New', 'Meiryo', 'メイリオ', 'MS Gothic', 'ＭＳ ゴシック', monospace";
    }
    document.documentElement.style.setProperty('--editor-font-family', fontString);
}
