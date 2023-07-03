use crate::Result;
use serde::de::DeserializeOwned;
use std::{ffi::CString, mem::ManuallyDrop};

/// # Safety
/// expects
/// - valid ptr to a T encoded as CString encoding a JSON value
/// returns a T
pub unsafe fn cstr_to_type<T: DeserializeOwned>(cstr: *mut i8) -> Result<T> {
    let cstr = ManuallyDrop::new(CString::from_raw(cstr));
    Ok(serde_json::from_str(cstr.to_str()?)?)
}
