<#
.SYNOPSIS
    Unified herdr-cortex Installer for Windows 11 Herdr GUI (herdr-core / hc):
      - Registers the herdr-cortex Stdio MCP server for Claude Code (through `claude mcp add`) and, when
        Antigravity is present, for Antigravity CLI
      - Registers official hooks (Claude Code SessionStart/SessionEnd/PreCompact/UserPromptSubmit/PreToolUse,
        Antigravity SessionStart/PreInvocation) with the absolute path of node.exe
      - Installs cortex skills into ~/.claude/skills/cortex-* (when prompts/skills exists)
      - Initializes ~/.herdr-cortex/ (sessions, docs, config.json)
      - Adds a marker-delimited block to the PowerShell profile(s) that provides auto-resume and the commands
        `cortex-status`, `cortex-trust`, `revive-agents`, `revive-status`
    Every file is checked before anything is written, and every existing file that changes is first copied to
    <file>.herdr-cortex.<yyyyMMdd-HHmmss>.bak.
.PARAMETER NoAutoResume
    Install the shell commands but do not restore agent tabs automatically when a shell starts.
.PARAMETER SetExecutionPolicy
    If the PowerShell ExecutionPolicy does not allow local scripts, set it to RemoteSigned for the current
    user without asking.
.PARAMETER SkipExecutionPolicy
    Never change the ExecutionPolicy and do not ask.
.PARAMETER NodePath
    The node.exe to use (and to record in hooks and MCP entries) when `node` is not on PATH.
#>
param(
    [switch]$NoAutoResume,
    [switch]$SetExecutionPolicy,
    [switch]$SkipExecutionPolicy,
    [string]$NodePath
)

$ErrorActionPreference = "Stop"

$RepoRoot = $PSScriptRoot
$InstallerScript = Join-Path $RepoRoot "src\hooks\installer.mjs"
$AutoReviveScript = Join-Path $RepoRoot "scripts\auto-revive.ps1"

. (Join-Path $RepoRoot "scripts\install-tools.ps1")

$TestHome = if (-not [string]::IsNullOrWhiteSpace($env:HERDR_CORTEX_TEST_HOME)) {
    $env:HERDR_CORTEX_TEST_HOME
} elseif (-not [string]::IsNullOrWhiteSpace($env:HERDR_REVIVE_TEST_HOME)) {
    $env:HERDR_REVIVE_TEST_HOME
} else {
    $null
}
$EffectiveHome = if ($TestHome) { $TestHome } else { $env:USERPROFILE }
$GlobalCortexDir = Join-Path $EffectiveHome ".herdr-cortex"

Write-Host "=== herdr-cortex Installer ===" -ForegroundColor Cyan
if ($TestHome) {
    Write-Host "[TEST] Installing into the test home: $TestHome" -ForegroundColor DarkGray
}

# 1. Verify prerequisites (Node.js >= 22.13.0 for node:sqlite, sqlite-vec optional vector search, hc CLI)
$NodeExe = $null
if (-not [string]::IsNullOrWhiteSpace($NodePath)) {
    if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
        Write-Error "-NodePath does not point at a file: $NodePath"
        exit 1
    }
    $NodeExe = (Resolve-Path -LiteralPath $NodePath).ProviderPath
} else {
    $nodeCmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($nodeCmd) { $NodeExe = $nodeCmd.Source }
}
if (-not $NodeExe) {
    Write-Error "Node.js (node.exe >= 22.13.0) is required but was not found on PATH. Install it, or pass -NodePath <full path of node.exe>."
    exit 1
}

$nodeVerRaw = (& $NodeExe -v 2>$null | Select-Object -First 1)
if ($nodeVerRaw -match '^v?(\d+)\.(\d+)\.(\d+)') {
    $nodeMajor = [int]$Matches[1]
    $nodeMinor = [int]$Matches[2]
    if ($nodeMajor -lt 22 -or ($nodeMajor -eq 22 -and $nodeMinor -lt 13)) {
        Write-Error "Node.js >= 22.13.0 is required for built-in node:sqlite, but found $nodeVerRaw."
        exit 1
    }
    Write-Host "[OK] Node.js $nodeVerRaw detected." -ForegroundColor Green
} else {
    Write-Warning "Could not parse Node.js version string: $nodeVerRaw"
}

