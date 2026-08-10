/**
 * BaseView.js
 * Abstract base class for all editor view modes
 */
export class BaseView {
    constructor(container) {
        this.container = container;
    }

    /**
     * Render the view
     * @param {string} content 
     * @param {object} file 
     */
    render(content, file) {
        throw new Error("render() must be implemented");
    }

    /**
     * Clean up when switching views
     */
    destroy() {
        // Optional cleanup logic
    }

    /**
     * Focus the main input element
     */
    focus() {
        // Optional focus logic
    }

    /**
     * Get diagnostic errors/warnings for this view
     * @returns {Array}
     */
    getDiagnostics() {
        return [];
    }
}
