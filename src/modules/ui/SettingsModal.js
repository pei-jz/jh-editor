import { shortcuts } from '../core/ShortcutManager.js';
import { icon as svgIcon, iconEl } from './Icons.js';
import * as Layout from '../core/Layout.js';
import { EL } from '../core/Constants.js';
import { State } from '../core/Store.js';
import { Toast } from './Toast.js';
import { terminalManager } from './TerminalManager.js';
import { MarkdownTemplates } from '../utils/MarkdownTemplates.js';
import { Snippets, DEFAULT_CATEGORY } from './Snippets.js';
import { RegexPresets, DEFAULT_CATEGORY as REGEX_DEFAULT_CATEGORY } from './RegexPresets.js';
import { showConfirm } from './Dialog.js';
import { SCOPES, getScope, setScope } from '../ai/ContextScope.js';
import { isLocalSuggestEnabled, setLocalSuggestEnabled } from './InlineCompletion.js';
import {
    getLargeFileThresholdMB, setLargeFileThresholdMB,
    MIN_THRESHOLD_MB, MAX_THRESHOLD_MB,
} from '../utils/LargeFileSetting.js';
import { getLanguage, setLanguage, t } from '../utils/I18n.js';
import { THEMES, themeClasses, isKnownTheme } from '../utils/Themes.js';

/**
 * Fill in the About block at the bottom of the General tab.
 *
 * There was previously nowhere in the running app to find out which build you
 * were using, which made every bug report start with a round trip asking. The
 * Copy button exists for the same reason: the point is that the version reaches
 * the report, not that the user reads it off the screen and retypes it.
 *
 * Values are read at runtime from the Tauri APIs rather than baked in, so they
 * cannot drift from the binary the user is actually running. Everything here is
 * best-effort: outside a Tauri shell (unit tests, a plain browser) the fields
 * stay at their placeholder instead of throwing.
 */
async function initAboutSection() {
    const versionEl = document.getElementById('about-version');
    const platformEl = document.getElementById('about-platform');
    const tauriEl = document.getElementById('about-tauri');
    const copyBtn = document.getElementById('about-copy-btn');
    if (!versionEl) return;

    let version = '';
    let tauriVersion = '';
    let platform = '';

    try {
        const app = await import('@tauri-apps/api/app');
        version = await app.getVersion();
        tauriVersion = await app.getTauriVersion();
    } catch (_) { /* not running inside Tauri */ }

    try {
        const os = await import('@tauri-apps/plugin-os');
        const [name, arch] = await Promise.all([os.platform(), os.arch()]);
        platform = `${name} ${arch}`;
    } catch (_) {
        platform = (typeof navigator !== 'undefined' && navigator.platform) || '';
    }

    if (version) versionEl.textContent = `v${version}`;
    if (platformEl && platform) platformEl.textContent = platform;
    if (tauriEl && tauriVersion) tauriEl.textContent = tauriVersion;

    initUpdateCheck();

    if (copyBtn) {
        copyBtn.onclick = async () => {
            const lines = [
                `J.H Editor v${version || 'unknown'}`,
                `Platform: ${platform || 'unknown'}`,
                `Tauri: ${tauriVersion || 'unknown'}`,
            ].join('\n');
            try {
                const clip = await import('@tauri-apps/plugin-clipboard-manager');
                await clip.writeText(lines);
                Toast.show(t('Version info copied'));
            } catch (_) {
                try {
                    await navigator.clipboard.writeText(lines);
                    Toast.show(t('Version info copied'));
                } catch (e) {
                    Toast.show(t('Could not copy — select the text above instead'), 'error');
                }
            }
        };
    }
}

/**
 * 「更新を確認」ボタン。
 *
 * 起動時に黙って確認して再起動する作りにはしていない。入力中に勝手に
 * 再起動するエディタは、1 バージョン古いエディタより悪い。押したときだけ
 * 動き、見つかっても適用するかどうかは本人が決める。
 *
 * 更新の完全性はプラグイン側が担保する。配信された更新にプロジェクトの
 * 秘密鍵による署名がなければインストールされないので、配布物にコード署名が
 * ないこととは無関係に、偽の更新を掴まされることはない。
 *
 * Tauri の外（単体テスト、素のブラウザ）ではボタン自体を隠す。押しても
 * 何も起きないボタンを置くより、無いほうがましだから。
 *
 * 判定は import の成否ではなく IPC の有無で行う。プラグインは Vite が
 * バンドルするので import は素のブラウザでも「成功」し、失敗するのは
 * 実際に呼んだときの IPC —— つまり import の try/catch では検出できない。
 */