$sqliteVecDir = Join-Path $RepoRoot "node_modules\sqlite-vec"
if (-not (Test-Path $sqliteVecDir)) {
    Write-Warning "node_modules\sqlite-vec was not found. Vector search will be disabled until you run: npm install"
} else {
    Write-Host "[OK] sqlite-vec dependency detected." -ForegroundColor Green
}

if (-not (Get-Command hc -ErrorAction SilentlyContinue)) {
    Write-Warning "hc.exe was not found on PATH. Make sure Herdr-Core is installed for revive/relay features."
}

# 2. Register MCP server, official hooks, skills, and ~/.herdr-cortex/ directories.
#    The Node installer reads and checks every file first; on any problem it changes nothing and exits with 1.
$prevOutEnc = [Console]::OutputEncoding
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    & $NodeExe --no-warnings $InstallerScript install $RepoRoot
    $installerExit = $LASTEXITCODE
} finally {
    [Console]::OutputEncoding = $prevOutEnc
}
if ($installerExit -ne 0) {
    Write-Error "herdr-cortex was not installed (see the messages above). The PowerShell profile and the ExecutionPolicy were not touched."
    exit 1
}

# 3. PowerShell ExecutionPolicy: the profile is a local script, so it only loads when local scripts may run.
#    Nothing is changed without consent; what is changed is recorded so that uninstall.ps1 can restore it.
$policy = Get-HerdrPolicyState -TestHome $TestHome
if ($policy -and (Test-HerdrPolicyBlocksProfile $policy)) {
    $manualCommand = "Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned"
    $changePolicy = $false
    if ($SetExecutionPolicy) {
        $changePolicy = $true
    } elseif (-not $SkipExecutionPolicy) {
        $canPrompt = $false
        try {
            $canPrompt = (-not $TestHome) -and [Environment]::UserInteractive -and ($Host.Name -eq "ConsoleHost") -and (-not [Console]::IsInputRedirected)
        } catch {
            $canPrompt = $false
        }
        if ($canPrompt) {
            Write-Host ""
            Write-Host "PowerShell does not run local scripts under the current ExecutionPolicy (CurrentUser=$($policy.CurrentUser), LocalMachine=$($policy.LocalMachine))."
            Write-Host "The profile that provides cortex-status, cortex-trust and tab revive would not load."
            try {
                $answer = Read-Host "Set the ExecutionPolicy of the current user to RemoteSigned? [Y/N]"
                $changePolicy = ($answer -match '^\s*(?i)y(es)?\s*$')
            } catch {
                $changePolicy = $false
            }
        }
    }

    if ($changePolicy) {
        try {
            Write-HerdrPolicyRecord -GlobalDir $GlobalCortexDir -Previous $policy.CurrentUser -NewValue "RemoteSigned"
            Set-HerdrCurrentUserPolicy -Value "RemoteSigned" -TestHome $TestHome
            Write-Host "[OK] Set PowerShell ExecutionPolicy (CurrentUser) to RemoteSigned (it was $($policy.CurrentUser); uninstall.ps1 restores it)." -ForegroundColor Green
        } catch {
            Remove-Item -LiteralPath (Get-HerdrPolicyRecordPath $GlobalCortexDir) -Force -ErrorAction SilentlyContinue
            Write-Warning "Could not set the ExecutionPolicy ($($_.Exception.Message)). Run: $manualCommand"
        }
    } else {
        Write-Host "[SKIP] PowerShell ExecutionPolicy not changed (CurrentUser=$($policy.CurrentUser), LocalMachine=$($policy.LocalMachine))." -ForegroundColor Yellow
        Write-Host "       Until local scripts are allowed, PowerShell does not load the profile: cortex-status, cortex-trust and"
        Write-Host "       tab revive are unavailable (hooks and the MCP server work without it). To allow them, run:"
        Write-Host "         $manualCommand"
        Write-Host "       or run this installer again with -SetExecutionPolicy."
    }
}

