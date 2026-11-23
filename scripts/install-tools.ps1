<#
.SYNOPSIS
    Functions shared by install.ps1 and uninstall.ps1: the marker-delimited block in a PowerShell profile
    (written back in the file's own encoding, after a dated backup) and the ExecutionPolicy bookkeeping.

    Dot-source it to get the functions. Called with -Action it runs one profile operation and prints the
    result as one JSON line (this is how the tests drive it against scratch files):
      -Action ProfileSet    -ProfilePath <file> -BlockPath <UTF-8 file with the block lines> [-Stamp s] [-AnsiCodePage n]
      -Action ProfileRemove -ProfilePath <file> [-Stamp s] [-AnsiCodePage n]
      -Action PathExpression -Value <path>
#>
param(
    [string]$Action,
    [string]$ProfilePath,
    [string]$BlockPath,
    [string]$Stamp,
    [int]$AnsiCodePage = 0,
    [string]$Value
)

$script:HerdrBlockStart = "# >>> herdr-cortex >>>"
$script:HerdrBlockEnd = "# <<< herdr-cortex <<<"
$script:HerdrLegacyBlockStart = "# >>> herdr-revive >>>"
$script:HerdrLegacyBlockEnd = "# <<< herdr-revive <<<"

function script:Get-HerdrBackupStamp {
    return (Get-Date -Format "yyyyMMdd-HHmmss")
}

# Copy $Path to "<Path>.herdr-cortex.<stamp>.bak" (a counter is added when that name is taken). Returns the backup path.
function script:New-HerdrDatedBackup {
    param(
        [string]$Path,
        [string]$Stamp
    )
    if ([string]::IsNullOrWhiteSpace($Stamp)) { $Stamp = Get-HerdrBackupStamp }
    $backupPath = "$Path.herdr-cortex.$Stamp.bak"
    $counter = 2
    while (Test-Path -LiteralPath $backupPath) {
        $backupPath = "$Path.herdr-cortex.$Stamp-$counter.bak"
        $counter++
    }
    [System.IO.File]::Copy($Path, $backupPath, $false)
    return $backupPath
}

# The system ANSI code page as a strict encoding: a character it cannot represent raises an error instead
# of being replaced by "?".
function script:Get-HerdrAnsiEncoding {
    param([int]$CodePage = 0)
    if ($CodePage -le 0) {
        $CodePage = [System.Text.Encoding]::Default.CodePage
        if ($CodePage -eq 65001) {
            # PowerShell 7 reports UTF-8 here; the ANSI code page of the system is the culture's.
            $CodePage = [System.Globalization.CultureInfo]::CurrentCulture.TextInfo.ANSICodePage
        }
    }
    $encoderFallback = New-Object System.Text.EncoderExceptionFallback
    $decoderFallback = New-Object System.Text.DecoderExceptionFallback
    try {
        return [System.Text.Encoding]::GetEncoding($CodePage, $encoderFallback, $decoderFallback)
    } catch {
        # PowerShell 7 gets the Windows code pages from a provider.
        [System.Text.Encoding]::RegisterProvider([System.Text.CodePagesEncodingProvider]::Instance)
        return [System.Text.Encoding]::GetEncoding($CodePage, $encoderFallback, $decoderFallback)
    }
}

<#
    Detect how a profile is encoded: UTF-8 with BOM, UTF-16 LE / BE with BOM, otherwise UTF-8 when the bytes
    are valid UTF-8, otherwise the system ANSI code page. Returns @{ Name; Encoding; Preamble }.
    All encodings are strict (invalid bytes and unrepresentable characters raise errors).
#>
function script:Get-HerdrTextEncoding {
    param(
        [byte[]]$Bytes,
        [int]$AnsiCodePage = 0
    )
    $n = if ($null -eq $Bytes) { 0 } else { $Bytes.Length }
    if ($n -ge 4 -and $Bytes[0] -eq 0xFF -and $Bytes[1] -eq 0xFE -and $Bytes[2] -eq 0 -and $Bytes[3] -eq 0) {
        throw "the file is UTF-32, which is not supported"
    }
    if ($n -ge 4 -and $Bytes[0] -eq 0 -and $Bytes[1] -eq 0 -and $Bytes[2] -eq 0xFE -and $Bytes[3] -eq 0xFF) {
        throw "the file is UTF-32, which is not supported"
    }
    if ($n -ge 3 -and $Bytes[0] -eq 0xEF -and $Bytes[1] -eq 0xBB -and $Bytes[2] -eq 0xBF) {
        return @{ Name = "utf-8-bom"; Encoding = (New-Object System.Text.UTF8Encoding($false, $true)); Preamble = [byte[]](0xEF, 0xBB, 0xBF) }
    }
    if ($n -ge 2 -and $Bytes[0] -eq 0xFF -and $Bytes[1] -eq 0xFE) {
        return @{ Name = "utf-16le"; Encoding = (New-Object System.Text.UnicodeEncoding($false, $false, $true)); Preamble = [byte[]](0xFF, 0xFE) }
    }
    if ($n -ge 2 -and $Bytes[0] -eq 0xFE -and $Bytes[1] -eq 0xFF) {
        return @{ Name = "utf-16be"; Encoding = (New-Object System.Text.UnicodeEncoding($true, $false, $true)); Preamble = [byte[]](0xFE, 0xFF) }
    }
    $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
    try {
        [void]$utf8.GetString($Bytes)
        return @{ Name = "utf-8"; Encoding = $utf8; Preamble = [byte[]]@() }
    } catch {
        $ansi = Get-HerdrAnsiEncoding -CodePage $AnsiCodePage
        return @{ Name = "ansi-$($ansi.CodePage)"; Encoding = $ansi; Preamble = [byte[]]@() }
    }
}

function script:Test-HerdrBytesEqual {
    param([byte[]]$A, [byte[]]$B)
    if ($A.Length -ne $B.Length) { return $false }
    for ($i = 0; $i -lt $A.Length; $i++) {
        if ($A[$i] -ne $B[$i]) { return $false }
    }
    return $true
}

function script:ConvertTo-HerdrFileBytes {
    param([string]$Text, $TextEncoding)
    $body = $TextEncoding.Encoding.GetBytes($Text)
    $out = New-Object byte[] ($TextEncoding.Preamble.Length + $body.Length)
    [System.Array]::Copy($TextEncoding.Preamble, 0, $out, 0, $TextEncoding.Preamble.Length)
    [System.Array]::Copy($body, 0, $out, $TextEncoding.Preamble.Length, $body.Length)
    return ,$out
}

<#
    Read a profile as text in its own encoding. Returns @{ Bytes; Text; TextEncoding }.
    Throws when the bytes cannot be decoded, or when decoding and encoding again would not give back
    exactly the same bytes (then the file cannot be rewritten without changing text outside the block).
#>
function script:Read-HerdrProfile {
    param(
        [string]$Path,
        [int]$AnsiCodePage = 0
    )
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $textEncoding = Get-HerdrTextEncoding -Bytes $bytes -AnsiCodePage $AnsiCodePage
    $offset = $textEncoding.Preamble.Length
    try {
        $text = $textEncoding.Encoding.GetString($bytes, $offset, $bytes.Length - $offset)
    } catch {
        throw "its bytes are not valid $($textEncoding.Name) text"
    }
    $again = ConvertTo-HerdrFileBytes -Text $text -TextEncoding $textEncoding
    if (-not (Test-HerdrBytesEqual $bytes $again)) {
        throw "it cannot be rewritten as $($textEncoding.Name) without changing bytes outside the herdr-cortex block"
    }
    return @{ Bytes = $bytes; Text = $text; TextEncoding = $textEncoding }
}

# The spans of the marker-delimited blocks in $Text, in order: objects with Start and End (End is exclusive
# and includes the block's own line break when $WithLineBreak is set). Throws for a start marker without end marker.
function script:Find-HerdrBlockSpans {
    param(
        [string]$Text,
        [string]$StartMarker,
        [string]$EndMarker,
        [switch]$WithLineBreak
    )
    $spans = New-Object System.Collections.Generic.List[object]
    $pos = 0
    while ($true) {
        $start = $Text.IndexOf($StartMarker, $pos, [System.StringComparison]::Ordinal)
        if ($start -lt 0) { break }
        $endMarkerAt = $Text.IndexOf($EndMarker, $start + $StartMarker.Length, [System.StringComparison]::Ordinal)
        if ($endMarkerAt -lt 0) {
            throw "it contains ""$StartMarker"" without a matching ""$EndMarker"""
        }
        $end = $endMarkerAt + $EndMarker.Length
        if ($WithLineBreak) {
            if ($end -lt $Text.Length -and $Text[$end] -eq "`r") { $end++ }
            if ($end -lt $Text.Length -and $Text[$end] -eq "`n") { $end++ }
        }
        $spans.Add([PSCustomObject]@{ Start = $start; End = $end })
        $pos = $end
    }
    return ,$spans.ToArray()
}

# $Text without the given spans (which must be in order and not overlap).
function script:Remove-HerdrSpans {
    param([string]$Text, [object[]]$Spans)
    $builder = New-Object System.Text.StringBuilder
    $pos = 0
    foreach ($span in $Spans) {
        [void]$builder.Append($Text.Substring($pos, $span.Start - $pos))
        $pos = $span.End
    }
    [void]$builder.Append($Text.Substring($pos))
    return $builder.ToString()
}

function script:Get-HerdrLineBreak {
    param([string]$Text)
    if ($Text.Contains("`r`n")) { return "`r`n" }
    if ($Text.Contains("`n")) { return "`n" }
    return "`r`n"
}

<#
    $Text with the herdr-cortex block set to $BlockLines (an array of lines, markers included): the first
    existing block is replaced in place, further ones and the predecessor's (herdr-revive) block are removed,
    and without an existing block the new one is appended on a line of its own. Nothing else is changed.
#>
function script:Set-HerdrBlockInText {
    param([string]$Text, [string[]]$BlockLines)
    $eol = Get-HerdrLineBreak $Text
    $block = $BlockLines -join $eol

    $legacy = Find-HerdrBlockSpans -Text $Text -StartMarker $script:HerdrLegacyBlockStart -EndMarker $script:HerdrLegacyBlockEnd -WithLineBreak
    $result = Remove-HerdrSpans -Text $Text -Spans $legacy

    $own = Find-HerdrBlockSpans -Text $result -StartMarker $script:HerdrBlockStart -EndMarker $script:HerdrBlockEnd
    if ($own.Length -eq 0) {
        $separator = if ($result.Length -gt 0 -and -not $result.EndsWith("`n")) { $eol } else { "" }
        return $result + $separator + $block + $eol
    }
    # Further blocks (they all come after the first) go away together with their line break; the first is
    # replaced in place and keeps its line break.
    if ($own.Length -gt 1) {
        $withBreaks = Find-HerdrBlockSpans -Text $result -StartMarker $script:HerdrBlockStart -EndMarker $script:HerdrBlockEnd -WithLineBreak
        $result = Remove-HerdrSpans -Text $result -Spans @($withBreaks | Select-Object -Skip 1)
    }
    return $result.Substring(0, $own[0].Start) + $block + $result.Substring($own[0].End)
}

# $Text without the herdr-cortex block(s) and the predecessor's block(s), each removed with its own line break.
function script:Remove-HerdrBlockFromText {
    param([string]$Text)
    $result = $Text
    foreach ($markers in @(@($script:HerdrBlockStart, $script:HerdrBlockEnd), @($script:HerdrLegacyBlockStart, $script:HerdrLegacyBlockEnd))) {
        $spans = Find-HerdrBlockSpans -Text $result -StartMarker $markers[0] -EndMarker $markers[1] -WithLineBreak
        $result = Remove-HerdrSpans -Text $result -Spans $spans
    }
    return $result
}

<#
    Put the block into a profile file. Returns @{ Status; Encoding; BackupPath; Message }:
      created    the file did not exist: written as UTF-8 with BOM
      updated    the block was added or replaced; the file keeps its encoding; BackupPath is the copy made before
      unchanged  the block was already there, identical
      failed     nothing was written; Message says why (undecodable file, a block character the file's
                 encoding cannot represent, a start marker without end marker)
#>
function script:Set-HerdrProfileBlock {
    param(
        [string]$ProfilePath,
        [string[]]$BlockLines,
        [string]$Stamp,
        [int]$AnsiCodePage = 0
    )
    $result = @{ Status = "failed"; Encoding = ""; BackupPath = ""; Message = "" }
    try {
        if (-not (Test-Path -LiteralPath $ProfilePath)) {
            $dir = Split-Path -Parent $ProfilePath
            if (-not (Test-Path -LiteralPath $dir)) {
                New-Item -ItemType Directory -Force -Path $dir | Out-Null
            }
            # A new profile: UTF-8 with BOM, which every PowerShell version reads correctly.
            $newEncoding = @{ Name = "utf-8-bom"; Encoding = (New-Object System.Text.UTF8Encoding($false, $true)); Preamble = [byte[]](0xEF, 0xBB, 0xBF) }
            $bytes = ConvertTo-HerdrFileBytes -Text (Set-HerdrBlockInText -Text "" -BlockLines $BlockLines) -TextEncoding $newEncoding
            [System.IO.File]::WriteAllBytes($ProfilePath, $bytes)
            $result.Status = "created"
            $result.Encoding = $newEncoding.Name
            return $result
        }

        $current = Read-HerdrProfile -Path $ProfilePath -AnsiCodePage $AnsiCodePage
        $textEncoding = $current.TextEncoding
        if ($current.Bytes.Length -eq 0) {
            # An empty file has no encoding to keep.
            $textEncoding = @{ Name = "utf-8-bom"; Encoding = (New-Object System.Text.UTF8Encoding($false, $true)); Preamble = [byte[]](0xEF, 0xBB, 0xBF) }
        }
        $result.Encoding = $textEncoding.Name
        $updated = Set-HerdrBlockInText -Text $current.Text -BlockLines $BlockLines
        if ([string]::Equals($updated, $current.Text, [System.StringComparison]::Ordinal) -and $current.Bytes.Length -gt 0) {
            $result.Status = "unchanged"
            return $result
        }
        try {
            $bytes = ConvertTo-HerdrFileBytes -Text $updated -TextEncoding $textEncoding
        } catch {
            throw "the block contains characters that the file's encoding ($($textEncoding.Name)) cannot represent"
        }
        $result.BackupPath = New-HerdrDatedBackup -Path $ProfilePath -Stamp $Stamp
        [System.IO.File]::WriteAllBytes($ProfilePath, $bytes)
        $result.Status = "updated"
        return $result
    } catch {
        $result.Status = "failed"
        $result.Message = $_.Exception.Message
        return $result
    }
}

<#
    Remove the block (and the predecessor's) from a profile file. Returns @{ Status; Encoding; BackupPath; Message }
    with Status missing (no file) | unchanged (no block) | removed | failed.
#>
function script:Remove-HerdrProfileBlock {
    param(
        [string]$ProfilePath,
        [string]$Stamp,
        [int]$AnsiCodePage = 0
    )
    $result = @{ Status = "failed"; Encoding = ""; BackupPath = ""; Message = "" }
    try {
        if (-not (Test-Path -LiteralPath $ProfilePath)) {
            $result.Status = "missing"
            return $result
        }
        $current = Read-HerdrProfile -Path $ProfilePath -AnsiCodePage $AnsiCodePage
        $result.Encoding = $current.TextEncoding.Name
        $updated = Remove-HerdrBlockFromText -Text $current.Text
        if ([string]::Equals($updated, $current.Text, [System.StringComparison]::Ordinal)) {
            $result.Status = "unchanged"
            return $result
        }
        $bytes = ConvertTo-HerdrFileBytes -Text $updated -TextEncoding $current.TextEncoding
        $result.BackupPath = New-HerdrDatedBackup -Path $ProfilePath -Stamp $Stamp
        [System.IO.File]::WriteAllBytes($ProfilePath, $bytes)
        $result.Status = "removed"
        return $result
    } catch {
        $result.Status = "failed"
        $result.Message = $_.Exception.Message
        return $result
    }
}

<#
    A PowerShell expression, written in ASCII only, that evaluates to $Path: a single-quoted literal, with
    every character outside printable ASCII spelled as [char]0xNNNN. The profile block built from it reads
    the same in every encoding (Windows PowerShell 5.1 reads a profile without BOM in the ANSI code page,
    PowerShell 7 reads it as UTF-8), whatever the folder is called.
#>
function script:ConvertTo-HerdrPathExpression {
    param([string]$Path)
    $parts = New-Object System.Collections.Generic.List[string]
    $run = New-Object System.Text.StringBuilder
    $ascii = $true
    foreach ($ch in $Path.ToCharArray()) {
        $code = [int]$ch
        if ($code -ge 0x20 -and $code -le 0x7E) {
            if ($ch -eq "'") { [void]$run.Append("''") } else { [void]$run.Append($ch) }
        } else {
            $ascii = $false
            # The expression always starts with a string, so that every "+" after it joins text.
            if ($run.Length -gt 0 -or $parts.Count -eq 0) {
                $parts.Add("'" + $run.ToString() + "'")
                [void]$run.Clear()
            }
            $parts.Add("[char]0x" + $code.ToString("X4"))
        }
    }
    if ($run.Length -gt 0 -or $parts.Count -eq 0) { $parts.Add("'" + $run.ToString() + "'") }
    if ($ascii) { return $parts[0] }
    return "(" + ($parts -join " + ") + ")"
}

# The lines of the profile block that loads scripts\auto-revive.ps1.
function script:Get-HerdrProfileBlockLines {
    param(
        [string]$AutoReviveScript,
        [switch]$NoAutoResume
    )
    $expression = ConvertTo-HerdrPathExpression $AutoReviveScript
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add($script:HerdrBlockStart)
    if ($NoAutoResume) { $lines.Add("`$env:HERDR_REVIVE_DISABLE = '1'") }
    $lines.Add("if (Test-Path -LiteralPath $expression) { . $expression }")
    $lines.Add($script:HerdrBlockEnd)
    return $lines.ToArray()
}

# ---------------------------------------------------------------------------------------------------------
# ExecutionPolicy
# ---------------------------------------------------------------------------------------------------------

# With a test home the real policy is never read or changed. A test can supply one through
# HERDR_CORTEX_TEST_EXECUTION_POLICY ("<CurrentUser>,<LocalMachine>"); changes go to a file in the test home.
function script:Get-HerdrPolicyState {
    param([string]$TestHome)
    if ($TestHome) {
        if ([string]::IsNullOrWhiteSpace($env:HERDR_CORTEX_TEST_EXECUTION_POLICY)) { return $null }
        $parts = $env:HERDR_CORTEX_TEST_EXECUTION_POLICY.Split(",")
        $state = @{ CurrentUser = $parts[0].Trim(); LocalMachine = "Undefined" }
        if ($parts.Length -gt 1) { $state.LocalMachine = $parts[1].Trim() }
        $simulated = Join-Path $TestHome "test-execution-policy.txt"
        if (Test-Path -LiteralPath $simulated) {
            $state.CurrentUser = ([System.IO.File]::ReadAllText($simulated)).Trim()
        }
        return $state
    }
    return @{
        CurrentUser  = [string](Get-ExecutionPolicy -Scope CurrentUser)
        LocalMachine = [string](Get-ExecutionPolicy -Scope LocalMachine)
    }
}

function script:Set-HerdrCurrentUserPolicy {
    param([string]$Value, [string]$TestHome)
    if ($TestHome) {
        [System.IO.File]::WriteAllText((Join-Path $TestHome "test-execution-policy.txt"), $Value)
        return
    }
    Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy $Value -Force
}

# True when the profile (a local script) would not be loaded under these policies.
function script:Test-HerdrPolicyBlocksProfile {
    param($State)
    $cu = $State.CurrentUser
    $lm = $State.LocalMachine
    return (($cu -eq "Restricted") -or ($cu -eq "Undefined" -and ($lm -eq "Restricted" -or $lm -eq "Undefined")))
}

function script:Get-HerdrPolicyRecordPath {
    param([string]$GlobalDir)
    return (Join-Path $GlobalDir "state\execution-policy.json")
}

# What the installer changed: @{ scope; previous; set; changedAt } or $null.
function script:Read-HerdrPolicyRecord {
    param([string]$GlobalDir)
    $recordPath = Get-HerdrPolicyRecordPath $GlobalDir
    if (-not (Test-Path -LiteralPath $recordPath)) { return $null }
    try {
        $parsed = Get-Content -Raw -LiteralPath $recordPath -Encoding UTF8 | ConvertFrom-Json
        if ($parsed.previous -and $parsed.set) { return $parsed }
    } catch {}
    return $null
}

function script:Write-HerdrPolicyRecord {
    param([string]$GlobalDir, [string]$Previous, [string]$NewValue)
    $recordPath = Get-HerdrPolicyRecordPath $GlobalDir
    $dir = Split-Path -Parent $recordPath
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $json = '{"scope":"CurrentUser","previous":"' + $Previous + '","set":"' + $NewValue + '","changedAt":"' + (Get-Date).ToString("o") + '"}'
    [System.IO.File]::WriteAllText($recordPath, $json, (New-Object System.Text.UTF8Encoding($false)))
}

# ---------------------------------------------------------------------------------------------------------
# Direct invocation (tests)
# ---------------------------------------------------------------------------------------------------------

if ($Action) {
    $ErrorActionPreference = "Stop"
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $out = $null
    switch ($Action) {
        "ProfileSet" {
            $blockText = [System.IO.File]::ReadAllText($BlockPath, (New-Object System.Text.UTF8Encoding($false)))
            $blockLines = @($blockText -split "`r?`n" | Where-Object { $_ -ne "" })
            $out = Set-HerdrProfileBlock -ProfilePath $ProfilePath -BlockLines $blockLines -Stamp $Stamp -AnsiCodePage $AnsiCodePage
        }
        "ProfileRemove" {
            $out = Remove-HerdrProfileBlock -ProfilePath $ProfilePath -Stamp $Stamp -AnsiCodePage $AnsiCodePage
        }
        "PathExpression" {
            $expression = ConvertTo-HerdrPathExpression $Value
            $out = @{ Status = "ok"; Expression = $expression; Lines = (Get-HerdrProfileBlockLines -AutoReviveScript $Value) }
        }
        default {
            Write-Error "Unknown -Action '$Action'"
            exit 2
        }
    }
    Write-Output (ConvertTo-Json -InputObject $out -Compress)
    if ($out.Status -eq "failed") { exit 1 }
    exit 0
}
