using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;

static class InstallPrompt {
    internal static bool Show(string source) {
        bool portable = false, busy = false;
        using (var form = new Form()) {
            form.Text = "Tada"; form.ClientSize = new Size(580, 300); form.StartPosition = FormStartPosition.CenterScreen;
            form.AutoScaleMode = AutoScaleMode.Dpi;
            form.FormBorderStyle = FormBorderStyle.FixedDialog; form.MaximizeBox = false;
            form.Font = new Font("맑은 고딕", 10); form.BackColor = Color.FromArgb(250, 249, 246);
            var title = new Label { Text = "곁에 두는 비서, Tada", Location = new Point(32, 30), Size = new Size(520, 40), Font = new Font("맑은 고딕", 19, FontStyle.Bold) };
            var message = new Label { Text = "이 컴퓨터에 설치하면 시작 메뉴에서 바로 열 수 있어요.\n대화와 연결한 계정은 프로그램 파일과 따로 보관합니다.\n\n로그인할 때 자동으로 켤지는 연결을 마친 뒤 설정에서 정해요.", Location = new Point(32, 90), Size = new Size(520, 105) };
            var install = new Button { Text = "설치하고 시작하기", Location = new Point(32, 228), Size = new Size(230, 42) };
            var once = new Button { Text = "설치 없이 열기", Location = new Point(280, 228), Size = new Size(230, 42) };
            install.FlatStyle = FlatStyle.Flat; install.FlatAppearance.BorderSize = 0;
            install.BackColor = Color.FromArgb(52, 82, 65); install.ForeColor = Color.White;
            once.FlatStyle = FlatStyle.Flat; once.FlatAppearance.BorderColor = Color.FromArgb(205, 210, 202);
            form.Controls.AddRange(new Control[] { title, message, install, once }); form.AcceptButton = install;
            once.Click += (sender, e) => { portable = true; form.Close(); };
            form.FormClosing += (sender, e) => { if (busy) e.Cancel = true; };
            install.Click += (sender, e) => {
                busy = true; install.Enabled = once.Enabled = false; message.Text = "Tada를 준비하고 있어요. 잠시만 기다려 주세요.\n기존 대화와 계정 연결은 그대로 유지합니다.";
                Task.Factory.StartNew(() => {
                    try {
                        InstalledApp.Install(source, InstalledApp.DefaultRoot, true, Launcher.Verify);
                        Process.Start(new ProcessStartInfo(Path.Combine(InstalledApp.DefaultRoot, "Tada.exe")) { UseShellExecute = true });
                        form.BeginInvoke(new Action(() => { busy = false; form.Close(); }));
                    } catch {
                        form.BeginInvoke(new Action(() => {
                            busy = false; install.Enabled = once.Enabled = true;
                            message.Text = "설치를 마치지 못했어요. 같은 Windows 계정으로 다시 시도해 주세요.\n다른 Tada 설치 창이 있다면 먼저 닫아 주세요.\n\n기존 대화와 계정 연결은 지우지 않았습니다.";
                        }));
                    }
                });
            };
            form.ShowDialog();
        }
        return !portable;
    }
}
