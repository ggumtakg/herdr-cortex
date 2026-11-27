<#
.SYNOPSIS
    Loaded by PowerShell $PROFILE.
    1) Exposes the `revive-agents`, `revive-agy`, `revive-status`, `cortex-status`, `cortex-trust`, `cortex-work` and `cortex-worker` commands.
    2) Automatically resumes Antigravity (agy) or Claude Code (claude) when Herdr-Core
       reopens a saved agent tab as a bare PowerShell after a reboot or core restart.
       Reads ~/.herdr-cortex/sessions/ first with automatic fallback to ~/.herdr-revive/sessions/.
#>

$script:HerdrCortexRoot = Split-Path -Parent $PSScriptRoot
$script:HerdrReviveScript = Join-Path $PSScriptRoot "revive-agents.ps1"
$script:HerdrStatusScript = Join-Path $PSScriptRoot "cortex-status.mjs"
$script:HerdrWorkScript = Join-Path $PSScriptRoot "cortex-work.mjs"
$script:HerdrWorkerScript = Join-Path $PSScriptRoot "cortex-worker.mjs"
$script:HerdrTrustScript = Join-Path $script:HerdrCortexRoot "src\core\trust-cli.mjs"

. (Join-Path $PSScriptRoot "revive-common.ps1")
. (Join-Path $PSScriptRoot "store-location.ps1")

# Home directory and global store: decided in store-location.ps1.
$script:HerdrHome = Get-HerdrEffectiveHome
$script:HerdrCortexDir = Get-HerdrCortexGlobalDir
$script:HerdrCortexSessionsDir = Join-Path $script:HerdrCortexDir "sessions"
$script:HerdrCortexConfigPath = Join-Path $script:HerdrCortexDir "config.json"
$script:HerdrLegacySessionsDir = Join-Path $script:HerdrHome ".herdr-revive\sessions"
$script:HerdrLegacyConfigPath = Join-Path $script:HerdrHome ".herdr-revive\config.json"

# The Node path the installer recorded (<global store>\state\install.json): @{ Path; Exists }.
# Hooks and the MCP server are started with this path, so the shell commands use it as well.
function script:Get-HerdrRecordedNode {
    $result = @{ Path = ""; Exists = $false }
    $dirs = @($script:HerdrCortexDir, (Join-Path $script:HerdrHome ".herdr-cortex")) | Select-Object -Unique
    foreach ($dir in $dirs) {
        $recordPath = Join-Path $dir "state\install.json"
        if (-not (Test-Path -LiteralPath $recordPath)) { continue }
        try {
            $record = Get-Content -Raw -LiteralPath $recordPath -Encoding UTF8 | ConvertFrom-Json
            if ($record.nodePath) {
                $result.Path = [string]$record.nodePath
                $result.Exists = [System.IO.File]::Exists($result.Path)
                return $result
            }
        } catch {}
    }
    return $result
}

# The Node executable to run: the recorded one when it exists, otherwise `node` from PATH, otherwise $null.
function script:Resolve-HerdrNode {
    $recorded = Get-HerdrRecordedNode
    if ($recorded.Exists) { return $recorded.Path }
    $onPath = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($onPath) { return $onPath.Source }
    return $null
}

function script:Write-HerdrNodeMissing {
    $recorded = Get-HerdrRecordedNode
    if ($recorded.Path) {
        Write-Host ("Node          : the path recorded at install time does not exist: {0}" -f $recorded.Path) -ForegroundColor Red
    } else {
        Write-Host "Node          : no install record, and node.exe is not on PATH" -ForegroundColor Red
    }
    Write-Host "                Hooks and the MCP server cannot start. Install Node.js >= 22.13, then run install.ps1 again." -ForegroundColor Red
}

