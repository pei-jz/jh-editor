import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pathToUri, uriToPath, normalizeDrive } from '../src/modules/lsp/Uri.js';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));

const { findOpenFile } = await import('../src/modules/core/Panes.js');
const { State } = await import('../src/modules/core/Store.js');

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '..', rel), 'utf8').split('\r\n').join('\n');

/* F12 on a symbol defined in the file you were already reading opened a SECOND
   tab for that file. Two conversions were being done by hand, and neither was a
   URI conversion:

       const uri  = `file:///${filePath.replace(/\\/g, '/')…}`   // never encodes
       const path = uri.replace('file:///', '')…                 // never decodes

   A language server answers with a properly formed URI, so what came back was
   percent-encoded and carried whatever case IT uses for the drive letter. The
   editor compared that against the path the tab was opened under, found no
   match, and opened the file again — two tabs over one document, each with its
   own undo history, and a save from the stale one reverting the other. */

describe('path → URI', () => {
    it('makes a URI a language server will accept', () => {
        expect(pathToUri('C:\\proj\\src\\main.rs')).toBe('file:///C:/proj/src/main.rs');
        expect(pathToUri('C:/proj/src/main.rs')).toBe('file:///C:/proj/src/main.rs');
    });

    /* The outgoing half was broken too, just less visibly: a path with a space
       or a '#' in it went out malformed and the server answered about a file
       that does not exist. This machine's own home directory is
       C:/Users/裴京植, so "non-ASCII paths are rare" was never true here. */
    it('percent-encodes what a URI cannot carry raw', () => {
        expect(pathToUri('C:/my docs/a.rs')).toBe('file:///C:/my%20docs/a.rs');
        expect(pathToUri('C:/proj/a#b.rs')).toBe('file:///C:/proj/a%23b.rs');
        expect(pathToUri('C:/Users/裴京植/x.rs'))
            .toBe('file:///C:/Users/%E8%A3%B4%E4%BA%AC%E6%A4%8D/x.rs');
    });

    // Per segment, not whole: encodeURIComponent on the lot turns every
    // separator into %2F and the server sees one very long filename.
    it('leaves the separators alone', () => {
        expect(pathToUri('C:/a/b/c.rs')).toBe('file:///C:/a/b/c.rs');
        expect(pathToUri('C:/a/b/c.rs')).not.toContain('%2F');
    });

    it('keeps a POSIX path rooted', () => {
        expect(pathToUri('/home/x/main.rs')).toBe('file:///home/x/main.rs');
    });

    it('keeps a UNC path\u2019s server name', () => {
        expect(pathToUri('//server/share/a.rs')).toBe('file://server/share/a.rs');
    });
});

