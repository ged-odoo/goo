pub mod bundler;
pub mod minifier;
mod transpiler;
mod ts_transpiler;
mod utils;
mod xml_bundle;

#[cfg(feature = "python")]
use pyo3::prelude::*;

#[cfg(feature = "python")]
#[pyfunction]
#[pyo3(signature = (name, files, minify_level = "whitespace"))]
fn bundle(name: &str, files: Vec<String>, minify_level: &str) -> PyResult<String> {
    let level = minifier::MinifyLevel::parse(minify_level)
        .map_err(pyo3::exceptions::PyValueError::new_err)?;
    bundler::bundle(name, &files, level).map_err(pyo3::exceptions::PyRuntimeError::new_err)
}

#[cfg(feature = "python")]
#[pymodule]
fn goo_odoo_bundler(module: &Bound<'_, PyModule>) -> PyResult<()> {
    module.add_function(wrap_pyfunction!(bundle, module)?)?;
    module.add("__version__", env!("CARGO_PKG_VERSION"))?;
    Ok(())
}
