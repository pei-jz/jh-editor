import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeHtml, escapeAttr } from '../src/modules/utils/SanitizeHtml.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const read = (...p) => readFileSync(join(repo, ...p), 'utf8');

/*
   Opening a Markdown file someone else wrote used to be enough to run arbitrary
   commands: `marked` passes raw HTML straight through, the result went into the
   MAIN document's innerHTML, there was no CSP, and a general `run_command`
   handed any string to `cmd /C`. Four layers, each individually reasonable,
   that together turned "preview a README" into code execution.

   Every layer is closed now, and each one is cheap to reopen by accident — a
   new preview surface that forgets to sanitise, a `csp: null` restored while
   debugging. These tests are the tripwire.
*/

describe('sanitizeHtml — what must not survive', () => {
    it('drops script elements', () => {
        expect(sanitizeHtml('<p>hi</p><script>alert(1)</script>')).not.toMatch(/<script/i);
    });

    it('drops inline event handlers', () => {
        const out = sanitizeHtml('<img src="x" onerror="alert(1)">');
        expect(out).not.toMatch(/onerror/i);
    });

    it('drops javascript: URLs', () => {
        const out = sanitizeHtml('<a href="javascript:alert(1)">click</a>');
        expect(out).not.toMatch(/javascript:/i);
    });

    it('drops iframes and objects', () => {
        const out = sanitizeHtml('<iframe src="evil.html"></iframe><object data="x"></object>');
        expect(out).not.toMatch(/<iframe|<object/i);
    });

    it('drops style attributes and style elements', () => {
        const out = sanitizeHtml('<style>body{display:none}</style><p style="position:fixed">x</p>');
        expect(out).not.toMatch(/<style/i);
        expect(out).not.toMatch(/style=/i);
    });

    it('keeps the surrounding text when it removes a tag', () => {
        expect(sanitizeHtml('<p>before<script>x</script>after</p>')).toContain('before');
    });
});

describe('sanitizeHtml — what must survive', () => {
    it('keeps mermaid blocks and their escaped source', () => {
        const out = sanitizeHtml('<div class="mermaid">graph TD; A[Editor.js&lt;br/&gt;tabs]--&gt;B;</div>');
        expect(out).toContain('class="mermaid"');
        // The `<br/>` must still reach mermaid as text, not as an element.
        expect(out).toContain('&lt;br/&gt;');
    });

    it('keeps highlighted code blocks with their classes', () => {
        const out = sanitizeHtml('<pre><code class="language-js hljs"><span class="tok-keyword">const</span></code></pre>');
        expect(out).toContain('language-js hljs');
        expect(out).toContain('tok-keyword');
    });

    it('keeps the click-routing data attributes on links', () => {
        const out = sanitizeHtml('<a href="#" data-file-link="notes/a.md" data-url-link="">x</a>');
        expect(out).toContain('data-file-link="notes/a.md"');
    });

    it('keeps images served through the Tauri asset protocol', () => {
        // macOS / Linux use the asset: scheme, which is not in DOMPurify's
        // default allow-list — stripping it would blank every embedded image.
        expect(sanitizeHtml('<img src="asset://localhost/x.png">')).toContain('asset://');
        expect(sanitizeHtml('<img src="http://asset.localhost/x.png">')).toContain('asset.localhost');
        expect(sanitizeHtml('<img src="data:image/png;base64,iVBORw0K">')).toContain('data:image/png');
    });

    it('keeps tables, task lists and details', () => {
        const out = sanitizeHtml(
            '<table><tr><td>a</td></tr></table>'
            + '<ul><li><input type="checkbox" disabled checked>done</li></ul>'
            + '<details><summary>more</summary>body</details>',
        );
        expect(out).toContain('<table');
        expect(out).toContain('type="checkbox"');
        expect(out).toContain('<details');
    });

    it('handles empty and nullish input without throwing', () => {
        expect(sanitizeHtml('')).toBe('');
        expect(sanitizeHtml(null)).toBe('');
        expect(sanitizeHtml(undefined)).toBe('');
    });
});

