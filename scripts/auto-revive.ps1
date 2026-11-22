<#
.SYNOPSIS
    Loaded by PowerShell $PROFILE.
    1) Exposes `revive-agents`, `revive-agy`, `revive-status`, and `cortex-status` commands.
    2) Automatically resumes Antigravity (agy) or Claude Code (claude) when Herdr-Core
       reopens a saved agent tab as a bare PowerShell after a reboot or core restart.
       Reads ~/.herdr-cortex/sessions/ first with automatic fallback to ~/.herdr-revive/sessions/.
#>

$script:HerdrCortexRoot = Split-Path -Parent $PSScriptRoot
$script:HerdrReviveScript = Join-Path $PSScriptRoot "revive-agents.ps1"

function script:Get-HerdrEffectiveHome {
    if (-not [string]::IsNullOrWhiteSpace($env:HERDR_CORTEX_TEST_HOME)) { return $env:HERDR_CORTEX_TEST_HOME }
    if (-not [string]::IsNullOrWhiteSpace($env:HERDR_REVIVE_TEST_HOME)) { return $env:HERDR_REVIVE_TEST_HOME }
    return $env:USERPROFILE
}

$script:HerdrHome = Get-HerdrEffectiveHome
$script:HerdrCortexDir = if (-not [string]::IsNullOrWhiteSpace($env:HERDR_CORTEX_HOME)) {
    $env:HERDR_CORTEX_HOME
} else {
    Join-Path $script:HerdrHome ".herdr-cortex"
}
$script:HerdrCortexSessionsDir = Join-Path $script:HerdrCortexDir "sessions"
$script:HerdrCortexConfigPath = Join-Path $script:HerdrCortexDir "config.json"
$script:HerdrLegacySessionsDir = Join-Path $script:HerdrHome ".herdr-revive\sessions"
$script:HerdrLegacyConfigPath = Join-Path $script:HerdrHome ".herdr-revive\config.json"

function global:revive-agents {
    param(
        [switch]$DryRun,
        [switch]$Status,
        [int]$DelayMs = 300
    )
    & $script:HerdrReviveScript -DryRun:$DryRun -Status:$Status -DelayMs $DelayMs
}

function global:revive-agy {
    param(
        [switch]$DryRun,
        [switch]$Status,
        [int]$DelayMs = 300
    )
    & $script:HerdrReviveScript -DryRun:$DryRun -Status:$Status -DelayMs $DelayMs
}

function global:revive-status {
    & $script:HerdrReviveScript -Status
}

function global:cortex-status {
    Write-Host "=== herdr-cortex Status ===" -ForegroundColor Cyan
    Write-Host ("Repo Root     : {0}" -f $script:HerdrCortexRoot)
    Write-Host ("Global Store  : {0} (exists={1})" -f $script:HerdrCortexDir, (Test-Path $script:HerdrCortexDir))

    $cfgPath = $script:HerdrCortexConfigPath
    if (Test-Path $cfgPath) {
        try {
            $cfg = Get-Content -Raw -Path $cfgPath -Encoding UTF8 | ConvertFrom-Json
            $embedProv = if ($cfg.embedding -and $cfg.embedding.provider) { $cfg.embedding.provider } else { "auto" }
            Write-Host ("Config        : headCoreEnabled={0}, hookBudget={1}, embedding={2}" -f $cfg.headCoreEnabled, $cfg.hookBudget, $embedProv)
        } catch {
            Write-Host ("Config        : {0} (parse error)" -f $cfgPath) -ForegroundColor Yellow
        }
    } else {
        Write-Host "Config        : (default)"
    }

    $cortexSessions = if (Test-Path $script:HerdrCortexSessionsDir) {
        @(Get-ChildItem -Path $script:HerdrCortexSessionsDir -Filter "*.json" -File -ErrorAction SilentlyContinue).Count
    } else { 0 }
    $legacySessions = if (Test-Path $script:HerdrLegacySessionsDir) {
        @(Get-ChildItem -Path $script:HerdrLegacySessionsDir -Filter "*.json" -File -ErrorAction SilentlyContinue).Count
    } else { 0 }
    Write-Host ("Saved Sessions: cortex={0}, legacy={1}" -f $cortexSessions, $legacySessions)

    $projMemDir = Join-Path (Get-Location).Path ".memory"
    if (Test-Path $projMemDir) {
        $docCount = @(Get-ChildItem -Path (Join-Path $projMemDir "docs") -Filter "*.md" -Recurse -File -ErrorAction SilentlyContinue).Count
        $hasDb = Test-Path (Join-Path $projMemDir "index.sqlite")
        Write-Host ("Project Memory: {0} (docs={1}, sqlite={2})" -f $projMemDir, $docCount, $hasDb) -ForegroundColor Green
    } else {
        Write-Host ("Project Memory: none in {0}" -f (Get-Location).Path) -ForegroundColor DarkGray
    }

    if (-not [string]::IsNullOrWhiteSpace($env:HC_TERMINAL_ID)) {
        Write-Host ("HC_TERMINAL_ID: {0}" -f $env:HC_TERMINAL_ID)
    }

    if (Get-Command hc -ErrorAction SilentlyContinue) {
        Write-Host ""
        & $script:HerdrReviveScript -Status
    }
}

