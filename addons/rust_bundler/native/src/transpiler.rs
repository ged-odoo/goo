use lazy_static::lazy_static;
use regex::{Captures, Regex, RegexSet, Replacer};
use std::borrow::Cow;
use std::collections::HashSet;

const PATTERN_URL: &str = r#"(?x)
    /?(?P<module>\S+)    # /module name
    /([\S/]*/)?static/   # ... /static/
    (?P<type>src|tests|lib)  # src, test, or lib file
    (?P<url>/[\S/]*)     # URL (/...)
"#;

const PATTERN_EXPORT_FCT: &str = r#"(?mx)
    ^
    (?P<space>\s*)                          # space and empty line
    export\s+                               # export
    (?P<type>(async\s+)?function)\s+        # async function or function
    (?P<identifier>[\w$]+)                  # name of the function
"#;

const PATTERN_EXPORT_CLASS: &str = r#"(?mx)
    ^
    (?P<space>\s*)                          # space and empty line
    export\s+                               # export
    (?P<type>class)\s+                      # class
    (?P<identifier>[\w$]+)                  # name of the class
"#;

const PATTERN_EXPORT_FCT_DEFAULT: &str = r#"(?mx)
    ^
    (?P<space>\s*)                          # space and empty line
    export\s+default\s+                     # export default
    (?P<type>(async\s+)?function)\s+        # async function or function
    (?P<identifier>[\w$]+)                  # name of the function
"#;

const PATTERN_EXPORT_CLASS_DEFAULT: &str = r#"(?mx)
    ^
    (?P<space>\s*)                          # space and empty line
    export\s+default\s+                     # export default
    (?P<type>class)\s+                      # class
    (?P<identifier>[\w$]+)                  # name of the class or the function
"#;

const PATTERN_GETTEXT: &str = r#"(?mx)
    ^
    \s*const\s*\{
    (?:\s*\w*\s*,)*
    \s*(_t)\s*
    (?:,\s*\w*\s*)*,?\s*
    \}\s*=\s*require\("@web/core/l10n/translation"\);$
"#;

const PATTERN_T_FN: &str = r#"(?mx)
    ^
    \s*const\s*\{
    (?:\s*\w*\s*,)*
    \s*(appTranslateFn)\s*
    (?:,\s*\w*\s*)*,?\s*
    \}\s*=\s*require\("@web/core/l10n/translation"\);$
"#;

const PATTERN_EXPORT_VAR: &str = r#"(?mx)
    ^
    (?P<space>\s*)              # space and empty line
    export\s+                   # export
    (?P<type>let|const|var)\s+  # let or cont or var
    (?P<identifier>[\w$]+)      # variable name
"#;

const PATTERN_EXPORT_DEFAULT_VAR: &str = r#"(?mx)
    ^
    (?P<space>\s*)              # space and empty line
    export\s+default\s+         # export default
    (?P<type>let|const|var)\s+  # let or const or var
    (?P<identifier>[\w$]+)\s*   # variable name
"#;

const PATTERN_EXPORT_OBJECT: &str = r#"(?mx)
    ^
    (?P<space>\s*)                      # space and empty line
    export\s*                           # export
    (?P<object>\{[\w$\s,]+\})             # { a, b, c as x, ... }
"#;

const PATTERN_EXPORT_FROM: &str = r#"(?mx)
    ^
    (?P<space>\s*)                      # space and empty line
    export\s*                           # export
    (?P<object>\{[\w$\s,]+\})\s*          # { a, b, c as x, ... }
    from\s*                             # from
    (?P<path>(?P<quote>["'])([^"'`]+)(["']))   # "file path"
"#;

const PATTERN_EXPORT_STAR_FROM: &str = r#"(?mx)
    ^
    (?P<space>\s*)                      # space and empty line
    export\s*\*\s*from\s*               # export * from
    (?P<path>(?P<quote>["'])([^"'`]+)(["']))   # "file path"
"#;

