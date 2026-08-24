
import { SyntaxHighlighter } from './SyntaxHighlighter.js';
import { isDarkTheme } from './ThemeInfo.js';

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
                return `<div class="mermaid">${code}</div>`;
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

export function initMermaid() {
    if (typeof mermaid === 'undefined') {
        console.error('Mermaid library not found');
        return;
    }
    try {
        const isDark = isDarkTheme();
        mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'loose',
            theme: isDark ? 'dark' : 'default'
        });
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

export async function renderMermaid(container = document) {
    if (typeof mermaid === 'undefined') return;

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
        .filter(n => !n.getAttribute('data-processed') && !n.querySelector('svg'));
    if (nodes.length === 0) return;

    // Keep the source so a failed render can show the code instead of a blank
    // block, and so a retry has something to parse.
    for (const n of nodes) {
        if (!n.dataset.mermaidSrc) n.dataset.mermaidSrc = n.textContent;
        // mermaid needs a unique id per diagram; duplicates silently drop one.
        if (!n.id) n.id = `mmd-${Date.now().toString(36)}-${++_mermaidSeq}`;
    }

    _mermaidQueue = _mermaidQueue.then(async () => {
        try {
            const isDark = isDarkTheme();
            mermaid.initialize({
                startOnLoad: false,
                securityLevel: 'loose',
                theme: isDark ? 'dark' : 'default'
            });
            await mermaid.run({ nodes, suppressErrors: true });
        } catch (e) {
            console.error('Mermaid rendering error', e);
        }
        for (const n of nodes) {
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
            _fixSvgHeight(svg);
        }
    }).catch((e) => { console.error('Mermaid queue error', e); });

    return _mermaidQueue;
}
