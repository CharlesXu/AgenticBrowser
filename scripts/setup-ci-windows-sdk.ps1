param([Parameter(Mandatory)][ValidateSet('x64', 'arm64')][string]$TargetArch)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'SDK provisioning is restricted to ephemeral GitHub-hosted Windows runners.'
}
# Microsoft SDK downloads, June 2026. Match the pinned Chromium requirement.
$sdkVersion = '10.0.28000.0'
$installerVersion = '10.0.28000.2270'
$url = 'https://download.microsoft.com/download/78b533c3-6724-4e28-a984-b9fa93265781/KIT_BUNDLE_WINDOWSSDK_MEDIACREATION/winsdksetup.exe'
$expectedHash = 'e9f1bde566381355e594e2f90daf4f714eb5c7ef2c45c501ce236afe2abea300'
$toolchain = Get-Content '.chromium/src/build/vs_toolchain.py' -Raw
$instructions = Get-Content '.chromium/src/docs/windows_build_instructions.md' -Raw
if (-not $toolchain.Contains("SDK_VERSION = '$sdkVersion'") -or -not $instructions.Contains($installerVersion)) {
    throw 'Pinned Chromium SDK requirements changed; review the SDK installer before proceeding.'
}
$kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10'
$reportDir = New-Item -ItemType Directory -Force '.runtime/ci'
$report = [ordered]@{ target = "windows-$TargetArch"; sdkVersion = $sdkVersion; installerVersion = $installerVersion; url = $url; sha256 = $expectedHash; status = 'failed' }
try {
    $report.installedBefore = @(Get-ChildItem "$kits/Include" -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
    $installer = Join-Path $env:RUNNER_TEMP 'agentic-winsdksetup.exe'
    Invoke-WebRequest -Uri $url -OutFile $installer
    if ((Get-FileHash $installer -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) { throw 'Windows SDK installer SHA-256 mismatch.' }
    $signature = Get-AuthenticodeSignature $installer
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'CN=Microsoft Corporation(?:,|$)') {
        throw 'Windows SDK installer is not validly signed by Microsoft Corporation.'
    }
    $features = @('OptionId.UWPCPP', 'OptionId.DesktopCPPx86', 'OptionId.DesktopCPPx64', 'OptionId.DesktopCPParm64', 'OptionId.WindowsDesktopDebuggers')
    $proc = Start-Process -FilePath $installer -ArgumentList (@('/quiet', '/norestart', '/ceip', 'off', '/features') + $features) -Wait -PassThru
    $report.installerExitCode = $proc.ExitCode
    if ($proc.ExitCode -notin @(0, 3010)) { throw "Windows SDK installer failed: $($proc.ExitCode)" }
    foreach ($file in @('um/windows.h', 'shared/sdkddkver.h', 'ucrt/stdio.h', 'winrt/wrl.h')) {
        if (-not (Test-Path "$kits/Include/$sdkVersion/$file")) { throw "Missing SDK header: $file" }
    }
    $report.debuggers = @()
    foreach ($cpu in @('x86', 'x64', 'arm64')) {
        foreach ($file in @("um/$cpu/kernel32.lib", "ucrt/$cpu/ucrt.lib")) {
            if (-not (Test-Path "$kits/Lib/$sdkVersion/$file")) { throw "Missing SDK library: $file" }
        }
        if ($cpu -eq 'arm64' -and $TargetArch -eq 'x64') { continue }
        if (-not (Test-Path "$kits/bin/$sdkVersion/$cpu/rc.exe")) { throw "Missing SDK resource compiler: $cpu" }
        # The SDK installer omits x64 Debuggers on ARM64 hosts. Like runner-images,
        # stage the official SDK-bin copy; do not substitute a system/older DLL.
        $debugDir = New-Item -ItemType Directory -Force "$kits/Debuggers/$cpu"
        foreach ($dll in @('dbghelp.dll', 'dbgcore.dll', 'symsrv.dll')) {
            $dest = Join-Path $debugDir $dll
            $sourceDll = "$kits/bin/$sdkVersion/$cpu/$dll"
            if (-not (Test-Path $dest) -and (Test-Path $sourceDll)) { Copy-Item $sourceDll $dest }
        }
        $dbghelp = Get-Item "$debugDir/dbghelp.dll"
        if ($dbghelp.VersionInfo.FileVersionRaw -lt [version]'10.0.26100.3323') { throw "SDK debugger is too old: $cpu" }
        $bytes = [IO.File]::ReadAllBytes($dbghelp.FullName)
        $offset = [BitConverter]::ToInt32($bytes, 0x3c)
        $expectedMachine = @{ x86 = 0x14c; x64 = 0x8664; arm64 = 0xaa64 }[$cpu]
        if ([BitConverter]::ToUInt16($bytes, $offset + 4) -ne $expectedMachine) { throw "Incorrect debugger architecture: $cpu" }
        $report.debuggers += @{ arch = $cpu; version = $dbghelp.VersionInfo.FileVersionRaw.ToString() }
    }
    $report.status = 'passed'
} catch {
    $report.error = $_.Exception.Message
    throw
} finally {
    $report | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $reportDir "windows-sdk-$TargetArch.json")
}
