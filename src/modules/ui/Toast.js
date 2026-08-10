/**
 * Toast.js — Global Notification System
 * Replaces intrusive alert() calls with a smooth, non-blocking UI.
 */

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
     * Show a toast notification
     * @param {string} message The message to display
     * @param {string} type 'success', 'error', 'info', 'warning'
     * @param {number} duration Duration in milliseconds
     */
    show(message, type = 'info', duration = 3000) {
        this.ensureContainer();

        const toast = document.createElement('div');
        toast.style.background = 'var(--bg-secondary, #1e1e1e)';
        toast.style.color = 'var(--text-color, #ffffff)';
        toast.style.padding = '12px 20px';
        toast.style.borderRadius = '6px';
        toast.style.boxShadow = '0 8px 16px rgba(0,0,0,0.3)';
        toast.style.fontSize = '13px';
        toast.style.fontWeight = '500';
        toast.style.pointerEvents = 'auto';
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(20px)';
        toast.style.transition = 'all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)';
        toast.style.display = 'flex';
        toast.style.alignItems = 'center';
        toast.style.gap = '8px';

        // Styling based on type
        let borderLeftColor = 'var(--primary-color, #0d6efd)';
        let icon = 'ℹ️';

        if (type === 'success') {
            borderLeftColor = '#28a745';
            icon = '✅';
        } else if (type === 'error') {
            borderLeftColor = '#dc3545';
            icon = '❌';
        } else if (type === 'warning') {
            borderLeftColor = '#ffc107';
            icon = '⚠️';
        }

        toast.style.borderLeft = `4px solid ${borderLeftColor}`;
        toast.innerHTML = `<span>${icon}</span><span style="white-space: pre-wrap;">${message}</span>`;

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
        }, duration);
    }

    success(message, duration) {
        this.show(message, 'success', duration);
    }

    error(message, duration) {
        this.show(message, 'error', duration);
    }

    info(message, duration) {
        this.show(message, 'info', duration);
    }
}

export const Toast = new ToastManager();
