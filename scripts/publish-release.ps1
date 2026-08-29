<#
.SYNOPSIS
    ビルド済みの成果物を GitHub Release へ上げる。

.DESCRIPTION
    上げる前に、更新経路が壊れる条件を機械的に潰す。ここで弾いているのは
    どれも「ビルドは通り、リリースも通り、更新が来ないと言われて初めて
    気づく」種類のものばかりで、目視で守り続けるのは無理がある。

      - latest.json の URL と、実際に上げるファイル名が一致しているか
        GitHub は資産名の空白を置き換えるので、空白入りのまま上げると
        必ずずれる
      - latest.json の版・タグ・tauri.conf.json の版が揃っているか
      - 署名が入っているか (鍵無しでビルドすると .sig が出ず、更新は
        永久に検証に失敗する)
      - タグが指すコミットが、いま手元にあるものと同じか

    公開後は latest.json が実際に取得できるところまで確認する。ここが
    404 だと更新は一切届かない。draft のままだと latest に含まれないので、
    既定では draft にしない。

.PARAMETER Tag
    リリースのタグ。省略すると tauri.conf.json の版から v{version} を使う。

.PARAMETER NotesFile
    リリースノートのファイル。省略すると scratch/release-notes-{version}.md
    を探し、無ければタグの注釈を使う。

.PARAMETER Draft
    下書きとして作る。更新は届かなくなるので、確認目的のときだけ。

.PARAMETER Force
    既にあるリリースへ資産を上書きする。

.EXAMPLE
    .\scripts\publish-release.ps1

.EXAMPLE
    .\scripts\publish-release.ps1 -Tag v0.1.1 -NotesFile .\scratch\notes.md
#>

[CmdletBinding()]
param(
    [string] $Tag,
    [string] $NotesFile,
    [switch] $Draft,
    [switch] $Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = Split-Path -Parent $PSScriptRoot

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    OK   $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    警告 $msg" -ForegroundColor Yellow }

function Fail($msg) {
    Write-Host "`nerror: $msg" -ForegroundColor Red
    exit 1
}

# StrictMode は存在しないプロパティの参照も例外にする。「無いこと」を確かめ
# たい場所が、確かめる前に落ちてしまうので、任意の項目はここを通す。
function Get-Prop($obj, [string] $name) {
    if ($null -eq $obj) { return $null }
    $p = $obj.PSObject.Properties[$name]
    if ($p) { return $p.Value }
    return $null
}

# PowerShell 5.1 は、exe の stderr を 2>&1 で成功ストリームへ流すと各行を
# ErrorRecord に包む。ErrorActionPreference が Stop だとそれが終了エラーに
# なり、終了コード 0 でも落ちる。終了コードだけ見たいので、その間だけ
# Continue にする。
function Invoke-Quiet {
    param([Parameter(Mandatory)][string] $Exe,
          [string[]] $Arguments = @())
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Exe @Arguments 2>&1 | Out-Null
        return $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
    }
}

# ------------------------------------------------------------ 事前確認

Write-Step '事前確認'