const PATTERN_EXPORT_DEFAULT: &str = r#"(?mx)
    ^
    (?P<space>\s*)      # space and empty line
    export\s+default    # export default
    (\s+[\w$]+\s*=)?    # something (optional)
"#;

const PATTERN_IMPORT_BASIC: &str = r#"(?mx)
    ^
    (?P<space>\s*)                      # space and empty line
    import\s+                           # import
    (?P<object>\{[\s\w$,]+\})\s*          # { a, b, c as x, ... }
    from\s*                             # from
    (?P<path>(?P<quote>["'])([^"'`]+)(["']))   # "file path"
"#;

const PATTERN_IMPORT_LEGACY_DEFAULT: &str = r#"(?mx)
    ^
    (?P<space>\s*)                                      # space and empty line
    import\s+                                           # import
    (?P<identifier>[\w$]+)\s*                           # default variable name
    from\s*                                             # from
    (?P<path>(?P<quote>["'])([^@\."'`][^"'`]*)(["']))  # legacy alias file
"#;

const PATTERN_IMPORT_DEFAULT: &str = r#"(?mx)
    ^
    (?P<space>\s*)                      # space and empty line
    import\s+                           # import
    (?P<identifier>[\w$]+)\s*           # default variable name
    from\s*                             # from
    (?P<path>(?P<quote>["'])([^"'`]+)(["']))   # "file path"
"#;

const PATTERN_IS_PATH_LEGACY: &str = r#"(?P<quote>["'])([^@\."'`][^"'`]*)(["'])"#;

const PATTERN_IMPORT_DEFAULT_AND_NAMED: &str = r#"(?mx)
    ^
    (?P<space>\s*)                                  # space and empty line
    import\s+                                       # import
    (?P<default_export>[\w$]+)\s*,\s*               # default variable name,
    (?P<named_exports>\{[\s\w$,]+\})\s*                # { a, b, c as x, ... }
    from\s*                                         # from
    (?P<path>(?P<quote>["'])([^"'`]+)(["']))   # "file path"
"#;

const PATTERN_RELATIVE_REQUIRE: &str = r#"(?mx)
    ^(?P<prefix>[^/*\n]*)require\((?P<quote>["'`])([^"'`]+)(["'])\) # require("some/path")
"#;

const PATTERN_IMPORT_STAR: &str = r#"(?mx)
    ^(?P<space>\s*)         # indentation
    import\s+\*\s+as\s+     # import * as
    (?P<identifier>[\w$]+)  # alias
    \s*from\s*              # from
    (?P<path>[^;\n]+)       # path
"#;

const PATTERN_IMPORT_DEFAULT_AND_STAR: &str = r#"(?mx)
    ^(?P<space>\s*)                    # indentation
    import\s+                          # import
    (?P<default_export>[\w$]+)\s*,\s*  # default export name,
    \*\s+as\s+                         # * as
    (?P<named_exports_alias>[\w$]+)    # alias
    \s*from\s*                         # from
    (?P<path>[^;\n]+)                  # path
"#;

const PATTERN_IMPORT_UNNAMED_RELATIVE: &str = r#"(?mx)
    ^(?P<space>\s*)     # indentation
    import\s+           # import
    (?P<path>[^;\n]+)   # relative path
"#;

const PATTERN_URL_INDEX: &str = r#"(?mx)
    require\s*                 # require
    \(\s*                      # (
    (?P<path>(?P<quote>["'])([^"'`]*/index/?)(["']))  # path ended by /index or /index/
    \s*\)                      # )
"#;

const PATTERN_ODOO_MODULE: &str = r#"(?x)
    \s*                                # starting white space
    /(\*|/)                            # /* or //
    .*                                 # any comment in between (optional)
    @odoo-module                       # '@odoo-module' statement
    (?P<ignore>\s+ignore)?             # module in src | tests which should not be transpiled (optional)
    (\s+alias=(?P<alias>[^\s*]+))?     # alias (e.g. alias=web.Widget, alias=@web/../tests/utils) (optional)
    (\s+default=(?P<default>[\w$]+))?  # no implicit default export (e.g. default=false) (optional)
"#;

lazy_static! {
    static ref URL_RE: Regex = Regex::new(PATTERN_URL).unwrap();
    static ref EXPORT_FCT_RE: Regex = Regex::new(PATTERN_EXPORT_FCT).unwrap();
    static ref EXPORT_CLASS_RE: Regex = Regex::new(PATTERN_EXPORT_CLASS).unwrap();
    static ref EXPORT_FCT_DEFAULT_RE: Regex = Regex::new(PATTERN_EXPORT_FCT_DEFAULT).unwrap();
    static ref EXPORT_CLASS_DEFAULT_RE: Regex = Regex::new(PATTERN_EXPORT_CLASS_DEFAULT).unwrap();
    static ref GETTEXT_RE: Regex = Regex::new(PATTERN_GETTEXT).unwrap();
    static ref T_FN_RE: Regex = Regex::new(PATTERN_T_FN).unwrap();
    static ref EXPORT_VAR_RE: Regex = Regex::new(PATTERN_EXPORT_VAR).unwrap();
    static ref EXPORT_DEFAULT_VAR_RE: Regex = Regex::new(PATTERN_EXPORT_DEFAULT_VAR).unwrap();
    static ref EXPORT_OBJECT_RE: Regex = Regex::new(PATTERN_EXPORT_OBJECT).unwrap();
    static ref EXPORT_FROM_RE: Regex = Regex::new(PATTERN_EXPORT_FROM).unwrap();
    static ref EXPORT_STAR_FROM_RE: Regex = Regex::new(PATTERN_EXPORT_STAR_FROM).unwrap();
    static ref EXPORT_DEFAULT_RE: Regex = Regex::new(PATTERN_EXPORT_DEFAULT).unwrap();
    static ref IMPORT_BASIC_RE: Regex = Regex::new(PATTERN_IMPORT_BASIC).unwrap();
    static ref IMPORT_LEGACY_DEFAULT_RE: Regex = Regex::new(PATTERN_IMPORT_LEGACY_DEFAULT).unwrap();
    static ref IMPORT_DEFAULT: Regex = Regex::new(PATTERN_IMPORT_DEFAULT).unwrap();
    static ref IS_PATH_LEGACY_RE: Regex = Regex::new(PATTERN_IS_PATH_LEGACY).unwrap();
    static ref IMPORT_DEFAULT_AND_NAMED_RE: Regex = Regex::new(PATTERN_IMPORT_DEFAULT_AND_NAMED).unwrap();
    static ref RELATIVE_REQUIRE_RE: Regex = Regex::new(PATTERN_RELATIVE_REQUIRE).unwrap();
    static ref IMPORT_STAR: Regex = Regex::new(PATTERN_IMPORT_STAR).unwrap();
    static ref IMPORT_DEFAULT_AND_STAR: Regex = Regex::new(PATTERN_IMPORT_DEFAULT_AND_STAR).unwrap();
    static ref IMPORT_UNNAMED_RELATIVE_RE: Regex = Regex::new(PATTERN_IMPORT_UNNAMED_RELATIVE).unwrap();
    static ref URL_INDEX_RE: Regex = Regex::new(PATTERN_URL_INDEX).unwrap();
    static ref ODOO_MODULE_RE: Regex = Regex::new(PATTERN_ODOO_MODULE).unwrap();

    // RegexSet for bulk matching
    static ref REPLACEMENTS_SET: RegexSet = RegexSet::new([
        PATTERN_IMPORT_LEGACY_DEFAULT,      // 0
        PATTERN_IMPORT_BASIC,               // 1
        PATTERN_IMPORT_DEFAULT_AND_NAMED,   // 2
        PATTERN_IMPORT_DEFAULT_AND_STAR,    // 3
        PATTERN_IMPORT_DEFAULT,             // 4
        PATTERN_IMPORT_STAR,                // 5
        PATTERN_IMPORT_UNNAMED_RELATIVE,    // 6
        PATTERN_EXPORT_FROM,                // 7
        PATTERN_EXPORT_STAR_FROM,           // 8
        PATTERN_URL_INDEX,                  // 9
        PATTERN_RELATIVE_REQUIRE,           // 10
        PATTERN_EXPORT_FCT,                 // 11
        PATTERN_EXPORT_CLASS,               // 12
        PATTERN_EXPORT_VAR,                 // 13
        PATTERN_EXPORT_OBJECT,              // 14
        PATTERN_EXPORT_FCT_DEFAULT,         // 15
        PATTERN_EXPORT_CLASS_DEFAULT,       // 16
        PATTERN_EXPORT_DEFAULT_VAR,         // 17
        PATTERN_EXPORT_DEFAULT,             // 18
    ]).unwrap();
}

pub struct ModuleInfo {
    pub alias: Option<String>,
    pub default: Option<String>,
}

pub fn analyze_module(url: &str, content: &str) -> (bool, Option<ModuleInfo>) {
    if content.contains("@odoo-module") {
        if let Some(caps) = ODOO_MODULE_RE.captures(content) {
            if caps.name("ignore").is_some() {
                return (false, None);
            }
            let alias = caps.name("alias").map(|m| m.as_str().to_string());
            let default = caps.name("default").map(|m| m.as_str().to_string());
            return (true, Some(ModuleInfo { alias, default }));
        }
    }

    if let Some(start) = url.strip_prefix('/') {
        if let Some(idx) = start.find('/') {
            let rest = &start[idx..];
            if rest.starts_with("/static/src") || rest.starts_with("/static/tests") {
                return (true, None);
            }
        }
    }
    (false, None)
}

fn replace_cow<'a, R>(input: Cow<'a, str>, regex: &Regex, replacer: R) -> Cow<'a, str>
where
    R: Replacer,
{
    match input {
        Cow::Borrowed(s) => regex.replace_all(s, replacer),
        Cow::Owned(ref s) => {
            let result = regex.replace_all(s, replacer);
            match result {
                Cow::Borrowed(_) => input,
                Cow::Owned(new_s) => Cow::Owned(new_s),
            }
        }
    }
}

pub fn transpile_javascript(url: &str, content: &str, info: Option<&ModuleInfo>) -> String {
    let module_path = url_to_module_path(url);
    let legacy_odoo_define = get_aliased_odoo_define_content(&module_path, info);
    let mut dependencies = Vec::new();

    // Check which regexes match
    let matches = REPLACEMENTS_SET.matches(content);
    let mut content = Cow::Borrowed(content);

    // 0..6 are imports. 10 is require.
    let any_import = (0..=6).any(|i| matches.matched(i));
    let has_require = matches.matched(10);

    if matches.matched(0) {
        content = convert_legacy_default_import(content);
    }
    if matches.matched(1) {
        content = convert_basic_import(content);
    }
    if matches.matched(2) {
        content = convert_default_and_named_import(content);
    }
    if matches.matched(3) {
        content = convert_default_and_star_import(content);
    }
    if matches.matched(4) {
        content = convert_default_import(content);
    }
    if matches.matched(5) {
        content = convert_star_import(content);
    }
    if matches.matched(6) {
        content = convert_unnamed_relative_import(content);
    }
    if matches.matched(7) {
        content = convert_from_export(content);
    }
    if matches.matched(8) {
        content = convert_star_from_export(content);
    }

    // Require conversions (index 9 and 10)
    // Run if original matched OR if any import matched (which generates require)
    if matches.matched(9) || any_import || has_require || matches.matched(7) || matches.matched(8) {
        content = remove_index(content);
    }
    if has_require || any_import || matches.matched(7) || matches.matched(8) {
        content = convert_relative_require(url, &mut dependencies, content);
    }

    if matches.matched(11) {
        content = convert_export_function(content);
    }
    if matches.matched(12) {
        content = convert_export_class(content);
    }
    if matches.matched(13) {
        content = convert_variable_export(content);
    }
    if matches.matched(14) {
        content = convert_object_export(content);
    }

    if matches.matched(15) {
        content = convert_export_fct_default(content);
    }
    if matches.matched(16) {
        content = convert_export_class_default(content);
    }
    if matches.matched(17) {
        content = convert_export_default_var(content);
    }
    if matches.matched(18) {
        content = convert_export_default_simple(content);
    }

    // Convert _t before wrapping to avoid scanning wrappers
    content = convert_t_cow(url, content);

    let qunit_wrapper = get_qunit_wrapper(url, &content);
    let (odoo_pre, odoo_suf) = get_odoo_wrapper(&module_path, &dependencies);

    let mut final_out =
        String::with_capacity(content.len() + odoo_pre.len() + odoo_suf.len() + 100);

    if let Some(legacy) = legacy_odoo_define {
        final_out.push_str(&legacy);
    }

    if let Some((pre, _)) = &qunit_wrapper {
        final_out.push_str(pre);
    }
    final_out.push_str(&odoo_pre);
    final_out.push_str(&content);
    final_out.push_str(&odoo_suf);
    if let Some((_, suf)) = &qunit_wrapper {
        final_out.push_str(suf);
    }

    final_out
}

fn get_odoo_wrapper(module_path: &str, dependencies: &[String]) -> (String, String) {
    let deps_str = dependencies
        .iter()
        .map(|d| format!("\"{}\"", d))
        .collect::<Vec<_>>()
        .join(", ");
    (
        format!(
            r#"odoo.define("{}", [{}], function (require) {{
'use strict';
let __exports = {{}};
"#,
            module_path, deps_str
        ),
        "\nreturn __exports;\n});\n".to_string(),
    )
}

fn get_qunit_wrapper(url: &str, content: &str) -> Option<(String, String)> {
    if url.contains("/tests/")
        && content.contains("QUnit.")
        && (content.contains("QUnit.test(")
            || content.contains("QUnit.debug(")
            || content.contains("QUnit.only("))
    {
        if let Some(caps) = URL_RE.captures(url) {
            let module = caps.name("module").unwrap().as_str();
            return Some((
                format!("QUnit.module(\"{}\", function() {{", module),
                "});".to_string(),
            ));
        }
    }
    None
}

fn convert_t_cow<'a>(url: &str, content: Cow<'a, str>) -> Cow<'a, str> {
    if url.ends_with(".test.js") {
        return content;
    }
    if !content.contains("@web/core/l10n/translation") {
        return content;
    }
    let module_name = if let Some(caps) = URL_RE.captures(url) {
        caps.name("module").unwrap().as_str().to_string()
    } else {
        return content;
    };

    let has_app_translate = T_FN_RE.is_match(&content);

    replace_cow(content, &GETTEXT_RE, |caps: &Captures| {
        let match_str = &caps[0];
        let renamed_import = if has_app_translate {
            match_str.replace("_t", "__not_defined__")
        } else {
            match_str.replace("_t", "appTranslateFn")
        };
        format!(
            "{}const _t = (str, ...args) => appTranslateFn(str, \"{}\", ...args);",
            renamed_import, module_name
        )
    })
}

fn url_to_module_path(url: &str) -> String {
    if let Some(start) = url.strip_prefix('/') {
        if let Some(static_pos) = start.find("/static/") {
            let module = &start[..static_pos];
            let after_static = &start[static_pos + 8..]; // skip "/static/"

            let (type_part, rest) = if let Some(idx) = after_static.find('/') {
                (&after_static[..idx], &after_static[idx..])
            } else {
                (after_static, "")
            };

            if type_part == "src" || type_part == "lib" || type_part == "tests" {
                let mut url_part = rest.to_string();
                if url_part.ends_with("/index.js") || url_part.ends_with("/index") {
                    if let Some(idx) = url_part.rfind('/') {
                        url_part.truncate(idx);
                    }
                }
                if url_part.ends_with(".js") || url_part.ends_with(".ts") {
                    url_part.truncate(url_part.len() - 3);
                }

                if type_part == "src" {
                    return format!("@{}{}", module, url_part);
                } else if type_part == "lib" {
                    return format!("@{}/../lib{}", module, url_part);
                } else {
                    return format!("@{}/../tests{}", module, url_part);
                }
            }
        }
    }
    url.to_string()
}

fn get_aliased_odoo_define_content(module_path: &str, info: Option<&ModuleInfo>) -> Option<String> {
    let info = info?;
    let alias = info.alias.as_deref()?;
    let default_val = info.default.as_deref();

    if !alias.is_empty() {
        if default_val.is_some() {
            Some(format!("\nodoo.define(`{}`, ['{}'], function (require) {{\n                        return require('{}');\n                        }});\n", alias, module_path, module_path))
        } else {
            Some(format!("\nodoo.define(`{}`, ['{}'], function (require) {{\n                        return require('{}')[Symbol.for(\"default\")];\n                        }});\n", alias, module_path, module_path))
        }
    } else {
        None
    }
}

fn convert_legacy_default_import<'a>(content: Cow<'a, str>) -> Cow<'a, str> {
    replace_cow(content, &IMPORT_LEGACY_DEFAULT_RE, |caps: &Captures| {
        format!(
            r"{}const {} = require({})",
            &caps["space"], &caps["identifier"], &caps["path"]
        )
    })
}

