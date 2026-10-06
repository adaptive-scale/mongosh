//! Command-line parsing and connection-string construction, following
//! mongosh's rules (`mongosh [options] [db address] [file names]`).

use std::fmt::Write as _;

pub const USAGE: &str = r#"
  $ mongo-sh [options] [db address] [file names (ending in .js or .mongodb)]

  Options:

    -h, --help                                 Show this usage information
    -f, --file [arg]                           Load the specified mongosh script
        --host [arg]                           Server to connect to
        --port [arg]                           Port to connect to
        --build-info                           Show build information
        --version                              Show version information
        --quiet                                Silence output from the shell during the connection process
        --shell                                Run the shell after executing files
        --nodb                                 Don't connect to mongod on startup - no 'db address' [arg] expected
        --norc                                 Will not run the '.mongoshrc.js' file on start up
        --eval [arg]                           Evaluate javascript
        --json[=canonical|relaxed]             Print result of --eval as Extended JSON, including errors
        --retryWrites[=true|false]             Automatically retry write operations upon transient network errors (Default: true)
        --deep-inspect[=true|false]            Force full depth inspection of server results (default: true if in interactive mode)

  Authentication Options:

    -u, --username [arg]                       Username for authentication
    -p, --password [arg]                       Password for authentication
        --authenticationDatabase [arg]         User source (defaults to dbname)
        --authenticationMechanism [arg]        Authentication mechanism
        --awsIamSessionToken [arg]             AWS IAM Temporary Session Token ID
        --gssapiServiceName [arg]              Service name to use when authenticating using GSSAPI/Kerberos

  TLS Options:

        --tls                                  Use TLS for all connections
        --tlsCertificateKeyFile [arg]          PEM certificate/key file for TLS
        --tlsCertificateKeyFilePassword [arg]  Password for key in PEM file for TLS
        --tlsCAFile [arg]                      Certificate Authority file for TLS
        --tlsAllowInvalidHostnames             Allow connections to servers with non-matching hostnames
        --tlsAllowInvalidCertificates          Allow connections to servers with invalid certificates

  API version options:

        --apiVersion [arg]                     Specifies the API version to connect with
        --apiStrict                            Use strict API version mode
        --apiDeprecationErrors                 Fail deprecated commands for the specified API version

  DB Address Examples:

        foo                                    Foo database on local machine
        192.168.0.5/foo                        Foo database on 192.168.0.5 machine
        192.168.0.5:9999/foo                   Foo database on 192.168.0.5 machine on port 9999
        mongodb://192.168.0.5:9999/foo         Connection string URI can also be used

  File Names:

        A list of files to run. Files must end in .js and will exit after unless --shell is specified.

  Examples:

        Start mongo-sh using 'ships' database on specified connection string:
        $ mongo-sh mongodb://192.168.0.5:9999/ships

  For more information on usage: https://github.com/adaptive-scale/mongo-sh
"#;

#[derive(Default, Debug, Clone)]
pub struct Cli {
    pub help: bool,
    pub version: bool,
    pub build_info: bool,
    pub quiet: bool,
    pub shell: bool,
    pub nodb: bool,
    pub norc: bool,
    pub evals: Vec<String>,
    pub files: Vec<String>,
    pub host: Option<String>,
    pub port: Option<String>,
    pub connection: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    /// `-p` was given without a value: ask for the password.
    pub password_prompt: bool,
    pub auth_db: Option<String>,
    pub auth_mechanism: Option<String>,
    pub aws_session_token: Option<String>,
    pub gssapi_service_name: Option<String>,
    pub tls: bool,
    pub tls_cert_key_file: Option<String>,
    pub tls_cert_key_password: Option<String>,
    pub tls_ca_file: Option<String>,
    pub tls_allow_invalid_hostnames: bool,
    pub tls_allow_invalid_certificates: bool,
    pub api_version: Option<String>,
    pub api_strict: bool,
    pub api_deprecation_errors: bool,
    /// `canonical` or `relaxed` when --json is set.
    pub json: Option<String>,
    pub retry_writes: Option<bool>,
    pub deep_inspect: Option<bool>,
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Flag,
    /// Takes a value, from `--opt=value` or the next argument.
    Value,
    /// Value is optional and only read from `--opt=value`.
    OptionalValue,
    /// Value is optional; the next argument is used unless it is an option.
    OptionalNext,
}

