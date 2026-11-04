/**
 * MarkdownTableCells.js — Markdown 原文の中で「表のどのセルがどこにあるか」を求める。
 *
 * 表示モードでセルを直すとき、表全体を組み立て直すと、触っていないセルの桁揃えや
 * 区切り行まで書き換わって差分が膨らむ。そこで原文上のセルの範囲を求め、そのセルの
 * 文字だけを差し替える。行や列の増減のときだけ、表の部分を整形し直す。
 *
 * DOM に触らない純粋な関数だけを置く。トークン列は marked.lexer() の結果を呼び出し
 * 側から渡す (描画と同じパーサーで表の範囲を決めるため)。
 */

import { TableEditor } from '../editors/TableEditor.js';

/** `|` がその前のバックスラッシュでエスケープされているか。 */
function isEscapedAt(text, i) {
    let n = 0;
    for (let k = i - 1; k >= 0 && text[k] === '\\'; k--) n++;
    return n % 2 === 1;
}

/**
 * 1 行分のセルの範囲。前後の空白を除いた範囲を返す。
 * `start` / `end` は文書全体のオフセット。
 */
function rowCells(text, lineStart, lineEnd) {
    const pipes = [];
    for (let i = lineStart; i < lineEnd; i++) {
        if (text[i] === '|' && !isEscapedAt(text, i)) pipes.push(i);
    }

    let from = lineStart;
    let to = lineEnd;
    while (from < to && /\s/.test(text[from])) from++;
    while (to > from && /\s/.test(text[to - 1])) to--;

    const bounds = pipes.filter((p) => p >= from && p < to);
    // 行頭と行末の `|` は区切りではなく、表の外枠。
    const hasLead = bounds[0] === from;
    const hasTrail = bounds.length > 0 && bounds[bounds.length - 1] === to - 1
        && !(hasLead && bounds.length === 1);

    const cuts = [hasLead ? from : from - 1];
    for (const p of bounds) {
        if (p === from && hasLead) continue;
        if (p === to - 1 && hasTrail) continue;
        cuts.push(p);
    }
    cuts.push(hasTrail ? to - 1 : to);

    const cells = [];
    for (let i = 0; i < cuts.length - 1; i++) {
        let s = cuts[i] + 1;
        let e = cuts[i + 1];
        while (s < e && /\s/.test(text[s])) s++;
        while (e > s && /\s/.test(text[e - 1])) e--;
        cells.push({ start: s, end: e });
    }
    return { cells, lineStart, lineEnd, hasTrail };
}

/**
 * `text` の中にある表の一覧。
 *
 * @param {string} text ブロックの原文
 * @param {Array} tokens marked.lexer(text) の結果
 * @returns {Array<{start:number,end:number,rows:Array,columns:number,editable:boolean}>}
 *   rows[0] がヘッダー。区切り行は rows に入らない。
 *
 * `editable` は「原文のセルと、描画されたセルを 1 対 1 で対応づけられる」こと。
 * 列数より多いセルを持つ行 ([[a|b]] の `|` を区切りと数えた行など) は、描画側の
 * 列と食い違うので編集の対象にしない。誤ったセルへ書き込むよりは F2 に任せる。
 */
export function findTables(text, tokens) {
    const tables = [];
    let cursor = 0;
    for (const token of tokens || []) {
        const raw = token && token.raw;
        if (typeof raw !== 'string' || !raw) continue;
        const at = text.indexOf(raw, cursor);
        if (at < 0) continue;
        cursor = at + raw.length;
        if (token.type !== 'table') continue;

        const end = at + raw.replace(/\s+$/, '').length;
        const lines = [];
        let pos = at;
        while (pos <= end) {
            let nl = text.indexOf('\n', pos);
            if (nl < 0 || nl > end) nl = end;
            lines.push({ start: pos, end: nl });
            pos = nl + 1;
        }

        const rows = lines
            .filter((_, i) => i !== 1)            // 2 行目は区切り行
            .map((l) => rowCells(text, l.start, l.end));
        const columns = rows.length ? rows[0].cells.length : 0;
        tables.push({
            start: at,
            end,
            rows,
            columns,
            editable: columns > 0 && rows.every((r) => r.cells.length <= columns),
        });
    }
    return tables;
}

