<#
.SYNOPSIS
    Unified herdr-cortex Installer for Windows 11 Herdr GUI (herdr-core / hc):
      - Registers cortex Stdio MCP server for Antigravity CLI and Claude Code
      - Registers official hooks (Antigravity SessionStart/PreInvocation, Claude Code SessionStart/PreCompact/UserPromptSubmit/PreToolUse)
      - Installs cortex skills into ~/.claude/skills/cortex-* (when prompts/skills exists)
      - Initializes ~/.herdr-cortex/ (sessions, docs, config.json)
      - Patches PowerShell $PROFILE with auto-resume + `revive-agents`, `revive-status`, `cortex-status`
#>
param(
    [switch]$NoAutoResume
)

$ErrorActionPreference = "Stop"

$RepoRoot = $PSScriptRoot
$InstallerScript = Join-Path $RepoRoot "src\hooks\installer.mjs"
$AutoReviveScript = Join-Path $RepoRoot "scripts\auto-revive.ps1"

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

# 1. Verify prerequisites (Node.js >= 22.13.0 for node:sqlite, sqlite-vec optional vector search, hc CLI)
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js (node.exe >= 22.13.0) is required but was not found on PATH."
    exit 1
}

$nodeVerRaw = (& node -v 2>$null | Select-Object -First 1)
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

# 2. Register MCP server, official hooks, skills, and ~/.herdr-cortex/ directories
& node --no-warnings $InstallerScript install $RepoRoot
if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to install herdr-cortex hooks and MCP configuration."
    exit 1
}
Write-Host "[OK] Global cortex store ready: $GlobalCortexDir" -ForegroundColor Green

# 3. Ensure PowerShell ExecutionPolicy allows local profile scripts (skip in isolated test mode)
if (-not $TestHome) {
    $cuPolicy = Get-ExecutionPolicy -Scope CurrentUser
    $lmPolicy = Get-ExecutionPolicy -Scope LocalMachine
    $needsPolicy = ($cuPolicy -eq "Restricted") -or ($cuPolicy -eq "Undefined" -and ($lmPolicy -eq "Restricted" -or $lmPolicy -eq "Undefined"))
    if ($needsPolicy) {
        try {
            Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force
            Write-Host "[OK] Set PowerShell ExecutionPolicy (CurrentUser) to RemoteSigned." -ForegroundColor Green
        } catch {
            Write-Warning "PowerShell ExecutionPolicy is Restricted. Run: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned"
        }
    }
}

# 4. Patch PowerShell profile(s) with guarded marker block (migrating legacy herdr-revive block cleanly)
$startMarker = "# >>> herdr-cortex >>>"
$endMarker = "# <<< herdr-cortex <<<"
$legacyStart = "# >>> herdr-revive >>>"
$legacyEnd = "# <<< herdr-revive <<<"

$disableLine = if ($NoAutoResume) { "`$env:HERDR_REVIVE_DISABLE = '1'`r`n" } else { "" }
$escapedAutoRevive = $AutoReviveScript.Replace("'", "''")
$block = @"
$startMarker
${disableLine}if (Test-Path '$escapedAutoRevive') { . '$escapedAutoRevive' }
$endMarker
"@

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

$cortexPattern = "(?s)" + [regex]::Escape($startMarker) + ".*?" + [regex]::Escape($endMarker)
$legacyPattern = "(?s)\r?\n?" + [regex]::Escape($legacyStart) + ".*?" + [regex]::Escape($legacyEnd) + "\r?\n?"
$blockEvaluator = [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $block }
$newlineEvaluator = [System.Text.RegularExpressions.MatchEvaluator]{ param($m) "`r`n" }

foreach ($profPath in ($profileTargets | Select-Object -Unique)) {
    $profDir = Split-Path -Parent $profPath
    if (-not (Test-Path $profDir)) {
        New-Item -ItemType Directory -Force -Path $profDir | Out-Null
    }

    $existing = ""
    if (Test-Path $profPath) {
        $existing = Get-Content -Raw -Path $profPath -Encoding UTF8
        if ($null -eq $existing) { $existing = "" }
    }

    # Remove legacy herdr-revive block if present so profile has no duplicate loader
    if ($existing -match [regex]::Escape($legacyStart)) {
        $existing = [regex]::Replace($existing, $legacyPattern, $newlineEvaluator).Trim()
        if ($existing.Length -gt 0) { $existing += "`r`n" }
    }

    if ($existing -match $cortexPattern) {
        $updated = [regex]::Replace($existing, $cortexPattern, $blockEvaluator)
    } else {
        $sep = if ($existing.Length -gt 0 -and -not $existing.EndsWith("`n")) { "`r`n`r`n" } elseif ($existing.Length -gt 0) { "`r`n" } else { "" }
        $updated = $existing + $sep + $block + "`r`n"
    }

    # Write UTF-8 with BOM so Windows PowerShell 5.1 reads Korean characters cleanly
    [System.IO.File]::WriteAllText($profPath, $updated, (New-Object System.Text.UTF8Encoding($true)))
    Write-Host "[OK] Updated PowerShell profile: $profPath" -ForegroundColor Green
}

Write-Host ""
Write-Host "herdr-cortex installation complete!" -ForegroundColor Cyan
Write-Host "Next steps:"
Write-Host "  1. Open a new terminal or run: . '$escapedAutoRevive'"
Write-Host "  2. Restart Claude Code / Antigravity CLI tabs to load the cortex MCP server and official hooks."
Write-Host "  3. Commands available anywhere: cortex-status, revive-agents, revive-status, revive-agents -DryRun"
