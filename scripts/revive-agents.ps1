<#
.SYNOPSIS
    One-click batch reviver for Antigravity (agy) and Claude Code (claude) terminals in Herdr-Core (hc).
    Reads ~/.herdr-cortex/sessions/ first with automatic fallback to ~/.herdr-revive/sessions/.
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

$EffectiveHome = if (-not [string]::IsNullOrWhiteSpace($env:HERDR_CORTEX_TEST_HOME)) {
    $env:HERDR_CORTEX_TEST_HOME
} elseif (-not [string]::IsNullOrWhiteSpace($env:HERDR_REVIVE_TEST_HOME)) {
    $env:HERDR_REVIVE_TEST_HOME
} else {
    $env:USERPROFILE
}

$CortexDir = if (-not [string]::IsNullOrWhiteSpace($env:HERDR_CORTEX_HOME)) {
    $env:HERDR_CORTEX_HOME
} else {
    Join-Path $EffectiveHome ".herdr-cortex"
}

$CortexSessionsDir = Join-Path $CortexDir "sessions"
$LegacySessionsDir = Join-Path $EffectiveHome ".herdr-revive\sessions"
$CortexConfigPath = Join-Path $CortexDir "config.json"
$LegacyConfigPath = Join-Path $EffectiveHome ".herdr-revive\config.json"
$BareShells = @("powershell.exe", "pwsh.exe", "cmd.exe", "bash.exe", "nu.exe", "powershell", "pwsh", "cmd")

function Normalize-PathKey {
    param([string]$PathValue)
    if ([string]::IsNullOrWhiteSpace($PathValue)) { return "" }
    return $PathValue.Trim().TrimEnd('\', '/').ToLowerInvariant()
}

function Get-ReviveConfig {
    $defaults = @{
        agyExtraArgs    = @()
        claudeExtraArgs = @()
    }
    foreach ($cfgPath in @($CortexConfigPath, $LegacyConfigPath)) {
        if (Test-Path $cfgPath) {
            try {
                $parsed = Get-Content -Raw -Path $cfgPath -Encoding UTF8 | ConvertFrom-Json
                if ($parsed.agyExtraArgs -and $defaults.agyExtraArgs.Count -eq 0) { $defaults.agyExtraArgs = @($parsed.agyExtraArgs) }
                if ($parsed.claudeExtraArgs -and $defaults.claudeExtraArgs.Count -eq 0) { $defaults.claudeExtraArgs = @($parsed.claudeExtraArgs) }
            } catch {
                # Ignore invalid config and use defaults
            }
        }
    }
    return $defaults
}

function Get-SavedSession {
    param([string]$TerminalId)
    if ([string]::IsNullOrWhiteSpace($TerminalId)) { return $null }
    foreach ($dir in @($CortexSessionsDir, $LegacySessionsDir)) {
        $file = Join-Path $dir "$TerminalId.json"
        if (Test-Path $file) {
            try {
                return Get-Content -Raw -Path $file -Encoding UTF8 | ConvertFrom-Json
            } catch {
                # Fall through to next candidate
            }
        }
    }
    return $null
}

function Resolve-RevivePlan {
    param(
        $Terminal,
        $Config
    )

    $addr = [string]$Terminal.address
    $cwd = [string]$Terminal.cwd
    $where = [string]$Terminal.where
    $saved = Get-SavedSession -TerminalId $addr

    $extraAgy = if ($Config.agyExtraArgs.Count -gt 0) { " " + ($Config.agyExtraArgs -join " ") } else { "" }
    $extraClaude = if ($Config.claudeExtraArgs.Count -gt 0) { " " + ($Config.claudeExtraArgs -join " ") } else { "" }

    # 1. Exact per-terminal session ID recorded by hooks
    if ($saved -and $saved.sessionId) {
        $savedCwdNorm = Normalize-PathKey $saved.cwd
        $liveCwdNorm = Normalize-PathKey $cwd
        $cwdMatches = ([string]::IsNullOrEmpty($savedCwdNorm)) -or ($savedCwdNorm -eq $liveCwdNorm)

        if ($cwdMatches) {
            if ($saved.agent -eq "antigravity") {
                return [PSCustomObject]@{
                    Agent     = "antigravity"
                    Source    = "session-id"
                    SessionId = $saved.sessionId
                    Command   = "agy --conversation $($saved.sessionId)$extraAgy"
                }
            }
            if ($saved.agent -eq "claude") {
                return [PSCustomObject]@{
                    Agent     = "claude"
                    Source    = "session-id"
                    SessionId = $saved.sessionId
                    Command   = "claude --resume $($saved.sessionId)$extraClaude"
                }
            }
        }
    }

    # 2. Fallback to Herdr tab title ("... / Antigravity" or "... / Claude")
    if ($where -match '(?i)/\s*Antigravity\b') {
        return [PSCustomObject]@{
            Agent     = "antigravity"
            Source    = "tab-title"
            SessionId = $null
            Command   = "agy -c$extraAgy"
        }
    }
    if ($where -match '(?i)/\s*Claude(\s+Code)?\b') {
        return [PSCustomObject]@{
            Agent     = "claude"
            Source    = "tab-title"
            SessionId = $null
            Command   = "claude -c$extraClaude"
        }
    }

    return $null
}

$hcCmd = Get-Command hc -ErrorAction SilentlyContinue
if (-not $hcCmd) {
    Write-Error "hc.exe not found on PATH. Make sure Herdr-Core is installed."
    exit 1
}

$lsRaw = & hc ls --json 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to query hc ls --json: $lsRaw"
    exit 1
}

