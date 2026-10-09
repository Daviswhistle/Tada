# Developer build only. End users need neither npm nor a compiler.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$NodeArchive,
  [Parameter(Mandatory=$true)][string]$Broker,
  [Parameter(Mandatory=$true)][string]$Output,
  [Parameter(Mandatory=$true)][string]$NativeNotices,
  [Parameter(Mandatory=$true)][string]$NpmCli
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$nodeHash = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'
if (-not [Environment]::Is64BitOperatingSystem) { throw 'Windows x64 required' }
if ((Get-FileHash -LiteralPath $NodeArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $nodeHash) { throw 'Node archive checksum mismatch' }
$Broker = (Resolve-Path -LiteralPath $Broker).Path
$NpmCli = (Resolve-Path -LiteralPath $NpmCli).Path
$NativeNotices = (Resolve-Path -LiteralPath $NativeNotices).Path
if (-not (Test-Path -LiteralPath (Join-Path $NativeNotices 'native-dependencies.json'))) { throw 'Native dependency notices missing' }
$Output = [IO.Path]::GetFullPath($Output)
if ($Output -eq [IO.Path]::GetPathRoot($Output)) { throw 'Output cannot be a drive or share root' }
$Output = $Output.TrimEnd([char[]]'\/')
if ((Test-Path -LiteralPath $Output) -or (Test-Path -LiteralPath ($Output + '.zip'))) { throw 'Output directory and archive must be new' }
$root = Split-Path -Parent $PSScriptRoot
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('tada-package-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporary | Out-Null
$env:NODE_OPTIONS = ''; $env:NODE_PATH = ''
try {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::ExtractToDirectory([IO.Path]::GetFullPath($NodeArchive), $temporary)
  $runtime = Join-Path $temporary 'node-v24.21.0-win-x64'
  $node = Join-Path $runtime 'node.exe'
  & $node (Join-Path $root 'scripts/windows-bundle.mjs') stage $Output
  if ($LASTEXITCODE -ne 0) { throw 'Runtime staging failed' }
  Push-Location $Output
  try {
    & $node $NpmCli ci --omit=dev --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Production dependency installation failed' }
  } finally { Pop-Location }
  New-Item -ItemType Directory -Path (Join-Path $Output 'node'),(Join-Path $Output 'bin') | Out-Null
  Copy-Item -LiteralPath (Join-Path $runtime 'node.exe'),(Join-Path $runtime 'LICENSE') -Destination (Join-Path $Output 'node')
  Copy-Item -LiteralPath $Broker -Destination (Join-Path $Output 'bin/tada-read-broker.exe')
  Copy-Item -LiteralPath $NativeNotices -Destination (Join-Path $Output 'native-notices') -Recurse
  $compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
  & $compiler /nologo /warnaserror+ /codepage:65001 /target:winexe /platform:x64 /optimize+ /reference:System.Windows.Forms.dll /reference:Microsoft.CSharp.dll "/out:$Output\bin\Tada-bootstrap.exe" (Join-Path $root 'apps/windows/Bootstrap.cs') (Join-Path $root 'apps/windows/InstalledApp.cs')
  if ($LASTEXITCODE -ne 0) { throw 'Installed launcher compilation failed' }
  & $node (Join-Path $root 'scripts/windows-bundle.mjs') manifest $Output
  if ($LASTEXITCODE -ne 0) { throw 'Manifest generation failed' }
  $compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
  & $compiler /nologo /warnaserror+ /codepage:65001 /target:winexe /platform:x64 /optimize+ /reference:System.Runtime.Serialization.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /reference:Microsoft.CSharp.dll "/resource:$Output\bundle.json,Tada.Bundle" "/out:$Output\Tada.exe" (Join-Path $root 'apps/windows/Launcher.cs') (Join-Path $root 'apps/windows/InstalledApp.cs') (Join-Path $root 'apps/windows/InstallPrompt.cs')
  if ($LASTEXITCODE -ne 0) { throw 'Launcher compilation failed' }
  $verification = Start-Process -FilePath (Join-Path $Output 'Tada.exe') -ArgumentList '--verify' -PassThru -Wait
  if ($verification.ExitCode -ne 0) { throw 'Bundle verification failed' }
  # Some upstream license files have Unix-epoch timestamps, outside ZIP's range.
  Add-Type -AssemblyName System.IO.Compression
  $archiveFile = [IO.File]::Open($Output + '.zip', [IO.FileMode]::CreateNew)
  try {
    $archive = New-Object IO.Compression.ZipArchive($archiveFile, [IO.Compression.ZipArchiveMode]::Create, $true)
    try {
      foreach ($file in Get-ChildItem -LiteralPath $Output -File -Recurse -Force | Sort-Object FullName) {
        $name = 'Tada/' + $file.FullName.Substring($Output.Length + 1).Replace('\', '/')
        $entry = $archive.CreateEntry($name, [IO.Compression.CompressionLevel]::Optimal)
        $entry.LastWriteTime = [DateTimeOffset]::new(1980, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
        $inputFile = [IO.File]::OpenRead($file.FullName)
        try { $entryStream = $entry.Open(); try { $inputFile.CopyTo($entryStream) } finally { $entryStream.Dispose() } }
        finally { $inputFile.Dispose() }
      }
    } finally { $archive.Dispose() }
  } finally { $archiveFile.Dispose() }
  Write-Output "Built and verified: $Output.zip"
} finally { Remove-Item -LiteralPath $temporary -Recurse -Force }
