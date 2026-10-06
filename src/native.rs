//! The `__native` bridge: the small set of blocking primitives the JS shell
//! layer is built on.
//!
//! Everything the shell does against a server goes through raw commands
//! (`runCommand`) or driver-managed cursors (`cursorOpen` / `cursorMore`), so
//! options pass through untouched and results keep the server's shape. JS runs
//! on a single thread; each primitive blocks that thread on the tokio runtime
//! until the driver call finishes or the user interrupts it.

use std::{
    cell::RefCell,
    collections::HashMap,
    future::Future,
    io::Write,
    sync::{
        atomic::{AtomicBool, Ordering},
        OnceLock,
    },
    time::Duration,
};

use futures_util::StreamExt;
use mongodb::{
    bson::{self, Bson, Document},
    error::{Error as MongoError, ErrorKind},
    options::{
        ClientOptions, CursorType, ReadConcern, ReadPreference, ReadPreferenceOptions, SelectionCriteria, ServerApi,
        ServerApiVersion, SessionOptions, TagSet, TransactionOptions, WriteConcern,
    },
    raw_batch_cursor::{RawBatch, RawBatchCursor, SessionRawBatchCursor},
    Client, ClientSession,
};
use rquickjs::{function::Rest, Array, Ctx, Exception, Function, Object, Result as JsResult, TypedArray, Value};
use tokio::sync::Notify;

use crate::convert::{uint8_bytes, Conv};

static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
static INTERRUPTED: AtomicBool = AtomicBool::new(false);
static INTERRUPT_NOTIFY: Notify = Notify::const_new();

pub fn runtime() -> &'static tokio::runtime::Runtime {
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("failed to start the async runtime")
    })
}

/// Ask the running evaluation to stop (Ctrl-C in the REPL).
pub fn request_interrupt() {
    INTERRUPTED.store(true, Ordering::SeqCst);
    INTERRUPT_NOTIFY.notify_waiters();
}

pub fn clear_interrupt() {
    INTERRUPTED.store(false, Ordering::SeqCst);
}

pub fn interrupt_requested() -> bool {
    INTERRUPTED.load(Ordering::SeqCst)
}

struct WasInterrupted;

/// Block the JS thread on a driver future, giving up early on Ctrl-C.
fn block_on<F: Future>(fut: F) -> Result<F::Output, WasInterrupted> {
    runtime().block_on(async {
        let interrupted = INTERRUPT_NOTIFY.notified();
        tokio::pin!(interrupted);
        // Register before checking the flag so a signal cannot slip between.
        interrupted.as_mut().enable();
        if interrupt_requested() {
            return Err(WasInterrupted);
        }
        tokio::select! {
            biased;
            _ = &mut interrupted => Err(WasInterrupted),
            out = fut => Ok(out),
        }
    })
}

enum CursorEntry {
    Implicit(RawBatchCursor),
    WithSession { cursor: SessionRawBatchCursor, session: u32 },
}

#[derive(Default)]
struct State {
    next_id: u32,
    clients: HashMap<u32, Client>,
    cursors: HashMap<u32, CursorEntry>,
    sessions: HashMap<u32, ClientSession>,
}

impl State {
    fn new_id(&mut self) -> u32 {
        self.next_id += 1;
        self.next_id
    }
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

/// Drop every driver handle. Called before the process exits so cursors and
/// sessions are released while the runtime is still alive.
pub fn shutdown() {
    let (cursors, sessions, clients) = STATE.with(|s| {
        let mut s = s.borrow_mut();
        (std::mem::take(&mut s.cursors), std::mem::take(&mut s.sessions), std::mem::take(&mut s.clients))
    });
    let _guard = runtime().enter();
    drop(cursors);
    drop(sessions);
    drop(clients);
}

// --------------------------------------------------------------------
// Argument helpers
// --------------------------------------------------------------------

fn arg<'js>(ctx: &Ctx<'js>, args: &Rest<Value<'js>>, i: usize) -> Value<'js> {
    args.0.get(i).cloned().unwrap_or_else(|| Value::new_undefined(ctx.clone()))
}

fn arg_string<'js>(ctx: &Ctx<'js>, args: &Rest<Value<'js>>, i: usize, what: &str) -> JsResult<String> {
    match args.0.get(i).and_then(|v| v.as_string()) {
        Some(s) => s.to_string(),
        None => Err(Exception::throw_type(ctx, &format!("{what} must be a string"))),
    }
}

fn arg_u32<'js>(ctx: &Ctx<'js>, args: &Rest<Value<'js>>, i: usize, what: &str) -> JsResult<u32> {
    match args.0.get(i).and_then(|v| v.as_number()) {
        Some(n) if n >= 0.0 => Ok(n as u32),
        _ => Err(Exception::throw_type(ctx, &format!("{what} must be a handle"))),
    }
}

fn opt_object<'js>(value: &Value<'js>) -> Option<Object<'js>> {
    if value.is_null() || value.is_undefined() {
        None
    } else {
        value.as_object().cloned()
    }
}

fn opt_number<'js>(obj: &Object<'js>, key: &str) -> JsResult<Option<f64>> {
    let v: Value = obj.get(key)?;
    Ok(v.as_number())
}