$lsData = $lsRaw | ConvertFrom-Json
$terminals = @($lsData.terminals)
$config = Get-ReviveConfig

if ($Status) {
    Write-Host "=== Herdr Live Terminals & Saved Sessions ===" -ForegroundColor Cyan
    foreach ($t in $terminals) {
        $saved = Get-SavedSession -TerminalId $t.address
        $savedInfo = if ($saved) { "$($saved.agent):$($saved.sessionId)" } else { "(none)" }
        $isShell = $BareShells -contains ([string]$t.agent).ToLowerInvariant()
        $tag = if ($isShell) { "SHELL" } else { "ACTIVE" }
        Write-Host ("[{0,-6}] {1,-5} agent={2,-15} where={3,-32} saved={4}" -f $tag, $t.address, $t.agent, $t.where, $savedInfo)
    }
    exit 0
}

$revivedCount = 0
$skippedCount = 0

foreach ($t in $terminals) {
    if ($t.state -ne "live") { continue }

    $agentLower = ([string]$t.agent).ToLowerInvariant()
    if ($BareShells -notcontains $agentLower) {
        Write-Host "[SKIP]   $($t.address) ($($t.where)) -> already running $($t.agent)" -ForegroundColor DarkGray
        $skippedCount++
        continue
    }

    $plan = Resolve-RevivePlan -Terminal $t -Config $config
    if (-not $plan) {
        Write-Host "[IGNORE] $($t.address) ($($t.where)) -> regular shell" -ForegroundColor DarkGray
        continue
    }

    if ($DryRun) {
        Write-Host "[DRYRUN] $($t.address) ($($t.where)) [$($plan.Source)] -> $($plan.Command)" -ForegroundColor Yellow
        $revivedCount++
        continue
    }

    Write-Host "[REVIVE] $($t.address) ($($t.where)) [$($plan.Source)] -> $($plan.Command)" -ForegroundColor Green
    & hc send $t.address $plan.Command | Out-Null
    $revivedCount++

    if ($DelayMs -gt 0) {
        Start-Sleep -Milliseconds $DelayMs
    }
}

Write-Host ""
if ($DryRun) {
    Write-Host "Dry run complete: $revivedCount terminal(s) would be revived, $skippedCount already active." -ForegroundColor Cyan
} else {
    Write-Host "Done: revived $revivedCount terminal(s), $skippedCount already active." -ForegroundColor Cyan
}