const OPTIONS: &[(&str, Kind)] = &[
    ("help", Kind::Flag),
    ("version", Kind::Flag),
    ("build-info", Kind::Flag),
    ("buildInfo", Kind::Flag),
    ("quiet", Kind::Flag),
    ("shell", Kind::Flag),
    ("nodb", Kind::Flag),
    ("norc", Kind::Flag),
    ("eval", Kind::Value),
    ("file", Kind::Value),
    ("host", Kind::Value),
    ("port", Kind::Value),
    // Accepted for compatibility with go-mongosh 1.x; mongosh takes the
    // connection string as a positional argument.
    ("uri", Kind::Value),
    ("username", Kind::Value),
    ("password", Kind::OptionalNext),
    ("authenticationDatabase", Kind::Value),
    ("authenticationMechanism", Kind::Value),
    ("awsIamSessionToken", Kind::Value),
    ("gssapiServiceName", Kind::Value),
    ("tls", Kind::Flag),
    ("tlsCertificateKeyFile", Kind::Value),
    ("tlsCertificateKeyFilePassword", Kind::Value),
    ("tlsCAFile", Kind::Value),
    ("tlsAllowInvalidHostnames", Kind::Flag),
    ("tlsAllowInvalidCertificates", Kind::Flag),
    ("apiVersion", Kind::Value),
    ("apiStrict", Kind::Flag),
    ("apiDeprecationErrors", Kind::Flag),
    ("json", Kind::OptionalValue),
    ("retryWrites", Kind::OptionalValue),
    ("deep-inspect", Kind::OptionalValue),
    ("deepInspect", Kind::OptionalValue),
];

fn lookup(name: &str) -> Option<(&'static str, Kind)> {
    OPTIONS.iter().find(|(n, _)| *n == name).copied()
}

/// mongosh's argument parser drops one pair of matching outer quotes from
/// string values, which is what makes `--eval 'db.c.find()'` work from shells
/// that do not treat single quotes as quoting (cmd.exe).
///
/// mongosh also strips `'a' + 'b'` down to `a' + 'b` and then fails with a
/// syntax error. That case is left intact here: the quotes are only dropped
/// when they enclose the whole value.
fn strip_outer_quotes(value: &str) -> String {
    let bytes = value.as_bytes();
    if bytes.len() >= 2 && (bytes[0] == b'"' || bytes[0] == b'\'') && bytes[bytes.len() - 1] == bytes[0] {
        let inner = &value[1..value.len() - 1];
        if !inner.contains(bytes[0] as char) {
            return inner.to_string();
        }
    }
    value.to_string()
}

fn parse_bool(name: &str, value: &str) -> Result<bool, String> {
    match value {
        "true" | "1" | "" => Ok(true),
        "false" | "0" => Ok(false),
        other => Err(format!("Error parsing command line: --{name} expects true or false, got '{other}'")),
    }
}

