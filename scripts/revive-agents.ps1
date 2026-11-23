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
$ReservedWinNames = @("con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9")

function Test-ValidTerminalId {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
    $trimmed = $Value.Trim()
    if ($trimmed -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$') { return $false }
    if ($ReservedWinNames -contains $trimmed.ToLowerInvariant()) { return $false }
    return $true
}

function Test-ValidSessionId {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
    $trimmed = $Value.Trim()
    if ($trimmed -notmatch '^[a-zA-Z0-9._-]{1,128}$') { return $false }
    if ($trimmed.Contains("..")) { return $false }
    return $true
}

function Normalize-PathKey {
    param([string]$PathValue)
    if ([string]::IsNullOrWhiteSpace($PathValue)) { return "" }
    return $PathValue.Trim().TrimEnd('\', '/').ToLowerInvariant()
}

function Get-TerminalMeta {
    param($Terminal)

    $addr = if ($Terminal.address) { [string]$Terminal.address } elseif ($Terminal.id) { [string]$Terminal.id } else { "" }
    $agent = if ($Terminal.foreground -and $Terminal.foreground.name) {
        [string]$Terminal.foreground.name
    } elseif ($Terminal.agent) {
        [string]$Terminal.agent
    } else {
        ""
    }
    $cwd = if ($Terminal.foreground -and $Terminal.foreground.cwd) {
        [string]$Terminal.foreground.cwd
    } elseif ($Terminal.cwd) {
        [string]$Terminal.cwd
    } else {
        ""
    }
    $where = if ($Terminal.labels -and $Terminal.labels.where) {
        [string]$Terminal.labels.where
    } elseif ($Terminal.where) {
        [string]$Terminal.where
    } else {
        ""
    }

    return [PSCustomObject]@{
        Address = $addr.Trim()
        State   = [string]$Terminal.state
        Agent   = $agent.Trim()
        Cwd     = $cwd.Trim()
        Where   = $where.Trim()
    }
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
    if (-not (Test-ValidTerminalId $TerminalId)) { return $null }
    $cleanId = $TerminalId.Trim()
    foreach ($dir in @($CortexSessionsDir, $LegacySessionsDir)) {
        $file = Join-Path $dir "$cleanId.json"
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
        $Meta,
        $Config
    )

    $addr = $Meta.Address
    $cwd = $Meta.Cwd
    $where = $Meta.Where
    $saved = Get-SavedSession -TerminalId $addr

    $extraAgy = if ($Config.agyExtraArgs.Count -gt 0) { " " + ($Config.agyExtraArgs -join " ") } else { "" }
    $extraClaude = if ($Config.claudeExtraArgs.Count -gt 0) { " " + ($Config.claudeExtraArgs -join " ") } else { "" }

    # 1. Exact per-terminal session ID recorded by hooks (strictly validated against command injection)
    if ($saved -and $saved.sessionId) {
        $sid = ([string]$saved.sessionId).Trim()
        if (Test-ValidSessionId $sid) {
            $savedCwdNorm = Normalize-PathKey $saved.cwd
            $liveCwdNorm = Normalize-PathKey $cwd
            $cwdMatches = ([string]::IsNullOrEmpty($savedCwdNorm)) -or ($savedCwdNorm -eq $liveCwdNorm)

            if ($cwdMatches) {
                if ($saved.agent -eq "antigravity") {
                    return [PSCustomObject]@{
                        Agent     = "antigravity"
                        Source    = "session-id"
                        SessionId = $sid
                        Command   = "agy --conversation $sid$extraAgy"
                    }
                }
                if ($saved.agent -eq "claude") {
                    return [PSCustomObject]@{
                        Agent     = "claude"
                        Source    = "session-id"
                        SessionId = $sid
                        Command   = "claude --resume $sid$extraClaude"
                    }
                }
            }
        } else {
            Write-Warning "[SKIP]   $addr -> ignored invalid saved sessionId"
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
    $config = Get-ReviveConfig

    if ($Status) {
        Write-Host "=== Herdr Live Terminals & Saved Sessions ===" -ForegroundColor Cyan
        foreach ($t in $terminals) {
            $meta = Get-TerminalMeta $t
            $saved = Get-SavedSession -TerminalId $meta.Address
            $savedInfo = if ($saved) { "$($saved.agent):$($saved.sessionId)" } else { "(none)" }
            $isShell = $BareShells -contains $meta.Agent.ToLowerInvariant()
            $tag = if ($isShell) { "SHELL" } else { "ACTIVE" }
            Write-Host ("[{0,-6}] {1,-5} agent={2,-15} where={3,-32} saved={4}" -f $tag, $meta.Address, $meta.Agent, $meta.Where, $savedInfo)
        }
        exit 0
    }

    $revivedCount = 0
    $skippedCount = 0

    foreach ($t in $terminals) {
        $meta = Get-TerminalMeta $t
        if ($meta.State -ne "live") { continue }
        if (-not (Test-ValidTerminalId $meta.Address)) {
            Write-Warning "[SKIP]   invalid terminalId '$($meta.Address)'"
            continue
        }

        $agentLower = $meta.Agent.ToLowerInvariant()
        if ($BareShells -notcontains $agentLower) {
            Write-Host "[SKIP]   $($meta.Address) ($($meta.Where)) -> already running $($meta.Agent)" -ForegroundColor DarkGray
            $skippedCount++
            continue
        }

        $plan = Resolve-RevivePlan -Meta $meta -Config $config
        if (-not $plan) {
            Write-Host "[IGNORE] $($meta.Address) ($($meta.Where)) -> regular shell" -ForegroundColor DarkGray
            continue
        }

        if ($DryRun) {
            Write-Host "[DRYRUN] $($meta.Address) ($($meta.Where)) [$($plan.Source)] -> $($plan.Command)" -ForegroundColor Yellow
            $revivedCount++
            continue
        }

        Write-Host "[REVIVE] $($meta.Address) ($($meta.Where)) [$($plan.Source)] -> $($plan.Command)" -ForegroundColor Green
        $ErrorActionPreference = "Continue"
        & hc send $meta.Address $plan.Command 2>$null | Out-Null
        $ErrorActionPreference = $prevEap
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
} finally {
    $ErrorActionPreference = $prevEap
    [Console]::OutputEncoding = $prevOutEnc
}
