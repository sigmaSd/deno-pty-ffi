const ENCODER = new TextEncoder();

export function encodeJsonCstring<T>(data: T): Uint8Array {
  return encodeCstring(JSON.stringify(data));
}

export function decodeJsonCstring<T>(
  ptr: NonNullable<Deno.PointerValue>,
): T {
  // ptr is a cstring
  const cstr = new Deno.UnsafePointerView(ptr).getCString();
  return JSON.parse(cstr);
}

export function encodeCstring(str: string): Uint8Array {
  const buf = new Uint8Array(str.length + 1);
  ENCODER.encodeInto(str, buf);
  return buf;
}

export function decodeCstring(
  ptr: NonNullable<Deno.PointerValue>,
): string {
  // ptr is a cstring
  return new Deno.UnsafePointerView(ptr).getCString();
}

export function createPtrFromBuffer(buffer: Uint8Array) {
  const ptr = Deno.UnsafePointer.create(
    //TODO
    new BigUint64Array(buffer.buffer)[0],
  );
  if (!ptr) throw new Error("create pointer failed");
  return ptr;
}
