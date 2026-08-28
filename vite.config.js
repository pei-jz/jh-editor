
import { defineConfig } from 'vite';

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
    clearScreen: false,
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
            output: {
                manualChunks: (id) => {
                    if (id.includes('node_modules')) {
                        if (id.includes('@tauri-apps')) return 'tauri';
                        // Heavy, view-specific dependencies are dynamically
                        // imported at their point of use. Forcing them into the
                        // 'vendor' chunk would defeat that lazy split (shiki is
                        // 10MB+ of WASM + grammars and only serves Markdown/
                        // diff/structure code blocks, never the editor itself).
                        // Returning undefined lets Vite chunk them by their own
                        // dynamic-import boundary instead.
                        if (id.includes('shikijs') || id.includes('/shiki/') || id.includes('oniguruma') || id.includes('vscode-textmate')) return undefined;
                        if (id.includes('/katex/')) return undefined;
                        return 'vendor'; // Split other vendors
                    }
                }
            }
        }
    },
});
