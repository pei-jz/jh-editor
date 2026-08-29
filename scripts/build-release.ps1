<#
.SYNOPSIS
    署名付きのリリースビルドを作り、latest.json まで用意する。

.DESCRIPTION
    署名鍵とパスフレーズを受け取り、環境変数へ入れてビルドし、終わったら
    消す。鍵はファイルからもその場の入力からも渡せる。

    鍵の扱いについて:
      - パスフレーズはパラメータにしていない。コマンドラインに書けると
        PowerShell の履歴 (ConsoleHost_history.txt) に平文で残る。入力は
        毎回 SecureString で受ける。
      - 環境変数はこのプロセスにしか置かず、finally で必ず消す。手順書に
        あった「シェルを閉じるまで残る」状態を作らない。
      - 鍵の内容はどこにも出力しない。エラーメッセージにも載せない。

    鍵とパスフレーズの両方を失うと、公開済みの全インストールが更新経路を
    永久に失う。復旧手段は無い。両方を別々に控えておくこと。

.PARAMETER KeyPath
    署名鍵ファイルのパス。省略すると対話で聞く。パスは秘密ではないので
    パラメータで渡してよい。

.PARAMETER SkipTests
    テストを飛ばす。急いで手元の確認をしたいときだけ。リリース用の
    ビルドでは使わない。

.EXAMPLE
    .\scripts\build-release.ps1 -KeyPath ~\.tauri\jh-editor.key

.EXAMPLE
    .\scripts\build-release.ps1
    # 鍵のパス、または内容 (base64 1 行) を聞かれる
#>

[CmdletBinding()]
param(
    [string] $KeyPath,
    [switch] $SkipTests
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = Split-Path -Parent $PSScriptRoot

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }

function Fail($msg) {
    Write-Host "`nerror: $msg" -ForegroundColor Red
    exit 1
}

# SecureString を平文へ。使い終わったらすぐ捨てる前提で呼ぶ。
function ConvertFrom-SecureStringPlain([System.Security.SecureString] $s) {
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    } finally {
        # BSTR を確保したまま放置しない。
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    }
}

# ------------------------------------------------------------ 事前確認

Write-Step '事前確認'

foreach ($cmd in @('node', 'npm', 'cargo')) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Fail "$cmd が見つからない"
    }
}
Write-Ok 'node / npm / cargo あり'

$confPath = Join-Path $repo 'src-tauri\tauri.conf.json'
$conf = Get-Content $confPath -Raw | ConvertFrom-Json
$version = $conf.version
Write-Ok "バージョン $version"

# 版がずれたまま出すと、About の表示と配布物とタグが食い違う。
$pkg = Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json
if ($pkg.version -ne $version) {
    Fail "package.json ($($pkg.version)) と tauri.conf.json ($version) の版が違う"
}
$cargoToml = Get-Content (Join-Path $repo 'src-tauri\Cargo.toml') -Raw
if ($cargoToml -notmatch "(?m)^version\s*=\s*""$([regex]::Escape($version))""") {
    Fail "Cargo.toml の版が tauri.conf.json ($version) と違う"
}
Write-Ok '3 箇所の版が一致'

Push-Location $repo
try {
    $dirty = git status --porcelain
    if ($dirty) {
        Write-Warn '作業ツリーに未コミットの変更がある:'
        $dirty -split "`n" | Select-Object -First 10 | ForEach-Object { Write-Warn "  $_" }
        $ans = Read-Host '    このまま続けるか (y/N)'
        if ($ans -ne 'y') { Fail '中止した' }
    } else {
        Write-Ok '作業ツリーは清潔'
    }
} finally {
    Pop-Location
}

# ------------------------------------------------------------ 鍵の入力

Write-Step '署名鍵'

$keyValue = $null

if (-not $KeyPath) {
    Write-Host '    鍵ファイルのパス、または鍵の内容 (base64 1 行) を入力する。'
    Write-Host '    入力は表示されない。' -ForegroundColor DarkGray
    $secure = Read-Host '    鍵' -AsSecureString
    $entered = ConvertFrom-SecureStringPlain $secure
    if (-not $entered) { Fail '鍵が入力されなかった' }

    # パスとして解決できるならファイル、できないなら内容そのもの。
    $asPath = $null
    try { $asPath = Resolve-Path -LiteralPath $entered -ErrorAction SilentlyContinue } catch { }
    if ($asPath) {
        $KeyPath = $asPath.Path
    } else {
        $keyValue = $entered
        Write-Ok '入力された内容を鍵として使う'
    }
    $entered = $null
}

if ($KeyPath) {
    $resolved = Resolve-Path -LiteralPath $KeyPath -ErrorAction SilentlyContinue
    if (-not $resolved) { Fail "鍵ファイルが見つからない: $KeyPath" }
    $keyValue = Get-Content -LiteralPath $resolved.Path -Raw
    if (-not $keyValue) { Fail "鍵ファイルが空: $($resolved.Path)" }
    Write-Ok "鍵を読み込んだ: $($resolved.Path)"
}

# 取り違えを早めに弾く。公開鍵を渡してもビルドは進み、署名だけが静かに
# 失敗する。
if ($keyValue -match 'minisign public key') {
    Fail '公開鍵が渡されている。署名には秘密鍵が要る'
}

Write-Host '    パスフレーズを入力する (鍵に設定していなければ空のまま Enter)。'
$securePass = Read-Host '    パスフレーズ' -AsSecureString
$passValue = ConvertFrom-SecureStringPlain $securePass

