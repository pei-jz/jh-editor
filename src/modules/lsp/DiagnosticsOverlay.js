/**
 * DiagnosticsOverlay.js — Renders LSP diagnostic information in the editor.
 * Displays error/warning underlines, gutter icons, and hover tooltips.
 */

import { lspClient } from './LspClient.js';

export class DiagnosticsOverlay {
    constructor(view) {
        this.view = view; // PlainTextView reference
        this.currentDiagnostics = [];
        this.overlayElement = null;
        this.gutterMarkers = [];
        this.tooltipElement = null;
    }

    /**
     * Attach the overlay to an editor view.
     * @param {HTMLElement} container - The .plain-text-container element
     */
    attach(container) {
        // Create overlay layer
        this.overlayElement = document.createElement('div');
        this.overlayElement.className = 'diagnostics-overlay';
        container.appendChild(this.overlayElement);

        // Create tooltip element (hidden by default)
        this.tooltipElement = document.createElement('div');
        this.tooltipElement.className = 'diagnostics-tooltip';
        this.tooltipElement.style.display = 'none';
        container.appendChild(this.tooltipElement);
    }

    /**
     * Update diagnostics display for the current file.
     * @param {Array} diagnostics - Array of { line, character, end_line, end_character, severity, message, source }
     */
    update(diagnostics) {
        this.currentDiagnostics = diagnostics || [];
        this.render();
    }

    /**
     * Render diagnostic markers (underlines + gutter icons).
     */
    render() {
        if (!this.overlayElement) return;
        this.overlayElement.innerHTML = '';
        this.gutterMarkers = [];

        if (!this.currentDiagnostics.length) return;

        const lineHeight = this.view?.lineHeight || 22;
        const charWidth = this._getCharWidth();
        const gutterWidth = this._getGutterWidth();

        // Group diagnostics by line for gutter icons
        const byLine = new Map();

        for (const diag of this.currentDiagnostics) {
            const line = diag.line; // 0-based from LSP
            if (!byLine.has(line)) byLine.set(line, []);
            byLine.get(line).push(diag);

            // Create underline element
            const underline = document.createElement('div');
            underline.className = `diag-underline diag-severity-${diag.severity}`;
            
            const startChar = diag.character || 0;
            const endChar = diag.end_character || startChar + 1;
            const width = Math.max(1, endChar - startChar) * charWidth;

            underline.style.top = `${line * lineHeight + lineHeight - 3}px`;
            underline.style.left = `${gutterWidth + startChar * charWidth}px`;
            underline.style.width = `${width}px`;
            underline.dataset.line = line;
            underline.dataset.message = diag.message;
            underline.dataset.severity = diag.severity;
            underline.dataset.source = diag.source || '';

            // Hover tooltip
            underline.addEventListener('mouseenter', (e) => this._showTooltip(e, diag));
            underline.addEventListener('mouseleave', () => this._hideTooltip());

            this.overlayElement.appendChild(underline);
        }

        // Render gutter icons
        for (const [line, diags] of byLine) {
            // Use the highest severity (lowest number = highest severity)
            const worstSeverity = Math.min(...diags.map(d => d.severity));
            const gutterIcon = document.createElement('div');
            gutterIcon.className = `diag-gutter-icon diag-gutter-severity-${worstSeverity}`;
            gutterIcon.style.top = `${line * lineHeight}px`;
            gutterIcon.style.height = `${lineHeight}px`;
            gutterIcon.textContent = worstSeverity === 1 ? '●' : worstSeverity === 2 ? '▲' : 'ℹ';
            gutterIcon.title = diags.map(d => `[${this._severityLabel(d.severity)}] ${d.message}`).join('\n');

            // Click gutter icon to cycle through diagnostics
            gutterIcon.addEventListener('click', () => {
                const allMessages = diags.map(d => `[${d.source || 'lsp'}] ${d.message}`).join('\n');
                this._showTooltipAt(gutterIcon.getBoundingClientRect(), { 
                    message: allMessages, 
                    severity: worstSeverity, 
                    source: diags[0]?.source || '' 
                });
            });

            this.overlayElement.appendChild(gutterIcon);
            this.gutterMarkers.push(gutterIcon);
        }
    }

    /**
     * Show diagnostic tooltip near mouse position.
     */
    _showTooltip(event, diag) {
        if (!this.tooltipElement) return;
        
        const rect = event.target.getBoundingClientRect();
        this._showTooltipAt(rect, diag);
    }

    _showTooltipAt(rect, diag) {
        if (!this.tooltipElement) return;

        const severityClass = `diag-tooltip-severity-${diag.severity}`;
        const label = this._severityLabel(diag.severity);
        
        this.tooltipElement.innerHTML = `
            <div class="diag-tooltip-header ${severityClass}">
                <span class="diag-tooltip-severity">${label}</span>
                ${diag.source ? `<span class="diag-tooltip-source">${diag.source}</span>` : ''}
            </div>
            <div class="diag-tooltip-message">${this._escapeHtml(diag.message)}</div>
        `;

        // Position tooltip
        const container = this.overlayElement?.parentElement;
        if (container) {
            const containerRect = container.getBoundingClientRect();
            let top = rect.top - containerRect.top - this.tooltipElement.offsetHeight - 4;
            let left = rect.left - containerRect.left;

            // If tooltip would go above the container, show below
            if (top < 0) top = rect.bottom - containerRect.top + 4;
            
            this.tooltipElement.style.top = `${top}px`;
            this.tooltipElement.style.left = `${Math.max(0, left)}px`;
        }
        
        this.tooltipElement.style.display = 'block';
    }

    _hideTooltip() {
        if (this.tooltipElement) {
            this.tooltipElement.style.display = 'none';
        }
    }

    _severityLabel(severity) {
        switch (severity) {
            case 1: return 'Error';
            case 2: return 'Warning';
            case 3: return 'Info';
            case 4: return 'Hint';
            default: return 'Unknown';
        }
    }

    _escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    _getCharWidth() {
        if (this.view?._cachedCharWidth) return this.view._cachedCharWidth;
        // Estimate from font
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const fontSize = getComputedStyle(document.documentElement).getPropertyValue('--font-size')?.trim() || '14px';
        const fontFamily = getComputedStyle(document.documentElement).getPropertyValue('--font-family')?.trim() || 'monospace';
        ctx.font = `${fontSize} ${fontFamily}`;
        return ctx.measureText('M').width;
    }

    _getGutterWidth() {
        const gutter = this.view?.layers?.gutter;
        return gutter ? gutter.offsetWidth : 50;
    }

    /**
     * Clean up overlay elements.
     */
    destroy() {
        if (this.overlayElement) {
            this.overlayElement.remove();
            this.overlayElement = null;
        }
        if (this.tooltipElement) {
            this.tooltipElement.remove();
            this.tooltipElement = null;
        }
        this.currentDiagnostics = [];
        this.gutterMarkers = [];
    }
}
