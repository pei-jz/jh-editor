
import { SyntaxHighlighter } from './SyntaxHighlighter.js';
import { mermaidConfig, hasOwnTheme } from './MermaidTheme.js';

/**
 * Escape a mermaid source so the DOM hands it back unchanged.
 *
 * Only the three characters that make the HTML parser do something. Quotes are
 * left alone: this lands in a text node, not an attribute, and mermaid's own
 * syntax uses them.
 */
export function escapeForMermaid(code) {
    return String(code == null ? '' : code)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export function configureMarkdown() {
    // Dependency Check
    if (typeof marked === 'undefined') {
        console.error('Marked library not found');
        return;
    }

    // Configure Renderer
    const renderer = {
        code(codeOrObj, infostring, escaped) {
            let code = codeOrObj;
            let lang = infostring;
            if (typeof codeOrObj === 'object' && codeOrObj !== null) {
                code = codeOrObj.text !== undefined ? codeOrObj.text : codeOrObj.code;
                lang = codeOrObj.lang;
            }

            // Check for Mermaid
            lang = (lang || '').match(/\S*/)[0];
            const isMermaid = lang === 'mermaid';
            const isMermaidContent = !isMermaid && /^\s*(graph|sequenceDiagram|classDiagram|stateDiagram|gantt|pie|erDiagram|flowchart)\s/.test(code);

            if (isMermaid || isMermaidContent) {
                // ESCAPED, not interpolated raw. Mermaid labels legitimately
                // contain markup — `A[Editor.js<br/>tabs]` is how you get two
                // lines in a node — and injecting the fence as HTML let the
                // browser consume that `<br/>` as a real element before mermaid
                // ever saw it. What reached the parser was
                // `A[Editor.jstabs, panes]`: a comma in an unquoted label, i.e.
                // "Syntax error in text" on the very first render.
                return `<div class="mermaid">${escapeForMermaid(code)}</div>`;
            }
            return false; // Toggle default renderer
        }
    };

    marked.use({
        renderer,
        pedantic: false,
        gfm: true,
        breaks: true,
        highlight: function (code, lang) {
            return SyntaxHighlighter.highlight(code, lang);
        }
    });
}

/** Where the mermaid bundle lives once Vite has copied `public/` into `dist/`. */
const MERMAID_SRC = '/lib/mermaid.min.js';

let _mermaidLoad = null;

/**
 * Load mermaid on first use, not at startup.
 *
 * The bundle is ~2.7 MB. It used to be a plain `<script>` in index.html, so
 * every window paid to parse it on launch — including the windows that only
 * ever open a log file. Diagrams are common in Markdown and rare everywhere
 * else, so the cost belongs at the first diagram, not at every boot.
 *
 * Resolves to false rather than throwing when the file is missing: a document
 * that cannot draw its diagram should still render its prose.
 */
export function ensureMermaid() {
    if (typeof mermaid !== 'undefined') return Promise.resolve(true);
    if (_mermaidLoad) return _mermaidLoad;

    _mermaidLoad = new Promise((resolve) => {
        let settled = false;
        const finish = (ok) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            // On failure the cached promise is cleared so the next diagram
            // retries, instead of every later render inheriting one bad load.
            if (!ok) _mermaidLoad = null;
            resolve(ok);
        };

        // A script tag that neither loads nor errors would leave every caller
        // awaiting forever, and renderMermaid is awaited by the preview path.
        // Far longer than reading a local file, short enough to end.
        const timer = setTimeout(() => {
            console.error('Mermaid library timed out loading from', MERMAID_SRC);
            finish(false);
        }, 20000);

        const script = document.createElement('script');
        script.src = MERMAID_SRC;
        script.async = true;
        script.onload = () => {
            initMermaid();
            finish(typeof mermaid !== 'undefined');
        };
        script.onerror = () => {
            console.error('Mermaid library failed to load from', MERMAID_SRC);
            finish(false);
        };
        document.head.appendChild(script);
    });
    return _mermaidLoad;
}

let _elkLoad = null;
let _elkReady = false;

/**
 * Register the ELK layout engine with mermaid, once.
 *
 * ELK routes edges orthogonally and places nodes so that edges and their
 * labels do not run through each other, which dagre (mermaid's default) does
 * not try to do. It is ~4 MB, so it is a separate chunk fetched with the first
 * diagram, after mermaid itself.
 *
 * Resolves to false when it cannot be had; diagrams then fall back to dagre
 * rather than failing to draw.
 */
function ensureElk() {
    if (_elkLoad) return _elkLoad;
    if (typeof mermaid === 'undefined' || typeof mermaid.registerLayoutLoaders !== 'function') {
        return Promise.resolve(false);
    }
    _elkLoad = import('@mermaid-js/layout-elk')
        .then((mod) => {
            mermaid.registerLayoutLoaders(mod.default);
            _elkReady = true;
            return true;
        })
        .catch((e) => {
            console.error('ELK layout failed to load; using dagre', e);
            return false;
        });
    return _elkLoad;
}

