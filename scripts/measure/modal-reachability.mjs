#!/usr/bin/env node
/**
 * Can the last button of a tall dialog actually be reached? — asked of a REAL
 * browser layout, because jsdom cannot answer it and pretending it could is
 * how this bug shipped twice (review items 23+40, 5 Sep 2026).
 *
 * ## What it checks
 *
 * Two representative dialogs, at 1280×500 — short enough that both MUST
 * scroll:
 *
 *   1. The client-intake invite flow to its Review step: the
 *      "Create client & email the sign-in link" button must be scrollable into
 *      view and hit-testable (`elementFromPoint` resolves to it).
 *   2. The publish flow with the server's review mounted: select Ready docs →
 *      Stage for review → Read review (the dialog now holds the server's whole
 *      rendered review, thousands of px) → the Approve button must be
 *      scrollable into view and hit-testable. The run then clicks CANCEL — a
 *      contracted withdrawal — so documents stay Ready and the check is
 *      repeatable. Nothing is ever approved or created by this script.
 *
 * Both go through `DynamicComponents/Modal`, whose scroll mechanism is exactly
 * what regressed: every class of the 2 Sep "bounded card + scroll box" fix was
 * present and asserted in jsdom, yet in a real browser the dialog card's
 * `overflow-hidden` (the rounded-corner idiom) zeroed its automatic flex
 * minimum size, so the scroll box SHRANK the card to fit instead of scrolling
 * it, and the card clipped its own tail: `scrollHeight === clientHeight`,
 * nothing to scroll, Approve unreachable — publishing impossible. The fix is
 * `[&>*]:shrink-0` on the frame's scroll box; this script is the guard that
 * actually computes layout, and it fails loudly if the mechanism (not just the
 * class list) breaks again.
 *
 * ## Running it
 *
 * Needs the local dev stack (docker compose up -d · pnpm db:migrate ·
 * pnpm db:seed · pnpm dev) and a Chromium-family binary:
 *
 *   CHROME_EXE="C:/path/to/chrome.exe" node scripts/measure/modal-reachability.mjs
 *
 * Optional: WEB_URL (default http://localhost:5173) and API_URL — which
 * defaults to WEB_URL because the dev server proxies `/v1` same-origin (see
 * vite.config.ts); only set API_URL when pointing at a stack with no proxy.
 * Credentials are the seeded demo login. Exit 0 = both dialogs pass; exit 1
 * with a per-step report otherwise.
 *
 * No dependencies on purpose: raw CDP over Node's built-in WebSocket (Node
 * 22+), spawning the browser itself with a throwaway profile. Playwright would
 * be nicer to read, but it is not a repo dependency and a smoke that needs an
 * install step is a smoke nobody runs.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const WEB = process.env.WEB_URL ?? 'http://localhost:5173';
const API = process.env.API_URL ?? WEB; // the dev server proxies /v1 same-origin
const CHROME = process.env.CHROME_EXE;
if (!CHROME) {
  console.error('Set CHROME_EXE to a Chromium-family binary.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── minimal CDP client ────────────────────────────────────────────────── */
