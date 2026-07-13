use crate::utils;
use quick_xml::events::Event;
use quick_xml::reader::Reader;
use rayon::prelude::*;
use std::collections::BTreeSet;
use std::fs;

struct Block {
    is_extension: bool,
    name: Option<String>,
    inherit: Option<String>,
    xml: String,
    url: String,
}

pub fn generate_xml_bundle(xml_files: &[String]) -> Result<String, String> {
    // par_iter().collect::<Vec<_>>() retains the order of this indexed iterator.
    let parsed: Vec<Result<Vec<Block>, String>> = xml_files
        .par_iter()
        .map(|path| parse_file(path).map_err(|error| format!("file {path}: {error}")))
        .collect();
    let blocks = parsed
        .into_iter()
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();

    let mut names = BTreeSet::new();
    let mut primary_parents = BTreeSet::new();
    let mut extension_parents = BTreeSet::new();
    for block in &blocks {
        if block.is_extension {
            if let Some(inherit) = &block.inherit {
                extension_parents.insert(inherit.clone());
            }
        } else {
            if let Some(name) = &block.name {
                names.insert(name.clone());
            }
            if let Some(inherit) = &block.inherit {
                primary_parents.insert(inherit.clone());
            }
        }
    }

    let mut output = Vec::new();
    let missing_primary = primary_parents.difference(&names).collect::<Vec<_>>();
    if !missing_primary.is_empty() {
        let names = missing_primary
            .iter()
            .map(|name| format!("\"{name}\""))
            .collect::<Vec<_>>()
            .join(", ");
        output.push(format!("checkPrimaryTemplateParents([{names}]);"));
    }

    let missing_extensions = extension_parents.difference(&names).collect::<Vec<_>>();
    if !missing_extensions.is_empty() {
        let names = missing_extensions
            .iter()
            .map(|name| name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        output.push(format!(
            "console.error(\"Missing (extension) parent templates: {names}\");"
        ));
    }

    for block in blocks {
        let (function, key) = if block.is_extension {
            ("registerTemplateExtension", block.inherit.as_ref())
        } else {
            ("registerTemplate", block.name.as_ref())
        };
        if let Some(key) = key {
            let escaped = block
                .xml
                .replace('\\', "\\\\")
                .replace('`', "\\`")
                .replace("${", "\\${");
            output.push(format!(
                "{function}(\"{key}\", `{}`, `{escaped}`);",
                utils::normalize_path(&block.url)
            ));
        }
    }

    Ok(output.join("\n"))
}

fn parse_file(path: &str) -> Result<Vec<Block>, String> {
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let mut reader = Reader::from_str(&content);
    let mut buffer = Vec::new();
    let mut blocks = Vec::new();
    type StackEntry = (
        i32,
        String,
        usize,
        String,
        (Option<String>, Option<String>, bool),
    );
    let mut stack: Vec<StackEntry> = Vec::new();

    loop {
        let start_position = reader.buffer_position() as usize;
        let event = reader
            .read_event_into(&mut buffer)
            .map_err(|error| error.to_string())?;
        let end_position = reader.buffer_position() as usize;

        match &event {
            Event::Start(element) | Event::Empty(element) => {
                if !stack.is_empty() {
                    if matches!(event, Event::Start(_)) {
                        stack.last_mut().unwrap().0 += 1;
                    }
                    buffer.clear();
                    continue;
                }

                let mut template_name = None;
                let mut inherited_name = None;
                let mut extension_mode = false;
                let mut preserves_space = false;
                for attribute in element.attributes() {
                    let attribute = attribute.map_err(|error| error.to_string())?;
                    let key = attribute.key.as_ref();
                    let value = attribute
                        .unescape_value()
                        .map_err(|error| error.to_string())?;
                    match key {
                        b"t-name" => template_name = Some(value.to_string()),
                        b"t-inherit" => inherited_name = Some(value.to_string()),
                        b"t-inherit-mode" if value == "extension" => extension_mode = true,
                        b"xml:space" if value == "preserve" => preserves_space = true,
                        _ => {}
                    }
                }

                let is_extension = extension_mode && inherited_name.is_some();
                if !is_extension && template_name.is_none() {
                    buffer.clear();
                    continue;
                }

                let mut start_tag = content[start_position..end_position].to_string();
                if !preserves_space {
                    if start_tag.ends_with("/>") {
                        start_tag.truncate(start_tag.len() - 2);
                        start_tag.push_str(" xml:space=\"preserve\"/>");
                    } else if start_tag.ends_with('>') {
                        start_tag.truncate(start_tag.len() - 1);
                        start_tag.push_str(" xml:space=\"preserve\">");
                    }
                }

                if matches!(event, Event::Empty(_)) {
                    blocks.push(Block {
                        is_extension,
                        name: template_name,
                        inherit: inherited_name,
                        xml: start_tag,
                        url: path.to_string(),
                    });
                } else {
                    stack.push((
                        1,
                        String::from_utf8_lossy(element.name().as_ref()).to_string(),
                        end_position,
                        start_tag,
                        (template_name, inherited_name, is_extension),
                    ));
                }
            }
            Event::End(element) => {
                if let Some((mut depth, root_name, content_start, start_tag, metadata)) =
                    stack.pop()
                {
                    let name = String::from_utf8_lossy(element.name().as_ref()).to_string();
                    if depth == 1 && name == root_name {
                        let inner = &content[content_start..start_position];
                        blocks.push(Block {
                            is_extension: metadata.2,
                            name: metadata.0,
                            inherit: metadata.1,
                            xml: format!("{start_tag}{inner}</{name}>"),
                            url: path.to_string(),
                        });
                    } else {
                        depth -= 1;
                        stack.push((depth, root_name, content_start, start_tag, metadata));
                    }
                }
            }
            Event::Eof => {
                if stack.is_empty() {
                    break;
                }
                return Err("unexpected end of XML input".to_string());
            }
            _ => {}
        }
        buffer.clear();
    }

    Ok(blocks)
}
