//! mongo-sh: a MongoDB shell compatible with mongosh, written in Rust.

mod cli;
mod convert;
mod engine;
mod lexer;
mod native;
mod repl;

use std::io::{IsTerminal, Write};

use rquickjs::{Ctx, Object, Value};

use engine::{call_msh, Engine};

pub fn os_hostname() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .filter(|h| !h.is_empty())
        .or_else(|| {
            std::process::Command::new("hostname")
                .output()
                .ok()
                .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
                .filter(|h| !h.is_empty())
        })
        .unwrap_or_else(|| "localhost".to_string())
}

pub fn home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|home| !home.is_empty())
        .map(std::path::PathBuf::from)
}

/// Where the shell keeps its history and settings: ~/.mongodb/mongo-sh.
pub fn state_dir() -> Option<std::path::PathBuf> {
    let dir = home_dir()?.join(".mongodb").join("mongo-sh");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn build_info() -> String {
    format!(
        "{{\n  \"version\": \"{}\",\n  \"distributionKind\": \"compiled\",\n  \"buildArch\": \"{}\",\n  \"buildPlatform\": \"{}\",\n  \"buildTarget\": \"{}-{}\",\n  \"runtime\": \"QuickJS (rquickjs)\",\n  \"driver\": \"mongodb (Rust)\"\n}}",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::ARCH,
        std::env::consts::OS,
        std::env::consts::OS,
        std::env::consts::ARCH,
    )
}

/// How a script (--eval, file) reports an error it did not catch.
pub fn describe_error<'js>(ctx: &Ctx<'js>, thrown: Value<'js>) -> String {
    call_msh::<_, String>(ctx, "formatUncaught", (thrown,))
        .unwrap_or_else(|_| "Error: failed to format an error".to_string())
}

/// How the interactive shell reports an error thrown by a line.
pub fn describe_error_interactive<'js>(ctx: &Ctx<'js>, thrown: Value<'js>) -> String {
    call_msh::<_, String>(ctx, "formatUncaughtInteractive", (thrown,))
        .unwrap_or_else(|_| "Uncaught Error: failed to format an error".to_string())
}

