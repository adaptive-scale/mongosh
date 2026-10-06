//! The interactive shell: line editing, history, completion and the
//! read-eval-print loop. When stdin is not a terminal the same loop reads
//! piped input instead.

use std::{
    io::{BufRead, Write},
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};

use rquickjs::{Array, Context, Value};
use rustyline::{
    completion::Completer, error::ReadlineError, highlight::Highlighter, hint::Hinter, history::DefaultHistory,
    validate::Validator, CompletionType, Config, Editor, Helper,
};

use crate::{
    describe_error, describe_error_interactive,
    engine::{self, call_msh, Engine},
    lexer, native, print_result_or_nothing,
};

/// Prompt shown while a statement continues on the next line.
const CONTINUATION_PROMPT: &str = "| ";

pub struct Options {
    pub quiet: bool,
    pub norc: bool,
    pub stdin_tty: bool,
}

/// True while user code is running, so Ctrl-C interrupts it instead of being
/// ignored between prompts.
static EVALUATING: AtomicBool = AtomicBool::new(false);

struct ShellHelper {
    context: Context,
}

impl Completer for ShellHelper {
    type Candidate = String;

    fn complete(
        &self,
        line: &str,
        pos: usize,
        _ctx: &rustyline::Context<'_>,
    ) -> rustyline::Result<(usize, Vec<String>)> {
        let prefix = &line[..pos];
        let result = self.context.with(|ctx| -> Option<(usize, Vec<String>)> {
            let reply: Array = call_msh(&ctx, "complete", (prefix,)).ok()?;
            let start: usize = reply.get(0).ok()?;
            let items: Vec<String> = reply.get(1).ok()?;
            Some((start, items))
        });
        Ok(result.unwrap_or((pos, Vec::new())))
    }
}

impl Hinter for ShellHelper {
    type Hint = String;
}
impl Highlighter for ShellHelper {}
impl Validator for ShellHelper {}
impl Helper for ShellHelper {}

fn history_path() -> Option<PathBuf> {
    Some(crate::state_dir()?.join("repl_history"))
}

/// Like mongosh, keep commands that carry credentials out of the history.
fn is_sensitive(input: &str) -> bool {
    const WORDS: &[&str] =
        &["createUser", "auth", "updateUser", "changeUserPassword", "connect", "Mongo", "passwordPrompt"];
    WORDS.iter().any(|word| {
        input.match_indices(word).any(|(at, _)| {
            let before = input[..at].chars().next_back();
            let after = input[at + word.len()..].chars().next();
            let boundary = |c: Option<char>| c.is_none_or(|c| !(c.is_alphanumeric() || c == '_'));
            boundary(before) && boundary(after)
        })
    })
}

fn prompt(engine: &Engine) -> String {
    engine.context().with(|ctx| call_msh::<_, String>(&ctx, "prompt", ()).ok()).unwrap_or_else(|| "> ".to_string())
}

fn is_direct_command(engine: &Engine, input: &str) -> bool {
    engine.context().with(|ctx| call_msh::<_, bool>(&ctx, "isDirectCommand", (input,)).unwrap_or(false))
}

/// Evaluate one complete input and print its result or error. Returns false
/// when nothing was printed.
fn eval_and_print(engine: &Engine, input: &str) -> bool {
    native::clear_interrupt();
    EVALUATING.store(true, Ordering::SeqCst);
    let printed = engine.context().with(|ctx| {
        let outcome = engine::eval_input(&ctx, input, "REPL").and_then(|value| print_result_or_nothing(&ctx, value));
        EVALUATING.store(false, Ordering::SeqCst);
        let printed = match outcome {
            Ok(printed) => printed,
            Err(thrown) => {
                if native::interrupt_requested() {
                    println!("Stopping execution...");
                } else {
                    println!("{}", describe_error_interactive(&ctx, thrown));
                }
                true
            }
        };
        // Run anything the evaluation left on the job queue.
        while ctx.execute_pending_job() {}
        printed
    });
    EVALUATING.store(false, Ordering::SeqCst);
    native::clear_interrupt();
    let _ = std::io::stdout().flush();
    printed
}

fn install_interrupt_handler() {
    native::runtime().spawn(async {
        while tokio::signal::ctrl_c().await.is_ok() {
            if EVALUATING.load(Ordering::SeqCst) {
                native::request_interrupt();
            }
        }
    });
}

