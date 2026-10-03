"""One-shot, exact-base integration of the duplex engine slice. Removed after use."""
from pathlib import Path
import json
import subprocess

base = {
 'crates/agentd/src/process_runner.rs':'17f3a8cd808f494692feb324f3dc66bb11ee5da4',
 'crates/agentd/src/foreground.rs':'668ea928534b461ed995dcc85f92c2ca3e84ba22',
 'crates/agentd/src/bin/tada-agentd.rs':'a8b47230d6af49205a3ed85b25f284523ea3340f',
 'crates/store/src/control/worker.rs':'498c1c25999a407ee2625f5d669afaf40783457c',
}
for path, sha in base.items():
    assert subprocess.check_output(['git','hash-object',path], text=True).strip() == sha, path

def edit(path, pairs):
    p = Path(path)
    s = p.read_text()
    for old, new in pairs:
        assert s.count(old) == 1, (path, old, s.count(old))
        s = s.replace(old, new)
    p.write_text(s)

edit('crates/store/src/control/worker.rs', [(
 'const CATALOG: &str =',
 '''/// Bounded unique-key parsing plus the generated contract validator. This
/// constructs values only; it never authenticates a channel or grants authority.
pub fn decode_worker_message<T: Contract>(bytes: &[u8]) -> Result<T> {
    if bytes.is_empty() || bytes.len() > MAX_WORKER_BODY {
        return Err(Error::Invalid("WORKER_BODY_LIMIT"));
    }
    let value = json_input::parse(bytes).map_err(|_| Error::Invalid("WORKER_INVALID_JSON"))?;
    decode(&value)
}
const CATALOG: &str =''')])

p = Path('crates/agentd/src/lib.rs')
p.write_text(p.read_text() + '\npub mod engine_pipe;\n')
edit('crates/agentd/src/bin/tada-agentd.rs', [(
 '        } else {\n            tada_agentd::foreground::run(args)',
 '''        } else if args.first().is_some_and(|a| a == "--engine-worker") {
            match args.as_slice() {
                [_] => tada_agentd::engine_pipe::worker_stdio("normal").map_err(Into::into),
                [_, mode] => match mode.to_str() {
                    Some(mode) => tada_agentd::engine_pipe::worker_stdio(mode).map_err(Into::into),
                    None => Err("INVALID_WORKER_MODE".into()),
                },
                _ => Err("INVALID_WORKER_ARGUMENTS".into()),
            }
        } else {
            tada_agentd::foreground::run(args)''')])