/// Print the result of an evaluation; returns false when there was nothing
/// to print (the value was `undefined`).
pub fn print_result_or_nothing<'js>(ctx: &Ctx<'js>, value: Value<'js>) -> Result<bool, Value<'js>> {
    let formatted: Value = call_msh(ctx, "formatResult", (value,))?;
    match formatted.as_string().and_then(|s| s.to_string().ok()) {
        Some(text) => {
            let mut out = std::io::stdout().lock();
            if writeln!(out, "{text}").is_err() || out.flush().is_err() {
                std::process::exit(0);
            }
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Print the result of an evaluation; `undefined` prints nothing.
pub fn print_result<'js>(ctx: &Ctx<'js>, value: Value<'js>) -> Result<(), Value<'js>> {
    print_result_or_nothing(ctx, value).map(|_| ())
}

fn fail<'js>(ctx: &Ctx<'js>, thrown: Value<'js>, json: bool) -> i32 {
    if json {
        // --json reports errors as Extended JSON on stdout.
        let text = call_msh::<_, String>(ctx, "formatErrorJson", (thrown,)).unwrap_or_default();
        println!("{text}");
    } else {
        eprintln!("{}", describe_error(ctx, thrown));
    }
    1
}

fn run(cli: cli::Cli) -> i32 {
    let interactive = cli.shell || (cli.evals.is_empty() && cli.files.is_empty());
    let stdout_tty = std::io::stdout().is_terminal();
    let stdin_tty = std::io::stdin().is_terminal();
    let colors = interactive && stdout_tty && std::env::var_os("NO_COLOR").is_none();

    let mut conn = None;
    if !cli.nodb {
        let mut built = match cli::build_conn_string(&cli) {
            Ok(conn) => conn,
            Err(message) => {
                eprintln!("{message}");
                return 1;
            }
        };
        if cli.password_prompt || built.needs_password() {
            match rpassword::prompt_password("Enter password: ") {
                Ok(password) => built.password = Some(password),
                Err(err) => {
                    eprintln!("Error: could not read password: {err}");
                    return 1;
                }
            }
        }
        conn = Some(built);
    }

    let engine = match Engine::new() {
        Ok(engine) => engine,
        Err(message) => {
            eprintln!("mongo-sh: {message}");
            return 1;
        }
    };

    let json = cli.json.clone();
    let setup = engine.context().with(|ctx| -> Result<(), i32> {
        let config = Object::new(ctx.clone()).map_err(|_| 1)?;
        config.set("interactive", interactive).map_err(|_| 1)?;
        config.set("quiet", cli.quiet).map_err(|_| 1)?;
        config.set("colors", colors).map_err(|_| 1)?;
        config.set("isTTY", stdout_tty).map_err(|_| 1)?;
        if let Some(mode) = &json {
            config.set("json", mode.as_str()).map_err(|_| 1)?;
        }
        if let Some(deep) = cli.deep_inspect {
            config.set("deepInspect", deep).map_err(|_| 1)?;
        }
        if let Some(version) = &cli.api_version {
            let api = Object::new(ctx.clone()).map_err(|_| 1)?;
            api.set("version", version.as_str()).map_err(|_| 1)?;
            api.set("strict", cli.api_strict).map_err(|_| 1)?;
            api.set("deprecationErrors", cli.api_deprecation_errors).map_err(|_| 1)?;
            config.set("serverApi", api).map_err(|_| 1)?;
        }
        if let Err(thrown) = call_msh::<_, Value>(&ctx, "setup", (config,)) {
            return Err(fail(&ctx, thrown, false));
        }
        if let Some(conn) = &conn {
            if let Err(thrown) = call_msh::<_, Value>(&ctx, "connectInitial", (conn.to_uri(), conn.to_redacted())) {
                return Err(fail(&ctx, thrown, json.is_some()));
            }
        }
        Ok(())
    });
    if let Err(code) = setup {
        native::shutdown();
        return code;
    }

    let mut code = 0;
    if !cli.evals.is_empty() || !cli.files.is_empty() {
        code = engine.context().with(|ctx| {
            // Only the result of the last --eval is printed.
            let mut last: Option<Value> = None;
            for script in &cli.evals {
                match engine::eval_input(&ctx, script, "@(shell eval)") {
                    Ok(value) => last = Some(value),
                    Err(thrown) => return fail(&ctx, thrown, json.is_some()),
                }
            }
            if let Some(value) = last {
                if let Err(thrown) = print_result(&ctx, value) {
                    return fail(&ctx, thrown, json.is_some());
                }
            }
            for file in &cli.files {
                if let Err(thrown) = call_msh::<_, Value>(&ctx, "loadFile", (file.as_str(),)) {
                    return fail(&ctx, thrown, json.is_some());
                }
            }
            0
        });
    }

    if code == 0 && interactive {
        code = repl::run(&engine, repl::Options { quiet: cli.quiet, norc: cli.norc, stdin_tty });
    }

    let _ = std::io::stdout().flush();
    native::shutdown();
    code
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cli = match cli::parse(&args) {
        Ok(cli) => cli,
        Err(message) => {
            // Same shape as mongosh: the problem, then the usage text.
            eprint!("MongoshUnimplementedError: [COMMON-10001]   {message}\n        {}", cli::USAGE);
            std::process::exit(1);
        }
    };
    if cli.help {
        print!("{}", cli::USAGE);
        return;
    }
    if cli.version {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return;
    }
    if cli.build_info {
        println!("{}", build_info());
        return;
    }

    // Deeply nested documents recurse through the formatter and the BSON
    // converter, so the shell runs on a thread with a generous stack.
    let shell = std::thread::Builder::new()
        .name("mongo-sh".into())
        .stack_size(engine::JS_STACK_SIZE + 16 * 1024 * 1024)
        .spawn(move || run(cli))
        .expect("failed to start the shell thread");
    let code = shell.join().unwrap_or(1);
    std::process::exit(code);
}
