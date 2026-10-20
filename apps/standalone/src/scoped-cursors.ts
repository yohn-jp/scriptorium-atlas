/** Frame-local tokens keep Host inventory paths out of ungranted responses. */
export class ScopedCursors {
  private readonly entries = new Map<string, { scope: string; cursor: string }>();
  constructor(private readonly capacity = 4096) {}

  decode(token: string | undefined, scope: string): string | undefined {
    if (token === undefined) return undefined;
    const entry = this.entries.get(token);
    if (!entry || entry.scope !== scope) throw new Error('INVALID_INPUT: Cursor expired or belongs to another query/session');
    return entry.cursor;
  }

  encode(cursor: string | null, scope: string): string | null {
    if (cursor === null) return null;
    const token = crypto.randomUUID();
    this.entries.set(token, { scope, cursor });
    if (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
    return token;
  }
}
