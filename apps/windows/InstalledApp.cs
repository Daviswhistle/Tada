using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32;

// State lives beside versioned payloads, never inside their exact-file manifest.
static class InstalledApp {
    internal static string DefaultRoot { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Tada", "app"); } }
    internal static string Quote(string value) {
        var output = new StringBuilder("\""); int slashes = 0;
        foreach (var c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { output.Append('\\', slashes * 2 + 1); output.Append(c); }
            else { output.Append('\\', slashes); output.Append(c); }
            slashes = 0;
        }
        output.Append('\\', slashes * 2); return output.Append('"').ToString();
    }
    internal static string Hash(string path) {
        using (var input = File.OpenRead(path)) using (var hash = SHA256.Create())
            return BitConverter.ToString(hash.ComputeHash(input)).Replace("-", "").ToLowerInvariant();
    }
    internal static string Root(string path) {
        var root = Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar);
        if (!Path.IsPathRooted(path) || root.Length < 4 || root.StartsWith("\\\\", StringComparison.Ordinal)) throw new IOException("Local installation path required");
        for (var at = root; at != null; at = Path.GetDirectoryName(at))
            if ((Directory.Exists(at) || File.Exists(at)) && (File.GetAttributes(at) & FileAttributes.ReparsePoint) != 0) throw new IOException("Linked installation");
        return root;
    }
    static string Marker(string root) { return "Tada per-user installation v1\n" + root + "\n"; }
    internal static void CheckRoot(string root) {
        Root(root);
        var marker = Path.Combine(root, "installed.txt");
        if (!File.Exists(marker) || new FileInfo(marker).Length > 4096 || File.ReadAllText(marker) != Marker(root)) throw new IOException("Installation not owned");
        foreach (var file in new[] { "installed.txt", "current.txt", "Tada.exe", "versions" }) {
            var path = Path.Combine(root, file);
            if ((File.Exists(path) || Directory.Exists(path)) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new IOException("Linked installation state");
        }
    }
    internal static string Current(string root) {
        CheckRoot(root);
        var pointer = Path.Combine(root, "current.txt");
        if (new FileInfo(pointer).Length > 256) throw new IOException("Invalid installed version");
        var text = File.ReadAllText(pointer);
        var match = Regex.Match(text, "\\ATada installed version 1\n([0-9a-f]{64}(?:-[0-9a-f]{32})?)\n([0-9a-f]{64})\n\\z");
        if (!match.Success) throw new IOException("Invalid installed version");
        var payload = Path.Combine(root, "versions", match.Groups[1].Value); Root(payload);
        if (Hash(Path.Combine(payload, "bundle.json")) != match.Groups[1].Value.Split('-')[0] || Hash(Path.Combine(payload, "Tada.exe")) != match.Groups[2].Value) throw new IOException("Installed version changed");
        return payload;
    }
    internal static int VerifyPayload(string payload) {
        var start = new ProcessStartInfo(Path.Combine(payload, "Tada.exe"), "--verify") { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = payload };
        using (var child = Process.Start(start)) {
            if (!child.WaitForExit(30000)) { child.Kill(); child.WaitForExit(); throw new IOException("Verification timed out"); }
            return child.ExitCode;
        }
    }
    static bool Reusable(string payload, string source) {
        try {
            var executable = Path.Combine(payload, "Tada.exe"); Root(executable);
            // Check known executable bytes BEFORE asking it to verify the rest.
            return Hash(executable) == Hash(Path.Combine(source, "Tada.exe")) && VerifyPayload(payload) == 0;
        } catch (IOException) { return false; } catch (UnauthorizedAccessException) { return false; }
    }
    static void CopyTree(string source, string destination) {
        if ((File.GetAttributes(source) & FileAttributes.ReparsePoint) != 0) throw new IOException("Linked source");
        Directory.CreateDirectory(destination);
        foreach (var path in Directory.EnumerateFileSystemEntries(source)) {
            if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new IOException("Linked source");
            var target = Path.Combine(destination, Path.GetFileName(path));
            if (Directory.Exists(path)) CopyTree(path, target); else File.Copy(path, target, false);
        }
    }
    static void AtomicText(string path, string text) {
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try {
            File.WriteAllText(temporary, text, new UTF8Encoding(false));
            if (File.Exists(path)) File.Replace(temporary, path, null); else File.Move(temporary, path);
        } finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
    internal static void Install(string source, string requestedRoot, bool shortcut) {
        var root = Root(requestedRoot);
        var sourceRoot = Root(source);
        if (root.Equals(sourceRoot, StringComparison.OrdinalIgnoreCase) || root.StartsWith(sourceRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
            || sourceRoot.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new IOException("Install source overlaps destination");
        if (!Directory.Exists(root)) {
            Directory.CreateDirectory(root);
            File.WriteAllText(Path.Combine(root, "installed.txt"), Marker(root), new UTF8Encoding(false));
        }
        CheckRoot(root);
        // Concurrent installers cannot replace a version or pointer under each other.
        using (var installLock = new FileStream(Path.Combine(root, ".install.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None)) {
            CheckRoot(root);
            var id = Hash(Path.Combine(source, "bundle.json"));
            var versions = Path.Combine(root, "versions"); Directory.CreateDirectory(versions); Root(versions);
            // A repair gets a new immutable copy. Never move or delete an old
            // payload: it may still be running, or useful for recovery.
            var destination = Path.Combine(versions, id + "-" + Guid.NewGuid().ToString("N"));
            bool reusable = false;
            try {
                var previous = Current(root);
                if (Path.GetFileName(previous).Split('-')[0] == id && Reusable(previous, source)) { destination = previous; reusable = true; }
            } catch (IOException) {} catch (UnauthorizedAccessException) {}
            if (!reusable) {
                var staging = Path.Combine(versions, ".staging-" + Guid.NewGuid().ToString("N"));
                try {
                    CopyTree(source, staging);
                    if (!Reusable(staging, source)) throw new IOException("Staged payload invalid");
                    Directory.Move(staging, destination);
                } finally { if (Directory.Exists(staging)) Directory.Delete(staging, true); }
            }
            var bootstrap = Path.Combine(root, "Tada.exe");
            var incoming = Path.Combine(destination, "bin", "Tada-bootstrap.exe");
            if (File.Exists(bootstrap) && Hash(bootstrap) != Hash(incoming)) {
                // This exact reserved file belongs to the marked installation.
                // Explicit reinstall can repair it without executing damaged code.
                var replacement = Path.Combine(root, "bootstrap-" + Guid.NewGuid().ToString("N") + ".tmp");
                try { File.Copy(incoming, replacement, false); File.Replace(replacement, bootstrap, null); }
                finally { if (File.Exists(replacement)) File.Delete(replacement); }
            }
            if (!File.Exists(bootstrap)) File.Copy(incoming, bootstrap, false);
            // Existing host keeps its payload/lease. A new launch reopens it safely.
            CreateShortcut(root, shortcut ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Tada.lnk") : Path.Combine(root, "Tada.lnk"));
            AtomicText(Path.Combine(root, "current.txt"), "Tada installed version 1\n" + Path.GetFileName(destination) + "\n" + Hash(Path.Combine(destination, "Tada.exe")) + "\n");
        }
    }
    static void CreateShortcut(string root, string link) {
        if (File.Exists(link) && (File.GetAttributes(link) & FileAttributes.ReparsePoint) != 0) throw new IOException("Linked shortcut");
        // Never replace a shortcut belonging to a different installation.
        dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
        try {
            dynamic item = shell.CreateShortcut(link);
            try {
                if (File.Exists(link) && (!String.Equals((string)item.TargetPath, Path.Combine(root, "Tada.exe"), StringComparison.OrdinalIgnoreCase) || !String.IsNullOrEmpty((string)item.Arguments))) throw new IOException("Start menu entry already in use");
                item.TargetPath = Path.Combine(root, "Tada.exe"); item.WorkingDirectory = root;
                item.Description = "Tada 개인 비서"; item.Save();
            } finally { System.Runtime.InteropServices.Marshal.FinalReleaseComObject(item); }
        } finally { System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shell); }
    }
    static string StartupName(string root) {
        using (var hash = SHA256.Create()) return "Tada-" + BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(root.ToUpperInvariant()))).Replace("-", "").Substring(0, 20);
    }
    internal static string Startup(string root, string action) {
        Current(root);
        var name = StartupName(root); var command = Quote(Path.Combine(root, "Tada.exe")) + " --background";
        if (command.Length > 260) throw new IOException("Startup path too long");
        const string runPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
        using (var key = action == "status" ? Registry.CurrentUser.OpenSubKey(runPath, false) : Registry.CurrentUser.CreateSubKey(runPath)) {
            var value = key == null ? null : key.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames);
            if (value != null && (!(value is string) || (string)value != command || key.GetValueKind(name) != RegistryValueKind.String)) throw new IOException("Startup entry already in use");
            if (action == "enable") { key.SetValue(name, command, RegistryValueKind.String); value = command; }
            else if (action == "disable") { if (value != null) key.DeleteValue(name, false); value = null; }
            else if (action != "status") throw new IOException("Unknown startup action");
            return "{\"registered\":" + (value == null ? "false" : "true") + "}";
        }
    }
}
