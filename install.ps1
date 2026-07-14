# LMcode source installer for Windows.
# Prerequisites: Node.js >= 22.19.0 and Git.

$ErrorActionPreference = "Stop"

$Repo       = "Lyin01/LMcode-cli"
$DefaultDir = "$env:USERPROFILE\lmcode"
$InstallDir = [IO.Path]::GetFullPath($(if ($env:INSTALL_DIR) { $env:INSTALL_DIR } else { $DefaultDir }))
$BinDir     = Join-Path $InstallDir "bin"

$UpgradeMode = $false
$ForceMode   = $false
$RequiredPnpmVersion = "11.7.0"

function Show-Usage {
    Write-Host "Usage: .\install.ps1 [--upgrade] [--force]"
    Write-Host ""
    Write-Host "  --upgrade  Update an existing LMcode checkout with a fast-forward pull."
    Write-Host "  --force    Reset tracked files in an existing LMcode checkout to origin/main."
    Write-Host ""
    Write-Host "INSTALL_DIR may be used to choose the source checkout directory."
}

foreach ($arg in $args) {
    switch ($arg) {
        "--upgrade" { $UpgradeMode = $true }
        "--force"   { $ForceMode = $true }
        "--help"    { Show-Usage; exit 0 }
        "-h"        { Show-Usage; exit 0 }
        default      { Write-Host "[ERROR] Unknown option: $arg" -ForegroundColor Red; Show-Usage; exit 2 }
    }
}

function Info($msg)  { Write-Host "[INFO]  $msg" -ForegroundColor Green }
function Warn($msg)  { Write-Host "[WARN]  $msg" -ForegroundColor Yellow }
function Fail($msg)  { Write-Host "[ERROR] $msg" -ForegroundColor Red }

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter()][string[]]$Arguments = @()
    )

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed (exit code $LASTEXITCODE)"
    }
}

function Test-LmcodeCheckout {
    $gitDir = Join-Path $InstallDir ".git"
    $rootPackageJson = Join-Path $InstallDir "package.json"
    $appPackageJson = Join-Path $InstallDir "apps\lmcode\package.json"
    if (-not (Test-Path -LiteralPath $gitDir -PathType Container)) { return $false }
    if (-not (Test-Path -LiteralPath $rootPackageJson -PathType Leaf)) { return $false }
    if (-not (Test-Path -LiteralPath $appPackageJson -PathType Leaf)) { return $false }

    try {
        $rootManifest = Get-Content -LiteralPath $rootPackageJson -Raw | ConvertFrom-Json
        $appManifest = Get-Content -LiteralPath $appPackageJson -Raw | ConvertFrom-Json
        return $rootManifest.name -eq "@lmcode-cli/monorepo" -and
            $appManifest.name -eq "@liumir/lmcode"
    } catch {
        return $false
    }
}

function Test-LegacyUserData {
    foreach ($relativePath in @("config.toml", "mcp.json", "sessions", "memory", "user-history", "logs")) {
        if (Test-Path -LiteralPath (Join-Path $InstallDir $relativePath)) { return $true }
    }
    return $false
}

function Test-CompatiblePnpm {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter()][string[]]$Prefix = @()
    )

    try {
        $versionOutput = & $Command @Prefix --version 2>$null
        if ($LASTEXITCODE -ne 0 -or $versionOutput -notmatch "^(\d+)\.(\d+)\.(\d+)$") {
            return $false
        }
        $major = [int]$matches[1]
        $minor = [int]$matches[2]
        $patch = [int]$matches[3]
        return $major -eq 11 -and ($minor -gt 7 -or ($minor -eq 7 -and $patch -ge 0))
    } catch {
        return $false
    }
}

