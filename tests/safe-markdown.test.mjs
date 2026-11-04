import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSafeMarkdown, safeExternalUrl } from '../public/safe-markdown.js';

test('official source links preserve commit and line references with safe anchor attributes', () => {
  const url = 'https://github.com/example/project/blob/0123456789abcdef0123456789abcdef01234567/src/model.py#L42-L58';
  assert.equal(renderSafeMarkdown(`[官方实现](${url})`), `<a class="external-source-link" href="${url}" target="_blank" rel="noopener noreferrer">官方实现</a>`);
  assert.equal(safeExternalUrl('HTTP://EXAMPLE.ORG:80/supplement.pdf'), 'http://example.org/supplement.pdf');
});

test('nested URL parentheses and angle destinations remain usable', () => {
  assert.match(renderSafeMarkdown('[论文](https://example.org/article_(v2))'), /href="https:\/\/example\.org\/article_\(v2\)"/);
  assert.match(renderSafeMarkdown('[论文](<https://example.org/article_(v2)>)'), /href="https:\/\/example\.org\/article_\(v2\)"/);
  assert.match(renderSafeMarkdown(String.raw`[论文](https://example.org/article_\(v2\).pdf)`), /href="https:\/\/example\.org\/article_\(v2\)\.pdf"/);
});

test('link labels and optional titles are escaped without trusting HTML', () => {
  const output = renderSafeMarkdown(String.raw`[<img src=x onerror=alert(1)> & source](https://example.org "A \"quoted\" title & <note>")`);
  assert.ok(output.includes('&lt;img src=x onerror=alert(1)&gt; &amp; source'));
  assert.ok(output.includes('title="A &quot;quoted&quot; title &amp; &lt;note&gt;"'));
  assert.ok(!output.includes('<img'));
  assert.ok(renderSafeMarkdown('[来源](https://example.org (文档 (v2)))').includes('title="文档 (v2)"'));
});

test('raw model HTML is inert text, including HTML nested in bold', () => {
  const output = renderSafeMarkdown('</div><script>alert(1)</script> **<svg onload=alert(1)>**');
  assert.equal(output, '&lt;/div&gt;&lt;script&gt;alert(1)&lt;/script&gt; <strong>&lt;svg onload=alert(1)&gt;</strong>');
});

test('only absolute HTTP and HTTPS links are permitted', () => {
  for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>x</script>', 'file:///C:/secret.txt', 'ftp://example.org/a', 'mailto:x@example.org', '//example.org/a', '/api/status', 'https://user:password@example.org', 'https://@example.org', 'https://example.org\\@other.test/a']) {
    assert.equal(safeExternalUrl(url), null, url);
    assert.ok(!renderSafeMarkdown(`[来源](${url})`).includes('<a '), url);
  }
});

test('raw and percent-encoded controls, format controls, and backslashes are rejected', () => {
  for (const tail of ['\nother', '\tother', '\u0000', '\u007f', '\u202e', '\u200b', '%00', '%0a', '%0D', '%7f', '%5c', '%250a', '%25255c', '%E2%80%AE', '%C2%80']) {
    const url = `https://example.org/${tail}`;
    assert.equal(safeExternalUrl(url), null, JSON.stringify(tail));
    assert.ok(!renderSafeMarkdown(`[来源](${url})`).includes('<a '), JSON.stringify(tail));
  }
});

test('Unicode paths, encoded spaces, and literal percent signs remain valid', () => {
  assert.equal(safeExternalUrl('https://example.org/补充材料.pdf'), new URL('https://example.org/补充材料.pdf').href);
  assert.equal(safeExternalUrl('https://example.org/%E8%A1%A5%E5%85%85.pdf'), 'https://example.org/%E8%A1%A5%E5%85%85.pdf');
  assert.equal(safeExternalUrl('https://example.org/Supplementary%20Material.pdf'), 'https://example.org/Supplementary%20Material.pdf');
  assert.equal(safeExternalUrl('https://example.org/100%25.pdf'), 'https://example.org/100%25.pdf');
  assert.equal(safeExternalUrl('https://example.org/Supplementary Material.pdf'), null);
});

test('URL query entities and encoded punctuation cannot become new anchor attributes', () => {
  const output = renderSafeMarkdown('[代码](https://example.org/?a=1&b=%22onclick%3D%22bad&c=&quot;)');
  assert.ok(output.includes('&amp;b=%22onclick%3D%22bad&amp;c=&amp;quot;'));
  assert.equal((output.match(/<a /g) || []).length, 1);
  assert.ok(!output.includes(' onclick='));
  assert.ok(!renderSafeMarkdown('[x](https://example.org/" onclick="alert(1))').includes('<a '));
});

test('inline and fenced code do not activate links or raw HTML', () => {
  assert.equal(renderSafeMarkdown('`[source](https://example.org)`'), '<code>[source](https://example.org)</code>');
  const code = renderSafeMarkdown('```\n[source](https://example.org)\n<img src=x>\n```');
  assert.ok(!code.includes('<a '));
  assert.ok(code.includes('&lt;img src=x&gt;'));
  assert.ok(!renderSafeMarkdown('```\n[source](https://example.org)').includes('<a '));
});

test('math tokens, citation markers and ordinary source text retain their text', () => {
  assert.equal(renderSafeMarkdown('$x_i < y$ ⟦MATH_m001⟧ [第3页·p-abc]'), '$x_i &lt; y$ ⟦MATH_m001⟧ [第3页·p-abc]');
  assert.equal(renderSafeMarkdown('来源 citeturn0search1'), '来源 citeturn0search1');
  assert.equal(renderSafeMarkdown(String.raw`\(x_i < y\) 与 \[\alpha + [literal](https://example.org)\]`), String.raw`\(x_i &lt; y\) 与 \[\alpha + [literal](https://example.org)\]`);
});

test('safe label formatting is supported without allowing nested links', () => {
  assert.equal(renderSafeMarkdown('[**API** 与 `源码`](https://example.org)'), '<a class="external-source-link" href="https://example.org/" target="_blank" rel="noopener noreferrer"><strong>API</strong> 与 <code>源码</code></a>');
  assert.ok(!renderSafeMarkdown(String.raw`\[literal](https://example.org)`).includes('<a '));
});

test('Markdown images are not embedded or silently turned into media', () => {
  const output = renderSafeMarkdown('![diagram](https://example.org/figure.png)');
  assert.equal(output, '![diagram](https://example.org/figure.png)');
});

test('malformed or excessive destinations remain inert and do not throw', () => {
  for (const value of ['[x](https://example.org/%zz)', '[x](https://example.org/unclosed(foo)', '[x](https://example.org "unclosed)', '[x](https://example.org/' + 'a'.repeat(9000) + ')']) {
    assert.ok(!renderSafeMarkdown(value).includes('<a '));
  }
  assert.doesNotThrow(() => renderSafeMarkdown('['.repeat(20000)));
});