function script:Normalize-HerdrPath {
    param([string]$PathValue)
    if ([string]::IsNullOrWhiteSpace($PathValue)) { return "" }
    return $PathValue.Trim().TrimEnd('\', '/').ToLowerInvariant()
}

function script:Read-SavedHerdrSession {
    param([string]$TerminalId)
    foreach ($dir in @($script:HerdrCortexSessionsDir, $script:HerdrLegacySessionsDir)) {
        $file = Join-Path $dir "$TerminalId.json"
        if (Test-Path $file) {
            try {
                return Get-Content -Raw -Path $file -Encoding UTF8 | ConvertFrom-Json
            } catch {}
        }
    }
    return $null
}

function script:Invoke-HerdrAutoRevive {
    # Safety guards: only run once per interactive top-level PowerShell inside Herdr-Core
    if ($global:HerdrReviveAttempted) { return }
    $global:HerdrReviveAttempted = $true

    if ([string]::IsNullOrWhiteSpace($env:HC_TERMINAL_ID)) { return }
    if ($env:HERDR_REVIVE_DISABLE -eq "1") { return }
    if ($env:HERDR_REVIVE_IN_AGENT -eq "1") { return }
    if (-not [string]::IsNullOrWhiteSpace($env:CLAUDECODE)) { return }
    if ($Host.Name -ne "ConsoleHost") { return }
    if (-not [Environment]::UserInteractive) { return }
    try {
        if ([Console]::IsInputRedirected) { return }
    } catch { return }

    $cmdArgs = [Environment]::GetCommandLineArgs()
    $hasNoExit = $false
    $hasOneShotArg = $false
    foreach ($arg in $cmdArgs) {
        if ($arg -match '^(?i)-noe(xit)?$') {
            $hasNoExit = $true
        } elseif ($arg -match '^(?i)-(c|command|f|file|e|ec|encodedcommand)$') {
            $hasOneShotArg = $true
        }
    }
    # Herdr-Core spawns interactive panes with `-NoExit -Command "$global:__hc_prompt = ..."`.
    # Only skip when a one-shot command/file is invoked WITHOUT -NoExit.
    if ($hasOneShotArg -and -not $hasNoExit) {
        return
    }

    $terminalId = $env:HC_TERMINAL_ID.Trim()
    $bareShells = @("powershell.exe", "pwsh.exe", "cmd.exe", "bash.exe", "nu.exe", "powershell", "pwsh", "cmd")

    # Load optional extra args config (cortex first, legacy fallback)
    $agyExtra = @()
    $claudeExtra = @()
    foreach ($cfgPath in @($script:HerdrCortexConfigPath, $script:HerdrLegacyConfigPath)) {
        if (Test-Path $cfgPath) {
            try {
                $cfg = Get-Content -Raw -Path $cfgPath -Encoding UTF8 | ConvertFrom-Json
                if ($cfg.agyExtraArgs -and $agyExtra.Count -eq 0) { $agyExtra = @($cfg.agyExtraArgs) }
                if ($cfg.claudeExtraArgs -and $claudeExtra.Count -eq 0) { $claudeExtra = @($cfg.claudeExtraArgs) }
            } catch {}
        }
    }

    # Check live terminal metadata from hc
    $liveTerm = $null
    for ($attempt = 0; $attempt -lt 3; $attempt++) {
        try {
            $hcRaw = & hc get $terminalId --json 2>$null
            $hcText = ($hcRaw -join "`n").Trim()
            if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($hcText)) {
                $liveTerm = $hcText | ConvertFrom-Json
                break
            }
        } catch {}
        Start-Sleep -Milliseconds 300
    }

    $liveAgentName = $null
    $liveWhere = $null
    if ($liveTerm) {
        if ($liveTerm.foreground -and $liveTerm.foreground.name) {
            $liveAgentName = [string]$liveTerm.foreground.name
        } elseif ($liveTerm.agent) {
            $liveAgentName = [string]$liveTerm.agent
        }

        if ($liveTerm.labels -and $liveTerm.labels.where) {
            $liveWhere = [string]$liveTerm.labels.where
        } elseif ($liveTerm.where) {
            $liveWhere = [string]$liveTerm.where
        }
    }

    if ($liveAgentName) {
        $agentLower = $liveAgentName.ToLowerInvariant()
        if ($bareShells -notcontains $agentLower) {
            return
        }
    }

    # 1) Prefer exact saved session ID for this HC_TERMINAL_ID (cortex first, legacy fallback)
    $targetAgent = $null
    $targetArgs = @()
    $displayDetail = ""

    $saved = Read-SavedHerdrSession -TerminalId $terminalId
    if ($saved -and $saved.sessionId) {
        $savedCwd = Normalize-HerdrPath $saved.cwd
        $currCwd = Normalize-HerdrPath (Get-Location).Path
        $cwdMatches = ([string]::IsNullOrEmpty($savedCwd)) -or ($savedCwd -eq $currCwd)

        if ($cwdMatches) {
            if ($saved.agent -eq "antigravity") {
                $targetAgent = "agy"
                $targetArgs = @("--conversation", [string]$saved.sessionId) + $agyExtra
                $displayDetail = "antigravity ($($saved.sessionId))"
            } elseif ($saved.agent -eq "claude") {
                $targetAgent = "claude"
                $targetArgs = @("--resume", [string]$saved.sessionId) + $claudeExtra
                $displayDetail = "claude ($($saved.sessionId))"
            }
        }
    }

    # 2) Fallback: check Herdr tab title ("... / Antigravity" or "... / Claude")
    if (-not $targetAgent -and $liveWhere) {
        if ($liveWhere -match '(?i)/\s*Antigravity\b') {
            $targetAgent = "agy"
            $targetArgs = @("-c") + $agyExtra
            $displayDetail = "antigravity (latest via -c)"
        } elseif ($liveWhere -match '(?i)/\s*Claude(\s+Code)?\b') {
            $targetAgent = "claude"
            $targetArgs = @("-c") + $claudeExtra
            $displayDetail = "claude (latest via -c)"
        }
    }

    if (-not $targetAgent) { return }
    if (-not (Get-Command $targetAgent -ErrorAction SilentlyContinue)) { return }

    # Small deterministic stagger per terminal ID so multiple panes don't spike CPU simultaneously
    $hashSum = 0
    foreach ($ch in $terminalId.ToCharArray()) { $hashSum += [int]$ch }
    $staggerMs = (($hashSum % 5) * 200) + 150

    Write-Host "[herdr-cortex] Restoring $displayDetail in $terminalId... (Ctrl+C to cancel)" -ForegroundColor Cyan
    Start-Sleep -Milliseconds $staggerMs

    $env:HERDR_REVIVE_IN_AGENT = "1"
    try {
        & $targetAgent @targetArgs
    } finally {
        Remove-Item Env:HERDR_REVIVE_IN_AGENT -ErrorAction SilentlyContinue
    }
}

Invoke-HerdrAutoRevive