fn client_for<'js>(ctx: &Ctx<'js>, id: u32) -> JsResult<Client> {
    STATE
        .with(|s| s.borrow().clients.get(&id).cloned())
        .ok_or_else(|| Exception::throw_message(ctx, "This connection has been closed"))
}

fn take_session<'js>(ctx: &Ctx<'js>, id: u32) -> JsResult<ClientSession> {
    STATE
        .with(|s| s.borrow_mut().sessions.remove(&id))
        .ok_or_else(|| Exception::throw_message(ctx, "Cannot use a session that has ended"))
}

fn put_session(id: u32, session: ClientSession) {
    STATE.with(|s| s.borrow_mut().sessions.insert(id, session));
}

// --------------------------------------------------------------------
// Errors
// --------------------------------------------------------------------

/// Turn a driver error into the JS error mongosh users expect. The shaping
/// (MongoServerError, MongoNetworkError, ...) happens in js/errors.js.
fn throw_driver_error<'js>(ctx: &Ctx<'js>, conv: &Conv<'js>, err: MongoError) -> rquickjs::Error {
    match driver_error_value(ctx, conv, &err) {
        Ok(value) => ctx.throw(value),
        Err(e) => e,
    }
}

fn driver_error_value<'js>(ctx: &Ctx<'js>, conv: &Conv<'js>, err: &MongoError) -> JsResult<Value<'js>> {
    let info = Object::new(ctx.clone())?;
    let kind = match err.kind.as_ref() {
        ErrorKind::Command(cmd) => {
            info.set("code", cmd.code)?;
            info.set("codeName", cmd.code_name.as_str())?;
            info.set("message", cmd.message.as_str())?;
            "command"
        }
        ErrorKind::Authentication { .. } => "authentication",
        ErrorKind::ServerSelection { .. } => "serverSelection",
        ErrorKind::Io(_) | ErrorKind::ConnectionPoolCleared { .. } => "network",
        ErrorKind::DnsResolve { .. } => "dns",
        ErrorKind::InvalidArgument { message, .. } => {
            info.set("message", message.as_str())?;
            "invalidArgument"
        }
        ErrorKind::Transaction { .. } => "transaction",
        ErrorKind::InvalidTlsConfig { .. } => "tls",
        _ => "other",
    };
    info.set("kind", kind)?;
    if !info.contains_key("message")? {
        info.set("message", err.kind.to_string())?;
    }
    let labels = Array::new(ctx.clone())?;
    for (i, label) in err.labels().iter().enumerate() {
        labels.set(i, label.as_str())?;
    }
    info.set("errorLabels", labels)?;
    if let Some(raw) = err.server_response() {
        if let Ok(doc) = Document::try_from(raw.as_ref()) {
            info.set("response", conv.document_to_js(&doc)?)?;
        }
    }
    let make: Function = ctx.globals().get::<_, Object>("__msh")?.get("driverError")?;
    make.call((info,))
}

fn throw_interrupted(ctx: &Ctx<'_>) -> rquickjs::Error {
    let make: JsResult<Function> = ctx.globals().get::<_, Object>("__msh").and_then(|m| m.get("interruptedError"));
    match make.and_then(|f| f.call::<_, Value>(())) {
        Ok(value) => ctx.throw(value),
        Err(e) => e,
    }
}

/// Run a driver future and map both failure modes to JS exceptions.
fn drive<'js, T, F>(ctx: &Ctx<'js>, conv: &Conv<'js>, fut: F) -> JsResult<T>
where
    F: Future<Output = Result<T, MongoError>>,
{
    match block_on(fut) {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(err)) => Err(throw_driver_error(ctx, conv, err)),
        Err(WasInterrupted) => Err(throw_interrupted(ctx)),
    }
}

// --------------------------------------------------------------------
// Option parsing
// --------------------------------------------------------------------

fn parse_read_preference<'js>(
    ctx: &Ctx<'js>,
    conv: &Conv<'js>,
    value: &Value<'js>,
) -> JsResult<Option<SelectionCriteria>> {
    let Some(obj) = opt_object(value) else { return Ok(None) };
    let mode: Value = obj.get("mode")?;
    let Some(mode) = mode.as_string() else { return Ok(None) };
    let mode = mode.to_string()?;

    let mut tag_sets: Option<Vec<TagSet>> = None;
    for key in ["tagSet", "tags", "tagSets"] {
        let raw: Value = obj.get(key)?;
        if let Some(arr) = raw.as_array() {
            let mut sets = Vec::new();
            for i in 0..arr.len() {
                let item: Value = arr.get(i)?;
                let doc = conv.to_document(&item)?;
                sets.push(doc.into_iter().map(|(k, v)| (k, bson_to_plain_string(&v))).collect::<TagSet>());
            }
            tag_sets = Some(sets);
            break;
        }
    }
    let max_staleness = opt_number(&obj, "maxStalenessSeconds")?.filter(|n| *n > 0.0).map(Duration::from_secs_f64);
    let options = if tag_sets.is_some() || max_staleness.is_some() {
        Some(ReadPreferenceOptions::builder().tag_sets(tag_sets).max_staleness(max_staleness).build())
    } else {
        None
    };
    let pref = match mode.as_str() {
        "primary" => ReadPreference::Primary,
        "primaryPreferred" => ReadPreference::PrimaryPreferred { options },
        "secondary" => ReadPreference::Secondary { options },
        "secondaryPreferred" => ReadPreference::SecondaryPreferred { options },
        "nearest" => ReadPreference::Nearest { options },
        other => return Err(Exception::throw_type(ctx, &format!("Invalid read preference mode \"{other}\""))),
    };
    Ok(Some(SelectionCriteria::ReadPreference(pref)))
}

