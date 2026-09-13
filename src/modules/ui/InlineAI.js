import AIAgent from '../ai/AIAgent.js';
import { t, promptLanguageName } from '../utils/I18n.js';
import { icon as svgIcon, iconEl } from './Icons.js';
import { State } from '../core/Store.js';
import { SyntaxHighlighter } from '../utils/SyntaxHighlighter.js';
import { sanitizeHtml } from '../utils/SanitizeHtml.js';
import { hasEditorSelection, runInlinePreset, listInlinePresets } from '../ai/JhAiMcp.js';

export class InlineAI {
    constructor(editor) {
        this.editor = editor; // Reference to PlainTextView or similar
        this.element = null;
        this.promptInput = null;
        this.resultArea = null;
        this.currentAbortController = null;
    }

    show(x, y, context) {
        if (this.element) this.hide();

        const currentModel = 'JH AI Agent';
        const modal = document.createElement('div');
        modal.className = 'inline-ai-modal';
        modal.style.left = `${x}px`;
        modal.style.top = `${y}px`;

        modal.innerHTML = `
            <div class="inline-ai-header">
                <span class="model-badge jh-icon-row">${svgIcon('robot', { size: 12 })}${currentModel}</span>
                <button class="inline-ai-close">×</button>
            </div>
            <div class="inline-ai-presets" style="display:flex;flex-wrap:wrap;gap:4px;margin:2px 0 6px;"></div>
            <textarea class="inline-ai-input" placeholder="Ask the AI… (explain, summarize, refactor, aggregate — anything)"></textarea>
            <div class="inline-ai-actions">
                <div class="action-group main-actions">
                    <button class="inline-ai-gen-btn primary-btn" id="ai-send-btn">Send <span class="shortcut">↵</span></button>
                    <button class="inline-ai-stop-btn" id="ai-stop-btn" style="display:none;">Stop <span class="shortcut">Esc</span></button>
                </div>
                <div class="action-group result-actions" style="display:none;">
                    <button class="inline-ai-apply-btn primary-btn">Apply <span class="shortcut">Alt+↵</span></button>
                    <button class="inline-ai-copy-btn">Copy</button>
                </div>
            </div>
            <div class="inline-ai-review-bar" style="display:none;">
                <button class="review-btn accept-btn">Accept <span class="shortcut">Alt+↵</span></button>
                <button class="review-btn reject-btn">Reject <span class="shortcut">Esc</span></button>
            </div>
            <div class="inline-ai-result" style="display:none; max-height: 250px; overflow-y: auto; overflow-x: hidden; border: 1px solid var(--control-border); border-radius: 6px; padding: 8px; background: var(--surface-sunken); margin-top: 5px;">
                <div class="result-content" style="font-size: 13px; line-height: 1.4;"></div>
            </div>
        `;

        document.body.appendChild(modal);
        this.element = modal;

        // Ensure modal is within viewport
        const mRect = modal.getBoundingClientRect();
        if (mRect.right > window.innerWidth) modal.style.left = `${window.innerWidth - mRect.width - 20}px`;
        if (mRect.bottom > window.innerHeight) modal.style.top = `${y - mRect.height - 40}px`;

        this.promptInput = modal.querySelector('.inline-ai-input');
        this.resultArea = modal.querySelector('.inline-ai-result');
        this.resultContent = modal.querySelector('.result-content');

        this.promptInput.focus();

        // Preset transforms — shown when text is selected. Each runs async (task
        // → activity dock, editor stays usable); the dock chip then offers a Diff
        // to review/apply. See runInlinePreset.
        const presetBar = modal.querySelector('.inline-ai-presets');
        if (presetBar) {
            let hasSel = false;
            try { hasSel = hasEditorSelection(); } catch (_) {}
            if (hasSel) {
                listInlinePresets().forEach((pr) => {
                    const b = document.createElement('button');
                    b.className = 'inline-ai-preset-btn';
                    b.textContent = pr.title;
                    b.title = `AI: ${pr.title} (runs on the selection → review as a diff)`;
                    // The accent at a usable strength, from the theme — this was the
                    // DEFAULT accent frozen as a literal, so it stayed blue on
                    // the ink-brush and bamboo themes.
                    b.style.cssText = 'background:var(--primary-soft);border:1px solid var(--primary-border);'
                        + 'color:inherit;padding:3px 9px;border-radius:5px;cursor:pointer;font-size:11px;';
                    b.onclick = () => {
                        // The launch/download guidance lives inside runSingleShot
                        // (via ensureAgentAvailable); a pre-check here would only
                        // show a bare "offline" message without the offer to
                        // start the agent.
                        runInlinePreset(pr.id).catch((e) => console.warn('preset failed:', e));
                        this.hide(); // async → dock; keep editing while it works
                    };
                    presetBar.appendChild(b);
                });
            } else {
                presetBar.style.display = 'none';
            }
        }

        // Events
        modal.querySelector('.inline-ai-close').onclick = () => this.hide();
        modal.querySelector('.inline-ai-gen-btn').onclick = () => this.handleGenerate(context);

        const applyBtn = modal.querySelector('.inline-ai-apply-btn');
        const copyBtn = modal.querySelector('.inline-ai-copy-btn');
        const acceptBtn = modal.querySelector('.accept-btn');
        const rejectBtn = modal.querySelector('.reject-btn');

        const extractCode = () => {
            const codeEl = this.resultContent.querySelector('code');
            if (codeEl) return codeEl.textContent;
            return this.resultContent.textContent;
        };

        const applyAction = () => {
            if (this.onApply) this.onApply(extractCode());
            this.hide();
        };

        applyBtn.onclick = applyAction;
        acceptBtn.onclick = applyAction;

        copyBtn.onclick = async () => {
            try {
                await navigator.clipboard.writeText(extractCode());
                copyBtn.textContent = t('Copied!');
                setTimeout(() => copyBtn.textContent = t('Copy'), 2000);
            } catch (e) { }
        };

        rejectBtn.onclick = () => {
            if (this.onReject) this.onReject();
            this.hide();
        };

        const stopBtn = modal.querySelector('.inline-ai-stop-btn');
        stopBtn.onclick = () => {
            if (this.currentAbortController) {
                this.currentAbortController.abort();
            }
        };

        // Keyboard navigation
        this.promptInput.onkeydown = (e) => {
            if (e.key === 'Escape') {
                if (this.currentAbortController) {
                    this.currentAbortController.abort();
                } else {
                    if (this.onReject) this.onReject();
                    this.hide();
                }
                return;
            }
            if (e.key === 'Enter' && !e.shiftKey) {
                if (e.altKey || e.ctrlKey) {
                    if (this.resultArea.style.display !== 'none' && this.resultContent.textContent && this.resultContent.textContent !== 'Thinking...') {
                        applyAction();
                        e.preventDefault();
                    }
                } else {
                    this.handleGenerate(context);
                    e.preventDefault();
                }
            }
        };
    }

