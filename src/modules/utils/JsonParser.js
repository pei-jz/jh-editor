/**
 * JsonParser.js
 * Converts JSON string <-> Generic Node Tree
 *
 * Writing the tree back must not rewrite the file. JSON.parse + JSON.stringify
 * did: one edited value re-indented everything to two spaces, dropped the
 * final newline, turned 1.0 into 1 and "é" into "é", merged duplicate
 * keys, and rounded 12345678901234567890 to 12345678901234567000.
 *
 * So the tree is built by a parser of our own that remembers where every node
 * sat in the text (parseDocument). stringify() then copies every untouched
 * part of the file verbatim and only generates text for what was edited, in
 * the file's own indentation. Scalars keep their raw token, so even a
 * regenerated container writes 1e3 and "é" exactly as they were.
 *
 * Bookkeeping fields on nodes (all plain data, so the editor's JSON-clone
 * undo history keeps them):
 *   _src      id of the text the node was parsed from
 *   _s, _e    the node's value span in that text; _d its nesting depth
 *   _t, _v, _raw   scalars: JSON kind, decoded value and token as parsed
 *   _ids      containers: child ids as parsed
 *   _m        containers: per-child [start, end, keyEnd, valueStart, key]
 */

let nextSourceId = 1;

/** True when Number(raw) cannot hold the number the token spells out. */
export function isLossyNumber(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return true;
    // String(n) may use exponent notation; both forms canonicalise the same.
    return canonicalDecimal(raw) !== canonicalDecimal(String(n));
}

/** "-0012.3400e+2" -> "-1234|1" : sign, significant digits, exponent. */
function canonicalDecimal(text) {
    const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
    if (!m) return text;
    const sign = m[1];
    const intPart = m[2];
    const frac = m[3] || '';
    let exp = parseInt(m[4] || '0', 10) + intPart.length;
    let digits = intPart + frac;
    const lead = digits.match(/^0*/)[0].length;
    digits = digits.slice(lead);
    exp -= lead;
    digits = digits.replace(/0+$/, '');
    if (digits === '') return '0';
    return `${sign}${digits}|${exp}`;
}

class Reader {
    constructor(text, srcId) {
        this.text = text;
        this.pos = 0;
        this.srcId = srcId;
        this.lossy = [];
    }

    fail(msg) {
        throw new Error(`${msg} at position ${this.pos}`);
    }

    ws() {
        const t = this.text;
        while (this.pos < t.length) {
            const c = t.charCodeAt(this.pos);
            if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.pos++;
            else break;
        }
    }

    value(key, depth, path) {
        this.ws();
        const c = this.text[this.pos];
        if (c === '{') return this.object(key, depth, path);
        if (c === '[') return this.array(key, depth, path);
        return this.scalar(key, depth, path);
    }

    node(type, key, depth, start) {
        return {
            id: Math.random().toString(36).substr(2, 9),
            type,
            key,
            value: null,
            children: [],
            expanded: true,
            _src: this.srcId,
            _s: start,
            _e: start,
            _d: depth,
        };
    }

    object(key, depth, path) {
        const node = this.node('object', key, depth, this.pos);
        const members = [];
        this.pos++; // {
        this.ws();
        if (this.text[this.pos] === '}') {
            this.pos++;
        } else {
            for (;;) {
                this.ws();
                const start = this.pos;
                if (this.text[this.pos] !== '"') this.fail('Expected property name');
                const name = this.string().value;
                const keyEnd = this.pos;
                this.ws();
                if (this.text[this.pos] !== ':') this.fail("Expected ':'");
                this.pos++;
                this.ws();
                const valueStart = this.pos;
                const child = this.value(name, depth + 1, path.concat(name));
                // Scalars inside an object are shown as properties.
                if (child.type !== 'object' && child.type !== 'array') child.type = 'property';
                node.children.push(child);
                members.push([start, this.pos, keyEnd, valueStart, name]);
                this.ws();
                const sep = this.text[this.pos];
                if (sep === ',') { this.pos++; continue; }
                if (sep === '}') { this.pos++; break; }
                this.fail("Expected ',' or '}'");
            }
        }
        node._e = this.pos;
        node._ids = node.children.map((c) => c.id);
        node._m = members;
        return node;
    }

    array(key, depth, path) {
        const node = this.node('array', key, depth, this.pos);
        const members = [];
        this.pos++; // [
        this.ws();
        if (this.text[this.pos] === ']') {
            this.pos++;
        } else {
            for (;;) {
                this.ws();
                const start = this.pos;
                const i = node.children.length;
                const child = this.value(`[${i}]`, depth + 1, path.concat(i));
                node.children.push(child);
                members.push([start, this.pos]);
                this.ws();
                const sep = this.text[this.pos];
                if (sep === ',') { this.pos++; continue; }
                if (sep === ']') { this.pos++; break; }
                this.fail("Expected ',' or ']'");
            }
        }
        node._e = this.pos;
        node._ids = node.children.map((c) => c.id);
        node._m = members;
        return node;
    }

