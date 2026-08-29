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
 * 複製ではなくリネームするのは、選ぶ余地を残さないため。並べて置くと中身の
 * 同じ exe が 2 つになり、見分けはファイル名だけになる。取り違えてもビルドは
 * 通りリリースも通り、気づくのは更新が届かないと言われたときになる。
 *
 *   node scripts/make-latest-json.mjs [--notes "変更点"]
 */

import { readFileSync, writeFileSync, readdirSync, renameSync, rmSync, existsSync } from 'node:fs';
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

// 前の版のインストーラも同じディレクトリに残る。名前だけで拾うと、どれが
// 選ばれるかは readdir の順次第になる。順番が変われば古い版を指した
// manifest ができ、版だけ新しく中身と署名は古い、という状態になる。
// 署名は正しいので検証は通り、インストールもできてしまう。更新したのに何も
// 変わらず、気づく手がかりが無い。だから版で絞る。
const forVersion = files.filter(
    (f) => f.endsWith('-setup.exe') && f.includes(`_${version}_`));

if (forVersion.length === 0) {
    const others = files.filter((f) => f.endsWith('-setup.exe'));
    die(others.length
        ? `${version} のインストーラが無い。あるのは: ${others.join(', ')}。ビルドし直す`
        : 'インストーラ (*-setup.exe) が見つからない');
}

const signed = forVersion.filter((f) => files.includes(`${f}.sig`));
if (signed.length === 0) {
    die('署名 (.sig) のないインストーラしかない。TAURI_SIGNING_PRIVATE_KEY を設定してビルドし直す');
}

// 空白入りが残っていればそれが今回のビルド出力。複製していた頃の名残で
// 空白なしの写しが同居していることがあるので、元のほうを選んで改名する。
const installer = signed.find((f) => /\s/.test(f)) || signed[0];

const signature = readFileSync(join(nsisDir, `${installer}.sig`), 'utf8').trim();
if (!signature) die('署名が空');

// 空白のない名前へ揃える。残すのは一つだけにして、上げるファイルを選ばせない。
const assetName = installer.replace(/\s+/g, '.');
if (assetName !== installer) {
    for (const [from, to] of [[installer, assetName],
                              [`${installer}.sig`, `${assetName}.sig`]]) {
        rmSync(join(nsisDir, to), { force: true });   // 前回ビルドの残骸
        renameSync(join(nsisDir, from), join(nsisDir, to));
    }
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
console.log('リリースに上げるファイル (この 2 つだけ):');
console.log('  ' + join(nsisDir, assetName));
console.log('  ' + out);
if (assetName !== installer) {
    console.log('');
    console.log(`  ※ ${installer} は ${assetName} へ改名した。`);
    console.log('     空白入りの名前で上げると manifest の URL と一致しない。');
}
