import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const svgNamespace = 'http://www.w3.org/2000/svg';
const csp = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ');

test('SVG content type is inline only for inert, local-reference SVG in Chromium under product CSP', async ({ page }) => {
  const moduleSource = await readFile(process.env.ATLAS_SVG_MODULE ?? new URL('../dist/svg.js', import.meta.url), 'utf8');
  const samples = [
    { name: 'plain SVG', source: `<svg xmlns="${svgNamespace}"><rect width="10" height="10"/></svg>`, expected: 'image/svg+xml' },
    { name: 'local fragment reference', source: `<svg xmlns="${svgNamespace}"><defs><linearGradient id="paint"/></defs><rect fill="url(#paint)"/></svg>`, expected: 'image/svg+xml' },
    { name: 'stylesheet import', source: `<svg xmlns="${svgNamespace}"><style>@import url(https://evil.invalid/x.css);</style></svg>`, expected: 'application/octet-stream' },
    { name: 'inline style URL', source: `<svg xmlns="${svgNamespace}"><rect style="fill:url(https://evil.invalid/p.svg#x)"/></svg>`, expected: 'application/octet-stream' },
    { name: 'escaped CSS URL', source: `<svg xmlns="${svgNamespace}"><rect fill="u\\72l(https://evil.invalid/p.svg#x)"/></svg>`, expected: 'application/octet-stream' },
    { name: 'comment-obfuscated CSS URL', source: `<svg xmlns="${svgNamespace}"><rect fill="u/**/rl/**/(https://evil.invalid/p.svg#x)"/></svg>`, expected: 'application/octet-stream' },
    { name: 'aliased XLink external reference', source: `<svg xmlns="${svgNamespace}" xmlns:q="http://www.w3.org/1999/xlink"><image q:href="https://evil.invalid/p.png"/></svg>`, expected: 'application/octet-stream' },
    { name: 'external namespace href', source: `<svg xmlns="${svgNamespace}" xmlns:q="https://evil.invalid/ns"><image q:href="https://evil.invalid/p.png"/></svg>`, expected: 'application/octet-stream' },
    { name: 'SMIL href mutation', source: `<svg xmlns="${svgNamespace}"><image id="i"/><set href="#i" attributeName="href" to="https://evil.invalid/p.png"/></svg>`, expected: 'application/octet-stream' },
    { name: 'script element', source: `<svg xmlns="${svgNamespace}"><script>alert(1)</script><rect/></svg>`, expected: 'application/octet-stream' },
    { name: 'event handler', source: `<svg xmlns="${svgNamespace}" onload="alert(1)"><rect/></svg>`, expected: 'application/octet-stream' },
    { name: 'external XML base', source: `<svg xmlns="${svgNamespace}" xml:base="https://evil.invalid/"><use href="#shape"/></svg>`, expected: 'application/octet-stream' },
    { name: 'XML stylesheet processing instruction', source: `<?xml-stylesheet href="https://evil.invalid/x.css"?><svg xmlns="${svgNamespace}"/>`, expected: 'application/octet-stream' },
    { name: 'malformed XML', source: `<svg xmlns="${svgNamespace}"><g></svg>`, expected: 'application/octet-stream' }
  ];

  const runnerSource = `import { svgContentType } from '/svg.js';
const sources = ${JSON.stringify(samples.map(({ source }) => source))};
const results = sources.map((source) => {
  const bytes = new TextEncoder().encode(source);
  const original = bytes.slice();
  const contentType = svgContentType(bytes);
  return {
    contentType,
    bytesPreserved: bytes.length === original.length && bytes.every((value, index) => value === original[index])
  };
});
document.querySelector('#results').textContent = JSON.stringify(results);`;

  await page.route('http://atlas-persistence.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/index.html') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        headers: { 'Content-Security-Policy': csp },
        body: '<!doctype html><meta charset="utf-8"><pre id="results"></pre><script type="module" src="/runner.js"></script>'
      });
    } else if (url.pathname === '/runner.js') {
      await route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: runnerSource });
    } else if (url.pathname === '/svg.js') {
      await route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: moduleSource });
    } else {
      await route.fulfill({ status: 404, body: '' });
    }
  });

  const response = await page.goto('http://atlas-persistence.test/index.html');
  expect(response?.headers()['content-security-policy']).toBe(csp);
  await expect(page.locator('#results')).not.toHaveText('');
  const results = JSON.parse(await page.locator('#results').textContent() ?? '[]') as Array<{
    contentType: string;
    bytesPreserved: boolean;
  }>;

  expect(results).toHaveLength(samples.length);
  for (const [index, sample] of samples.entries()) {
    expect(results[index], sample.name).toEqual({ contentType: sample.expected, bytesPreserved: true });
  }
});
