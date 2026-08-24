import { createHighlighter } from 'shiki';

let highlighter = null;
let initializationPromise = null;

export const ShikiHighlighter = {
    async init() {
        if (highlighter) return highlighter;
        if (initializationPromise) return initializationPromise;

        initializationPromise = createHighlighter({
            // github-dark-high-contrast has the brightest foreground and keeps
            // vivid, high-contrast tokens that stay readable on every dark theme
            // background (default dark, midnight navy, solarized-dark teal), where
            // plain github-dark looked dim.
            themes: ['github-dark', 'github-light', 'github-dark-high-contrast'],
            langs: [
                'javascript', 'typescript', 'rust', 'json', 'html', 
                'css', 'sql', 'java', 'xml', 'toml', 'yaml', 'markdown', 'python',
                'shell', 'bash', 'c', 'cpp', 'csharp', 'go', 'ruby', 'php',
                'swift', 'kotlin', 'dockerfile', 'ini', 'bat', 'powershell', 'vue', 'svelte'
            ]
        }).then(h => {
            highlighter = h;
            return h;
        });

        return initializationPromise;
    },

    highlight(code, lang, theme = 'github-dark') {
        if (!highlighter) {
            // Return escaped code if not initialized yet
            return this.escapeHtml(code);
        }

        try {
            const mappedLang = this._mapLang(lang);
            // Verify if the language is loaded to avoid ShikiError crash on unsupported files
            const loadedLangs = highlighter.getLoadedLanguages();
            if (!loadedLangs.includes(mappedLang)) {
                return this.escapeHtml(code);
            }

            // Shiki's codeToHtml returns a full <pre><code> block
            // We want just the inner content or we'll wrap it
            const html = highlighter.codeToHtml(code, {
                lang: mappedLang,
                theme: theme
            });
            
            // Extract the content inside <pre><code>
            const match = html.match(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/);
            return match ? match[1] : html;
        } catch (e) {
            console.error('Shiki highlight error:', e);
            return this.escapeHtml(code);
        }
    },

    /**
     * Whether the app is currently in a dark theme. Mirrors applyTheme()'s class
     * scheme: the default "light" theme adds NO class, light variants use
     * theme-latte / theme-solarized-light / theme-paper*, and only these four
     * are dark.
     */
    isDarkTheme() {
        const c = document.body.classList;
        return c.contains('theme-dark') || c.contains('theme-midnight')
            || c.contains('theme-solarized-dark') || c.contains('theme-bamboo-ancient')
            || c.contains('theme-nord');
    },

    /** The Shiki theme name matching the current app theme. */
    getActiveTheme() {
        // github-dark-high-contrast gives clearly readable, high-contrast tokens
        // on every dark app theme (default dark #1e1e1e, midnight navy,
        // solarized-dark teal), where github-dark's muted palette looked dim.
        return this.isDarkTheme() ? 'github-dark-high-contrast' : 'github-light';
    },

    _mapLang(lang) {
        const l = lang.toLowerCase();
        const map = {
            'js': 'javascript',
            'ts': 'typescript',
            'rs': 'rust',
            'jsx': 'javascript',
            'tsx': 'typescript',
            'xsd': 'xml',
            'wsdl': 'xml',
            'py': 'python',
            'properties': 'ini',
            'sh': 'shell',
            'c++': 'cpp',
            'c#': 'csharp',
            'docker': 'dockerfile',
            'ps1': 'powershell'
        };
        return map[l] || l;
    },

    escapeHtml(text) {
        return text.replace(/[&<>"']/g, function (m) {
            switch (m) {
                case '&': return '&amp;';
                case '<': return '&lt;';
                case '>': return '&gt;';
                case '"': return '&quot;';
                case "'": return '&#39;';
            }
        });
    }
};
