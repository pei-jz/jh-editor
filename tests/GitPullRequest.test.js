import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => '') }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn(async () => {}) }));

import { parseRemoteUrl, pullRequestUrl } from '../src/modules/ui/GitPanel.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '..', rel), 'utf8').replace(/\r\n/g, '\n');

describe('parseRemoteUrl', () => {
    it('reads the four shapes a remote actually comes in', () => {
        const gh = { host: 'github.com', owner: 'acme', repo: 'widget' };
        expect(parseRemoteUrl('git@github.com:acme/widget.git')).toEqual(gh);
        expect(parseRemoteUrl('ssh://git@github.com/acme/widget.git')).toEqual(gh);
        expect(parseRemoteUrl('https://github.com/acme/widget.git')).toEqual(gh);
        expect(parseRemoteUrl('https://someone@github.com/acme/widget')).toEqual(gh);
    });

    // GitLab nests groups, so everything before the last segment is the owner.
    it('keeps nested groups together', () => {
        expect(parseRemoteUrl('https://gitlab.com/team/sub/widget.git'))
            .toEqual({ host: 'gitlab.com', owner: 'team/sub', repo: 'widget' });
    });

    it('drops a port from a self-hosted URL', () => {
        expect(parseRemoteUrl('https://git.internal:8443/acme/widget.git').host)
            .toBe('git.internal');
    });

    it('returns null rather than a half-parsed guess', () => {
        for (const bad of ['', null, 'not a url', 'https://github.com/acme']) {
            expect(parseRemoteUrl(bad), String(bad)).toBeNull();
        }
    });
});

describe('pullRequestUrl', () => {
    const gh = { host: 'github.com', owner: 'acme', repo: 'widget' };

    it('builds a GitHub compare URL with the text prefilled', () => {
        const url = pullRequestUrl(gh, 'main', 'fix/bug', { title: 'Fix & ship', body: 'why' });
        expect(url).toContain('https://github.com/acme/widget/compare/main...fix/bug');
        expect(url).toContain('expand=1');
        // An ampersand in the title must not start a new query parameter.
        expect(url).toContain('title=Fix%20%26%20ship');
        expect(url).toContain('body=why');
    });

    // A branch name may contain slashes, which are path separators here and are
    // meant to stay that way.
    it('leaves the slashes in a branch name alone', () => {
        expect(pullRequestUrl(gh, 'release/2.0', 'feat/a/b')).toContain('/release/2.0...feat/a/b');
    });

    it('addresses GitLab and Bitbucket in their own shapes', () => {
        const gl = pullRequestUrl({ host: 'gitlab.com', owner: 'team', repo: 'w' },
            'main', 'topic', { title: 'T' });
        expect(gl).toContain('/-/merge_requests/new?');
        expect(gl).toContain('merge_request%5Bsource_branch%5D=topic');
        expect(gl).toContain('merge_request%5Btarget_branch%5D=main');

        const bb = pullRequestUrl({ host: 'bitbucket.org', owner: 'team', repo: 'w' },
            'main', 'topic');
        expect(bb).toContain('/pull-requests/new?source=topic&dest=main');
    });

    // Better to say "do it on the web" than to invent a URL for an unknown host.
    it('gives up on a host it does not know', () => {
        expect(pullRequestUrl({ host: 'git.example.com', owner: 'a', repo: 'b' }, 'main', 'x'))
            .toBeNull();
        expect(pullRequestUrl(null, 'main', 'x')).toBeNull();
        expect(pullRequestUrl(gh, 'main', '')).toBeNull();
    });
});

/* `git push` on a branch that has never been pushed fails with "no upstream
   branch" — which is precisely the branch you most want to push. */
describe('pushing a new branch', () => {
    const panel = read('src/modules/ui/GitPanel.js');
    const rs = read('src-tauri/src/commands/git.rs');

    it('lets the backend publish a branch, and still allows a plain push', () => {
        expect(rs).toContain('set_upstream: Option<bool>');
        expect(rs).toContain('args.push("--set-upstream".into())');
        // Omitting all three optional arguments must stay a bare `git push`.
        expect(rs).toContain('let mut args: Vec<String> = vec!["push".into()];');
    });

    // git reports the push on stderr; returning stdout alone showed nothing.
    it('keeps the push summary git writes to stderr', () => {
        const i = rs.indexOf('pub async fn git_push(');
        const fn = rs.slice(i, rs.indexOf('\n}', i));
        expect(fn).toContain('out.push_str(&err)');
    });

    // Creating a remote branch is visible to everyone, so it is not silent.
    it('asks before publishing a branch for the first time', () => {
        const i = panel.indexOf('async push() {');
        const fn = panel.slice(i, panel.indexOf('\n    }', i));
        expect(fn).toContain("invoke('git_upstream'");
        expect(fn).toContain('showConfirm(');
        expect(fn).toContain('setUpstream: true');
    });

    // The branch picker replaced a <select>, so `.value` stopped answering.
    it('tracks the checked-out branch rather than reading a dead .value', () => {
        expect(panel).toContain('this._activeBranch = activeBranch');
        expect(panel).not.toContain("querySelector('#git-branch-select')?.value");
    });
});

describe('the pull request route', () => {
    const panel = read('src/modules/ui/GitPanel.js');
    const rs = read('src-tauri/src/commands/git.rs');

    // gh on PATH but signed out fails at creation with a prompt no one can
    // answer, so availability means BOTH installed and authenticated.
    it('treats gh as available only when it is also signed in', () => {
        const i = rs.indexOf('pub async fn gh_available(');
        const fn = rs.slice(i, rs.indexOf('\n}', i));
        expect(fn).toContain('"auth", "status"');
        expect(fn).toContain('Err(_) => Ok(false)');
    });

    // A PR title is user text; interpolating it into a command line is how a
    // quote or an ampersand becomes a bug, or worse.
    it('passes the title and body as arguments, not shell text', () => {
        const i = rs.indexOf('pub async fn gh_pr_create(');
        const fn = rs.slice(i, rs.indexOf('\n}', i));
        expect(fn).toContain('cmd.args(["pr", "create"');
        expect(fn).not.toMatch(/format!\("gh pr create/);
    });

    it('falls back to the forge\'s own page when gh is missing', () => {
        const i = panel.indexOf('async createPullRequest() {');
        const fn = panel.slice(i, panel.indexOf('\n    _openExternal', i));
        expect(fn).toContain("invoke('gh_available'");
        expect(fn).toContain('pullRequestUrl(repo,');
        expect(fn).toContain('this._openExternal(url)');
    });

    // There is nothing to review until the branch exists on the remote.
    it('pushes the branch first when it has no upstream', () => {
        const i = panel.indexOf('async createPullRequest() {');
        const fn = panel.slice(i, panel.indexOf('\n    _openExternal', i));
        expect(fn).toContain("invoke('git_upstream'");
        expect(fn).toContain('setUpstream: true');
    });

    it('registers the new commands with Tauri', () => {
        const lib = read('src-tauri/src/lib.rs');
        for (const cmd of ['git_upstream', 'git_remote_url', 'git_default_branch',
            'gh_available', 'gh_pr_create']) {
            expect(lib, cmd).toContain(`commands::git::${cmd}`);
        }
    });
});