# インストールした直後は、既に開いているシェルの PATH に gh が載っていない。
# 「入れたのに見つからない」で止めても、確認したいことと関係がない。
function Resolve-Gh {
    $onPath = Get-Command gh -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    foreach ($c in @(
        (Join-Path $env:ProgramFiles 'GitHub CLI\gh.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'GitHub CLI\gh.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\GitHub CLI\gh.exe')
    )) {
        if ($c -and (Test-Path $c)) { return $c }
    }
    return $null
}

$gh = Resolve-Gh
if (-not $gh) { Fail 'gh CLI が見つからない。https://cli.github.com/' }

if ((Invoke-Quiet $gh @('auth', 'status')) -ne 0) {
    Fail 'gh が認証されていない。gh auth login を実行する'
}
Write-Ok "gh は認証済み ($gh)"

$conf = Get-Content (Join-Path $repo 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
$version = $conf.version

if (-not $Tag) { $Tag = "v$version" }
if ($Tag -ne "v$version") {
    Fail "タグ $Tag が tauri.conf.json の版 $version と合わない (v$version のはず)"
}
Write-Ok "タグ $Tag / 版 $version"

# ------------------------------------------------------ 成果物の確認

Write-Step '成果物'

$bundle = Join-Path $repo 'src-tauri\target\release\bundle'
$nsis = Join-Path $bundle 'nsis'
$manifestPath = Join-Path $bundle 'latest.json'

if (-not (Test-Path $manifestPath)) {
    Fail 'latest.json が無い。先に .\scripts\build-release.ps1 を実行する'
}

$installers = @(Get-ChildItem $nsis -Filter '*-setup.exe' -ErrorAction SilentlyContinue)
if ($installers.Count -eq 0) { Fail 'インストーラが無い。先にビルドする' }
if ($installers.Count -gt 1) {
    Write-Warn 'インストーラが複数ある:'
    $installers | ForEach-Object { Write-Warn "  $($_.Name)" }
    Fail 'make-latest-json.mjs を実行して 1 つに揃える'
}
$installer = $installers[0]

if ($installer.Name -match '\s') {
    Fail "インストーラ名に空白がある: $($installer.Name)。GitHub が名前を置き換えるので latest.json の URL とずれる"
}
Write-Ok "インストーラ $($installer.Name)"

# 成果物がソースより古くないか。タグと HEAD が揃っていても、手元の
# インストーラがそれより前のコードから作られていることはある。署名は通り、
# 版も URL も合うので何も報告されず、配ってから「直したはずの不具合が直って
# いない」と言われて気づく。
$srcPaths = @('src', 'src-tauri/src', 'src-tauri/tauri.conf.json',
              'src-tauri/Cargo.toml', 'index.html', 'package.json')
Push-Location $repo
try {
    $lastSrc = & git log -1 --format=%cI -- @srcPaths
} finally {
    Pop-Location
}
if ($lastSrc) {
    $srcTime = [datetimeoffset]::Parse($lastSrc).LocalDateTime
    if ($installer.LastWriteTime -lt $srcTime) {
        Write-Warn 'インストーラがソースより古い'
        Write-Warn ('  最後のソース変更 {0:yyyy-MM-dd HH:mm}' -f $srcTime)
        Write-Warn ('  インストーラ     {0:yyyy-MM-dd HH:mm}' -f $installer.LastWriteTime)
        Write-Warn '  いまのコードで作り直していない可能性がある'
        $ans = Read-Host '    このまま上げるか (y/N)'
        if ($ans -ne 'y') { Fail '中止した。.\scripts\build-release.ps1 で作り直す' }
    } else {
        Write-Ok 'インストーラはソースより新しい'
    }
}

# ------------------------------------------------ latest.json の突き合わせ

Write-Step 'latest.json'

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json

if ($manifest.version -ne $version) {
    Fail "latest.json の版 ($($manifest.version)) が tauri.conf.json ($version) と違う。ビルドし直す"
}
Write-Ok "版 $($manifest.version)"

$platform = Get-Prop (Get-Prop $manifest 'platforms') 'windows-x86_64'
if (-not $platform) { Fail 'latest.json に windows-x86_64 が無い' }

if (-not (Get-Prop $platform 'signature')) {
    Fail '署名が空。TAURI_SIGNING_PRIVATE_KEY を設定してビルドし直す'
}
Write-Ok '署名あり'

# ここが一番外しやすい。URL の末尾と実ファイル名が一致していないと、
# リリースは成功し、更新だけが 404 で永久に届かない。
$urlName = ($platform.url -split '/')[-1]
if ($urlName -ne $installer.Name) {
    Fail "latest.json の URL 末尾 ($urlName) が実ファイル名 ($($installer.Name)) と違う"
}
Write-Ok "URL の指す名前が実ファイルと一致 ($urlName)"

if ($platform.url -notmatch "/download/$([regex]::Escape($Tag))/") {
    Fail "latest.json の URL がタグ $Tag を指していない: $($platform.url)"
}
Write-Ok "URL のタグが $Tag"

# ------------------------------------------------------------ タグ

Write-Step 'タグ'

Push-Location $repo
try {
    if ((Invoke-Quiet 'git' @('rev-parse', '--verify', "refs/tags/$Tag")) -ne 0) {
        Fail "タグ $Tag がローカルに無い。git tag -a $Tag で作る"
    }

    $tagCommit = (git rev-list -n 1 $Tag).Trim()
    $headCommit = (git rev-parse HEAD).Trim()
    if ($tagCommit -ne $headCommit) {
        Write-Warn "タグ $Tag は HEAD と別のコミットを指している"
        Write-Warn "  tag  $tagCommit"
        Write-Warn "  HEAD $headCommit"
        $ans = Read-Host '    このまま続けるか (y/N)'
        if ($ans -ne 'y') { Fail '中止した' }
    } else {
        Write-Ok "タグは HEAD を指している"
    }

    if ((Invoke-Quiet 'git' @('ls-remote', '--exit-code', '--tags', 'origin', $Tag)) -ne 0) {
        Write-Warn "タグ $Tag が origin に無いので push する"
        git push origin $Tag
        if ($LASTEXITCODE -ne 0) { Fail 'タグを push できなかった' }
    }
    Write-Ok 'タグは origin にある'
} finally {
    Pop-Location
}

# ------------------------------------------------------ リリースノート

if (-not $NotesFile) {
    $cand = Join-Path $repo "scratch\release-notes-$Tag.md"
    if (Test-Path $cand) { $NotesFile = $cand }
}
if ($NotesFile -and -not (Test-Path $NotesFile)) {
    Fail "リリースノートが見つからない: $NotesFile"
}

# ------------------------------------------------------------ 公開

Write-Step '公開'

$assets = @($installer.FullName, $manifestPath)
foreach ($a in $assets) { Write-Host "    $a" }

$exists = $false
Push-Location $repo
try {
    if ((Invoke-Quiet $gh @('release', 'view', $Tag)) -eq 0) { $exists = $true }
} finally {
    Pop-Location
}

Push-Location $repo
try {
    if ($exists) {
        if (-not $Force) {
            Fail "リリース $Tag は既にある。資産を差し替えるなら -Force"
        }
        Write-Warn "既存のリリース $Tag へ資産を上書きする"
        & $gh release upload $Tag @assets --clobber
        if ($LASTEXITCODE -ne 0) { Fail '資産を上げられなかった' }
    } else {
        $ghArgs = @('release', 'create', $Tag) + $assets +
                @('--title', "J.H Editor $version", '--verify-tag')
        if ($NotesFile) {
            $ghArgs += @('--notes-file', $NotesFile)
        } else {
            $ghArgs += '--generate-notes'
        }
        if ($Draft) { $ghArgs += '--draft' }

        & $gh @ghArgs
        if ($LASTEXITCODE -ne 0) { Fail 'リリースを作成できなかった' }
    }
} finally {
    Pop-Location
}

Write-Ok 'アップロード完了'

# ------------------------------------------------------ 公開後の確認

Write-Step '公開後の確認'

if ($Draft) {
    Write-Warn 'draft なので更新は届かない。確認が済んだら publish すること'
    Write-Host "    gh release edit $Tag --draft=false"
    exit 0
}

# 更新チェックが実際に見に行く URL。ここが 404 なら何も届かない。
$endpoint = (Get-Prop (Get-Prop (Get-Prop $conf 'plugins') 'updater') 'endpoints')[0]
Write-Host "    $endpoint"

try {
    $res = Invoke-WebRequest -Uri $endpoint -UseBasicParsing -TimeoutSec 30
    $got = $res.Content | ConvertFrom-Json
    if ($got.version -ne $version) {
        Write-Warn "取得できた manifest の版が $($got.version) で、$version と違う"
    } else {
        Write-Ok "manifest を取得できた (版 $($got.version))"
    }

    $head = Invoke-WebRequest -Uri $got.platforms.'windows-x86_64'.url -Method Head -UseBasicParsing -TimeoutSec 30
    Write-Ok "インストーラも取得できる (HTTP $($head.StatusCode))"
} catch {
    Write-Warn "確認に失敗した: $_"
    Write-Warn '反映に少し時間がかかることがある。少し置いて上の URL を開いて確かめる'
}

Write-Step '完了'
Push-Location $repo
try { & $gh release view $Tag --web } finally { Pop-Location }