export function initMermaid() {
    if (typeof mermaid === 'undefined') {
        console.error('Mermaid library not found');
        return;
    }
    try {
        // securityLevel is 'strict', not 'loose' (set in mermaidConfig). Loose
        // lets a diagram's `click` directive call arbitrary JavaScript and
        // passes HTML in labels straight through — from a fence in a document
        // the user merely opened, in the privileged main window. Strict
        // encodes label HTML and runs mermaid's own sanitiser over the SVG it
        // produces. `<br/>` still breaks lines: mermaid splits on it itself
        // rather than relying on the HTML parser.
        mermaid.initialize(mermaidConfig({ elk: _elkReady }));
    } catch (e) {
        console.error('Mermaid init failed', e);
    }
}

/**
 * Some diagram types (mindmap above all) come back with height="100%", which
 * resolves to 0 inside an auto-height block — the diagram is there but
 * invisible. Derive a real pixel height from the viewBox aspect ratio.
 */
function _fixSvgHeight(svg) {
    try {
        const h = svg.getAttribute('height');
        if (h && !/%/.test(h)) return; // already a concrete size
        const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
        if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
            const width = svg.clientWidth || svg.getBoundingClientRect().width || vb[2];
            svg.style.height = `${Math.round((width * vb[3]) / vb[2])}px`;
        } else {
            svg.style.height = 'auto';
        }
        svg.removeAttribute('height');
    } catch (_) { /* cosmetic only */ }
}

// mermaid.run() mutates global parser state, so two overlapping calls corrupt
// each other and surface as a bogus "Syntax error in text". The live preview
// re-renders on every keystroke, so overlap is the normal case — serialise all
// runs through this promise chain.
let _mermaidQueue = Promise.resolve();
let _mermaidSeq = 0;

/**
 * Say why a diagram failed.
 *
 * `suppressErrors: true` keeps one bad diagram from taking the rest of the
 * page down, but it also means mermaid never throws for a syntax error — it
 * draws its bomb and returns normally. So the catch around mermaid.run() never
 * fires for the one failure mode people actually hit, and the console stays
 * empty while the page shows "Syntax error in text".
 *
 * mermaid.parse() does throw, and its message names the line and the token.
 * Called only on a node that already rendered as an error, so the cost lands
 * on the failing case alone.
 */
async function _reportIfError(node, svg) {
    // mermaid marks its error graphic; fall back to the visible text for
    // versions that do not.
    const looksBroken = svg.getAttribute('aria-roledescription') === 'error'
        || /Syntax error in text/i.test(svg.textContent || '');
    if (!looksBroken) return false;

    const src = node.dataset.mermaidSrc || '';
    try {
        await mermaid.parse(src);
    } catch (e) {
        // The grammar really is wrong. Leave the error graphic in place:
        // retrying something that cannot succeed only fills the console.
        console.error('Mermaid syntax error:', (e && e.message) || e);
        console.error('Mermaid source was:\n' + src);
        return false;
    }

    // The source parses, so this was the drawing rather than the diagram.
    // mermaid measures label text with getBBox, which returns nothing inside a
    // display:none subtree — and book mode keeps every page but the open
    // spread folded away.
    //
    // The element has to be REPLACED, not reset. Measured against the bundled
    // mermaid 11.12.2 with this exact diagram:
    //
    //     render while open     ok
    //     render while folded   ERROR
    //     same node, revealed   ERROR   <- resetting text + marks is not enough
    //     fresh node            ok
    //     trivial diagram after ok      <- mermaid's own state is fine
    //
    // Something stays on the element mermaid already gave up on, and it keeps
    // refusing that node however the content is put back. A new element with
    // no id gets a fresh one on the next pass and draws.
    //
    // Leaving the error graphic in place is not an option either: it counts as
    // a rendered diagram, so every later pass skips the node and turning to
    // the page never helps.
    _restoreFresh(node);
    return true;
}

/** Put a node back to source on a NEW element, ready for a later pass. */
function _restoreFresh(node) {
    const src = node.dataset.mermaidSrc || '';
    const fresh = node.ownerDocument.createElement('div');
    fresh.className = node.className;
    fresh.dataset.mermaidSrc = src;
    fresh.textContent = src;
    node.replaceWith(fresh);
}

/**
 * Can this node be laid out right now?
 *
 * Inside a display:none subtree nothing has a size, and book mode keeps every
 * page but the open spread folded that way. dagre gave up on such a diagram
 * with an error graphic, which _reportIfError turned into a retry. ELK does
 * not fail: it lays out zero-sized boxes and returns a 16x16 drawing, which
 * looks like success, so the page later opens on an empty square that is
 * never redrawn. Such a node is left as source until it can be seen; the
 * book view renders again whenever a spread opens.
 *
 * checkVisibility() is absent in jsdom; treating that as visible keeps the
 * tests drawing everything as before.
 */
function _canMeasure(node) {
    if (!node.isConnected) return false;
    return typeof node.checkVisibility === 'function' ? node.checkVisibility() : true;
}

/**
 * A drawing with no extent: what ELK produces when it measured nothing. The
 * diagram parsed, so this is worth another attempt once the node is visible.
 */
