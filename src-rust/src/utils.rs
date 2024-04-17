use crate::Result;
use serde::{de::DeserializeOwned, Serialize};
use std::os::raw::c_char;
use std::{ffi::CString, mem::ManuallyDrop};

/// # Safety
/// expects
/// - valid ptr to a T encoded as CString encoding a JSON value
/// returns a T
/// This function doens't consume the CString
pub unsafe fn cstr_to_type<T: DeserializeOwned>(cstr: *mut c_char) -> Result<T> {
    let cstr = ManuallyDrop::new(CString::from_raw(cstr));
    Ok(serde_json::from_str(cstr.to_str()?)?)
}

pub fn type_to_cstr<T: Serialize>(t: &T) -> Result<CString> {
    Ok(CString::new(serde_json::to_string(&t)?)?)
}

pub fn boxed_error_to_cstring(err: Box<dyn std::error::Error>) -> CString {
    CString::new(err.to_string()).expect("failed to create cstring")
}
