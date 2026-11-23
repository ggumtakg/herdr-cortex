<#
.SYNOPSIS
    Functions shared by revive-agents.ps1 (batch revive through `hc send`) and auto-revive.ps1 (a tab that
    restores itself when its profile loads). Dot-source this file; it defines functions only.

    A revive plan for a bare-shell tab is one of:
      session-id   the hooks recorded this tab's session id       -> claude --resume <id> / agy --conversation <id>
                   (when the recorded folder differs from the tab's folder, the tab first changes to the
                   recorded folder; when that folder is gone the tab is skipped)
      tab-title    no usable record, the tab title names the agent -> claude -c / agy -c
                   (skipped when another live tab in the same folder is, or is about to be, the same agent:
                   `-c` continues the most recent conversation of the folder and cannot tell them apart)
#>

$script:HerdrBareShellNames = @("powershell.exe", "pwsh.exe", "cmd.exe", "bash.exe", "nu.exe", "powershell", "pwsh", "cmd")
$script:HerdrPowerShellNames = @("powershell.exe", "pwsh.exe", "powershell", "pwsh")
$script:HerdrReservedDeviceNames = @("con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9")

function script:Test-HerdrTerminalId {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
    $t = $Value.Trim()
    if ($t -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$') { return $false }
    if ($script:HerdrReservedDeviceNames -contains $t.ToLowerInvariant()) { return $false }
    return $true
}

function script:Test-HerdrSessionId {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
    $t = $Value.Trim()
    if ($t -notmatch '^[a-zA-Z0-9._-]{1,128}$') { return $false }
    if ($t.Contains("..")) { return $false }
    return $true
}

function script:ConvertTo-HerdrPathKey {
    param([string]$PathValue)
    if ([string]::IsNullOrWhiteSpace($PathValue)) { return "" }
    return $PathValue.Trim().Replace('/', '\').TrimEnd('\').ToLowerInvariant()
}

function script:Test-HerdrBareShell {
    param([string]$AgentName)
    if ([string]::IsNullOrWhiteSpace($AgentName)) { return $false }
    return ($script:HerdrBareShellNames -contains $AgentName.Trim().ToLowerInvariant())
}

# One terminal as `hc ls --json` (a row) or `hc get <id> --json` prints it.
function script:Get-HerdrTerminalMeta {
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

# The saved session record of a terminal from the first directory that has one, or $null.
function script:Read-HerdrSavedSession {
    param(
        [string]$TerminalId,
        [string[]]$SessionDirs
    )
    if (-not (Test-HerdrTerminalId $TerminalId)) { return $null }
    $cleanId = $TerminalId.Trim()
    foreach ($dir in $SessionDirs) {
        if ([string]::IsNullOrWhiteSpace($dir)) { continue }
        $file = Join-Path $dir "$cleanId.json"
        if (Test-Path -LiteralPath $file) {
            try {
                return Get-Content -Raw -LiteralPath $file -Encoding UTF8 | ConvertFrom-Json
            } catch {
                # Fall through to the next candidate
            }
        }
    }
    return $null
}

# agyExtraArgs / claudeExtraArgs from the first config file that sets them.
function script:Read-HerdrReviveConfig {
    param([string[]]$ConfigPaths)
    $result = @{
        agyExtraArgs    = @()
        claudeExtraArgs = @()
    }
    foreach ($cfgPath in $ConfigPaths) {
        if ([string]::IsNullOrWhiteSpace($cfgPath)) { continue }
        if (Test-Path -LiteralPath $cfgPath) {
            try {
                $parsed = Get-Content -Raw -LiteralPath $cfgPath -Encoding UTF8 | ConvertFrom-Json
                if ($parsed.agyExtraArgs -and $result.agyExtraArgs.Count -eq 0) { $result.agyExtraArgs = @($parsed.agyExtraArgs) }
                if ($parsed.claudeExtraArgs -and $result.claudeExtraArgs.Count -eq 0) { $result.claudeExtraArgs = @($parsed.claudeExtraArgs) }
            } catch {
                # Ignore an invalid config and use the defaults
            }
        }
    }
    return $result
}

# Which agent a tab title ("... / Claude Code", "... / Antigravity") names: 'claude', 'antigravity' or ''.
function script:Get-HerdrTitleAgent {
    param([string]$Where)
    if ([string]::IsNullOrWhiteSpace($Where)) { return "" }
    if ($Where -match '(?i)/\s*Antigravity\b') { return "antigravity" }
    if ($Where -match '(?i)/\s*Claude(\s+Code)?\b') { return "claude" }
    return ""
}

# Which agent a running (non-shell) tab is: by the program hc reports, else by its title.
function script:Get-HerdrRunningAgent {
    param($Meta)
    $name = $Meta.Agent.ToLowerInvariant()
    if ($name -match '^claude') { return "claude" }
    if ($name -match '^(agy|antigravity)') { return "antigravity" }
    return (Get-HerdrTitleAgent $Meta.Where)
}

function script:Get-HerdrAgentExe {
    param([string]$Agent)
    if ($Agent -eq "antigravity") { return "agy" }
    return "claude"
}

# The text typed into a PowerShell tab to change to $Path: the path is a single-quoted literal with every
# quote character doubled, so nothing in it is ever read as code.
function script:Format-HerdrSetLocation {
    param([string]$Path)
    $escaped = [System.Management.Automation.Language.CodeGeneration]::EscapeSingleQuotedStringContent($Path)
    return "Set-Location -LiteralPath '$escaped'"
}

<#
    Decide what to do with every terminal of $Metas (objects from Get-HerdrTerminalMeta).
    Returns one object per live terminal with a valid id:
      Address, Where, Action ('revive' | 'skip' | 'ignore' | 'active'), Agent, Source ('session-id' | 'tab-title'),
      SessionId, Folder (the folder the agent runs in), ChangeTo (folder to change to first, '' when none),
      Exe, Arguments (argument array), Command (the line typed into the tab), Reason (why it is skipped),
      Warning (a note that does not stop the plan).
#>
function script:Resolve-HerdrRevivePlans {
    param(
        [object[]]$Metas,
        $Config,
        [string[]]$SessionDirs
    )

    $plans = New-Object System.Collections.Generic.List[object]
    foreach ($meta in $Metas) {
        if ($meta.State -ne "live") { continue }
        $plan = [PSCustomObject]@{
            Address   = $meta.Address
            Where     = $meta.Where
            ShellName = $meta.Agent
            Action    = "ignore"
            Agent     = ""
            Source    = ""
            SessionId = $null
            Folder    = $meta.Cwd
            ChangeTo  = ""
            Exe       = ""
            Arguments = @()
            Command   = ""
            Reason    = ""
            Warning   = ""
            TitleConflict = ""
        }
        if (-not (Test-HerdrTerminalId $meta.Address)) {
            $plan.Action = "skip"
            $plan.Reason = "invalid terminal id"
            $plans.Add($plan)
            continue
        }
        if (-not (Test-HerdrBareShell $meta.Agent)) {
            $plan.Action = "active"
            $plan.Agent = Get-HerdrRunningAgent $meta
            $plans.Add($plan)
            continue
        }

        # 1. The session id the hooks recorded for exactly this terminal (strictly validated)
        $saved = Read-HerdrSavedSession -TerminalId $meta.Address -SessionDirs $SessionDirs
        if ($saved -and $saved.sessionId) {
            $sid = ([string]$saved.sessionId).Trim()
            $savedAgent = [string]$saved.agent
            if (-not (Test-HerdrSessionId $sid)) {
                $plan.Warning = "ignored invalid saved sessionId"
            } elseif ($savedAgent -eq "antigravity" -or $savedAgent -eq "claude") {
                $plan.Agent = $savedAgent
                $plan.Source = "session-id"
                $plan.SessionId = $sid
                $plan.Exe = Get-HerdrAgentExe $savedAgent
                $extra = if ($savedAgent -eq "antigravity") { @($Config.agyExtraArgs) } else { @($Config.claudeExtraArgs) }
                $resumeFlag = if ($savedAgent -eq "antigravity") { "--conversation" } else { "--resume" }
                $plan.Arguments = @($resumeFlag, $sid) + $extra
                $plan.Command = (@($plan.Exe) + $plan.Arguments) -join " "
                $plan.Action = "revive"

                $savedCwd = if ($saved.cwd) { ([string]$saved.cwd).Trim() } else { "" }
                $sameFolder = [string]::IsNullOrEmpty($savedCwd) -or ((ConvertTo-HerdrPathKey $savedCwd) -eq (ConvertTo-HerdrPathKey $meta.Cwd))
                if (-not $sameFolder) {
                    # The session belongs to the recorded folder: go there first instead of guessing by the title.
                    # Only an absolute path of an existing file-system directory is ever used.
                    $folderExists = $false
                    try {
                        $folderExists = [System.IO.Path]::IsPathRooted($savedCwd) -and [System.IO.Directory]::Exists($savedCwd)
                    } catch {
                        $folderExists = $false
                    }
                    if (-not $folderExists) {
                        $plan.Action = "skip"
                        $plan.Reason = "the folder saved with session $sid no longer exists: $savedCwd"
                    } elseif ($script:HerdrPowerShellNames -notcontains $meta.Agent.ToLowerInvariant()) {
                        $plan.Action = "skip"
                        $plan.Reason = "session $sid was saved in another folder ($savedCwd) and this tab's shell ($($meta.Agent)) is not PowerShell; change to that folder yourself, then run: $($plan.Command)"
                    } else {
                        $plan.Folder = $savedCwd
                        $plan.ChangeTo = $savedCwd
                        $plan.Command = (Format-HerdrSetLocation $savedCwd) + "; " + $plan.Command
                    }
                }
                $plans.Add($plan)
                continue
            }
        }

        # 2. No usable record: the tab title ("... / Antigravity" or "... / Claude")
        $titleAgent = Get-HerdrTitleAgent $meta.Where
        if ($titleAgent) {
            $plan.Agent = $titleAgent
            $plan.Source = "tab-title"
            $plan.Exe = Get-HerdrAgentExe $titleAgent
            $extra = if ($titleAgent -eq "antigravity") { @($Config.agyExtraArgs) } else { @($Config.claudeExtraArgs) }
            $plan.Arguments = @("-c") + $extra
            $plan.Command = (@($plan.Exe) + $plan.Arguments) -join " "
            $plan.Action = "revive"
        }
        $plans.Add($plan)
    }

    # `-c` continues the most recent conversation of the folder. When another live tab in that folder is the
    # same agent (running already, or about to be revived), the two cannot be told apart: do not guess.
    foreach ($plan in $plans) {
        if ($plan.Action -ne "revive" -or $plan.Source -ne "tab-title") { continue }
        $folderKey = ConvertTo-HerdrPathKey $plan.Folder
        if ([string]::IsNullOrEmpty($folderKey)) { continue }
        $sharing = @($plans | Where-Object {
            $_.Address -ne $plan.Address -and
            $_.Agent -eq $plan.Agent -and
            ($_.Action -eq "active" -or $_.Action -eq "revive") -and
            (ConvertTo-HerdrPathKey $_.Folder) -eq $folderKey
        })
        if ($sharing.Count -gt 0) {
            $ids = (@($plan.Address) + @($sharing | ForEach-Object { $_.Address })) -join ", "
            $plan.TitleConflict = "'$($plan.Exe) -c' not used: $($sharing.Count + 1) $($plan.Agent) tabs share the folder $($plan.Folder) ($ids), and -c cannot tell their conversations apart; pick one yourself with: $($plan.Exe) --resume"
        }
    }
    # Applied afterwards, so that two tabs that conflict with each other are both skipped.
    foreach ($plan in $plans) {
        if ($plan.TitleConflict) {
            $plan.Action = "skip"
            $plan.Reason = $plan.TitleConflict
        }
    }

    return $plans.ToArray()
}
