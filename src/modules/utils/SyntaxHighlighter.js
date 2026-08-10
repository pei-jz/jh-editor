import { ShikiHighlighter } from './ShikiHighlighter.js';

export const SyntaxHighlighter = {
    async init() {
        return ShikiHighlighter.init();
    },

    highlight(code, lang) {
        // Shiki highlight is sync after init, but we need to ensure it's initialized.
        // The view will re-render once init is complete. Use the shared theme
        // selector so the editor and diff view stay consistent and the dark
        // themes get the brighter dark-plus palette.
        const theme = ShikiHighlighter.getActiveTheme();
        return ShikiHighlighter.highlight(code, lang, theme);
    },

    escapeHtml(text) {
        return ShikiHighlighter.escapeHtml(text);
    }
};
