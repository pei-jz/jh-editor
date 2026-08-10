import { invoke } from '@tauri-apps/api/core';

class FileHistoryManager {
    constructor() {
        this.history = new Map(); // path -> Array<{content, timestamp}>
        this.maxHistory = 20;
    }

    async snapshot(path) {
        try {
            const data = await invoke('read_file_auto_detect', { path });
            if (!data || !data.content) return;

            if (!this.history.has(path)) {
                this.history.set(path, []);
            }

            const stack = this.history.get(path);
            stack.push({
                content: data.content,
                timestamp: Date.now()
            });

            if (stack.length > this.maxHistory) {
                stack.shift();
            }
        } catch (e) {
            console.warn(`Failed to snapshot ${path}:`, e);
        }
    }

    getPrevious(path) {
        const stack = this.history.get(path);
        if (!stack || stack.length === 0) return null;
        return stack.pop();
    }

    async undo(path) {
        const prev = this.getPrevious(path);
        if (!prev) return false;

        try {
            await invoke('write_file', { path, content: prev.content });
            return true;
        } catch (e) {
            console.error(`Failed to undo ${path}:`, e);
            return false;
        }
    }
}

export const fileHistoryManager = new FileHistoryManager();