fn convert_basic_import<'a>(content: Cow<'a, str>) -> Cow<'a, str> {
    replace_cow(content, &IMPORT_BASIC_RE, |caps: &Captures| {
        let new_object = caps["object"].replace(" as ", ": ");
        format!(
            r"{}const {} = require({})",
            &caps["space"], new_object, &caps["path"]
        )
    })
}

fn convert_default_import<'a>(content: Cow<'a, str>) -> Cow<'a, str> {
    replace_cow(content, &IMPORT_DEFAULT, |caps: &Captures| {
        format!(
            r#"{}const {} = require({})[Symbol.for("default")]"#,
            &caps["space"], &caps["identifier"], &caps["path"]
        )
    })
}

fn convert_default_and_named_import<'a>(content: Cow<'a, str>) -> Cow<'a, str> {
    replace_cow(content, &IMPORT_DEFAULT_AND_NAMED_RE, |caps: &Captures| {
        let is_legacy = IS_PATH_LEGACY_RE.is_match(&caps["path"]);
        let new_object = caps["named_exports"].replace(" as ", ": ");
        if is_legacy {
            format!(
                r"{0}const {1} = require({2});{0}const {3} = {1}",
                &caps["space"], &caps["default_export"], &caps["path"], new_object
            )
        } else {
            let inner = &new_object[1..];
            format!(
                r#"{}const {{ [Symbol.for("default")]: {},{}" = require({})"#,
                &caps["space"], &caps["default_export"], inner, &caps["path"]
            )
        }
    })
}

