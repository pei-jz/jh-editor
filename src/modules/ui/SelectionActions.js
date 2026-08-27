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

/** Run a quick AI transform over the selection and open the result as Markdown. */
async function runSelectionAction({ title, instruction, replace = false }) {
    const selection = getSelection();
    if (!selection || !selection.trim()) {
        Toast.info('Select some text first.');
        return;
    }

    const fileName = getActiveFileName();
    Toast.info(`${title}…`);

    try {
        const systemPrompt =
            'You are a text assistant inside JHEditor. Respond in Japanese. '
            + 'Use Markdown. Return ONLY the requested result.';
        const result = await AIAgent.runSingleShot({
            prompt: `${instruction}\n\n--- 選択されたテキスト ---\n${selection}`,
            systemPrompt,
            context: { app: 'jheditor', file: fileName },
        });

        if (!result || !result.trim()) {
            Toast.error(`${title} returned nothing.`);
            return;
        }

        if (replace) {
            // Replace the selection with the result.
            const view = window.app?.getCurrentView?.();
            if (view && typeof view.replaceSelectedText === 'function') {
                view.replaceSelectedText(result);
                Toast.success(`${title} applied.`);
                return;
            }
        }

        // Default: open as a Markdown tab.
        if (window.app?.openMarkdownResult) {
            window.app.openMarkdownResult(`${title}: ${fileName.split(/[\\/]/).pop()}`, result);
        } else {
            Toast.error('Could not open the result.');
        }
    } catch (e) {
        const msg = (e && e.message) || String(e);
        if (/not reachable|failed to fetch|connection refused/i.test(msg)) {
            Toast.error('Cannot reach J.H AI Agent. Start the agent and try again.');
        } else {
            Toast.error(`${title} failed: ${msg}`);
        }
    }
}

export const SelectionActions = {
    summarize() {
        return runSelectionAction({
            title: 'Summarize',
            instruction: '選択されたテキストを簡潔に要約してください。箇条書きで要点をまとめてください。',
        });
    },
    translate() {
        return runSelectionAction({
            title: 'Translate',
            instruction: '選択されたテキストを日本語に翻訳してください。',
        });
    },
    rephrase() {
        return runSelectionAction({
            title: 'Rephrase',
            instruction: '選択されたテキストを、意味を保ったまま自然で読みやすく言い換えてください。',
        });
    },
};
