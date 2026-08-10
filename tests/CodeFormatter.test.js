import { describe, it, expect } from 'vitest';
import { CodeFormatter } from '../src/modules/utils/CodeFormatter.js';

describe('CodeFormatter', () => {
    it('should format JSON correctly', () => {
        const input = '{"name":"test","value":1}';
        const expected = '{\n  "name": "test",\n  "value": 1\n}';
        const result = CodeFormatter.format(input, 'json');
        expect(result).toBe(expected);
    });

    it('should return original string if JSON is invalid', () => {
        const input = '{invalid_json:]';
        const result = CodeFormatter.format(input, 'json');
        expect(result).toBe(input);
    });

    it('should format XML correctly', () => {
        const input = '<root><child>value</child></root>';
        // The formatter uses regex replacement, expectation depends on implementation
        const result = CodeFormatter.format(input, 'xml');
        expect(result).toContain('<root>');
        expect(result).toContain('  <child>value</child>');
        expect(result).toContain('</root>');
    });

    it('should format SQL correctly', () => {
        const input = 'select * from users where id=1';
        const result = CodeFormatter.format(input, 'sql');
        expect(result).toContain('SELECT'); // First word, no leading newline
        expect(result).toContain('\nFROM');
        expect(result).toContain('\nWHERE');
    });

    it('should format Javascript correctly', () => {
        // C-style formatter only manages indents on existing lines, so we must provide newlines
        const input = 'function test() {\nconsole.log("hello");\n}';
        const result = CodeFormatter.format(input, 'js');
        expect(result).toContain('function test() {');
        expect(result).toContain('    console.log("hello");');
        expect(result).toContain('}');
    });

    it('should format single-line Javascript correctly (Inserting Newlines)', () => {
        const input = 'function test(){console.log("hello");if(true){return 1;}}';
        const result = CodeFormatter.format(input, 'js');
        const lines = result.split('\n');
        expect(lines[0].trim()).toBe('function test() {');
        expect(lines[1].trim()).toBe('console.log("hello");');
        expect(lines[2].trim()).toBe('if (true) {');
        expect(lines[3].trim()).toBe('return 1;');
        expect(lines[4].trim()).toBe('}');
        expect(lines[5].trim()).toBe('}');
    });
});
