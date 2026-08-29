#!/usr/bin/env node
/**
 * 配布物に同梱している第三者コードの著作権表示を集めて
 * `THIRD-PARTY-NOTICES.md` を作る。
 *
 * MIT と BSD は「著作権表示と許諾文を複製物に含めること」を条件にしていて、
 * これはソース配布だけの話ではない。インストーラの中にライブラリのコードが
 * 入っている以上、バイナリ配布にも同じ条件がかかる。守らなければライセンス
 * 違反になる。自分のコードを何で出すかとは別の話で、選べる余地はない。
 *
 * 手で書かない。依存は増えるし版も上がるので、手書きの一覧は必ず古くなる。
 * 古くなった時点で、それは表記があるだけで条件を満たしていない。
 *
 *   node scripts/make-third-party-notices.mjs
 *
 * 対象は 2 つある。どちらも成果物に入る。
 *   - npm の依存      … Vite が dist へバンドルする
 *   - Rust のクレート … exe にリンクされる
 *
 * `public/lib/` に直接置いてあるものは node_modules に無いので、手で
 * VENDORED に足す。ここだけは自動で拾えない。
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');

/** ライセンス本文が入っていそうなファイル名。 */
const LICENSE_FILES = /^(LICEN[CS]E|COPYING|NOTICE)([-.].*)?$/i;

/**
 * `public/lib/` へ直接置いているもの。ビルドを通さず index.html から読むので
 * 依存グラフに現れず、放っておくと表記から漏れる。
 */
const VENDORED = [
    {
        name: 'marked',
        file: 'public/lib/marked.min.js',
        license: 'MIT',
        homepage: 'https://github.com/markedjs/marked',
    },
    {
        name: 'mermaid',
        file: 'public/lib/mermaid.min.js',
        license: 'MIT',
        homepage: 'https://github.com/mermaid-js/mermaid',
    },
];

const die = (msg) => { console.error('error: ' + msg); process.exit(1); };

/** ディレクトリ直下からライセンス本文を読む。 */
function licenseTextFrom(dir) {
    if (!dir || !existsSync(dir)) return null;
    let names;
    try { names = readdirSync(dir); } catch { return null; }
    const hits = names.filter((n) => LICENSE_FILES.test(n)).sort();
    if (!hits.length) return null;
    const parts = [];
    for (const n of hits) {
        try {
            const body = readFileSync(join(dir, n), 'utf8').trim();
            if (body) parts.push(hits.length > 1 ? `--- ${n} ---\n${body}` : body);
        } catch { /* 読めないものは飛ばす */ }
    }
    return parts.length ? parts.join('\n\n') : null;
}

// ---------------------------------------------------------------- npm

/**
 * package.json の dependencies から推移的にたどる。devDependencies は
 * 成果物に入らないので追わない。
 */
function collectNpm() {
    const seen = new Map();
    const rootPkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));

    const resolve = (name, fromDir) => {
        let dir = fromDir;
        for (;;) {
            const cand = join(dir, 'node_modules', name);
            if (existsSync(join(cand, 'package.json'))) return cand;
            const up = dirname(dir);
            if (up === dir) return null;
            dir = up;
        }
    };

    const walk = (name, fromDir) => {
        const dir = resolve(name, fromDir);
        if (!dir) return;                       // 任意依存が入っていない等
        let pkg;
        try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); }
        catch { return; }

        const key = `${pkg.name}@${pkg.version}`;
        if (seen.has(key)) return;
        seen.set(key, {
            name: pkg.name,
            version: pkg.version,
            license: pkg.license || pkg.licenses?.[0]?.type || null,
            homepage: pkg.homepage || pkg.repository?.url || pkg.repository || null,
            text: licenseTextFrom(dir),
        });

        for (const dep of Object.keys(pkg.dependencies || {})) walk(dep, dir);
    };

    for (const dep of Object.keys(rootPkg.dependencies || {})) walk(dep, repo);
    return [...seen.values()];
}

// --------------------------------------------------------------- cargo

/**
 * cargo metadata から、実際にリンクされるクレートだけを取る。
 *
 * --filter-platform を付けないと、Android や Linux でしか使われないものまで
 * 並ぶ。配っていないプラットフォームの依存を載せた表記は、正確ではなく
 * ただ長いだけで、本当に同梱しているものを探しにくくする。
 */
const TARGET = process.env.NOTICES_TARGET || 'x86_64-pc-windows-msvc';

