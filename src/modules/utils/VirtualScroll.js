
export class VirtualScroll {
    constructor(container, itemCount, itemHeightProvider, renderCallback) {
        this.container = container;
        this.itemCount = itemCount;
        // itemHeightProvider can be a number (fixed) or function(index) -> number
        this.itemHeight = itemHeightProvider;
        this.renderCallback = renderCallback;

        this.scrollTop = 0;
        this.visibleItems = 0;

        this.container.addEventListener('scroll', this.onScroll.bind(this));

        // Initial sizing check
        this.resizeObserver = new ResizeObserver(() => this.onResize());
        this.resizeObserver.observe(this.container);

        this.onResize(); // Initial trigger
    }

    getItemHeight(index) {
        if (typeof this.itemHeight === 'function') {
            return this.itemHeight(index);
        }
        return this.itemHeight;
    }

    update(newItemCount) {
        this.itemCount = newItemCount;
        this.onScroll();
    }

    onResize() {
        // Estimate visible items based on average/first item height?
        // Or just trigger scroll which handles rendering
        // We need an estimate for buffer calculation
        const baseHeight = this.getItemHeight(0) || 28;
        const height = this.container.clientHeight;
        this.visibleItems = Math.ceil(height / baseHeight);
        this.onScroll();
    }

    onScroll() {
        this.scrollTop = this.container.scrollTop;

        // Dynamic Calculation of Start/End
        let currentY = 0;
        let startIndex = 0;
        let endIndex = 0;

        // 1. Find Start Index (Scan)
        if (typeof this.itemHeight === 'number') {
            startIndex = Math.floor(this.scrollTop / this.itemHeight);
            currentY = startIndex * this.itemHeight;
        } else {
            for (let i = 0; i < this.itemCount; i++) {
                const h = this.getItemHeight(i);
                if (currentY + h > this.scrollTop) {
                    startIndex = i;
                    break;
                }
                currentY += h;
            }
        }

        // 2. Find End Index
        let visibleH = 0;
        const viewH = this.container.clientHeight;
        // Start from where we found start
        let tempY = currentY;
        for (let i = startIndex; i < this.itemCount; i++) {
            const h = this.getItemHeight(i);
            tempY += h;
            visibleH += h;
            endIndex = i;
            if (visibleH > viewH) break;
        }

        // Buffers
        const buffer = 5;
        startIndex = Math.max(0, startIndex - buffer);
        endIndex = Math.min(this.itemCount - 1, endIndex + buffer);

        // Calculate OffsetY for startIndex
        let offsetY = 0;
        if (typeof this.itemHeight === 'number') {
            offsetY = startIndex * this.itemHeight;
        } else {
            for (let i = 0; i < startIndex; i++) {
                offsetY += this.getItemHeight(i);
            }
        }

        // Calculate Total Height
        let totalHeight = 0;
        if (typeof this.itemHeight === 'number') {
            totalHeight = this.itemCount * this.itemHeight;
        } else {
            for (let i = 0; i < this.itemCount; i++) {
                totalHeight += this.getItemHeight(i);
            }
        }

        // Callback with render info
        this.renderCallback({
            startIndex,
            endIndex,
            offsetY,
            totalHeight
        });
    }

    destroy() {
        this.resizeObserver.disconnect();
    }
}
