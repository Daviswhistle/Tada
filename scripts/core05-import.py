"""One-shot correction of the test adapter's owned credential reference."""
from pathlib import Path
p=Path('crates/credential/src/tests.rs')
s=p.read_text()
old='    let e = id.discovery()?;'
assert s.count(old)==1
s=s.replace(old,old+'\n    let credential = id.credential()?;')
assert s.count('&id.credential()?,')==1
p.write_text(s.replace('&id.credential()?,','&credential,'))
Path(__file__).unlink()
