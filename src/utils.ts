export function encode_json_cstring<T>(data: T): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(data) + "\0");
}

export function decode_json_cstring<T>(
  ptr: NonNullable<Deno.PointerValue>,
): T {
  // ptr is a cstring
  const cstr = new Deno.UnsafePointerView(ptr).getCString();
  return JSON.parse(cstr);
}

export function encode_cstring(data: string): Uint8Array {
  return new TextEncoder().encode(data + "\0");
}

export function decode_cstring(
  ptr: NonNullable<Deno.PointerValue>,
): string {
  // ptr is a cstring
  return new Deno.UnsafePointerView(ptr).getCString();
}
