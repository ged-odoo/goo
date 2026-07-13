use crate::minifier::{self, MinifyLevel};
use crate::{transpiler, ts_transpiler, utils, xml_bundle};
use rayon::prelude::*;
use std::path::Path;

#[derive(Clone)]
struct ProcessedAsset {
    header: String,
    content: String,
}

pub fn bundle(name: &str, files: &[String], minify_level: MinifyLevel) -> Result<String, String> {
    let mut javascript_files = Vec::new();
    let mut xml_files = Vec::new();

    for file in files {
        match Path::new(file)
            .extension()
            .and_then(|extension| extension.to_str())
        {
            Some("js" | "ts") => javascript_files.push(file.clone()),
            Some("xml") => xml_files.push(file.clone()),
            _ => return Err(format!("unsupported asset file: {file}")),
        }
    }

    // Indexed Rayon iterators preserve the input order when collected into a Vec.
    // Imports are deliberately not resolved here: Odoo's asset list is authoritative.
    let processed: Result<Vec<_>, String> = javascript_files
        .par_iter()
        .map(|path| process_javascript(path, minify_level))
        .collect();
    let processed = processed?;

    let mut output = String::new();
    for (index, asset) in processed.iter().enumerate() {
        if index > 0 {
            output.push_str(";\n");
        }
        output.push_str(&asset.header);
        output.push_str(&asset.content);
    }

    if !xml_files.is_empty() {
        let templates = xml_bundle::generate_xml_bundle(&xml_files)?;
        if !output.is_empty() && !output.ends_with('\n') {
            output.push('\n');
        }
        output.push_str(&format!(
            r#"
/*******************************************
*  Templates                               *
*******************************************/
odoo.define("{name}.bundle.xml", ["@web/core/templates"], function(require) {{
    "use strict";
    const {{ checkPrimaryTemplateParents, registerTemplate, registerTemplateExtension }} = require("@web/core/templates");
    /* {name} */
    {templates}
}});
"#
        ));
    }

    Ok(output)
}

fn process_javascript(path: &str, minify_level: MinifyLevel) -> Result<ProcessedAsset, String> {
    let original =
        std::fs::read_to_string(path).map_err(|error| format!("could not read {path}: {error}"))?;
    let normalized_url = utils::normalize_path(path);
    let mut content = if Path::new(path)
        .extension()
        .is_some_and(|extension| extension == "ts")
    {
        ts_transpiler::transpile_typescript(&original, path)
    } else {
        original
    };

    let (is_transpiled, info) = transpiler::analyze_module(&normalized_url, &content);
    if is_transpiled {
        content = transpiler::transpile_javascript(&normalized_url, &content, info.as_ref());
    }
    content = minifier::minify(&content, minify_level);

    let header = if minify_level == MinifyLevel::None {
        let filepath = format!("Filepath: {normalized_url}");
        let lines = format!("Lines: {}", content.lines().count());
        let width = filepath.len().max(lines.len());
        let stars = "*".repeat(width + 5);
        format!("\n/{stars}\n*  {filepath:<width$}  *\n*  {lines:<width$}  *\n{stars}/\n")
    } else {
        format!("\n/* {normalized_url} */\n")
    };

    Ok(ProcessedAsset { header, content })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture {
        root: PathBuf,
        source: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root =
                std::env::temp_dir().join(format!("goo-bundler-{}-{unique}", std::process::id()));
            let source = root.join("addons/test_module/static/src");
            fs::create_dir_all(&source).unwrap();
            Self { root, source }
        }

        fn write(&self, name: &str, content: &str) -> String {
            let path = self.source.join(name);
            fs::write(&path, content).unwrap();
            path.to_string_lossy().into_owned()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn import_does_not_add_an_unlisted_existing_file() {
        let fixture = Fixture::new();
        let entry = fixture.write(
            "entry.js",
            "import { value } from './dependency';\nconsole.log(value);",
        );
        fixture.write("dependency.js", "export const value = 'UNLISTED-CONTENT';");

        let output = bundle("test", &[entry], MinifyLevel::Whitespace).unwrap();

        assert!(output.contains("@test_module/dependency"));
        assert!(!output.contains("UNLISTED-CONTENT"));
        assert!(!output.contains("dependency.js */"));
    }

    #[test]
    fn missing_import_is_a_runtime_dependency_not_a_build_error() {
        let fixture = Fixture::new();
        let entry = fixture.write(
            "entry.js",
            "import { value } from './missing';\nconsole.log(value);",
        );
        let output = bundle("test", &[entry], MinifyLevel::Whitespace).unwrap();
        assert!(output.contains("@test_module/missing"));
    }

    #[test]
    fn explicit_files_and_duplicates_keep_the_supplied_order() {
        let fixture = Fixture::new();
        let first = fixture.write("first.js", "console.log('FIRST-CONTENT');");
        let second = fixture.write("second.js", "console.log('SECOND-CONTENT');");
        let output = bundle(
            "test",
            &[second.clone(), first.clone(), second],
            MinifyLevel::Whitespace,
        )
        .unwrap();

        let first_second = output.find("/test_module/static/src/second.js").unwrap();
        let first = output.find("/test_module/static/src/first.js").unwrap();
        let last_second = output.rfind("/test_module/static/src/second.js").unwrap();
        assert!(first_second < first && first < last_second);
        assert_eq!(
            output.matches("/test_module/static/src/second.js").count(),
            2
        );
    }

    #[test]
    fn typescript_is_processed_without_crawling_imports() {
        let fixture = Fixture::new();
        let typed = fixture.write("typed.ts", "export const answer: number = 42;");
        let output = bundle("test", &[typed], MinifyLevel::None).unwrap();
        assert!(output.contains("answer = 42"));
        assert!(!output.contains(": number"));
    }

    #[test]
    fn xml_files_keep_the_supplied_order() {
        let fixture = Fixture::new();
        let first = fixture.write(
            "first.xml",
            "<templates><t t-name=\"test.First\"><div/></t></templates>",
        );
        let second = fixture.write(
            "second.xml",
            "<templates><t t-name=\"test.Second\"><span/></t></templates>",
        );
        let output = bundle("test", &[second, first], MinifyLevel::None).unwrap();
        assert!(output.find("test.Second").unwrap() < output.find("test.First").unwrap());
    }

    #[test]
    fn unsupported_missing_and_malformed_inputs_fail() {
        let fixture = Fixture::new();
        let unsupported = fixture.write("style.css", "body {}");
        assert!(bundle("test", &[unsupported], MinifyLevel::None)
            .unwrap_err()
            .contains("unsupported asset"));

        let missing = fixture
            .source
            .join("missing.js")
            .to_string_lossy()
            .into_owned();
        assert!(bundle("test", &[missing], MinifyLevel::None)
            .unwrap_err()
            .contains("could not read"));

        let malformed = fixture.write("bad.xml", "<templates><t t-name=\"bad\"><div></templates>");
        assert!(bundle("test", &[malformed], MinifyLevel::None).is_err());
    }
}
