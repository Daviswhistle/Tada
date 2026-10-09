# Real Windows Forms tray/menu and child lifecycle; only synthetic private files.
param([Parameter(Mandatory=$true)][string]$Report, [Parameter(Mandatory=$true)][string]$Preview,
 [Parameter(Mandatory=$true)][string]$Node)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$source=Split-Path -Parent $PSScriptRoot
$root=Join-Path ([IO.Path]::GetTempPath()) ('tada-tray-check-'+[Guid]::NewGuid().ToString('N'))
$compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
New-Item -ItemType Directory -Path $root|Out-Null
try {
 @'
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { superviseWindow } from './windows-control.mjs';
const [data, mode] = process.argv.slice(2);
mkdirSync(data, { recursive: true }); appendFileSync(join(data, 'attempts'), 'started\n');
if (mode === 'reopen') process.exit(0);
process.stdout.write('\x1eTADA_HOST_OPEN_V1\n\x1eTADA_ASSISTANT_READY_V1\n');
if (mode === 'backoff') process.exit(1);
const keepAlive = setInterval(() => {}, 1000);
process.stdin.on('data', bytes => appendFileSync(join(data, 'bytes'), bytes.toString('hex')));
superviseWindow(process.stdin, {
 open: () => appendFileSync(join(data, 'opened'), 'open\n'),
 stop: () => { writeFileSync(join(data, 'closed'), 'EOF observed'); clearInterval(keepAlive); },
 failed: () => { process.exitCode = 2; },
});
'@ | Set-Content -LiteralPath (Join-Path $root 'Child.mjs') -Encoding UTF8
 Copy-Item -LiteralPath (Join-Path $source 'packages/engine/src/windows-control.mjs') -Destination (Join-Path $root 'windows-control.mjs')
 @'
using System;using System.IO;using System.Diagnostics;using System.Drawing;using System.Reflection;using System.Runtime.InteropServices;using System.Windows.Forms;
class Fixture {
 [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr window,IntPtr dc,uint flags);
 [STAThread] static int Main(string[] args) {
  Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
  var mode=args[1];var encoding=args[4];Console.InputEncoding=System.Text.Encoding.GetEncoding(int.Parse(encoding));
  var data=Path.Combine(args[0],mode+encoding);bool opened=false,stopped=false,seen=false,failed=false;
  var start=new ProcessStartInfo(args[3],"\""+Path.Combine(args[0],"Child.mjs")+"\" \""+data+"\" "+mode) {UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true};
  using(var context=new OwnedHostContext(start,()=>{},false)) using(var timer=new Timer()) {
   var menu=(ContextMenuStrip)typeof(OwnedHostContext).GetField("menu",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(context);
   var watch=Stopwatch.StartNew();timer.Interval=25;
   timer.Tick+=(sender,e)=>{
    seen=seen||context.TrayVisible;
    if(watch.ElapsedMilliseconds>10000){failed=true;context.Stop();}
    if(mode=="active" && context.TrayVisible && !opened){
     opened=true;menu.Show(200,200);menu.Update();
     using(var image=new Bitmap(menu.Width,menu.Height))using(var graphics=Graphics.FromImage(image)){
      var dc=graphics.GetHdc();try{if(!PrintWindow(menu.Handle,dc,0))failed=true;}finally{graphics.ReleaseHdc(dc);}
      image.Save(args[2],System.Drawing.Imaging.ImageFormat.Png);
     }
     menu.Close();((ToolStripMenuItem)menu.Items[2]).PerformClick();
    }
    if((mode=="active" && File.Exists(Path.Combine(data,"opened")) || mode=="backoff" && context.Recovering) && !stopped){stopped=true;((ToolStripMenuItem)menu.Items[3]).PerformClick();}
   };
   timer.Start();Application.Run(context);timer.Stop();
   if(context.ExitCode!=0 || context.TrayVisible || failed)return 3;
  }
  System.Threading.Thread.Sleep(1200);
  if(File.ReadAllLines(Path.Combine(data,"attempts")).Length!=1)return 4;
  if(mode=="reopen")return seen?5:0;
  if(!seen || !stopped)return 6;
  if(mode=="active" && (!opened || !File.Exists(Path.Combine(data,"closed")) || File.ReadAllLines(Path.Combine(data,"opened")).Length!=1))return 7;
  if(mode=="active" && File.ReadAllText(Path.Combine(data,"bytes"))!=(encoding=="65001"?"efbbbf":"")+"544144415f4f50454e5f56310d0a")return 8;
  return 0;
 }
}
'@ | Set-Content -LiteralPath (Join-Path $root 'Fixture.cs') -Encoding UTF8
 & $compiler /nologo /warnaserror+ /codepage:65001 /target:exe /reference:System.Drawing.dll /reference:System.Windows.Forms.dll "/out:$root\Fixture.exe" (Join-Path $root 'Fixture.cs') (Join-Path $source 'apps/windows/OwnedHostContext.cs')
 if($LASTEXITCODE -ne 0){throw 'Native tray fixture compilation failed'}
 $checks=New-Object 'System.Collections.Generic.List[string]'
 foreach($encoding in @('949','65001')) { foreach($mode in @('active','backoff','reopen')) {
  # Hidden new console belongs only to this fixture: owner console/code page is untouched.
  $process=Start-Process -WindowStyle Hidden -FilePath (Join-Path $root 'Fixture.exe') -ArgumentList @(('"'+$root+'"'),$mode,('"'+[IO.Path]::GetFullPath($Preview)+'"'),('"'+[IO.Path]::GetFullPath($Node)+'"'),$encoding) -PassThru
  try {
   if(-not $process.WaitForExit(20000)){throw 'Tray fixture timed out'}
   if($process.ExitCode -ne 0){throw "Tray fixture $mode failed with $($process.ExitCode)"}
   $detail=if($mode -eq 'active'){'first command bytes, native open and EOF stop verified'}else{'native lifecycle verified'}
   $checks.Add("$mode encoding $encoding passed: exact one Node child; $detail")
  } finally {if(-not $process.HasExited){$process.Kill();$process.WaitForExit()};$process.Dispose()}
 }}
 @{passed=$true;checks=@($checks);scope='Real Windows Forms tray/menu and production Node receiver with synthetic work, CP949 and UTF-8 BOM; not live account or physical mobile acceptance'}|ConvertTo-Json|Set-Content -LiteralPath $Report -Encoding UTF8
 Write-Output 'Native tray open, explicit stop, backoff stop and reopen-only lifecycle passed'
} finally {Remove-Item -LiteralPath $root -Recurse -Force}
