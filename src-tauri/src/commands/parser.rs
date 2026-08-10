use quick_xml::events::Event;
use quick_xml::reader::Reader;
use tauri::command;
use std::sync::{Mutex, OnceLock};
use std::collections::HashMap;
use crate::models::StructuredNode;

fn get_cache() -> &'static Mutex<HashMap<String, StructuredNode>> {
    static CACHE: OnceLock<Mutex<HashMap<String, StructuredNode>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn truncate_tree(node: &StructuredNode, depth: usize) -> StructuredNode {
    let mut new_node = node.clone();
    if depth == 0 {
        if let Some(ref children) = node.children {
            let mut retained_children = Vec::new();
            let mut has_truncated = false;
            for child in children {
                if child.node_type == "property" || child.node_type == "directive" {
                    retained_children.push(child.clone());
                } else {
                    has_truncated = true;
                }
            }
            if has_truncated {
                new_node.children = Some(retained_children);
                new_node.lazy = Some(true);
            } else {
                new_node.children = Some(retained_children);
                new_node.lazy = Some(false);
            }
        }
    } else {
        if let Some(ref children) = node.children {
            let mut new_children = Vec::new();
            for child in children {
                new_children.push(truncate_tree(child, depth - 1));
            }
            new_node.children = Some(new_children);
            new_node.lazy = Some(false);
        }
    }
    new_node
}

fn find_node<'a>(root: &'a StructuredNode, id: &str) -> Option<&'a StructuredNode> {
    if root.id == id {
        return Some(root);
    }
    if let Some(ref children) = root.children {
        for child in children {
            if let Some(found) = find_node(child, id) {
                return Some(found);
            }
        }
    }
    None
}

#[command]
pub fn get_node_children(file_path: String, node_id: String) -> Result<Vec<StructuredNode>, String> {
    let cache = get_cache().lock().unwrap();
    if let Some(root) = cache.get(&file_path) {
        if let Some(node) = find_node(root, &node_id) {
            if let Some(ref children) = node.children {
                let mut trunc_children = Vec::new();
                for child in children {
                    trunc_children.push(truncate_tree(child, 0));
                }
                return Ok(trunc_children);
            }
        }
    }
    Ok(vec![])
}

#[command]
pub fn parse_structured_data(content: String, format: String, file_path: String) -> Result<StructuredNode, String> {
    let root = if format == "json" {
        let v: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
        convert_json_to_node(v, "root".to_string())
    } else {
        parse_xml_html(&content)?
    };

    // Store in cache
    get_cache().lock().unwrap().insert(file_path, root.clone());
    
    // Return full tree to prevent data loss on stringify
    Ok(root)
}

