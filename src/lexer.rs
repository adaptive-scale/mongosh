//! A small JavaScript scanner used for the two things the shell needs to know
//! about input before handing it to the engine:
//!
//! * whether it is incomplete (so the REPL keeps reading lines), and
//! * where its top-level `let` / `const` / `class` declarations are, so they
//!   can be turned into `var` bindings. Like mongosh, that lets a name be
//!   declared again on a later line instead of failing with a redeclaration
//!   error, and makes a function or class declaration the value of its line.
//!
//! It understands strings, template literals, comments and regex literals well
//! enough to never mistake their contents for code.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Prev {
    /// Start of input.
    None,
    /// Identifier, number, string, template, regex, `)` or `]`: a value just
    /// ended, so a following `/` is a division.
    Value,
    /// Keyword after which an expression starts (`return`, `typeof`, ...).
    Keyword,
    /// `}` -- ends a block or an object literal.
    CloseBrace,
    /// `;`
    Semicolon,
    /// Any other punctuator or operator.
    Operator,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Open {
    Paren,
    Bracket,
    Brace,
    /// `{` opening the body of a top-level class or function declaration.
    /// Closing it ends the statement and re-states the declared name, so the
    /// declaration is also the value of the line (as it is in mongosh).
    DeclBody,
    /// `${` inside a template literal.
    TemplateExpr,
}

const EXPRESSION_KEYWORDS: &[&str] = &[
    "return",
    "typeof",
    "instanceof",
    "in",
    "of",
    "new",
    "delete",
    "void",
    "throw",
    "case",
    "do",
    "else",
    "yield",
    "await",
];

/// An edit to apply to the source: replace `range` with `text`.
struct Edit {
    start: usize,
    end: usize,
    text: String,
}

struct Scan {
    edits: Vec<Edit>,
    incomplete: bool,
}

fn is_ident_start(c: char) -> bool {
    c.is_alphabetic() || c == '_' || c == '$'
}

fn is_ident_part(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$'
}

