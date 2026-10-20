import { describe, expect, it } from 'vitest';
import { createScriptoriumAdapter } from '../src/index.js';

describe('Scriptorium adapter boundary', () => {
  it('fails closed while the public SDK is unavailable', async () => {
    const adapter = createScriptoriumAdapter();
    expect(adapter.status).toBe('unavailable');
    await expect(adapter.connect()).rejects.toMatchObject({ code: 'SCRIPTORIUM_HOST_UNAVAILABLE' });
  });
});
