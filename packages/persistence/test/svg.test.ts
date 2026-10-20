import { describe, expect, it } from 'vitest';
import { inferContentType } from '../src/bundle.js';

describe('SVG classification without a browser parser', () => {
  it('fails closed while preserving input bytes', () => {
    const original = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
    const before = original.slice();
    expect(inferContentType('image.svg', original)).toBe('application/octet-stream');
    expect(original).toEqual(before);
  });
});
