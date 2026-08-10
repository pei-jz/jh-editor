import { describe, it, expect, beforeEach } from 'vitest';
import { LargeFileView } from '../src/modules/views/LargeFileView.js';

// These tests cover the pure index/search logic, which is the part with real
// off-by-one risk. The virtualized DOM rendering depends on layout
// (getBoundingClientRect) and is not meaningfully testable under jsdom.
describe('LargeFileView line index', () => {
    let view;

    beforeEach(() => {
        view = new LargeFileView(document.createElement('div'));
    });

    function load(content) {
        view.content = content;
        view._buildLineIndex();
    }

    it('indexes a simple multi-line string', () => {
        load('alpha\nbeta\ngamma');
        expect(view.lineCount).toBe(3);
        expect(view._lineText(0)).toBe('alpha');
        expect(view._lineText(1)).toBe('beta');
        expect(view._lineText(2)).toBe('gamma');
    });

    it('treats a trailing newline as a final empty line', () => {
        load('a\nb\n');
        expect(view.lineCount).toBe(3);
        expect(view._lineText(2)).toBe('');
    });

    it('handles empty content as a single empty line', () => {
        load('');
        expect(view.lineCount).toBe(1);
        expect(view._lineText(0)).toBe('');
    });

    it('preserves empty lines in the middle', () => {
        load('x\n\ny');
        expect(view.lineCount).toBe(3);
        expect(view._lineText(0)).toBe('x');
        expect(view._lineText(1)).toBe('');
        expect(view._lineText(2)).toBe('y');
    });

    it('maps char offsets back to the correct line', () => {
        load('alpha\nbeta\ngamma');
        expect(view._lineAtOffset(0)).toBe(0);   // 'a' of alpha
        expect(view._lineAtOffset(5)).toBe(0);   // the '\n' after alpha
        expect(view._lineAtOffset(6)).toBe(1);   // 'b' of beta
        expect(view._lineAtOffset(11)).toBe(2);  // 'g' of gamma
        expect(view._lineAtOffset(15)).toBe(2);  // last char
    });
});

describe('LargeFileView find', () => {
    let view;

    beforeEach(() => {
        view = new LargeFileView(document.createElement('div'));
        view.content = 'foo bar\nbaz Foo\nqux';
        view._buildLineIndex();
        // Stub the DOM-touching parts so find() is exercisable in isolation.
        view.findStatus = { textContent: '' };
        view.goToLine = () => {};
    });

    it('finds the first match (case-insensitive) and resolves line/col', () => {
        view.find('foo', true);
        expect(view._activeMatch).toEqual({ line: 0, col: 0, length: 3 });
    });

    it('advances to the next match on repeated forward search', () => {
        view.find('foo', true); // line 0
        view.find('foo', true); // should jump to line 1 'Foo'
        expect(view._activeMatch.line).toBe(1);
        expect(view._activeMatch.col).toBe(4);
    });

    it('wraps around to the top after the last match', () => {
        view.find('foo', true); // line 0
        view.find('foo', true); // line 1
        view.find('foo', true); // wraps back to line 0
        expect(view._activeMatch.line).toBe(0);
    });

    it('reports no match for a missing term', () => {
        view.find('zzz', true);
        expect(view._activeMatch).toBeNull();
        expect(view.findStatus.textContent).toBe('Not found');
    });
});
