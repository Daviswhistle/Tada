// Compile with the real InstalledApp.cs; every path and byte belongs to this fixture.
using System;
using System.IO;
using System.Linq;
using System.Text;

public static class InstallationSafety {
    static int checks;
    static void Check(bool value, string label) { if (!value) throw new Exception(label); checks++; }
    static void Reject(Action action) { bool failed = false; try { action(); } catch (IOException) { failed = true; } Check(failed, "expected rejection"); }
    static void Text(string path, string value) { File.WriteAllText(path, value, new UTF8Encoding(false)); }
    [STAThread] public static int Main(string[] args) {
        var root = args.Single();
        var source = Path.Combine(root, "source"); Directory.CreateDirectory(Path.Combine(source, "bin"));
        // Not executable. Verification must never dispatch a possibly damaged copy.
        Text(Path.Combine(source, "Tada.exe"), "synthetic non executable launcher");
        Text(Path.Combine(source, "bin", "Tada-bootstrap.exe"), "synthetic bootstrap");
        Text(Path.Combine(source, "bundle.json"), "synthetic manifest one");
        var install = Path.Combine(root, "installed"); int validations = 0;
        Action<string> verify = payload => {
            validations++;
            Check(File.ReadAllText(Path.Combine(payload, "bundle.json")) == File.ReadAllText(Path.Combine(source, "bundle.json")), "manifest bytes");
        };
        InstalledApp.Install(source, install, false, verify);
        var pointer = Path.Combine(install, "current.txt"); var original = File.ReadAllText(pointer);
        Check(original.StartsWith("Tada installed version 2\n"), "v2 pointer");
        Check(Path.GetFileName(InstalledApp.Current(install)).Length == 32, "short version name");
        Check(validations == 2, "staging and final verification");
        InstalledApp.Install(source, install, false, verify);
        Check(File.ReadAllText(pointer) == original, "healthy copy reused");
        Check(validations == 3, "existing copy verified directly");
        foreach (var header in new[] { "3", "02", "-2" }) {
            Text(pointer, original.Replace("version 2", "version " + header));
            Reject(() => InstalledApp.Current(install));
        }
        foreach (var index in new[] { 2, 3 }) {
            var lines = original.Split('\n'); lines[index] = new String('0', 64);
            Text(pointer, String.Join("\n", lines)); Reject(() => InstalledApp.Current(install));
        }
        Text(pointer, original);
        var oldPayload = InstalledApp.Current(install);
        var oldName = InstalledApp.Hash(Path.Combine(oldPayload, "bundle.json")) + "-" + Guid.NewGuid().ToString("N");
        var legacy = Path.Combine(install, "versions", oldName); Directory.Move(oldPayload, legacy);
        var oldPointer = "Tada installed version 1\n" + oldName + "\n" + InstalledApp.Hash(Path.Combine(legacy, "Tada.exe")) + "\n";
        Text(pointer, oldPointer); Check(InstalledApp.Current(install) == legacy, "legacy pointer read");
        InstalledApp.Install(source, install, false, verify);
        Check(Directory.Exists(legacy), "legacy copy preserved");
        original = File.ReadAllText(pointer); Check(original.StartsWith("Tada installed version 2\n"), "legacy upgrade");
        Text(Path.Combine(source, "bundle.json"), "synthetic manifest two");
        foreach (bool failInStaging in new[] { true, false }) {
            Reject(() => InstalledApp.Install(source, install, false, path => {
                bool staging = Path.GetFileName(path).StartsWith(".staging-");
                if (staging == failInStaging) throw new IOException("fixture validation failure");
                verify(path);
            }));
            Check(File.ReadAllText(pointer) == original, "failed verification preserved pointer");
            Check(Directory.Exists(InstalledApp.Current(install)), "previous version remains usable");
        }
        using (var locked = new FileStream(Path.Combine(install, "Tada.exe"), FileMode.Open, FileAccess.Read, FileShare.None)) {
            Reject(() => InstalledApp.Install(source, install, false, verify));
            Check(File.ReadAllText(pointer) == original, "locked bootstrap preserved pointer");
        }
        InstalledApp.Install(source, install, false, verify);
        Check(File.ReadAllText(pointer) != original, "explicit retry completes after unlock");
        var excessive = Path.Combine(root, new String('x', 180));
        Reject(() => InstalledApp.Install(source, excessive, false, verify));
        Check(!Directory.Exists(excessive), "unsupported path leaves no installation");
        Console.WriteLine("{\"passed\":true,\"checks\":" + checks + "}"); return 0;
    }
}
