import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    // Playwright specs must not be picked up by vitest — they call
    // test.describe() from @playwright/test and abort the whole run
    // (which also broke `--coverage`).
    exclude: ['node_modules/**', 'dist/**', 'tests/e2e/**'],

    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text', 'html'],

      // "Logic" = everything that can be reasoned about without a live DOM
      // tree, a Tauri backend or a CodeMirror instance. Views/editors/UI are
      // driven by real widgets and are covered by the e2e suite instead;
      // holding them to a unit-test threshold would only invite fake tests.
      include: [
        'src/modules/utils/**/*.js',
        'src/modules/core/Store.js',
        'src/modules/core/Session.js',
        'src/modules/core/Panes.js',
        'src/modules/core/ShortcutManager.js',
        'src/modules/core/ShortcutDefinitions.js',
        'src/modules/core/PluginManager.js',
      ],
      exclude: [
        // Thin wrappers over Tauri IPC / Web Worker plumbing: there is no
        // behaviour here that can be observed without a backend or a real
        // Worker, so a unit test could only assert the mock.
        'src/modules/utils/FileSystem.js',
        'src/modules/utils/AsyncParser.js',
        'src/modules/utils/AsyncCsvParser.js',
        'src/modules/utils/AsyncFormatter.js',
        '**/*.worker.js',
      ],

      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
});
