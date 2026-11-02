param([Parameter(Mandatory)][ValidateSet('x64', 'arm64')][string]$TargetArch)
. (Join-Path $PSScriptRoot 'prepare-ci-windows-sandbox.ps1') -TargetArch $TargetArch
$temporary = Join-Path $env:RUNNER_TEMP ("agentic-sandbox-acl-" + [guid]::NewGuid().ToString('N'))
$report = [ordered]@{ target = "windows-$TargetArch"; status = 'failed'; checks = @() }
$reportDir = New-Item -ItemType Directory -Force (Join-Path (Split-Path $PSScriptRoot -Parent) '.runtime/ci')
function Assert-Check($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Expect-Rejection([scriptblock]$Action, [string]$Expected) {
    $message = ''
    try { & $Action } catch { $message = $_.Exception.Message }
    Assert-Check ($message.Contains($Expected)) "Expected rejection: $Expected; got: $message"
}
try {
    $stage = New-Item -ItemType Directory -Path (Join-Path $temporary 'Agentic Browser') -Force
    $outside = New-Item -ItemType Directory -Path (Join-Path $temporary 'unrelated')
    $outsideDacl = (Get-Acl -LiteralPath $outside.FullName).Sddl
    $parentDacl = (Get-Acl -LiteralPath $temporary).Sddl
    # Remove inherited permissions only on this newly created fixture, retaining
    # the current runner's full control. This gives a known missing LPAC ACE.
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $user, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    Set-Acl -LiteralPath $stage.FullName -AclObject $acl
    $nested = New-Item -ItemType Directory -Path (Join-Path $stage 'locales')
    [IO.File]::WriteAllText((Join-Path $stage 'chrome.exe'), 'fixture executable; never launched')
    [IO.File]::WriteAllText((Join-Path $nested 'en-US.pak'), 'fixture data')
    $hash = (Get-FileHash -LiteralPath (Join-Path $stage 'chrome.exe')).Hash
    $owner = (Get-Acl -LiteralPath $stage.FullName).Owner
    Assert-Check (-not (Get-Acl -LiteralPath (Join-Path $stage 'chrome.exe')).Sddl.Contains('S-1-15-2-2')) 'Fixture must initially lack LPAC access.'
    $result = @{}
    Initialize-CiWindowsSandbox $stage.FullName $result
    Assert-Check ($result.status -eq 'configured' -and $result.verifiedEntries -eq 4) 'Nested files must inherit RX.'
    $report.checks += 'missing ACL repaired on nested files'
    foreach ($item in @($stage) + @(Get-ChildItem -LiteralPath $stage.FullName -Recurse)) {
        $rules = (Get-Acl -LiteralPath $item.FullName).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
        foreach ($rule in $rules | Where-Object { $_.IdentityReference.Value -eq 'S-1-15-2-2' }) {
            Assert-Check (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Write) -eq 0) 'LPAC must not receive write access.'
        }
    }
    Assert-Check ((Get-FileHash -LiteralPath (Join-Path $stage 'chrome.exe')).Hash -eq $hash) 'File contents changed.'
    Assert-Check ((Get-Acl -LiteralPath $stage.FullName).Owner -eq $owner) 'Owner changed.'
    Assert-Check ((Get-Acl -LiteralPath $temporary).Sddl -eq $parentDacl) 'Parent ACL changed.'
    Assert-Check ((Get-Acl -LiteralPath $outside.FullName).Sddl -eq $outsideDacl) 'Unrelated ACL changed.'
    $report.checks += 'read execute only; content owner parent and unrelated ACL preserved'
    $dacl = (Get-Acl -LiteralPath $stage.FullName).Sddl
    Initialize-CiWindowsSandbox $stage.FullName @{}
    Assert-Check ((Get-Acl -LiteralPath $stage.FullName).Sddl -eq $dacl) 'Repeated preparation changed the ACL.'
    $report.checks += 'idempotent grant'
    $junction = New-Item -ItemType Junction -Path (Join-Path $stage 'outside-link') -Target $outside.FullName
    try { Expect-Rejection { Initialize-CiWindowsSandbox $stage.FullName @{} } 'Reparse point' }
    finally { [IO.Directory]::Delete($junction.FullName) }
    Assert-Check ((Get-Acl -LiteralPath $outside.FullName).Sddl -eq $outsideDacl) 'Junction target ACL changed.'
    $report.checks += 'junction rejected without touching its target'
    $file = Join-Path $nested 'en-US.pak'
    $acl = Get-Acl -LiteralPath $file
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new('S-1-15-2-2'), 'ReadAndExecute', 'Deny'))
    Set-Acl -LiteralPath $file -AclObject $acl
    $deniedDacl = (Get-Acl -LiteralPath $file).Sddl
    Expect-Rejection { Initialize-CiWindowsSandbox $stage.FullName @{} } 'Existing LPAC denial'
    Assert-Check ((Get-Acl -LiteralPath $file).Sddl -eq $deniedDacl) 'Explicit denial changed.'
    $report.checks += 'explicit denial preserved and rejected'
    $acl = [Security.AccessControl.FileSecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($user, 'FullControl', 'Allow'))
    Set-Acl -LiteralPath $file -AclObject $acl
    $protectedDacl = (Get-Acl -LiteralPath $file).Sddl
    Expect-Rejection { Initialize-CiWindowsSandbox $stage.FullName @{} } 'lacks inherited LPAC read/execute'
    Assert-Check ((Get-Acl -LiteralPath $file).Sddl -eq $protectedDacl) 'Protected child ACL changed.'
    $report.checks += 'protected child fails closed without changing inheritance'
    $report.status = 'passed'
} catch { $report.error = $_.Exception.Message; throw }
finally {
    try { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force } }
    catch { $report.status = 'failed'; $report.error = "Fixture cleanup failed: $($_.Exception.Message)"; throw }
    finally { $report | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $reportDir "sandbox-fixture-windows-$TargetArch.json") }
}