# ------------------------------------------------------------ ビルド

$exitCode = 0
try {
    $env:TAURI_SIGNING_PRIVATE_KEY = $keyValue
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $passValue

    Push-Location $repo
    try {
        if (-not $SkipTests) {
            Write-Step 'テスト'
            npm test
            if ($LASTEXITCODE -ne 0) { Fail 'テストが落ちた' }
            Write-Ok '通過'
        } else {
            Write-Warn 'テストを飛ばした'
        }

        Write-Step 'ビルド (数分かかる)'
        npm run tauri build
        if ($LASTEXITCODE -ne 0) { Fail 'ビルドが落ちた' }
        Write-Ok '完了'

        Write-Step 'latest.json の生成と成果物の名前揃え'
        node scripts/make-latest-json.mjs
        if ($LASTEXITCODE -ne 0) { Fail 'latest.json を作れなかった' }
    } finally {
        Pop-Location
    }
} catch {
    Write-Host "`nerror: $_" -ForegroundColor Red
    $exitCode = 1
} finally {
    # ここは必ず通す。ビルドが落ちても鍵を環境に残さない。
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
    $keyValue = $null
    $passValue = $null
    [GC]::Collect()
}

if ($exitCode -ne 0) { exit $exitCode }

# ------------------------------------------------------------ 結果

$bundle = Join-Path $repo 'src-tauri\target\release\bundle'
$nsis = Join-Path $bundle 'nsis'
$installer = Get-ChildItem $nsis -Filter '*-setup.exe' | Select-Object -First 1
$manifest = Join-Path $bundle 'latest.json'

if (-not $installer) { Fail 'インストーラが見つからない' }
if (-not (Test-Path $manifest)) { Fail 'latest.json が見つからない' }

$hash = (Get-FileHash $installer.FullName -Algorithm SHA256).Hash.ToLower()

# ------------------------------------------------------ ポータブル版

# exe だけを固めた zip は配れない。著作権表示を複製物に含める条件は、
# インストーラでもポータブルでも同じようにかかる。手で固めると必ず忘れる
# ので、ここで一緒に入れる。
Write-Step 'ポータブル版'

$portableExe = Join-Path $repo 'src-tauri\target\release\jh_editor.exe'
if (-not (Test-Path $portableExe)) {
    Write-Warn 'jh_editor.exe が無いのでポータブル版は作らない'
    $portableZip = $null
} else {
    $stage = Join-Path $repo 'src-tauri\target\release\portable'
    if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
    New-Item -ItemType Directory -Path $stage | Out-Null

    Copy-Item $portableExe (Join-Path $stage 'jh_editor.exe')
    foreach ($f in @('LICENSE', 'THIRD-PARTY-NOTICES.md')) {
        $src = Join-Path $repo $f
        if (-not (Test-Path $src)) { Fail "$f が無い。ポータブル版に同梱できない" }
        Copy-Item $src (Join-Path $stage $f)
    }

    # インストーラと違い、ここには自動更新も WebView2 の導入も無い。
    # 中に書いておかないと伝わらない。
    $readme = @"
J.H Editor $version (ポータブル版)

jh_editor.exe をそのまま実行してください。インストールは不要です。

## インストーラ版との違い

自動更新はありません。インストーラを使わずに置いた場合、更新はこの
ファイルではなくインストール先へ適用されてしまうため、更新機能自体を
表示しないようにしています。新しい版は配布ページから入れ替えてください。

Microsoft Edge WebView2 ランタイムが必要です。Windows 11 と、最近の
Windows 10 には最初から入っています。起動しない場合は Microsoft の
配布ページから WebView2 ランタイムを入れてください。インストーラ版は
不足していれば自動で導入しますが、こちらにはその仕組みがありません。

設定と履歴は exe の隣ではなく、次の場所に保存されます。
持ち歩いても設定は付いてきません。

  %LOCALAPPDATA%\io.github.pei-jz.jheditor

## ライセンス

MIT ライセンスです。本ソフトウェアは無保証で提供されます。
LICENSE を参照してください。

同梱している第三者ソフトウェアの著作権表示は
THIRD-PARTY-NOTICES.md に記載しています。
"@
    Set-Content -Path (Join-Path $stage 'README.txt') -Value $readme -Encoding UTF8

    $portableZip = Join-Path $repo ("src-tauri\target\release\J.H.Editor_{0}_x64-portable.zip" -f $version)
    if (Test-Path $portableZip) { Remove-Item $portableZip -Force }
    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $portableZip
    Remove-Item $stage -Recurse -Force

    Write-Ok ('{0} ({1:N0} bytes)' -f (Split-Path $portableZip -Leaf), (Get-Item $portableZip).Length)
}

Write-Step '成果物'
Write-Host ('    {0}' -f $installer.FullName)
Write-Host ('    {0:N0} bytes' -f $installer.Length) -ForegroundColor DarkGray
Write-Host ('    SHA-256 {0}' -f $hash) -ForegroundColor DarkGray
Write-Host ('    {0}' -f $manifest)
if ($portableZip) { Write-Host ('    {0}' -f $portableZip) }

Write-Step '次にすること'
Write-Host '    1. ビルドした exe を実際に触って確認する'
Write-Host '    2. 問題なければ公開する:'
Write-Host ('       .\scripts\publish-release.ps1 -Tag v{0}' -f $version) -ForegroundColor White