let msgId = 0;
const pending = new Map();
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  });
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', (e) => reject(new Error('CDP connect failed: ' + e.message)));
  });
}
const send = (ws, method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

/** Evaluate an async function body in the page; throws on page exception. */
async function evaluate(ws, fnBody) {
  const res = await send(ws, 'Runtime.evaluate', {
    expression: `(async () => { ${fnBody} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    throw new Error('page threw: ' + (res.exceptionDetails.exception?.description ?? res.exceptionDetails.text));
  }
  return res.result.value;
}

/* ── the in-page toolkit, shared by both checks ───────────────────────── */
const HELPERS = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const byText = (sel, re) =>
    [...document.querySelectorAll(sel)].find((el) => re.test(el.textContent ?? '') && el.getBoundingClientRect().width > 0);
  const setValue = (input, value) => {
    // React controlled inputs need the native setter plus an input event.
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const dialogInputs = () =>
    [...document.querySelector('[role="dialog"]').querySelectorAll('input')].filter((i) => i.getBoundingClientRect().width > 0);
  /** The reachability assertion this whole script exists for. */
  const assertReachable = (btn, label) => {
    if (!btn) throw new Error(label + ': button not found');
    const box = document.querySelector('[role="dialog"]').lastElementChild;
    if (box.scrollHeight <= box.clientHeight) {
      throw new Error(label + ': dialog does not overflow at this viewport — the check proved nothing (scrollHeight ' + box.scrollHeight + ' <= clientHeight ' + box.clientHeight + ')');
    }
    btn.scrollIntoView({ block: 'end' });
    const r = btn.getBoundingClientRect();
    if (r.bottom > innerHeight + 1 || r.top < -1) {
      throw new Error(label + ': not in view after scroll (top ' + Math.round(r.top) + ', bottom ' + Math.round(r.bottom) + ', innerHeight ' + innerHeight + ')');
    }
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    if (hit !== btn && !btn.contains(hit) && !(hit && hit.contains(btn))) {
      throw new Error(label + ': occluded — elementFromPoint hit ' + (hit?.tagName ?? 'nothing'));
    }
    return { scrolled: true, bottom: Math.round(r.bottom) };
  };
`;

async function main() {
  const profile = mkdtempSync(path.join(tmpdir(), 'nt-modal-smoke-'));
  const browser = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--disable-extensions',
    'about:blank',
  ], { stdio: 'ignore' });

  let ws;
  const failures = [];
  try {
    // The browser writes its chosen port to DevToolsActivePort in the profile.
    let port = null;
    for (let i = 0; i < 50 && port === null; i++) {
      await sleep(200);
      try { port = readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { /* not yet */ }
    }
    if (port === null) throw new Error('browser never wrote DevToolsActivePort');
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const pageTarget = targets.find((t) => t.type === 'page');
    ws = await connect(pageTarget.webSocketDebuggerUrl);
    await send(ws, 'Page.enable');
    await send(ws, 'Runtime.enable');
    // 1280×500: short enough that both dialogs MUST scroll — a viewport where
    // they fit would pass without exercising the mechanism, and assertReachable
    // refuses that as a non-proof.
    await send(ws, 'Emulation.setDeviceMetricsOverride', { width: 1280, height: 500, deviceScaleFactor: 1, mobile: false });

    const goto = async (url) => {
      await send(ws, 'Page.navigate', { url });
      await sleep(2000);
    };

    /* sign in: the cookie is set by the API; the SPA then renders signed-in */
    await goto(WEB + '/login');
    await evaluate(ws, `
      const res = await fetch('${API}/v1/auth/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: 'shakib@neoting.test', password: 'demo-neoting-2026', totp: '000000' }),
      });
      if (!res.ok && res.status !== 204) throw new Error('login failed: ' + res.status);
    `);

    /* ── check 1: intake to the Review step ── */
    try {
      await goto(WEB + '/clients');
      const intake = await evaluate(ws, HELPERS + `
        byText('button', /add client/i).click();
        await sleep(700);
        byText('[role="dialog"] button', /Send the client a link/).click();
        await sleep(500);
        setValue(dialogInputs()[0], 'Overflow Smoke Ltd');
        await sleep(200);
        byText('[role="dialog"] button', /^Continue$/).click();
        await sleep(500);
        const inputs = dialogInputs();
        setValue(inputs[0], 'Ada'); setValue(inputs[1], 'Smoke'); setValue(inputs[2], 'ada.smoke@example.test');
        await sleep(200);
        byText('[role="dialog"] button', /^Continue$/).click();
        await sleep(600);
        // Assert reachable; do NOT click — clicking would create a business.
        return assertReachable(byText('[role="dialog"] button', /Create client/), 'intake Review');
      `);
      console.log('PASS  intake Review step — Create reachable', JSON.stringify(intake));
    } catch (e) {
      failures.push('intake: ' + e.message);
      console.error('FAIL  intake Review step —', e.message);
    }

    /* ── check 2: publish with the server review mounted ── */
    try {
      let staged = false;
      // Seed ids are stable; the first client that still has Ready docs wins.
      for (const biz of ['biz_burger', 'biz_cosmo', 'biz_dental']) {
        await goto(`${WEB}/clients/${biz}/costs/ready`);
        const rows = await evaluate(ws, `return document.querySelectorAll('tbody tr').length;`);
        if (rows === 0) continue;
        const publish = await evaluate(ws, HELPERS + `
          document.querySelector('th button[aria-pressed]').click();
          await sleep(400);
          const open = byText('button', /^Publish selected/);
          if (!open) throw new Error('no Publish selected action');
          open.click();
          await sleep(800);
          const stage = byText('[role="dialog"] button', /Stage for review/);
          if (!stage || stage.disabled) return { skipped: 'nothing stageable for this client' };
          stage.click();
          await sleep(2500);
          byText('[role="dialog"] button', /Read review/).click();
          await sleep(2500);
          const result = assertReachable(byText('[role="dialog"] button', /^\\s*Approve/), 'publish Approve');
          // Withdraw so the docs stay Ready and this smoke is repeatable.
          byText('[role="dialog"] button', /^\\s*Cancel/).click();
          await sleep(1500);
          return result;
        `);
        if (publish.skipped) continue;
        console.log(`PASS  publish review (client ${biz}) — Approve reachable`, JSON.stringify(publish));
        staged = true;
        break;
      }
      if (!staged) throw new Error('no seeded client had a stageable Ready batch — re-run pnpm db:seed');
    } catch (e) {
      failures.push('publish: ' + e.message);
      console.error('FAIL  publish review —', e.message);
    }
  } finally {
    try { ws?.close(); } catch { /* closing */ }
    browser.kill();
    await sleep(500);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* profile busy on Windows is fine */ }
  }

  if (failures.length) {
    console.error(`\n${failures.length} dialog(s) unreachable:\n - ` + failures.join('\n - '));
    process.exit(1);
  }
  console.log('\nAll dialog reachability checks passed.');
}

main().catch((e) => { console.error(e); process.exit(1); });
