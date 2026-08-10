import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Tauri modules
vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn()
}));

import { fileHistoryManager } from '../src/modules/utils/FileHistoryManager.js';
import { invoke } from '@tauri-apps/api/core';

describe('FileHistoryManager', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        fileHistoryManager.history.clear();
    });

    it('should capture snapshots up to maxHistory limit', async () => {
        vi.mocked(invoke).mockResolvedValue({ content: 'state-1' });
        await fileHistoryManager.snapshot('/test.txt');

        expect(invoke).toHaveBeenCalledWith('read_file_auto_detect', { path: '/test.txt' });
        expect(fileHistoryManager.history.get('/test.txt').length).toBe(1);
        expect(fileHistoryManager.history.get('/test.txt')[0].content).toBe('state-1');

        // Snapshot multiple times to hit limit
        fileHistoryManager.maxHistory = 3;
        vi.mocked(invoke).mockResolvedValue({ content: 'state-2' });
        await fileHistoryManager.snapshot('/test.txt');
        
        vi.mocked(invoke).mockResolvedValue({ content: 'state-3' });
        await fileHistoryManager.snapshot('/test.txt');

        vi.mocked(invoke).mockResolvedValue({ content: 'state-4' });
        await fileHistoryManager.snapshot('/test.txt');

        // Stack length should be capped at 3
        const stack = fileHistoryManager.history.get('/test.txt');
        expect(stack.length).toBe(3);
        // First state ('state-1') should be shifted out, leaving 2, 3, 4
        expect(stack[0].content).toBe('state-2');
        expect(stack[2].content).toBe('state-4');
    });

    it('should rollback to previous state on undo', async () => {
        vi.mocked(invoke).mockResolvedValue({ content: 'v1' });
        await fileHistoryManager.snapshot('/test.txt');

        vi.mocked(invoke).mockResolvedValue({ content: 'v2' });
        await fileHistoryManager.snapshot('/test.txt');

        const undoResult = await fileHistoryManager.undo('/test.txt');
        expect(undoResult).toBe(true);
        expect(invoke).toHaveBeenCalledWith('write_file', { path: '/test.txt', content: 'v2' });

        const undoResult2 = await fileHistoryManager.undo('/test.txt');
        expect(undoResult2).toBe(true);
        expect(invoke).toHaveBeenCalledWith('write_file', { path: '/test.txt', content: 'v1' });

        const undoResult3 = await fileHistoryManager.undo('/test.txt');
        expect(undoResult3).toBe(false); // Stack is empty now
    });
});