fn bson_to_plain_string(value: &Bson) -> String {
    match value {
        Bson::String(s) => s.clone(),
        other => other.to_string(),
    }
}

struct CommandOpts {
    session: Option<u32>,
    criteria: Option<SelectionCriteria>,
}

fn parse_command_opts<'js>(ctx: &Ctx<'js>, conv: &Conv<'js>, value: &Value<'js>) -> JsResult<CommandOpts> {
    let Some(obj) = opt_object(value) else {
        return Ok(CommandOpts { session: None, criteria: None });
    };
    let session = opt_number(&obj, "session")?.map(|n| n as u32);
    let read_pref: Value = obj.get("readPreference")?;
    Ok(CommandOpts { session, criteria: parse_read_preference(ctx, conv, &read_pref)? })
}

// --------------------------------------------------------------------
// Connections and commands
// --------------------------------------------------------------------

/// connect(uri, { serverApi }) -> { id, hosts, defaultDatabase }
fn connect<'js>(ctx: Ctx<'js>, args: Rest<Value<'js>>) -> JsResult<Value<'js>> {
    let conv = Conv::new(&ctx)?;
    let uri = arg_string(&ctx, &args, 0, "connection string")?;
    let mut options = drive(&ctx, &conv, async { ClientOptions::parse(&uri).await })?;
    if let Some(opts) = opt_object(&arg(&ctx, &args, 1)) {
        let api: Value = opts.get("serverApi")?;
        if let Some(api) = opt_object(&api) {
            let version: String = api.get("version")?;
            if version != "1" {
                return Err(Exception::throw_type(
                    &ctx,
                    &format!("Invalid server API version={version}; must be in the following enum: [\"1\"]"),
                ));
            }
            let strict: Value = api.get("strict")?;
            let deprecation_errors: Value = api.get("deprecationErrors")?;
            let mut server_api = ServerApi::builder().version(ServerApiVersion::V1).build();
            server_api.strict = strict.as_bool();
            server_api.deprecation_errors = deprecation_errors.as_bool();
            options.server_api = Some(server_api);
        }
    }

    let out = Object::new(ctx.clone())?;
    let hosts = Array::new(ctx.clone())?;
    for (i, host) in options.hosts.iter().enumerate() {
        hosts.set(i, host.to_string())?;
    }
    out.set("hosts", hosts)?;
    if let Some(db) = &options.default_database {
        out.set("defaultDatabase", db.as_str())?;
    }

    let client = {
        let _guard = runtime().enter();
        Client::with_options(options)
    };
    let client = match client {
        Ok(client) => client,
        Err(err) => return Err(throw_driver_error(&ctx, &conv, err)),
    };
    let id = STATE.with(|s| {
        let mut s = s.borrow_mut();
        let id = s.new_id();
        s.clients.insert(id, client);
        id
    });
    out.set("id", id)?;
    Ok(out.into_value())
}

/// clientClose(clientId)
fn client_close<'js>(ctx: Ctx<'js>, args: Rest<Value<'js>>) -> JsResult<Value<'js>> {
    let id = arg_u32(&ctx, &args, 0, "client")?;
    let client = STATE.with(|s| s.borrow_mut().clients.remove(&id));
    if let Some(client) = client {
        let _ = block_on(async { client.shutdown().await });
    }
    Ok(Value::new_undefined(ctx))
}

/// runCommand(clientId, dbName, command, { session, readPreference }) -> reply
fn run_command<'js>(ctx: Ctx<'js>, args: Rest<Value<'js>>) -> JsResult<Value<'js>> {
    let conv = Conv::new(&ctx)?;
    let client = client_for(&ctx, arg_u32(&ctx, &args, 0, "client")?)?;
    let db = client.database(&arg_string(&ctx, &args, 1, "database name")?);
    let command = conv.to_document(&arg(&ctx, &args, 2))?;
    let opts = parse_command_opts(&ctx, &conv, &arg(&ctx, &args, 3))?;

    let reply = match opts.session {
        Some(sid) => {
            let mut session = take_session(&ctx, sid)?;
            let result = {
                let mut action = db.run_command(command).session(&mut session);
                if let Some(criteria) = opts.criteria {
                    action = action.selection_criteria(criteria);
                }
                drive(&ctx, &conv, async { action.await })
            };
            put_session(sid, session);
            result?
        }
        None => {
            let mut action = db.run_command(command);
            if let Some(criteria) = opts.criteria {
                action = action.selection_criteria(criteria);
            }
            drive(&ctx, &conv, async { action.await })?
        }
    };
    conv.document_to_js(&reply)
}