pub fn parse(args: &[String]) -> Result<Cli, String> {
    let mut cli = Cli::default();
    let mut positionals: Vec<String> = Vec::new();
    let mut i = 0;

    while i < args.len() {
        let arg = &args[i];
        i += 1;

        if arg == "--" {
            positionals.extend(args[i..].iter().cloned());
            break;
        }

        let (name, inline): (String, Option<String>) = if let Some(rest) = arg.strip_prefix("--") {
            match rest.split_once('=') {
                Some((n, v)) => (n.to_string(), Some(v.to_string())),
                None => (rest.to_string(), None),
            }
        } else if arg.starts_with('-') && arg.len() > 1 {
            let rest = &arg[1..];
            let (n, v) = match rest.split_once('=') {
                Some((n, v)) => (n, Some(v.to_string())),
                None => (rest, None),
            };
            let long = match n {
                "h" => "help",
                "f" => "file",
                "u" => "username",
                "p" => "password",
                // Single-dash long options (`-eval`) are how go-mongosh 1.x
                // spelled them; keep accepting them.
                other if lookup(other).is_some() => other,
                _ => return Err(format!("Error parsing command line: unrecognized option: {arg}")),
            };
            (long.to_string(), v)
        } else {
            positionals.push(arg.clone());
            continue;
        };

        let Some((name, kind)) = lookup(&name) else {
            return Err(format!("Error parsing command line: unrecognized option: {arg}"));
        };

        let value: Option<String> = match kind {
            Kind::Flag => inline,
            Kind::OptionalValue => inline,
            Kind::Value => match inline {
                Some(v) => Some(v),
                // An option left without a value is ignored, as mongosh does.
                None => match args.get(i) {
                    Some(next) => {
                        i += 1;
                        Some(next.clone())
                    }
                    None => continue,
                },
            },
            Kind::OptionalNext => match inline {
                Some(v) => Some(v),
                None => match args.get(i) {
                    Some(next) if !next.starts_with('-') => {
                        i += 1;
                        Some(next.clone())
                    }
                    _ => None,
                },
            },
        };
        let text = value.as_deref().map(strip_outer_quotes);
        let flag = |v: &Option<String>| parse_bool(name, v.as_deref().unwrap_or(""));

        match name {
            "help" => cli.help = flag(&text)?,
            "version" => cli.version = flag(&text)?,
            "build-info" | "buildInfo" => cli.build_info = flag(&text)?,
            "quiet" => cli.quiet = flag(&text)?,
            "shell" => cli.shell = flag(&text)?,
            "nodb" => cli.nodb = flag(&text)?,
            "norc" => cli.norc = flag(&text)?,
            "eval" => cli.evals.push(text.unwrap_or_default()),
            "file" => cli.files.push(text.unwrap_or_default()),
            "host" => cli.host = text,
            "port" => cli.port = text,
            "uri" => cli.connection = text,
            "username" => cli.username = text,
            "password" => match text {
                Some(p) => cli.password = Some(p),
                None => cli.password_prompt = true,
            },
            "authenticationDatabase" => cli.auth_db = text,
            "authenticationMechanism" => cli.auth_mechanism = text,
            "awsIamSessionToken" => cli.aws_session_token = text,
            "gssapiServiceName" => cli.gssapi_service_name = text,
            "tls" => cli.tls = flag(&text)?,
            "tlsCertificateKeyFile" => cli.tls_cert_key_file = text,
            "tlsCertificateKeyFilePassword" => cli.tls_cert_key_password = text,
            "tlsCAFile" => cli.tls_ca_file = text,
            "tlsAllowInvalidHostnames" => cli.tls_allow_invalid_hostnames = flag(&text)?,
            "tlsAllowInvalidCertificates" => cli.tls_allow_invalid_certificates = flag(&text)?,
            "apiVersion" => cli.api_version = text,
            "apiStrict" => cli.api_strict = flag(&text)?,
            "apiDeprecationErrors" => cli.api_deprecation_errors = flag(&text)?,
            "json" => {
                let mode = text.unwrap_or_else(|| "canonical".into());
                cli.json = Some(match mode.as_str() {
                    "" | "true" | "canonical" => "canonical".to_string(),
                    "relaxed" => "relaxed".to_string(),
                    other => {
                        return Err(format!(
                            "Error parsing command line: --json must be 'canonical' or 'relaxed', got '{other}'"
                        ))
                    }
                });
            }
            "retryWrites" => cli.retry_writes = Some(flag(&text)?),
            "deep-inspect" | "deepInspect" => cli.deep_inspect = Some(flag(&text)?),
            _ => unreachable!("option table and match arms are kept in sync"),
        }
    }

    // The first positional is the db address unless it names a script.
    let mut positionals = positionals.into_iter();
    if !cli.nodb && cli.connection.is_none() {
        if let Some(first) = positionals.next() {
            if is_connection_specifier(&first) {
                cli.connection = Some(first);
            } else {
                cli.files.push(first);
            }
        }
    }
    cli.files.extend(positionals);
    Ok(cli)
}

