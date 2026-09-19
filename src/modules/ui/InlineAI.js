import { t } from '../utils/I18n.js';
import { icon as svgIcon } from './Icons.js';
import { hasEditorSelection, runInlinePreset, runInlinePrompt, listInlinePresets } from '../ai/JhAiMcp.js';

/**
 * InlineAI — the small "ask the AI about this" popup at the cursor.
 *
 * Every request it makes now runs as a task in the activity dock, and the popup
 * closes the moment one starts.
 *
 * It used to do two different things depending on which half of it you used.
 * The preset buttons along the top ran as dock tasks and let go of the editor;
 * a typed instruction streamed its answer into the popup instead, which meant
 * the popup stayed open — anchored over the very code the question was about —
 * and the editor stayed still, for as long as the model took. Same model, same
 * kind of question, same wait; only one of them let you keep working through
 * it. There was no rule a user could learn from that, only a surprise.
 *
 * So the popup is now a way to ASK, and never a place to wait. Where the answer
 * appears is decided by what came back, not by how it was asked — see
 * runInlinePrompt in ai/JhAiMcp.js.
 */
export class InlineAI {
    constructor(editor) {
        this.editor = editor; // Reference to PlainTextView or similar
        this.element = null;
        this.promptInput = null;
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
                </div>
            </div>
            <div class="inline-ai-hint"></div>
        `;

        document.body.appendChild(modal);
        this.element = modal;

        // Ensure modal is within viewport
        const mRect = modal.getBoundingClientRect();
        if (mRect.right > window.innerWidth) modal.style.left = `${window.innerWidth - mRect.width - 20}px`;
        if (mRect.bottom > window.innerHeight) modal.style.top = `${y - mRect.height - 40}px`;

        this.promptInput = modal.querySelector('.inline-ai-input');
        this.promptInput.focus();

        // Says where the answer will turn up, because it is not here. Without
        // it, sending looks like the popup simply closed on you.
        const hint = modal.querySelector('.inline-ai-hint');
        if (hint) {
            hint.textContent = t('The answer appears in the activity panel, bottom right.');
            hint.style.cssText = 'font-size:10.5px;opacity:.6;margin-top:6px;line-height:1.35;';
        }

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

        modal.querySelector('.inline-ai-close').onclick = () => this.hide();
        modal.querySelector('.inline-ai-gen-btn').onclick = () => this.handleGenerate(context);

        this.promptInput.onkeydown = (e) => {
            if (e.key === 'Escape') {
                this.hide();
                return;
            }
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.handleGenerate(context);
            }
        };
    }

    /**
     * Hand the typed instruction to the dock and get out of the way.
     *
     * Nothing is awaited: the task owns the request from here, including its
     * Stop button and wherever the answer ends up. The popup's job is over the
     * moment the question has been asked.
     */
    handleGenerate(context) {
        const prompt = this.promptInput ? this.promptInput.value.trim() : '';
        if (!prompt) return;
        // The launch/download guidance lives inside runSingleShot (via
        // ensureAgentAvailable), and it reaches the user through the dock card.
        runInlinePrompt(prompt, context).catch((e) => console.warn('inline prompt failed:', e));
        this.hide();
    }

    hide() {
        if (this.element) {
            this.isVisible = false;
            this.element.remove();
            this.element = null;
            this.promptInput = null;
        }
    }

    destroy() {
        this.hide();
    }
}
