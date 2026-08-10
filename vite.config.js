
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
                        return 'vendor'; // Split other vendors
                    }
                }
            }
        }
    },
});
