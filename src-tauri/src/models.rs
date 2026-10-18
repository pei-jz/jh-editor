use serde::{Serialize, Deserialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub is_directory: bool,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchProgress {
    pub scanned: usize,
    pub found: usize,
    pub current_path: String,
    pub total: usize,
    pub search_id: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileContent {
    pub content: String,
    pub encoding: String,
    /// Some bytes did not decode in `encoding` and became U+FFFD. Saving the
    /// text back writes U+FFFD where those bytes were, so the editor asks
    /// before it does.
    #[serde(default)]
    pub lossy: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StructuredNode {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub key: String,
    pub value: String,
    pub children: Option<Vec<StructuredNode>>,
    pub lazy: Option<bool>,
}