fn convert_relative_require<'a>(
    url: &str,
    dependencies: &mut Vec<String>,
    content: Cow<'a, str>,
) -> Cow<'a, str> {
    let mut deps = HashSet::new();
    let new_content = replace_cow(content, &RELATIVE_REQUIRE_RE, |caps: &Captures| {
        let _quote = &caps["quote"];
        let path = &caps[3];
        let full_match = &caps[0];
        let prefix = &caps["prefix"];

        let module_path = if path.starts_with(".") && path.contains('/') {
            relative_path_to_module_path(url, path)
        } else {
            path.to_string()
        };

        deps.insert(module_path.clone());

        if path.starts_with(".") && path.contains('/') {
            format!("{}require(\"{}\")", prefix, module_path)
        } else {
            full_match.to_string()
        }
    });

    for d in deps {
        if !dependencies.contains(&d) {
            dependencies.push(d);
        }
    }
    new_content
}

fn convert_star_import<'a>(content: Cow<'a, str>) -> Cow<'a, str> {
    replace_cow(
        content,
        &IMPORT_STAR,
        r"${space}const $identifier = require($path)",
    )
}

fn convert_default_and_star_import<'a>(content: Cow<'a, str>) -> Cow<'a, str> {
    replace_cow(
        content,
        &IMPORT_DEFAULT_AND_STAR,
        r#"${space}const $named_exports_alias = require($path);
${space}const $default_export = $named_exports_alias[Symbol.for("default")]"#,
    )
}

