import { describe, it, expect, vi, beforeEach } from 'vitest';

// TaskNotificationPanel imports State from Store; both are singletons in the
// current architecture. Import the panel and exercise the pure-ish helpers
// (_processTaskLogs) that rebuild modifiedFiles — including the persisted
// `modified_files` shape added by the Rust TaskInfo.
import { TaskNotificationPanel } from '../src/modules/ai/TaskNotificationPanel.js';

describe('TaskNotificationPanel diff support', () => {
    let panel;

    beforeEach(() => {
        panel = new TaskNotificationPanel();
    });

    it('rebuilds modifiedFiles from the persisted modified_files field (history tasks)', () => {
        const task = {
            id: 't1',
            status: 'completed',
            logs: [], // list_tasks strips logs — history tasks arrive without them
            modified_files: [
                { path: 'C:/ws/a.js', original: 'old a', current: 'new a' },
                { path: 'C:/ws/b.js', original: null, current: 'brand new' },
            ],
        };
        panel._processTaskLogs(task);
        expect(task.modifiedFiles).toHaveLength(2);
        expect(task.modifiedFiles[0]).toEqual({ path: 'C:/ws/a.js', original: 'old a', current: 'new a' });
        expect(task.modifiedFiles[1]).toEqual({ path: 'C:/ws/b.js', original: null, current: 'brand new' });
    });

    it('falls back to the complete event modifiedFiles when logs are present', () => {
        const task = {
            id: 't2',
            status: 'completed',
            logs: [
                { event: 'complete', data: { modifiedFiles: [{ path: 'C:/ws/c.js', original: 'x', current: 'y' }] } },
            ],
        };
        panel._processTaskLogs(task);
        expect(task.modifiedFiles).toHaveLength(1);
        expect(task.modifiedFiles[0].path).toBe('C:/ws/c.js');
        expect(task.modifiedFiles[0].original).toBe('x');
        expect(task.modifiedFiles[0].current).toBe('y');
    });

    it('collects file_modified events into the file list when no rich content exists', () => {
        const task = {
            id: 't3',
            status: 'running',
            logs: [
                { event: 'file_modified', data: { path: 'C:/ws/d.js' } },
                { event: 'file_modified', data: { path: 'C:/ws/d.js' } }, // duplicate → skipped
                { event: 'file_modified', data: { path: 'C:/ws/e.js' } },
            ],
        };
        panel._processTaskLogs(task);
        expect(task.modifiedFiles).toHaveLength(2);
        expect(task.modifiedFiles.map(f => f.path)).toEqual(['C:/ws/d.js', 'C:/ws/e.js']);
    });

    it('does not crash when the task has neither logs nor modified_files', () => {
        const task = { id: 't4', status: 'running' };
        expect(() => panel._processTaskLogs(task)).not.toThrow();
        expect(task.modifiedFiles).toEqual([]);
    });
});