fn scan(src: &str) -> Scan {
    let bytes: Vec<(usize, char)> = src.char_indices().collect();
    let n = bytes.len();
    let at = |i: usize| -> char {
        if i < n {
            bytes[i].1
        } else {
            '\0'
        }
    };
    let pos = |i: usize| -> usize {
        if i < n {
            bytes[i].0
        } else {
            src.len()
        }
    };

    let mut edits = Vec::new();
    let mut stack: Vec<Open> = Vec::new();
    let mut prev = Prev::None;
    let mut newline_before = false;
    // Name of a top-level class/function declaration whose body is next.
    let mut pending_decl: Option<String> = None;
    let mut open_decls: Vec<String> = Vec::new();
    let mut after_async = false;
    let mut unterminated = false;
    let mut i = 0;

    // Skip a shebang line.
    if src.starts_with("#!") {
        while i < n && at(i) != '\n' {
            i += 1;
        }
    }

    while i < n {
        let c = at(i);

        if c == '\n' {
            newline_before = true;
            i += 1;
            continue;
        }
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        if c == '/' && at(i + 1) == '/' {
            while i < n && at(i) != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && at(i + 1) == '*' {
            i += 2;
            let mut closed = false;
            while i < n {
                if at(i) == '*' && at(i + 1) == '/' {
                    i += 2;
                    closed = true;
                    break;
                }
                if at(i) == '\n' {
                    newline_before = true;
                }
                i += 1;
            }
            if !closed {
                unterminated = true;
            }
            continue;
        }

        // A statement can start here when the previous token ended one.
        let statement_start = stack.is_empty()
            && match prev {
                Prev::None | Prev::Semicolon | Prev::CloseBrace => true,
                Prev::Value => newline_before,
                Prev::Keyword | Prev::Operator => false,
            };

        if c == '\'' || c == '"' {
            i += 1;
            while i < n && at(i) != c && at(i) != '\n' {
                if at(i) == '\\' {
                    i += 1;
                }
                i += 1;
            }
            i += 1;
            prev = Prev::Value;
            newline_before = false;
            continue;
        }

        if c == '`' {
            i += 1;
            i = scan_template(&at, n, i, &mut stack, &mut unterminated);
            prev = Prev::Value;
            newline_before = false;
            continue;
        }

        if c == '/' {
            let regex_allowed = matches!(prev, Prev::None | Prev::Operator | Prev::Keyword | Prev::Semicolon)
                || (prev == Prev::CloseBrace && stack.is_empty());
            if regex_allowed {
                i += 1;
                let mut in_class = false;
                while i < n && at(i) != '\n' {
                    match at(i) {
                        '\\' => i += 1,
                        '[' => in_class = true,
                        ']' => in_class = false,
                        '/' if !in_class => break,
                        _ => {}
                    }
                    i += 1;
                }
                i += 1;
                while i < n && is_ident_part(at(i)) {
                    i += 1;
                }
                prev = Prev::Value;
                newline_before = false;
                continue;
            }
        }

        if is_ident_start(c) {
            let start = i;
            while i < n && is_ident_part(at(i)) {
                i += 1;
            }
            let word: String = bytes[start..i].iter().map(|(_, ch)| *ch).collect();
            let after_dot = start > 0 && at(start - 1) == '.';

            let declares = (statement_start || after_async) && !after_dot;
            after_async = false;
            if declares {
                // What follows the keyword decides whether it declares a name.
                let mut j = i;
                while j < n && at(j).is_whitespace() {
                    j += 1;
                }
                let next = at(j);
                let name_at = |mut k: usize| -> String {
                    let from = k;
                    while k < n && is_ident_part(at(k)) {
                        k += 1;
                    }
                    bytes[from..k].iter().map(|(_, ch)| *ch).collect()
                };
                match word.as_str() {
                    "const" => {
                        edits.push(Edit { start: pos(start), end: pos(i), text: "var".into() });
                    }
                    "let" if is_ident_start(next) || next == '[' || next == '{' => {
                        edits.push(Edit { start: pos(start), end: pos(i), text: "var".into() });
                    }
                    "class" if is_ident_start(next) => {
                        let name = name_at(j);
                        if name != "extends" {
                            edits.push(Edit { start: pos(start), end: pos(start), text: format!("var {name} = ") });
                            pending_decl = Some(name);
                        }
                    }
                    "async" if is_ident_start(next) && name_at(j) == "function" => {
                        after_async = true;
                    }
                    "function" => {
                        // function name() {}, function* name() {}
                        let mut k = j;
                        if at(k) == '*' {
                            k += 1;
                            while k < n && at(k).is_whitespace() {
                                k += 1;
                            }
                        }
                        if is_ident_start(at(k)) {
                            pending_decl = Some(name_at(k));
                        }
                    }
                    _ => {}
                }
            }

            prev = if !after_dot && EXPRESSION_KEYWORDS.contains(&word.as_str()) { Prev::Keyword } else { Prev::Value };
            newline_before = false;
            continue;
        }

        if c.is_ascii_digit() || (c == '.' && at(i + 1).is_ascii_digit()) {
            let is_hex = c == '0' && matches!(at(i + 1), 'x' | 'X');
            i += 1;
            while i < n && (is_ident_part(at(i)) || at(i) == '.') {
                // Exponent signs belong to the number: 1e-5
                if !is_hex && matches!(at(i), 'e' | 'E') && matches!(at(i + 1), '-' | '+') {
                    i += 1;
                }
                i += 1;
            }
            prev = Prev::Value;
            newline_before = false;
            continue;
        }

        match c {
            '(' => {
                stack.push(Open::Paren);
                prev = Prev::Operator;
            }
            '[' => {
                stack.push(Open::Bracket);
                prev = Prev::Operator;
            }
            '{' => {
                match pending_decl.take() {
                    Some(name) if stack.is_empty() => {
                        open_decls.push(name);
                        stack.push(Open::DeclBody);
                    }
                    other => {
                        pending_decl = other;
                        stack.push(Open::Brace);
                    }
                }
                prev = Prev::Operator;
            }
            ')' | ']' => {
                stack.pop();
                prev = Prev::Value;
            }
            '}' => match stack.pop() {
                Some(Open::TemplateExpr) => {
                    i += 1;
                    i = scan_template(&at, n, i, &mut stack, &mut unterminated);
                    prev = Prev::Value;
                    newline_before = false;
                    continue;
                }
                Some(Open::DeclBody) => {
                    // End the statement so the next line cannot be parsed as
                    // a call on it, then name the declaration as its value.
                    let name = open_decls.pop().unwrap_or_default();
                    edits.push(Edit { start: pos(i + 1), end: pos(i + 1), text: format!(";{name};") });
                    prev = Prev::Semicolon;
                }
                _ => prev = Prev::CloseBrace,
            },
            ';' => prev = Prev::Semicolon,
            '+' | '-' if at(i + 1) == c => {
                // `x++` ends a value, `++x` does not; either way the input is
                // not left waiting for an operand.
                i += 1;
                prev = Prev::Value;
            }
            _ => prev = Prev::Operator,
        }
        newline_before = false;
        i += 1;
    }

    let dangling_operator = prev == Prev::Operator && stack.is_empty() && ends_with_dangling_operator(src);
    Scan { edits, incomplete: unterminated || !stack.is_empty() || dangling_operator }
}

/// Scan the body of a template literal starting just after its opening
/// backtick (or just after the `}` closing an interpolation). Returns the
/// index after the closing backtick, or after the `${` that re-enters code.
fn scan_template(
    at: &dyn Fn(usize) -> char,
    n: usize,
    mut i: usize,
    stack: &mut Vec<Open>,
    unterminated: &mut bool,
) -> usize {
    while i < n {
        match at(i) {
            '\\' => i += 2,
            '`' => return i + 1,
            '$' if at(i + 1) == '{' => {
                stack.push(Open::TemplateExpr);
                return i + 2;
            }
            _ => i += 1,
        }
    }
    *unterminated = true;
    i
}

/// True when the code ends with an operator that needs a right-hand side,
/// e.g. `db.coll.find().` or `x = 1 +`.
fn ends_with_dangling_operator(src: &str) -> bool {
    let trimmed = src.trim_end();
    const DANGLING: &[&str] =
        &[".", ",", "=", "+", "-", "*", "/", "%", "&", "|", "^", "<", ">", "?", ":", "!", "~", "=>"];
    DANGLING.iter().any(|op| trimmed.ends_with(op))
}

/// Does this input need more lines before it can be evaluated?
pub fn is_incomplete(src: &str) -> bool {
    scan(src).incomplete
}

/// Rewrite top-level lexical declarations to `var` bindings.
pub fn rewrite_toplevel(src: &str) -> String {
    let mut edits = scan(src).edits;
    if edits.is_empty() {
        return src.to_string();
    }
    edits.sort_by_key(|e| e.start);
    let mut out = String::with_capacity(src.len() + 16);
    let mut cursor = 0;
    for edit in edits {
        out.push_str(&src[cursor..edit.start]);
        out.push_str(&edit.text);
        cursor = edit.end;
    }
    out.push_str(&src[cursor..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_top_level_declarations() {
        assert_eq!(rewrite_toplevel("let a = 1"), "var a = 1");
        assert_eq!(rewrite_toplevel("const a = 1; let b = 2"), "var a = 1; var b = 2");
        assert_eq!(rewrite_toplevel("const {a, b} = o"), "var {a, b} = o");
        assert_eq!(rewrite_toplevel("let [x] = arr"), "var [x] = arr");
        assert_eq!(rewrite_toplevel("x = 1\nlet y = 2"), "x = 1\nvar y = 2");
    }

    #[test]
    fn leaves_nested_declarations_alone() {
        assert_eq!(rewrite_toplevel("for (let i = 0; i < 3; i++) {}"), "for (let i = 0; i < 3; i++) {}");
        assert_eq!(rewrite_toplevel("{ let a = 1 }"), "{ let a = 1 }");
        assert_eq!(rewrite_toplevel("function f() { const a = 1 }"), "function f() { const a = 1 };f;");
        assert_eq!(rewrite_toplevel("x => { let a = 1 }"), "x => { let a = 1 }");
    }

    #[test]
    fn ignores_keywords_inside_literals() {
        assert_eq!(rewrite_toplevel("'let a = 1'"), "'let a = 1'");
        assert_eq!(rewrite_toplevel("`const ${1} let`"), "`const ${1} let`");
        assert_eq!(rewrite_toplevel("// let a\n/* const b */ 1"), "// let a\n/* const b */ 1");
        assert_eq!(rewrite_toplevel("x = /let a/.test(s)"), "x = /let a/.test(s)");
        assert_eq!(rewrite_toplevel("obj.let = 1"), "obj.let = 1");
    }

    #[test]
    fn rewrites_class_declarations() {
        assert_eq!(rewrite_toplevel("class A {}"), "var A = class A {};A;");
        assert_eq!(
            rewrite_toplevel("class A extends B { m() { return {} } }\nnew A()"),
            "var A = class A extends B { m() { return {} } };A;\nnew A()"
        );
        assert_eq!(rewrite_toplevel("x = class {}"), "x = class {}");
        assert_eq!(rewrite_toplevel("var A = class B {}"), "var A = class B {}");
    }

    #[test]
    fn function_declarations_become_the_value_of_the_line() {
        assert_eq!(rewrite_toplevel("function f(a = {}) { return {} }"), "function f(a = {}) { return {} };f;");
        assert_eq!(rewrite_toplevel("async function h() {}"), "async function h() {};h;");
        assert_eq!(rewrite_toplevel("function* gen() {}"), "function* gen() {};gen;");
        assert_eq!(rewrite_toplevel("x = function () {}"), "x = function () {}");
        assert_eq!(rewrite_toplevel("(function f() {})()"), "(function f() {})()");
        assert_eq!(rewrite_toplevel("function f() { function g() {} }"), "function f() { function g() {} };f;");
    }

    #[test]
    fn template_interpolation_keeps_depth() {
        assert_eq!(rewrite_toplevel("`${ {a: 1}.a }`; let b = 1"), "`${ {a: 1}.a }`; var b = 1");
    }

    #[test]
    fn detects_incomplete_input() {
        assert!(is_incomplete("db.coll.find({"));
        assert!(is_incomplete("function f() {"));
        assert!(is_incomplete("[1, 2,"));
        assert!(is_incomplete("`abc"));
        assert!(is_incomplete("/* comment"));
        assert!(is_incomplete("db.coll.find()."));
        assert!(is_incomplete("x = 1 +"));
        assert!(is_incomplete("`a ${ {"));
    }

    #[test]
    fn detects_complete_input() {
        assert!(!is_incomplete("db.coll.find({})"));
        assert!(!is_incomplete("x = '{'"));
        assert!(!is_incomplete("x = /[{]/"));
        assert!(!is_incomplete("// {"));
        assert!(!is_incomplete("i++"));
        assert!(!is_incomplete("`a ${ {b: 1}.b } c`"));
        assert!(!is_incomplete("show dbs"));
        assert!(!is_incomplete("x = 1e-5"));
    }
}
