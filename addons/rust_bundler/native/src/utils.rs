pub fn normalize_path(path: &str) -> String {
    for marker in ["/addons/", "/enterprise/"] {
        if let Some(index) = path.find(marker) {
            return format!("/{}", path[index + marker.len()..].trim_start_matches('/'));
        }
    }

    if let Some(index) = path.find("/static/") {
        if let Some(slash) = path[..index].rfind('/') {
            return format!("/{}", &path[slash + 1..]);
        }
    }
    path.to_string()
}
