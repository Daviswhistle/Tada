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
    static void Verify(string root) {
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
    // Windows command-line quoting, including trailing backslashes and spaces.
    static string Quote(string value) {
        var output = new StringBuilder("\""); int slashes = 0;
        foreach (var c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { output.Append('\\', slashes * 2 + 1); output.Append(c); }
            else { output.Append('\\', slashes); output.Append(c); }
            slashes = 0;
        }
        output.Append('\\', slashes * 2); return output.Append('"').ToString();
    }
    [STAThread] static int Main(string[] args) {
        bool verify = args.Length == 1 && args[0] == "--verify";
        try {
            if (!Environment.Is64BitOperatingSystem) throw new IOException("64-bit Windows required");
            var root = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            Verify(root);
            if (verify) return 0;
            var data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Tada", "conversation");
            if (args.Length != 0) {
                if (args.Length != 2 || args[0] != "--data" || !Path.IsPathRooted(args[1])) throw new IOException("Invalid launch arguments");
                data = Path.GetFullPath(args[1]);
            }
            var start = new ProcessStartInfo(Path.Combine(root, "node", "node.exe"),
                "--experimental-strip-types " + Quote(Path.Combine(root, "packages", "engine", "src", "start-app.mjs")) + " --data " + Quote(data));
            start.WorkingDirectory = root; start.UseShellExecute = false; start.CreateNoWindow = true;
            start.RedirectStandardOutput = true; start.RedirectStandardError = true;
            foreach (var key in new[] { "NODE_OPTIONS", "NODE_PATH", "TADA_GOOGLE_OAUTH_CLIENT_ID", "TADA_GOOGLE_OAUTH_CLIENT_SECRET" }) start.EnvironmentVariables.Remove(key);
            using (var process = new Process()) {
                process.StartInfo = start;
                // Capability URLs and account details must not be persisted in launcher logs.
                process.OutputDataReceived += (sender, e) => {}; process.ErrorDataReceived += (sender, e) => {};
                process.Start(); process.BeginOutputReadLine(); process.BeginErrorReadLine(); process.WaitForExit();
                if (process.ExitCode != 0) throw new IOException("Application failed");
            }
            return 0;
        } catch {
            if (!verify) MessageBox.Show("Tada를 열지 못했어요.\n\n압축 파일을 새 폴더에 모두 풀고 Tada.exe를 다시 열어 주세요. 브라우저가 열리지 않으면 Windows의 기본 브라우저 설정도 확인해 주세요.\n\n저장된 대화와 계정 연결은 지우지 않습니다.", "Tada", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
