param([ValidateSet('x64', 'arm64')][string]$TargetArch)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Sandbox ACL preparation is restricted to ephemeral GitHub-hosted Windows runners.'
}

function Initialize-CiWindowsSandbox([string]$Directory, [System.Collections.IDictionary]$Diagnostics) {
    # Match pinned Chromium testing/scripts/common.py:set_lpac_acls. Grant only
    # read/execute to LPAC processes, never write access or a sandbox exemption.
    $sid = 'S-1-15-2-2'
    $rx = [Security.AccessControl.FileSystemRights]::ReadAndExecute
    $stage = Get-Item -LiteralPath $Directory -Force
    if (-not $stage.PSIsContainer) { throw 'Expected a staged application directory.' }
    for ($parent = $stage; $null -ne $parent; $parent = $parent.Parent) {
        if ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point in staging path.' }
    }
    $items = @($stage) + @(Get-ChildItem -LiteralPath $stage.FullName -Recurse -Force)
    if (@($items | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) {
        throw 'Reparse point inside staged application.'
    }
    $exe = Join-Path $stage.FullName 'chrome.exe'
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Missing staged chrome.exe.' }
    $Diagnostics.sid = $sid
    $Diagnostics.grant = '(OI)(CI)(RX)'
    $Diagnostics.before = @{}
    foreach ($item in $items) {
        $acl = Get-Acl -LiteralPath $item.FullName
        $relative = [IO.Path]::GetRelativePath($stage.FullName, $item.FullName)
        if ($relative -in @('.', 'chrome.exe', 'chrome.dll')) { $Diagnostics.before[$relative] = $acl.Sddl }
        # Preserve existing denials and inheritance policy; do not "repair" them
        # by removing restrictions. Native smoke still checks effective access.
        foreach ($ace in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
            if ($ace.IdentityReference.Value -eq $sid -and $ace.AccessControlType -eq 'Deny' -and ($ace.FileSystemRights -band $rx)) {
                throw "Existing LPAC denial: $relative"
            }
        }
    }
    # No /reset, /grant:r, /T or parent-directory grant. Existing staged files
    # inherit the directory ACE; protected children fail verification below.
    & icacls.exe $stage.FullName /grant '*S-1-15-2-2:(OI)(CI)(RX)' /q | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "icacls failed: $LASTEXITCODE" }
    $Diagnostics.after = @{}
    foreach ($item in $items) {
        $acl = Get-Acl -LiteralPath $item.FullName
        $relative = [IO.Path]::GetRelativePath($stage.FullName, $item.FullName)
        if ($relative -in @('.', 'chrome.exe', 'chrome.dll')) { $Diagnostics.after[$relative] = $acl.Sddl }
        $allowed = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object {
            $_.IdentityReference.Value -eq $sid -and $_.AccessControlType -eq 'Allow' -and
            -not ($_.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -and
            ($_.FileSystemRights -band $rx) -eq $rx
        })
        if (-not $allowed.Count) {
            $Diagnostics.failedPath = $relative
            $Diagnostics.failedDacl = $acl.Sddl
            throw "Staged file lacks inherited LPAC read/execute: $relative"
        }
    }
    $Diagnostics.verifiedEntries = $items.Count
    $Diagnostics.status = 'configured'
}

# Dot-sourcing exposes the same implementation to isolated native ACL fixtures.
if ($MyInvocation.InvocationName -ne '.') {
    if (-not $TargetArch) { throw 'TargetArch is required.' }
    $root = Split-Path $PSScriptRoot -Parent
    $stage = Join-Path $root ".runtime/package/windows-$TargetArch/Agentic Browser"
    $reportDir = New-Item -ItemType Directory -Force (Join-Path $root '.runtime/ci')
    $report = [ordered]@{ target = "windows-$TargetArch"; status = 'failed'; scope = 'staged application only' }
    try { Initialize-CiWindowsSandbox $stage $report }
    catch { $report.error = $_.Exception.Message; throw }
    finally { $report | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $reportDir "sandbox-windows-$TargetArch.json") }
}
