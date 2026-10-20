/** Non-JSON structured clones fail closed before schema validation or dispatch. */
export function serializedMessageBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? Infinity : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return Infinity;
  }
}
