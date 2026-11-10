import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const credentials = JSON.parse(
  await readFile('../backend/.research-local/login.json', 'utf8'),
);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
let page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => {
  errors.push(e.message);
  console.log('PAGE ERROR', e.message);
});
try {
  await page.goto('http://127.0.0.1:5174/research.html');
  await page.getByLabel('Mật khẩu local').fill(credentials.password);
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await page
    .getByRole('button', { name: 'Preset Smoke', exact: true })
    .waitFor();
  await page.getByRole('button', { name: 'Preset Smoke', exact: true }).click();
  await page
    .getByLabel('Tên thí nghiệm', { exact: true })
    .fill('UI smoke · close tab');
  await page
    .getByRole('button', { name: 'Chạy thí nghiệm', exact: true })
    .click();
  await page.waitForURL(/run=/);
  const url = page.url();
  const id = new URL(url).searchParams.get('run');
  await page.close();
  page = await context.newPage();
  await page.goto(url);
  await page
    .getByRole('button', { name: 'Theo dõi lượt chạy', exact: true })
    .click();
  for (let attempt = 0; attempt < 120; attempt++) {
    const response = await context.request.get(
      'http://127.0.0.1:5174/api/research/runs/' + id,
    );
    const current = await response.json();
    if (current.run.state === 'COMPLETED') break;
    if (['FAILED', 'INTERRUPTED', 'CANCELLED'].includes(current.run.state))
      throw new Error(JSON.stringify(current.run));
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log('Observed completed run', id);
  await page
    .getByRole('button', { name: 'Báo cáo nghiên cứu', exact: true })
    .click();
  await page.getByText('Xuất dữ liệu bất biến').waitFor();
  await page.screenshot({
    path: process.env.TEMP + '/emukey-research-report.png',
    fullPage: true,
  });
  for (const format of ['json', 'samples.csv', 'pdf', 'png']) {
    const r = await context.request.get(
      `http://127.0.0.1:5174/api/research/runs/${id}/export?format=${format}`,
    );
    assert.equal(
      r.status(),
      200,
      format + ' ' + (r.status() !== 200 ? await r.text() : ''),
    );
    assert.ok((await r.body()).length > 100);
  }
  assert.deepEqual(errors, []);
  console.log(
    'Playwright PASS: login → start → close tab → resume → report/export. Run ' +
      id,
  );
} finally {
  await browser.close();
}
