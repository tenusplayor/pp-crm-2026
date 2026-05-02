#!/usr/bin/env node
/**
 * One-time backfill: downloads the past 90 days for all 3 tenants
 * and merges them into exports/backfill.csv
 *
 * Run: node backfill.js
 *      node backfill.js --headed   (visible browser)
 */

require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const HEADED = process.argv.includes('--headed');
const EXPORTS_DIR = path.join(__dirname, 'exports');
const BASE_URL = 'https://manager.playtomic.io';
const DAYS = 90;

const TENANTS = [
  { name: 'embarcadero',     id: 'cef5933f-cdb8-4b9d-90f7-05dc852ee182' },
  { name: 'west-sacramento', id: '0418a159-ebcb-4ba0-98aa-560a28a22ad5' },
  { name: 'south-sf',        id: '5594eeca-ad72-408b-bebc-094c6d245e27' },
];

function toYYYYMMDD(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function randomDelay(minMs, maxMs) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise(r => setTimeout(r, ms));
}

function paymentsUrl(tenantId, startStr, endStr) {
  const params = new URLSearchParams({ tid: tenantId, start: startStr, end: endStr, datetype: 'payment' });
  return `${BASE_URL}/dashboard/payments/processed?${params}`;
}

async function login(page, email, password) {
  console.log('Logging in...');
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'load' });
  await randomDelay(1000, 2000);
  await page.fill('input[type="email"], input[name="email"], input[placeholder*="mail" i]', email);
  await randomDelay(400, 800);
  await page.fill('input[type="password"], input[name="password"]', password);
  await randomDelay(600, 1200);
  await page.click('button[type="submit"]');
  await page.waitForNavigation({ waitUntil: 'load', timeout: 15000 });
  console.log('Logged in. URL:', page.url());
}

async function downloadTenant(page, tenant, startStr, endStr, email, password) {
  console.log(`\n── ${tenant.name} (${startStr} → ${endStr}) ──`);
  const url = paymentsUrl(tenant.id, startStr, endStr);
  console.log('Navigating to:', url);
  await page.goto(url, { waitUntil: 'load' });

  if (page.url().includes('/login')) {
    console.log('Session expired — re-logging in...');
    await login(page, email, password);
    await page.goto(url, { waitUntil: 'load' });
  }

  console.log('Waiting for page to fully load...');
  const dotsBtn = page.locator('button[aria-label="More"]').last();
  try {
    await dotsBtn.waitFor({ state: 'visible', timeout: 60000 });
  } catch {
    await page.screenshot({ path: path.join(EXPORTS_DIR, `debug_backfill_${tenant.name}.png`) });
    console.log(`No data found for ${tenant.name} — skipping (screenshot saved).`);
    return null;
  }

  await randomDelay(800, 1500);
  await dotsBtn.click();

  const exportCsvItem = page.locator('[role="menuitem"], li, button').filter({ hasText: /export csv/i }).first();
  await exportCsvItem.waitFor({ state: 'visible', timeout: 5000 });
  await randomDelay(500, 1000);
  await exportCsvItem.click();

  console.log('Waiting for terms modal...');
  await randomDelay(1000, 2000);
  const acceptBtn = page.locator('button').filter({ hasText: /accept/i }).last();
  await acceptBtn.waitFor({ state: 'visible', timeout: 8000 });

  console.log('Accepting & downloading...');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }), // larger file, more time
    acceptBtn.click(),
  ]);

  const tmpPath = path.join(EXPORTS_DIR, `backfill_${tenant.name}_tmp.csv`);
  await download.saveAs(tmpPath);

  // Strip the 3 summary rows at the top
  const lines = fs.readFileSync(tmpPath, 'utf8').split('\n');
  const cleaned = lines.slice(3).join('\n');
  fs.unlinkSync(tmpPath);
  console.log(`Downloaded ${tenant.name}: ${lines.length - 3} lines`);
  return cleaned;
}

async function run() {
  const email = process.env.PLAYTOMIC_EMAIL;
  const password = process.env.PLAYTOMIC_PASSWORD;

  if (!email || !password) {
    console.error('ERROR: Set PLAYTOMIC_EMAIL and PLAYTOMIC_PASSWORD in .env');
    process.exit(1);
  }

  if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR, { recursive: true });

  const endDate = new Date();
  endDate.setDate(endDate.getDate() - 1); // yesterday
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - (DAYS - 1)); // 90 days back
  const startStr = toYYYYMMDD(startDate);
  const endStr = toYYYYMMDD(endDate);
  console.log(`Backfilling ${startStr} → ${endStr}`);

  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext({ acceptDownloads: true, locale: 'en-US' });
  const page = await context.newPage();

  const csvChunks = [];

  try {
    await login(page, email, password);

    for (let i = 0; i < TENANTS.length; i++) {
      const tenant = TENANTS[i];
      const csv = await downloadTenant(page, tenant, startStr, endStr, email, password);
      if (csv) csvChunks.push({ tenant: tenant.name, csv });

      if (i < TENANTS.length - 1) {
        const wait = Math.floor(Math.random() * 5000) + 8000;
        console.log(`Waiting ${(wait/1000).toFixed(1)}s before next tenant...`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  } catch (err) {
    console.error('\nERROR:', err.message);
    if (HEADED) await page.waitForTimeout(30000);
    await browser.close();
    process.exit(1);
  }

  await browser.close();

  if (csvChunks.length === 0) {
    console.log('No data downloaded.');
    return;
  }

  // Merge: one header row, then all data rows from all tenants
  const headerLine = csvChunks[0].csv.split('\n').find(l => l.trim() && !l.startsWith('Total'));
  const allRows = [];

  for (const { tenant, csv } of csvChunks) {
    const lines = csv.split('\n');
    // Find where the actual header row is, then take everything after it
    const headerIdx = lines.findIndex(l => l.trim() && !l.startsWith('Total') && !l.startsWith(';'));
    const dataLines = lines.slice(headerIdx + 1).filter(l => l.trim());
    console.log(`${tenant}: ${dataLines.length} data rows`);
    allRows.push(...dataLines);
  }

  const backfillPath = path.join(EXPORTS_DIR, 'backfill.csv');
  fs.writeFileSync(backfillPath, [headerLine, ...allRows].join('\n') + '\n');
  console.log(`\nBackfill saved: ${backfillPath} (${allRows.length} total rows)`);
}

run();