fn batch_to_js<'js>(ctx: &Ctx<'js>, conv: &Conv<'js>, batch: &RawBatch) -> JsResult<Value<'js>> {
    match Document::try_from(batch.as_raw_document()) {
        Ok(doc) => conv.document_to_js(&doc),
        Err(err) => Err(Exception::throw_message(ctx, &format!("invalid server reply: {err}"))),
    }
}

/// cursorOpen(clientId, dbName, command, opts) -> { handle, reply }
///
/// `command` is any cursor-producing command (find, aggregate, listIndexes,
/// ...). `opts` may carry `session`, `readPreference` and the settings the
/// driver applies to follow-up getMores: `batchSize`, `maxTimeMS`, `comment`,
/// `tailable`, `awaitData`.
fn cursor_open<'js>(ctx: Ctx<'js>, args: Rest<Value<'js>>) -> JsResult<Value<'js>> {
    let conv = Conv::new(&ctx)?;
    let client = client_for(&ctx, arg_u32(&ctx, &args, 0, "client")?)?;
    let db = client.database(&arg_string(&ctx, &args, 1, "database name")?);
    let command = conv.to_document(&arg(&ctx, &args, 2))?;
    let opts_value = arg(&ctx, &args, 3);
    let opts = parse_command_opts(&ctx, &conv, &opts_value)?;

    let mut cursor_type = None;
    let mut batch_size = None;
    let mut max_time = None;
    let mut comment = None;
    if let Some(obj) = opt_object(&opts_value) {
        let tailable: Value = obj.get("tailable")?;
        let await_data: Value = obj.get("awaitData")?;
        if tailable.as_bool() == Some(true) {
            cursor_type =
                Some(if await_data.as_bool() == Some(true) { CursorType::TailableAwait } else { CursorType::Tailable });
        }
        batch_size = opt_number(&obj, "batchSize")?.filter(|n| *n > 0.0).map(|n| n as u32);
        max_time = opt_number(&obj, "maxTimeMS")?.filter(|n| *n > 0.0).map(|n| Duration::from_millis(n as u64));
        let c: Value = obj.get("comment")?;
        if !c.is_undefined() && !c.is_null() {
            comment = Some(conv.to_bson_value(&c)?);
        }
    }

    macro_rules! configure {
        ($action:expr) => {{
            let mut action = $action;
            if let Some(criteria) = opts.criteria.clone() {
                action = action.selection_criteria(criteria);
            }
            if let Some(t) = cursor_type {
                action = action.cursor_type(t);
            }
            if let Some(n) = batch_size {
                action = action.batch_size(n);
            }
            if let Some(d) = max_time {
                action = action.max_time(d);
            }
            if let Some(c) = comment.clone() {
                action = action.comment(c);
            }
            action
        }};
    }

    let (entry, first) = match opts.session {
        Some(sid) => {
            let mut session = take_session(&ctx, sid)?;
            let result = drive(&ctx, &conv, async {
                let mut cursor = configure!(db.run_cursor_command(command)).session(&mut session).batch().await?;
                let first = cursor.stream(&mut session).next().await.transpose()?;
                Ok((cursor, first))
            });
            put_session(sid, session);
            let (cursor, first) = result?;
            (CursorEntry::WithSession { cursor, session: sid }, first)
        }
        None => {
            let (cursor, first) = drive(&ctx, &conv, async {
                let mut cursor = configure!(db.run_cursor_command(command)).batch().await?;
                let first = cursor.next().await.transpose()?;
                Ok((cursor, first))
            })?;
            (CursorEntry::Implicit(cursor), first)
        }
    };

    let out = Object::new(ctx.clone())?;
    match first {
        Some(batch) => out.set("reply", batch_to_js(&ctx, &conv, &batch)?)?,
        None => out.set("reply", Value::new_null(ctx.clone()))?,
    }
    let handle = STATE.with(|s| {
        let mut s = s.borrow_mut();
        let id = s.new_id();
        s.cursors.insert(id, entry);
        id
    });
    out.set("handle", handle)?;
    Ok(out.into_value())
}

/// cursorMore(handle) -> reply | null
///
/// Fetches the next server batch. Returns null once the cursor is exhausted;
/// a tailable cursor instead yields replies with an empty batch.
fn cursor_more<'js>(ctx: Ctx<'js>, args: Rest<Value<'js>>) -> JsResult<Value<'js>> {
    let conv = Conv::new(&ctx)?;
    let handle = arg_u32(&ctx, &args, 0, "cursor")?;
    let Some(entry) = STATE.with(|s| s.borrow_mut().cursors.remove(&handle)) else {
        return Ok(Value::new_null(ctx));
    };
    let (entry, result) = match entry {
        CursorEntry::Implicit(mut cursor) => {
            let result = drive(&ctx, &conv, async { cursor.next().await.transpose() });
            (CursorEntry::Implicit(cursor), result)
        }
        CursorEntry::WithSession { mut cursor, session: sid } => {
            let mut session = take_session(&ctx, sid)?;
            let result = drive(&ctx, &conv, async { cursor.stream(&mut session).next().await.transpose() });
            put_session(sid, session);
            (CursorEntry::WithSession { cursor, session: sid }, result)
        }
    };
    match result {
        Ok(Some(batch)) => {
            STATE.with(|s| s.borrow_mut().cursors.insert(handle, entry));
            batch_to_js(&ctx, &conv, &batch)
        }
        Ok(None) => {
            let _guard = runtime().enter();
            drop(entry);
            Ok(Value::new_null(ctx))
        }
        Err(e) => {
            let _guard = runtime().enter();
            drop(entry);
            Err(e)
        }
    }
}

