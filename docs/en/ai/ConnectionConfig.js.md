# ConnectionConfig.js — Auto-discovery Connection Config

## Purpose
Automatically discovers connection info for J.H AI Agent using a 3-layer resolution strategy.

## File Info
- **Path**: `src/modules/ai/ConnectionConfig.js` (145 lines)
- **Dependencies**: None (uses Tauri commands)

## Exported Functions

| Function | Description |
|----------|-------------|
| `getConnectionConfig()` | Get connection config (cached) |
| `refreshConnectionConfig()` | Force refresh connection config |
| `isAgentReachable()` | Check agent reachability |

## 3-Layer Resolution

1. **Standard JH Path**: Check OS-specific config file path
2. **localStorage**: Check saved user settings
3. **Fallback**: Use default values

## Branch Logic

| Condition | Action |
|-----------|--------|
| Config file at standard path | Use that config |
| No standard path, config in localStorage | Use localStorage config |
| Neither found | Use fallback defaults |
| OS detection | Windows: `%APPDATA%`, macOS: `~/Library/Application Support`, Linux: `~/.config` |