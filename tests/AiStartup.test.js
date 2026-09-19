import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const read = (rel) => readFileSync(join(repo, rel), 'utf8').replace(/\r\n/g, '\n');
const aiFiles = () => readdirSync(join(repo, 'src/modules/ai'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => [`src/modules/ai/${f}`, read(`src/modules/ai/${f}`)]);

/* The editor used to go looking for J.H AI Agent at STARTUP — probe it, then
   pair with it for a token — whether or not the session would ever use AI. It
   does not any more: every AI entry point goes through ensureAgentAvailable()
   at the moment the user asks, and boot touches none of it.

   That is worth holding onto. It decides how long a cold start takes, and it
   decides what happens on a machine where the agent is not installed: nothing,
   rather than a probe that fails and a dialog nobody asked for.

   AgentConnection.js states the rule in its header — "Neither is ever called
   during boot" — and until this file, prose was all that enforced it. One line
   put back in App.js would undo it silently, with every other test still
   green. */

/** Everything that means "reach for the agent". */
const REACHES_FOR_THE_AGENT = [
    'initJhEditorMcp',
    'ensureAgentAvailable',
    'ensureMcpServer',
    'isAgentReachable',
    'checkHealth',
    'is_jh_agent_installed',
    'launch_jh_agent',
    'createJhaiAdapter',
];

describe('boot does not go looking for the AI agent', () => {
    const app = read('src/modules/core/App.js');

    for (const name of REACHES_FOR_THE_AGENT) {
        it(`App.js never calls ${name}`, () => {
            expect(app).not.toContain(name);
        });
    }

    // The chat panel is a module singleton imported by App.js, so anything its
    // constructor did would happen at boot by the back door.
    it('the chat panel singleton is inert until it is opened', () => {
        const panel = read('src/modules/ui/AiChatPanel.js');
        const ctor = panel.slice(panel.indexOf('    constructor() {'), panel.indexOf('\n    }', panel.indexOf('    constructor() {')));
        expect(ctor).toBeTruthy();
        for (const name of REACHES_FOR_THE_AGENT) {
            expect(ctor, name).not.toContain(name);
        }
        // No network of any kind on the way to existing.
        expect(ctor).not.toContain('fetch(');
        expect(ctor).not.toContain('invoke(');
    });
});

/* "Periodically" is the other half of it. A probe that runs every N seconds is
   a startup probe that never stops, and it would keep a machine without the
   agent installed answering the same question for the life of the session. */
describe('nothing hunts for the agent on a timer', () => {
    it('no AI module sets an interval at all', () => {
        const offenders = aiFiles()
            .filter(([, src]) => src.includes('setInterval'))
            .map(([rel]) => rel);
        expect(offenders, offenders.join(', ')).toEqual([]);
    });

    /* The two intervals the app does run are named here so that a third one has
       to be looked at rather than merely added. Neither is about the agent:
       one drags the editor's scroll, one repaints "⏳ Sending… 1.4 s" while a
       request the user started is in flight. */
    it('the intervals the app does run are the two known ones', () => {
        const files = ['src/modules/core/Editor.js', 'src/modules/ui/AiChatPanel.js'];
        let total = 0;
        for (const dir of ['src/modules/core', 'src/modules/ui', 'src/modules/utils',
            'src/modules/views', 'src/modules/editors', 'src/modules/ai', 'src/modules/lsp']) {
            for (const f of readdirSync(join(repo, dir)).filter((x) => x.endsWith('.js'))) {
                const rel = `${dir}/${f}`;
                const hits = (read(rel).match(/setInterval\(/g) || []).length;
                if (hits && !files.includes(rel)) {
                    throw new Error(`unexpected setInterval in ${rel} — is it polling for something?`);
                }
                total += hits;
            }
        }
        expect(total).toBe(2);
    });
});

/* The one loop that does exist, and why it is not the thing above: it runs
   AFTER the user has agreed to start the agent, waiting for the process they
   just asked for to come up. A wait for something you asked for is not a
   search for something you did not. */
describe('the launch wait is bounded', () => {
    const conn = read('src/modules/ai/AgentConnection.js');
    const fn = conn.slice(conn.indexOf('async function waitForReachable'),
        conn.indexOf('export async function ensureAgentAvailable'));

    it('stops at a deadline instead of spinning', () => {
        expect(fn).toContain('const deadline = Date.now() + timeoutMs');
        expect(fn).toMatch(/while \(Date\.now\(\) < deadline\)/);
    });

    it('is only reached once the user has said to start the agent', () => {
        // Called from ensureAgentAvailable's launch branch, nowhere else.
        expect((conn.match(/waitForReachable\(/g) || [])).toHaveLength(2);  // the definition, and one call
    });
});

/* Every way in has to ask first. An entry point that skipped the check would
   surface a raw fetch error — "Could not reach J.H AI Agent" — instead of the
   offer to start it. */
describe('every AI action asks whether the agent is there', () => {
    const agent = read('src/modules/ai/AIAgent.js');
    /* From the method's own line to whatever starts the next member. Not to the
       first `\n    }` — these methods take a destructured options object, so
       that brace closes the PARAMETER LIST and the slice would stop before the
       body it is meant to be about. */
    const body = (name) => {
        const at = agent.indexOf(`    async ${name}(`);
        expect(at, name).toBeGreaterThan(-1);
        const next = ['\n    async ', '\n    /**', '\n}']
            .map((mark) => agent.indexOf(mark, at + 10))
            .filter((i) => i > 0);
        return agent.slice(at, next.length ? Math.min(...next) : agent.length);
    };

    for (const entry of ['runAsk', 'runSingleShot', 'openInAgent']) {
        it(`${entry} goes through ensureAgentAvailable`, () => {
            expect(body(entry)).toContain('ensureAgentAvailable()');
        });
    }

    it('asks before it talks, not after', () => {
        for (const entry of ['runAsk', 'runSingleShot', 'openInAgent']) {
            const b = body(entry);
            const asked = b.indexOf('ensureAgentAvailable()');
            const talked = b.indexOf('this._getClient()');
            if (talked >= 0) expect(asked, entry).toBeLessThan(talked);
        }
    });
});

/* The MCP socket reconnects when it drops, which is the right thing for a
   connection the user's first AI action established — and would be the wrong
   thing if it started on its own. */
describe('the MCP socket only runs once AI has been used', () => {
    const mcp = read('src/modules/ai/JhAiMcp.js');
    const adapter = read('src/modules/ai/jhai-adapter.js');

    it('is started from initJhEditorMcp and nowhere else', () => {
        const starts = aiFiles().filter(([, src]) => /\.start\(\)/.test(src)).map(([rel]) => rel);
        expect(starts).toEqual(['src/modules/ai/JhAiMcp.js']);
        expect(mcp).toContain('createJhaiAdapter(');
    });

    // initJhEditorMcp is reached through ensureMcpServer(), which is an AI
    // action's first move — never boot's.
    it('is reached only through ensureMcpServer', () => {
        const callers = [];
        for (const dir of ['src/modules/core', 'src/modules/ui', 'src/modules/ai']) {
            for (const f of readdirSync(join(repo, dir)).filter((x) => x.endsWith('.js'))) {
                const rel = `${dir}/${f}`;
                if (read(rel).includes('initJhEditorMcp')) callers.push(rel);
            }
        }
        expect(callers.sort()).toEqual([
            'src/modules/ai/AgentConnection.js',   // ensureMcpServer, on first use
            'src/modules/ai/JhAiMcp.js',           // the definition
        ]);
    });

    it('backs off rather than retrying in a tight loop', () => {
        expect(adapter).toMatch(/_reconnectMs = Math\.min\(this\._reconnectMs \* 2, this\._reconnectMaxMs\)/);
        const max = /_reconnectMaxMs = (\d+)/.exec(adapter);
        expect(max).toBeTruthy();
        expect(Number(max[1])).toBeGreaterThanOrEqual(60000);
    });
});
