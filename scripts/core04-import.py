"""One-shot cross-platform source refinements; removed before normal PR CI."""
from pathlib import Path
p = Path('crates/local-ipc/src/windows.rs')
s = p.read_text()
assert s.count('ptr::{null, null_mut}') == 1
p.write_text(s.replace('ptr::{null, null_mut}', 'ptr::null_mut'))
p = Path('crates/local-ipc/src/lib.rs')
s = p.read_text()
old = '''    let mut builder = std::fs::DirBuilder::new();
    #[cfg(target_os = "linux")]
    { use std::os::unix::fs::DirBuilderExt; builder.mode(0o700); }
    builder.create(path)?;'''
new = '''    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().mode(0o700).create(path)?;
    }
    #[cfg(windows)]
    std::fs::create_dir(path)?;'''
assert s.count(old) == 1
p.write_text(s.replace(old, new))
p = Path('crates/local-ipc/src/tests.rs')
s = p.read_text()
old = 'async fn close(self) -> ServeReport { self.stop.send(true).unwrap(); self.job.await.unwrap().unwrap() }'
new = 'async fn close(self) -> ServeReport { self.stop.send(true).unwrap(); let report=self.job.await.unwrap().unwrap(); drop(self.store); drop(self.temp); report }'
assert s.count(old) == 1
p.write_text(s.replace(old, new))
Path(__file__).unlink()
