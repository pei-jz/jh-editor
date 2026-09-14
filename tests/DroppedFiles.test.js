import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let answer = null;
vi.mock('@tauri-apps/api/event', () => ({
    listen: vi.fn(async (event, callback) => {
        answer = callback;
        return () => {};
    }),
}));

const {
    DROP_MESSAGE_PREFIX, DROP_RESULT_EVENT, initDroppedFiles, isExternalFileDrag,
    canResolveDroppedPaths, resolveDroppedPaths,
} = await import('../src/modules/utils/DroppedFiles.js');

const file = (name) => new File(['x'], name, { type: 'text/plain' });

/** A WebView2 host that answers every request with `paths`. */
function hostAnswering(paths) {
    const post = vi.fn((message) => {
        const id = message.slice(DROP_MESSAGE_PREFIX.length);
        queueMicrotask(() => answer({ event: DROP_RESULT_EVENT, payload: { id, paths } }));
    });
    window.chrome = { webview: { postMessageWithAdditionalObjects: post } };
    return post;
}

beforeEach(() => {
    initDroppedFiles();
});

afterEach(() => {
    delete window.chrome;
    vi.useRealTimers();
});

describe('DroppedFiles', () => {
    it('hands the files to the host and resolves with the paths it reports', async () => {
        const post = hostAnswering(['C:\\proj\\a.txt', 'C:\\proj\\b.md']);
        const files = [file('a.txt'), file('b.md')];
        await expect(resolveDroppedPaths(files)).resolves.toEqual(['C:\\proj\\a.txt', 'C:\\proj\\b.md']);
        expect(post).toHaveBeenCalledTimes(1);
        expect(post.mock.calls[0][0].startsWith(DROP_MESSAGE_PREFIX)).toBe(true);
        expect(post.mock.calls[0][1]).toEqual(files);
    });

    it('ignores answers meant for another request (another window)', async () => {
        window.chrome = { webview: { postMessageWithAdditionalObjects: vi.fn((message) => {
            const id = message.slice(DROP_MESSAGE_PREFIX.length);
            queueMicrotask(() => {
                answer({ payload: { id: 'someone-else', paths: ['C:/wrong.txt'] } });
                answer({ payload: { id, paths: ['C:/right.txt'] } });
            });
        }) } };
        await expect(resolveDroppedPaths([file('right.txt')])).resolves.toEqual(['C:/right.txt']);
    });

    it('resolves to nothing outside WebView2, without trying', async () => {
        expect(canResolveDroppedPaths()).toBe(false);
        await expect(resolveDroppedPaths([file('a.txt')])).resolves.toEqual([]);
    });

    it('gives up after a while when the host never answers', async () => {
        vi.useFakeTimers();
        window.chrome = { webview: { postMessageWithAdditionalObjects: vi.fn() } };
        const pending = resolveDroppedPaths([file('a.txt')], { timeoutMs: 1000 });
        vi.advanceTimersByTime(1000);
        await expect(pending).resolves.toEqual([]);
    });

    it('resolves to nothing when the host refuses the files', async () => {
        window.chrome = { webview: { postMessageWithAdditionalObjects: vi.fn(() => { throw new Error('unsupported object'); }) } };
        await expect(resolveDroppedPaths([file('a.txt')])).resolves.toEqual([]);
    });

    it('ignores an empty drop without asking the host', async () => {
        const post = hostAnswering(['C:/never.txt']);
        await expect(resolveDroppedPaths([])).resolves.toEqual([]);
        expect(post).not.toHaveBeenCalled();
    });

    it('drops malformed paths from the answer', async () => {
        hostAnswering(['C:/ok.txt', '', null, 42]);
        await expect(resolveDroppedPaths([file('ok.txt')])).resolves.toEqual(['C:/ok.txt']);
    });

    it('tells external file drags from the app\'s own tab and explorer drags', () => {
        expect(isExternalFileDrag({ types: ['Files'] })).toBe(true);
        expect(isExternalFileDrag({ types: ['application/x-jheditor-tab', 'Files'] })).toBe(false);
        expect(isExternalFileDrag({ types: ['text/plain'] })).toBe(false);
        expect(isExternalFileDrag(null)).toBe(false);
    });
});

/* Structural: the Rust side cannot run under vitest. */
describe('host side', () => {
    it('uses the same message prefix and event name as the page', async () => {
        const { readFileSync } = await import('node:fs');
        const { fileURLToPath } = await import('node:url');
        const { dirname, join } = await import('node:path');
        const here = dirname(fileURLToPath(import.meta.url));
        const rust = readFileSync(join(here, '..', 'src-tauri/src/commands/file_drop.rs'), 'utf8');
        expect(rust).toContain(`pub const DROP_MESSAGE_PREFIX: &str = "${DROP_MESSAGE_PREFIX}";`);
        expect(rust).toContain(`pub const DROP_RESULT_EVENT: &str = "${DROP_RESULT_EVENT}";`);
        const lib = readFileSync(join(here, '..', 'src-tauri/src/lib.rs'), 'utf8');
        expect(lib).toContain('commands::file_drop::install(webview)');
    });
});