fn convert_unnamed_relative_import<'a>(content: Cow<'a, str>) -> Cow<'a, str> {
    replace_cow(content, &IMPORT_UNNAMED_RELATIVE_RE, r"require($path)")
}

fn remove_index<'a>(content: Cow<'a, str>) -> Cow<'a, str> {
    replace_cow(content, &URL_INDEX_RE, |caps: &Captures| {
        let path = &caps["path"];
        if let Some(idx) = path.rfind("/index") {
            let new_path = format!("{}{}", &path[..idx], &path[0..1]); // quote
            format!("require({})", new_path)
        } else {
            caps[0].to_string()
        }
    })
}

fn relative_path_to_module_path(url: &str, path_rel: &str) -> String {
    let url_split: Vec<&str> = url.split('/').collect();
    let path_rel_split: Vec<&str> = path_rel.split('/').collect();
    let nb_back = path_rel_split.iter().filter(|&&v| v == "..").count() + 1;

    let mut result_parts = Vec::new();
    if url_split.len() >= nb_back {
        result_parts.extend_from_slice(&url_split[..url_split.len() - nb_back]);
    }
    for v in path_rel_split {
        if v != ".." && v != "." {
            result_parts.push(v);
        }
    }
    let result = result_parts.join("/");
    url_to_module_path(&result)
}

