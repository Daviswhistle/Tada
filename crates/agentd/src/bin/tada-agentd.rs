//! Explicit foreground host and its fixed, no-tool child entry point.
fn main() {
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    let result: Result<(), Box<dyn std::error::Error>> = if args.first().is_some_and(|a| a == "--probe-worker") {
        // This branch must run before any async runtime or worker pool exists.
        match args.as_slice() {
            [_] => tada_agentd::worker_wire::worker_stdio("normal").map_err(Into::into),
            [_, mode] => match mode.to_str() {
                Some(mode) => tada_agentd::worker_wire::worker_stdio(mode).map_err(Into::into),
                None => Err("INVALID_WORKER_MODE".into()),
            },
            _ => Err("INVALID_WORKER_ARGUMENTS".into()),
        }
    } else {
        tada_agentd::foreground::run(args)
    };
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
