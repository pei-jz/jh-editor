import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { applyTableOp, cellSource, findTables, replaceCell, toCellSource } from '../src/modules/utils/MarkdownTableCells.js';

// 表示モードのセル編集は、原文のうちセルの文字だけを差し替える。ここが 1 文字でも
// ずれると、見ているセルとは別の場所を書き換えてしまう。描画と同じ marked で表の
// 範囲を決めている実物を通して確かめる。

let marked;
beforeAll(() => {
    // public/lib の UMD をそのまま読む (アプリが読み込むのと同じ実物)。
    const module = { exports: {} };
    new Function('module', 'exports', readFileSync('public/lib/marked.min.js', 'utf8'))(module, module.exports);
    marked = module.exports.marked || module.exports;
});

const tablesOf = (text) => findTables(text, marked.lexer(text));

const SOURCE = [
    '| 名前 | 内容 |',
    '| --- | :-: |',
    '| a   | **太字** |',
    '| b   |  |',
].join('\n');

describe('findTables', () => {
    it('finds each cell, skipping the separator row', () => {
        const [table] = tablesOf(SOURCE);
        expect(table.rows).toHaveLength(3);
        expect(table.columns).toBe(2);
        expect(cellSource(SOURCE, table, 0, 1)).toBe('内容');
        expect(cellSource(SOURCE, table, 1, 1)).toBe('**太字**');
        expect(cellSource(SOURCE, table, 2, 1)).toBe('');
    });

    it('locates a table that follows other text in the block', () => {
        const text = `前の段落\n\n${SOURCE}\n\n後の段落 | 表ではない`;
        const tables = tablesOf(text);
        expect(tables).toHaveLength(1);
        expect(cellSource(text, tables[0], 1, 0)).toBe('a');
    });

    it('keeps an escaped pipe inside its cell', () => {
        const text = '| a | b |\n|---|---|\n| x\\|y | z |';
        const [table] = tablesOf(text);
        expect(table.editable).toBe(true);
        expect(cellSource(text, table, 1, 0)).toBe('x\\|y');
        expect(cellSource(text, table, 1, 1)).toBe('z');
    });

    it('reads rows written without the outer pipes', () => {
        const text = 'a | b\n--|--\n1 | 2';
        const [table] = tablesOf(text);
        expect(cellSource(text, table, 1, 0)).toBe('1');
        expect(cellSource(text, table, 1, 1)).toBe('2');
    });

    it('refuses a table whose rows cannot be matched to the drawn cells', () => {
        // marked 描画では 2 列に切り詰められる行。原文のセルとは対応しない。
        const text = '| a | b |\n|---|---|\n| 1 | 2 | 3 |';
        expect(tablesOf(text)[0].editable).toBe(false);
    });

    it('does not see a table inside a code fence', () => {
        expect(tablesOf('```\n| a |\n|---|\n| 1 |\n```')).toHaveLength(0);
    });
});

describe('replaceCell', () => {
    it('changes only that cell and leaves the alignment of the rest', () => {
        const [table] = tablesOf(SOURCE);
        expect(replaceCell(SOURCE, table, 1, 0, 'ab')).toBe(SOURCE.replace('| a   |', '| ab   |'));
        expect(replaceCell(SOURCE, table, 2, 1, '新しい')).toBe(SOURCE.replace('| b   |  |', '| b   | 新しい |'));
    });

    it('fills a cell with no spaces at all', () => {
        const text = '| a | b |\n|---|---|\n|x||';
        const [table] = tablesOf(text);
        expect(replaceCell(text, table, 1, 1, 'y')).toBe('| a | b |\n|---|---|\n|x| y |');
    });

    it('writes to a cell the source row is missing', () => {
        const text = '| a | b | c |\n|---|---|---|\n| 1 |';
        const [table] = tablesOf(text);
        const next = replaceCell(text, table, 1, 2, 'z');
        expect(next).toBe('| a | b | c |\n|---|---|---|\n| 1 |  | z |');
        expect(cellSource(next, tablesOf(next)[0], 1, 2)).toBe('z');
    });

    it('round-trips a typed pipe and line break as one cell', () => {
        const [table] = tablesOf(SOURCE);
        const next = replaceCell(SOURCE, table, 1, 0, 'x|y\nz');
        const [after] = tablesOf(next);
        expect(after.columns).toBe(2);
        expect(after.editable).toBe(true);
        expect(cellSource(next, after, 1, 0)).toBe('x\\|y<br>z');
    });
});

describe('toCellSource', () => {
    it('does not escape a pipe twice', () => {
        expect(toCellSource('a\\|b')).toBe('a\\|b');
    });

    it('leaves a [[wiki|link]] alone', () => {
        expect(toCellSource('[[page|表示名]]')).toBe('[[page|表示名]]');
    });

    it('drops the newline a contenteditable leaves at the end', () => {
        expect(toCellSource('a\n')).toBe('a');
    });
});

describe('applyTableOp', () => {
    const text = '前\n\n| a | b |\n|:--|--:|\n| 1 | 2 |\n\n後';
    const run = (op, r, c) => {
        const next = applyTableOp(text, tablesOf(text)[0], op, r, c);
        const [t] = tablesOf(next);
        return { next, t, grid: t.rows.map((_, i) => t.rows[0].cells.map((__, k) => cellSource(next, t, i, k))) };
    };

    it('leaves the text around the table alone', () => {
        const { next } = run('row-below', 1, 0);
        expect(next.startsWith('前\n\n|')).toBe(true);
        expect(next.endsWith('|\n\n後')).toBe(true);
    });

    it('inserts rows, never above the header', () => {
        expect(run('row-below', 1, 0).grid).toEqual([['a', 'b'], ['1', '2'], ['', '']]);
        expect(run('row-above', 1, 0).grid).toEqual([['a', 'b'], ['', ''], ['1', '2']]);
        expect(run('row-above', 0, 0).grid).toEqual([['a', 'b'], ['', ''], ['1', '2']]);
    });

    it('inserts columns and keeps each column its alignment', () => {
        const { next, grid } = run('col-right', 1, 0);
        expect(grid).toEqual([['a', '', 'b'], ['1', '', '2']]);
        const sep = next.split('\n')[3].split('|').slice(1, -1).map((c) => c.trim());
        expect(sep[0].startsWith(':')).toBe(true);
        expect(sep[1].includes(':')).toBe(false);
        expect(sep[2].endsWith(':')).toBe(true);
    });

    it('deletes a row or a column, but not the header or the last column', () => {
        expect(run('row-delete', 1, 0).t.rows).toHaveLength(1);
        expect(run('row-delete', 0, 0).t.rows).toHaveLength(2);
        expect(run('col-delete', 1, 1).grid).toEqual([['a'], ['1']]);
        const single = '| a |\n|---|\n| 1 |';
        expect(applyTableOp(single, tablesOf(single)[0], 'col-delete', 1, 0)).toContain('| a');
    });
});
