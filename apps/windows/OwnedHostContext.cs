using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;

// One tray belongs to the process that owns the continuing assistant lease.
// Reopen-only launchers exit without displaying a second tray.
sealed class OwnedHostContext : ApplicationContext {
    readonly ProcessStartInfo start;
    readonly Action verify;
    readonly bool background;
    readonly Control dispatcher = new Control();
    readonly Timer retry = new Timer();
    readonly NotifyIcon tray = new NotifyIcon();
    readonly ContextMenuStrip menu = new ContextMenuStrip();
    readonly ToolStripMenuItem status = new ToolStripMenuItem("Tada를 열고 있어요") { Enabled = false };
    readonly ToolStripMenuItem open = new ToolStripMenuItem("Tada 열기");
    readonly ToolStripMenuItem quit = new ToolStripMenuItem("작업을 멈추고 종료");
    readonly Icon icon;
    Process child;
    int attempts;
    bool everOpened, ready, currentReady, owned, quitting, finished, openPending, opening;
    internal int ExitCode { get; private set; }
    internal bool TrayVisible { get { return tray.Visible; } }
    internal bool Recovering { get { return retry.Enabled; } }
    [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr handle);
    static Icon CreateIcon() {
        using (var bitmap = new Bitmap(32, 32)) {
            using (var graphics = Graphics.FromImage(bitmap)) {
                graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                using (var brush = new SolidBrush(Color.FromArgb(52, 82, 65))) graphics.FillEllipse(brush, 0, 0, 31, 31);
                using (var font = new Font("Georgia", 21, FontStyle.Regular, GraphicsUnit.Pixel))
                    graphics.DrawString("t.", font, Brushes.White, 6, 2);
            }
            var handle = bitmap.GetHicon();
            try { using (var source = Icon.FromHandle(handle)) return (Icon)source.Clone(); }
            finally { DestroyIcon(handle); }
        }
    }
    internal OwnedHostContext(ProcessStartInfo start, Action verify, bool background) {
        this.start = start; this.verify = verify; this.background = background;
        dispatcher.CreateControl();
        icon = CreateIcon(); tray.Icon = icon; tray.Text = "Tada · 곁에 두는 비서";
        quit.ToolTipText = "실행 중인 작업은 중단합니다. 대화와 계정은 유지하고, 대기 중인 요청은 다음 실행 때 이어갑니다.";
        menu.Items.AddRange(new ToolStripItem[] { status, new ToolStripSeparator(), open, quit });
        tray.ContextMenuStrip = menu;
        open.Click += (sender, e) => OpenWindow();
        tray.DoubleClick += (sender, e) => OpenWindow();
        tray.BalloonTipClicked += (sender, e) => OpenWindow();
        quit.Click += (sender, e) => Stop();
        retry.Tick += (sender, e) => { retry.Stop(); StartChild(); };
        dispatcher.BeginInvoke(new Action(StartChild));
    }
    void Post(Action action) {
        try { if (!dispatcher.IsDisposed) dispatcher.BeginInvoke(action); }
        catch (InvalidOperationException) { /* The owning message loop has ended. */ }
    }
    void StartChild() {
        if (quitting || finished) return;
        Process process = null;
        try {
            verify();
            process = new Process { StartInfo = start };
            child = process; owned = currentReady = false;
            var current = process;
            // Discard every other stdout/stderr line: they can contain secrets.
            process.OutputDataReceived += (sender, e) => {
                if (e.Data == "\u001eTADA_HOST_OPEN_V1") Post(() => {
                    if (child != current || quitting || finished) return;
                    everOpened = owned = true; tray.Visible = true;
                    status.Text = "컴퓨터에서 실행 중"; tray.Text = "Tada · 실행 중";
                    if (openPending) OpenWindow();
                });
                else if (e.Data == "\u001eTADA_ASSISTANT_READY_V1") Post(() => { if (child == current) ready = currentReady = true; });
                else if (e.Data == "\u001eTADA_NEWS_V1") Post(() => {
                    if (child != current || !currentReady || quitting || finished || current.HasExited) return;
                    // Ready may precede the window-open receipt during startup.
                    tray.Visible = true;
                    tray.BalloonTipTitle = "Tada"; tray.BalloonTipText = "새 소식이 있어요. Tada에서 확인해 주세요.";
                    tray.BalloonTipIcon = ToolTipIcon.Info; tray.ShowBalloonTip(5000);
                });
                else if (e.Data == "\u001eTADA_OPEN_FAILED_V1") Post(() => {
                    if (child != current || quitting || finished) return;
                    tray.ShowBalloonTip(5000, "Tada", "창을 열지 못했어요. Windows의 기본 브라우저 설정을 확인하고 다시 열어 주세요.", ToolTipIcon.Warning);
                });
            };
            process.ErrorDataReceived += (sender, e) => {};
            process.Start(); process.BeginOutputReadLine(); process.BeginErrorReadLine();
            Task.Factory.StartNew(() => {
                try { current.WaitForExit(); Post(() => ChildExited(current)); }
                catch (InvalidOperationException) { /* Already released after startup failure. */ }
            });
        } catch {
            if (process != null) { try { process.StandardInput.Close(); } catch (IOException) {} catch (InvalidOperationException) {} process.Dispose(); }
            child = null; Finish(1);
        }
    }
    void ChildExited(Process process) {
        if (child != process) return;
        var code = process.ExitCode; child = null; owned = false; process.Dispose();
        if (quitting || code == 0) { Finish(0); return; }
        if ((!background && !everOpened) || attempts >= 3) { Finish(1); return; }
        if (!background && ready && !start.Arguments.EndsWith(" --background", StringComparison.Ordinal)) start.Arguments += " --background";
        status.Text = "다시 연결하고 있어요"; tray.Text = "Tada · 다시 연결 중";
        retry.Interval = new[] { 1000, 5000, 15000 }[attempts++]; retry.Start();
    }
    internal void OpenWindow() {
        if (quitting || finished || opening) return;
        if (child == null || !owned) { openPending = true; return; }
        openPending = false; opening = true;
        var current = child;
        Task.Factory.StartNew(() => {
            try { current.StandardInput.WriteLine("TADA_OPEN_V1"); current.StandardInput.Flush(); }
            catch (IOException) {} catch (InvalidOperationException) {}
            finally { Post(() => { opening = false; }); }
        });
    }
    internal void Stop() {
        if (quitting || finished) return;
        // Latch before touching the pipe so neither exit nor backoff can restart.
        quitting = true; retry.Stop(); openPending = false; open.Enabled = quit.Enabled = false;
        status.Text = "작업 기록을 남기고 종료 중"; tray.Text = "Tada · 종료 중";
        if (child == null) { Finish(0); return; }
        try { child.StandardInput.Close(); }
        catch (IOException) {} catch (InvalidOperationException) {}
    }
    void Finish(int code) {
        if (finished) return;
        finished = true; ExitCode = code; retry.Stop(); tray.Visible = false; ExitThread();
    }
    protected override void Dispose(bool disposing) {
        if (disposing) {
            quitting = true; retry.Stop(); tray.Visible = false;
            if (child != null) { try { child.StandardInput.Close(); } catch (IOException) {} catch (InvalidOperationException) {} }
            retry.Dispose(); tray.Dispose(); menu.Dispose(); icon.Dispose(); dispatcher.Dispose();
        }
        base.Dispose(disposing);
    }
}
