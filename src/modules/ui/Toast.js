/**
 * Toast.js — Global Notification System
 * Replaces intrusive alert() calls with a smooth, non-blocking UI.
 */

import { icon as svgIcon } from './Icons.js';
class ToastManager {
    constructor() {
        this.container = null;
        this.ensureContainer();
    }

    ensureContainer() {
        if (!this.container) {
            this.container = document.createElement('div');
            this.container.id = 'toast-container';
            this.container.style.position = 'fixed';
            this.container.style.bottom = '30px';
            this.container.style.right = '30px';
            this.container.style.zIndex = '9999';
            this.container.style.display = 'flex';
            this.container.style.flexDirection = 'column';
            this.container.style.gap = '10px';
            this.container.style.pointerEvents = 'none'; // Click through the container
            document.body.appendChild(this.container);
        }
    }

    /**
     * How long a message stays up.
     *
     * Three seconds is fine for "Saved" and far too short for a sentence with a
     * number in it that the user is meant to read and act on, so the floor is
     * raised and long messages get proportionally longer. Capped so nothing
     * camps on screen.
     */
    static durationFor(message) {
        const chars = String(message || '').length;
        return Math.min(12000, Math.max(5000, 2500 + chars * 90));
    }

    /**
     * Show a toast notification
     * @param {string} message The message to display
     * @param {string} type 'success', 'error', 'info', 'warning'
     * @param {number} [duration] Milliseconds; defaults to a length-based time.
     */
    show(message, type = 'info', duration = null) {
        this.ensureContainer();
        const ms = Number.isFinite(duration) && duration > 0
            ? duration : ToastManager.durationFor(message);

        const toast = document.createElement('div');
        // This asked for `--bg-secondary`, which no theme defines (they define
        // --bg-color-secondary), so it always fell through to the hard-coded
        // dark #1e1e1e while the text followed the theme — dark on dark in
        // every light theme. Naming the token the themes actually set is the
        // fix; an alias would only move the problem.
        toast.style.background = 'var(--bg-color-secondary, #1e1e1e)';
        toast.style.color = 'var(--text-color, #ffffff)';
        toast.style.border = '1px solid var(--border-color, rgba(0,0,0,0.15))';
        toast.style.padding = '12px 20px';
        toast.style.borderRadius = '6px';
        toast.style.boxShadow = 'var(--overlay-shadow, 0 10px 24px rgba(0,0,0,0.35))';
        toast.style.fontSize = '13px';
        toast.style.fontWeight = '500';
        toast.style.maxWidth = 'min(520px, 60vw)';
        toast.style.pointerEvents = 'auto';
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(20px)';
        toast.style.transition = 'all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)';
        toast.style.display = 'flex';
        toast.style.alignItems = 'center';
        toast.style.gap = '8px';

        // Styling based on type
        let borderLeftColor = 'var(--primary-color, #0d6efd)';
        let iconName = 'info';

        if (type === 'success') {
            borderLeftColor = 'var(--success-color, #28a745)';
            iconName = 'check-circle';
        } else if (type === 'error') {
            borderLeftColor = 'var(--danger-color, #dc3545)';
            iconName = 'x-circle';
        } else if (type === 'warning') {
            borderLeftColor = 'var(--warning-color, #ffc107)';
            iconName = 'warning';
        }

        toast.style.borderLeft = `4px solid ${borderLeftColor}`;
        // The icon now takes the toast's own text colour, so it stays legible on
        // every theme instead of being whatever the OS emoji font painted.
        toast.innerHTML = `<span style="display:inline-flex;color:${borderLeftColor};">${svgIcon(iconName, { size: 15 })}</span><span style="white-space: pre-wrap;">${message}</span>`;

        this.container.appendChild(toast);

        // Animate in
        requestAnimationFrame(() => {
            toast.style.opacity = '1';
            toast.style.transform = 'translateY(0)';
        });

        // Remove after duration
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(10px)';
            setTimeout(() => {
                if (this.container.contains(toast)) {
                    this.container.removeChild(toast);
                }
            }, 300); // Wait for transition
        }, ms);
    }

    success(message, duration) {
        this.show(message, 'success', duration);
    }

    error(message, duration) {
        // An error is the one people most often look away from and back to.
        this.show(message, 'error', duration || ToastManager.durationFor(message) + 3000);
    }

    info(message, duration) {
        this.show(message, 'info', duration);
    }

    warning(message, duration) {
        this.show(message, 'warning', duration);
    }
}

export const Toast = new ToastManager();
