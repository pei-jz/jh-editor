# FileSystem.js — File System Operation Wrappers

## Purpose
Wraps Tauri backend file system commands for frontend use.

## File Info
- **Path**: `src/modules/utils/FileSystem.js` (8.3KB)
- **Dependencies**: `@tauri-apps/api/core` (invoke), `@tauri-apps/plugin-dialog`, `@tauri-apps/plugin-fs`

## Key Functions

| Function | Description |
|----------|-------------|
| `readFile(path)` | Read file |
| `writeFile(path, content)` | Write file |
| `readDir(path)` | List directory |
| `exists(path)` | Check path exists |
| `createDir(path)` | Create directory |
| `removeFile(path)` | Remove file/directory |
| `renameFile(old, new)` | Rename |
| `openFolder()` | Folder picker dialog |
| `readFileAutoDetect(path)` | Auto-detect encoding read |
| `readFileWithEncoding(path, enc)` | Encoding-specific read |
| `pasteFiles()` | Clipboard file paste |
| `listRecursive(path)` | Recursive file list |
| `parseExcelToMarkdown(bytes, ext)` | Excel→Markdown conversion |