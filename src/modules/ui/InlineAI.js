import AIAgent from '../ai/AIAgent.js';
import { State } from '../core/Store.js';
import { SyntaxHighlighter } from '../utils/SyntaxHighlighter.js';
import { sanitizeHtml } from '../utils/SanitizeHtml.js';
import { listJhaiIntents, runJhaiIntent, hasEditorSelection, runJhaiFreeform, ensureJhaiConnected, runInlinePreset, listInlinePresets } from '../ai/JhAiMcp.js';

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
                <span class="model-badge">🤖 ${currentModel}</span>
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
            <div class="inline-ai-result" style="display:none; max-height: 250px; overflow-y: auto; overflow-x: hidden; border: 1px solid rgba(255,255,255,0.05); border-radius: 6px; padding: 8px; background: rgba(0,0,0,0.2); margin-top: 5px;">
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
                    b.style.cssText = 'background:rgba(10,108,255,0.14);border:1px solid rgba(10,108,255,0.4);color:inherit;padding:3px 9px;border-radius:5px;cursor:pointer;font-size:11px;';
                    b.onclick = async () => {
                        try {
                            if (!(await ensureJhaiConnected())) {
                                this.resultArea.style.display = 'block';
                                this.resultContent.textContent = '❌ Cannot reach J.H AI Agent. Please start the Agent.';
                                return;
                            }
                            runInlinePreset(pr.id, {}).catch((e) => console.warn('preset failed:', e));
                            this.hide(); // async → dock; keep editing while it works
                        } catch (e) { console.warn('preset error:', e); }
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
                copyBtn.textContent = 'Copied!';
                setTimeout(() => copyBtn.textContent = 'Copy', 2000);
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

        // Preferred path: when JHAI's MCP (WS) is connected, run the free-text as
        // a FREEFORM task — the LLM is given JHEditor's live tools and decides what
        // to do. The bottom-right activity dock shows live progress / Stop / result
        // (Markdown opens in an editor tab), so we CLOSE this popup immediately.
        try {
            if (await ensureJhaiConnected()) {
                runJhaiFreeform(prompt, context).catch((e) => console.warn('JHAI freeform failed:', e));
                this.hide();
                return;
            }
        } catch (_) { /* fall through to the legacy path */ }

        this.resultArea.style.display = 'block';
        this.resultContent.textContent = 'Thinking...';

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

Please provide only the suggested replacement code block. Do NOT use tools to write files directly. Stream your code response.`;

        try {
            const result = await AIAgent.run(
                agentPrompt,
                (chunk) => {
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
                (status) => {
                    if (!fullResponse) {
                        this.resultContent.textContent = status;
                    }
                },
                async (confirmData) => {
                    // Disallow direct writes from the agent during inline assist
                    return false;
                },
                null, // editContext
                [],   // chatContext
                null, // onLog
                this.currentAbortController.signal
            );

            fullResponse = result.response || fullResponse;

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
                genBtn.textContent = 'Retry';
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
                            <div style="font-weight: bold; margin-bottom: 8px; font-size: 14px;">❌ Cannot reach J.H AI Agent</div>
                            <p style="margin: 4px 0 12px 0; font-size: 12px; color: var(--text-color); opacity: 0.8; line-height: 1.4;">
                                The agent is not running, or the connection details are wrong.
                            </p>
                            <ol style="margin: 0; padding-left: 18px; font-size: 11.5px; color: var(--text-color); opacity: 0.8; line-height: 1.6;">
                                <li>Check that the <strong>J.H AI Agent</strong> app is running.</li>
                                <li>In the agent, press <strong>Settings → General → 📤 Export Connection</strong> — that writes out the details this editor reads.</li>
                                <li>Or enter the URL and token by hand in <strong>⚙️ Settings → Agent</strong>.</li>
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
                    this.resultContent.textContent = 'Error: ' + e.message;
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

    /**
     * Fetch JHAI-registered intents and render a quick-action button per intent.
     * Clicking a button runs that intent via the MCP adapter (JHEditor exposes its
     * buffer as tools; JHAI's LLM pulls what it needs and returns a result).
     */
    async _populateIntents(context) {
        let intents = [];
        try {
            intents = await listJhaiIntents();
        } catch (_) {
            return;
        }
        // The modal may have been closed while we awaited.
        if (!this.element || !intents.length) return;
        const bar = this.element.querySelector('.inline-ai-intents');
        if (!bar) return;

        // Offer selection-scoped intents when text is selected, document-scoped
        // ones otherwise; intents without a scope are always shown.
        const selected = hasEditorSelection();
        const wanted = selected ? 'selection' : 'document';
        const visible = intents.filter((it) => !it.scope || it.scope === wanted);
        if (!visible.length) return;

        bar.innerHTML = '';
        visible.forEach((it) => {
            const b = document.createElement('button');
            b.className = 'inline-ai-intent-btn';
            b.textContent = `✨ ${it.title}`;
            b.title = `JHAI intent: ${it.id}`;
            b.style.cssText = 'background:rgba(10,108,255,0.15);border:1px solid rgba(10,108,255,0.4);color:inherit;padding:3px 8px;border-radius:5px;cursor:pointer;font-size:11px;';
            b.onclick = () => this.handleIntent(it.id, context);
            bar.appendChild(b);
        });
        bar.style.display = 'flex';
    }

    /** Run the free-text input as a freeform JHAI task (LLM auto-selects tools). */
    async handleFreeform(context) {
        const prompt = this.promptInput.value.trim();
        if (!prompt) return;

        this.resultArea.style.display = 'block';
        this.resultContent.textContent = 'Thinking...';

        const genBtn = this.element.querySelector('.inline-ai-gen-btn');
        const stopBtn = this.element.querySelector('.inline-ai-stop-btn');
        const reviewBar = this.element.querySelector('.inline-ai-review-bar');
        genBtn.style.display = 'none';
        stopBtn.style.display = 'none';
        reviewBar.style.display = 'none';

        try {
            const onEvent = (event, data) => this._showInlineStatus(event, data);
            const envelope = await runJhaiFreeform(prompt, context, { onEvent });
            const p = (envelope && envelope.payload) || {};
            const md = p.md || p.markdown || p.text
                || (envelope && envelope.summary) || '(no result)';

            this._renderResultMarkdown(md);

            const resultActions = this.element.querySelector('.result-actions');
            resultActions.style.display = 'flex';
            genBtn.style.display = 'inline-block';
            genBtn.textContent = 'Retry';
            if (this.onPreview) this.onPreview(md);
        } catch (e) {
            const msg = (e && e.message) || String(e);
            this.resultContent.textContent = 'Error: ' + msg;
            genBtn.style.display = 'inline-block';
        }
    }

    /** Run a JHAI MCP intent and render its result envelope inline. */
    async handleIntent(intentId, context) {
        this.resultArea.style.display = 'block';
        this.resultContent.textContent = 'Thinking...';

        const genBtn = this.element.querySelector('.inline-ai-gen-btn');
        const stopBtn = this.element.querySelector('.inline-ai-stop-btn');
        const reviewBar = this.element.querySelector('.inline-ai-review-bar');
        genBtn.style.display = 'none';
        stopBtn.style.display = 'none'; // intents resolve as a unit (no chunk stream to abort)
        reviewBar.style.display = 'none';

        const prompt = this.promptInput.value.trim();
        try {
            const onEvent = (event, data) => this._showInlineStatus(event, data);
            const envelope = await runJhaiIntent(intentId, prompt || undefined, { onEvent });
            const p = (envelope && envelope.payload) || {};
            const md = p.md || p.markdown || p.text
                || (envelope && envelope.summary) || '(no result)';

            this._renderResultMarkdown(md);

            const resultActions = this.element.querySelector('.result-actions');
            resultActions.style.display = 'flex';
            genBtn.style.display = 'inline-block';
            genBtn.textContent = 'Retry';
            if (this.onPreview) this.onPreview(md);
        } catch (e) {
            const msg = (e && e.message) || String(e);
            const low = msg.toLowerCase();
            if (low.includes('not available') || low.includes('not reachable') || low.includes('failed to fetch')) {
                this.resultContent.textContent = '❌ Cannot reach J.H AI Agent. Start the Agent, then run Settings → General → Export Connection.';
            } else {
                this.resultContent.textContent = 'Error: ' + msg;
            }
            genBtn.style.display = 'inline-block';
        }
    }

    /** Update the inline result area with a live status line while a task streams. */
    _showInlineStatus(event, data) {
        if (!this.resultContent) return;
        let text = null;
        if (event === 'status' && data.message) text = String(data.message);
        else if (event === 'tool_call' && data.name) text = `🛠 ${data.name}`;
        else if (event === 'thought' && typeof data.text === 'string') text = data.text.replace(/\s+/g, ' ').slice(0, 100);
        if (text) this.resultContent.textContent = `⏳ ${text}`;
    }

    /** Render markdown into the result area with code syntax highlighting. */
    _renderResultMarkdown(text) {
        if (text && typeof marked !== 'undefined') {
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
            this.resultContent.innerHTML = sanitizeHtml(marked.parse(text, { renderer }));
            this.resultContent.style.userSelect = 'text';
            this.resultContent.style.cursor = 'text';
            this.resultContent.querySelectorAll('pre').forEach((pre) => {
                pre.style.position = 'relative';
                pre.style.userSelect = 'text';
                pre.querySelectorAll('code').forEach((c) => { c.style.userSelect = 'text'; });
            });
        } else {
            this.resultContent.textContent = text || '';
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
            this.element.querySelector('.inline-ai-gen-btn').textContent = 'Send';

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