/** セルの原文。原文側に存在しないセル (列が足りない行) は空。 */
export function cellSource(text, table, row, col) {
    const cell = table.rows[row] && table.rows[row].cells[col];
    return cell ? text.slice(cell.start, cell.end) : '';
}

/**
 * 入力された文字を、1 つのセルに収まる原文にする。
 * 改行は表の行を壊すので <br> に、`|` は列を増やすので \| にする。[[a|b]] の `|` は
 * 描画の前にリンクへ展開されて消えるので、そのまま残す。
 */
export function toCellSource(value) {
    const oneLine = String(value == null ? '' : value)
        .replace(/\r\n?/g, '\n')
        .replace(/\n+$/, '')
        .replace(/\n/g, '<br>')
        .trim();
    return oneLine.replace(/\[\[[^\]\n]*\]\]|\\[\s\S]|\|/g, (m) => (m === '|' ? '\\|' : m));
}

/** セルを 1 つ差し替えた原文を返す。ほかの文字には触らない。 */
export function replaceCell(text, table, row, col, value) {
    const r = table.rows[row];
    if (!r) return text;
    const source = toCellSource(value);
    const cell = r.cells[col];

    if (cell) {
        if (cell.start === cell.end && source) {
            // 空のセルは、区切りのあいだの空白ごと ` 値 ` に置き換える。
            let left = cell.start;
            let right = cell.end;
            while (left > r.lineStart && /\s/.test(text[left - 1])) left--;
            while (right < r.lineEnd && /\s/.test(text[right])) right++;
            const before = text[left - 1] === '|' ? ' ' : '';
            const after = text[right] === '|' ? ' ' : '';
            return text.slice(0, left) + before + source + after + text.slice(right);
        }
        return text.slice(0, cell.start) + source + text.slice(cell.end);
    }

    // 列が足りない行のセル (描画では空のセルが補われている) に書く場合は、
    // 途中の空セルも含めて行末に足す。
    let insertAt = r.lineEnd;
    while (insertAt > r.lineStart && /\s/.test(text[insertAt - 1])) insertAt--;
    const missing = col - r.cells.length;
    const filler = '  |'.repeat(missing);
    const addition = r.hasTrail
        ? `${filler} ${source} |`
        : ` |${filler} ${source}`;
    return text.slice(0, insertAt) + addition + text.slice(insertAt);
}

/** 表の構造の変更。data は TableEditor.parse() の 2 次元配列で、その場で書き換える。 */
const OPS = {
    'row-above': (data, r, _c, cols) => { data.splice(Math.max(1, r), 0, new Array(cols).fill('')); },
    'row-below': (data, r, _c, cols) => { data.splice(r + 1, 0, new Array(cols).fill('')); },
    'col-left': (data, _r, c) => {
        data.forEach((row) => row.splice(c, 0, ''));
        if (data.align) data.align.splice(c, 0, null);
    },
    'col-right': (data, _r, c) => {
        data.forEach((row) => row.splice(c + 1, 0, ''));
        if (data.align) data.align.splice(c + 1, 0, null);
    },
    'row-delete': (data, r) => { if (r > 0) data.splice(r, 1); },
    'col-delete': (data, _r, c, cols) => {
        if (cols <= 1) return;
        data.forEach((row) => row.splice(c, 1));
        if (data.align) data.align.splice(c, 1);
    },
};

/** 行や列を増減した原文を返す。表の部分だけを整形し直す。 */
export function applyTableOp(text, table, op, row, col) {
    const fn = OPS[op];
    if (!fn) return text;
    const data = TableEditor.parse(text.slice(table.start, table.end));
    const cols = table.columns;
    // 列が足りない行をそろえておかないと、列の挿入位置がずれる。
    data.forEach((r) => { while (r.length < cols) r.push(''); });
    fn(data, row, col, cols);
    return text.slice(0, table.start) + TableEditor.serialize(data) + text.slice(table.end);
}
