import { expect, test } from 'vitest';

import { renderEmailHtml } from './email-html.js';

const BODY = [
  'Hello Priya,',
  '',
  'Your sign-in code is 428913',
  '',
  '- Currys £1,299.00 on 9 Aug',
  '- Bidfood £402.10 on 12 Aug',
  '',
  'Upload securely here:',
  'https://neoacc.neovogent.com/p/tok123',
  '',
  'Neo Accounting',
].join('\n');

test('every content line of the text part survives into the HTML — the drift rule', () => {
  const html = renderEmailHtml({ subject: 'Test', body: BODY, highlight: '428913' });
  expect(html).toContain('Hello Priya,');
  expect(html).toContain('428913');
  expect(html).toContain('Currys £1,299.00 on 9 Aug');
  expect(html).toContain('https://neoacc.neovogent.com/p/tok123');
  expect(html).toContain('Neo Accounting');
});

test('nothing remote is ever fetched — no image, no style block, no import', () => {
  const html = renderEmailHtml({
    subject: 'Test',
    body: BODY,
    linkLabels: { 'https://neoacc.neovogent.com/p/tok123': 'Upload securely' },
  });
  expect(html).not.toMatch(/<img|<style|<link|@import|url\(/i);
  // The only URLs in the document are hrefs carrying links that ARE the body.
  const urls = html.match(/https?:\/\/[^"'<\s]+/g) ?? [];
  for (const url of urls) expect(url.startsWith('https://neoacc.neovogent.com/p/tok123')).toBe(true);
});

test('dynamic text is escaped — a supplier named <script> is words, not markup', () => {
  const html = renderEmailHtml({
    subject: 'Test <sub>',
    body: 'A supplier called <script>alert(1)</script> & "friends"\n',
  });
  expect(html).not.toContain('<script>');
  expect(html).toContain('&lt;script&gt;');
  expect(html).toContain('&amp; &quot;friends&quot;');
});

test('the highlight renders as the code box, label split from digits', () => {
  const html = renderEmailHtml({ subject: 'Code', body: 'Your sign-in code is 428913\n', highlight: '428913' });
  expect(html).toContain('letter-spacing:8px');
  expect(html).toContain('Your sign-in code is');
});

test('a labelled URL becomes a button AND keeps the bare link for copy-paste', () => {
  const url = 'https://neoacc.neovogent.com/signup/verify?token=abc';
  const html = renderEmailHtml({ subject: 'Verify', body: `Confirm here:\n${url}\n`, linkLabels: { [url]: 'Confirm email address' } });
  expect(html).toContain('Confirm email address');
  // Twice: once as the button href, once visible as text.
  expect(html.split('https://neoacc.neovogent.com/signup/verify?token=abc').length).toBeGreaterThan(2);
});

test('bullet lines render as list rows, not lost and not markup', () => {
  const html = renderEmailHtml({ subject: 'Missing', body: '- Currys £1,299.00 on 9 Aug\n- Costa £4.20 on 10 Aug\n' });
  expect(html).toContain('Currys £1,299.00 on 9 Aug');
  expect(html).toContain('Costa £4.20 on 10 Aug');
  expect(html).toContain('&bull;');
});