/// cursorClose(handle) -- dropping the driver cursor kills it server-side.
fn cursor_close<'js>(ctx: Ctx<'js>, args: Rest<Value<'js>>) -> JsResult<Value<'js>> {
    let handle = arg_u32(&ctx, &args, 0, "cursor")?;
    let entry = STATE.with(|s| s.borrow_mut().cursors.remove(&handle));
    let _guard = runtime().enter();
    drop(entry);
    Ok(Value::new_undefined(ctx.clone()))
}

fn conn_string_result<'js>(ctx: &Ctx<'js>, conn: &crate::cli::ConnString) -> JsResult<Value<'js>> {
    let out = Object::new(ctx.clone())?;
    out.set("uri", conn.to_uri())?;
    out.set("redacted", conn.to_redacted())?;
    out.set("__normalized", true)?;
    Ok(out.into_value())
}

/// normalizeUri(address) -> { uri, redacted }
///
/// Applies the same rules as the command line to a db address or URI, for
/// `new Mongo(...)` and `connect(...)`.
fn normalize_uri<'js>(ctx: Ctx<'js>, args: Rest<Value<'js>>) -> JsResult<Value<'js>> {
    let address = arg_string(&ctx, &args, 0, "connection string")?;
    let cli =
        crate::cli::Cli { connection: if address.is_empty() { None } else { Some(address) }, ..Default::default() };
    match crate::cli::build_conn_string(&cli) {
        Ok(conn) => conn_string_result(&ctx, &conn),
        Err(message) => {
            let make: Function = ctx.globals().get::<_, Object>("__msh")?.get("invalidInput")?;
            let message = message.trim_start_matches("MongoshInvalidInputError: [COMMON-10001] ").to_string();
            let error: Value = make.call((message,))?;
            Err(ctx.throw(error))
        }
    }
}

/// withCredentials(uri, username, password, authSource, authMechanism)
///
/// A string sets the value, null clears it, undefined leaves it alone.
fn with_credentials<'js>(ctx: Ctx<'js>, args: Rest<Value<'js>>) -> JsResult<Value<'js>> {
    let uri = arg_string(&ctx, &args, 0, "connection string")?;
    let mut conn = crate::cli::ConnString::parse(&uri).map_err(|m| Exception::throw_message(&ctx, &m))?;
    let text = |i: usize| -> JsResult<Option<Option<String>>> {
        let value = arg(&ctx, &args, i);
        if value.is_undefined() {
            Ok(None)
        } else if value.is_null() {
            Ok(Some(None))
        } else {
            Ok(Some(Some(value.get::<rquickjs::Coerced<String>>()?.0)))
        }
    };
    if let Some(username) = text(1)? {
        if username.is_none() {
            conn.password = None;
        }
        conn.username = username;
    }
    if let Some(password) = text(2)? {
        conn.password = password;
    }
    for (index, key) in [(3, "authSource"), (4, "authMechanism")] {
        match text(index)? {
            Some(Some(value)) => conn.set(key, &crate::cli::encode_param(&value)),
            Some(None) if index == 3 && conn.username.is_none() => {
                conn.params.retain(|(k, _)| !k.eq_ignore_ascii_case(key))
            }
            _ => {}
        }
    }
    conn_string_result(&ctx, &conn)
}

// --------------------------------------------------------------------
// Sessions and transactions
// --------------------------------------------------------------------

fn parse_transaction_options<'js>(
    ctx: &Ctx<'js>,
    conv: &Conv<'js>,
    value: &Value<'js>,
) -> JsResult<Option<TransactionOptions>> {
    let Some(obj) = opt_object(value) else { return Ok(None) };
    let mut options = TransactionOptions::default();
    let read_concern: Value = obj.get("readConcern")?;
    if read_concern.is_object() {
        let doc = conv.to_document(&read_concern)?;
        options.read_concern = Some(
            bson::from_document::<ReadConcern>(doc)
                .map_err(|e| Exception::throw_type(ctx, &format!("Invalid readConcern: {e}")))?,
        );
    }
    let write_concern: Value = obj.get("writeConcern")?;
    if write_concern.is_object() {
        let doc = conv.to_document(&write_concern)?;
        options.write_concern = Some(
            bson::from_document::<WriteConcern>(doc)
                .map_err(|e| Exception::throw_type(ctx, &format!("Invalid writeConcern: {e}")))?,
        );
    }
    let read_pref: Value = obj.get("readPreference")?;
    options.selection_criteria = parse_read_preference(ctx, conv, &read_pref)?;
    options.max_commit_time = opt_number(&obj, "maxCommitTimeMS")?.map(|n| Duration::from_millis(n as u64));
    Ok(Some(options))
}

