/**
 * PluginManager.js
 * Manages editor view plugins and their associations with file extensions.
 */
// Exported (not just the singleton) so tests — and any future second registry —
// can work with an isolated instance instead of mutating global state.
export class PluginManager {
    constructor() {
        this.plugins = [];
    }

    /**
     * Register a new view plugin
     * @param {Object} config
     * @param {string} config.id - Unique identifier
     * @param {class} config.viewClass - Constructor for the view
     * @param {string[]} config.extensions - Supported file extensions (lower case)
     * @param {string[]} config.modes - Supported viewModes ('text', 'structure', etc.)
     * @param {number} config.priority - Resolver priority (higher = more specific)
     */
    register(config) {
        this.plugins.push({
            priority: 0,
            ...config
        });
        // Sort by priority descending
        this.plugins.sort((a, b) => b.priority - a.priority);
    }

    /**
     * Find the best plugin for a file and target mode
     * @param {Object} file - File object (must have path or name)
     * @param {string} [targetMode] - Optional mode override
     * @returns {Object|null}
     */
    resolve(file, targetMode) {
        const path = (file.path || file.name || '').toLowerCase();
        const ext = path.split('.').pop();
        
        // Handle markdown-specific fallback (default new file is md)
        const isMarkdown = path.endsWith('.md') || path.endsWith('.markdown') || (path === '' && !file.path);

        for (const p of this.plugins) {
            let extMatch = p.extensions.includes(ext);
            if (!extMatch && isMarkdown && p.extensions.includes('md')) extMatch = true;

            const modeMatch = !targetMode || p.modes.includes(targetMode);

            if (extMatch && modeMatch) {
                return p;
            }
        }
        return null;
    }

    /**
     * Get all registered plugins
     */
    getPlugins() {
        return this.plugins;
    }
}

export const pluginManager = new PluginManager();
