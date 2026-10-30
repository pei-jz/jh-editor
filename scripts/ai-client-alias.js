// Where `@jh/ai-client` resolves from, for vite.config.js and vitest.config.js.
//
// The client lives in the sibling jh-ai-agent repository
// (../jh-ai-agent/packages/jh-ai-client) and is an optional dependency: npm
// leaves a dangling link when that checkout is not there, and the import would
// then fail the build. So without it, the import is pointed at a stand-in that
// reports "not bundled" — the editor builds and runs, and the AI commands say
// why they are unavailable instead of the build failing.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** True when the real client is installed under `root`. */
export function hasAiClient(root) {
    // existsSync follows the link, so a dangling one counts as missing.
    return existsSync(join(root, 'node_modules', '@jh', 'ai-client', 'index.js'));
}

/** `resolve.alias` entries: empty with the real client, the stand-in without. */
export function aiClientAlias(root) {
    if (hasAiClient(root)) return {};
    return { '@jh/ai-client': join(root, 'src', 'modules', 'ai', 'AiClientUnavailable.js') };
}
