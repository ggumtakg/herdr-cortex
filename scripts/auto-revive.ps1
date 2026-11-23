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
$script:HerdrReservedWinNames = @("con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9")

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

function script:Test-HerdrTerminalId {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
    $t = $Value.Trim()
    if ($t -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$') { return $false }
    if ($script:HerdrReservedWinNames -contains $t.ToLowerInvariant()) { return $false }
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

    $cortexSessions = if (Test-Path $script:HerdrCortexSessionsDir) {
        @(Get-ChildItem -Path $script:HerdrCortexSessionsDir -Filter "*.json" -File -ErrorAction SilentlyContinue).Count
    } else { 0 }
    $legacySessions = if (Test-Path $script:HerdrLegacySessionsDir) {
        @(Get-ChildItem -Path $script:HerdrLegacySessionsDir -Filter "*.json" -File -ErrorAction SilentlyContinue).Count
    } else { 0 }
    Write-Host ("Saved Sessions: cortex={0}, legacy={1}" -f $cortexSessions, $legacySessions)

    if (-not [string]::IsNullOrWhiteSpace($env:HC_TERMINAL_ID)) {
        Write-Host ("HC_TERMINAL_ID: {0}" -f $env:HC_TERMINAL_ID)
    }

    if (Get-Command node -ErrorAction SilentlyContinue) {
        $diagJs = @'
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const repoRoot = process.env.HERDR_DIAG_REPO || '';
const cwdPath = process.env.HERDR_DIAG_CWD || process.cwd();
const globalDir = process.env.HERDR_DIAG_GLOBAL || '';
const homeDir = process.env.HERDR_DIAG_HOME || '';
const cfgMod = await import(pathToFileURL(path.join(repoRoot, 'src', 'core', 'config.mjs')).href);

const verMatch = /^v?(\d+)\.(\d+)/.exec(process.version);
const verOk = verMatch && (Number(verMatch[1]) > 22 || (Number(verMatch[1]) === 22 && Number(verMatch[2]) >= 13));
console.log(`Node Version  : ${process.version} (${verOk ? 'OK >=22.13' : 'TOO OLD: require >=22.13'})`);

let vecStatus = 'unavailable';
try {
  const req = createRequire(path.join(repoRoot, 'package.json'));
  const vecMod = await import(pathToFileURL(req.resolve('sqlite-vec')).href);
  vecStatus = typeof vecMod.load === 'function' ? 'available' : 'missing load()';
} catch (err) {
  vecStatus = `unavailable (${err?.code || err?.message || 'not installed'})`;
}
console.log(`sqlite-vec    : ${vecStatus}`);

const cfg = cfgMod.loadConfig({ projectDir: cwdPath, globalDir });
const enabled = cfgMod.isProjectEnabled(cwdPath, cfg);
const normPath = path.resolve(cwdPath).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const segs = normPath.split('/').filter(Boolean);
const matchRule = (list) => (Array.isArray(list) ? list.find((r) => {
  if (typeof r !== 'string') return false;
  const c = r.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (!c) return false;
  return (c.includes('/') || /^[a-z]:/i.test(c)) ? (normPath === c || normPath.startsWith(`${c}/`)) : segs.includes(c);
}) : null);

let ruleNote = `mode=${cfg.mode || 'all'}`;
if (typeof cfg.enabled === 'boolean') ruleNote = `explicit enabled=${cfg.enabled}`;
else if (!enabled) {
  const ex = matchRule(cfg.excludedProjects);
  ruleNote = ex ? `excludedProjects matched "${ex}"` : `opt-in (not in enabledProjects)`;
} else if (String(cfg.mode || '').toLowerCase() === 'opt-in') {
  const inc = matchRule(cfg.enabledProjects);
  if (inc) ruleNote = `opt-in matched "${inc}"`;
}
console.log(`CWD Policy    : enabled=${enabled} (${ruleNote}) | headCore=${cfg.headCoreEnabled} | budget=${cfg.hookBudget} | embed=${cfg.embedding?.provider || 'auto'}`);

const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(2)}MB` : `${(n / 1024).toFixed(1)}KB`);
const fileSize = (p) => { try { return fs.existsSync(p) ? fs.statSync(p).size : 0; } catch { return 0; } };

const inspectTier = (label, tierDir) => {
  if (!fs.existsSync(tierDir)) {
    console.log(`${label.padEnd(14)}: none (${tierDir})`);
    return;
  }
  const dbPath = path.join(tierDir, 'index.sqlite');
  const dbBytes = fileSize(dbPath);
  const walBytes = fileSize(`${dbPath}-wal`);
  let embedSummary = 'no db';
  let lastErr = '';
  if (dbBytes > 0) {
    let db;
    try {
      db = new DatabaseSync(dbPath, { open: true, readOnly: true });
      const cols = db.prepare('PRAGMA table_info(docs)').all().map((c) => c.name);
      const rows = db.prepare('SELECT embed_status, COUNT(*) AS cnt FROM docs GROUP BY embed_status').all();
      const counts = { ready: 0, pending: 0, error: 0 };
      for (const r of rows) {
        const k = String(r.embed_status || 'pending').toLowerCase();
        counts[k] = (counts[k] || 0) + Number(r.cnt || 0);
      }
      embedSummary = `ready=${counts.ready}, pending=${counts.pending}, error=${counts.error}`;
      if (cols.includes('embed_error')) {
        const errRow = db.prepare("SELECT id, embed_error FROM docs WHERE embed_error IS NOT NULL AND embed_error != '' ORDER BY updated_at DESC LIMIT 1").get();
        if (errRow) lastErr = `${errRow.id}: ${String(errRow.embed_error).slice(0, 80)}`;
      }
    } catch (err) {
      embedSummary = `db error: ${err?.message || err}`;
    } finally {
      try { db?.close(); } catch {}
    }
  }
  console.log(`${label.padEnd(14)}: db=${fmtBytes(dbBytes)}, wal=${fmtBytes(walBytes)} | embed(${embedSummary})${lastErr ? ` | lastErr=${lastErr}` : ''}`);
};

inspectTier('Project Tier', path.join(cwdPath, '.memory'));
inspectTier('Global Tier', globalDir);

// Inspect inbox pending / .broken / orphan .tmp files under project .memory/state
const projMemDir = path.join(cwdPath, '.memory');
if (fs.existsSync(projMemDir)) {
  let pendingInbox = 0;
  let brokenInbox = 0;
  let orphanTmp = 0;
  const walkTmp = (dir) => {
    try {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, ent.name);
        if (ent.isDirectory()) walkTmp(abs);
        else if (ent.name.includes('.tmp-')) orphanTmp++;
      }
    } catch {}
  };
  walkTmp(projMemDir);
  const inboxRoot = path.join(projMemDir, 'state', 'inbox');
  if (fs.existsSync(inboxRoot)) {
    try {
      for (const tidDir of fs.readdirSync(inboxRoot, { withFileTypes: true })) {
        if (!tidDir.isDirectory()) continue;
        const absTid = path.join(inboxRoot, tidDir.name);
        for (const f of fs.readdirSync(absTid, { withFileTypes: true })) {
          if (f.isFile() && f.name.endsWith('.json') && !f.name.startsWith('.')) pendingInbox++;
        }
        const bDir = path.join(absTid, '.broken');
        if (fs.existsSync(bDir)) {
          brokenInbox += fs.readdirSync(bDir).length;
        }
      }
    } catch {}
  }
  console.log(`Project State : inbox_pending=${pendingInbox}, inbox_broken=${brokenInbox}, orphan_tmp=${orphanTmp}`);
}

const checkJsonConfig = (label, p, pred) => {
  if (!fs.existsSync(p)) return `${label}=missing`;
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
    return `${label}=${pred(obj) ? 'ok' : 'not-registered'}`;
  } catch {
    return `${label}=INVALID_JSON`;
  }
};
const cfgChecks = [
  checkJsonConfig('agy-hooks', path.join(homeDir, '.gemini', 'config', 'hooks.json'), (o) => Boolean(o?.['herdr-cortex'])),
  checkJsonConfig('agy-mcp', path.join(homeDir, '.gemini', 'antigravity-cli', 'mcp_config.json'), (o) => Boolean(o?.mcpServers?.cortex)),
  checkJsonConfig('claude-hooks', path.join(homeDir, '.claude', 'settings.json'), (o) => Boolean(o?.hooks?.SessionStart)),
  checkJsonConfig('claude-mcp', path.join(homeDir, '.claude.json'), (o) => Boolean(o?.mcpServers?.cortex)),
];
console.log(`Configs       : ${cfgChecks.join(', ')}`);
'@
        $prevOutEnc = [Console]::OutputEncoding
        $prevRepo = $env:HERDR_DIAG_REPO
        $prevCwd = $env:HERDR_DIAG_CWD
        $prevGlobal = $env:HERDR_DIAG_GLOBAL
        $prevHome = $env:HERDR_DIAG_HOME
        try {
            [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
            $env:HERDR_DIAG_REPO = $script:HerdrCortexRoot
            $env:HERDR_DIAG_CWD = (Get-Location).Path
            $env:HERDR_DIAG_GLOBAL = $script:HerdrCortexDir
            $env:HERDR_DIAG_HOME = $script:HerdrHome
            $diagJs | & node --no-warnings --input-type=module
        } catch {
            Write-Host ("Diagnostics   : failed ({0})" -f $_.Exception.Message) -ForegroundColor Yellow
        } finally {
            [Console]::OutputEncoding = $prevOutEnc
            if ($null -eq $prevRepo) { Remove-Item Env:HERDR_DIAG_REPO -ErrorAction SilentlyContinue } else { $env:HERDR_DIAG_REPO = $prevRepo }
            if ($null -eq $prevCwd) { Remove-Item Env:HERDR_DIAG_CWD -ErrorAction SilentlyContinue } else { $env:HERDR_DIAG_CWD = $prevCwd }
            if ($null -eq $prevGlobal) { Remove-Item Env:HERDR_DIAG_GLOBAL -ErrorAction SilentlyContinue } else { $env:HERDR_DIAG_GLOBAL = $prevGlobal }
            if ($null -eq $prevHome) { Remove-Item Env:HERDR_DIAG_HOME -ErrorAction SilentlyContinue } else { $env:HERDR_DIAG_HOME = $prevHome }
        }
    } else {
        Write-Host "Node Version  : node.exe not found on PATH" -ForegroundColor Red
    }

    if (Get-Command hc -ErrorAction SilentlyContinue) {
        Write-Host ""
        try {
            & $script:HerdrReviveScript -Status
        } catch {
            Write-Host ("Herdr CLI     : unavailable ({0})" -f $_.Exception.Message) -ForegroundColor DarkGray
        }
    }
}

function script:Normalize-HerdrPath {
    param([string]$PathValue)
    if ([string]::IsNullOrWhiteSpace($PathValue)) { return "" }
    return $PathValue.Trim().TrimEnd('\', '/').ToLowerInvariant()
}

function script:Read-SavedHerdrSession {
    param([string]$TerminalId)
    if (-not (Test-HerdrTerminalId $TerminalId)) { return $null }
    $cleanId = $TerminalId.Trim()
    foreach ($dir in @($script:HerdrCortexSessionsDir, $script:HerdrLegacySessionsDir)) {
        $file = Join-Path $dir "$cleanId.json"
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
    if (-not (Test-HerdrTerminalId $terminalId)) { return }

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

    # Check live terminal metadata from hc (only if hc is on PATH to avoid 900ms startup delay)
    $liveTerm = $null
    if (Get-Command hc -ErrorAction SilentlyContinue) {
        $prevOutEnc = [Console]::OutputEncoding
        try {
            [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
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
        } finally {
            [Console]::OutputEncoding = $prevOutEnc
        }
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
        $sid = ([string]$saved.sessionId).Trim()
        if (Test-HerdrSessionId $sid) {
            $savedCwd = Normalize-HerdrPath $saved.cwd
            $currCwd = Normalize-HerdrPath (Get-Location).Path
            $cwdMatches = ([string]::IsNullOrEmpty($savedCwd)) -or ($savedCwd -eq $currCwd)

            if ($cwdMatches) {
                if ($saved.agent -eq "antigravity") {
                    $targetAgent = "agy"
                    $targetArgs = @("--conversation", $sid) + $agyExtra
                    $displayDetail = "antigravity ($sid)"
                } elseif ($saved.agent -eq "claude") {
                    $targetAgent = "claude"
                    $targetArgs = @("--resume", $sid) + $claudeExtra
                    $displayDetail = "claude ($sid)"
                }
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