fn is_connection_specifier(arg: &str) -> bool {
    arg.starts_with("mongodb://")
        || arg.starts_with("mongodb+srv://")
        || !(arg.ends_with(".js") || arg.ends_with(".mongodb"))
}

// --------------------------------------------------------------------
// Connection strings
// --------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct ConnString {
    pub srv: bool,
    pub username: Option<String>,
    pub password: Option<String>,
    pub hosts: String,
    pub database: String,
    pub params: Vec<(String, String)>,
}

fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for b in input.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            let _ = write!(out, "%{b:02X}");
        }
    }
    out
}

/// Encoding for query values: like `percent_encode`, but leaves the
/// characters mongosh leaves alone and writes spaces as `+`.
pub fn encode_param(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for b in input.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~' | b':' | b',' | b'/' | b'@') {
            out.push(b as char);
        } else if b == b' ' {
            out.push('+');
        } else {
            let _ = write!(out, "%{b:02X}");
        }
    }
    out
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    let hex = |b: u8| (b as char).to_digit(16).map(|d| d as u8);
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(hi * 16 + lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

impl ConnString {
    pub fn parse(uri: &str) -> Result<ConnString, String> {
        let (srv, rest) = if let Some(rest) = uri.strip_prefix("mongodb+srv://") {
            (true, rest)
        } else if let Some(rest) = uri.strip_prefix("mongodb://") {
            (false, rest)
        } else {
            return Err(format!("Invalid connection string \"{uri}\""));
        };
        let (rest, query) = match rest.split_once('?') {
            Some((r, q)) => (r, q),
            None => (rest, ""),
        };
        let (authority, database) = match rest.split_once('/') {
            Some((a, d)) => (a, d),
            None => (rest, ""),
        };
        let (userinfo, hosts) = match authority.rsplit_once('@') {
            Some((u, h)) => (Some(u), h),
            None => (None, authority),
        };
        if hosts.is_empty() {
            return Err(format!("Invalid connection string \"{uri}\""));
        }
        let (username, password) = match userinfo {
            Some(info) => match info.split_once(':') {
                Some((u, p)) => (Some(percent_decode(u)), Some(percent_decode(p))),
                None => (Some(percent_decode(info)), None),
            },
            None => (None, None),
        };
        let params = query
            .split('&')
            .filter(|p| !p.is_empty())
            .map(|p| match p.split_once('=') {
                Some((k, v)) => (k.to_string(), v.to_string()),
                None => (p.to_string(), String::new()),
            })
            .collect();
        Ok(ConnString {
            srv,
            username: username.filter(|u| !u.is_empty()),
            password,
            hosts: hosts.to_string(),
            database: database.to_string(),
            params,
        })
    }

    pub fn has(&self, key: &str) -> bool {
        self.params.iter().any(|(k, _)| k.eq_ignore_ascii_case(key))
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.params.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v.as_str())
    }

    /// Set a parameter, replacing an existing one. `value` must already be
    /// safe to place in a query string.
    pub fn set(&mut self, key: &str, value: &str) {
        match self.params.iter_mut().find(|(k, _)| k.eq_ignore_ascii_case(key)) {
            Some(entry) => entry.1 = value.to_string(),
            None => self.params.push((key.to_string(), value.to_string())),
        }
    }

    fn render(&self, credentials: Option<String>) -> String {
        let mut out = String::from(if self.srv { "mongodb+srv://" } else { "mongodb://" });
        if let Some(credentials) = credentials {
            out.push_str(&credentials);
            out.push('@');
        }
        out.push_str(&self.hosts);
        out.push('/');
        out.push_str(&self.database);
        if !self.params.is_empty() {
            out.push('?');
            let query: Vec<String> = self.params.iter().map(|(k, v)| format!("{k}={v}")).collect();
            out.push_str(&query.join("&"));
        }
        out
    }

    /// The string handed to the driver.
    pub fn to_uri(&self) -> String {
        let credentials = self.username.as_ref().map(|user| match &self.password {
            Some(password) => format!("{}:{}", percent_encode(user), percent_encode(password)),
            None => percent_encode(user),
        });
        self.render(credentials)
    }

    /// The string shown to the user, with credentials hidden.
    pub fn to_redacted(&self) -> String {
        self.render(self.username.as_ref().map(|_| "<credentials>".to_string()))
    }

    fn host_list(&self) -> Vec<&str> {
        self.hosts.split(',').collect()
    }

    fn all_hosts_loopback(&self) -> bool {
        !self.srv
            && self.host_list().iter().all(|h| {
                let host = if h.starts_with('[') {
                    h.split(']').next().unwrap_or("").trim_start_matches('[')
                } else {
                    h.rsplit_once(':').map(|(host, _)| host).unwrap_or(h)
                };
                host == "localhost" || host == "::1" || host.starts_with("127.") || host == "0.0.0.0"
            })
    }

    pub fn needs_password(&self) -> bool {
        if self.username.is_none() || self.password.is_some() {
            return false;
        }
        let mechanism = self.get("authMechanism").unwrap_or("").to_ascii_uppercase();
        !matches!(mechanism.as_str(), "GSSAPI" | "MONGODB-X509" | "MONGODB-AWS" | "MONGODB-OIDC")
    }
}

