import { describe, it, expect } from 'vitest';
import { JsonParser, isLossyNumber } from '../src/modules/utils/JsonParser.js';

/*
   Editing one value in the JSON structure view used to rewrite the whole file:
   JSON.parse + JSON.stringify(obj, null, 2) re-indented it, dropped the final
   newline, turned 1.0 into 1 and "é" into "é", merged duplicate keys and
   rounded big integers. Write-back now copies everything that was not edited.
*/

const clone = (o) => JSON.parse(JSON.stringify(o));
const find = (node, key) => node.children.find((c) => c.key === key);

function roundTrip(text, edit) {
    const { root, doc } = JsonParser.parseDocument(text);
    if (edit) edit(root);
    return JsonParser.stringify(root, { doc });
}

describe('JSON write-back keeps the file as it was', () => {
    it('an unedited tree writes back byte for byte', () => {
        const samples = [
            '{\n\t"a": 1,\n\t"b": [1.0, 1e3, -0, 2E-5]\n}\n',
            '{\n    "name": "caf\\u00e9",\n    "n": null\n}',
            '{"dup": 1, "dup": 2}',
            '﻿[\n  true,\n  false\n]\n\n',
            '  "just a string"  ',
            '{ }',
        ];
        for (const text of samples) expect(roundTrip(text)).toBe(text);
    });

    it('editing one value changes only that value', () => {
        const text = '{\n\t"id": 1.0,\n\t"size": 1e3,\n\t"name": "caf\\u00e9",\n\t"tags": [ "x",  "y" ],\n\t"v": 1\n}\n';
        const out = roundTrip(text, (root) => { find(root, 'v').value = '2'; });
        expect(out).toBe(text.replace('"v": 1', '"v": 2'));
    });

    it('keeps duplicate keys when something else is edited', () => {
        const text = '{\n  "dup": 1,\n  "dup": 2,\n  "x": "a"\n}';
        const out = roundTrip(text, (root) => { find(root, 'x').value = 'b'; });
        expect(out).toBe('{\n  "dup": 1,\n  "dup": 2,\n  "x": "b"\n}');
    });

    it('a renamed key is the only key that changes', () => {
        const text = '{\n    "a\\u0041": 1,\n    "b": 2\n}';
        const out = roundTrip(text, (root) => { find(root, 'b').key = 'c'; });
        expect(out).toBe('{\n    "a\\u0041": 1,\n    "c": 2\n}');
    });

    it('still finds the edit after an undo snapshot (JSON clone) of the tree', () => {
        const text = '{\n\t"a": [1.50, 2],\n\t"b": 3\n}\n';
        const { root, doc } = JsonParser.parseDocument(text);
        const restored = clone(root);
        find(restored, 'b').value = '4';
        expect(JsonParser.stringify(restored, { doc })).toBe('{\n\t"a": [1.50, 2],\n\t"b": 4\n}\n');
    });
});

describe('JSON write-back uses the file\'s own format for new text', () => {
    it('a container whose children changed is laid out with the file\'s tab indent', () => {
        const text = '{\n\t"list": [\n\t\t1.0,\n\t\t2\n\t],\n\t"keep": "caf\\u00e9"\n}\n';
        const out = roundTrip(text, (root) => {
            const list = find(root, 'list');
            list.children.push({ id: 'new', type: 'number', key: '[2]', value: 3, children: [] });
        });
        expect(out).toBe('{\n\t"list": [\n\t\t1.0,\n\t\t2,\n\t\t3\n\t],\n\t"keep": "caf\\u00e9"\n}\n');
    });

    it('detects four-space indentation and keeps a missing final newline missing', () => {
        const text = '{\n    "a": {\n        "x": 1\n    }\n}';
        const out = roundTrip(text, (root) => {
            const a = find(root, 'a');
            a.children.push({ id: 'y', type: 'property', key: 'y', value: 'z', children: [] });
        });
        expect(out).toBe('{\n    "a": {\n        "x": 1,\n        "y": "z"\n    }\n}');
    });

    it('detects indentation and trailing newline in parseDocument', () => {
        expect(JsonParser.parseDocument('{\n\t"a": 1\n}\n').doc.format.indent).toBe('\t');
        expect(JsonParser.parseDocument('{\n    "a": 1\n}').doc.format.indent).toBe('    ');
        expect(JsonParser.parseDocument('{\n  "a": {\n    "b": 1\n  }\n}').doc.format.indent).toBe('  ');
        expect(JsonParser.parseDocument('{"a": 1}\r\n').doc.trail).toBe('\r\n');
    });

    it('a minified file stays minified', () => {
        const text = '{"a":[1,2],"b":1}';
        const out = roundTrip(text, (root) => { find(root, 'a').children.pop(); });
        expect(out).toBe('{"a":[1],"b":1}');
    });

    it('a fragment for the source pane uses the file\'s indent', () => {
        const { root, doc } = JsonParser.parseDocument('{\n\t"a": {\n\t\t"x": 1e3\n\t}\n}');
        expect(JsonParser.stringify(find(root, 'a'), { format: doc.format })).toBe('{\n\t"x": 1e3\n}');
    });
});