fn parse_xml_html(content: &str) -> Result<StructuredNode, String> {
    let mut reader = Reader::from_str(content);
    reader.trim_text(true);
    reader.check_end_names(false);
    let mut stack: Vec<StructuredNode> = Vec::new();
    
    stack.push(StructuredNode {
        id: "root".to_string(),
        node_type: "root".to_string(),
        key: "root".to_string(),
        value: String::new(),
        children: Some(Vec::new()),
        lazy: Some(false),
    });
    
    let mut id_counter = 0;
    let mut buf = Vec::new();
    
    let void_elements = vec![
        "area", "base", "br", "col", "embed", "hr", "img", "input", "link", 
        "meta", "param", "source", "track", "wbr"
    ];

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                let tag_name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                let is_void = void_elements.contains(&tag_name.to_lowercase().as_str());
                let is_raw_text = tag_name.eq_ignore_ascii_case("script") || tag_name.eq_ignore_ascii_case("style");
                
                id_counter += 1;
                let mut node = StructuredNode {
                    id: format!("n{}", id_counter),
                    node_type: "element".to_string(),
                    key: tag_name,
                    value: String::new(),
                    children: Some(Vec::new()),
                    lazy: Some(false),
                };
                for attr_res in e.attributes() {
                    if let Ok(attr) = attr_res {
                        id_counter += 1;
                        node.children.as_mut().unwrap().push(StructuredNode {
                            id: format!("n{}", id_counter),
                            node_type: "property".to_string(),
                            key: format!("@{}", String::from_utf8_lossy(attr.key.as_ref())),
                            value: attr.decode_and_unescape_value(&reader).unwrap_or_default().to_string(),
                            children: None,
                            lazy: Some(false),
                        });
                    }
                }
                
                if is_void {
                    if !stack.is_empty() {
                        stack.last_mut().unwrap().children.as_mut().unwrap().push(node);
                    }
                } else {
                    stack.push(node);
                    if is_raw_text {
                        if let Ok(text) = reader.read_text(e.name()) {
                            let text_str = text.to_string();
                            if !text_str.trim().is_empty() {
                                id_counter += 1;
                                stack.last_mut().unwrap().children.as_mut().unwrap().push(StructuredNode {
                                    id: format!("n{}", id_counter),
                                    node_type: "text".to_string(),
                                    key: "text".to_string(),
                                    value: text_str,
                                    children: None,
                                    lazy: Some(false),
                                });
                            }
                        }
                        if stack.len() > 1 {
                            let finished_node = stack.pop().unwrap();
                            stack.last_mut().unwrap().children.as_mut().unwrap().push(finished_node);
                        }
                    }
                }
            },
            Ok(Event::Empty(ref e)) => {
                id_counter += 1;
                let mut node = StructuredNode {
                    id: format!("n{}", id_counter),
                    node_type: "element".to_string(),
                    key: String::from_utf8_lossy(e.name().as_ref()).to_string(),
                    value: String::new(),
                    children: Some(Vec::new()),
                    lazy: Some(false),
                };
                for attr_res in e.attributes() {
                    if let Ok(attr) = attr_res {
                        id_counter += 1;
                        node.children.as_mut().unwrap().push(StructuredNode {
                            id: format!("n{}", id_counter),
                            node_type: "property".to_string(),
                            key: format!("@{}", String::from_utf8_lossy(attr.key.as_ref())),
                            value: attr.decode_and_unescape_value(&reader).unwrap_or_default().to_string(),
                            children: None,
                            lazy: Some(false),
                        });
                    }
                }
                if !stack.is_empty() {
                    stack.last_mut().unwrap().children.as_mut().unwrap().push(node);
                }
            },
            Ok(Event::End(_)) => {
                if stack.len() > 1 {
                    let node = stack.pop().unwrap();
                    stack.last_mut().unwrap().children.as_mut().unwrap().push(node);
                }
            },
            Ok(Event::Text(ref e)) => {
                let text = e.unescape().unwrap_or_default().to_string();
                if !text.trim().is_empty() && !stack.is_empty() {
                    id_counter += 1;
                    stack.last_mut().unwrap().children.as_mut().unwrap().push(StructuredNode {
                        id: format!("n{}", id_counter),
                        node_type: "text".to_string(),
                        key: "text".to_string(),
                        value: text,
                        children: None,
                        lazy: Some(false),
                    });
                }
            },
            Ok(Event::Eof) => break,
            Ok(Event::Decl(ref e)) => {
                let text = format!("<?{}?>", String::from_utf8_lossy(e.as_ref()));
                id_counter += 1;
                stack.last_mut().unwrap().children.as_mut().unwrap().push(StructuredNode {
                    id: format!("n{}", id_counter),
                    node_type: "directive".to_string(),
                    key: "?xml".to_string(),
                    value: text,
                    children: None,
                    lazy: Some(false),
                });
            },
            Ok(Event::DocType(ref e)) => {
                let text = format!("<!DOCTYPE {}>", String::from_utf8_lossy(e.as_ref()));
                id_counter += 1;
                stack.last_mut().unwrap().children.as_mut().unwrap().push(StructuredNode {
                    id: format!("n{}", id_counter),
                    node_type: "directive".to_string(),
                    key: "!DOCTYPE".to_string(),
                    value: text,
                    children: None,
                    lazy: Some(false),
                });
            },
            Ok(Event::PI(ref e)) => {
                let text = format!("<?{}?>", String::from_utf8_lossy(e.as_ref()));
                id_counter += 1;
                stack.last_mut().unwrap().children.as_mut().unwrap().push(StructuredNode {
                    id: format!("n{}", id_counter),
                    node_type: "directive".to_string(),
                    key: "?pi".to_string(),
                    value: text,
                    children: None,
                    lazy: Some(false),
                });
            },
            _ => (),
        }
        buf.clear();
    }

    let mut result = stack.pop().unwrap();
    if result.node_type == "root" {
        if let Some(ref mut children) = result.children {
            if children.len() == 1 {
                let mut first = children.remove(0);
                first.id = "root".to_string();
                return Ok(first);
            }
        }
    }
    
    Ok(result)
}

fn convert_json_to_node(v: serde_json::Value, key: String) -> StructuredNode {
    use serde_json::Value;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static ID_GEN: AtomicUsize = AtomicUsize::new(0);
    let id_val = ID_GEN.fetch_add(1, Ordering::Relaxed);
    let id = format!("j{}", id_val);

    match v {
        Value::Object(map) => {
            let mut children = Vec::new();
            for (k, val) in map {
                children.push(convert_json_to_node(val, k));
            }
            StructuredNode { id, node_type: "object".to_string(), key, value: String::new(), children: Some(children), lazy: Some(false) }
        },
        Value::Array(arr) => {
            let mut children = Vec::new();
            for (i, val) in arr.into_iter().enumerate() {
                children.push(convert_json_to_node(val, format!("[{}]", i)));
            }
            StructuredNode { id, node_type: "array".to_string(), key, value: String::new(), children: Some(children), lazy: Some(false) }
        },
        Value::String(s) => {
            StructuredNode { id, node_type: "property".to_string(), key, value: s, children: None, lazy: Some(false) }
        },
        _ => {
            StructuredNode { id, node_type: "property".to_string(), key, value: v.to_string(), children: None, lazy: Some(false) }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_html_parsing_debug() {
        let content = r#"<html><head></head><body></body></html>"#.to_string();
        let result = parse_structured_data(content, "html".to_string(), "test.html".to_string()).unwrap();
        println!("RESULT HTML: {:#?}", result);
    }

    #[test]
    fn test_xml_parsing_debug() {
        let content = r#"<?xml version="1.0"?><root><item/><item/></root>"#.to_string();
        let result = parse_structured_data(content, "xml".to_string(), "test.xml".to_string()).unwrap();
        println!("RESULT XML: {:#?}", result);
        panic!("FORCE FAIL"); // To see the stdout
    }
}
