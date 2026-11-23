/**
 * pdfjs-assets.js — the data files pdf.js fetches at run time, served under
 * /pdfjs/ (see src/modules/views/PdfView.js).
 *
 * pdf.js does not bundle them: it asks for a base URL and fetches the file it
 * needs when a document calls for it. Without them a Japanese PDF whose fonts
 * are not embedded draws as empty boxes (cmaps), a PDF that leans on the 14
 * standard fonts draws in a fallback (standard_fonts), and a JBIG2 or JPEG 2000
 * scan does not draw at all (the decoders under wasm/).
 *
 * Served from node_modules in dev and emitted into dist on build, so the files
 * are never copied into the repository and always match the installed version.
 *
 * Only the image decoders' plain-JS fallbacks are taken from wasm/. The .wasm builds
 * would need 'wasm-unsafe-eval' in the CSP's script-src, and a preview is not
 * worth loosening it for — PdfView passes useWasm: false.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const DIRS = {
    cmaps: () => true,
    // The Liberation fonts are left out: they are GPL-2.0 with a font
    // exception, which is more to carry in the installer than a fallback for
    // Arial — which Windows already has, and which pdf.js uses when the file
    // is not there. The Foxit fonts are BSD.
    standard_fonts: (name) => !/liberation/i.test(name),
    wasm: (name) => /^(jbig2|openjpeg)_nowasm_fallback\.js$/.test(name)
        || /^LICENSE_(PDFJS_)?(JBIG2|OPENJPEG)$/.test(name),
};

const TYPES = {
    '.js': 'text/javascript',
    '.bcmap': 'application/octet-stream',
    '.pfb': 'application/octet-stream',
    '.ttf': 'font/ttf',
};

function pdfjsRoot(root) {
    return join(root, 'node_modules', 'pdfjs-dist');
}

/** Every file to publish, as [published path under pdfjs/, absolute source]. */
export function pdfjsAssetFiles(root) {
    const base = pdfjsRoot(root);
    const out = [];
    for (const [dir, keep] of Object.entries(DIRS)) {
        const abs = join(base, dir);
        if (!existsSync(abs)) continue;
        for (const name of readdirSync(abs)) {
            if (keep(name)) out.push([`${dir}/${name}`, join(abs, name)]);
        }
    }
    return out;
}

export function pdfjsAssets(root) {
    return {
        name: 'jh-pdfjs-assets',
        configureServer(server) {
            const files = new Map(pdfjsAssetFiles(root));
            server.middlewares.use((req, res, next) => {
                const url = (req.url || '').split('?')[0];
                if (!url.startsWith('/pdfjs/')) return next();
                const source = files.get(decodeURIComponent(url.slice('/pdfjs/'.length)));
                if (!source) return next();
                res.setHeader('Content-Type', TYPES[extname(source)] || 'application/octet-stream');
                res.end(readFileSync(source));
            });
        },
        generateBundle() {
            for (const [path, source] of pdfjsAssetFiles(root)) {
                this.emitFile({ type: 'asset', fileName: `pdfjs/${path}`, source: readFileSync(source) });
            }
        },
    };
}