describe('JSON write-back keeps value kinds and number spelling', () => {
    it('regenerated containers still write 1.0, 1e3 and escapes as they were', () => {
        const text = '[1.0, 1e3, "\\u00e9", 10]';
        const out = roundTrip(text, (root) => { root.children.splice(3, 1); });
        expect(out).toBe('[1.0, 1e3, "\\u00e9"]');
    });

    it('an inline edit of a number, boolean or null stays that kind', () => {
        const text = '{"n": 1, "b": true, "z": null, "s": "1"}';
        const out = roundTrip(text, (root) => {
            find(root, 'n').value = '2.50';
            find(root, 'b').value = 'false';
            find(root, 'z').value = '0';
            find(root, 's').value = '2';
        });
        expect(out).toBe('{"n": 2.50, "b": false, "z": 0, "s": "2"}');
    });

    it('text typed over a number that is not a number becomes a string', () => {
        const out = roundTrip('{"n": 1}', (root) => { find(root, 'n').value = 'abc'; });
        expect(out).toBe('{"n": "abc"}');
    });

    it('parses scalars with their JSON types', () => {
        const root = JsonParser.parse('{"a": 1, "b": [true, null, "x"]}');
        expect(find(root, 'a').value).toBe(1);
        expect(find(root, 'a').type).toBe('property');
        expect(find(root, 'b').children.map((c) => c.value)).toEqual([true, null, 'x']);
    });

    it('rejects what JSON.parse rejects', () => {
        for (const bad of ['', '{', '{"a" 1}', '[1,]', '01', '{"a":1} x', "{'a':1}"]) {
            expect(() => JsonParser.parse(bad), bad).toThrow('JSON Parsing Error');
        }
    });
});

describe('numbers a JS number cannot hold', () => {
    it('flags unsafe integers, over-long fractions and overflow', () => {
        expect(isLossyNumber('12345678901234567890')).toBe(true);
        expect(isLossyNumber('9007199254740993')).toBe(true);
        expect(isLossyNumber('0.12345678901234567890')).toBe(true);
        expect(isLossyNumber('1e400')).toBe(true);
    });

    it('does not flag numbers that round-trip, whatever their spelling', () => {
        for (const n of ['0', '-0', '1.0', '1e3', '1E+3', '0.1', '9007199254740991', '-9007199254740991', '2.5e-7', '123.4500']) {
            expect(isLossyNumber(n), n).toBe(false);
        }
    });

    it('parseDocument lists them with their path — but not digits inside strings', () => {
        const { doc } = JsonParser.parseDocument('{"id": "12345678901234567890", "big": [1, 12345678901234567890]}');
        expect(doc.lossy).toEqual([{ raw: '12345678901234567890', path: ['big', 1] }]);
    });

    it('an untouched big number is still written exactly when the tree is written', () => {
        const text = '{"big": 12345678901234567890, "x": 1}';
        const out = roundTrip(text, (root) => { find(root, 'x').value = '2'; });
        expect(out).toBe('{"big": 12345678901234567890, "x": 2}');
    });
});
