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

/**
 * 表の構造の変更。data は TableEditor.parse() の 2 次元配列で、その場で書き換える。
 * 削除は r..r2 行 / c..c2 列をまとめて消す (範囲選択からの削除)。見出し行は消さない。
 */
const OPS = {
    // 上 / 左への挿入は、r..r2 行 / c..c2 列と同じ数だけ足す (Excel の Ctrl+Shift++)。
    'row-above': (data, r, _c, cols, r2) => {
        const count = Math.max(1, r2 - r + 1);
        const rows = Array.from({ length: count }, () => new Array(cols).fill(''));
        data.splice(Math.max(1, r), 0, ...rows);
    },
    'row-below': (data, r, _c, cols) => { data.splice(r + 1, 0, new Array(cols).fill('')); },
    'col-left': (data, _r, c, _cols, _r2, c2) => {
        const count = Math.max(1, c2 - c + 1);
        data.forEach((row) => row.splice(c, 0, ...new Array(count).fill('')));
        if (data.align) data.align.splice(c, 0, ...new Array(count).fill(null));
    },
    'col-right': (data, _r, c) => {
        data.forEach((row) => row.splice(c + 1, 0, ''));
        if (data.align) data.align.splice(c + 1, 0, null);
    },
    'row-delete': (data, r, _c, _cols, r2) => {
        const from = Math.max(1, r);
        if (r2 >= from) data.splice(from, r2 - from + 1);
    },
    'col-delete': (data, _r, c, cols, _r2, c2) => {
        const count = c2 - c + 1;
        if (count <= 0 || count >= cols) return;
        data.forEach((row) => row.splice(c, count));
        if (data.align) data.align.splice(c, count);
    },
};

/** 表の部分を 2 次元配列にする。列が足りない行は空のセルで埋める。 */
function tableData(text, table) {
    const data = TableEditor.parse(text.slice(table.start, table.end));
    // 列が足りない行をそろえておかないと、列の挿入位置がずれる。
    data.forEach((r) => { while (r.length < table.columns) r.push(''); });
    return data;
}

function withTableData(text, table, data) {
    return text.slice(0, table.start) + TableEditor.serialize(data) + text.slice(table.end);
}

/**
 * 行や列を増減した原文を返す。表の部分だけを整形し直す。
 * `endRow` / `endCol` は削除の範囲の終わり (省略すると 1 行 / 1 列)。
 */
export function applyTableOp(text, table, op, row, col, endRow = row, endCol = col) {
    const fn = OPS[op];
    if (!fn) return text;
    const data = tableData(text, table);
    fn(data, row, col, table.columns, endRow, endCol);
    return withTableData(text, table, data);
}

/** 範囲 {r1, r2, c1, c2} のセルを空にした原文。ほかのセルには触らない。 */
export function clearCells(text, table, range) {
    let out = text;
    // 後ろのセルから書き換えると、前のセルの位置がずれない。
    for (let r = Math.min(range.r2, table.rows.length - 1); r >= range.r1; r--) {
        const row = table.rows[r];
        for (let c = Math.min(range.c2, table.columns - 1); c >= range.c1; c--) {
            if (row && row.cells[c]) out = replaceCell(out, table, r, c, '');
        }
    }
    return out;
}

/**
 * 貼り付けた値の並び (grid[行][列]) を (row, col) から書き込んだ原文。
 * 表に収まるならセルだけを差し替え、はみ出すなら行や列を足して表を整形し直す。
 */
export function writeGrid(text, table, row, col, grid) {
    const height = grid.length;
    const width = Math.max(0, ...grid.map((g) => g.length));
    if (!height || !width) return text;

    // 列が足りない行のセルは行末に足す書き方になり、後ろから順に書くと位置が狂う。
    // そういう行が混ざるときも整形し直す側へ回す。
    const fits = row + height <= table.rows.length && col + width <= table.columns
        && grid.every((values, r) => table.rows[row + r].cells.length >= col + values.length);
    if (fits) {
        let out = text;
        for (let r = height - 1; r >= 0; r--) {
            for (let c = grid[r].length - 1; c >= 0; c--) {
                out = replaceCell(out, table, row + r, col + c, grid[r][c]);
            }
        }
        return out;
    }

    const data = tableData(text, table);
    const columns = Math.max(table.columns, col + width);
    data.forEach((r) => { while (r.length < columns) r.push(''); });
    if (data.align) while (data.align.length < columns) data.align.push(null);
    while (data.length < row + height) data.push(new Array(columns).fill(''));
    grid.forEach((values, r) => values.forEach((v, c) => { data[row + r][col + c] = toCellSource(v); }));
    return withTableData(text, table, data);
}

/**
 * Excel などがクリップボードに置くタブ区切りの文字を 2 次元配列にする。
 * 改行やタブを含むセルは "..." で囲まれ、中の " は "" になっている。
 * 末尾の改行 (Excel は最後の行にも付ける) は行として数えない。
 */
export function parseTsv(value) {
    const src = String(value == null ? '' : value).replace(/\r\n?/g, '\n');
    const rows = [];
    let row = [];
    let cell = '';
    let i = 0;
    let atCellStart = true;
    while (i < src.length) {
        const ch = src[i];
        if (atCellStart && ch === '"') {
            // 囲みの終わりの " の直後が区切りか行末でなければ、囲みではない。
            let j = i + 1;
            let quoted = '';
            let closed = false;
            while (j < src.length) {
                if (src[j] === '"') {
                    if (src[j + 1] === '"') { quoted += '"'; j += 2; continue; }
                    closed = true;
                    j++;
                    break;
                }
                quoted += src[j++];
            }
            if (closed && (j >= src.length || src[j] === '\t' || src[j] === '\n')) {
                cell = quoted;
                i = j;
                atCellStart = false;
                continue;
            }
        }
        atCellStart = false;
        if (ch === '\t') {
            row.push(cell);
            cell = '';
            atCellStart = true;
        } else if (ch === '\n') {
            row.push(cell);
            rows.push(row);
            row = [];
            cell = '';
            atCellStart = true;
        } else {
            cell += ch;
        }
        i++;
    }
    if (cell !== '' || row.length) {
        row.push(cell);
        rows.push(row);
    }
    return rows;
}
