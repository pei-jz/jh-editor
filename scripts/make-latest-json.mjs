#!/usr/bin/env node
/**
 * ビルド出力から updater 用の `latest.json` を作る。
 *
 * `tauri build` はこれを生成しない。`createUpdaterArtifacts: true` が作るのは
 * インストーラと `.sig` までで、manifest は GitHub Action (tauri-action) が
 * 組み立てるか、自分で用意する必要がある。手元でビルドして手で配るなら後者。
 *
 * 手書きしない理由は、間違えても静かに壊れるから。署名の貼り間違いも URL の
 * ずれも、ビルドは通り、リリースも通り、気づくのは「更新が来ない」と言われた
 * ときになる。
 *
 * ファイル名から空白を落としているのもそのため。GitHub はリリース資産の
 * ファイル名にある空白を別の文字へ置き換えるので、`J.H Editor_...exe` の
 * ままだと manifest に書いた URL と実際の配信 URL がずれる。空白のない名前で
 * 上げてしまえば、その挙動に依存しなくて済む。
 *
 *   node scripts/make-latest-json.mjs [--notes "変更点"]
 */

import { readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');

const die = (msg) => { console.error('error: ' + msg); process.exit(1); };

const conf = JSON.parse(readFileSync(join(repo, 'src-tauri/tauri.conf.json'), 'utf8'));
const version = conf.version;
const tag = `v${version}`;

// endpoints から owner/repo を取る。設定と生成物がずれないよう、URL の元は
// 一箇所にしておく。
const endpoint = conf.plugins?.updater?.endpoints?.[0];
if (!endpoint) die('plugins.updater.endpoints が設定されていない');
const m = endpoint.match(/github\.com\/([^/]+)\/([^/]+)\//);
if (!m) die(`endpoint から owner/repo を読み取れない: ${endpoint}`);
const [, owner, repoName] = m;

const bundleDir = join(repo, 'src-tauri/target/release/bundle');
const nsisDir = join(bundleDir, 'nsis');
if (!existsSync(nsisDir)) die('ビルド出力がない。先に `npm run tauri build` を実行する');

const files = readdirSync(nsisDir);
const installer = files.find((f) => f.endsWith('-setup.exe'));
if (!installer) die('インストーラ (*-setup.exe) が見つからない');

const sigName = `${installer}.sig`;
if (!files.includes(sigName)) {
    die('署名 (.sig) がない。TAURI_SIGNING_PRIVATE_KEY を設定してビルドし直す');
}

const signature = readFileSync(join(nsisDir, sigName), 'utf8').trim();
if (!signature) die('署名が空');

// 空白のない名前でリリースに上げる。manifest の URL はこちらを指す。
const assetName = installer.replace(/\s+/g, '.');
if (assetName !== installer) {
    copyFileSync(join(nsisDir, installer), join(nsisDir, assetName));
}

const notesArg = process.argv.indexOf('--notes');
const notes = notesArg !== -1 ? process.argv[notesArg + 1] : `J.H Editor ${version}`;

const manifest = {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms: {
        'windows-x86_64': {
            signature,
            url: `https://github.com/${owner}/${repoName}/releases/download/${tag}/${assetName}`,
        },
    },
};

const out = join(bundleDir, 'latest.json');
writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

console.log('latest.json を生成しました:');
console.log('  ' + out);
console.log('');
console.log('リリースに上げるファイル:');
console.log('  ' + join(nsisDir, assetName));
console.log('  ' + out);
if (assetName !== installer) {
    console.log('');
    console.log(`  ※ 空白を除いた名前 (${assetName}) で上げること。`);
    console.log('     元の名前で上げると manifest の URL と一致しない。');
}
