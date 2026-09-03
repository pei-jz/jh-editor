import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeHtml, escapeAttr } from '../src/modules/utils/SanitizeHtml.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const read = (...p) => readFileSync(join(repo, ...p), 'utf8').replace(/\r\n/g, '\n');

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

describe('rendering diagrams more than once', () => {
    const src = read('src/modules/utils/Markdown.js');

    // Nodes are collected before the call joins the queue. Two calls covering
    // the same node both hold that list, and the second hands mermaid an
    // element that is already an <svg> — which it tries to parse as diagram
    // source and reports as "Syntax error in text". Narrowing again at run
    // time is what makes a redundant call harmless, and book mode needs one:
    // its pages are moved into the flipbook after the blocks render, so a
    // second pass has to be safe.
    it('drops nodes another run already finished', () => {
        expect(src).toContain('const pending = nodes.filter');
        expect(src).toContain('mermaid.run({ nodes: pending');
        expect(src, 'the stale list must not reach mermaid')
            .not.toContain('mermaid.run({ nodes, ');
    });

    it('renders again once the book pages are in place', () => {
        const view = read('src/modules/views/MarkdownView.js');
        const i = view.indexOf('loadFromHTML(pageElements)');
        expect(i).toBeGreaterThan(-1);
        const after = view.slice(i, i + 1200);
        expect(after).toContain('Markdown.renderMermaid(bookDiv)');
        // Measured after PageFlip has settled, or the open spread is not yet
        // the open spread.
        expect(after).toContain('requestAnimationFrame');
    });

    // mermaid sizes labels with getBBox, which measures nothing inside a
    // display:none subtree — and book mode folds away every page but the open
    // spread. Those diagrams have to be drawn when their page opens.
    it('draws the diagrams on a page when it is turned to', () => {
        const view = read('src/modules/views/MarkdownView.js');
        const i = view.indexOf("pageFlipInstance.on('flip'");
        expect(i).toBeGreaterThan(-1);
        expect(view.slice(i, i + 700)).toContain('Markdown.renderMermaid');
    });

    // The error graphic counts as a rendered diagram: querySelector('svg')
    // finds it, so every later pass skips the node and turning to the page
    // never helps. Anything whose source still parses gets its marks cleared
    // so a later attempt can succeed; a genuinely broken diagram keeps the
    // error, because retrying that only fills the console.
    it('lets a drawing failure be retried, but not a broken diagram', () => {
        // Resetting the element is not enough: mermaid keeps refusing a node
        // it already failed on, however the content is put back. Measured
        // against the bundled build - a fresh element draws, the same one
        // never does.
        expect(src).toContain('node.replaceWith(fresh)');
        const i = src.indexOf('async function _reportIfError');
        expect(i).toBeGreaterThan(-1);
        const fn = src.slice(i, src.indexOf('\n}', i));
        expect(fn).toContain('await mermaid.parse(src)');
        // The parse failure path reports and gives up.
        expect(fn).toContain('return false;');
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

    // Tauri does not serve this policy as written. At build time it puts a
    // nonce attribute on every <style> in the document, and at request time it
    // appends that nonce to style-src (tauri-utils html.rs inject_nonce, tauri
    // manager/mod.rs replace_csp_nonce). CSP says a nonce makes 'unsafe-inline'
    // be IGNORED — so the policy that actually ships is stricter than the one
    // configured here, and only in a packaged build. `tauri dev` never sees it:
    // the CSP is injected into bundled assets, not into what the dev server
    // serves.
    //
    // That shipped once. Every style="display: none;" in index.html was
    // blocked, so the welcome screen, the settings panel, the input dialog and
    // the shortcut guide all rendered at once on top of each other, and no
    // theme was applied. 73 violations, invisible to the whole test suite and
    // to every dev run.
    //
    // Tauri only rewrites script-src and style-src. Naming the two more
    // specific directives takes style elements and style attributes out of the
    // rewritten one, so what is configured is what runs.
    it('keeps inline styles working under the nonce Tauri injects', () => {
        const csp = conf.app.security.csp;

        // Runtime-injected <style> elements: CodeMirror, xterm, KaTeX and
        // mermaid all add their stylesheets this way.
        expect(csp['style-src-elem']).toContain("'unsafe-inline'");
        expect(csp['style-src-elem']).toContain("'self'");

        // style="..." attributes, including the ones index.html uses to keep
        // the modals hidden before any script runs.
        expect(csp['style-src-attr']).toContain("'unsafe-inline'");
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

/* 更新経路。配布物にコード署名はしない判断なので、「この更新が本物か」を
   担保するのは updater の署名だけになる。設定を一つ落とすと黙って無署名の
   更新を受け入れる、という壊れ方はしない (プラグインが拒否する) が、
   latest.json が生成されない・エンドポイントが違う、は黙って壊れる。 */
describe('updater', () => {
    const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
    const cap = JSON.parse(read('src-tauri/capabilities/default.json'));

    it('公開鍵が設定されている', () => {
        const key = conf.plugins.updater.pubkey;
        expect(key).toBeTruthy();
        // base64 の中身が minisign の公開鍵であること。秘密鍵を貼ってしまう
        // 事故は、ここで気づけないと git に入るまで気づけない。
        const decoded = Buffer.from(key, 'base64').toString('utf8');
        expect(decoded).toContain('minisign public key');
        expect(decoded).not.toContain('secret key');
    });

    it('配信先が指定されている', () => {
        expect(conf.plugins.updater.endpoints[0])
            .toBe('https://github.com/pei-jz/jh-editor/releases/latest/download/latest.json');
    });

    it('latest.json と署名を生成する設定になっている', () => {
        // これが false だと更新用の成果物が一切出ない。ビルドは成功するので
        // 気づけるのは「更新が来ない」と報告されたとき。
        expect(conf.bundle.createUpdaterArtifacts).toBe(true);
    });

    it('必要な権限がある', () => {
        const perms = cap.permissions.filter((p) => typeof p === 'string');
        expect(perms).toContain('updater:default');
        expect(perms).toContain('process:allow-restart');
    });

    it('Rust 側にプラグインが登録されている', () => {
        const lib = read('src-tauri/src/lib.rs');
        expect(lib).toContain('tauri_plugin_updater::Builder::new().build()');
        expect(lib).toContain('tauri_plugin_process::init()');
    });

    it('起動時に黙って更新せず、押したときだけ動く', () => {
        const settings = read('src/modules/ui/SettingsModal.js');
        // 入力中に勝手に再起動するエディタは、1 バージョン古いエディタより悪い。
        expect(settings).toContain('btn.onclick = async () => {');
        expect(settings).toContain("t('The update is installed. Restart now to use it?')");
        // 適用も再起動も、それぞれ本人の確認を挟む。ファイル全体ではなく
        // 更新の関数内に限って数える ― 設定画面には他にも確認ダイアログが
        // あり (ショートカットの初期化)、それを数えても意味がない。
        const fn = settings.slice(
            settings.indexOf('async function initUpdateCheck()'),
            settings.indexOf('export function initSettingsModal()'),
        );
        expect(fn.match(/await showConfirm\(/g) || []).toHaveLength(2);
    });

    it('Tauri の外ではボタンを隠す', () => {
        const settings = read('src/modules/ui/SettingsModal.js');
        // import の成否では判定できない ― Vite がバンドルするので素の
        // ブラウザでも import は成功し、失敗するのは呼んだときの IPC。
        expect(settings).toContain('window.__TAURI_INTERNALS__');
        expect(settings).toContain("btn.style.display = '';");
    });
});
