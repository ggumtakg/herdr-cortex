<#
.SYNOPSIS
    Unified herdr-cortex Uninstaller:
      - Removes the herdr-cortex hooks (only entries carrying "--id herdr-cortex"), the MCP entries that start
        this tool, and the managed skills from Claude Code and Antigravity CLI; everything else stays
      - Removes the herdr-cortex block (and the predecessor's herdr-revive block) from the PowerShell profiles,
        keeping each file's encoding
      - Restores the PowerShell ExecutionPolicy when the installer changed it and it was not changed since
      - Lists what is left on the machine
.PARAMETER PurgeData
    Also delete the global store ~/.herdr-cortex (memory documents, saved sessions, config) and the
    predecessor's ~/.herdr-revive folder.
.PARAMETER PurgeSessions
    Same as -PurgeData (kept for compatibility).
.PARAMETER RemoveBackups
    Also delete the backup files this tool created (<file>.herdr-cortex.<stamp>.bak and <file>.herdr-cortex.bak).
.PARAMETER NodePath
    The node.exe to use when `node` is not on PATH (default: PATH, then the path recorded at install time).
#>
param(
    [switch]$PurgeData,
    [switch]$PurgeSessions,
    [switch]$RemoveBackups,
    [string]$NodePath
)

$ErrorActionPreference = "Stop"

$RepoRoot = $PSScriptRoot
$InstallerScript = Join-Path $RepoRoot "src\hooks\installer.mjs"

. (Join-Path $RepoRoot "scripts\install-tools.ps1")
. (Join-Path $RepoRoot "scripts\store-location.ps1")

# Home directory and global store: decided in scripts\store-location.ps1 (the Node installer applies the same order).
$TestHome = Get-HerdrTestHome
$EffectiveHome = Get-HerdrEffectiveHome
$GlobalCortexDir = Get-HerdrCortexGlobalDir
$LegacyStoreDir = Join-Path $EffectiveHome ".herdr-revive"

Write-Host "=== herdr-cortex Uninstaller ===" -ForegroundColor Cyan
if ($TestHome) {
    Write-Host "[TEST] Uninstalling from the test home: $TestHome" -ForegroundColor DarkGray
}

# Node: -NodePath, then PATH, then the path the installer recorded.
$NodeExe = $null
if (-not [string]::IsNullOrWhiteSpace($NodePath) -and (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
    $NodeExe = (Resolve-Path -LiteralPath $NodePath).ProviderPath
}
if (-not $NodeExe) {
    $nodeCmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($nodeCmd) { $NodeExe = $nodeCmd.Source }
}
if (-not $NodeExe) {
    $recordPath = Join-Path $GlobalCortexDir "state\install.json"
    if (Test-Path -LiteralPath $recordPath) {
        try {
            $record = Get-Content -Raw -LiteralPath $recordPath -Encoding UTF8 | ConvertFrom-Json
            if ($record.nodePath -and [System.IO.File]::Exists([string]$record.nodePath)) { $NodeExe = [string]$record.nodePath }
        } catch {}
    }
}

function Invoke-InstallerCommand {
    param([string[]]$Arguments)
    $prevOutEnc = [Console]::OutputEncoding
    try {
        [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
        & $NodeExe --no-warnings $InstallerScript @Arguments
    } finally {
        [Console]::OutputEncoding = $prevOutEnc
    }
}

# 1. Hooks, MCP entries, skills
if ($NodeExe) {
    Invoke-InstallerCommand -Arguments @("uninstall", $RepoRoot)
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "The Node uninstaller reported a problem (exit code $LASTEXITCODE); see the messages above."
    }
} else {
    Write-Warning "node.exe was not found (not on PATH, no -NodePath, no recorded path): hooks, MCP entries and skills were NOT removed."
}

# 2. PowerShell profiles: remove only the marker-delimited blocks, keep the encoding, back up first
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
$profileTargets = @($profileTargets | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)

$backupStamp = Get-HerdrBackupStamp
foreach ($profPath in $profileTargets) {
    $res = Remove-HerdrProfileBlock -ProfilePath $profPath -Stamp $backupStamp
    switch ($res.Status) {
        "removed" {
            Write-Host "[OK] Cleaned PowerShell profile: $profPath (encoding kept: $($res.Encoding))" -ForegroundColor Green
            Write-Host "[OK] Backup: $($res.BackupPath)" -ForegroundColor Green
        }
        "failed" {
            Write-Warning "PowerShell profile NOT changed: $profPath ($($res.Message)). Remove the lines between '# >>> herdr-cortex >>>' and '# <<< herdr-cortex <<<' yourself."
        }
    }
}

# 3. ExecutionPolicy: put back what the installer changed, unless it was changed again since
$policyNote = ""
$policy = Get-HerdrPolicyState -TestHome $TestHome
$policyRecord = Read-HerdrPolicyRecord -GlobalDir $GlobalCortexDir
if (-not $policy) {
    $policyNote = "not looked at (test home)"
} elseif (-not $policyRecord) {
    $policyNote = "CurrentUser=$($policy.CurrentUser); the installer did not change it"
} elseif ($policy.CurrentUser -ne [string]$policyRecord.set) {
    $policyNote = "CurrentUser=$($policy.CurrentUser); the installer had set $($policyRecord.set) (it was $($policyRecord.previous)), but it was changed since, so it was left as it is"
    Remove-Item -LiteralPath (Get-HerdrPolicyRecordPath $GlobalCortexDir) -Force -ErrorAction SilentlyContinue
} else {
    try {
        Set-HerdrCurrentUserPolicy -Value ([string]$policyRecord.previous) -TestHome $TestHome
        Remove-Item -LiteralPath (Get-HerdrPolicyRecordPath $GlobalCortexDir) -Force -ErrorAction SilentlyContinue
        Write-Host "[OK] Restored PowerShell ExecutionPolicy (CurrentUser) to $($policyRecord.previous) (the installer had set $($policyRecord.set))." -ForegroundColor Green
        $policyNote = "CurrentUser=$($policyRecord.previous) (restored)"
    } catch {
        Write-Warning "Could not restore the ExecutionPolicy ($($_.Exception.Message)). Run: Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy $($policyRecord.previous)"
        $policyNote = "CurrentUser=$($policy.CurrentUser); restoring $($policyRecord.previous) failed"
    }
}

# 4. Backups this tool created
$backupArgs = @("backups")
foreach ($profPath in $profileTargets) { $backupArgs += @("--also", $profPath) }
if ($RemoveBackups) {
    if ($NodeExe) {
        Invoke-InstallerCommand -Arguments ($backupArgs + @("--remove"))
    } else {
        Write-Warning "node.exe was not found: the backup files were not removed."
    }
}

# 5. Stored data
$purge = $PurgeData -or $PurgeSessions
if ($purge) {
    foreach ($storeDir in @($GlobalCortexDir, $LegacyStoreDir)) {
        if (Test-Path -LiteralPath $storeDir) {
            Remove-Item -Recurse -Force -LiteralPath $storeDir
            Write-Host "[OK] Removed store directory: $storeDir" -ForegroundColor Green
        }
    }
}

# 6. What is left
Write-Host ""
Write-Host "Left on this machine:" -ForegroundColor Cyan
$remainingBackups = @()
if ($NodeExe) {
    $remainingBackups = @(Invoke-InstallerCommand -Arguments $backupArgs | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}
if ($remainingBackups.Count -gt 0) {
    Write-Host "  - Backup files ($($remainingBackups.Count)); delete them with: .\uninstall.ps1 -RemoveBackups"
    foreach ($backup in $remainingBackups) { Write-Host "      $backup" }
} elseif ($NodeExe) {
    Write-Host "  - Backup files: none"
} else {
    Write-Host "  - Backup files: not listed (node.exe was not found); they are named <file>.herdr-cortex.<date>.bak"
}
if (Test-Path -LiteralPath $GlobalCortexDir) {
    Write-Host "  - Global store: $GlobalCortexDir (memory documents, saved sessions, config.json); delete it with: .\uninstall.ps1 -PurgeData"
} else {
    Write-Host "  - Global store: removed"
}
if (Test-Path -LiteralPath $LegacyStoreDir) {
    Write-Host "  - Store of the predecessor herdr-revive: $LegacyStoreDir; -PurgeData deletes it as well"
}
Write-Host "  - Project memory: the .memory\ folder of each project is your data and is never removed"
Write-Host "  - PowerShell ExecutionPolicy: $policyNote"

Write-Host ""
Write-Host "herdr-cortex uninstall complete." -ForegroundColor Cyan