fn convert_from_export<'a>(content: Cow<'a, str>) -> Cow<'a, str> {
    replace_cow(content, &EXPORT_FROM_RE, |caps: &Captures| {
        let object_str = &caps["object"];
        let inner = &object_str[1..object_str.len() - 1];
        let parts: Vec<&str> = inner.split(',').collect();

        let object_clean = format!(
            "{{ {} }}",
            parts
                .iter()
                .map(|s| remove_as(s))
                .collect::<Vec<_>>()
                .join(",")
        );
        let object_process = format!(
            "{{ {} }}",
            parts
                .iter()
                .map(|s| convert_as(s))
                .collect::<Vec<_>>()
                .join(", ")
        );

        format!(
            r"{}{{const {} = require({});Object.assign(__exports, {})}}",
            &caps["space"], object_clean, &caps["path"], object_process
        )
    })
}

fn convert_star_from_export<'a>(content: Cow<'a, str>) -> Cow<'a, str> {
    replace_cow(
        content,
        &EXPORT_STAR_FROM_RE,
        r"${space}Object.assign(__exports, require($path))",
    )
}

fn convert_export_function<'a>(content: Cow<'a, str>) -> Cow<'a, str> {
    replace_cow(
        content,
        &EXPORT_FCT_RE,
        r"${space}__exports.$identifier = $identifier; $type $identifier",
    )
}

