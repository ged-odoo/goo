use oxc_allocator::Allocator;
use oxc_codegen::{Codegen, CodegenOptions};
use oxc_minifier::{Minifier, MinifierOptions};
use oxc_parser::Parser;
use oxc_span::SourceType;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MinifyLevel {
    None,
    Whitespace,
    Full,
}

impl MinifyLevel {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "none" => Ok(Self::None),
            "whitespace" => Ok(Self::Whitespace),
            "full" => Ok(Self::Full),
            _ => Err(format!(
                "invalid minify_level {value:?}; expected 'none', 'whitespace', or 'full'"
            )),
        }
    }
}

pub fn minify(code: &str, level: MinifyLevel) -> String {
    if level == MinifyLevel::None {
        return code.to_string();
    }

    let allocator = Allocator::default();
    let source_type = SourceType::default();
    let ret = Parser::new(&allocator, code, source_type).parse();

    if !ret.errors.is_empty() {
        return code.to_string();
    }

    let mut program = ret.program;

    if level == MinifyLevel::Full {
        let options = MinifierOptions::default();
        Minifier::new(options).minify(&allocator, &mut program);
    }

    Codegen::new()
        .with_options(CodegenOptions {
            minify: true,
            ..Default::default()
        })
        .build(&program)
        .code
}