    scalar(key, depth, path) {
        const start = this.pos;
        const t = this.text;
        let kind;
        let value;
        if (t[start] === '"') {
            kind = 'string';
            value = this.string().value;
        } else if (t.startsWith('true', start)) {
            kind = 'boolean'; value = true; this.pos += 4;
        } else if (t.startsWith('false', start)) {
            kind = 'boolean'; value = false; this.pos += 5;
        } else if (t.startsWith('null', start)) {
            kind = 'null'; value = null; this.pos += 4;
        } else {
            const m = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
            m.lastIndex = start;
            const hit = m.exec(t);
            if (!hit) this.fail('Unexpected token');
            kind = 'number';
            value = Number(hit[0]);
            this.pos = m.lastIndex;
            if (isLossyNumber(hit[0])) this.lossy.push({ raw: hit[0], path });
        }
        const node = this.node(kind, key, depth, start);
        node.value = value;
        node._e = this.pos;
        node._t = kind;
        node._v = value;
        node._raw = t.slice(start, this.pos);
        return node;
    }

    string() {
        const t = this.text;
        const start = this.pos;
        this.pos++; // opening quote
        for (;;) {
            if (this.pos >= t.length) this.fail('Unterminated string');
            const c = t.charCodeAt(this.pos);
            if (c === 0x22) break;
            if (c === 0x5c) this.pos += 2;
            else if (c < 0x20) this.fail('Control character in string');
            else this.pos++;
        }
        this.pos++; // closing quote
        const raw = t.slice(start, this.pos);
        // The token is already in JSON's own string syntax; let JSON decode it.
        return { raw, value: JSON.parse(raw) };
    }
}

/** Indentation, separators and line ending the file was written with. */
function detectFormat(text, root) {
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    const body = text.slice(root._s, root._e);
    const compact = !/[\r\n]/.test(body);
    let indent = '  ';
    const lines = body.split(/\r?\n/).slice(1);
    const first = lines.find((l) => /^[ \t]+\S/.test(l));
    if (first && first[0] === '\t') {
        indent = '\t';
    } else {
        let min = Infinity;
        for (const l of lines) {
            const m = /^( +)\S/.exec(l);
            if (m && m[1].length < min) min = m[1].length;
        }
        if (min !== Infinity) indent = ' '.repeat(min);
    }
    const colon = compact && !/"\s*:\s/.test(body) ? ':' : ': ';
    const comma = compact && !/,\s/.test(body) ? ',' : ', ';
    return { indent, newline, compact, colon, comma };
}

const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

export class JsonParser {
    static parse(jsonString) {
        return this.parseDocument(jsonString).root;
    }

    /**
     * Parse and keep what is needed to write the text back faithfully.
     * `doc.lossy` lists numbers a JS number cannot hold; while it is non-empty
     * the tree must not be written back (see StructureView).
     */
    static parseDocument(jsonString) {
        const srcId = `j${nextSourceId++}`;
        const reader = new Reader(String(jsonString), srcId);
        let root;
        try {
            if (reader.text.charCodeAt(0) === 0xfeff) reader.pos = 1;
            root = reader.value('root', 0, []);
            reader.ws();
            if (reader.pos < reader.text.length) reader.fail('Unexpected content after JSON');
        } catch (e) {
            throw new Error("JSON Parsing Error: " + e.message);
        }
        const doc = {
            srcId,
            source: reader.text,
            format: detectFormat(reader.text, root),
            lead: reader.text.slice(0, root._s),
            trail: reader.text.slice(root._e),
            lossy: reader.lossy,
        };
        return { root, doc };
    }

    static jsonToNode(data, key, typeOverride) {
        const node = {
            id: Math.random().toString(36).substr(2, 9),
            type: typeOverride || this.getType(data),
            key: key,
            value: null,
            children: [],
            expanded: true
        };

        if (Array.isArray(data)) {
            node.type = 'array';
            data.forEach((item, index) => {
                node.children.push(this.jsonToNode(item, `[${index}]`));
            });
        } else if (typeof data === 'object' && data !== null) {
            node.type = 'object';
            Object.keys(data).forEach(prop => {
                const child = this.jsonToNode(data[prop], prop);
                if (typeof data[prop] === 'object' && data[prop] !== null) {
                    child.type = Array.isArray(data[prop]) ? 'array' : 'object';
                } else {
                    child.type = 'property';
                    child.value = data[prop];
                }
                child.key = prop;
                node.children.push(child);
            });
        } else {
            node.value = data;
            if (node.type === 'root') node.type = typeof data;
        }

        return node;
    }

    static getType(data) {
        if (data === null) return 'null';
        if (Array.isArray(data)) return 'array';
        return typeof data;
    }

