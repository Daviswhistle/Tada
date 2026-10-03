"""Final reviewed source adjustments; removed after preparation."""
from pathlib import Path
p = Path('crates/agentd/src/process_runner.rs')
s = p.read_text()
old = '    let expected_hash = lease.contract_hash().to_owned();\n'
assert s.count(old) == 1
s = s.replace(old, old + '    let engine_stop = stop.clone();\n')
old = 'stdin, stdout, started, pid, stop: stop.clone(), mode: options.mode.clone(),'
assert s.count(old) == 1
s = s.replace(old, 'stdin, stdout, started, pid, stop: engine_stop, mode: options.mode.clone(),')
p.write_text(s)
for name, addition in [
 ('README.md', '\n## Duplex engine integration\n\n[ENGINE-01A](docs/engine-duplex.md) connects the SEC-01A broker to actual child pipes. `demo-engine NEW_DIRECTORY` uses the built-in Rust reference; `demo-typescript NEW_DIRECTORY ABS_NODE` uses the checked-in deterministic TypeScript worker with the exact `.node-version` runtime supplied explicitly. Both authorize and invoke only the current task contract-digest read, preserve one committed result on replay, revoke their host-owned channel, and require confirmed process cleanup before a probe checkpoint. They do not call models or complete user tasks. The mandatory process-fixture suite now requires the pinned Node executable on the developer test PATH in addition to `npm ci`; production commands never resolve a runtime from PATH.\n'),
 ('docs/roadmap.md', '\n## ENGINE-01A — duplex digest integration\n\nThe actual Rust and TypeScript process paths are specified in [engine-duplex.md](engine-duplex.md). This joins the existing host-owned channel to a bounded propose/authorize/invoke/replay/final exchange without replacing the task/control/worker schemas. It remains a model-free fixed read probe; general model planning, provider adapters, file actions, artifact verification/publication, packaged runtime integrity and independent security review are separate gates.\n'),
 ('docs/worker-authority.md', '\n## Follow-through: ENGINE-01A\n\nThe subsequent [duplex integration](engine-duplex.md) retains the opaque channel in the parent and calls this broker from a real child-pipe exchange. The original SEC-01A library boundary above describes its initial slice; the built-in and TypeScript demonstration paths now exercise it across processes. Neither path exposes host policy installation or channel issuance to worker JSON.\n'),
]:
    p = Path(name)
    p.write_text(p.read_text() + addition)
Path(__file__).unlink()
