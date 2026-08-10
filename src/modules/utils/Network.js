import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

/**
 * A wrapper for fetch that respects global proxy settings.
 * In tauri-plugin-http v2, fetch accepts ClientOptions including proxy.
 */
export async function smartFetch(url, options = {}) {
    const proxyEnabled = localStorage.getItem('settings_proxyEnabled') === 'true';
    const proxyUrl = localStorage.getItem('settings_proxy') || '';

    const fetchOptions = { ...options };

    if (proxyEnabled && proxyUrl) {
        // According to tauri-plugin-http v2 types, we can pass proxy in init options
        fetchOptions.proxy = {
            all: proxyUrl
        };
    }

    try {
        return await tauriFetch(url, fetchOptions);
    } catch (e) {
        console.error('smartFetch failed:', e);
        throw e;
    }
}

// Window global for manual use if needed
window.smartFetch = smartFetch;