function collectCargo() {
    let meta;
    try {
        const out = execFileSync(
            'cargo',
            ['metadata', '--format-version', '1', '--locked',
             '--filter-platform', TARGET],
            { cwd: join(repo, 'src-tauri'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
        );
        meta = JSON.parse(out);
    } catch (e) {
        console.warn('warn: cargo metadata を実行できないので Rust 側を飛ばす');
        console.warn('      ' + (e.message || e).split('\n')[0]);
        return [];
    }

    // resolve.nodes に出るのが依存グラフ。ワークスペース自身は除く。
    const members = new Set(meta.workspace_members || []);
    const byId = new Map(meta.packages.map((p) => [p.id, p]));
    const ids = (meta.resolve?.nodes || []).map((n) => n.id).filter((id) => !members.has(id));

    return ids
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((p) => ({
            name: p.name,
            version: p.version,
            license: p.license || (p.license_file ? 'see license file' : null),
            homepage: p.repository || p.homepage || null,
            // manifest_path は <crate>/Cargo.toml を指す。
            text: licenseTextFrom(p.manifest_path ? dirname(p.manifest_path) : null),
        }));
}

// -------------------------------------------------------------- output

/**
 * 本文が一字一句同じものはまとめて 1 回だけ載せる。
 *
 * Apache-2.0 の本文はどのクレートでも同一で、windows-sys 系だけで 400 回
 * 近く繰り返される。並べても情報は増えず、MIT の著作権者行のように本当に
 * 固有のものが埋もれる。求められているのは著作権表示と許諾文を含めること
 * であって、パッケージごとに別々の写しを置くことではない。どのパッケージ
 * がどの本文に対応するかが辿れればよい。
 */
function section(title, items) {
    const lines = [`## ${title}`, ''];
    if (!items.length) {
        lines.push('（なし）', '');
        return lines.join('\n');
    }

    const groups = new Map();
    for (const it of [...items].sort((a, b) => a.name.localeCompare(b.name))) {
        const key = it.text || `\u0000no-text:${it.license || 'unknown'}`;
        if (!groups.has(key)) groups.set(key, { text: it.text, members: [] });
        groups.get(key).members.push(it);
    }

    lines.push(`${items.length} 件（本文 ${groups.size} 種）。`, '');

    let n = 0;
    for (const g of groups.values()) {
        n += 1;
        const label = g.members.length === 1
            ? `${g.members[0].name} ${g.members[0].version || ''}`.trim()
            : `${g.members[0].name} ほか ${g.members.length - 1} 件`;
        lines.push(`### ${n}. ${label}`, '');

        for (const m of g.members) {
            const url = m.homepage ? ` — ${String(m.homepage).replace(/^git\+|\.git$/g, '')}` : '';
            lines.push(`- \`${m.name}${m.version ? ' ' + m.version : ''}\` （${m.license || 'ライセンス不明'}）${url}`);
        }
        lines.push('');

        if (g.text) {
            lines.push('```text', g.text, '```', '');
        } else {
            lines.push(
                '> 配布物にライセンス本文が同梱されていなかった。上記の URL を参照のこと。',
                '',
            );
        }
    }
    return lines.join('\n');
}

const npm = collectNpm();
const cargo = collectCargo();
const vendored = VENDORED.map((v) => {
    if (!existsSync(join(repo, v.file))) die(`${v.file} が無い。VENDORED の記述が古い`);
    return { ...v, version: '', text: null };
});

if (!npm.length) die('npm の依存を 1 件も拾えなかった。node_modules はあるか');

const header = `# 第三者ライセンス表記

J.H Editor には以下の第三者ソフトウェアが含まれています。それぞれの著作権は
各権利者に帰属し、以下に示す条件のもとで再配布しています。

J.H Editor 自体のライセンスは同梱の \`LICENSE\`（MIT）を参照してください。

このファイルは \`scripts/make-third-party-notices.mjs\` で生成しています。
依存を追加・更新したら再生成してください。手で編集しないこと。

生成日時: ${new Date().toISOString()}

`;

const body = [
    header,
    section('npm パッケージ', npm),
    section('直接同梱しているライブラリ', vendored),
    section(`Rust クレート (${TARGET})`, cargo),
].join('\n');

const out = join(repo, 'THIRD-PARTY-NOTICES.md');
writeFileSync(out, body, 'utf8');

console.log('THIRD-PARTY-NOTICES.md を生成しました:');
console.log('  ' + out);
console.log('');
console.log(`  npm パッケージ   ${npm.length} 件 (本文あり ${npm.filter((x) => x.text).length})`);
console.log(`  直接同梱         ${vendored.length} 件`);
console.log(`  Rust クレート    ${cargo.length} 件 (本文あり ${cargo.filter((x) => x.text).length}) [${TARGET}]`);