# Run a Node script of this repository with the given arguments, printing its output as UTF-8.
function script:Invoke-HerdrNodeScript {
    param(
        [string]$NodePath,
        [string]$ScriptPath,
        [object[]]$Arguments = @()
    )
    $prevOutEnc = [Console]::OutputEncoding
    try {
        [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
        & $NodePath --no-warnings $ScriptPath @Arguments
    } finally {
        [Console]::OutputEncoding = $prevOutEnc
    }
}

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

# cortex-trust approve|revoke|status|list|acknowledge [folder] [--json]
# Approves a project folder for herdr-cortex (default: the current location of this shell). "approve" and
# "acknowledge" show a confirmation dialog first; only its Yes button confirms.
function global:cortex-trust {
    $node = Resolve-HerdrNode
    if (-not $node) {
        Write-HerdrNodeMissing
        return
    }
    # The approval list lives in the global store this shell uses (also in test-home mode); a --global given
    # by the caller comes later on the command line and wins.
    $trustArgs = @("--global", $script:HerdrCortexDir) + $args
    # The CLI takes npm's INIT_CWD as the default folder when it is started by `npm run trust`. A shell that
    # was itself started from an npm script still carries that variable: hide it, so that the default
    # folder is this shell's current location.
    $prevLifecycle = $env:npm_lifecycle_event
    try {
        Remove-Item Env:npm_lifecycle_event -ErrorAction SilentlyContinue
        Invoke-HerdrNodeScript -NodePath $node -ScriptPath $script:HerdrTrustScript -Arguments $trustArgs
    } finally {
        if ($null -ne $prevLifecycle) { $env:npm_lifecycle_event = $prevLifecycle }
    }
}

function global:cortex-status {
    $node = Resolve-HerdrNode
    if (-not $node) {
        Write-Host "=== herdr-cortex status ===" -ForegroundColor Cyan
        Write-Host ("Repo          : {0}" -f $script:HerdrCortexRoot)
        Write-Host ("Global store  : {0} (exists={1})" -f $script:HerdrCortexDir, (Test-Path -LiteralPath $script:HerdrCortexDir))
        Write-HerdrNodeMissing
    } else {
        try {
            # Node path, hook and MCP registration, approval, embedding, index, relay inbox, configuration
            Invoke-HerdrNodeScript -NodePath $node -ScriptPath $script:HerdrStatusScript -Arguments @("--cwd", (Get-Location).Path)
        } catch {
            Write-Host ("Diagnostics   : failed ({0})" -f $_.Exception.Message) -ForegroundColor Yellow
        }
    }

    $cortexSessions = if (Test-Path -LiteralPath $script:HerdrCortexSessionsDir) {
        @(Get-ChildItem -LiteralPath $script:HerdrCortexSessionsDir -Filter "*.json" -File -ErrorAction SilentlyContinue).Count
    } else { 0 }
    $legacySessions = if (Test-Path -LiteralPath $script:HerdrLegacySessionsDir) {
        @(Get-ChildItem -LiteralPath $script:HerdrLegacySessionsDir -Filter "*.json" -File -ErrorAction SilentlyContinue).Count
    } else { 0 }
    Write-Host ("Saved sessions: cortex={0}, legacy={1}" -f $cortexSessions, $legacySessions)

    if (Get-Command hc -ErrorAction SilentlyContinue) {
        Write-Host ""
        try {
            & $script:HerdrReviveScript -Status
        } catch {
            Write-Host ("Herdr CLI     : unavailable ({0})" -f $_.Exception.Message) -ForegroundColor DarkGray
        }
    }
}

# cortex-work status|release|reset [--tab <id>] [--all] [--json]
function global:cortex-work {
    $node = Resolve-HerdrNode
    if (-not $node) {
        Write-HerdrNodeMissing
        $global:LASTEXITCODE = 1
        return
    }
    $workArgs = @("--global", $script:HerdrCortexDir) + $args
    $loc = Get-Location
    $prevCwd = [System.Environment]::CurrentDirectory
    try {
        if ($loc.Provider.Name -eq "FileSystem") {
            [System.Environment]::CurrentDirectory = $loc.ProviderPath
        }
        Invoke-HerdrNodeScript -NodePath $node -ScriptPath $script:HerdrWorkScript -Arguments $workArgs
    } finally {
        try { [System.Environment]::CurrentDirectory = $prevCwd } catch {}
    }
}

# cortex-worker --role <developer|coder|reviewer|researcher> --agent <antigravity|claude> --model <name> --brief <file> [--out <file>] [--timeout <minutes>] [--allow <rule>]... [--cwd <folder>]
function global:cortex-worker {
    $node = Resolve-HerdrNode
    if (-not $node) {
        Write-HerdrNodeMissing
        $global:LASTEXITCODE = 1
        return
    }
    $loc = Get-Location
    $prevCwd = [System.Environment]::CurrentDirectory
    try {
        if ($loc.Provider.Name -eq "FileSystem") {
            [System.Environment]::CurrentDirectory = $loc.ProviderPath
        }
        Invoke-HerdrNodeScript -NodePath $node -ScriptPath $script:HerdrWorkerScript -Arguments $args
    } finally {
        try { [System.Environment]::CurrentDirectory = $prevCwd } catch {}
    }
}

# `hc <arguments> --json` parsed, or $null. Never throws.
function script:Invoke-HerdrHcJson {
    param(
        [string[]]$Arguments,
        [int]$Attempts = 1
    )
    if (-not (Get-Command hc -ErrorAction SilentlyContinue)) { return $null }
    $prevOutEnc = [Console]::OutputEncoding
    try {
        [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
        for ($attempt = 0; $attempt -lt $Attempts; $attempt++) {
            try {
                $raw = & hc @Arguments --json 2>$null
                $text = ($raw -join "`n").Trim()
                if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($text)) {
                    $parsed = $text | ConvertFrom-Json
                    if (-not ($parsed.PSObject.Properties['error'] -and $parsed.error)) { return $parsed }
                }
            } catch {}
            if ($attempt -lt ($Attempts - 1)) { Start-Sleep -Milliseconds 300 }
        }
    } finally {
        [Console]::OutputEncoding = $prevOutEnc
    }
    return $null
}

<#
    What this tab should do when its shell starts: a plan object of Resolve-HerdrRevivePlans
    (Action 'revive' with Exe / Arguments / ChangeTo, or 'skip' with Reason), or $null when there is
    nothing to restore. $CurrentCwd is the folder this shell starts in.
#>
function script:Get-HerdrAutoRevivePlan {
    param(
        [string]$TerminalId,
        [string]$CurrentCwd
    )
    if (-not (Test-HerdrTerminalId $TerminalId)) { return $null }
    $cleanId = $TerminalId.Trim()
    $sessionDirs = @($script:HerdrCortexSessionsDir, $script:HerdrLegacySessionsDir)
    $config = Read-HerdrReviveConfig -ConfigPaths @($script:HerdrCortexConfigPath, $script:HerdrLegacyConfigPath)

    # Live metadata of this tab from hc (only if hc is on PATH)
    $own = [PSCustomObject]@{ Address = $cleanId; State = "live"; Agent = ""; Cwd = $CurrentCwd; Where = "" }
    $liveTerm = Invoke-HerdrHcJson -Arguments @("get", $cleanId) -Attempts 3
    if ($liveTerm) {
        $liveMeta = Get-HerdrTerminalMeta $liveTerm
        $own.Agent = $liveMeta.Agent
        $own.Where = $liveMeta.Where
    }
    # This shell just ran `hc get <id> --json` inside this tab, so Herdr's foreground sampler can
    # report our own hc.exe subprocess. Treat hc/hc.exe as this bare shell rather than another app.
    if ($own.Agent -match '^(?i)hc(\.exe)?$') {
        $own.Agent = ""
    }
    # hc reports another program in this tab: leave it alone.
    if ($own.Agent -and -not (Test-HerdrBareShell $own.Agent)) { return $null }
    # This code runs inside PowerShell, whatever hc could tell.
    if (-not $own.Agent) { $own.Agent = "powershell.exe" }

    $plan = @(Resolve-HerdrRevivePlans -Metas @($own) -Config $config -SessionDirs $sessionDirs)[0]
    if (-not $plan -or $plan.Action -eq "ignore" -or $plan.Action -eq "active") { return $null }

    if ($plan.Action -eq "revive" -and $plan.Source -eq "tab-title") {
        # `-c` is only safe when no other tab in this folder is the same agent: look at the other tabs.
        $lsData = Invoke-HerdrHcJson -Arguments @("ls")
        if (-not $lsData) {
            $plan.Action = "skip"
            $plan.Reason = "'$($plan.Exe) -c' not used: the other tabs could not be listed (hc ls failed), so it is unknown whether another tab shares this folder"
            return $plan
        }
        $rows = if ($lsData -is [System.Array]) { @($lsData) } elseif ($lsData.terminals) { @($lsData.terminals) } else { @() }
        $others = @($rows | ForEach-Object { Get-HerdrTerminalMeta $_ } | Where-Object { $_.Address -ne $cleanId })
        $all = @($own) + $others
        $plan = @(Resolve-HerdrRevivePlans -Metas $all -Config $config -SessionDirs $sessionDirs | Where-Object { $_.Address -eq $cleanId })[0]
    }
    return $plan
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
    if (-not (Test-HerdrTerminalId $terminalId)) { return }

    $plan = Get-HerdrAutoRevivePlan -TerminalId $terminalId -CurrentCwd (Get-Location).Path
    if (-not $plan) { return }
    if ($plan.Warning) {
        Write-Host "[herdr-cortex] ${terminalId}: $($plan.Warning)" -ForegroundColor DarkYellow
    }
    if ($plan.Action -eq "skip") {
        Write-Host "[herdr-cortex] Not restoring ${terminalId}: $($plan.Reason)" -ForegroundColor Yellow
        return
    }
    if ($plan.Action -ne "revive") { return }
    if (-not (Get-Command $plan.Exe -ErrorAction SilentlyContinue)) { return }

    # Small deterministic stagger per terminal ID so multiple panes don't spike CPU simultaneously
    $hashSum = 0
    foreach ($ch in $terminalId.ToCharArray()) { $hashSum += [int]$ch }
    $staggerMs = (($hashSum % 5) * 200) + 150

    $detail = if ($plan.Source -eq "session-id") { "$($plan.Agent) ($($plan.SessionId))" } else { "$($plan.Agent) (latest via -c)" }
    if ($plan.ChangeTo) { $detail = "$detail in $($plan.ChangeTo)" }
    Write-Host "[herdr-cortex] Restoring $detail in $terminalId... (Ctrl+C to cancel)" -ForegroundColor Cyan
    Start-Sleep -Milliseconds $staggerMs

    if ($plan.ChangeTo) {
        # The session was saved in another folder: go there first (a real cmdlet call, no command text is built).
        try {
            Set-Location -LiteralPath $plan.ChangeTo -ErrorAction Stop
        } catch {
            Write-Host "[herdr-cortex] Not restoring ${terminalId}: cannot change to $($plan.ChangeTo) ($($_.Exception.Message))" -ForegroundColor Yellow
            return
        }
    }

    $exe = $plan.Exe
    $exeArgs = @($plan.Arguments)
    $env:HERDR_REVIVE_IN_AGENT = "1"
    try {
        & $exe @exeArgs
    } finally {
        Remove-Item Env:HERDR_REVIVE_IN_AGENT -ErrorAction SilentlyContinue
    }
}

Invoke-HerdrAutoRevive
