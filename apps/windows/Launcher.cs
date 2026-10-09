using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Security.Cryptography;
using System.Text;
using System.Windows.Forms;

[DataContract] sealed class BundleFile {
    [DataMember(IsRequired = true)] public string path { get; set; }
    [DataMember(IsRequired = true)] public long size { get; set; }
    [DataMember(IsRequired = true)] public string sha256 { get; set; }
}
[DataContract] sealed class Bundle {
    [DataMember(IsRequired = true)] public int version { get; set; }
    [DataMember(IsRequired = true)] public string platform { get; set; }
    [DataMember(IsRequired = true)] public string appVersion { get; set; }
    [DataMember(IsRequired = true)] public BundleFile[] files { get; set; }
}
static class Launcher {
    static string Hash(Stream stream) {
        using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
    }
    static void NoLink(string path) {
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new IOException("Linked bundle entry");
    }
    internal static void Verify(string root) {
        NoLink(root);
        byte[] bytes;
        using (var input = Assembly.GetExecutingAssembly().GetManifestResourceStream("Tada.Bundle")) {
            if (input == null || input.Length > 2000000) throw new IOException("Manifest missing");
            using (var buffer = new MemoryStream()) { input.CopyTo(buffer); bytes = buffer.ToArray(); }
        }
        var external = Path.Combine(root, "bundle.json"); NoLink(external);
        if (new FileInfo(external).Length != bytes.Length || !File.ReadAllBytes(external).SequenceEqual(bytes)) throw new IOException("Manifest changed");
        Bundle manifest;
        using (var input = new MemoryStream(bytes)) manifest = (Bundle)new DataContractJsonSerializer(typeof(Bundle)).ReadObject(input);
        if (manifest.version != 1 || manifest.platform != "win32-x64" || manifest.files == null || manifest.files.Length > 10000) throw new IOException("Unsupported bundle");
        var remaining = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var file in manifest.files) {
            if (String.IsNullOrEmpty(file.path) || file.path.Contains('\\') || file.path.Contains(':') || file.path.StartsWith("/") ||
                file.path.Split('/').Any(p => p.Length == 0 || p == "." || p == ".." || p.EndsWith(".") || p.EndsWith(" ")) ||
                file.size < 0 || file.sha256 == null || file.sha256.Length != 64 || !remaining.Add(file.path)) throw new IOException("Invalid manifest entry");
        }
        if (!remaining.Contains("node/node.exe") || !remaining.Contains("bin/tada-read-broker.exe") ||
            !remaining.Contains("packages/engine/src/start-app.mjs")) throw new IOException("Runtime missing");
        var directories = new Stack<string>(); directories.Push(root);
        while (directories.Count != 0) {
            var directory = directories.Pop();
            foreach (var path in Directory.EnumerateFileSystemEntries(directory)) {
                NoLink(path);
                if (Directory.Exists(path)) directories.Push(path);
                else {
                    var name = path.Substring(root.Length + 1).Replace('\\', '/');
                    if (name == "Tada.exe" || name == "bundle.json") continue;
                    if (!remaining.Remove(name)) throw new IOException("Unexpected file");
                }
            }
        }
        if (remaining.Count != 0) throw new IOException("Missing file");
        foreach (var file in manifest.files) {
            var path = Path.Combine(root, file.path.Replace('/', Path.DirectorySeparatorChar));
            if (new FileInfo(path).Length != file.size) throw new IOException("File size changed");
            using (var input = File.OpenRead(path)) if (Hash(input) != file.sha256) throw new IOException("File changed");
        }
    }
    [STAThread] static int Main(string[] args) {
        bool verify = args.Length == 1 && args[0] == "--verify";
        bool background = args.Length > 0 && args[0] == "--background";
        bool installOnly = args.Length == 2 && args[0] == "--install-root";
        try {
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            if (!Environment.Is64BitOperatingSystem) throw new IOException("64-bit Windows required");
            var root = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            Verify(root);
            if (verify) return 0;
            if (installOnly || args.Length == 1 && args[0] == "--install") {
                InstalledApp.Install(root, installOnly ? args[1] : InstalledApp.DefaultRoot, !installOnly);
                if (!installOnly) Process.Start(new ProcessStartInfo(Path.Combine(InstalledApp.DefaultRoot, "Tada.exe")) { UseShellExecute = true });
                return 0;
            }
            if (args.Length == 0) {
                var versions = Path.GetDirectoryName(root);
                bool installed = Path.GetFileName(versions) == "versions" && System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(root), "\\A[0-9a-f]{64}(?:-[0-9a-f]{32})?\\z");
                if (installed) InstalledApp.CheckRoot(Path.GetDirectoryName(versions));
                else if (InstallPrompt.Show(root)) return 0;
            }
            var data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Tada", "conversation");
            var routeArgs = background ? args.Skip(1).ToArray() : args;
            if (routeArgs.Length != 0) {
                if (routeArgs.Length != 2 || routeArgs[0] != "--data" || !Path.IsPathRooted(routeArgs[1])) throw new IOException("Invalid launch arguments");
                data = Path.GetFullPath(routeArgs[1]);
            }
            var start = new ProcessStartInfo(Path.Combine(root, "node", "node.exe"),
                "--experimental-strip-types " + InstalledApp.Quote(Path.Combine(root, "packages", "engine", "src", "start-app.mjs")) + " --data " + InstalledApp.Quote(data) + (background ? " --background" : ""));
            start.WorkingDirectory = root; start.UseShellExecute = false; start.CreateNoWindow = true;
            start.RedirectStandardOutput = true; start.RedirectStandardError = true; start.RedirectStandardInput = true;
            start.EnvironmentVariables["TADA_WINDOWS_SUPERVISED"] = "1";
            foreach (var key in new[] { "NODE_OPTIONS", "NODE_PATH", "TADA_GOOGLE_OAUTH_CLIENT_ID", "TADA_GOOGLE_OAUTH_CLIENT_SECRET" }) start.EnvironmentVariables.Remove(key);
            int opened = 0, ready = 0;
            for (int attempt = 0; ; attempt++) {
              using (var process = new Process()) {
                process.StartInfo = start;
                // Capability URLs and account details must not be persisted in launcher logs.
                process.OutputDataReceived += (sender, e) => { if (e.Data == "\u001eTADA_HOST_OPEN_V1") System.Threading.Interlocked.Exchange(ref opened, 1); if (e.Data == "\u001eTADA_ASSISTANT_READY_V1") System.Threading.Interlocked.Exchange(ref ready, 1); }; process.ErrorDataReceived += (sender, e) => {};
                process.Start(); process.BeginOutputReadLine(); process.BeginErrorReadLine(); process.WaitForExit();
                if (process.ExitCode == 0) return 0;
                if (!background && System.Threading.Interlocked.CompareExchange(ref opened, 0, 0) == 0) throw new IOException("Initial application window failed");
                if (attempt >= 3) throw new IOException("Application failed");
              }
              if (!background && System.Threading.Interlocked.CompareExchange(ref ready, 0, 0) != 0 && !start.Arguments.EndsWith(" --background", StringComparison.Ordinal)) start.Arguments += " --background";
              System.Threading.Thread.Sleep(new[] { 1000, 5000, 15000 }[attempt]);
              Verify(root);
            }
        } catch {
            if (!verify && !installOnly && !background) MessageBox.Show("Tada를 열지 못했어요.\n\n압축 파일을 새 폴더에 모두 풀고 Tada.exe를 다시 열어 주세요. 브라우저가 열리지 않으면 Windows의 기본 브라우저 설정도 확인해 주세요.\n\n저장된 대화와 계정 연결은 지우지 않습니다.", "Tada", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
