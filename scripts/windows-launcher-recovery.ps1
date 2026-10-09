# Uses only synthetic child processes and temporary files; no browser/account.
param([Parameter(Mandatory=$true)][string]$Report)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$source=Split-Path -Parent $PSScriptRoot
$root=Join-Path ([IO.Path]::GetTempPath()) ('tada-launcher-check-'+[Guid]::NewGuid().ToString('N'))
$payload=Join-Path $root 'payload'
$compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$checks=New-Object 'System.Collections.Generic.List[string]'
New-Item -ItemType Directory -Path (Join-Path $payload 'node'),(Join-Path $payload 'bin'),(Join-Path $payload 'packages/engine/src') -Force|Out-Null
try {
 @'
using System;using System.IO;using System.Linq;
class Child {
 static int Main(string[] a) {
  var d=a[Array.IndexOf(a,"--data")+1];Directory.CreateDirectory(d);
  var p=Path.Combine(d,"attempts.txt");bool retry=File.Exists(p);var mode=Path.GetFileName(d);
  File.AppendAllText(p,a.Contains("--background")?"background\n":"foreground\n");
  if(mode=="normal") return 0;
  if((mode=="started" || mode=="onboarding") && !retry) Console.WriteLine("\u001eTADA_HOST_OPEN_V1");
  if(mode=="started" && !retry) Console.WriteLine("\u001eTADA_ASSISTANT_READY_V1");
  return (mode=="started" || mode=="onboarding") && retry?0:1;
 }
}
'@ | Set-Content -LiteralPath (Join-Path $root 'Child.cs') -Encoding UTF8
 & $compiler /nologo /target:exe "/out:$payload\node\node.exe" (Join-Path $root 'Child.cs')
 if($LASTEXITCODE -ne 0){throw 'Synthetic child compilation failed'}
 [IO.File]::WriteAllText((Join-Path $payload 'bin/tada-read-broker.exe'),'synthetic-unused')
 [IO.File]::WriteAllText((Join-Path $payload 'packages/engine/src/start-app.mjs'),'// synthetic child')
 $files=@(Get-ChildItem -LiteralPath $payload -File -Recurse|ForEach-Object {
  @{path=$_.FullName.Substring($payload.Length+1).Replace('\','/');size=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
 })
 $manifest=@{version=1;platform='win32-x64';appVersion='synthetic-fixture';files=$files}|ConvertTo-Json -Depth 5
 [IO.File]::WriteAllText((Join-Path $payload 'bundle.json'),$manifest,[Text.UTF8Encoding]::new($false))
 & $compiler /nologo /warnaserror+ /codepage:65001 /target:winexe /reference:System.Runtime.Serialization.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /reference:Microsoft.CSharp.dll "/resource:$payload\bundle.json,Tada.Bundle" "/out:$payload\Tada.exe" (Join-Path $source 'apps/windows/Launcher.cs') (Join-Path $source 'apps/windows/InstalledApp.cs') (Join-Path $source 'apps/windows/InstallPrompt.cs')
 if($LASTEXITCODE -ne 0){throw 'Launcher fixture compilation failed'}
 $verified=Start-Process -FilePath (Join-Path $payload 'Tada.exe') -ArgumentList '--verify' -PassThru -Wait
 if($verified.ExitCode -ne 0){throw 'Synthetic bundle verification failed'}
 foreach($mode in @('first','started','onboarding','normal','background')) {
  $data=Join-Path $root $mode
  $arguments=@('--data',('"'+$data+'"'));if($mode -eq 'background'){$arguments=@('--background')+$arguments}
  $child=Start-Process -FilePath (Join-Path $payload 'Tada.exe') -ArgumentList $arguments -PassThru
  try {
   if($mode -eq 'first') {
    for($i=0;$i -lt 100;$i++){ $child.Refresh();if($child.HasExited -or $child.MainWindowHandle -ne 0){break};Start-Sleep -Milliseconds 100 }
    if($child.HasExited -or $child.MainWindowHandle -eq 0){throw 'Initial failure must show a recovery window'}
    if(-not $child.CloseMainWindow()){throw 'Own recovery window did not close'}
   }
   if(-not $child.WaitForExit(35000)){throw 'Launcher recovery timed out'}
   $expectedCode=0;if($mode -in @('first','background')){$expectedCode=1}
   if($child.ExitCode -ne $expectedCode){throw "Wrong exit for $mode"}
   $attempts=[IO.File]::ReadAllLines((Join-Path $data 'attempts.txt'))
   $expectedCount=1;if($mode -in @('started','onboarding')){$expectedCount=2};if($mode -eq 'background'){$expectedCount=4}
   if($attempts.Length -ne $expectedCount){throw "Wrong attempts for $mode"}
   if($mode -eq 'started' -and $attempts[1] -ne 'background'){throw 'Recovered host must not reopen browser'}
   if($mode -eq 'onboarding' -and $attempts[1] -ne 'foreground'){throw 'Incomplete setup must remain visible and initialize its journal'}
   $checks.Add("$mode exit=$expectedCode attempts=$expectedCount")
  } finally {if(-not $child.HasExited){$child.Kill();$child.WaitForExit()};$child.Dispose()}
 }
 @{passed=$true;checks=@($checks)}|ConvertTo-Json|Set-Content -LiteralPath $Report -Encoding UTF8
 Write-Output 'Native launcher failure, started-crash, normal-exit and bounded-background recovery passed'
} finally {Remove-Item -LiteralPath $root -Recurse -Force}
