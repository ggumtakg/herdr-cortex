<#
.SYNOPSIS
    Unified herdr-cortex Uninstaller:
      - Removes cortex hooks, MCP entries, and managed skills from Antigravity CLI and Claude Code
        (preserving all pre-existing user entries and .herdr-cortex.bak backups)
      - Cleans herdr-cortex and legacy herdr-revive blocks from PowerShell profiles
      - Optionally purges ~/.herdr-cortex (and legacy ~/.herdr-revive) with -PurgeData
#>
param(
    [switch]$PurgeData,
    [switch]$PurgeSessions
)

$ErrorActionPreference = "Stop"

$RepoRoot = $PSScriptRoot
$InstallerScript = Join-Path $RepoRoot "src\hooks\installer.mjs"

$TestHome = if (-not [string]::IsNullOrWhiteSpace($env:HERDR_CORTEX_TEST_HOME)) {
    $env:HERDR_CORTEX_TEST_HOME
} elseif (-not [string]::IsNullOrWhiteSpace($env:HERDR_REVIVE_TEST_HOME)) {
    $env:HERDR_REVIVE_TEST_HOME
} else {
    $null
}
$EffectiveHome = if ($TestHome) { $TestHome } else { $env:USERPROFILE }

Write-Host "=== herdr-cortex Uninstaller ===" -ForegroundColor Cyan

if (Get-Command node -ErrorAction SilentlyContinue) {
    & node --no-warnings $InstallerScript uninstall $RepoRoot
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Node uninstaller reported a non-zero exit code ($LASTEXITCODE)."
    }
}

$markers = @(
    @{ Start = "# >>> herdr-cortex >>>"; End = "# <<< herdr-cortex <<<" },
    @{ Start = "# >>> herdr-revive >>>"; End = "# <<< herdr-revive <<<" }
)

$docsDir = if ($TestHome) {
    Join-Path $TestHome "Documents"
} else {
    $d = [Environment]::GetFolderPath("MyDocuments")
    if ([string]::IsNullOrWhiteSpace($d)) { Join-Path $env:USERPROFILE "Documents" } else { $d }
}

$profileTargets = @(
    (Join-Path $docsDir "WindowsPowerShell\Microsoft.PowerShell_profile.ps1"),
    (Join-Path $docsDir "PowerShell\Microsoft.PowerShell_profile.ps1")
)
if (-not $TestHome -and -not [string]::IsNullOrWhiteSpace($PROFILE)) {
    $profileTargets += $PROFILE
}
$profileTargets = $profileTargets | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique

foreach ($profPath in $profileTargets) {
    if (-not (Test-Path $profPath)) { continue }
    $existing = Get-Content -Raw -Path $profPath -Encoding UTF8
    if ($null -eq $existing) { continue }

    $updated = $existing
    $changed = $false
    foreach ($m in $markers) {
        if ($updated -match [regex]::Escape($m.Start)) {
            $pattern = "(?s)\r?\n?" + [regex]::Escape($m.Start) + ".*?" + [regex]::Escape($m.End) + "\r?\n?"
            $updated = [regex]::Replace($updated, $pattern, "`r`n")
            $changed = $true
        }
    }

    if ($changed) {
        $updated = $updated.Trim()
        if ($updated.Length -gt 0) { $updated += "`r`n" }
        [System.IO.File]::WriteAllText($profPath, $updated, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "[OK] Cleaned PowerShell profile: $profPath" -ForegroundColor Green
    }
}

if ($PurgeData -or $PurgeSessions) {
    foreach ($dirName in @(".herdr-cortex", ".herdr-revive")) {
        $storeDir = Join-Path $EffectiveHome $dirName
        if (Test-Path $storeDir) {
            Remove-Item -Recurse -Force -Path $storeDir
            Write-Host "[OK] Removed store directory: $storeDir" -ForegroundColor Green
        }
    }
}

Write-Host "herdr-cortex uninstall complete." -ForegroundColor Cyan