describe('escapeAttr', () => {
    it('neutralises the characters that break out of an attribute', () => {
        expect(escapeAttr('a"b')).toBe('a&quot;b');
        expect(escapeAttr("a'b")).toBe('a&#39;b');
        expect(escapeAttr('<x>')).toBe('&lt;x&gt;');
        expect(escapeAttr('a&b')).toBe('a&amp;b');
    });

    it('escapes the ampersand first, so escapes are not double-encoded wrongly', () => {
        expect(escapeAttr('&quot;')).toBe('&amp;quot;');
    });

    it('returns an empty string for nullish input', () => {
        expect(escapeAttr(null)).toBe('');
        expect(escapeAttr(undefined)).toBe('');
    });
});

describe('rendered Markdown reaches the DOM sanitised', () => {
    const view = read('src/modules/views/MarkdownView.js');

    it('routes _parseMarkdown through the sanitiser', () => {
        expect(view).toMatch(/sanitizeHtml\(marked\.parse\(/);
    });

    it('escapes the mermaid fence body instead of injecting it raw', () => {
        expect(view).toContain('escapeForMermaid(code)');
        expect(view).not.toMatch(/class="mermaid">\$\{code\}/);
    });

    it('escapes link hrefs and titles before building the anchor', () => {
        expect(view).not.toMatch(/data-url-link="\$\{href\}"/);
        expect(view).not.toMatch(/ title="\$\{title\}"/);
    });

    it('sanitises AI output too — model text lands in the same document', () => {
        expect(read('src/modules/ui/InlineAI.js')).toMatch(/sanitizeHtml\(marked\.parse\(/);
        expect(read('src/modules/ui/AiChatPanel.js')).toMatch(/sanitizeHtml\(marked\.parse\(/);
    });
});

describe('no general shell command is exposed to the webview', () => {
    it('run_command is gone from the Rust commands', () => {
        expect(read('src-tauri/src/commands/app.rs')).not.toMatch(/pub async fn run_command/);
    });

    it('nothing in the frontend invokes it', () => {
        for (const f of ['src/modules/ui/GitPanel.js']) {
            expect(read(f)).not.toMatch(/invoke\(\s*['"]run_command['"]/);
        }
    });

    it('git runs through an argument array, not a command line', () => {
        const git = read('src-tauri/src/commands/git.rs');
        expect(git).toMatch(/pub async fn git_exec\(args: Vec<String>/);
        expect(read('src-tauri/src/lib.rs')).toContain('commands::git::git_exec');
        expect(read('src-tauri/src/lib.rs')).not.toContain('commands::app::run_command');
    });
});

describe('tauri configuration', () => {
    const conf = JSON.parse(read('src-tauri/tauri.conf.json'));

    it('sets a content security policy', () => {
        const csp = conf.app.security.csp;
        expect(csp).not.toBeNull();
        expect(csp['default-src']).toBe("'self'");
        expect(csp['object-src']).toBe("'none'");
        expect(csp['base-uri']).toBe("'self'");
    });

    it('pins the bundle identifier', () => {
        // The identifier is the path to the WebView2 data directory, and this
        // app keeps its settings, session, drafts and recent workspaces in
        // localStorage — which lives there. Changing it after release orphans
        // all of that and makes the installer treat the build as a different
        // application, so updates stop arriving too.
        //
        // It has already happened once in this project: a folder for the
        // misspelled `com.jh-editer.app` is still on disk, 7 GB of it.
        expect(conf.identifier).toBe('io.github.pei-jz.jheditor');
    });

    it('bundles only what has been tested on real hardware', () => {
        // "all" also produces macOS and Linux artefacts. The sh / open /
        // xdg-open branches compile but have not been run on those systems.
        expect(conf.bundle.targets).toEqual(['nsis']);
    });

    it('keeps the version in step across the three manifests', () => {
        const pkg = JSON.parse(read('package.json')).version;
        const cargo = read('src-tauri/Cargo.toml').match(/^version = "([^"]+)"/m)[1];
        expect(conf.version).toBe(pkg);
        expect(cargo).toBe(pkg);
    });
});

describe('mermaid', () => {
    const md = read('src/modules/utils/Markdown.js');

    it('runs in strict mode everywhere it is initialised', () => {
        expect(md).not.toMatch(/securityLevel:\s*'loose'/);
        expect(md.match(/securityLevel:\s*'strict'/g) || []).toHaveLength(2);
    });

    it('is not loaded at startup', () => {
        expect(read('index.html')).not.toMatch(/<script[^>]+mermaid\.min\.js/);
        expect(md).toContain('export function ensureMermaid');
    });
});