/// sessionStart(clientId, { causalConsistency, snapshot, defaultTransactionOptions }) -> { handle, id }
fn session_start<'js>(ctx: Ctx<'js>, args: Rest<Value<'js>>) -> JsResult<Value<'js>> {
    let conv = Conv::new(&ctx)?;
    let client = client_for(&ctx, arg_u32(&ctx, &args, 0, "client")?)?;
    let mut options = SessionOptions::default();
    if let Some(obj) = opt_object(&arg(&ctx, &args, 1)) {
        let causal: Value = obj.get("causalConsistency")?;
        options.causal_consistency = causal.as_bool();
        let snapshot: Value = obj.get("snapshot")?;
        options.snapshot = snapshot.as_bool();
        let txn: Value = obj.get("defaultTransactionOptions")?;
        options.default_transaction_options = parse_transaction_options(&ctx, &conv, &txn)?;
    }
    let session = drive(&ctx, &conv, async { client.start_session().with_options(options).await })?;
    let out = Object::new(ctx.clone())?;
    out.set("id", conv.document_to_js(session.id())?)?;
    let handle = STATE.with(|s| {
        let mut s = s.borrow_mut();
        let id = s.new_id();
        s.sessions.insert(id, session);
        id
    });
    out.set("handle", handle)?;
    Ok(out.into_value())
}

/// sessionEnd(handle)
fn session_end<'js>(ctx: Ctx<'js>, args: Rest<Value<'js>>) -> JsResult<Value<'js>> {
    let handle = arg_u32(&ctx, &args, 0, "session")?;
    let session = STATE.with(|s| s.borrow_mut().sessions.remove(&handle));
    let _guard = runtime().enter();
    drop(session);
    Ok(Value::new_undefined(ctx.clone()))
}

/// sessionTransaction(handle, "start" | "commit" | "abort", options)
fn session_transaction<'js>(ctx: Ctx<'js>, args: Rest<Value<'js>>) -> JsResult<Value<'js>> {
    let conv = Conv::new(&ctx)?;
    let handle = arg_u32(&ctx, &args, 0, "session")?;
    let op = arg_string(&ctx, &args, 1, "operation")?;
    let options = parse_transaction_options(&ctx, &conv, &arg(&ctx, &args, 2))?;
    let mut session = take_session(&ctx, handle)?;
    let result = drive(&ctx, &conv, async {
        match op.as_str() {
            "start" => match options {
                Some(options) => session.start_transaction().with_options(options).await,
                None => session.start_transaction().await,
            },
            "commit" => session.commit_transaction().await,
            _ => session.abort_transaction().await,
        }
    });
    put_session(handle, session);
    result?;
    Ok(Value::new_undefined(ctx))
}

/// sessionState(handle) -> { clusterTime, operationTime }
fn session_state<'js>(ctx: Ctx<'js>, args: Rest<Value<'js>>) -> JsResult<Value<'js>> {
    let conv = Conv::new(&ctx)?;
    let handle = arg_u32(&ctx, &args, 0, "session")?;
    let out = Object::new(ctx.clone())?;
    let (cluster_time, operation_time) = STATE.with(|s| {
        let s = s.borrow();
        match s.sessions.get(&handle) {
            Some(session) => {
                (session.cluster_time().and_then(|ct| bson::to_document(ct).ok()), session.operation_time())
            }
            None => (None, None),
        }
    });
    if let Some(ct) = cluster_time {
        out.set("clusterTime", conv.document_to_js(&ct)?)?;
    }
    if let Some(ts) = operation_time {
        out.set("operationTime", conv.to_js(&Bson::Timestamp(ts))?)?;
    }
    Ok(out.into_value())
}

/// sessionAdvance(handle, clusterTime | null, operationTime | null)
fn session_advance<'js>(ctx: Ctx<'js>, args: Rest<Value<'js>>) -> JsResult<Value<'js>> {
    let conv = Conv::new(&ctx)?;
    let handle = arg_u32(&ctx, &args, 0, "session")?;
    let cluster_time = arg(&ctx, &args, 1);
    let operation_time = arg(&ctx, &args, 2);
    let cluster_time =
        if cluster_time.is_object() { bson::from_document(conv.to_document(&cluster_time)?).ok() } else { None };
    let operation_time = match conv.to_bson_value(&operation_time)? {
        Bson::Timestamp(ts) => Some(ts),
        _ => None,
    };
    STATE.with(|s| {
        if let Some(session) = s.borrow_mut().sessions.get_mut(&handle) {
            if let Some(ct) = &cluster_time {
                session.advance_cluster_time(ct);
            }
            if let Some(ts) = operation_time {
                session.advance_operation_time(ts);
            }
        }
    });
    Ok(Value::new_undefined(ctx))
}

// --------------------------------------------------------------------
// BSON helpers
// --------------------------------------------------------------------

fn new_object_id<'js>(_ctx: Ctx<'js>, _args: Rest<Value<'js>>) -> JsResult<String> {
    Ok(bson::oid::ObjectId::new().to_hex())
}

fn new_uuid<'js>(ctx: Ctx<'js>, _args: Rest<Value<'js>>) -> JsResult<Value<'js>> {
    Ok(TypedArray::<u8>::new(ctx, bson::Uuid::new().bytes().to_vec())?.into_value())
}

