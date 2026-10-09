using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

static class Bootstrap {
    [STAThread] static int Main(string[] args) {
        bool quiet = args.Length > 0 && args[0].StartsWith("--startup-", StringComparison.Ordinal);
        try {
            var root = InstalledApp.Root(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location));
            var payload = InstalledApp.Current(root);
            if (quiet) {
                if (args.Length != 1) throw new IOException("Invalid startup arguments");
                Console.WriteLine(InstalledApp.Startup(root, args[0].Substring("--startup-".Length))); return 0;
            }
            if (!(args.Length == 0 || args.Length == 1 && (args[0] == "--background" || args[0] == "--verify") || args.Length == 2 && args[0] == "--data" && Path.IsPathRooted(args[1]))) throw new IOException("Invalid arguments");
            var arguments = String.Join(" ", Array.ConvertAll(args, InstalledApp.Quote));
            using (var child = Process.Start(new ProcessStartInfo(Path.Combine(payload, "Tada.exe"), arguments) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = payload })) {
                // Verification has a result; ordinary launch must not own browser lifetime.
                if (args.Length == 1 && args[0] == "--verify") { child.WaitForExit(); return child.ExitCode; }
            }
            return 0;
        } catch {
            if (!quiet) MessageBox.Show("설치된 Tada를 열지 못했어요. 실행 파일을 다시 설치해 주세요.\n\n대화와 계정 연결은 지우지 않습니다.", "Tada", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