describe('URI → path', () => {
    it('decodes what the server encoded', () => {
        expect(uriToPath('file:///c%3A/proj/main.rs')).toBe('C:/proj/main.rs');
        expect(uriToPath('file:///C:/my%20docs/a.rs')).toBe('C:/my docs/a.rs');
        expect(uriToPath('file:///C:/Users/%E8%A3%B4%E4%BA%AC%E6%A4%8D/x.rs'))
            .toBe('C:/Users/裴京植/x.rs');
    });

    /* The drive letter is upper-cased on the way back, because the only thing
       done with this path is compare it against the tabs already open. */
    it('settles the drive letter\u2019s case', () => {
        expect(uriToPath('file:///c:/proj/main.rs')).toBe('C:/proj/main.rs');
        expect(uriToPath('file:///C:/proj/main.rs')).toBe('C:/proj/main.rs');
    });

    // `file:///C:/…` has an EMPTY authority and a leading slash that belongs to
    // the URI, not the path. `/C:/proj` is not something Windows can open.
    it('does not leave a Windows path starting with a slash', () => {
        expect(uriToPath('file:///C:/proj/main.rs')).not.toMatch(/^\//);
    });

    it('keeps a POSIX path absolute', () => {
        expect(uriToPath('file:///home/x/main.rs')).toBe('/home/x/main.rs');
    });

    it('reads a UNC URI back as a UNC path', () => {
        expect(uriToPath('file://server/share/a.rs')).toBe('//server/share/a.rs');
    });

    /* A stray '%' is not an escape sequence. Throwing a URIError in the middle
       of Go to Definition would take the whole jump down over a filename. */
    it('survives a malformed escape instead of throwing', () => {
        expect(() => uriToPath('file:///C:/100%/a.rs')).not.toThrow();
        expect(uriToPath('file:///C:/100%/a.rs')).toBe('C:/100%/a.rs');
    });

    it('takes a bare path as a path', () => {
        expect(uriToPath('C:/proj/main.rs')).toBe('C:/proj/main.rs');
        expect(uriToPath('')).toBe('');
    });
});

describe('the two conversions agree with each other', () => {
    it('round-trips every shape of path', () => {
        for (const path of [
            'C:/proj/src/main.rs',
            'C:/my docs/a #1.rs',
            'C:/Users/裴京植/x.rs',
            '/home/x/main.rs',
            '//server/share/a.rs',
        ]) {
            expect(uriToPath(pathToUri(path)), path).toBe(path);
        }
    });
});

/* The other half of the fix. Even with the URI conversion right, ANY caller
   that arrives with a differently-cased path — the explorer, a dropped file, a
   command-line argument, a language server — would open a duplicate. On
   Windows, case is not part of a file's identity. */
describe('finding the tab a file is already open in', () => {
    const tab = (path) => ({ path, name: path.split('/').pop(), content: '' });

    beforeEach(() => {
        State.openFiles = [tab('C:/proj/src-tauri/src/commands/fs.rs')];
        State.rightOpenFiles = [];
        State.activeTabIndex = 0;
        State.rightActiveTabIndex = -1;
        State.splitMode = null;
    });

    it('finds it when the path matches exactly', () => {
        expect(findOpenFile('C:/proj/src-tauri/src/commands/fs.rs')).toBeTruthy();
    });

    // The reported bug: the same file, with the drive letter the server used.
    it('finds it when only the drive letter\u2019s case differs', () => {
        expect(findOpenFile('c:/proj/src-tauri/src/commands/fs.rs')).toBeTruthy();
    });

    it('finds it whatever the case, since Windows has none', () => {
        expect(findOpenFile('C:/PROJ/Src-Tauri/src/Commands/FS.rs')).toBeTruthy();
    });

    it('finds it through backslashes', () => {
        expect(findOpenFile('C:\\proj\\src-tauri\\src\\commands\\fs.rs')).toBeTruthy();
    });

    it('still says no to a different file', () => {
        expect(findOpenFile('C:/proj/src-tauri/src/commands/git.rs')).toBeNull();
    });

    /* POSIX keeps its case: there, `a.rs` and `A.rs` ARE two files, and
       matching them would open the wrong one. The drive letter is what tells
       the two worlds apart. */
    it('leaves POSIX paths case-sensitive', () => {
        State.openFiles = [tab('/home/x/a.rs')];
        expect(findOpenFile('/home/x/a.rs')).toBeTruthy();
        expect(findOpenFile('/home/x/A.rs')).toBeNull();
    });

    it('searches the right-hand pane too', () => {
        State.openFiles = [];
        State.rightOpenFiles = [tab('C:/proj/a.rs')];
        const hit = findOpenFile('c:/proj/a.rs');
        expect(hit).toBeTruthy();
        expect(hit.pane).toBe('right');
    });
});

/* Six copies of two one-line conversions is how they came to disagree with each
   other in the first place. */
describe('nothing builds a file URI by hand any more', () => {
    for (const rel of ['src/modules/lsp/LspClient.js', 'src/modules/views/CodeMirrorView.js']) {
        it(`${rel.split('/').pop()} goes through Uri.js`, () => {
            const src = read(rel);
            expect(src).not.toMatch(/`file:\/\/\/\$\{/);
            expect(src).not.toContain("replace('file:///', '')");
            expect(src).toMatch(/from '\.[./]*\/?(lsp\/)?Uri\.js'/);
        });
    }
});
