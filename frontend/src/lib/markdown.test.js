import { describe, it, expect } from 'vitest';
import { markdownToHtml, escapeHtml } from './markdown';

function render(md) {
  const el = document.createElement('div');
  el.innerHTML = markdownToHtml(md);
  return el;
}

const payloads = [
  '<script>alert(1)</script>',
  '<img src=x onerror="alert(1)">',
  '<svg onload=alert(1)>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '"><img src=x onerror=alert(1)>',
  '<a href="javascript:alert(1)">x</a>',
  '**<img src=x onerror=alert(1)>**',
  '# <script>alert(1)</script>',
];

describe('markdownToHtml XSS guard', () => {
  it.each(payloads)('does not produce executable markup for %s', (payload) => {
    const el = render(payload);
    expect(el.querySelector('script,img,svg,iframe')).toBeNull();
    el.querySelectorAll('*').forEach((node) => {
      for (const attr of node.attributes) {
        expect(attr.name.startsWith('on')).toBe(false);
      }
    });
  });

  it('rejects non-http(s) link schemes', () => {
    for (const href of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
    ]) {
      expect(render(`[click](${href})`).querySelector('a')).toBeNull();
    }
  });

  it('cannot break out of the href attribute', () => {
    const a = render('[x](https://e.com/"onmouseover="alert(1))').querySelector('a');
    expect(a?.getAttribute('onmouseover')).toBeFalsy();
  });

  it('allows safe https links with safe rel/target', () => {
    const a = render('[site](https://example.com)').querySelector('a');
    expect(a.getAttribute('href')).toBe('https://example.com');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('pins escape-before-transform ordering', () => {
    expect(markdownToHtml('**<b>x</b>**')).toBe('<strong>&lt;b&gt;x&lt;/b&gt;</strong>');
    expect(markdownToHtml('<h1>x</h1>')).toBe(escapeHtml('<h1>x</h1>'));
  });

  it('handles empty input', () => {
    expect(markdownToHtml(undefined)).toBe('');
  });
});