fn startup(engine: &Engine, options: &Options) {
    engine.context().with(|ctx| {
        if !options.quiet {
            if let Ok(banner) = call_msh::<_, String>(&ctx, "banner", ()) {
                if !banner.is_empty() {
                    println!("{banner}");
                }
            }
        }
        if !options.norc {
            if let Some(rc) = crate::home_dir().map(|home| home.join(".mongoshrc.js")).filter(|p| p.is_file()) {
                let path = rc.to_string_lossy().into_owned();
                if let Err(thrown) = call_msh::<_, Value>(&ctx, "loadFile", (path.as_str(),)) {
                    println!("Error while running ~/.mongoshrc.js:");
                    println!("{}", describe_error(&ctx, thrown));
                }
            }
        }
    });
    let _ = std::io::stdout().flush();
}

pub fn run(engine: &Engine, options: Options) -> i32 {
    startup(engine, &options);
    if options.stdin_tty {
        run_terminal(engine)
    } else {
        run_piped(engine)
    }
}

fn run_terminal(engine: &Engine) -> i32 {
    install_interrupt_handler();

    let config = match Config::builder()
        .completion_type(CompletionType::List)
        .history_ignore_dups(true)
        .and_then(|b| b.max_history_size(1000))
    {
        Ok(builder) => builder.auto_add_history(false).build(),
        Err(_) => Config::default(),
    };
    let mut editor: Editor<ShellHelper, DefaultHistory> = match Editor::with_config(config) {
        Ok(editor) => editor,
        Err(err) => {
            eprintln!("mongo-sh: cannot start the line editor: {err}");
            return 1;
        }
    };
    editor.set_helper(Some(ShellHelper { context: engine.context().clone() }));
    let history = history_path();
    if let Some(path) = &history {
        let _ = editor.load_history(path);
    }

    let mut interrupted_once = false;
    loop {
        let mut input = match editor.readline(&prompt(engine)) {
            Ok(line) => line,
            Err(ReadlineError::Interrupted) => {
                if interrupted_once {
                    break;
                }
                interrupted_once = true;
                println!("(To exit, press Ctrl+C again or Ctrl+D or type .exit)");
                continue;
            }
            Err(ReadlineError::Eof) => break,
            Err(err) => {
                eprintln!("mongo-sh: {err}");
                break;
            }
        };
        interrupted_once = false;
        if input.trim().is_empty() {
            continue;
        }

        // Keep reading while brackets, templates or comments are open.
        let mut aborted = false;
        while !is_direct_command(engine, &input) && lexer::is_incomplete(&input) {
            match editor.readline(CONTINUATION_PROMPT) {
                Ok(more) => {
                    input.push('\n');
                    input.push_str(&more);
                }
                Err(ReadlineError::Interrupted) => {
                    aborted = true;
                    break;
                }
                Err(_) => break,
            }
        }
        if aborted {
            continue;
        }

        if !is_sensitive(&input) {
            let _ = editor.add_history_entry(input.as_str());
            if let Some(path) = &history {
                let _ = editor.save_history(path);
            }
        }
        if matches!(input.trim().trim_end_matches(';'), ".exit" | ".quit") {
            break;
        }
        eval_and_print(engine, &input);
    }
    0
}

/// Non-interactive stdin: evaluate the piped input statement by statement.
/// Nothing echoes the input, so the transcript is the prompt followed by each
/// result, with a bare newline where a statement has no value -- the same
/// shape mongosh produces.
fn run_piped(engine: &Engine) -> i32 {
    let stdin = std::io::stdin();
    let mut pending = String::new();
    let mut continuation_lines = 0;
    let mut out = std::io::stdout();
    let mut run = |input: &str, continuation_lines: usize| {
        print!("{}{}", prompt(engine), CONTINUATION_PROMPT.repeat(continuation_lines));
        let _ = out.flush();
        if !eval_and_print(engine, input) {
            println!();
        }
    };
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if pending.is_empty() {
            if line.trim().is_empty() {
                continue;
            }
            pending = line;
        } else {
            pending.push('\n');
            pending.push_str(&line);
            continuation_lines += 1;
        }
        if !is_direct_command(engine, &pending) && lexer::is_incomplete(&pending) {
            continue;
        }
        let input = std::mem::take(&mut pending);
        run(&input, std::mem::take(&mut continuation_lines));
    }
    if !pending.trim().is_empty() {
        run(&pending, continuation_lines);
    }
    print!("{}", prompt(engine));
    let _ = std::io::stdout().flush();
    0
}