/// decimalFromString(str) -> Uint8Array(16), or null when it does not parse.
fn decimal_from_string<'js>(ctx: Ctx<'js>, args: Rest<Value<'js>>) -> JsResult<Value<'js>> {
    let text = arg_string(&ctx, &args, 0, "decimal")?;
    match text.parse::<bson::Decimal128>() {
        Ok(d) => Ok(TypedArray::<u8>::new(ctx, d.bytes().to_vec())?.into_value()),
        Err(_) => Ok(Value::new_null(ctx)),
    }
}

fn decimal_to_string<'js>(ctx: Ctx<'js>, args: Rest<Value<'js>>) -> JsResult<String> {
    let bytes = arg(&ctx, &args, 0).as_object().and_then(uint8_bytes).and_then(|b| <[u8; 16]>::try_from(b).ok());
    match bytes {
        Some(raw) => Ok(bson::Decimal128::from_bytes(raw).to_string()),
        None => Err(Exception::throw_type(&ctx, "expected the 16 bytes of a Decimal128")),
    }
}

/// bsonSize(document) -> size in bytes of its BSON encoding
fn bson_size<'js>(ctx: Ctx<'js>, args: Rest<Value<'js>>) -> JsResult<f64> {
    let conv = Conv::new(&ctx)?;
    let doc = conv.to_document(&arg(&ctx, &args, 0))?;
    match bson::to_vec(&doc) {
        Ok(bytes) => Ok(bytes.len() as f64),
        Err(err) => Err(Exception::throw_message(&ctx, &err.to_string())),
    }
}

/// bsonRoundTrip(value) -> the value as it would come back from the server
fn bson_round_trip<'js>(ctx: Ctx<'js>, args: Rest<Value<'js>>) -> JsResult<Value<'js>> {
    let conv = Conv::new(&ctx)?;
    let value = conv.to_bson_value(&arg(&ctx, &args, 0))?;
    conv.to_js(&value)
}

// --------------------------------------------------------------------
// Process and I/O helpers
// --------------------------------------------------------------------

/// write(text, toStderr)
fn write<'js>(ctx: Ctx<'js>, args: Rest<Value<'js>>) -> JsResult<Value<'js>> {
    let text = arg_string(&ctx, &args, 0, "text")?;
    let to_stderr = arg(&ctx, &args, 1).as_bool().unwrap_or(false);
    // A closed pipe (`mongo-sh ... | head`) is not an error worth reporting.
    if to_stderr {
        let mut err = std::io::stderr().lock();
        let _ = err.write_all(text.as_bytes());
        let _ = err.flush();
    } else {
        let mut out = std::io::stdout().lock();
        if out.write_all(text.as_bytes()).is_err() || out.flush().is_err() {
            std::process::exit(0);
        }
    }
    Ok(Value::new_undefined(ctx))
}

/// sleep(ms) -- interruptible
fn sleep<'js>(ctx: Ctx<'js>, args: Rest<Value<'js>>) -> JsResult<Value<'js>> {
    let ms = arg(&ctx, &args, 0).as_number().unwrap_or(0.0).max(0.0);
    match block_on(async { tokio::time::sleep(Duration::from_secs_f64(ms / 1000.0)).await }) {
        Ok(()) => Ok(Value::new_undefined(ctx)),
        Err(WasInterrupted) => Err(throw_interrupted(&ctx)),
    }
}

fn read_file<'js>(ctx: Ctx<'js>, args: Rest<Value<'js>>) -> JsResult<String> {
    let path = arg_string(&ctx, &args, 0, "path")?;
    // Worded like Node's fs errors, which is what mongosh reports.
    std::fs::read_to_string(&path).map_err(|err| {
        let reason = match err.kind() {
            std::io::ErrorKind::NotFound => "ENOENT: no such file or directory, open".to_string(),
            std::io::ErrorKind::PermissionDenied => "EACCES: permission denied, open".to_string(),
            std::io::ErrorKind::IsADirectory => "EISDIR: illegal operation on a directory, read".to_string(),
            std::io::ErrorKind::InvalidData => "EILSEQ: file is not valid UTF-8, read".to_string(),
            _ => format!("EIO: {err}, open"),
        };
        Exception::throw_message(&ctx, &format!("{reason} '{path}'"))
    })
}

/// writeFile(path, text) -> true when the file was written
fn write_file<'js>(ctx: Ctx<'js>, args: Rest<Value<'js>>) -> JsResult<bool> {
    let path = arg_string(&ctx, &args, 0, "path")?;
    let text = arg_string(&ctx, &args, 1, "text")?;
    Ok(std::fs::write(&path, text).is_ok())
}

/// stateFile(name) -> path of a file in the shell's per-user directory
/// (~/.mongodb/mongo-sh), or null when there is no home directory.
fn state_file<'js>(ctx: Ctx<'js>, args: Rest<Value<'js>>) -> JsResult<Value<'js>> {
    let name = arg_string(&ctx, &args, 0, "name")?;
    match crate::state_dir() {
        Some(dir) => Ok(rquickjs::String::from_str(ctx, &dir.join(name).to_string_lossy())?.into_value()),
        None => Ok(Value::new_null(ctx)),
    }
}

