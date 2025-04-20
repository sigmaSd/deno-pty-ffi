use std::ffi::CString;

pub fn boxed_error_to_cstring(err: Box<dyn std::error::Error>) -> CString {
    CString::new(err.to_string()).expect("failed to create cstring")
}