    /**
     * Tree -> JSON text.
     *   doc    from parseDocument: untouched parts of that text are copied
     *          verbatim, new parts follow its format.
     *   format just the formatting, for showing a subtree on its own.
     * With neither, two-space indentation.
     */
    static stringify(rootNode, { doc = null, format = null } = {}) {
        const fmt = format || (doc && doc.format)
            || { indent: '  ', newline: '\n', compact: false, colon: ': ', comma: ', ' };
        const w = new Writer(fmt, doc);
        const body = w.emit(rootNode, 0);
        return doc ? doc.lead + body + doc.trail : body;
    }

    static nodeToJson(node) {
        if (node.type === 'array') {
            return node.children.map((child) => this.nodeToJson(child));
        } else if (node.type === 'object' || node.type === 'root') {
            const obj = {};
            node.children.forEach(child => {
                obj[child.key] = this.nodeToJson(child);
            });
            return obj;
        }
        return node.value;
    }
}

function isContainer(node) {
    return node.type === 'object' || node.type === 'array' || node.type === 'root';
}

class Writer {
    constructor(fmt, doc) {
        this.fmt = fmt;
        this.doc = doc;
        this.src = doc ? doc.source : null;
        this.memo = new Map();
    }

    /** Placed where the parse put it, holding what it held then. */
    fromHere(node, depth) {
        return !!this.doc && node._src === this.doc.srcId && node._d === depth;
    }

    sameShape(node) {
        const ids = node._ids;
        const kids = node.children || [];
        if (!ids || ids.length !== kids.length) return false;
        for (let i = 0; i < ids.length; i++) if (kids[i].id !== ids[i]) return false;
        return true;
    }

    untouched(node, depth) {
        if (this.memo.has(node)) return this.memo.get(node);
        let ok = this.fromHere(node, depth);
        if (ok) {
            if (isContainer(node)) {
                ok = this.sameShape(node);
                for (let i = 0; ok && i < node.children.length; i++) {
                    const child = node.children[i];
                    if (node.type === 'object' && child.key !== node._m[i][4]) ok = false;
                    else ok = this.untouched(child, depth + 1);
                }
            } else {
                ok = node._raw !== undefined && node.value === node._v
                    && !(node.children && node.children.length);
            }
        }
        this.memo.set(node, ok);
        return ok;
    }

    emit(node, depth) {
        if (this.untouched(node, depth)) return this.src.slice(node._s, node._e);
        if (!isContainer(node)) return this.scalar(node);
        if (this.fromHere(node, depth) && this.sameShape(node)) return this.patch(node, depth);
        return this.generate(node, depth);
    }

    /** Same children in the same order: keep the text between them as is. */
    patch(node, depth) {
        const src = this.src;
        const m = node._m;
        const kids = node.children;
        if (kids.length === 0) return src.slice(node._s, node._e);
        let out = src.slice(node._s, m[0][0]);
        for (let i = 0; i < kids.length; i++) {
            const child = kids[i];
            if (node.type === 'object') {
                const [start, , keyEnd, valueStart, key] = m[i];
                out += child.key === key ? src.slice(start, keyEnd) : JSON.stringify(String(child.key));
                out += src.slice(keyEnd, valueStart);
            }
            out += this.emit(child, depth + 1);
            out += src.slice(m[i][1], i + 1 < kids.length ? m[i + 1][0] : node._e);
        }
        return out;
    }

    generate(node, depth) {
        const isArray = node.type === 'array';
        const open = isArray ? '[' : '{';
        const close = isArray ? ']' : '}';
        const kids = node.children || [];
        if (kids.length === 0) return open + close;
        const f = this.fmt;
        const parts = kids.map((child) => {
            const value = this.emit(child, depth + 1);
            return isArray ? value : this.key(node, child) + f.colon + value;
        });
        if (f.compact) return open + parts.join(f.comma) + close;
        const inner = f.newline + f.indent.repeat(depth + 1);
        return open + inner + parts.join(',' + inner) + f.newline + f.indent.repeat(depth) + close;
    }

    /** A key that was not renamed keeps its original spelling (escapes and all). */
    key(parent, child) {
        if (this.doc && parent._src === this.doc.srcId && parent._m) {
            const i = parent._ids.indexOf(child.id);
            if (i >= 0 && parent._m[i][4] === child.key) {
                return this.src.slice(parent._m[i][0], parent._m[i][2]);
            }
        }
        return JSON.stringify(String(child.key));
    }

    scalar(node) {
        const value = node.value;
        if (node._raw !== undefined && value === node._v) return node._raw;
        if (typeof value === 'string') {
            // Inline edits arrive as text. A value that was a number, boolean or
            // null stays one when what was typed still is one.
            if (node._t && node._t !== 'string') {
                const s = value.trim();
                if (JSON_NUMBER.test(s) || s === 'true' || s === 'false' || s === 'null') return s;
            }
            return JSON.stringify(value);
        }
        if (value === undefined) return 'null';
        return JSON.stringify(value);
    }
}