function _isEmptyDrawing(svg) {
    const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
    return vb.length === 4 && vb[2] <= 16 && vb[3] <= 16;
}

export async function renderMermaid(container = document) {
    // Every diagram render in the app funnels through here, which is why this
    // is where the library gets loaded: nothing else has to remember to.
    if (!(await ensureMermaid())) return;

    // 1. Fallback for language-mermaid class
    const defaultBlocks = container.querySelectorAll('code.language-mermaid');
    defaultBlocks.forEach(codeBlock => {
        const pre = codeBlock.parentElement;
        if (pre && pre.tagName === 'PRE') {
            const div = document.createElement('div');
            div.className = 'mermaid';
            div.textContent = codeBlock.textContent;
            pre.replaceWith(div);
        }
    });

    // 2. Collect the nodes that still hold SOURCE. Re-running mermaid over a
    //    node it already turned into an <svg> makes it try to parse that SVG —
    //    the other source of the phantom "Syntax error in text".
    const nodes = Array.from(container.querySelectorAll('.mermaid'))
        .filter(n => !n.getAttribute('data-processed') && !n.querySelector('svg'))
        .filter(_canMeasure);
    if (nodes.length === 0) return;

    // Keep the source so a failed render can show the code instead of a blank
    // block, and so a retry has something to parse.
    for (const n of nodes) {
        if (!n.dataset.mermaidSrc) n.dataset.mermaidSrc = n.textContent;
        // mermaid needs a unique id per diagram; duplicates silently drop one.
        if (!n.id) n.id = `mmd-${Date.now().toString(36)}-${++_mermaidSeq}`;
    }

    _mermaidQueue = _mermaidQueue.then(async () => {
        // 集めたのはキューに入る前。順番待ちのあいだに、別の呼び出しが同じ
        // ノードを描き終えていることがある。済んだものを渡すと mermaid は
        // その <svg> を図の記述として読もうとし、「Syntax error in text」に
        // なる。走る直前にもう一度絞れば、重ねて呼ばれても害が無い。
        // Visibility is checked again for the same reason: a page can be
        // folded away while this run waited its turn.
        const pending = nodes.filter(
            (n) => !n.getAttribute('data-processed') && !n.querySelector('svg')
                && _canMeasure(n));
        if (pending.length === 0) return;

        try {
            const elk = await ensureElk();
            // Re-initialised per run to pick up a theme change. Both calls
            // build their settings in one place, so securityLevel cannot
            // drift between them: a second 'loose' here would have quietly
            // undone the first one.
            //
            // Colours come from the document being drawn into. The print path
            // renders into a bare iframe with no theme on it, and paper wants
            // the light palette whatever the editor is showing.
            const doc = (container && container.ownerDocument) || document;
            // A diagram that names its own theme is drawn in a separate pass
            // without the app palette: mermaid layers site-wide
            // themeVariables over named themes too, so a `forest` chosen in
            // the diagram would otherwise come out in the app's colours.
            const own = pending.filter((n) => hasOwnTheme(n.dataset.mermaidSrc));
            const rest = pending.filter((n) => !own.includes(n));
            for (const [batch, themed] of [[rest, true], [own, false]]) {
                if (batch.length === 0) continue;
                mermaid.initialize(mermaidConfig({ elk, doc, themed }));
                await mermaid.run({ nodes: batch, suppressErrors: true });
            }
        } catch (e) {
            console.error('Mermaid rendering error', e);
        }
        for (const n of pending) {
            const svg = n.querySelector('svg');
            // Anything mermaid gave up on (or blanked) gets its source back, so
            // the user sees the diagram text rather than an empty block.
            if (!svg) {
                if (n.dataset.mermaidSrc) {
                    n.textContent = n.dataset.mermaidSrc;
                    n.removeAttribute('data-processed');
                }
                continue;
            }
            // Restored for a later attempt: there is no SVG to size any more.
            if (await _reportIfError(n, svg)) continue;
            if (_isEmptyDrawing(svg)) {
                _restoreFresh(n);
                continue;
            }
            _fixSvgHeight(svg);
        }
    }).catch((e) => { console.error('Mermaid queue error', e); });

    return _mermaidQueue;
}

/**
 * Redraw every diagram already on the page.
 *
 * A drawn diagram carries its colours inline in the SVG, so a theme switch
 * leaves it in the old palette until something re-renders the block. The
 * node itself is kept — the lightbox listener lives on it — and only its
 * content goes back to source.
 */
export function refreshMermaid(container = document) {
    if (typeof mermaid === 'undefined') return Promise.resolve();
    const drawn = Array.from(container.querySelectorAll('.mermaid'))
        .filter((n) => n.dataset.mermaidSrc && n.querySelector('svg'));
    if (drawn.length === 0) return Promise.resolve();
    for (const n of drawn) {
        n.textContent = n.dataset.mermaidSrc;
        n.removeAttribute('data-processed');
    }
    return renderMermaid(container);
}

if (typeof window !== 'undefined') {
    window.addEventListener('themeChanged', () => {
        refreshMermaid(document).catch((e) => console.error('Mermaid refresh failed', e));
    });
}