    async handleGenerate(context) {
        const prompt = this.promptInput.value.trim();
        if (!prompt) return;

        // One round trip (lane L1 — transform). This used to prefer a "freeform"
        // task that handed the model every JHEditor tool and ran as an agent,
        // and fall back to an agent run with no tools at all. InlineAI proposes
        // a replacement at the cursor; the context around the cursor is already
        // in the prompt, gated by the context scope where it was gathered.

        this.resultArea.style.display = 'block';
        this.resultContent.textContent = t('Thinking...');

        const genBtn = this.element.querySelector('.inline-ai-gen-btn');
        const stopBtn = this.element.querySelector('.inline-ai-stop-btn');
        const reviewBar = this.element.querySelector('.inline-ai-review-bar');

        genBtn.style.display = 'none';
        stopBtn.style.display = 'inline-block';
        reviewBar.style.display = 'none';

        this.currentAbortController = new AbortController();
        let fullResponse = '';

        const agentPrompt = `JHEditor Inline Code Request.
Context around the cursor:
"""
${context}
"""
Instruction: "${prompt}"

Reply with only the suggested replacement code in one fenced code block, unless the instruction asks for an explanation.`;

        try {
            const result = await AIAgent.runSingleShot({
                prompt: agentPrompt,
                systemPrompt: `You are a code assistant inside JHEditor. Answer in ${promptLanguageName()}.`,
                abortSignal: this.currentAbortController.signal,
                onUpdate: (chunk) => {
                    fullResponse += chunk;
                    // Partially render Markdown during generation
                    if (typeof marked !== 'undefined') {
                        // Create a custom renderer for Syntax Highlighting
                        const renderer = new marked.Renderer();
                        renderer.code = (codeOrObj, infostring) => {
                            let code = codeOrObj;
                            let lang = infostring;
                            if (typeof codeOrObj === 'object' && codeOrObj !== null) {
                                code = codeOrObj.text !== undefined ? codeOrObj.text : codeOrObj.code;
                                lang = codeOrObj.lang;
                            }
                            const highlighted = (typeof SyntaxHighlighter !== 'undefined')
                                ? SyntaxHighlighter.highlight(code, lang || 'text')
                                : code;
                            return `<pre><code class="language-${lang} hljs">${highlighted}</code></pre>`;
                        };
                        this.resultContent.innerHTML = sanitizeHtml(marked.parse(fullResponse, { renderer }));
                        this.resultContent.style.userSelect = 'text';
                        this.resultContent.style.cursor = 'text';
                        
                        this.resultContent.querySelectorAll('pre').forEach(pre => {
                            pre.style.position = 'relative';
                            pre.style.userSelect = 'text';
                            pre.querySelectorAll('code').forEach((c) => { c.style.userSelect = 'text'; });
                        });
                    } else {
                        this.resultContent.textContent = fullResponse;
                    }
                },
            });

            fullResponse = result || fullResponse;

            // Render final response just in case streaming missed it
            if (fullResponse && typeof marked !== 'undefined') {
                const renderer = new marked.Renderer();
                renderer.code = (codeOrObj, infostring) => {
                    let code = codeOrObj;
                    let lang = infostring;
                    if (typeof codeOrObj === 'object' && codeOrObj !== null) {
                        code = codeOrObj.text !== undefined ? codeOrObj.text : codeOrObj.code;
                        lang = codeOrObj.lang;
                    }
                    const highlighted = (typeof SyntaxHighlighter !== 'undefined')
                        ? SyntaxHighlighter.highlight(code, lang || 'text')
                        : code;
                    return `<pre><code class="language-${lang} hljs">${highlighted}</code></pre>`;
                };
                this.resultContent.innerHTML = sanitizeHtml(marked.parse(fullResponse, { renderer }));
                this.resultContent.style.userSelect = 'text';
                this.resultContent.style.cursor = 'text';
                this.resultContent.querySelectorAll('pre').forEach(pre => {
                    pre.style.position = 'relative';
                    pre.style.userSelect = 'text';
                    pre.querySelectorAll('code').forEach((c) => { c.style.userSelect = 'text'; });
                });
            } else if (fullResponse) {
                this.resultContent.textContent = fullResponse;
            }

            // On success
            if (fullResponse.trim()) {
                const resultActions = this.element.querySelector('.result-actions');
                resultActions.style.display = 'flex';
                stopBtn.style.display = 'none';
                genBtn.style.display = 'inline-block';
                genBtn.textContent = t('Retry');
                if (this.onPreview) this.onPreview(fullResponse);
            } else {
                genBtn.style.display = 'inline-block';
                stopBtn.style.display = 'none';
            }
        } catch (e) {
            if (e.name !== 'AbortError' && e.message !== 'AbortError: Task aborted by user.') {
                const msg = (e.message || '').toLowerCase();
                const isConnectionError = msg.includes('not reachable') || msg.includes('failed to fetch') || msg.includes('connection refused') || msg.includes('agent error');
                if (isConnectionError) {
                    this.resultContent.innerHTML = `
                        <div class="agent-connection-error" style="color: var(--error-color, #ff4d4f); padding: 8px;">
                            <div class="jh-icon-row" style="font-weight: bold; margin-bottom: 8px; font-size: 14px;">${svgIcon('x-circle', { size: 14 })}Cannot reach J.H AI Agent</div>
                            <p style="margin: 4px 0 12px 0; font-size: 12px; color: var(--text-color); opacity: 0.8; line-height: 1.4;">
                                The agent is not running, or the connection details are wrong.
                            </p>
                            <ol style="margin: 0; padding-left: 18px; font-size: 11.5px; color: var(--text-color); opacity: 0.8; line-height: 1.6;">
                                <li>Check that the <strong>J.H AI Agent</strong> app is running.</li>
                                <li>Approve the connection request the agent shows — check its six-digit code matches the one this editor displays.</li>
                                <li>Or enter the URL and token by hand in <strong>Settings → Agent</strong>.</li>
                            </ol>
                            <div style="margin-top: 12px;">
                                <button class="primary-btn" id="ai-reconnect-btn" style="padding: 4px 8px; font-size: 11px; cursor: pointer;">Test the connection and retry</button>
                            </div>
                        </div>
                    `;
                    const reconnectBtn = this.resultContent.querySelector('#ai-reconnect-btn');
                    if (reconnectBtn) {
                        reconnectBtn.onclick = () => {
                            AIAgent.refreshClient();
                            this.handleGenerate(context);
                        };
                    }
                } else {
                    this.resultContent.textContent = t('Error: ') + e.message;
                }
                genBtn.style.display = 'inline-block';
                stopBtn.style.display = 'none';
            } else {
                // Aborted
                this.resultContent.textContent = fullResponse || 'Stopped.';
                genBtn.style.display = 'inline-block';
                stopBtn.style.display = 'none';
            }
        } finally {
            this.currentAbortController = null;
        }
    }

