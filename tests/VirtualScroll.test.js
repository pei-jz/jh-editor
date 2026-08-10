import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VirtualScroll } from '../src/modules/utils/VirtualScroll.js';

describe('VirtualScroll', () => {
    let container;

    beforeEach(() => {
        // Mock ResizeObserver
        global.ResizeObserver = class ResizeObserver {
            constructor(callback) {
                this.callback = callback;
            }
            observe(element) {
                this.element = element;
            }
            unobserve() {}
            disconnect() {}
        };

        // Create container element
        container = document.createElement('div');
        container.style.height = '100px';
        container.style.overflowY = 'auto';
        
        // Define mock properties
        Object.defineProperty(container, 'clientHeight', {
            get: () => 100,
            configurable: true
        });
        Object.defineProperty(container, 'scrollTop', {
            get: function() { return this._scrollTop || 0; },
            set: function(val) { this._scrollTop = val; },
            configurable: true
        });
    });

    it('should initialize and trigger first render', () => {
        const renderCallback = vi.fn();
        const scroller = new VirtualScroll(container, 100, 20, renderCallback);

        expect(renderCallback).toHaveBeenCalled();
        const callArgs = renderCallback.mock.calls[0][0];
        
        expect(callArgs.startIndex).toBe(0);
        expect(callArgs.endIndex).toBe(10); // clientHeight / itemHeight = 100 / 20 = 5 visible. Plus buffer of 5 is 10.
        expect(callArgs.offsetY).toBe(0);
        expect(callArgs.totalHeight).toBe(2000); // 100 * 20

        scroller.destroy();
    });

    it('should handle updates to item count', () => {
        const renderCallback = vi.fn();
        const scroller = new VirtualScroll(container, 50, 20, renderCallback);
        
        renderCallback.mockClear();
        scroller.update(80);

        expect(renderCallback).toHaveBeenCalled();
        expect(renderCallback.mock.calls[0][0].totalHeight).toBe(1600); // 80 * 20

        scroller.destroy();
    });

    it('should compute indices and offsets when scrolled', () => {
        const renderCallback = vi.fn();
        const scroller = new VirtualScroll(container, 100, 20, renderCallback);

        // Scroll down
        container.scrollTop = 100;
        
        renderCallback.mockClear();
        scroller.onScroll();

        expect(renderCallback).toHaveBeenCalled();
        const callArgs = renderCallback.mock.calls[0][0];

        // scrollTop 100 / 20 = startIndex 5. Buffer is 5. Max(0, 5 - 5) = 0.
        // visible height is 100. itemCount is 100.
        // indices should adapt correctly.
        expect(callArgs.startIndex).toBe(0); // 5 - 5 buffer
        expect(callArgs.offsetY).toBe(0);

        // Try a larger scroll
        container.scrollTop = 200;
        renderCallback.mockClear();
        scroller.onScroll();
        const callArgs2 = renderCallback.mock.calls[0][0];
        
        // 200 / 20 = 10. 10 - 5 buffer = 5 start index.
        expect(callArgs2.startIndex).toBe(5);
        expect(callArgs2.offsetY).toBe(100); // 5 * 20 = 100

        scroller.destroy();
    });

    it('should support dynamic item heights', () => {
        const heights = [10, 20, 30, 40, 50];
        const heightProvider = (idx) => heights[idx % heights.length];
        
        const renderCallback = vi.fn();
        const scroller = new VirtualScroll(container, 5, heightProvider, renderCallback);

        const callArgs = renderCallback.mock.calls[0][0];
        expect(callArgs.totalHeight).toBe(150); // 10 + 20 + 30 + 40 + 50
        
        scroller.destroy();
    });
});
