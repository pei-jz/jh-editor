import DOMPurify from 'dompurify';

/**
 * SanitizeHtml.js — the one place rendered Markdown is allowed to become DOM.
 *
 * Markdown is a document format that permits raw HTML, and `marked` passes that
 * HTML through by design. Every consumer here writes the result into the MAIN
 * document — not a sandboxed frame — so an `<img src=x onerror=…>` inside a
 * `.md` file used to run as privileged application script, with the Tauri IPC
 * bridge in reach. Opening a file someone else wrote is the whole point of
 * wiki-links, templates and workspace docs, so that is not a theoretical path.
 *
 * The rule is therefore: nothing produced from document text reaches innerHTML
 * without passing through `sanitizeHtml()` first.
 *
 * What survives sanitising is deliberately everything Markdown actually needs —
 * headings, tables, task lists, code blocks with their highlight spans, images,
 * `<details>`, and the `data-file-link` / `data-url-link` hooks the click
 * handlers rely on. What does not survive is `<script>`, event-handler
 * attributes, `<iframe>`, `<object>` and `javascript:` URLs. In practice a
 * legitimate document loses nothing.
 *
 * KaTeX is unaffected: math is rendered by walking the DOM *after* insertion,
 * so it writes its own trusted markup and never passes through here.
 */

// Tauri serves local files through the asset protocol: `asset://…` on
// macOS/Linux, `http://asset.localhost/…` on Windows. DOMPurify's default URI
// allow-list covers the Windows form (it is http) but would strip `asset:`,
// which would silently break every embedded image on the other platforms.
const ALLOWED_URI_REGEXP =
    /^(?:(?:https?|mailto|tel|callto|sms|ftp|asset|blob):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

const CONFIG = {
    ALLOWED_TAGS: [
        // Block structure
        'p', 'div', 'span', 'br', 'hr', 'blockquote', 'pre', 'code',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'ul', 'ol', 'li', 'dl', 'dt', 'dd',
        'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
        'details', 'summary', 'figure', 'figcaption',
        // Inline
        'a', 'img', 'em', 'strong', 'b', 'i', 'u', 's', 'del', 'ins', 'mark',
        'sub', 'sup', 'small', 'kbd', 'samp', 'var', 'abbr', 'cite', 'q', 'time',
        // GFM task lists render as disabled checkboxes
        'input',
    ],
    ALLOWED_ATTR: [
        'href', 'src', 'alt', 'title', 'class', 'id', 'lang', 'dir',
        'width', 'height', 'loading', 'align', 'colspan', 'rowspan', 'start',
        'type', 'checked', 'disabled', 'open', 'datetime', 'cite',
        // Click routing for links the editor handles itself.
        'data-file-link', 'data-url-link',
    ],
    ALLOWED_URI_REGEXP,
    // Embedded base64 images are a normal thing to paste into a note.
    ADD_DATA_URI_TAGS: ['img'],
    // `<style>` is not in ALLOWED_TAGS, and an inline `style` attribute is a
    // CSS injection surface with no Markdown feature behind it.
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form'],
    FORBID_ATTR: ['style'],
    // Keep the document's own text if a tag is dropped, rather than deleting
    // the paragraph that contained it.
    KEEP_CONTENT: true,
};

/**
 * Sanitise a rendered-Markdown HTML string for insertion into the main
 * document. Returns a string, so callers keep using `innerHTML =`.
 */
export function sanitizeHtml(html) {
    const src = String(html == null ? '' : html);
    if (!src) return '';
    return DOMPurify.sanitize(src, CONFIG);
}

/**
 * Escape a value being interpolated into an HTML attribute.
 *
 * Sanitising catches the result, but building broken markup and repairing it
 * afterwards is a bad habit: a title containing `"` would first close the
 * attribute and turn the rest of the string into attributes of its own.
 */
export function escapeAttr(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export default { sanitizeHtml, escapeAttr };
