use oxc_allocator::Allocator;
use oxc_codegen::{Codegen, CodegenOptions};
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;
use oxc_transformer::{TransformOptions, Transformer};
use std::path::Path;

pub fn transpile_typescript(source_text: &str, path: &str) -> String {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(Path::new(path))
        .unwrap_or_default()
        .with_typescript(true);

    let ret = Parser::new(&allocator, source_text, source_type).parse();

    if !ret.errors.is_empty() {
        eprintln!("Parse error in {}:", path);
        for error in ret.errors {
            eprintln!("{:?}", error);
        }
    }

    let mut program = ret.program;

    let semantic_ret = SemanticBuilder::new().build(&program);

    let scoping = semantic_ret.semantic.into_scoping();

    let transform_options = TransformOptions::default();

    let _ = Transformer::new(&allocator, Path::new(path), &transform_options)
        .build_with_scoping(scoping, &mut program);

    let codegen_options = CodegenOptions::default();
    let printed = Codegen::new().with_options(codegen_options).build(&program);

    printed.code
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_transpile_typescript() {
        let input = "const x: number = 1;";
        let output = transpile_typescript(input, "test.ts");
        println!("Output: '{}'", output);
        assert!(output.contains("const x = 1"), "Output was: {}", output);
    }
}