# 4. PowerShell profile(s): a marker-delimited block, written in the file's own encoding after a dated backup.
#    Only that block changes (the block of the predecessor herdr-revive is removed).
$blockLines = Get-HerdrProfileBlockLines -AutoReviveScript $AutoReviveScript -NoAutoResume:$NoAutoResume

$profileTargets = New-Object System.Collections.Generic.List[string]
$docsDir = if ($TestHome) {
    Join-Path $TestHome "Documents"
} else {
    $d = [Environment]::GetFolderPath("MyDocuments")
    if ([string]::IsNullOrWhiteSpace($d)) { Join-Path $env:USERPROFILE "Documents" } else { $d }
}
$winPsProfile = Join-Path $docsDir "WindowsPowerShell\Microsoft.PowerShell_profile.ps1"
$pwshProfile = Join-Path $docsDir "PowerShell\Microsoft.PowerShell_profile.ps1"

$profileTargets.Add($winPsProfile)
if ((Test-Path (Split-Path -Parent $pwshProfile)) -or (Get-Command pwsh -ErrorAction SilentlyContinue)) {
    $profileTargets.Add($pwshProfile)
}
if (-not $TestHome -and $PROFILE -and ($profileTargets -notcontains $PROFILE)) {
    $profileTargets.Add($PROFILE)
}

$backupStamp = Get-HerdrBackupStamp
$profileProblems = 0
foreach ($profPath in ($profileTargets | Select-Object -Unique)) {
    $res = Set-HerdrProfileBlock -ProfilePath $profPath -BlockLines $blockLines -Stamp $backupStamp
    switch ($res.Status) {
        "created" {
            Write-Host "[OK] Created PowerShell profile: $profPath" -ForegroundColor Green
        }
        "updated" {
            Write-Host "[OK] Updated PowerShell profile: $profPath (encoding kept: $($res.Encoding))" -ForegroundColor Green
            Write-Host "[OK] Backup: $($res.BackupPath)" -ForegroundColor Green
        }
        "unchanged" {
            Write-Host "[OK] PowerShell profile already up to date: $profPath" -ForegroundColor Green
        }
        default {
            $profileProblems++
            Write-Warning "PowerShell profile NOT changed: $profPath ($($res.Message)). Add these lines to it yourself:"
            foreach ($line in $blockLines) { Write-Host "    $line" }
        }
    }
}

# 5. Where documents would be sent for embedding (nothing, unless a provider is configured)
$prevOutEnc = [Console]::OutputEncoding
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    & $NodeExe --no-warnings $InstallerScript embedding-status
} catch {
    Write-Warning "Could not read the embedding status: $($_.Exception.Message)"
} finally {
    [Console]::OutputEncoding = $prevOutEnc
}

$escapedAutoRevive = $AutoReviveScript.Replace("'", "''")
Write-Host ""
if ($profileProblems -gt 0) {
    Write-Host "herdr-cortex installation complete, except for $profileProblems PowerShell profile(s) (see the warning above)." -ForegroundColor Yellow
} else {
    Write-Host "herdr-cortex installation complete!" -ForegroundColor Cyan
}
Write-Host "Next steps:"
Write-Host "  1. Open a new terminal or run: . '$escapedAutoRevive'"
Write-Host "  2. Restart Claude Code / Antigravity CLI tabs to load the herdr-cortex MCP server and official hooks."
Write-Host "  3. In each project folder that should have memory, run: cortex-trust approve"
Write-Host "  4. Commands available anywhere: cortex-status, cortex-trust, revive-agents, revive-status, revive-agents -DryRun"
