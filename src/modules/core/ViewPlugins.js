/**
 * ViewPlugins.js
 * Registers all built-in view plugins for the JHEditor.
 */
import { pluginManager } from './PluginManager.js';
import { CodeMirrorView } from '../views/CodeMirrorView.js';
import { MarkdownView } from '../views/MarkdownView.js';
import { StructureView } from '../views/StructureView.js';
import { CsvView } from '../views/CsvView.js';

export function initDefaultPlugins(context) {
    // 1. Markdown
    pluginManager.register({
        id: 'markdown',
        viewClass: MarkdownView,
        extensions: ['md', 'markdown'],
        modes: ['structure'],
        priority: 10
    });

    // 2. CSV
    pluginManager.register({
        id: 'csv',
        viewClass: CsvView,
        extensions: ['csv'],
        modes: ['structure'],
        priority: 10
    });

    // 3. Structure (XML, JSON, HTML)
    pluginManager.register({
        id: 'structure',
        viewClass: StructureView,
        extensions: ['xml', 'json', 'html', 'xsd', 'wsdl', 'htm', 'jsp'],
        modes: ['structure'],
        priority: 10,
        // Helper to determine structure type
        getStructureType: (file) => {
            const path = (file.path || file.name || '').toLowerCase();
            if (path.endsWith('.xml') || path.endsWith('.xsd') || path.endsWith('.wsdl')) return 'xml';
            if (path.endsWith('.html') || path.endsWith('.htm') || path.endsWith('.jsp')) return 'html';
            return 'json';
        }
    });

    // 4. Plain Text (Fallback)
    pluginManager.register({
        id: 'plain',
        viewClass: CodeMirrorView,
        extensions: ['txt', 'log', 'java', 'js', 'javascript', 'ts', 'typescript', 'sql', 'css', 'json', 'xml', 'html', 'jsp', 'md', 'markdown', ''],
        modes: ['text'],
        priority: 1
    });
}
