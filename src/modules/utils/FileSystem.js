
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { stat } from '@tauri-apps/plugin-fs';

export async function onSearchProgress(callback) {
    return await listen('search-progress', callback);
}

export async function onScanProgress(callback) {
    return await listen('scan-progress', callback);
}

export function getOsLineEnding() {
    const ua = navigator.userAgent || '';
    if (ua.indexOf('Windows') !== -1) return '\r\n';
    if (ua.indexOf('Mac') !== -1 || ua.indexOf('iPad') !== -1 || ua.indexOf('iPhone') !== -1) {
        if (ua.indexOf('iPhone') !== -1 || ua.indexOf('iPad') !== -1) return '\r';
        return '\n';
    }
    if (ua.indexOf('Linux') !== -1) return '\n';
    return '\n';
}

/**
 * Size and modification time for a path, or null when there is none to be had.
 *
 * Goes through the backend rather than `@tauri-apps/plugin-fs`'s `stat`. That
 * one is limited by the plugin's `fs:scope`, so a workspace outside `$HOME` was
 * refused — and because the refusal came back as null, the status bar simply
 * showed no modification date, for every file, forever.
 */
export async function getFileStats(path) {
    try {
        return await invoke('file_stats', { path });
    } catch (e) {
        // A deleted or unreadable file is a normal answer, not a fault.
        console.warn('FS: getFileStats failed', path, e);
        return null;
    }
}

export async function readDirectory(path) {
    try {
        const entries = await invoke('read_dir', { path });
        // Transform Rust entries to match application expectation
        // Rust returns: { name, is_directory, path }
        // App expects match: { entry: name, type: 'DIRECTORY'|'FILE' }
        const BINARY_EXTENSIONS = new Set([
            'exe', 'dll', 'so', 'dylib', 'bin', 'obj', 'o',
            'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp',
            'zip', 'tar', 'gz', '7z', 'rar',
            'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
            'mp3', 'mp4', 'wav', 'avi', 'mov', 'mkv',
            'db', 'sqlite', 'class', 'jar', 'pyc'
        ]);

        return entries.filter(entry => {
            if (entry.is_directory) return true;
            const ext = entry.name.split('.').pop().toLowerCase();
            return !BINARY_EXTENSIONS.has(ext);
        }).map(entry => ({
            entry: entry.name,
            type: entry.is_directory ? 'DIRECTORY' : 'FILE',
            path: entry.path
        }));
    } catch (e) {
        console.error('FS: readDirectory error', path, e);
        throw e;
    }
}

/**
 * A file's text, read through the backend.
 *
 * Same reason as getFileStats: `@tauri-apps/plugin-fs`'s `readFile` obeys the
 * plugin's `fs:scope` and is refused for a workspace outside `$HOME`, while the
 * backend's own `read_file` takes the path it is given. Returns null when the
 * file cannot be read at all.
 */
export async function readFileText(path) {
    try {
        const bytes = await invoke('read_file', { path });
        return new TextDecoder().decode(new Uint8Array(bytes));
    } catch (e) {
        console.warn('FS: readFileText failed', path, e);
        return null;
    }
}