    showReviewMode(newCode) {
        if (!this.element) {
            this.show(100, 100, "");
        }

        this.element.querySelector('.inline-ai-header').style.display = 'none';
        this.element.querySelector('.inline-ai-input').style.display = 'none';
        this.element.querySelector('.inline-ai-actions').style.display = 'none';
        this.element.querySelector('.inline-ai-result').style.display = 'none';

        const reviewBar = this.element.querySelector('.inline-ai-review-bar');
        reviewBar.style.display = 'flex';
        this.element.classList.add('compact-review');
        this.element.classList.add('visible');

        this.element.style.width = 'auto';
        this.element.style.minWidth = '200px';

        this.resultContent.textContent = newCode;
        this.isVisible = true;
    }

    hide() {
        if (this.element) {
            this.isVisible = false;
            this.element.classList.remove('visible');
            this.element.classList.remove('compact-review');
            this.element.style.width = '';
            this.element.style.minWidth = '';

            this.element.querySelector('.inline-ai-header').style.display = 'flex';
            this.element.querySelector('.inline-ai-input').style.display = 'block';
            this.element.querySelector('.inline-ai-actions').style.display = 'flex';
            this.element.querySelector('.inline-ai-result').style.display = 'none';
            this.element.querySelector('.inline-ai-review-bar').style.display = 'none';
            this.element.querySelector('.result-actions').style.display = 'none';
            this.element.querySelector('.inline-ai-gen-btn').textContent = t('Send');

            this.element.remove();
            this.element = null;
        }
    }

    destroy() {
        if (this.currentAbortController) {
            this.currentAbortController.abort();
        }
        this.hide();
    }
}
