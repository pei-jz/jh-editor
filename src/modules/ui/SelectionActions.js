/**
 * SelectionActions.js — AI on the current selection (Phase 1 quick wins).
 *
 * Summarize / translate / rephrase the selected text using the lightweight
 * single-shot path (AIAgent.runSingleShot). Results open as a Markdown editor
 * tab (reuse window.app.openMarkdownResult) so they are full-size, copyable,
 * and never silently write into the buffer.
 */

import AIAgent from '../ai/AIAgent.js';
import { Toast } from './Toast.js';
import { t, promptLanguageName } from '../utils/I18n.js';

function getSelection() {
    try {
        const view = window.app?.getCurrentView?.();
        if (view && typeof view.getSelectedText === 'function') {
            return view.getSelectedText() || '';
        }
    } catch (_) { /* ignore */ }
    return '';
}

function getActiveFileName() {
    try {
        const f = window.app?.getActiveFile?.();
        return f ? (f.path || f.name || 'selection') : 'selection';
    } catch (_) { return 'selection'; }
}

/**
 * Per-language instruction for a transform. The UI language decides the OUTPUT
 * language, so "Translate" means "translate into the configured language".
 */
function instructionFor(kind) {
    const lang = promptLanguageName();
    switch (kind) {
        case 'summarize':
            return {
                en: 'Summarize the selected text concisely. Use bullet points for the key points.',
                ja: '選択されたテキストを簡潔に要約してください。箇条書きで要点をまとめてください。',
                zh: '请简洁地总结所选文本，并用项目符号列出要点。',
                ko: '선택된 텍스트를 간결하게 요약하세요. 핵심을 글머리 기호로 정리하세요.',
            }[lang] || 'Summarize the selected text concisely. Use bullet points for the key points.';
        case 'translate':
            return {
                en: 'Translate the selected text into English.',
                ja: '選択されたテキストを日本語に翻訳してください。',
                zh: '请将所选文本翻译成中文。',
                ko: '선택된 텍스트를 한국어로 번역하세요.',
            }[lang] || 'Translate the selected text into English.';
        case 'rephrase':
            return {
                en: 'Rephrase the selected text to be natural and readable while keeping the meaning.',
                ja: '選択されたテキストを、意味を保ったまま自然で読みやすく言い換えてください。',
                zh: '请改写所选文本，使其更自然易读，同时保留原意。',
                ko: '선택된 텍스트를 의미를 유지하면서 자연스럽고 읽기 쉽게 바꿔 쓰세요.',
            }[lang] || 'Rephrase the selected text to be natural and readable while keeping the meaning.';
        default:
            return '';
    }
}

/** The "--- selected text ---" separator in the prompt, in the configured language. */
function selectionSeparator() {
    const lang = promptLanguageName();
    return {
        en: '--- selected text ---',
        ja: '--- 選択されたテキスト ---',
        zh: '--- 所选文本 ---',
        ko: '--- 선택된 텍스트 ---',
    }[lang] || '--- selected text ---';
}

/** Run a quick AI transform over the selection and open the result as Markdown. */
async function runSelectionAction({ title, instruction, replace = false }) {
    const selection = getSelection();
    if (!selection || !selection.trim()) {
        Toast.info(t('Select some text first.'));
        return;
    }

    const fileName = getActiveFileName();
    Toast.info(t('{title}…', { title }));

    try {
        const systemPrompt =
            `You are a text assistant inside JHEditor. Respond in ${promptLanguageName()}. `
            + 'Use Markdown. Return ONLY the requested result.';
        const result = await AIAgent.runSingleShot({
            prompt: `${instruction}\n\n${selectionSeparator()}\n${selection}`,
            systemPrompt,
            context: { app: 'jheditor', file: fileName },
        });

        if (!result || !result.trim()) {
            Toast.error(t('{title} returned nothing.', { title }));
            return;
        }

        if (replace) {
            // Replace the selection with the result.
            const view = window.app?.getCurrentView?.();
            if (view && typeof view.replaceSelectedText === 'function') {
                view.replaceSelectedText(result);
                Toast.success(t('{title} applied.', { title }));
                return;
            }
        }

        // Default: open as a Markdown tab.
        if (window.app?.openMarkdownResult) {
            window.app.openMarkdownResult(`${title}: ${fileName.split(/[\\/]/).pop()}`, result);
        } else {
            Toast.error(t('Could not open the result.'));
        }
    } catch (e) {
        const msg = (e && e.message) || String(e);
        if (/not reachable|failed to fetch|connection refused/i.test(msg)) {
            Toast.error(t('Cannot reach J.H AI Agent. Start the agent and try again.'));
        } else {
            Toast.error(t('{title} failed: {msg}', { title, msg }));
        }
    }
}

export const SelectionActions = {
    summarize() {
        return runSelectionAction({
            title: t('Summarize'),
            instruction: instructionFor('summarize'),
        });
    },
    translate() {
        return runSelectionAction({
            title: t('Translate'),
            instruction: instructionFor('translate'),
        });
    },
    rephrase() {
        return runSelectionAction({
            title: t('Rephrase'),
            instruction: instructionFor('rephrase'),
        });
    },
};
