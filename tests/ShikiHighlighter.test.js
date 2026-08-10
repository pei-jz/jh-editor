import { describe, it, expect } from 'vitest';
import { ShikiHighlighter } from '../src/modules/utils/ShikiHighlighter.js';

describe('ShikiHighlighter test', () => {
    it('initializes and highlights', async () => {
        console.log("Initializing Shiki...");
        await ShikiHighlighter.init();
        console.log("Initialized!");
        const code = "public class Foo {}";
        const hl = ShikiHighlighter.highlight(code, "java");
        console.log("Highlighted output snippet:", hl.slice(0, 100));
        expect(hl).toContain("Foo");
    });
});