fn is_plain_host_list(value: &str) -> bool {
    !value.is_empty()
        && value.split(',').all(|part| {
            let (host, port) = match part.rsplit_once(':') {
                Some((h, p)) => (h, Some(p)),
                None => (part, None),
            };
            !host.is_empty()
                && host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
                && port.is_none_or(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
        })
}

fn conflict_check(cli: &Cli) -> Result<(), String> {
    if cli.host.is_some() || cli.port.is_some() {
        return Err("MongoshInvalidInputError: [COMMON-10001] If a full URI is provided, you cannot also specify --host or --port".to_string());
    }
    Ok(())
}

/// Build the connection string from the db address and --host/--port, the
/// way mongosh does, without the credential and TLS options applied yet.
fn base_conn_string(cli: &Cli) -> Result<ConnString, String> {
    let address = cli.connection.as_deref().unwrap_or("");
    let default_host = cli.host.clone().unwrap_or_else(|| "127.0.0.1".into());
    let default_port = cli.port.clone().unwrap_or_else(|| "27017".into());

    // --host replSet/host1:port,host2:port
    if let Some(host) = &cli.host {
        if let Some((set_name, hosts)) = host.split_once('/') {
            if !set_name.is_empty() && is_plain_host_list(hosts) {
                let mut conn = ConnString::parse(&format!("mongodb://{hosts}/{}", percent_encode(address)))?;
                conn.set("replicaSet", &percent_encode(set_name));
                return Ok(conn);
            }
        }
        // --host host1:port,host2:port
        if host.contains(',') && is_plain_host_list(host) {
            return ConnString::parse(&format!("mongodb://{host}/{}", percent_encode(address)));
        }
    }

    if address.is_empty() {
        let host = if default_host.contains(':') && cli.port.is_none() {
            default_host.clone()
        } else {
            format!("{default_host}:{default_port}")
        };
        let mut conn = ConnString::parse(&format!("mongodb://{host}/"))?;
        conn.set("directConnection", "true");
        return Ok(conn);
    }

    if address.starts_with("mongodb+srv://") {
        conflict_check(cli)?;
        return ConnString::parse(address);
    }
    if address.starts_with("mongodb://") {
        conflict_check(cli)?;
        let mut conn = ConnString::parse(address)?;
        add_direct_connection(&mut conn);
        return Ok(conn);
    }

    // host[:port][/db], or just a database name.
    let (host_port, db) = match address.split_once('/') {
        Some((h, d)) => (h, Some(d)),
        None => (address, None),
    };
    let (mut host, port) = match host_port.rsplit_once(':') {
        Some((h, p)) if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) => {
            (Some(h.to_string()), Some(p.to_string()))
        }
        _ => (Some(host_port.to_string()), None),
    };
    let host_ok = host.as_deref().is_some_and(|h| {
        h.len() >= 2
            && h.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
            && h.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    });
    let mut database = db.map(|d| d.to_string());
    if !host_ok || db.is_some_and(|d| d.chars().any(char::is_whitespace)) {
        if address.chars().any(|c| matches!(c, '/' | '\\' | '.' | ' ' | '"' | '$')) {
            return Err(format!("MongoshInvalidInputError: [COMMON-10001] Invalid URI: {address}"));
        }
        host = None;
        database = Some(address.to_string());
    } else if port.is_none() && database.is_none() && !host.as_deref().unwrap_or("").contains('.') {
        // No port, no db and no dot: "foo" is a database, "foo.bar" a host.
        database = host.take();
    }
    if host.is_some() || port.is_some() {
        conflict_check(cli)?;
    }
    let mut conn = ConnString::parse(&format!(
        "mongodb://{}:{}/{}",
        host.unwrap_or(default_host),
        port.unwrap_or(default_port),
        percent_encode(&database.unwrap_or_default())
    ))?;
    add_direct_connection(&mut conn);
    Ok(conn)
}