fn cwd<'js>(_ctx: Ctx<'js>, _args: Rest<Value<'js>>) -> JsResult<String> {
    Ok(std::env::current_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default())
}

fn chdir<'js>(ctx: Ctx<'js>, args: Rest<Value<'js>>) -> JsResult<Value<'js>> {
    let path = arg_string(&ctx, &args, 0, "path")?;
    std::env::set_current_dir(&path)
        .map_err(|err| Exception::throw_message(&ctx, &format!("cannot change directory to '{path}': {err}")))?;
    Ok(Value::new_undefined(ctx))
}

fn env_var<'js>(ctx: Ctx<'js>, args: Rest<Value<'js>>) -> JsResult<Value<'js>> {
    let name = arg_string(&ctx, &args, 0, "name")?;
    match std::env::var(&name) {
        Ok(value) => Ok(rquickjs::String::from_str(ctx, &value)?.into_value()),
        Err(_) => Ok(Value::new_undefined(ctx)),
    }
}

fn password_prompt<'js>(ctx: Ctx<'js>, args: Rest<Value<'js>>) -> JsResult<String> {
    let prompt = args.0.first().and_then(|v| v.as_string()).and_then(|s| s.to_string().ok());
    rpassword::prompt_password(prompt.unwrap_or_else(|| "Enter password: ".into()))
        .map_err(|err| Exception::throw_message(&ctx, &format!("could not read password: {err}")))
}

fn exit<'js>(ctx: Ctx<'js>, args: Rest<Value<'js>>) -> JsResult<Value<'js>> {
    let code = arg(&ctx, &args, 0).as_number().unwrap_or(0.0) as i32;
    let _ = std::io::stdout().flush();
    shutdown();
    std::process::exit(code);
}

/// promiseState(promise) -> ["pending"] | ["fulfilled", value] | ["rejected", reason]
fn promise_state<'js>(ctx: Ctx<'js>, args: Rest<Value<'js>>) -> JsResult<Value<'js>> {
    let out = Array::new(ctx.clone())?;
    let value = arg(&ctx, &args, 0);
    let Some(promise) = value.as_promise() else {
        out.set(0, "pending")?;
        return Ok(out.into_value());
    };
    match promise.state() {
        rquickjs::promise::PromiseState::Pending => out.set(0, "pending")?,
        rquickjs::promise::PromiseState::Resolved => {
            out.set(0, "fulfilled")?;
            out.set(1, promise.result::<Value>().transpose()?)?;
        }
        rquickjs::promise::PromiseState::Rejected => {
            out.set(0, "rejected")?;
            // `result` re-throws the rejection; take it back off the context.
            let _ = promise.result::<Value>();
            out.set(1, ctx.catch())?;
        }
    }
    Ok(out.into_value())
}

/// evalScript(source, filename) -- used by load().
fn eval_script<'js>(ctx: Ctx<'js>, args: Rest<Value<'js>>) -> JsResult<Value<'js>> {
    let source = arg_string(&ctx, &args, 0, "source")?;
    let filename = arg_string(&ctx, &args, 1, "filename")?;
    match crate::engine::eval_user(&ctx, &source, &filename) {
        Ok(value) => Ok(value),
        Err(thrown) => Err(ctx.throw(thrown)),
    }
}

fn hostname<'js>(_ctx: Ctx<'js>, _args: Rest<Value<'js>>) -> JsResult<String> {
    Ok(crate::os_hostname())
}

pub fn register<'js>(ctx: &Ctx<'js>) -> JsResult<()> {
    let native = Object::new(ctx.clone())?;
    macro_rules! def {
        ($($name:literal => $f:expr),* $(,)?) => {
            $( native.set($name, Function::new(ctx.clone(), $f)?.with_name($name)?)?; )*
        };
    }
    def! {
        "connect" => connect,
        "normalizeUri" => normalize_uri,
        "withCredentials" => with_credentials,
        "clientClose" => client_close,
        "runCommand" => run_command,
        "cursorOpen" => cursor_open,
        "cursorMore" => cursor_more,
        "cursorClose" => cursor_close,
        "sessionStart" => session_start,
        "sessionEnd" => session_end,
        "sessionTransaction" => session_transaction,
        "sessionState" => session_state,
        "sessionAdvance" => session_advance,
        "newObjectId" => new_object_id,
        "newUuid" => new_uuid,
        "decimalFromString" => decimal_from_string,
        "decimalToString" => decimal_to_string,
        "bsonSize" => bson_size,
        "bsonRoundTrip" => bson_round_trip,
        "write" => write,
        "sleep" => sleep,
        "readFile" => read_file,
        "writeFile" => write_file,
        "stateFile" => state_file,
        "cwd" => cwd,
        "chdir" => chdir,
        "env" => env_var,
        "passwordPrompt" => password_prompt,
        "exit" => exit,
        "promiseState" => promise_state,
        "evalScript" => eval_script,
        "hostname" => hostname,
    }
    native.set("version", env!("CARGO_PKG_VERSION"))?;
    native.set("platform", std::env::consts::OS)?;
    native.set("arch", std::env::consts::ARCH)?;
    ctx.globals().set("__native", native)?;
    Ok(())
}
