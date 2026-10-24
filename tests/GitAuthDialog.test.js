import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => true) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }));

const { formFor, ask, hostName } = await import('../src/modules/ui/GitAuthDialog.js');
const { gitErrorText } = await import('../src/modules/ui/GitPanel.js');

const q = (extra) => ({ id: 7, window: 'main', prompt: '', host: '', user: '', key: '', ...extra });
const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => { document.body.innerHTML = ''; });

describe('the form for each question', () => {
    it('asks for the user name and the password at once', () => {
        const f = formFor(q({ kind: 'username', host: 'https://git.example.com' }));
        expect(f.title).toContain('git.example.com');
        const [user, pass] = f.form.querySelectorAll('input:not([type=checkbox])');
        expect(pass.type).toBe('password');
        expect(f.first()).toBe(user);
        user.value = 'me';
        pass.value = 'secret';
        expect(f.read()).toEqual({ answer: 'me', password: 'secret', remember: false });
    });

    it('shows a user name it already has without letting it change', () => {
        const f = formFor(q({ kind: 'password', host: 'https://h', user: 'pei' }));
        const [user, pass] = f.form.querySelectorAll('input:not([type=checkbox])');
        expect(user.value).toBe('pei');
        expect(user.readOnly).toBe(true);
        expect(f.first()).toBe(pass);
        pass.value = 'pw';
        f.form.querySelector('input[type=checkbox]').checked = true;
        expect(f.read()).toEqual({ answer: 'pw', password: null, remember: true });
    });

    it('asks for a key\'s passphrase', () => {
        const f = formFor(q({ kind: 'passphrase', key: '/c/Users/x/.ssh/id_ed25519' }));
        expect(f.message).toBe('/c/Users/x/.ssh/id_ed25519');
        f.form.querySelector('input[type=password]').value = 'phrase';
        expect(f.read().answer).toBe('phrase');
    });

    it('answers ssh\'s host check with yes, and remembers nothing', () => {
        const prompt = 'The authenticity of host … SHA256:abc … (yes/no/[fingerprint])?';
        const f = formFor(q({ kind: 'confirm', prompt }));
        expect(f.form.textContent).toContain('SHA256:abc');
        expect(f.form.querySelector('input[type=checkbox]')).toBeNull();
        expect(f.read()).toEqual({ answer: 'yes', password: null, remember: false });
    });

    it('passes any other question through with one field', () => {
        const f = formFor(q({ kind: 'text', prompt: 'Something? ' }));
        expect(f.message).toBe('Something? ');
        f.form.querySelector('input').value = 'x';
        expect(f.read().answer).toBe('x');
    });

    it('names the host from a URL', () => {
        expect(hostName('https://git.example.com:8443/team/repo.git')).toBe('git.example.com:8443');
        expect(hostName('plain')).toBe('plain');
    });
});

describe('asking', () => {
    it('sends what was typed and clears the fields', async () => {
        const send = vi.fn(async () => true);
        const done = ask(q({ kind: 'username', host: 'https://h' }), { send });
        await tick();
        const inputs = document.querySelectorAll('.app-dialog input:not([type=checkbox])');
        inputs[0].value = 'me';
        inputs[1].value = 'secret';
        [...document.querySelectorAll('.app-dialog-btn')].find((b) => b.classList.contains('primary')).click();
        await done;
        expect(send).toHaveBeenCalledWith({ id: 7, answer: 'me', password: 'secret', remember: false });
        expect(inputs[1].value).toBe('');
    });

    it('sends a cancel as no answer', async () => {
        const send = vi.fn(async () => true);
        const done = ask(q({ kind: 'passphrase', key: 'k' }), { send });
        await tick();
        [...document.querySelectorAll('.app-dialog-btn')].find((b) => !b.classList.contains('primary')).click();
        await done;
        expect(send).toHaveBeenCalledWith({ id: 7, answer: null, password: null, remember: false });
    });
});

describe('git errors in alerts', () => {
    it('says in words that sign-in failed', () => {
        const text = gitErrorText("fatal: could not read Username for 'https://h': terminal prompts disabled");
        expect(text).toMatch(/^Sign-in to the remote failed or was cancelled/);
        expect(text).toContain('terminal prompts disabled');
        expect(gitErrorText('remote: HTTP Basic: Access denied\nfatal: Authentication failed for x')).toMatch(/^Sign-in/);
    });

    it('leaves other errors as they were', () => {
        expect(gitErrorText('fatal: not a git repository')).toBe('Git Error: fatal: not a git repository');
        expect(gitErrorText('rejected (non-fast-forward)', 'Push failed')).toBe('Push failed: rejected (non-fast-forward)');
        // A status code counts; the same digits inside a word do not.
        expect(gitErrorText('fatal: unable to access: The requested URL returned error: 403')).toMatch(/^Sign-in/);
        expect(gitErrorText('error: pathspec 401abc did not match')).toMatch(/^Git Error/);
    });
});