function inTauri() {
    return typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
}

async function initUpdateCheck() {
    const btn = document.getElementById('about-update-btn');
    if (!btn) return;

    if (!inTauri()) {
        btn.style.display = 'none';
        return;
    }
    // 明示的に戻す。隠すだけで戻さないと、この関数は一度でも Tauri の外で
    // 走った後は二度とボタンを出せなくなる —— 起動が一度きりの本番では
    // 起きないが、状態の片道通行はいずれ誰かを困らせる。
    btn.style.display = '';

    let check = null;
    try {
        ({ check } = await import('@tauri-apps/plugin-updater'));
    } catch (e) {
        console.warn('Updater plugin unavailable', e);
        btn.style.display = 'none';
        return;
    }

    let busy = false;
    btn.onclick = async () => {
        if (busy) return;
        busy = true;
        const label = btn.textContent;
        btn.disabled = true;
        btn.textContent = t('Checking…');
        try {
            const update = await check();
            if (!update) {
                Toast.show(t('You are on the latest version.'));
                return;
            }
            const ok = await showConfirm(
                t('Version {v} is available. Download and install it now?', { v: update.version }),
                { title: t('Update Available') },
            );
            if (!ok) return;

            btn.textContent = t('Downloading…');
            await update.downloadAndInstall();

            // 再起動しないと更新は反映されない。未保存の作業を巻き込まない
            // よう、閉じる前に本人に確認する —— onCloseRequested は
            // relaunch() では走らないため、ここで聞くしかない。
            const restart = await showConfirm(
                t('The update is installed. Restart now to use it?'),
                { title: t('Update Available') },
            );
            if (restart) {
                const { relaunch } = await import('@tauri-apps/plugin-process');
                await relaunch();
            }
        } catch (e) {
            console.error('Update check failed', e);
            Toast.show(t('Could not check for updates: {msg}', { msg: (e && e.message) || String(e) }), 'error');
        } finally {
            busy = false;
            btn.disabled = false;
            btn.textContent = label;
        }
    };
}

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
                background: var(--bg-color-secondary);
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
                background: var(--bg-color-secondary);
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
                background: var(--bg-color-secondary);
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
    // Build the picker from the registry rather than from markup: a theme
    // added to Themes.js appears here without anyone remembering to add an
    // <option>, and the label goes through t() like every other string.
    if (themeSelector && !themeSelector.options.length) {
        for (const th of THEMES) {
            const opt = document.createElement('option');
            opt.value = th.id;
            opt.textContent = t(th.label);
            opt.setAttribute('data-i18n', th.label);
            themeSelector.appendChild(opt);
        }
    }

    applyTheme(savedTheme);
    if (themeSelector) themeSelector.value = savedTheme;

    // View Mode Selector
    const viewModeSelector = document.getElementById('view-mode-selector');
    const fontSizeInput = document.getElementById('font-size-input');
    const fontFamilySelector = document.getElementById('font-family-selector');
    const languageSelector = document.getElementById('language-selector');

    // Load saved font family
    const savedFont = localStorage.getItem('settings_fontFamily') || 'consolas';
    applyFontFamily(savedFont);
    if (fontFamilySelector) fontFamilySelector.value = savedFont;

    // Language
    if (languageSelector) {
        languageSelector.value = getLanguage();
        languageSelector.onchange = (e) => {
            setLanguage(e.target.value);
        };
    }

    initAboutSection();

    // Font Size Logic
    if (fontSizeInput) {
        const currentSize = localStorage.getItem('settings_fontSize') || '11.5';
        fontSizeInput.value = currentSize;

        fontSizeInput.addEventListener('change', (e) => {
            const newSize = e.target.value;
            Layout.saveFontSize(newSize);
        });
    }

    // Large-file threshold
    const largeFileInput = EL.largeFileThresholdInput;
    if (largeFileInput) {
        largeFileInput.min = String(MIN_THRESHOLD_MB);
        largeFileInput.max = String(MAX_THRESHOLD_MB);
        largeFileInput.value = String(getLargeFileThresholdMB());
        largeFileInput.addEventListener('change', () => {
            // Write back what was actually stored, so a value out of range
            // corrects itself in the box instead of lying about what is set.
            largeFileInput.value = String(setLargeFileThresholdMB(largeFileInput.value));
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
                    if (target === 'snippets') renderSnippetSettings();
                    if (target === 'regex') renderRegexSettings();
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
            <div class="settings-section-title">Agent Integration</div>

            <div id="agent-conn-status" style="margin-bottom:15px; padding:10px 12px; border-radius:6px; background:rgba(0,180,255,0.07); border:1px solid rgba(0,180,255,0.25); font-size:12px;">
                <strong class="jh-icon-row">${svgIcon('search', { size: 13 })}Discovering connection…</strong>
            </div>

            <div class="settings-description" style="margin-bottom:15px; padding:8px; background:rgba(0,200,150,0.05); border-left:3px solid rgba(0,200,150,0.5); font-size:12px;">
                <strong>Auto-discovery is preferred.</strong> In J.H AI Agent → Settings → General, click <strong>Export Connection</strong>.
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

            <div class="settings-section-title">Context Scope</div>

            <div class="settings-description" style="margin-bottom:12px; padding:8px; background:rgba(255,180,0,0.06); border-left:3px solid rgba(255,180,0,0.55); font-size:12px;">
                How much of the editor the AI may read. The agent PULLS this itself while a task
                runs — it is not sent unless a tool asks for it, and nothing here is sent when no
                task is running. Personal notes are excluded at every level.
            </div>

            <div id="ai-scope-list" style="display:flex; flex-direction:column; gap:2px; margin-bottom:20px;"></div>

            <div class="settings-section-title">Inline Suggestions</div>
            <div class="settings-description" style="margin-bottom:12px;">
                Ghost text after the cursor. <strong>Tab</strong> accepts, <strong>Esc</strong> dismisses.
            </div>

            <div class="settings-option">
                <label for="local-inline-suggest">Complete from this file</label>
                <input type="checkbox" id="local-inline-suggest">
            </div>
            <div class="settings-description" style="margin-bottom:18px;">
                Completes the line from a matching line elsewhere in the file, or the word from a
                word already used in it. Answers in well under a frame and sends nothing anywhere.
            </div>

            <div class="settings-description" style="margin-bottom:20px;">
                There is no AI behind this: a model round trip takes seconds, and a suggestion that
                arrives after the cursor has moved is thrown away. For AI help on a specific piece of
                text, select it and use <strong>Inline AI</strong>, where you ask and it is worth the wait.
            </div>
        `;

        const localToggle = container.querySelector('#local-inline-suggest');
        if (localToggle) {
            localToggle.checked = isLocalSuggestEnabled();
            localToggle.onchange = () => setLocalSuggestEnabled(localToggle.checked);
        }

        // Radios rather than a <select>: each level needs its consequence spelled
        // out next to it, and a dropdown hides four of the five while you choose.
        const scopeList = container.querySelector('#ai-scope-list');
        if (scopeList) {
            const current = getScope();
            for (const s of SCOPES) {
                const row = document.createElement('label');
                row.style.cssText = 'display:flex; gap:8px; align-items:flex-start; padding:7px 8px;'
                    + ' border:1px solid var(--border-color); border-radius:5px; cursor:pointer;'
                    + (s.id === current ? ' background:var(--bg-active);' : '');
                const radio = document.createElement('input');
                radio.type = 'radio';
                radio.name = 'ai-context-scope';
                radio.value = s.id;
                radio.checked = s.id === current;
                radio.style.marginTop = '2px';
                radio.onchange = () => {
                    setScope(s.id);
                    // Repaint so the highlight follows the choice.
                    for (const el of scopeList.children) {
                        el.style.background = el.querySelector('input').checked
                            ? 'var(--bg-active)' : 'transparent';
                    }
                };
                const text = document.createElement('div');
                const name = document.createElement('div');
                name.textContent = `${s.rank}. ${s.label}`;
                name.style.cssText = 'font-size:12px; font-weight:600;';
                const hint = document.createElement('div');
                hint.textContent = s.hint;
                hint.style.cssText = 'font-size:11px; opacity:0.7; margin-top:2px; line-height:1.45;';
                text.append(name, hint);
                row.append(radio, text);
                scopeList.appendChild(row);
            }
        }

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
                const stateLabel = reachable
            ? svgIcon('check-circle', { size: 12 }) + ' Reachable'
            : svgIcon('x-circle', { size: 12 }) + ' Not responding';
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
                    status.innerHTML = `<span class="jh-icon-row" style="color:#d9534f;">${svgIcon('warning', { size: 12 })}Discovery failed: ${e.message || e}</span>`;
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
                Toast.info(t('Keybindings are saved automatically as you record them.'));
            } else {
                Toast.success(t('Settings Applied'));
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
            <div class="settings-section-title">Markdown Templates</div>
            <div class="settings-description" style="margin-bottom:14px;">
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
                    del.textContent = t('Delete');
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
                restore.textContent = t('Restore');
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
                if (await showConfirm(t('Reset all shortcuts to default?'), { title: 'Shortcuts' })) {
                    shortcuts.resetToDefaults();
                    renderKeybindings();
                }
            };
        }
    };

    // --- Snippets ---
    const renderSnippetSettings = () => {
        const container = document.getElementById('snippet-settings-container');
        if (!container) return;

        container.innerHTML = `
            <div class="settings-section-title">Snippets</div>
            <div class="settings-description" style="margin-bottom:14px;">
                Register a snippet, then type its prefix in the editor and press Tab to expand it.
                A prefix is optional: snippets without one can still be kept here as reusable text.
                Group related snippets with a category; categories collapse.
            </div>
            <div style="margin-bottom:16px;">
                <button id="snip-toggle-btn" class="primary-btn" style="padding:6px 18px;">+ Add Snippet</button>
            </div>
            <div id="snip-form" style="display:none; margin-bottom:16px;">
                <div style="font-weight:bold; margin-bottom:6px; font-size:0.95em;">Register a new snippet</div>
                <div style="margin-bottom:10px;">
                    <label for="snip-name" style="display:block; font-size:12px; margin-bottom:4px; opacity:0.8;">Name</label>
                    <input type="text" id="snip-name" maxlength="60" placeholder="e.g. Log statement" style="width:100%; max-width:520px; box-sizing:border-box; padding:8px; background:var(--bg-color); color:var(--text-color); border:1px solid var(--border-color); border-radius:4px;">
                </div>
                <div style="margin-bottom:10px;">
                    <label for="snip-prefix" style="display:block; font-size:12px; margin-bottom:4px; opacity:0.8;">Prefix (optional)</label>
                    <input type="text" id="snip-prefix" maxlength="40" placeholder="e.g. lg" style="width:100%; max-width:520px; box-sizing:border-box; padding:8px; background:var(--bg-color); color:var(--text-color); border:1px solid var(--border-color); border-radius:4px;">
                </div>
                <div style="margin-bottom:10px;">
                    <label for="snip-category" style="display:block; font-size:12px; margin-bottom:4px; opacity:0.8;">Category</label>
                    <input type="text" id="snip-category" maxlength="40" list="snip-category-list" placeholder="${DEFAULT_CATEGORY}" style="width:100%; max-width:520px; box-sizing:border-box; padding:8px; background:var(--bg-color); color:var(--text-color); border:1px solid var(--border-color); border-radius:4px;">
                    <datalist id="snip-category-list"></datalist>
                </div>
                <div style="margin-bottom:10px;">
                    <label for="snip-body" style="display:block; font-size:12px; margin-bottom:4px; opacity:0.8;">Body</label>
                    <textarea id="snip-body" placeholder="console.log('hello');" style="width:100%; max-width:520px; min-height:140px; font-family:var(--font-mono, monospace); font-size:12px; padding:8px; background:var(--bg-color); color:var(--text-color); border:1px solid var(--border-color); border-radius:4px; resize:vertical; box-sizing:border-box;"></textarea>
                </div>
                <div style="display:flex; gap:8px;">
                    <button id="snip-add-btn" class="primary-btn" style="padding:6px 18px;">Register</button>
                    <button id="snip-cancel-btn" class="primary-btn" style="padding:6px 18px; background:none; color:var(--text-color); border:1px solid var(--border-color);">Cancel</button>
                </div>
            </div>
            <div style="font-weight:bold; margin-bottom:8px; font-size:0.95em;">Registered</div>
            <div id="snip-list" style="display:flex; flex-direction:column; gap:8px;"></div>
        `;

        const listEl = container.querySelector('#snip-list');
        const catList = container.querySelector('#snip-category-list');

        // Which categories are folded, remembered between visits — a list you
        // have to re-collapse every time you open Settings is not organised.
        const COLLAPSE_KEY = 'settings_snippetCollapsed';
        const readCollapsed = () => {
            try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]')); }
            catch (_) { return new Set(); }
        };
        const writeCollapsed = (set) => {
            try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set])); }
            catch (_) { /* ignore */ }
        };

        const renderList = () => {
            const groups = Snippets.grouped();
            listEl.innerHTML = '';

            // Keep the form's suggestions in step with what exists.
            if (catList) {
                catList.innerHTML = '';
                for (const c of Snippets.categories()) {
                    const opt = document.createElement('option');
                    opt.value = c;
                    catList.appendChild(opt);
                }
            }

            if (groups.length === 0) {
                listEl.innerHTML = '<div style="padding:16px; text-align:center; opacity:0.5;">No snippets yet.</div>';
                return;
            }

            const collapsed = readCollapsed();
            const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');

            for (const { category, items } of groups) {
                const group = document.createElement('div');
                group.className = 'snippet-group';

                const head = document.createElement('button');
                head.type = 'button';
                head.className = 'snippet-group-head';
                head.setAttribute('aria-expanded', String(!collapsed.has(category)));

                const arrow = document.createElement('span');
                arrow.className = 'snippet-group-arrow';
                arrow.replaceChildren(iconEl('chevron-right', { size: 11 }));
            arrow.classList.add('jh-icon-rotate');
            arrow.classList.toggle('is-open', !collapsed.has(category));

                const label = document.createElement('span');
                label.className = 'snippet-group-name';
                label.textContent = category;

                const count = document.createElement('span');
                count.className = 'snippet-group-count';
                count.textContent = items.length;

                head.append(arrow, label, count);

                const groupBody = document.createElement('div');
                groupBody.className = 'snippet-group-body';
                groupBody.style.display = collapsed.has(category) ? 'none' : '';

                head.onclick = () => {
                    const now = readCollapsed();
                    if (now.has(category)) now.delete(category);
                    else now.add(category);
                    writeCollapsed(now);
                    const open = !now.has(category);
                    groupBody.style.display = open ? '' : 'none';
                    arrow.replaceChildren(iconEl('chevron-right', { size: 11 }));
                arrow.classList.add('jh-icon-rotate');
                arrow.classList.toggle('is-open', !!open);
                    head.setAttribute('aria-expanded', String(open));
                };

                for (const s of items) {
                    const row = document.createElement('div');
                    row.className = 'snippet-settings-row';
                    row.innerHTML = `
                        <span class="snippet-name">${esc(s.name)}</span>
                        <span class="snippet-prefix">${s.prefix ? esc(s.prefix) : '(no prefix)'}</span>
                        <span class="snippet-body">${esc((s.body.split('\n')[0] || '').slice(0, 50))}</span>
                    `;

                    // Re-filing a snippet without deleting and retyping it.
                    const move = document.createElement('select');
                    move.className = 'snippet-move';
                    move.title = t('Move to another category');
                    for (const c of [...new Set([...Snippets.categories(), category])]) {
                        const o = document.createElement('option');
                        o.value = c;
                        o.textContent = c;
                        o.selected = c === category;
                        move.appendChild(o);
                    }
                    move.onchange = () => {
                        Snippets.setCategory(s.id, move.value);
                        renderList();
                    };
                    row.appendChild(move);

                    const del = document.createElement('button');
                    del.className = 'snippet-del';
                    del.textContent = '×';
                    del.title = t('Delete snippet');
                    del.onclick = () => {
                        Snippets.remove(s.id);
                        renderList();
                        Toast.info(`Snippet "${s.name}" deleted.`);
                    };
                    row.appendChild(del);
                    groupBody.appendChild(row);
                }

                group.append(head, groupBody);
                listEl.appendChild(group);
            }
        };
        renderList();

        const nameInput = container.querySelector('#snip-name');
        const prefixInput = container.querySelector('#snip-prefix');
        const bodyInput = container.querySelector('#snip-body');
        const categoryInput = container.querySelector('#snip-category');
        const formWrap = container.querySelector('#snip-form');
        const toggleBtn = container.querySelector('#snip-toggle-btn');

        toggleBtn.onclick = () => {
            formWrap.style.display = '';
            toggleBtn.style.display = 'none';
            nameInput.focus();
        };
        container.querySelector('#snip-cancel-btn').onclick = () => {
            nameInput.value = '';
            prefixInput.value = '';
            bodyInput.value = '';
            if (categoryInput) categoryInput.value = '';
            formWrap.style.display = 'none';
            toggleBtn.style.display = '';
        };
        container.querySelector('#snip-add-btn').onclick = () => {
            try {
                const saved = Snippets.add(
                    nameInput.value, prefixInput.value, bodyInput.value,
                    categoryInput ? categoryInput.value : '',
                );
                nameInput.value = '';
                prefixInput.value = '';
                bodyInput.value = '';
                // The category is NOT cleared: adding three snippets to the same
                // category in a row is the normal case, and retyping it each
                // time is the annoying one.
                formWrap.style.display = 'none';
                toggleBtn.style.display = '';
                renderList();
                Toast.success(`Snippet "${saved.name}" registered.`);
            } catch (err) {
                Toast.error(err.message || String(err));
            }
        };
    };

    // --- Regex samples ---
    const renderRegexSettings = () => {
        const container = document.getElementById('regex-settings-container');
        if (!container) return;

        container.innerHTML = `
            <div class="settings-section-title">Regex Samples</div>
            <div class="settings-description" style="margin-bottom:14px;">
                The library behind the <strong>.*</strong> button in Find &amp; Replace (Alt+T).
                Add the patterns you keep re-typing, and group them so the list stays short.
                Built-in samples can be removed and brought back later.
            </div>
            <div style="margin-bottom:16px;">
                <button id="rx-toggle-btn" class="primary-btn" style="padding:6px 18px;">+ Add Sample</button>
            </div>
            <div id="rx-form" style="display:none; margin-bottom:16px;">
                <div style="font-weight:bold; margin-bottom:6px; font-size:0.95em;">Register a new sample</div>
                <div style="margin-bottom:10px;">
                    <label for="rx-name" style="display:block; font-size:12px; margin-bottom:4px; opacity:0.8;">Name</label>
                    <input type="text" id="rx-name" maxlength="80" placeholder="e.g. Order number" style="width:100%; max-width:520px; box-sizing:border-box; padding:8px; background:var(--bg-color); color:var(--text-color); border:1px solid var(--border-color); border-radius:4px;">
                </div>
                <div style="margin-bottom:10px;">
                    <label for="rx-category" style="display:block; font-size:12px; margin-bottom:4px; opacity:0.8;">Category</label>
                    <input type="text" id="rx-category" maxlength="40" list="rx-category-list" placeholder="${REGEX_DEFAULT_CATEGORY}" style="width:100%; max-width:520px; box-sizing:border-box; padding:8px; background:var(--bg-color); color:var(--text-color); border:1px solid var(--border-color); border-radius:4px;">
                    <datalist id="rx-category-list"></datalist>
                </div>
                <div style="margin-bottom:6px;">
                    <label for="rx-pattern" style="display:block; font-size:12px; margin-bottom:4px; opacity:0.8;">Pattern</label>
                    <input type="text" id="rx-pattern" spellcheck="false" placeholder="\\bORD-\\d{6}\\b" style="width:100%; max-width:520px; box-sizing:border-box; padding:8px; font-family:var(--editor-font-family, monospace); font-size:12px; background:var(--bg-color); color:var(--text-color); border:1px solid var(--border-color); border-radius:4px;">
                </div>
                <div id="rx-check" style="min-height:18px; margin-bottom:10px; font-size:11.5px; font-family:var(--editor-font-family, monospace);"></div>
                <div style="display:flex; gap:8px;">
                    <button id="rx-add-btn" class="primary-btn" style="padding:6px 18px;">Register</button>
                    <button id="rx-cancel-btn" class="primary-btn" style="padding:6px 18px; background:none; color:var(--text-color); border:1px solid var(--border-color);">Cancel</button>
                </div>
            </div>
            <div style="font-weight:bold; margin-bottom:8px; font-size:0.95em;">Library</div>
            <div id="rx-list" style="display:flex; flex-direction:column; gap:8px;"></div>
            <div id="rx-removed" style="margin-top:22px;"></div>
        `;

        const listEl = container.querySelector('#rx-list');
        const removedEl = container.querySelector('#rx-removed');
        const catList = container.querySelector('#rx-category-list');

        const COLLAPSE_KEY = 'settings_regexSettingsCollapsed';
        const readCollapsed = () => {
            try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]')); }
            catch (_) { return new Set(); }
        };
        const writeCollapsed = (set) => {
            try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set])); }
            catch (_) { /* ignore */ }
        };

        const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');

        const renderList = () => {
            const groups = RegexPresets.grouped();
            listEl.innerHTML = '';

            if (catList) {
                catList.innerHTML = '';
                for (const c of RegexPresets.categories()) {
                    const opt = document.createElement('option');
                    opt.value = c;
                    catList.appendChild(opt);
                }
            }

            if (groups.length === 0) {
                listEl.innerHTML = '<div style="padding:16px; text-align:center; opacity:0.5;">Every sample has been removed.</div>';
            }

            const collapsed = readCollapsed();

            for (const { category, items } of groups) {
                const group = document.createElement('div');
                group.className = 'snippet-group';

                const head = document.createElement('button');
                head.type = 'button';
                head.className = 'snippet-group-head';
                head.setAttribute('aria-expanded', String(!collapsed.has(category)));

                const arrow = document.createElement('span');
                arrow.className = 'snippet-group-arrow';
                arrow.replaceChildren(iconEl('chevron-right', { size: 11 }));
            arrow.classList.add('jh-icon-rotate');
            arrow.classList.toggle('is-open', !collapsed.has(category));
                const name = document.createElement('span');
                name.className = 'snippet-group-name';
                name.textContent = category;
                const count = document.createElement('span');
                count.className = 'snippet-group-count';
                count.textContent = items.length;
                head.append(arrow, name, count);

                const body = document.createElement('div');
                body.className = 'snippet-group-body';
                body.style.display = collapsed.has(category) ? 'none' : '';

                head.onclick = () => {
                    const now = readCollapsed();
                    if (now.has(category)) now.delete(category);
                    else now.add(category);
                    writeCollapsed(now);
                    renderList();
                };

                for (const preset of items) {
                    const row = document.createElement('div');
                    row.className = 'regex-settings-row';
                    row.innerHTML = `
                        <span class="regex-name">${esc(preset.label)}</span>
                        <span class="regex-pattern" title="${esc(preset.pattern)}">${esc(preset.pattern)}</span>
                    `;
                    if (preset.builtin) {
                        const tag = document.createElement('span');
                        tag.className = 'regex-builtin';
                        tag.textContent = 'built-in';
                        row.appendChild(tag);
                    }

                    const move = document.createElement('select');
                    move.className = 'snippet-move';
                    move.title = t('Move to another category');
                    for (const c of [...new Set([...RegexPresets.categories(), category])]) {
                        const o = document.createElement('option');
                        o.value = c;
                        o.textContent = c;
                        o.selected = c === category;
                        move.appendChild(o);
                    }
                    move.onchange = () => {
                        RegexPresets.setCategory(preset.id, move.value);
                        renderList();
                    };
                    row.appendChild(move);

                    const del = document.createElement('button');
                    del.className = 'regex-del';
                    del.textContent = '×';
                    del.title = preset.builtin
                        ? 'Remove from the picker (can be restored below)'
                        : 'Delete this sample';
                    del.onclick = () => {
                        RegexPresets.remove(preset.id);
                        renderList();
                        Toast.info(`"${preset.label}" removed.`);
                    };
                    row.appendChild(del);

                    body.appendChild(row);
                }

                group.append(head, body);
                listEl.appendChild(group);
            }

            // Removed built-ins are listed rather than lost, so there is a way
            // back that does not involve retyping a pattern from memory.
            const hidden = RegexPresets.hiddenBuiltins();
            removedEl.innerHTML = '';
            if (hidden.length) {
                const title = document.createElement('div');
                title.style.cssText = 'font-weight:bold; margin-bottom:6px; font-size:0.95em;';
                title.textContent = `Removed built-ins (${hidden.length})`;
                removedEl.appendChild(title);

                for (const preset of hidden) {
                    const row = document.createElement('div');
                    row.className = 'regex-restore';
                    const label = document.createElement('span');
                    label.textContent = preset.label;
                    const pat = document.createElement('code');
                    pat.className = 'regex-pattern';
                    pat.textContent = preset.pattern;
                    const btn = document.createElement('button');
                    btn.className = 'primary-btn push';
                    btn.style.cssText = 'padding:3px 12px; font-size:11px;';
                    btn.textContent = t('Restore');
                    btn.onclick = () => {
                        RegexPresets.restore(preset.id);
                        renderList();
                    };
                    row.append(label, pat, btn);
                    removedEl.appendChild(row);
                }
            }
        };
        renderList();

        const nameInput = container.querySelector('#rx-name');
        const catInput = container.querySelector('#rx-category');
        const patInput = container.querySelector('#rx-pattern');
        const checkEl = container.querySelector('#rx-check');
        const formWrap = container.querySelector('#rx-form');
        const toggleBtn = container.querySelector('#rx-toggle-btn');

        // Tell the user the pattern is broken HERE, not later in the search box
        // where the sample looks fine and the search simply finds nothing.
        const check = () => {
            const src = patInput.value;
            if (!src) { checkEl.textContent = ''; return; }
            try {
                new RegExp(src);
                checkEl.style.color = 'var(--git-staged-color, #4a7a4a)';
                checkEl.classList.add('jh-icon-row');
                checkEl.replaceChildren(iconEl('check', { size: 12 }), document.createTextNode('valid'));
            } catch (e) {
                checkEl.style.color = 'var(--error-color, #d9534f)';
                checkEl.classList.add('jh-icon-row');
                checkEl.replaceChildren(iconEl('x', { size: 12 }), document.createTextNode(e.message));
            }
        };
        patInput.addEventListener('input', check);

        toggleBtn.onclick = () => {
            formWrap.style.display = '';
            toggleBtn.style.display = 'none';
            nameInput.focus();
        };
        container.querySelector('#rx-cancel-btn').onclick = () => {
            nameInput.value = '';
            patInput.value = '';
            catInput.value = '';
            checkEl.textContent = '';
            formWrap.style.display = 'none';
            toggleBtn.style.display = '';
        };
        container.querySelector('#rx-add-btn').onclick = () => {
            try {
                const saved = RegexPresets.add(nameInput.value, patInput.value, catInput.value);
                nameInput.value = '';
                patInput.value = '';
                checkEl.textContent = '';
                // The category is kept: adding several samples to one category
                // in a row is the normal case.
                formWrap.style.display = 'none';
                toggleBtn.style.display = '';
                renderList();
                Toast.success(`"${saved.label}" added to ${saved.category}.`);
            } catch (err) {
                Toast.error(err.message || String(err));
            }
        };
    };

    window.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.style.display = 'none';
        }
    });

}

export function applyTheme(theme) {
    // Derived from the registry, not repeated here. A theme missing from this
    // list used to leave TWO theme classes on <body> at once, after which the
    // palette depended on stylesheet order rather than on the setting.
    document.body.classList.remove(...themeClasses());
    if (theme && theme !== 'light' && isKnownTheme(theme)) {
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