fn convert_export_class<'a>(content: Cow<'a, str>) -> Cow<'a, str> {
    replace_cow(
        content,
        &EXPORT_CLASS_RE,
        r"${space}const $identifier = __exports.$identifier = $type $identifier",
    )
}

fn convert_variable_export<'a>(content: Cow<'a, str>) -> Cow<'a, str> {
    replace_cow(
        content,
        &EXPORT_VAR_RE,
        r"${space}$type $identifier = __exports.$identifier",
    )
}

fn convert_object_export<'a>(content: Cow<'a, str>) -> Cow<'a, str> {
    replace_cow(content, &EXPORT_OBJECT_RE, |caps: &Captures| {
        let object_str = &caps["object"];
        let inner = &object_str[1..object_str.len() - 1];
        let parts: Vec<&str> = inner.split(',').collect();
        let object_process = format!(
            "{{ {} }}",
            parts
                .iter()
                .map(|s| convert_as(s))
                .collect::<Vec<_>>()
                .join(", ")
        );
        format!(
            "{}Object.assign(__exports, {})",
            &caps["space"], object_process
        )
    })
}

fn convert_export_fct_default<'a>(content: Cow<'a, str>) -> Cow<'a, str> {
    replace_cow(
        content,
        &EXPORT_FCT_DEFAULT_RE,
        r#"${space}__exports[Symbol.for("default")] = $identifier; $type $identifier"#,
    )
}

