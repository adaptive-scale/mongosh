//! The JavaScript engine: boots QuickJS, installs the native bridge and the
//! embedded shell sources, and evaluates user input.

use std::time::Duration;

use rquickjs::{
    context::EvalOptions, CatchResultExt, Context, Ctx, Exception, Function, Object, Promise, Runtime, Value,
};

use crate::{lexer, native};

/// The shell itself, in evaluation order. Each file is an IIFE that hangs its
/// internals off the hidden `__msh` object and publishes the user-facing
/// globals.
const SOURCES: &[(&str, &str)] = &[
    ("mongo-sh:core", include_str!("js/core.js")),
    ("mongo-sh:inspect", include_str!("js/inspect.js")),
    ("mongo-sh:bson", include_str!("js/bson.js")),
    ("mongo-sh:ejson", include_str!("js/ejson.js")),
    ("mongo-sh:errors", include_str!("js/errors.js")),
    ("mongo-sh:help", include_str!("js/help.js")),
    ("mongo-sh:cursor", include_str!("js/cursor.js")),
    ("mongo-sh:collection", include_str!("js/collection.js")),
    ("mongo-sh:database", include_str!("js/database.js")),
    ("mongo-sh:mongo", include_str!("js/mongo.js")),
    ("mongo-sh:replica-set", include_str!("js/rs.js")),
    ("mongo-sh:sharding", include_str!("js/sh.js")),
    ("mongo-sh:shell", include_str!("js/shell.js")),
];

/// JS call depth is bounded by this much native stack. The engine runs on a
/// thread created with more room than this (see `main`).
pub const JS_STACK_SIZE: usize = 48 * 1024 * 1024;

pub struct Engine {
    // Field order matters: the context must be dropped before its runtime.
    context: Context,
    _runtime: Runtime,
}

impl Engine {
    pub fn new() -> Result<Engine, String> {
        let runtime = Runtime::new().map_err(|e| e.to_string())?;
        runtime.set_max_stack_size(JS_STACK_SIZE);
        runtime.set_interrupt_handler(Some(Box::new(native::interrupt_requested)));
        let context = Context::full(&runtime).map_err(|e| e.to_string())?;

        context.with(|ctx| -> Result<(), String> {
            native::register(&ctx).map_err(|e| e.to_string())?;
            for (name, source) in SOURCES {
                let mut options = EvalOptions::default();
                options.global = true;
                options.strict = false;
                options.filename = Some((*name).to_string());
                ctx.eval_with_options::<(), _>(*source, options)
                    .catch(&ctx)
                    .map_err(|e| format!("failed to load {name}: {e}"))?;
            }
            Ok(())
        })?;

        Ok(Engine { context, _runtime: runtime })
    }

    pub fn context(&self) -> &Context {
        &self.context
    }
}

/// Take the pending exception off the context as a JS value.
fn thrown_value<'js>(ctx: &Ctx<'js>, err: rquickjs::Error) -> Value<'js> {
    if err.is_exception() {
        return ctx.catch();
    }
    match Exception::from_message(ctx.clone(), &err.to_string()) {
        Ok(exception) => exception.into_object().into_value(),
        Err(_) => Value::new_undefined(ctx.clone()),
    }
}

pub fn msh<'js>(ctx: &Ctx<'js>) -> Object<'js> {
    ctx.globals().get("__msh").expect("shell internals are installed at startup")
}

/// Call a function on the shell internals object, e.g. `__msh.formatResult`.
pub fn call_msh<'js, A, R>(ctx: &Ctx<'js>, name: &str, args: A) -> Result<R, Value<'js>>
where
    A: rquickjs::function::IntoArgs<'js>,
    R: rquickjs::FromJs<'js>,
{
    let f: Function = msh(ctx).get(name).map_err(|e| thrown_value(ctx, e))?;
    f.call(args).map_err(|e| thrown_value(ctx, e))
}

/// Evaluate user code in the global scope and return its completion value.
///
/// The code runs as an async script so top-level `await` works; the job queue
/// and any pending timers are driven until the script settles. `Err` carries
/// the thrown value.
pub fn eval_user<'js>(ctx: &Ctx<'js>, source: &str, filename: &str) -> Result<Value<'js>, Value<'js>> {
    let code = lexer::rewrite_toplevel(source);
    let mut options = EvalOptions::default();
    options.global = true;
    options.strict = false;
    options.promise = true;
    options.backtrace_barrier = true;
    options.filename = Some(filename.to_string());

    let promise: Promise = ctx.eval_with_options(code, options).map_err(|e| thrown_value(ctx, e))?;
    let completion: Object = settle(ctx, &promise)?;
    let value: Value = completion.get("value").map_err(|e| thrown_value(ctx, e))?;

    // Like mongosh, a promise (or any thenable) that ends a line is awaited
    // and its result becomes the value of the line.
    let awaited: Value = call_msh(ctx, "thenableToPromise", (value.clone(),))?;
    match awaited.as_promise() {
        Some(pending) => settle(ctx, pending),
        None => Ok(value),
    }
}

/// Drive the job queue and pending timers until `promise` settles.
fn settle<'js, T: rquickjs::FromJs<'js>>(ctx: &Ctx<'js>, promise: &Promise<'js>) -> Result<T, Value<'js>> {
    loop {
        if let Some(result) = promise.result::<T>() {
            return result.map_err(|e| thrown_value(ctx, e));
        }
        if ctx.execute_pending_job() {
            continue;
        }
        // Nothing left on the job queue: the script is waiting on a timer.
        let wait: f64 = call_msh(ctx, "runTimers", ())?;
        if wait < 0.0 {
            let message = "Promise never settled: no pending timers or operations remain";
            return Err(match Exception::from_message(ctx.clone(), message) {
                Ok(exception) => exception.into_object().into_value(),
                Err(_) => Value::new_undefined(ctx.clone()),
            });
        }
        if wait > 0.0 {
            let pause = Duration::from_secs_f64(wait.min(50.0) / 1000.0);
            native::runtime().block_on(async { tokio::time::sleep(pause).await });
        }
        if native::interrupt_requested() {
            return Err(call_msh(ctx, "interruptedError", ()).unwrap_or_else(|e| e));
        }
    }
}

/// Evaluate one piece of shell input: either a direct command such as
/// `use db` / `show dbs` / `it`, or JavaScript.
pub fn eval_input<'js>(ctx: &Ctx<'js>, source: &str, filename: &str) -> Result<Value<'js>, Value<'js>> {
    let internals = msh(ctx);
    let not_a_command: Value = internals.get("NOT_A_COMMAND").map_err(|e| thrown_value(ctx, e))?;
    let direct: Value = call_msh(ctx, "runDirectCommand", (source,))?;
    if direct != not_a_command {
        return Ok(direct);
    }
    eval_user(ctx, source, filename)
}