$homeFullPath = [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\')
$installFullPath = $InstallDir.TrimEnd('\')
if ([string]::IsNullOrWhiteSpace($installFullPath) -or
    $installFullPath -eq [IO.Path]::GetPathRoot($installFullPath).TrimEnd('\') -or
    $installFullPath -eq $homeFullPath) {
    Fail "Refusing unsafe INSTALL_DIR: $InstallDir"
    exit 1
}

$isExistingCheckout = Test-LmcodeCheckout
$UseLegacyDataHome = $isExistingCheckout -and (Test-LegacyUserData)
if (-not $isExistingCheckout -and (Test-Path -LiteralPath $InstallDir)) {
    Fail "Refusing to overwrite existing non-LMcode directory: $InstallDir"
    Fail "Choose an empty path with INSTALL_DIR. Existing files were not changed."
    exit 1
}
if (-not $isExistingCheckout -and ($UpgradeMode -or $ForceMode)) {
    Fail "No LMcode source checkout exists at $InstallDir"
    exit 1
}

function Find-Node {
    foreach ($cmd in @("node", "nodejs", "node22", "node24", "node25")) {
        $found = Get-Command $cmd -ErrorAction SilentlyContinue
        if (-not $found) { continue }
        $verOutput = & $found.Source --version 2>&1
        if ($verOutput -match "^v?(\d+)\.(\d+)\.(\d+)$") {
            $major = [int]$matches[1]
            $minor = [int]$matches[2]
            $patch = [int]$matches[3]
            if ($major -gt 22 -or
                ($major -eq 22 -and ($minor -gt 19 -or ($minor -eq 19 -and $patch -ge 0)))) {
                return @{ Path = $found.Source; Version = "$major.$minor.$patch" }
            }
        }
    }
    return $null
}

Info "Checking Node.js >= 22.19.0..."
$nodeInfo = Find-Node
if (-not $nodeInfo) {
    Fail "Node.js 22.19.0 or newer was not found"
    Write-Host "Install it from https://nodejs.org/ and retry."
    exit 1
}
$node = $nodeInfo.Path
Info "Node.js: $( & $node --version ) ($node)"

Info "Checking Git..."
$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) {
    Fail "Git was not found. Install it from https://git-scm.com/download/win and retry."
    exit 1
}
Info "Git: $(& $git.Source --version)"

Info "Checking pnpm >= 11.7.0 and < 12..."
$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
$PnpmCommand = $null
$PnpmPrefix = @()
if ($pnpm -and (Test-CompatiblePnpm -Command $pnpm.Source)) {
    $PnpmCommand = $pnpm.Source
} else {
    Warn "A compatible pnpm was not found; activating pnpm $RequiredPnpmVersion."
    $corepack = Get-Command corepack -ErrorAction SilentlyContinue
    if ($corepack) {
        try {
            & $corepack.Source prepare "pnpm@$RequiredPnpmVersion" --activate 2>$null | Out-Null
        } catch { }
        if (Test-CompatiblePnpm -Command $corepack.Source -Prefix @("pnpm")) {
            $PnpmCommand = $corepack.Source
            $PnpmPrefix = @("pnpm")
        }
    }

    if (-not $PnpmCommand) {
        $tmpPnpmInstall = Join-Path $env:TEMP "pnpm-install-$([guid]::NewGuid().ToString('N')).ps1"
        $previousPnpmVersion = $env:PNPM_VERSION
        try {
            Invoke-WebRequest https://get.pnpm.io/install.ps1 -OutFile $tmpPnpmInstall
            $env:PNPM_VERSION = $RequiredPnpmVersion
            & $tmpPnpmInstall
        } catch {
            Fail "pnpm installation failed: $_"
            Write-Host "Install pnpm manually from https://pnpm.io/installation and retry."
            exit 1
        } finally {
            $env:PNPM_VERSION = $previousPnpmVersion
            Remove-Item -LiteralPath $tmpPnpmInstall -Force -ErrorAction SilentlyContinue
        }
        $pnpmHome = if ($env:PNPM_HOME) { $env:PNPM_HOME } else { "$env:LOCALAPPDATA\pnpm" }
        $env:PATH = "$pnpmHome;$env:USERPROFILE\.local\bin;$env:PATH"
        $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
        if ($pnpm -and (Test-CompatiblePnpm -Command $pnpm.Source)) {
            $PnpmCommand = $pnpm.Source
        }
    }
}
if (-not $PnpmCommand) {
    Fail "pnpm $RequiredPnpmVersion could not be activated"
    exit 1
}
$pnpmVersion = & $PnpmCommand @PnpmPrefix --version
Info "pnpm: $pnpmVersion"

try {
    if ($isExistingCheckout) {
        if (-not $UpgradeMode -and -not $ForceMode) {
            Fail "LMcode is already installed at $InstallDir"
            Write-Host "Run this installer with --upgrade to update it."
            exit 1
        }

        Info "Updating verified LMcode checkout: $InstallDir"
        if ($ForceMode) {
            Warn "--force resets tracked files to origin/main and never runs git clean; back up local code changes first."
            Invoke-Checked "Fetching LMcode" $git.Source @("-C", $InstallDir, "fetch", "--depth", "1", "origin", "main")
            Invoke-Checked "Resetting LMcode tracked files" $git.Source @("-C", $InstallDir, "reset", "--hard", "origin/main")
        } else {
            Invoke-Checked "Updating LMcode" $git.Source @("-C", $InstallDir, "pull", "--ff-only", "origin", "main")
        }
    } else {
        Info "Cloning LMcode into $InstallDir..."
        Invoke-Checked "Cloning LMcode" $git.Source @("clone", "--depth", "1", "https://github.com/$Repo.git", $InstallDir)
    }

    Info "Installing dependencies and building..."
    Invoke-Checked "Installing dependencies" $PnpmCommand @($PnpmPrefix + @("--dir", $InstallDir, "install", "--frozen-lockfile"))
    Invoke-Checked "Building LMcode" $PnpmCommand @($PnpmPrefix + @("--dir", $InstallDir, "-r", "build"))
} catch {
    Fail $_.Exception.Message
    exit 1
}

Info "Creating lm command..."
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

$EscapedInstallDirForBatch = $InstallDir.Replace('%', '%%')
$EscapedNodeForBatch = $node.Replace('%', '%%')
$LegacyHomeLine = if ($UseLegacyDataHome) {
    "if not defined LMCODE_HOME set `"LMCODE_HOME=$EscapedInstallDirForBatch`""
} else {
    ""
}
$LmCmd = @"
@echo off
setlocal
$LegacyHomeLine
set "LMCODE_INSTALL_DIR=$EscapedInstallDirForBatch"
"$EscapedNodeForBatch" "$EscapedInstallDirForBatch\apps\lmcode\dist\main.mjs" %*
exit /b %ERRORLEVEL%
"@
Set-Content -LiteralPath (Join-Path $BinDir "lm.cmd") -Value $LmCmd -Encoding Default

if ($env:LMCODE_SKIP_SHORTCUT -ne "1") {
    Info "Creating desktop shortcut..."
    try {
        $DesktopPath = [Environment]::GetFolderPath("Desktop")
        $ShortcutPath = Join-Path $DesktopPath "LMcode.lnk"
        $LauncherPath = Join-Path $BinDir "lm.cmd"
        $EscapedLauncherForPowerShell = $LauncherPath.Replace("'", "''")
        $WshShell = New-Object -ComObject WScript.Shell
        $Shortcut = $WshShell.CreateShortcut($ShortcutPath)

        $wt    = Get-Command wt.exe -ErrorAction SilentlyContinue
        $pwsh7 = Get-Command pwsh.exe -ErrorAction SilentlyContinue
        $ps5   = Get-Command powershell.exe -ErrorAction SilentlyContinue

        if ($wt) {
            $Shortcut.TargetPath = $wt.Source
            $Shortcut.Arguments  = '--title "LMcode" cmd /k "chcp 65001 > nul && call ""{0}"""' -f $LauncherPath
        } elseif ($pwsh7) {
            $Shortcut.TargetPath = $pwsh7.Source
            $Shortcut.Arguments  = '-NoExit -Command "chcp 65001 > $null; & ''{0}''"' -f $EscapedLauncherForPowerShell
        } elseif ($ps5) {
            $Shortcut.TargetPath = $ps5.Source
            $Shortcut.Arguments  = '-NoExit -Command "chcp 65001 > $null; [Console]::OutputEncoding = [Console]::InputEncoding = [Text.Encoding]::UTF8; $Host.UI.RawUI.WindowTitle = ''LMcode''; & ''{0}''"' -f $EscapedLauncherForPowerShell
        } else {
            $Shortcut.TargetPath = "powershell.exe"
            $Shortcut.Arguments  = '-NoExit -Command "chcp 65001 > $null; [Console]::OutputEncoding = [Console]::InputEncoding = [Text.Encoding]::UTF8; $Host.UI.RawUI.WindowTitle = ''LMcode''; & ''{0}''"' -f $EscapedLauncherForPowerShell
        }

        $Shortcut.WorkingDirectory = $env:USERPROFILE
        $Shortcut.Description = "LMcode - AI terminal agent"
        $IconPath = Join-Path $InstallDir "icon.ico"
        if (Test-Path -LiteralPath $IconPath) {
            $Shortcut.IconLocation = $IconPath
        }
        $Shortcut.Save()
        Info "Desktop shortcut created: $ShortcutPath"
    } catch {
        Warn "Desktop shortcut creation failed: $_"
    }
}

if ($env:LMCODE_SKIP_PATH_UPDATE -ne "1") {
    $UserPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    $NormalizedBinDir = $BinDir.TrimEnd('\')
    $PathEntries = @($UserPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $FilteredPathEntries = @($PathEntries | Where-Object {
        -not [string]::Equals($_.TrimEnd('\'), $NormalizedBinDir, [StringComparison]::OrdinalIgnoreCase)
    })
    $NewUserPath = (@($BinDir) + $FilteredPathEntries) -join ';'
    if ($NewUserPath -ne $UserPath) {
        Info "Putting $BinDir first in the user PATH..."
        [Environment]::SetEnvironmentVariable("PATH", $NewUserPath, "User")
    }
}
$CurrentPathEntries = @($env:PATH -split ';' | Where-Object {
    -not [string]::IsNullOrWhiteSpace($_) -and
    -not [string]::Equals($_.TrimEnd('\'), $BinDir.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
})
$env:PATH = (@($BinDir) + $CurrentPathEntries) -join ';'

Info "Installation complete"
Write-Host ""
Write-Host "Install location: $InstallDir"
Write-Host "Run:              lm --version"
