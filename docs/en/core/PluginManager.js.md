# PluginManager.js — View Plugin Registration and Resolution

## Purpose
`PluginManager.js` manages registration of editor view plugins and resolves the optimal plugin based on file extension and view mode.

## File Info
- **Path**: `src/modules/core/PluginManager.js` (63 lines)
- **Dependencies**: None

## Class: `PluginManager`

### Constructor
```javascript
constructor()
```
- `this.plugins: Array` — Registered plugin array

### Methods

#### `register(config: Object): void`
Registers a new view plugin.

**Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| `config.id` | `string` | Unique identifier |
| `config.viewClass` | `class` | View constructor |
| `config.extensions` | `string[]` | Supported file extensions (lowercase) |
| `config.modes` | `string[]` | Supported view modes (`'text'`, `'structure'`, etc.) |
| `config.priority` | `number` | Resolution priority (higher = more specific) |

**Branch Logic**: After registration, sorts by `priority` descending

#### `resolve(file: Object, targetMode?: string): Object|null`
Finds the best plugin for a file and target mode.

**Returns**: Matching plugin object, or `null`

**Branch Logic**:
1. Extract extension from file path
2. Markdown detection: `.md`, `.markdown`, or empty path (new unsaved file)
3. Loop through plugins by priority:
   - Extension match check
   - Markdown fallback: empty extension matches plugins supporting `md`
   - Mode match check (always matches if `targetMode` not specified)
4. Returns first matching plugin

#### `getPlugins(): Array`
Returns the registered plugin array.

## Export
- `pluginManager` — Singleton instance