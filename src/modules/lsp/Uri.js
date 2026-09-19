/**
 * Uri.js — the two conversions between a filesystem path and a `file:` URI.
 *
 * Both were done inline, by hand, in six places:
 *
 *     const uri  = `file:///${filePath.replace(/\\/g, '/').replace(/^\//, '')}`;
 *     const path = uri.replace('file:///', '').replace('file://', '');
 *
 * Neither is a URI conversion. The first never percent-encodes, so a path with
 * a space, a `#` or a non-ASCII character in it — `C:/Users/裴京植/...` is one —
 * goes out malformed. The second never percent-DECODES, and a language server
 * answers with a properly encoded URI, so what came back was `c%3A/Users/...`.
 *
 * What that cost, visibly: F12 on a symbol defined in the file you were already
 * reading opened a SECOND tab for it. The path that came back out of the server
 * did not string-match the path the tab was opened under — a lowercase drive
 * letter is enough — and the editor had no reason to think they were the same
 * file. Two tabs, same file, separate undo histories, and a save from the wrong
 * one silently undoing the other.
 */

/** Is this a Windows drive path (`C:/…`)? */
const hasDriveLetter = (p) => /^[a-zA-Z]:(?=[/\\]|$)/.test(p);

/**
 * `C:\dir\file.rs` → `file:///C:/dir/file.rs`, percent-encoded.
 *
 * Encoded per segment so the separators survive: encodeURIComponent would turn
 * every `/` into `%2F` and the server would see one long filename. The drive's
 * colon is left as-is, which is what every language server writes and reads.
 */
export function pathToUri(filePath) {
    const path = String(filePath || '').replace(/\\/g, '/');
    if (!path) return '';
    // A UNC path (`//server/share`) keeps its authority; everything else is
    // rooted at the empty authority that `file:///` already carries.
    const unc = path.startsWith('//');
    const body = unc ? path.slice(2) : path.replace(/^\/+/, '');
    const encoded = body.split('/').map((seg, i) => (
        // The drive letter segment is `C:` and must stay `C:`.
        i === 0 && !unc && hasDriveLetter(seg) ? seg : encodeURIComponent(seg)
    )).join('/');
    return unc ? `file://${encoded}` : `file:///${encoded}`;
}

/**
 * `file:///c%3A/dir/file.rs` → `C:/dir/file.rs`.
 *
 * Decoded, separators normalised, and the drive letter upper-cased — because
 * the only thing downstream does with this is compare it against the paths of
 * the tabs that are already open, and `c:` and `C:` are the same file.
 */
export function uriToPath(uri) {
    let s = String(uri || '');
    if (!s) return '';
    if (s.startsWith('file://')) {
        s = s.slice('file://'.length);
        // `file://server/share` is a UNC path; `file:///C:/…` and `file:///home`
        // have the empty authority and a leading slash that belongs to the path.
        if (!s.startsWith('/')) return normalizeDrive(decodeSegments(`//${s}`));
        s = s.slice(1);
    }
    const decoded = decodeSegments(s);
    // A decoded Windows path must not keep the slash that separated it from the
    // empty authority: `/C:/dir` is not a path anyone can open.
    return normalizeDrive(hasDriveLetter(decoded) ? decoded : `/${decoded}`.replace(/^\/+/, '/'));
}

/** Percent-decode each segment, leaving a malformed one as it arrived. */
function decodeSegments(path) {
    return path.split('/').map((seg) => {
        try {
            return decodeURIComponent(seg);
        } catch (_) {
            // A stray '%' is not an escape. Better a path with a '%' in it than
            // a thrown URIError in the middle of Go to Definition.
            return seg;
        }
    }).join('/');
}

/** `c:/dir` → `C:/dir`. Everything else is returned untouched. */
export function normalizeDrive(path) {
    const p = String(path || '').replace(/\\/g, '/');
    return hasDriveLetter(p) ? p[0].toUpperCase() + p.slice(1) : p;
}
