import { assert } from "@std/assert/assert";
// Type alias for the library type from ffi.ts
import type { PtyLib } from "./ffi.ts";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

// === Encoding Data FOR Rust ===

/**
 * Encodes a JavaScript string into a Uint8Array representing a
 * null-terminated C string (UTF-8 bytes + trailing '\0').
 * Use this for functions like `pty_write` that expect a CString.
 */
export function encodeCString(str: string): Uint8Array<ArrayBuffer> {
  const utf8Bytes = ENCODER.encode(str);
  const buffer = new Uint8Array(utf8Bytes.length + 1); // +1 for '\0'
  buffer.set(utf8Bytes, 0);
  // buffer[utf8Bytes.length] is already 0
  return buffer;
}

/**
 * Encodes arbitrary data (by JSON stringifying it) into a raw
 * UTF-8 byte buffer (Uint8Array). Does NOT add a null terminator.
 * Use this for functions expecting pointer + length (e.g., `pty_create`, `pty_resize`).
 */
export function encodePointerLenData<T>(data: T): Uint8Array<ArrayBuffer> {
  const jsonString = JSON.stringify(data);
  return ENCODER.encode(jsonString); // Just the UTF-8 bytes
}

// === Decoding Data FROM Rust ===

/**
 * Decodes a null-terminated C string (UTF-8) pointed to by `ptr`
 * into a JavaScript string.
 * Assumes `ptr` is valid and was allocated by Rust (e.g., error messages, read data).
 * IMPORTANT: The caller is responsible for freeing the `ptr` using `freeRustString` afterwards.
 */
export function decodeCString(
  ptr: NonNullable<Deno.PointerValue>,
): string {
  assert(ptr !== null, "decodeCString received a null pointer");
  return new Deno.UnsafePointerView(ptr).getCString();
}

/**
 * Decodes a raw byte buffer (pointed to by `ptr` with `len`) containing
 * UTF-8 encoded JSON data into a JavaScript object.
 * Assumes `ptr` and `len` are valid and came from Rust (e.g., `pty_get_size`).
 * IMPORTANT: The caller is responsible for freeing the data using `freeRustData` afterwards.
 */
export function decodePointerLenData<T>(
  ptr: NonNullable<Deno.PointerValue>,
  len: number,
): T {
  assert(ptr !== null, "decodePointerLenData received a null pointer");
  assert(len >= 0, "decodePointerLenData received negative length");
  if (len === 0) {
    // Handle empty JSON string case if necessary, or assume valid JSON if len > 0
    // Depending on Rust behavior, an empty buffer might mean "{}" or ""
    // Parsing "" will throw, parsing "{}" is valid. Adjust as needed.
    // For now, assume non-empty valid JSON if len > 0.
    if (ptr === null) return JSON.parse("{}"); // Or throw, or return default
    // If ptr is non-null but len is 0, what does it mean? Let's throw.
    throw new Error(
      "decodePointerLenData received non-null pointer but zero length",
    );
  }
  const view = new Deno.UnsafePointerView(ptr);
  const bytes = view.getArrayBuffer(len);
  const jsonString = DECODER.decode(bytes);
  return JSON.parse(jsonString);
}

// === Handling Pointers from Result Buffers ===

/**
 * Reads a pointer address (returned by Rust as e.g., usize)
 * from a result buffer (BigUint64Array of length 1) and
 * converts it into a Deno.PointerValue (or null if address is 0).
 */
export function readPointerFromResultBuffer(
  resultBuffer: BigUint64Array,
): Deno.PointerValue {
  assert(resultBuffer.length >= 1, "Result buffer must have length >= 1");
  return Deno.UnsafePointer.create(resultBuffer[0]);
}

/**
 * Reads an error message (as CString) from a result buffer after an FFI call failed.
 * Assumes the FFI function placed the CString pointer into the result buffer.
 * Automatically frees the Rust-allocated memory for the string.
 */
export function readErrorAndFree(
  lib: PtyLib,
  resultBuffer: BigUint64Array,
): string {
  const errorPtr = readPointerFromResultBuffer(resultBuffer);
  if (!errorPtr) {
    return "FFI call failed: Unknown error (null pointer returned)";
  }
  try {
    return decodeCString(errorPtr);
  } finally {
    // Ensure memory is freed even if decodeCString throws (though unlikely)
    freeRustString(lib, errorPtr);
  }
}

// === Memory Management ===

/**
 * Calls the Rust `free_string` function to deallocate memory
 * previously allocated by Rust for a CString.
 */
export function freeRustString(
  lib: PtyLib,
  ptr: Deno.PointerValue,
): void {
  if (ptr) { // Only call free if the pointer is not null
    lib.symbols.free_string(ptr);
  }
}

/**
 * Calls the Rust `free_data` function to deallocate memory
 * previously allocated by Rust for raw byte data (pointer + length).
 */
export function freeRustData(
  lib: PtyLib,
  ptr: Deno.PointerValue,
  len: number,
): void {
  if (ptr && len > 0) { // Only call free if pointer is not null and len > 0
    lib.symbols.free_data(ptr, BigInt(len));
  } else if (ptr && len === 0) {
    // Optional: Decide if Rust ever returns non-null ptr with len 0 that needs freeing.
    // If it does, call free_data(ptr, 0). If not, this check prevents unnecessary calls.
    // console.warn("freeRustData called with non-null pointer but zero length.");
  }
}
