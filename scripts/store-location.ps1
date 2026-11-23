<#
.SYNOPSIS
    Where herdr-cortex keeps its files, decided in one place for every PowerShell script (install.ps1,
    uninstall.ps1, scripts\auto-revive.ps1, scripts\revive-agents.ps1). Dot-source this file; it defines
    functions only. The Node side applies the same order in src\core\config.mjs (resolveHomeDir,
    resolveGlobalDir).

    Home directory : HERDR_CORTEX_TEST_HOME, else HERDR_REVIVE_TEST_HOME (the predecessor's name for it),
                     else USERPROFILE.
    Global store   : an explicit -GlobalDir, else HERDR_CORTEX_HOME, else <home directory>\.herdr-cortex.
#>

# The test home when one of the test-home variables is set, otherwise $null.
function script:Get-HerdrTestHome {
    if (-not [string]::IsNullOrWhiteSpace($env:HERDR_CORTEX_TEST_HOME)) { return $env:HERDR_CORTEX_TEST_HOME }
    if (-not [string]::IsNullOrWhiteSpace($env:HERDR_REVIVE_TEST_HOME)) { return $env:HERDR_REVIVE_TEST_HOME }
    return $null
}

function script:Get-HerdrEffectiveHome {
    $testHome = Get-HerdrTestHome
    if ($testHome) { return $testHome }
    return $env:USERPROFILE
}

function script:Get-HerdrCortexGlobalDir {
    param([string]$GlobalDir)
    if (-not [string]::IsNullOrWhiteSpace($GlobalDir)) { return $GlobalDir }
    if (-not [string]::IsNullOrWhiteSpace($env:HERDR_CORTEX_HOME)) { return $env:HERDR_CORTEX_HOME }
    return (Join-Path (Get-HerdrEffectiveHome) ".herdr-cortex")
}
