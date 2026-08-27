import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as FS from '../src/modules/utils/FileSystem.js';

// Mock Tauri modules
vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn()
}));

vi.mock('@tauri-apps/api/event', () => ({
    listen: vi.fn().mockResolvedValue(vi.fn())
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
    stat: vi.fn()
}));

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { stat } from '@tauri-apps/plugin-fs';

describe('FileSystem Utilities', () => {
    beforeEach(() => {
        vi.mocked(invoke).mockReset();
        vi.mocked(stat).mockReset();
    });

    describe('onSearchProgress and onScanProgress', () => {
        it('should listen to search/scan progress events', async () => {
            const cb = vi.fn();
            await FS.onSearchProgress(cb);
            expect(listen).toHaveBeenCalledWith('search-progress', cb);

            await FS.onScanProgress(cb);
            expect(listen).toHaveBeenCalledWith('scan-progress', cb);
        });
    });

    describe('getOsLineEnding', () => {
        it('should detect Windows line endings based on User Agent', () => {
            Object.defineProperty(global.navigator, 'userAgent', {
                value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                writable: true,
                configurable: true
            });
            expect(FS.getOsLineEnding()).toBe('\r\n');
        });

        it('should detect Mac line endings based on User Agent', () => {
            Object.defineProperty(global.navigator, 'userAgent', {
                value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
                writable: true,
                configurable: true
            });
            expect(FS.getOsLineEnding()).toBe('\n');
        });

        it('should detect Linux line endings based on User Agent', () => {
            Object.defineProperty(global.navigator, 'userAgent', {
                value: 'Mozilla/5.0 (X11; Linux x86_64)',
                writable: true,
                configurable: true
            });
            expect(FS.getOsLineEnding()).toBe('\n');
        });
    });

    /* This used to go through @tauri-apps/plugin-fs's `stat`, which obeys the
       plugin's fs:scope. With that scope set to $HOME/**, every workspace
       elsewhere was refused — and the refusal came back as null, so the status
       bar showed no modification date at all, for every file, forever. The
       backend command takes the path it is given, like every other read in
       this app. */
    describe('getFileStats', () => {
        it('asks the backend, not the scoped plugin', async () => {
            const stats = { size: 100, mtime: 1772668800000 };
            vi.mocked(invoke).mockResolvedValue(stats);

            const res = await FS.getFileStats('/test/path');
            expect(res).toBe(stats);
            expect(invoke).toHaveBeenCalledWith('file_stats', { path: '/test/path' });
            expect(stat).not.toHaveBeenCalled();
        });

        // A deleted or unreadable file is a normal answer, not a fault.
        it('returns null when the file cannot be stat-ed', async () => {
            vi.mocked(invoke).mockRejectedValue(new Error('File not found'));
            expect(await FS.getFileStats('/test/path')).toBeNull();
        });
    });

    describe('readFileText', () => {
        it('decodes the bytes the backend hands back', async () => {
            const bytes = [...new TextEncoder().encode('hello')];
            vi.mocked(invoke).mockResolvedValue(bytes);
            expect(await FS.readFileText('/test/path')).toBe('hello');
            expect(invoke).toHaveBeenCalledWith('read_file', { path: '/test/path' });
        });

        it('returns null rather than throwing at the caller', async () => {
            vi.mocked(invoke).mockRejectedValue(new Error('EACCES'));
            expect(await FS.readFileText('/test/path')).toBeNull();
        });
    });

    describe('readDirectory', () => {
        it('should invoke read_dir and return filtered and transformed directory entries', async () => {
            const mockRustEntries = [
                { name: 'dir1', is_directory: true, path: '/root/dir1' },
                { name: 'file1.txt', is_directory: false, path: '/root/file1.txt' },
                { name: 'binary.exe', is_directory: false, path: '/root/binary.exe' }, // should be filtered out
            ];
            vi.mocked(invoke).mockResolvedValue(mockRustEntries);

            const result = await FS.readDirectory('/root');
            expect(invoke).toHaveBeenCalledWith('read_dir', { path: '/root' });
            expect(result.length).toBe(2);
            expect(result[0]).toEqual({ entry: 'dir1', type: 'DIRECTORY', path: '/root/dir1' });
            expect(result[1]).toEqual({ entry: 'file1.txt', type: 'FILE', path: '/root/file1.txt' });
        });

        it('should throw error if read_dir throws', async () => {
            vi.mocked(invoke).mockRejectedValue(new Error('Read failed'));
            await expect(FS.readDirectory('/root')).rejects.toThrow('Read failed');
        });
    });

    describe('normalizeToLF', () => {
        it('should replace CRLF and CR with LF', () => {
            expect(FS.normalizeToLF('hello\r\nworld\rtest')).toBe('hello\nworld\ntest');
        });
    });

    describe('readFileAutoDetect', () => {
        it('should return contents and correct EOL', async () => {
            vi.mocked(invoke).mockResolvedValue({
                content: 'line1\r\nline2',
                encoding: 'UTF-8'
            });

            const result = await FS.readFileAutoDetect('/path');
            expect(result.content).toBe('line1\r\nline2');
            expect(result.encoding).toBe('UTF-8');
            expect(result.eol).toBe('\r\n');
        });

        it('should fallback to OS line ending if no EOL found', async () => {
            vi.mocked(invoke).mockResolvedValue({
                content: 'singleline',
                encoding: 'UTF-8'
            });
            Object.defineProperty(global.navigator, 'userAgent', {
                value: 'Linux',
                configurable: true
            });
            const result = await FS.readFileAutoDetect('/path');
            expect(result.eol).toBe('\n');
        });

        it('should propagate errors', async () => {
            vi.mocked(invoke).mockRejectedValue(new Error('Read error'));
            await expect(FS.readFileAutoDetect('/path')).rejects.toThrow('Read error');
        });
    });

    describe('readFileWithEncoding', () => {
        it('should invoke read_file_with_encoding and return file content', async () => {
            vi.mocked(invoke).mockResolvedValue({
                content: 'content in shift-jis',
                encoding: 'SHIFT-JIS'
            });

            const result = await FS.readFileWithEncoding('/path', 'shift-jis');
            expect(result.content).toBe('content in shift-jis');
            expect(result.encoding).toBe('SHIFT-JIS');
            expect(invoke).toHaveBeenCalledWith('read_file_with_encoding', { path: '/path', encoding: 'shift-jis' });
        });

        it('should propagate errors on read with encoding', async () => {
            vi.mocked(invoke).mockRejectedValue(new Error('Encoding error'));
            await expect(FS.readFileWithEncoding('/path', 'shift-jis')).rejects.toThrow('Encoding error');
        });
    });

    describe('searchFiles', () => {
        it('should search files and return mapped list', async () => {
            const mockResults = [
                { name: 'test.txt', path: './sub/test.txt', is_directory: false },
                { name: 'sub', path: './sub', is_directory: true }
            ];
            vi.mocked(invoke).mockResolvedValue(mockResults);

            const results = await FS.searchFiles('/dir', 'test', true, 123);
            expect(invoke).toHaveBeenCalledWith('search_files', {
                dir: '/dir',
                term: 'test',
                searchContent: true,
                searchId: 123
            });
            expect(results.length).toBe(2);
            expect(results[0].path).toBe('sub/test.txt');
            expect(results[0].dir).toBe('sub');
        });

        it('should propagate search errors', async () => {
            vi.mocked(invoke).mockRejectedValue(new Error('Search failed'));
            await expect(FS.searchFiles('/dir', 'test')).rejects.toThrow('Search failed');
        });
    });

    describe('writeFile, createDirectory, removeFile, rename, copyFile, exists, pasteFiles', () => {
        it('should invoke matching tauri commands', async () => {
            await FS.writeFile('/path', 'content', 'utf-8');
            expect(invoke).toHaveBeenCalledWith('write_file', { path: '/path', content: 'content', encoding: 'utf-8' });

            await FS.createDirectory('/dir');
            expect(invoke).toHaveBeenCalledWith('create_dir', { path: '/dir' });

            await FS.removeFile('/file');
            expect(invoke).toHaveBeenCalledWith('remove_file', { path: '/file' });

            await FS.rename('/old', '/new');
            expect(invoke).toHaveBeenCalledWith('rename_file', { oldPath: '/old', newPath: '/new' });

            await FS.copyFile('/src', '/dest');
            expect(invoke).toHaveBeenCalledWith('copy_file_cmd', { source: '/src', dest: '/dest' });

            await FS.exists('/path');
            expect(invoke).toHaveBeenCalledWith('exists', { path: '/path' });

            await FS.pasteFiles();
            expect(invoke).toHaveBeenCalledWith('paste_files');
        });

        it('should throw errors if tauri commands throw', async () => {
            vi.mocked(invoke).mockRejectedValue(new Error('Tauri error'));
            
            await expect(FS.writeFile('/path', 'content')).rejects.toThrow('Tauri error');
            await expect(FS.createDirectory('/dir')).rejects.toThrow('Tauri error');
            await expect(FS.removeFile('/file')).rejects.toThrow('Tauri error');
            await expect(FS.rename('/old', '/new')).rejects.toThrow('Tauri error');
            await expect(FS.copyFile('/src', '/dest')).rejects.toThrow('Tauri error');
        });
    });

    describe('joinPath, getParentDir, getBasename', () => {
        it('should join paths correctly with forward slashes', () => {
            expect(FS.joinPath('/a/b', 'c')).toBe('/a/b/c');
            expect(FS.joinPath('/a/b/', 'c')).toBe('/a/b/c');
            expect(FS.joinPath('.', 'c')).toBe('c');
        });

        it('should get parent directory correctly', () => {
            expect(FS.getParentDir('/a/b/c')).toBe('/a/b');
            expect(FS.getParentDir('c')).toBe('.');
        });

        it('should get basename correctly', () => {
            expect(FS.getBasename('/a/b/c.txt')).toBe('c.txt');
            expect(FS.getBasename('c.txt')).toBe('c.txt');
        });
    });
});