/// A single host without a replica set name is connected to directly instead
/// of being used as a seed for discovery.
fn add_direct_connection(conn: &mut ConnString) {
    if !conn.srv
        && !conn.has("replicaSet")
        && !conn.has("directConnection")
        && !conn.has("loadBalanced")
        && conn.host_list().len() == 1
    {
        conn.set("directConnection", "true");
    }
}

pub fn build_conn_string(cli: &Cli) -> Result<ConnString, String> {
    let mut conn = base_conn_string(cli)?;

    if !conn.has("serverSelectionTimeoutMS") && conn.all_hosts_loopback() {
        conn.set("serverSelectionTimeoutMS", "2000");
    }
    if let Some(user) = &cli.username {
        conn.username = Some(user.clone());
    }
    if let Some(password) = &cli.password {
        conn.password = Some(password.clone());
    }
    if let Some(db) = &cli.auth_db {
        conn.set("authSource", &encode_param(db));
    }
    if let Some(mechanism) = &cli.auth_mechanism {
        conn.set("authMechanism", &encode_param(mechanism));
    }
    let mut mechanism_properties: Vec<String> = Vec::new();
    if let Some(token) = &cli.aws_session_token {
        mechanism_properties.push(format!("AWS_SESSION_TOKEN:{}", encode_param(token)));
    }
    if let Some(service) = &cli.gssapi_service_name {
        mechanism_properties.push(format!("SERVICE_NAME:{}", encode_param(service)));
    }
    if !mechanism_properties.is_empty() {
        conn.set("authMechanismProperties", &mechanism_properties.join(","));
    }
    if cli.tls {
        conn.set("tls", "true");
    }
    if let Some(path) = &cli.tls_cert_key_file {
        conn.set("tlsCertificateKeyFile", &percent_encode(path));
    }
    if let Some(password) = &cli.tls_cert_key_password {
        conn.set("tlsCertificateKeyFilePassword", &percent_encode(password));
    }
    if let Some(path) = &cli.tls_ca_file {
        conn.set("tlsCAFile", &percent_encode(path));
    }
    if cli.tls_allow_invalid_hostnames {
        conn.set("tlsAllowInvalidHostnames", "true");
    }
    if cli.tls_allow_invalid_certificates {
        conn.set("tlsAllowInvalidCertificates", "true");
    }
    if let Some(retry) = cli.retry_writes {
        conn.set("retryWrites", if retry { "true" } else { "false" });
    }
    if !conn.has("appName") {
        conn.set("appName", &format!("mongo-sh+{}", env!("CARGO_PKG_VERSION")));
    }
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cli(args: &[&str]) -> Cli {
        parse(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>()).unwrap()
    }

    fn uri(args: &[&str]) -> String {
        let mut conn = build_conn_string(&cli(args)).unwrap();
        conn.params.retain(|(k, _)| k != "appName");
        conn.to_uri()
    }

    #[test]
    fn default_address() {
        assert_eq!(uri(&[]), "mongodb://127.0.0.1:27017/?directConnection=true&serverSelectionTimeoutMS=2000");
    }

    #[test]
    fn host_and_port_options() {
        assert_eq!(
            uri(&["--host", "db.example.com", "--port", "27018"]),
            "mongodb://db.example.com:27018/?directConnection=true"
        );
    }

    #[test]
    fn database_name_only() {
        assert_eq!(uri(&["foo"]), "mongodb://127.0.0.1:27017/foo?directConnection=true&serverSelectionTimeoutMS=2000");
    }

    #[test]
    fn host_port_and_database() {
        assert_eq!(uri(&["192.168.0.5:9999/foo"]), "mongodb://192.168.0.5:9999/foo?directConnection=true");
        assert_eq!(uri(&["192.168.0.5/foo"]), "mongodb://192.168.0.5:27017/foo?directConnection=true");
    }

    #[test]
    fn full_uri_keeps_replica_set_discovery() {
        assert_eq!(uri(&["mongodb://a:1,b:2/db?replicaSet=rs"]), "mongodb://a:1,b:2/db?replicaSet=rs");
        assert_eq!(uri(&["mongodb+srv://cluster.example.com/db"]), "mongodb+srv://cluster.example.com/db");
    }

    #[test]
    fn replica_set_host_option() {
        assert_eq!(uri(&["--host", "rs0/a:1,b:2"]), "mongodb://a:1,b:2/?replicaSet=rs0");
    }

    #[test]
    fn credentials_are_encoded_and_redacted() {
        let conn =
            build_conn_string(&cli(&["-u", "ad min", "-p", "p@ss:w/rd", "--authenticationDatabase", "admin"])).unwrap();
        assert!(conn.to_uri().starts_with("mongodb://ad%20min:p%40ss%3Aw%2Frd@127.0.0.1:27017/?"));
        assert!(conn.to_uri().contains("authSource=admin"));
        assert!(conn.to_redacted().starts_with("mongodb://<credentials>@127.0.0.1:27017/?"));
    }

    #[test]
    fn password_without_value_prompts() {
        let c = cli(&["-u", "admin", "-p", "--quiet"]);
        assert!(c.password_prompt && c.password.is_none() && c.quiet);
        let c = cli(&["-u", "admin", "-p", "secret"]);
        assert_eq!(c.password.as_deref(), Some("secret"));
    }

    #[test]
    fn files_and_evals() {
        let c = cli(&["--eval", "1+1", "--eval=2", "script.js", "other.mongodb"]);
        assert_eq!(c.evals, vec!["1+1", "2"]);
        assert_eq!(c.files, vec!["script.js", "other.mongodb"]);
        assert!(c.connection.is_none());
        let c = cli(&["mydb", "script.js"]);
        assert_eq!(c.connection.as_deref(), Some("mydb"));
        assert_eq!(c.files, vec!["script.js"]);
    }

    #[test]
    fn outer_quotes_are_stripped_like_mongosh() {
        assert_eq!(cli(&["--eval", "'hello'"]).evals, vec!["hello"]);
        assert_eq!(cli(&["--eval", "'a' + 'b'"]).evals, vec!["'a' + 'b'"]);
    }

    #[test]
    fn go_mongosh_flag_spellings_still_work() {
        let c = cli(&["-uri", "mongodb://h:1", "-quiet", "-eval", "1"]);
        assert_eq!(c.connection.as_deref(), Some("mongodb://h:1"));
        assert!(c.quiet);
        assert_eq!(c.evals, vec!["1"]);
    }

    #[test]
    fn json_modes() {
        assert_eq!(cli(&["--json"]).json.as_deref(), Some("canonical"));
        assert_eq!(cli(&["--json=relaxed"]).json.as_deref(), Some("relaxed"));
    }

    #[test]
    fn unknown_options_are_rejected() {
        assert!(parse(&["--bogus".to_string()]).is_err());
    }
}
