import { describe, it, expect, beforeEach } from 'vitest';
import { RecentFiles, sameWorkspace } from '../src/modules/utils/RecentFiles.js';

describe('RecentFiles', () => {
    beforeEach(() => localStorage.clear());

    describe('files', () => {
        it('puts the latest first and lists a file once', () => {
            RecentFiles.recordFile('C:/a.txt');
            RecentFiles.recordFile('C:/b.txt');
            RecentFiles.recordFile('C:/a.txt');
            expect(RecentFiles.getFiles()).toEqual(['C:/a.txt', 'C:/b.txt']);
        });

        it('leaves out virtual tabs, which cannot be reopened from a path', () => {
            RecentFiles.recordFile('scratch://1');
            RecentFiles.recordFile('');
            expect(RecentFiles.getFiles()).toEqual([]);
        });

        it('keeps the 15 latest', () => {
            for (let i = 0; i < 20; i++) RecentFiles.recordFile(`C:/${i}.txt`);
            const files = RecentFiles.getFiles();
            expect(files).toHaveLength(15);
            expect(files[0]).toBe('C:/19.txt');
        });

        it('clears', () => {
            RecentFiles.recordFile('C:/a.txt');
            RecentFiles.clearFiles();
            expect(RecentFiles.getFiles()).toEqual([]);
        });

        it('reads damaged storage as empty, and drops entries that are not paths', () => {
            localStorage.setItem('jheditor_recent_files', '{not json');
            expect(RecentFiles.getFiles()).toEqual([]);
            localStorage.setItem('jheditor_recent_files', '{"a":1}');
            expect(RecentFiles.getFiles()).toEqual([]);
            localStorage.setItem('jheditor_recent_files', '["C:/a.txt", 3, null]');
            expect(RecentFiles.getFiles()).toEqual(['C:/a.txt']);
        });
    });

    describe('workspaces', () => {
        it('counts a folder once however its slashes were written', () => {
            RecentFiles.recordWorkspace('C:\\Work\\A');
            RecentFiles.recordWorkspace('c:/work/a/');
            expect(RecentFiles.getWorkspaces()).toEqual(['c:/work/a/']);
        });

        it('keeps the 10 latest', () => {
            for (let i = 0; i < 12; i++) RecentFiles.recordWorkspace(`C:/w${i}`);
            expect(RecentFiles.getWorkspaces()).toHaveLength(10);
            expect(RecentFiles.getWorkspaces()[0]).toBe('C:/w11');
        });

        it('forgets one folder and keeps the rest', () => {
            RecentFiles.recordWorkspace('C:/a');
            RecentFiles.recordWorkspace('C:/b');
            RecentFiles.forgetWorkspace('c:\\A');
            expect(RecentFiles.getWorkspaces()).toEqual(['C:/b']);
        });
    });

    describe('sameWorkspace', () => {
        it('ignores slash direction, trailing slashes and case', () => {
            expect(sameWorkspace('C:\\Work\\A\\', 'c:/work/a')).toBe(true);
        });

        it('never matches a missing path', () => {
            expect(sameWorkspace('', '')).toBe(false);
            expect(sameWorkspace(null, 'C:/a')).toBe(false);
        });
    });
});
