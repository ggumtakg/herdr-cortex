<#
.SYNOPSIS
    One-click batch reviver for Antigravity (agy) and Claude Code (claude) terminals in Herdr-Core (hc).
    Reads ~/.herdr-cortex/sessions/ first with automatic fallback to ~/.herdr-revive/sessions/.

    For every live tab that is a bare shell:
      - a saved session id for the tab            -> claude --resume <id> / agy --conversation <id>
      - ... saved in another folder than the tab's -> the tab changes to the saved folder first
        (skipped when that folder no longer exists)
      - no saved id, the tab title names the agent -> claude -c / agy -c
        (skipped when another live tab in the same folder is the same agent: pick with `claude --resume`)
.EXAMPLE
    .\revive-agents.ps1
    .\revive-agents.ps1 -DryRun
    .\revive-agents.ps1 -Status
#>
param(
    [switch]$DryRun,
    [switch]$Status,
    [int]$DelayMs = 300
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "revive-common.ps1")
. (Join-Path $PSScriptRoot "store-location.ps1")

# Home directory and global store: decided in store-location.ps1.
$EffectiveHome = Get-HerdrEffectiveHome
$CortexDir = Get-HerdrCortexGlobalDir

$SessionDirs = @((Join-Path $CortexDir "sessions"), (Join-Path $EffectiveHome ".herdr-revive\sessions"))
$ConfigPaths = @((Join-Path $CortexDir "config.json"), (Join-Path $EffectiveHome ".herdr-revive\config.json"))

$hcCmd = Get-Command hc -ErrorAction SilentlyContinue
if (-not $hcCmd) {
    Write-Error "hc.exe not found on PATH. Make sure Herdr-Core is installed."
    exit 1
}

$prevOutEnc = [Console]::OutputEncoding
$prevEap = $ErrorActionPreference
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

    $ErrorActionPreference = "Continue"
    $lsRaw = & hc ls --json 2>$null
    $lsExit = $LASTEXITCODE
    $ErrorActionPreference = $prevEap

    if ($lsExit -ne 0) {
        Write-Error "Failed to query hc ls --json (exit code $lsExit)."
        exit 1
    }

    $lsText = ($lsRaw -join "`n").Trim()
    if ([string]::IsNullOrWhiteSpace($lsText)) {
        Write-Error "hc ls --json returned empty output."
        exit 1
    }

    $lsData = $lsText | ConvertFrom-Json
    if ($lsData -and $lsData.PSObject.Properties['error'] -and $lsData.error) {
        Write-Error "hc ls --json returned error: $($lsData.error | ConvertTo-Json -Compress)"
        exit 1
    }
    $terminals = if ($lsData -is [System.Array]) { @($lsData) } elseif ($lsData.terminals) { @($lsData.terminals) } else { @() }
    $metas = @($terminals | ForEach-Object { Get-HerdrTerminalMeta $_ })
    $config = Read-HerdrReviveConfig -ConfigPaths $ConfigPaths

    if ($Status) {
        Write-Host "=== Herdr Live Terminals & Saved Sessions ===" -ForegroundColor Cyan
        foreach ($meta in $metas) {
            $saved = Read-HerdrSavedSession -TerminalId $meta.Address -SessionDirs $SessionDirs
            $savedInfo = if ($saved) { "$($saved.agent):$($saved.sessionId)" } else { "(none)" }
            $tag = if (Test-HerdrBareShell $meta.Agent) { "SHELL" } else { "ACTIVE" }
            Write-Host ("[{0,-6}] {1,-5} agent={2,-15} where={3,-32} saved={4}" -f $tag, $meta.Address, $meta.Agent, $meta.Where, $savedInfo)
        }
        exit 0
    }

    $revivedCount = 0
    $activeCount = 0
    $skippedCount = 0

    $plans = @(Resolve-HerdrRevivePlans -Metas $metas -Config $config -SessionDirs $SessionDirs)
    foreach ($plan in $plans) {
        $label = "$($plan.Address) ($($plan.Where))"
        if ($plan.Warning) {
            Write-Host "[NOTE]   $($plan.Address) -> $($plan.Warning)" -ForegroundColor Yellow
        }

        if ($plan.Action -eq "active") {
            Write-Host "[SKIP]   $label -> already running $($plan.ShellName)" -ForegroundColor DarkGray
            $activeCount++
            continue
        }
        if ($plan.Action -eq "ignore") {
            Write-Host "[IGNORE] $label -> regular shell" -ForegroundColor DarkGray
            continue
        }
        if ($plan.Action -eq "skip") {
            Write-Host "[SKIP]   $label -> $($plan.Reason)" -ForegroundColor Yellow
            $skippedCount++
            continue
        }

        $source = if ($plan.ChangeTo) { "$($plan.Source), saved folder" } else { $plan.Source }
        if ($DryRun) {
            Write-Host "[DRYRUN] $label [$source] -> $($plan.Command)" -ForegroundColor Yellow
            $revivedCount++
            continue
        }

        Write-Host "[REVIVE] $label [$source] -> $($plan.Command)" -ForegroundColor Green
        $ErrorActionPreference = "Continue"
        & hc send $plan.Address $plan.Command 2>$null | Out-Null
        $sendExit = $LASTEXITCODE
        $ErrorActionPreference = $prevEap
        if ($sendExit -ne 0) {
            Write-Host "[FAILED] $($plan.Address) -> hc send exited with code $sendExit; nothing was typed into the tab" -ForegroundColor Red
            $skippedCount++
        } else {
            $revivedCount++
        }

        if ($DelayMs -gt 0) {
            Start-Sleep -Milliseconds $DelayMs
        }
    }

    Write-Host ""
    if ($DryRun) {
        Write-Host "Dry run complete: $revivedCount terminal(s) would be revived, $activeCount already active, $skippedCount skipped." -ForegroundColor Cyan
    } else {
        Write-Host "Done: revived $revivedCount terminal(s), $activeCount already active, $skippedCount skipped." -ForegroundColor Cyan
    }
} finally {
    $ErrorActionPreference = $prevEap
    [Console]::OutputEncoding = $prevOutEnc
}
