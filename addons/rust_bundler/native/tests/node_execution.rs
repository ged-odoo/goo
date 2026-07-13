use goo_odoo_bundler::bundler::bundle;
use goo_odoo_bundler::minifier::MinifyLevel;
use std::fs;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn transpiled_bundle_executes_in_node() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("goo-node-{}-{unique}", std::process::id()));
    let source = root.join("addons/exec_test/static/src");
    fs::create_dir_all(&source).unwrap();

    let a = source.join("a.js");
    let b = source.join("b.js");
    fs::write(&a, "export const msg = 'Hello from A';").unwrap();
    fs::write(&b, "import { msg } from './a'; console.log(msg);").unwrap();

    // Registration order may differ from dependency order. Every explicit file is
    // registered before run_all starts resolving factories.
    let files = vec![
        b.to_string_lossy().into_owned(),
        a.to_string_lossy().into_owned(),
    ];
    let javascript = bundle("test", &files, MinifyLevel::None).unwrap();
    let shim = r#"
global.odoo = { define(name, deps, factory) { modules[name] = { factory, loaded: false }; } };
global.modules = {};
function load(name) {
    const module = modules[name];
    if (!module) throw new Error(`Module not found: ${name}`);
    if (!module.loaded) {
        module.value = module.factory(load);
        module.loaded = true;
    }
    return module.value;
}
"#;
    let script = root.join("bundle.js");
    fs::write(
        &script,
        format!("{shim}\n{javascript}\nload('@exec_test/b');"),
    )
    .unwrap();
    let output = Command::new("node").arg(&script).output().unwrap();
    let _ = fs::remove_dir_all(&root);

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("Hello from A"));
}
