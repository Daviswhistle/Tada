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
import { pathToFileURL } from 'node:url';
import { superviseWindow } from './windows-control.mjs';
const [data, mode, source] = process.argv.slice(2);
mkdirSync(data, { recursive: true });
process.on('uncaughtException',error=>{appendFileSync(join(data,'child-error'),String(error.stack)+'\n');process.exit(1);});
process.on('unhandledRejection',error=>{appendFileSync(join(data,'child-error'),String(error?.stack??error)+'\n');process.exit(1);});
appendFileSync(join(data, 'attempts'), 'started\n');
if (mode === 'reopen') process.exit(0);
if (mode === 'news') process.stdout.write('\x1eTADA_NEWS_V1\n'); // Not ready: must be ignored.
process.stdout.write('\x1eTADA_HOST_OPEN_V1\n\x1eTADA_ASSISTANT_READY_V1\n');
if (mode === 'backoff') process.exit(1);
let store, service;
if (mode === 'news') {
 const {ContactStore,contactRoute}=await import(pathToFileURL(join(source,'packages/engine/src/contact-store.mjs')));
 const {ContactService}=await import(pathToFileURL(join(source,'packages/engine/src/contact-service.mjs')));
 store=new ContactStore({directory:join(data,'journal'),passphrase:'SYNTHETIC_TRAY_NEWS_ONLY',route:contactRoute({fixture:'tray-news'}),initialize:true,assistance:true});
 const device=store.addDevice('synthetic desktop').id;
 service=new ContactService(store,{}, {definitions:[],validate:()=>false,verify:async()=>false}, {desktopNotify:()=>process.stdout.write('\x1eTADA_NEWS_V1\n')});
 const now=Date.now();
 const {randomUUID}=await import('node:crypto');const {GOOGLE_SCOPES}=await import(pathToFileURL(join(source,'packages/engine/src/google-contract.mjs')));
 store.saveGoogleCredential(device,{version:1,epoch:randomUUID(),device,scopes:[...GOOGLE_SCOPES],refresh_token:'SYNTHETIC_TRAY_TOKEN_ONLY',email:'owner@example.test',connected_at:now,last_checked:null,last_error:null,reconnect_required:false},null);
 store.configureProactive(device,true,'connected_attention_v2','UTC',now);
 store.finishAttention(store.claimAttention(now),{fingerprint:'a'.repeat(64),observed_at:now,events:[{id:'fixture-event',title:'SYNTHETIC_PRIVATE_EVENT',start:now+20*60000,day:null}],truncated:false,account:'owner@example.test'},now);
 const queued=store.claim();if(queued)store.fail(queued.seq,'FIXTURE_CANCELLED');
 writeFileSync(join(data,'journal-id'),store.id);service.start();await service.idle();service.emit('change');writeFileSync(join(data,'desktop-state'),JSON.stringify(service.desktopNotifications));
}
const keepAlive = setInterval(() => {}, 1000);
process.stdin.on('data', bytes => appendFileSync(join(data, 'bytes'), bytes.toString('hex')));
superviseWindow(process.stdin, {
 open: () => appendFileSync(join(data, 'opened'), (store?.id ?? 'open')+'\n'),
 stop: () => { void (async()=>{await service?.close();store?.close();writeFileSync(join(data, 'closed'), 'EOF observed');clearInterval(keepAlive);})(); },
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
  var data=Path.Combine(args[0],mode+encoding);bool opened=false,stopped=false,seen=false,failed=false;int balloons=0,clicks=0;string failure="";
  var start=new ProcessStartInfo(args[3],"--experimental-strip-types \""+Path.Combine(args[0],"Child.mjs")+"\" \""+data+"\" "+mode+" \""+args[5]+"\"") {UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true};
  using(var context=new OwnedHostContext(start,()=>{},false)) using(var timer=new Timer()) {
   var menu=(ContextMenuStrip)typeof(OwnedHostContext).GetField("menu",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(context);
   var tray=(NotifyIcon)typeof(OwnedHostContext).GetField("tray",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(context);
   tray.BalloonTipShown+=(sender,e)=>{balloons++;};tray.BalloonTipClicked+=(sender,e)=>{clicks++;};
   var watch=Stopwatch.StartNew();timer.Interval=25;
   timer.Tick+=(sender,e)=>{
    seen=seen||context.TrayVisible;
    if(watch.ElapsedMilliseconds>10000){failed=true;failure+=" timeout";context.Stop();}
    if(mode=="active" && context.TrayVisible && !opened){
     opened=true;menu.Show(200,200);menu.Update();
     using(var image=new Bitmap(menu.Width,menu.Height))using(var graphics=Graphics.FromImage(image)){
      var dc=graphics.GetHdc();try{if(!PrintWindow(menu.Handle,dc,0))failed=true;}finally{graphics.ReleaseHdc(dc);}
      image.Save(args[2],System.Drawing.Imaging.ImageFormat.Png);
     }
     menu.Close();((ToolStripMenuItem)menu.Items[2]).PerformClick();
    }
    if(mode=="news" && balloons>0 && !opened){
     if(tray.BalloonTipTitle!="Tada" || tray.BalloonTipText!="\uc0c8 \uc18c\uc2dd\uc774 \uc788\uc5b4\uc694. Tada\uc5d0\uc11c \ud655\uc778\ud574 \uc8fc\uc138\uc694."){failed=true;failure+=" text";}
     opened=true;
     File.WriteAllText(Path.Combine(data,"click-state"),"owned="+typeof(OwnedHostContext).GetField("owned",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(context)+" opening="+typeof(OwnedHostContext).GetField("opening",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(context));
     // Exercise the production click handler after actual OS BalloonTipShown.
     // This is an injected click event, not a physical user click receipt.
     try { typeof(NotifyIcon).GetMethod("OnBalloonTipClicked",BindingFlags.Instance|BindingFlags.NonPublic).Invoke(tray,null); }
     catch(Exception error){File.AppendAllText(Path.Combine(data,"click-state")," exception="+error);failed=true;context.Stop();}
     File.AppendAllText(Path.Combine(data,"click-state")," clicks="+clicks+" afterOpening="+typeof(OwnedHostContext).GetField("opening",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(context)+" pending="+typeof(OwnedHostContext).GetField("openPending",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(context));
    }
    if(((mode=="active" || mode=="news") && File.Exists(Path.Combine(data,"opened")) || mode=="backoff" && context.Recovering) && !stopped){stopped=true;((ToolStripMenuItem)menu.Items[3]).PerformClick();}
   };
   timer.Start();Application.Run(context);timer.Stop();
   if(context.ExitCode!=0 || context.TrayVisible || failed){File.WriteAllText(Path.Combine(data,"diagnostic"),"reason="+failure+" opened="+opened+" stopped="+stopped+" openFile="+File.Exists(Path.Combine(data,"opened"))+" exit="+context.ExitCode+" visible="+context.TrayVisible+" failed="+failed+" balloons="+balloons+" title="+tray.BalloonTipTitle+" body="+tray.BalloonTipText);return 3;}
  }
  System.Threading.Thread.Sleep(1200);
  if(File.ReadAllLines(Path.Combine(data,"attempts")).Length!=1)return 4;
  if(mode=="reopen")return seen?5:0;
  if(!seen || !stopped)return 6;
  if(mode=="active" && (!opened || !File.Exists(Path.Combine(data,"closed")) || File.ReadAllLines(Path.Combine(data,"opened")).Length!=1))return 7;
  if(mode=="active" && File.ReadAllText(Path.Combine(data,"bytes"))!=(encoding=="65001"?"efbbbf":"")+"544144415f4f50454e5f56310d0a")return 8;
  if(mode=="news" && (balloons!=1 || !opened || !File.Exists(Path.Combine(data,"closed")) || File.ReadAllText(Path.Combine(data,"opened")).Trim()!=File.ReadAllText(Path.Combine(data,"journal-id"))))return 9;
  return 0;
 }
}
'@ | Set-Content -LiteralPath (Join-Path $root 'Fixture.cs') -Encoding UTF8
 & $compiler /nologo /warnaserror+ /codepage:65001 /target:exe /reference:System.Drawing.dll /reference:System.Windows.Forms.dll "/out:$root\Fixture.exe" (Join-Path $root 'Fixture.cs') (Join-Path $source 'apps/windows/OwnedHostContext.cs')
 if($LASTEXITCODE -ne 0){throw 'Native tray fixture compilation failed'}
 $checks=New-Object 'System.Collections.Generic.List[string]'
 foreach($encoding in @('949','65001')) { foreach($mode in @('active','backoff','reopen','news')) {
  if($mode -eq 'news' -and $encoding -eq '65001'){continue}
  # Hidden new console belongs only to this fixture: owner console/code page is untouched.
  $process=Start-Process -WindowStyle Hidden -FilePath (Join-Path $root 'Fixture.exe') -ArgumentList @(('"'+$root+'"'),$mode,('"'+[IO.Path]::GetFullPath($Preview)+'"'),('"'+[IO.Path]::GetFullPath($Node)+'"'),$encoding,('"'+$source+'"')) -PassThru
  try {
   if(-not $process.WaitForExit(20000)){throw 'Tray fixture timed out'}
   if($process.ExitCode -ne 0){foreach($name in @('diagnostic','child-error','desktop-state','bytes','click-state')){$detailPath=Join-Path (Join-Path $root ($mode+$encoding)) $name;if(Test-Path -LiteralPath $detailPath){Write-Output ($name+': '+[IO.File]::ReadAllText($detailPath))}};throw "Tray fixture $mode failed with $($process.ExitCode)"}
   $detail=if($mode -eq 'news'){'production ContactService reminder, OS BalloonTipShown, private generic body and injected click reopening the same journal verified'}elseif($mode -eq 'active'){'first command bytes, native open and EOF stop verified'}else{'native lifecycle verified'}
   $checks.Add("$mode encoding $encoding passed: exact one Node child; $detail")
  } finally {if(-not $process.HasExited){$process.Kill();$process.WaitForExit()};$process.Dispose()}
 }}
 @{passed=$true;checks=@($checks);scope='Real Windows Forms tray/menu, OS BalloonTipShown and production ContactService/Node receiver with synthetic work; balloon click event injected, not physical click or live account/mobile acceptance'}|ConvertTo-Json|Set-Content -LiteralPath $Report -Encoding UTF8
 Write-Output 'Native tray open, explicit stop, backoff stop and reopen-only lifecycle passed'
} finally {Remove-Item -LiteralPath $root -Recurse -Force}
