
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { aiClientAlias, hasAiClient } from './scripts/ai-client-alias.js';

const host = process.env.TAURI_DEV_HOST;
const root = fileURLToPath(new URL('.', import.meta.url));

// @jh/ai-client comes from ../jh-ai-agent. Without that checkout the editor
// still builds, with the AI commands reporting that they are not included.
if (!hasAiClient(root)) {
    console.warn('[jh-editor] @jh/ai-client not found (../jh-ai-agent is not checked out) — building without AI features.');
}

export default defineConfig({
    clearScreen: false,
    resolve: {
        alias: aiClientAlias(root),
    },
    server: {
        port: 1425,
        strictPort: true,
        host: host || false,
        hmr: host
            ? {
                protocol: 'ws',
                host,
                port: 1426,
            }
            : undefined,
        watch: {
            // Don't let the dev server full-reload the page when the user edits
            // and saves non-source files inside the project (e.g. dogfooding
            // JHEditor on its own repo). Saving files in these dirs no longer
            // reloads. NOTE: editing actual frontend source under src/ still
            // triggers HMR by design — use the production build to avoid that.
            ignored: [
                '**/src-tauri/**',
                '**/target/**',
                '**/node_modules/**',
                '**/dist/**',
                '**/.git/**',
                '**/docs/**',
                '**/test_data/**',
                '**/test-results/**',
                '**/playwright-report/**',
                '**/scratch/**',
                '**/.tmp/**',
            ],
        },
    },
    build: {
        outDir: 'dist',
        rollupOptions: {
            // 2 つ目のページ: Deck View の発表用ウィンドウ (src/deck-audience.js)
            input: {
                main: 'index.html',
                'deck-audience': 'deck-audience.html',
            },
            output: {
                manualChunks: (id) => {
                    if (id.includes('node_modules')) {
                        if (id.includes('@tauri-apps')) return 'tauri';
                        // Heavy, view-specific dependencies are dynamically
                        // imported at their point of use; forcing them into the
                        // 'vendor' chunk would defeat that lazy split. Returning
                        // undefined lets Vite chunk them by their own
                        // dynamic-import boundary instead.
                        //
                        // shiki was the reason this existed: 6.8 MB of TextMate
                        // grammars for languages nothing asked for. It is gone —
                        // highlighting uses the editor's own Lezer parsers now
                        // (utils/CMHighlighter.js).
                        if (id.includes('/katex/')) return undefined;
                        // ELK (Mermaid's layout engine, ~4 MB) is fetched with
                        // the first diagram — see Markdown.js ensureElk().
                        // Its build imports d3 and elkjs by name, so those
                        // have to stay out of 'vendor' with it.
                        if (/\/node_modules\/(@mermaid-js\/layout-elk|elkjs|d3|d3-[^/]+|internmap|delaunator|robust-predicates)\//.test(id)) {
                            return undefined;
                        }
                        return 'vendor'; // Split other vendors
                    }
                }
            }
        }
    },
});