export function normalizeToLF(content) {
    return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/*
export async function readFile(path) {
    // Unused primitive, kept commented for reference or future use if needed.
    try {
        const bytes = await invoke('read_file', { path });
        const uint8Array = new Uint8Array(bytes);
        const decoder = new TextDecoder('utf-8', { fatal: false });
        return decoder.decode(uint8Array);
    } catch (e) {
        throw e;
    }
}
*/

export async function readFileAutoDetect(path, forceEncoding = null) {
    try {
        if (forceEncoding) {
            // Future: Implement forced encoding reading if needed via Rust
            // For now, if forced is UTF-8, we can use standard readFile?
            // Or we need a backend command that accepts encoding.
            // Let's assume for now we just want auto-detect. 
            // If the user explicitly re-opens with encoding, we might need a new command `read_file_with_encoding`.
            // But let's start with auto-detect.
        }

        const result = await invoke('read_file_auto_detect', { path });
        return {
            content: result.content,
            encoding: result.encoding,
            // Detect EOL
            eol: (() => {
                if (result.content.indexOf('\r\n') !== -1) return '\r\n';
                if (result.content.indexOf('\n') !== -1) return '\n';
                if (result.content.indexOf('\r') !== -1) return '\r';
                return getOsLineEnding();
            })()
        };
    } catch (e) {
        throw e;
    }
}

export async function readFileWithEncoding(path, encoding) {
    try {
        const result = await invoke('read_file_with_encoding', { path, encoding });
        return {
            content: result.content,
            encoding: result.encoding,
            // Detect the file's ACTUAL EOL (matching readFileAutoDetect). Returning
            // the OS default here caused an LF file reopened with a forced encoding
            // to be saved as CRLF and then doubled into blank rows.
            eol: (() => {
                if (result.content.indexOf('\r\n') !== -1) return '\r\n';
                if (result.content.indexOf('\n') !== -1) return '\n';
                if (result.content.indexOf('\r') !== -1) return '\r';
                return getOsLineEnding();
            })()
        };
    } catch (e) {
        throw e;
    }
}

export async function writeFile(path, content, encoding = null) {
    try {
        await invoke('write_file', { path, content, encoding });
    } catch (e) {
        console.error('FS: writeFile error', path, e);
        throw e;
    }
}

/** Write raw bytes (pasted images…). Parent dirs are created by the backend. */
export async function writeFileBytes(path, bytes) {
    try {
        await invoke('write_file_bytes', { path, bytes: Array.from(bytes) });
    } catch (e) {
        console.error('FS: writeFileBytes error', path, e);
        throw e;
    }
}

export async function createDirectory(path) {
    try {
        await invoke('create_dir', { path });
    } catch (e) {
        console.error('FS: createDirectory error', path, e);
        throw e;
    }
}

export async function removeFile(path) {
    try {
        await invoke('remove_file', { path });
    } catch (e) {
        console.error('FS: removeFile error', path, e);
        throw e;
    }
}

export async function searchFiles(dir, term, searchContent = false, searchId = 0) {
    try {
        const entries = await invoke('search_files', { dir, term, searchContent, searchId });
        return entries.map(entry => {
            // Normalize path to use forward slashes for consistency with frontend
            let path = entry.path.replace(/\\/g, '/');

            // Remove leading ./ if present (common when scanning current dir)
            if (path.startsWith('./')) {
                path = path.substring(2);
            }

            const name = entry.name;

            // Calculate parent dir based on normalized path
            const lastSep = path.lastIndexOf('/');
            let parentDir = '';
            if (lastSep !== -1) {
                parentDir = path.substring(0, lastSep);
            } else if (path !== '.' && path !== name) {
                // Attempt to infer parent if implicit?
                // If path is "foo" and name is "foo", parent is "" (root relative)
            }

            return {
                entry: name,
                type: entry.is_directory ? 'DIRECTORY' : 'FILE',
                path: path,
                dir: parentDir
            };
        });
    } catch (e) {
        console.error('FS: searchFiles error', dir, e);
        throw e;
    }
}

export async function listAllFiles(dir) {
    try {
        const entries = await invoke('list_all_files', { dir });
        return entries.map(entry => {
            let path = entry.path.replace(/\\/g, '/');
            if (path.startsWith('./')) {
                path = path.substring(2);
            }
            const name = entry.name;
            const lastSep = path.lastIndexOf('/');
            let parentDir = '';
            if (lastSep !== -1) {
                parentDir = path.substring(0, lastSep);
            }
            return {
                entry: name,
                type: 'FILE',
                path: path,
                dir: parentDir
            };
        });
    } catch (e) {
        console.error('FS: listAllFiles error', dir, e);
        throw e;
    }
}

export async function rename(oldPath, newPath) {
    try {
        await invoke('rename_file', { oldPath, newPath });
    } catch (e) {
        console.error('FS: rename error', oldPath, e);
        throw e;
    }
}

export async function copyFile(source, dest) {
    try {
        await invoke('copy_file_cmd', { source, dest });
    } catch (e) {
        console.error('FS: copyFile error', source, e);
        throw e;
    }
}

export function joinPath(dir, entry) {
    let safeDir = dir.replace(/\\/g, '/');
    if (safeDir.endsWith('/')) safeDir = safeDir.slice(0, -1);
    return safeDir === '.' ? entry : `${safeDir}/${entry}`;
}

export function getParentDir(path) {
    const normalized = path.replace(/\\/g, '/');
    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash === -1) return '.';
    return normalized.substring(0, lastSlash);
}

export function getBasename(path) {
    const normalized = path.replace(/\\/g, '/');
    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash === -1) return path;
    return normalized.substring(lastSlash + 1);
}

export async function exists(path) {
    return await invoke('exists', { path });
}

export async function pasteFiles() {
    return await invoke('paste_files');
}