edit('crates/agentd/src/process_runner.rs', [
 ('pub(crate) struct Options {\n', '''pub(crate) struct Options {
    pub engine: Option<crate::engine_pipe::Program>,
    #[cfg(feature = "process-fixtures")]
    pub invocation_barrier: Option<StartupBarrier>,
'''),
 ('            mode: "normal".into(),', '''            engine: None,
            #[cfg(feature = "process-fixtures")]
            invocation_barrier: None,
            mode: "normal".into(),'''),
 ('    InvalidOutput,\n', '    InvalidOutput,\n    AuthorityDenied,\n'),
 ('fn configure(command: &mut Command, cwd: &Path) {\n    command\n        .arg("--probe-worker")', '''fn configure(command: &mut Command, cwd: &Path, engine: &Option<crate::engine_pipe::Program>) {
    match engine {
        None => { command.arg("--probe-worker"); }
        Some(crate::engine_pipe::Program::BuiltIn) => { command.arg("--engine-worker"); }
        Some(crate::engine_pipe::Program::Node(_)) => {
            command.arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/engine/src/stdio.mjs"));
        }
    }
    command'''),
 ('    if *stop.borrow() {\n        return Ok(None);\n    }\n    let stop_at_claim', '''    if let Some(crate::engine_pipe::Program::Node(node)) = &options.engine {
        if !node.is_absolute() || !node.is_file() {
            return Err(Error::Invalid("ENGINE_ABSOLUTE_NODE_REQUIRED"));
        }
    }
    let engine_enabled = options.engine.is_some();
    if *stop.borrow() {
        return Ok(None);
    }
    let stop_at_claim'''),
 ('        Ok(Some((lease, serde_json::to_string(&value)?)))', '''        let channel = if engine_enabled {
            Some(s.open_worker_channel(&lease, Duration::from_secs(60))?)
        } else { None };
        Ok(Some((lease, serde_json::to_string(&value)?, channel)))'''),
 ('    let Some((lease, contract_json)) = assignment else {', '    let Some((lease, contract_json, engine_channel)) = assignment else {'),
 ('    let mut command = Command::new(exe);\n    configure(&mut command, &cwd);', '''    let mut command = match &options.engine {
        Some(crate::engine_pipe::Program::Node(node)) => Command::new(node),
        _ => Command::new(exe),
    };
    configure(&mut command, &cwd, &options.engine);'''),
 ('        reap(&mut child, &scope).await?;\n        if matches!(error,', '''        reap(&mut child, &scope).await?;
        if let Some(channel) = engine_channel.clone() {
            with_store(Arc::clone(&store), Priority::Cancellation, move |s| {
                s.revoke_worker_channel(&channel)
            }).await?;
        }
        if matches!(error,'''),
 ('    let observation = async {\n        let send = async move {', '''    let observation = async {
        if let Some(channel) = engine_channel.clone() {
            let exchange = crate::engine_pipe::Exchange {
                store: Arc::clone(&store), channel,
                seed: crate::engine_pipe::proposal(lease.task_id(), &expected_hash, &request.nonce),
                stdin, stdout, started, pid, stop: stop.clone(), mode: options.mode.clone(),
                #[cfg(feature = "process-fixtures")]
                invocation_barrier: options.invocation_barrier,
            };
            tokio::try_join!(exchange.run(), drain_stderr(stderr))?;
            return Ok::<_, Error>(());
        }
        let send = async move {'''),
 ('result=&mut observation,if !got_reply=>match result {Ok(())=>got_reply=true,Err(_)=>break Cause::InvalidOutput},', '''result=&mut observation,if !got_reply=>match result {
                    Ok(())=>got_reply=true,
                    Err(error @ (Error::Sql(_) | Error::RecoveryRequired))=>{storage_error=Some(error);break Cause::OwnershipLost},
                    Err(Error::Denied(_))=>break Cause::AuthorityDenied,
                    Err(_)=>break Cause::InvalidOutput,
                },'''),
 ('    if let Some(error) = storage_error {\n        return Err(error);\n    }\n    let current = lease.clone();', '''    if let Some(error) = storage_error {
        return Err(error);
    }
    // Earlier entered broker operations retain the admission permit until the
    // DB closure finishes. Revoke/drain before retiring or reassigning work.
    if let Some(channel) = engine_channel {
        with_store(Arc::clone(&store), Priority::Cancellation, move |s| {
            s.revoke_worker_channel(&channel)
        }).await?;
    }
    let current = lease.clone();'''),
])

