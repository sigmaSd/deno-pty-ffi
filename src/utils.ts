const ENCODER = new TextEncoder();

export function encode_json_cstring<T>(data: T): Uint8Array {
  return encode_cstring(JSON.stringify(data));
}

export function decode_json_cstring<T>(
  ptr: NonNullable<Deno.PointerValue>,
): T {
  // ptr is a cstring
  const cstr = new Deno.UnsafePointerView(ptr).getCString();
  return JSON.parse(cstr);
}

export function encode_cstring(str: string): Uint8Array {
  const buf = new Uint8Array(str.length + 1);
  ENCODER.encodeInto(str, buf);
  return buf;
}

export function decode_cstring(
  ptr: NonNullable<Deno.PointerValue>,
): string {
  // ptr is a cstring
  return new Deno.UnsafePointerView(ptr).getCString();
}

export function createPtrFromBuf(buffer: Uint8Array) {
  const ptr = Deno.UnsafePointer.create(
    //TODO
    new BigUint64Array(buffer.buffer)[0],
  );
  if (!ptr) throw new Error("create pointer failed");
  return ptr;
}
