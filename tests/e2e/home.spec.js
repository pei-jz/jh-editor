import { test, expect } from '@playwright/test';

// Real-behaviour E2E tests. These drive the actual DOM through the same event
// handlers the app wires up in App.js, rather than injecting fake DOM or a
// (nonexistent) window.__TEST_MODE__ flag. Anything that needs the Tauri
// backend (folder pickers, filesystem, terminal PTY) is out of scope here and
// covered at the unit level; these tests verify the UI wiring that runs in a
// plain browser.

test.describe('JHEditor E2E', () => {
  test('welcome screen is shown on startup', async ({ page }) => {
    await page.goto('/');

    const welcomeScreen = page.locator('#welcome-screen');
    await expect(welcomeScreen).toBeVisible();
    await expect(page.locator('#welcome-screen h1')).toHaveText('J.H Editor');
    await expect(page.locator('#welcome-open-folder-btn')).toBeVisible();
  });

  test('settings modal opens and switching theme applies it to the document', async ({ page }) => {
    await page.goto('/');

    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-modal')).toBeVisible();

    const themeSelector = page.locator('#theme-selector');
    await expect(themeSelector).toBeVisible();

    // Apply a non-default theme through the real onchange handler.
    await themeSelector.selectOption('nord');
    await expect(page.locator('body')).toHaveClass(/theme-nord/);

    // Back to light: applyTheme removes every theme-* class.
    await themeSelector.selectOption('light');
    await expect(page.locator('body')).not.toHaveClass(/theme-(nord|dark|midnight|latte|sumi-e)/);
  });

  test('language selector switches the UI chrome to Japanese', async ({ page }) => {
    await page.goto('/');

    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-modal')).toBeVisible();

    const langSelector = page.locator('#language-selector');
    await expect(langSelector).toBeVisible();
    await langSelector.selectOption('ja');

    // Static chrome is localised through data-i18n.
    await expect(page.locator('[data-i18n="Settings"]').first()).toHaveText('設定');
    await expect(page.locator('#welcome-open-folder-btn')).toHaveText('フォルダーを開く');

    // Back to English for a clean state.
    await langSelector.selectOption('en');
    await expect(page.locator('#welcome-open-folder-btn')).toHaveText('Open Folder');
  });

  test('new-file button opens the New File modal', async ({ page }) => {
    await page.goto('/');

    // The New File button only exists inside the (initially hidden) main
    // layout, but the handler is wired regardless; force the layout visible the
    // same way selecting a workspace does.
    await page.evaluate(() => {
      document.getElementById('welcome-screen').style.display = 'none';
      document.getElementById('main-layout').style.display = 'flex';
    });

    const newTabBtn = page.locator('#new-tab-btn');
    await expect(newTabBtn).toBeVisible();
    await newTabBtn.click();

    // createNewFileAction → NewFileModal.show renders the #new-file-overlay.
    await expect(page.locator('#new-file-overlay')).toBeVisible();
  });

  test('commands button opens the shortcut guide', async ({ page }) => {
    await page.goto('/');

    // The Commands button lives in the status bar of the hidden main layout;
    // make it visible before interacting.
    await page.evaluate(() => {
      document.getElementById('welcome-screen').style.display = 'none';
      document.getElementById('main-layout').style.display = 'flex';
    });

    const commandsBtn = page.locator('#status-commands');
    await expect(commandsBtn).toBeVisible();
    await commandsBtn.click();

    await expect(page.locator('#shortcut-guide-overlay')).toBeVisible();
    await expect(page.locator('#shortcut-list li').first()).toBeVisible();
  });
});