edit('crates/agentd/src/foreground.rs', [
 ('  tada-agentd demo NEW_DIRECTORY\\n\\\n', '''  tada-agentd demo NEW_DIRECTORY\\n\\
  tada-agentd demo-engine NEW_DIRECTORY\\n\\
  tada-agentd demo-typescript NEW_DIRECTORY ABS_NODE\\n\\
'''),
 ('        ("demo", 2) => {', '''        ("demo-engine", 2) => {
            runtime()?.block_on(demo_impl(Path::new(&args[1]), "normal", Some(crate::engine_pipe::Program::BuiltIn)))?;
        }
        ("demo-typescript", 3) => {
            let node = absolute(&args[2])?;
            if !node.is_file() { return Err("ENGINE_ABSOLUTE_NODE_REQUIRED".into()); }
            runtime()?.block_on(demo_impl(Path::new(&args[1]), "normal", Some(crate::engine_pipe::Program::Node(node))))?;
        }
        #[cfg(feature = "process-fixtures")]
        ("demo-engine", 3) => {
            runtime()?.block_on(demo_impl(Path::new(&args[1]), args[2].to_str().ok_or("INVALID_FIXTURE")?, Some(crate::engine_pipe::Program::BuiltIn)))?;
        }
        #[cfg(feature = "process-fixtures")]
        ("demo-typescript", 4) => {
            let node = absolute(&args[2])?;
            if !node.is_file() { return Err("ENGINE_ABSOLUTE_NODE_REQUIRED".into()); }
            runtime()?.block_on(demo_impl(Path::new(&args[1]), args[3].to_str().ok_or("INVALID_FIXTURE")?, Some(crate::engine_pipe::Program::Node(node))))?;
        }
        ("demo", 2) => {'''),
 ('async fn demo(path: &Path, mode: &str) -> Result<()> {', '''async fn demo(path: &Path, mode: &str) -> Result<()> {
    demo_impl(path, mode, None).await
}
async fn demo_impl(path: &Path, mode: &str, engine: Option<crate::engine_pipe::Program>) -> Result<()> {'''),
 ('    let options = Options {\n', '''    if engine.is_some() {
        let policy = crate::engine_pipe::demo_policy("probe-a", mode)?;
        process_runner::with_store(Arc::clone(&store), tada_store::priority::Priority::Ordinary, move |s| {
            s.set_worker_policy("probe-a", &policy)
        }).await?;
    }
    #[cfg(feature = "process-fixtures")]
    let (invoke_notice, invoke_reached) = oneshot::channel();
    #[cfg(feature = "process-fixtures")]
    let (invoke_release, invoke_resume) = oneshot::channel();
    let options = Options {
        engine: engine.clone(),
        #[cfg(feature = "process-fixtures")]
        invocation_barrier: (mode == "cancel-before-invoke").then_some(process_runner::StartupBarrier {
            reached: invoke_notice, resume: invoke_resume,
        }),
'''),
 ('        pid\n    } else {\n        (&mut started).await?\n    };', '''        pid
    } else if mode == "cancel-before-invoke" {
        let pid = invoke_reached.await?;
        cancel(&mut client, "probe-a").await?;
        invoke_release.send(()).map_err(|_| "INVOCATION_RUNNER_LOST")?;
        pid
    } else {
        (&mut started).await?
    };'''),
 ('    let followup = if mode == "cancel-before-start" {\n        if started.await.is_ok() {', '''    let followup = if ["cancel-before-start", "cancel-before-invoke"].contains(&mode) {
        if mode == "cancel-before-start" && started.await.is_ok() {'''),
 ('        call(&mut client, submit("probe-after-race")).await?;\n        process_runner::run_one(', '''        call(&mut client, submit("probe-after-race")).await?;
        if engine.is_some() {
            let policy = crate::engine_pipe::demo_policy("probe-after-race", "normal")?;
            process_runner::with_store(Arc::clone(&store), tada_store::priority::Priority::Ordinary, move |s| {
                s.set_worker_policy("probe-after-race", &policy)
            }).await?;
        }
        process_runner::run_one('''),
 ('            Options::default(),\n            None,', '            Options { engine: engine.clone(), ..Options::default() },\n            None,'),
 ('"live_tools":0,"followup":followup', '"live_tools":0,"broker_enabled":engine.is_some(),"followup":followup'),
])

# Keep production builds warning-clean without suppressing unused_mut.
edit('crates/agentd/src/engine_pipe.rs', [
 ('    let mut proposal: WorkerProposal = decode_worker_message(&read_sync(&mut input)?)?;\n    #[cfg(feature = "process-fixtures")]\n    match mode {', '''    let proposal: WorkerProposal = decode_worker_message(&read_sync(&mut input)?)?;
    #[cfg(feature = "process-fixtures")]
    let proposal = {
    let mut proposal = proposal;
    match mode {'''),
 ('        _ => (),\n    }\n    send_sync(&mut output, &proposal)?;', '        _ => (),\n    }\n    proposal\n    };\n    send_sync(&mut output, &proposal)?;'),
])
p = Path('package.json')
v = json.loads(p.read_text())
v['scripts']['test'] += ' packages/engine/tests/*.test.mjs'
p.write_text(json.dumps(v, indent=2) + '\n')
p = Path('tsconfig.json')
v = json.loads(p.read_text())
v['include'].append('packages/engine/src/**/*.ts')
p.write_text(json.dumps(v, indent=2) + '\n')
Path(__file__).unlink()
