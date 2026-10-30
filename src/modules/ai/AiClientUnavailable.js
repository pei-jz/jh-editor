/**
 * AiClientUnavailable.js — stand-in for `@jh/ai-client` in a build made
 * without it.
 *
 * The real client comes from the sibling jh-ai-agent checkout. When that is
 * not there, vite.config.js / vitest.config.js point the import here instead
 * (scripts/ai-client-alias.js), so jh-editor builds and runs on its own.
 *
 * `unavailable` is how the rest of the editor tells the two apart
 * (AgentConnection.aiClientBundled). Every AI entry point checks that before
 * it gets this far; the methods below only make a path that forgot fail with
 * a sentence rather than "x is not a function".
 */

const reason = 'This build of J.H Editor does not include the J.H AI Agent client (@jh/ai-client).';

export default class JhAiClientUnavailable {
    static unavailable = true;

    constructor() {
        this.token = '';
    }

    ready() { return Promise.reject(new Error(reason)); }

    invoke() { return Promise.reject(new Error(reason)); }

    compose() { return Promise.reject(new Error(reason)); }

    invokeAgent() {
        const completed = Promise.reject(new Error(reason));
        completed.catch(() => {}); // the caller's await sees it; nothing else should
        return { completed, abort() {} };
    }
}