fn convert_export_class_default<'a>(content: Cow<'a, str>) -> Cow<'a, str> {
    replace_cow(
        content,
        &EXPORT_CLASS_DEFAULT_RE,
        r#"${space}const $identifier = __exports[Symbol.for("default")] = $type $identifier"#,
    )
}

fn convert_export_default_var<'a>(content: Cow<'a, str>) -> Cow<'a, str> {
    replace_cow(
        content,
        &EXPORT_DEFAULT_VAR_RE,
        r#"${space}$type $identifier = __exports[Symbol.for("default")]"#,
    )
}

fn convert_export_default_simple<'a>(content: Cow<'a, str>) -> Cow<'a, str> {
    replace_cow(
        content,
        &EXPORT_DEFAULT_RE,
        r#"${space}__exports[Symbol.for("default")] ="#,
    )
}

fn convert_as(val: &str) -> String {
    let parts: Vec<&str> = val.split(" as ").collect();
    if parts.len() >= 2 {
        format!("{}: {}", parts[1].trim(), parts[0].trim())
    } else {
        val.to_string()
    }
}

fn remove_as(val: &str) -> String {
    let parts: Vec<&str> = val.split(" as ").collect();
    if parts.len() >= 2 {
        parts[0].trim().to_string()
    } else {
        val.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_convert_basic_import() {
        let input = r#"import { something } from "./other";"#;
        let expected = r#"const { something } = require("./other");"#;
        let result = convert_basic_import(Cow::Borrowed(input));
        assert_eq!(result, expected);
    }

    #[test]
    fn test_transpile_import() {
        let url = "/my_addon/static/src/js/test.js";
        let input = r#"import { something } from "./other";
console.log("hello");"#;

        let (_, info) = analyze_module(url, input);
        let result = transpile_javascript(url, input, info.as_ref());

        assert!(result.contains(r#"const { something } = require("@my_addon/js/other");"#));
        assert!(result.contains(r#"odoo.define("@my_addon/js/test", ["@my_addon/js/other"]"#));
    }

    #[test]
    fn test_url_to_module_path_fallback() {
        assert_eq!(url_to_module_path("/web/static/src/start.js"), "@web/start");
        assert_eq!(
            url_to_module_path(
                "/website/static/src/client_actions/website_preview/new_content_systray_item.js"
            ),
            "@website/client_actions/website_preview/new_content_systray_item"
        );
    }

    #[test]
    fn test_start_js_transpilation() {
        let url = "/web/static/src/start.js";
        let input = r#"/** @odoo-module **/
import { start } from "./some_dependency";
export const myValue = 1;
"#;
        let (_, info) = analyze_module(url, input);
        let result = transpile_javascript(url, input, info.as_ref());

        assert!(result.contains(r#"odoo.define("@web/start","#));
    }

    #[test]
    fn test_webclient_js_transpilation() {
        let url = "/web/static/src/webclient/webclient.js";
        let input = r#"/** @odoo-module **/
import { something } from "./other";
export const webClient = {};
"#;
        let (_, info) = analyze_module(url, input);
        let result = transpile_javascript(url, input, info.as_ref());

        assert!(result.contains(r#"odoo.define("@web/webclient/webclient","#));
    }
}
