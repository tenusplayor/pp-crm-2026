#!/usr/bin/env node
/**
 * Downloads daily payment exports from the Playtomic manager portal.
 *
 * Usage:
 *   node download-payments.js              # all three tenants, headless
 *   node download-payments.js --headed     # visible browser (good for debugging)
 *   node download-payments.js --tenant embarcadero --headed  # single tenant
 */

require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');

const HEADED = process.argv.includes('--headed');
const TENANT_ARG = (() => {
  const i = process.argv.indexOf('--tenant');
  return i !== -1 ? process.argv[i + 1] : null;
})();

const EXPORTS_DIR = path.join(__dirname, 'exports');
const BASE_URL = 'https://manager.playtomic.io';

const TENANTS = [
  { name: 'embarcadero',     id: 'cef5933f-cdb8-4b9d-90f7-05dc852ee182' },
  { name: 'west-sacramento', id: '0418a159-ebcb-4ba0-98aa-560a28a22ad5' },
  { name: 'south-sf',        id: '5594eeca-ad72-408b-bebc-094c6d245e27' },
];

function randomDelay(minMs, maxMs) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise(r => setTimeout(r, ms));
}

function toYYYYMMDD(date) {
  // Use local date (not UTC) to match the portal's timezone
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d;
}

function paymentsUrl(tenantId, dateStr) {
  const params = new URLSearchParams({
    tid: tenantId,
    start: dateStr,
    end: dateStr,
    datetype: 'payment',
  });
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

async function downloadForTenant(page, tenant, dateStr, email, password) {
  console.log(`\n── ${tenant.name} ──`);

  const url = paymentsUrl(tenant.id, dateStr);
  console.log('Navigating to:', url);
  await page.goto(url, { waitUntil: 'load' });

  // Re-login if the navigation redirected us to the login page
  if (page.url().includes('/login')) {
    console.log('Session expired — re-logging in...');
    await login(page, email, password);
    await page.goto(url, { waitUntil: 'load' });
  }

  // Step 1: Wait for the ⋮ button — this confirms the page is fully loaded
  console.log('Waiting for page to fully load...');
  const dotsBtn = page.locator('button[aria-label="More"]').last();
  try {
    await dotsBtn.waitFor({ state: 'visible', timeout: 60000 });
  } catch {
    await page.screenshot({ path: path.join(EXPORTS_DIR, `debug_${tenant.name}.png`) });
    console.log(`No data or export unavailable for ${tenant.name} on ${dateStr} (screenshot saved). Skipping.`);
    return;
  }
  await randomDelay(800, 1500);
  await dotsBtn.click();

  // Step 2: Wait for dropdown, then click "Export CSV"
  const exportCsvItem = page.locator('[role="menuitem"], li, button').filter({ hasText: /export csv/i }).first();
  await exportCsvItem.waitFor({ state: 'visible', timeout: 5000 });
  await randomDelay(500, 1000);
  await exportCsvItem.click();

  // Step 3: Accept the terms & conditions modal
  // Wait for a dialog/modal to appear, then click its primary action button
  console.log('Waiting for terms modal...');
  await randomDelay(1000, 2000);
  await page.screenshot({ path: path.join(EXPORTS_DIR, `debug_modal_${tenant.name}.png`) });

  // Click the "Accept and Export" button in the terms modal
  const acceptBtn = page.locator('button').filter({ hasText: /accept/i }).last();
  await acceptBtn.waitFor({ state: 'visible', timeout: 8000 });

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    acceptBtn.click(),
  ]);

  const filename = `payments_${tenant.name}_${dateStr}.csv`;
  const savePath = path.join(EXPORTS_DIR, filename);
  await download.saveAs(savePath);

  const lines = fs.readFileSync(savePath, 'utf8').split('\n');
  const headerIdx = lines.findIndex(l => l.startsWith('Corporate Name'));
  fs.writeFileSync(savePath, lines.slice(headerIdx).join('\n'));
  console.log(`Saved: ${savePath}`);

  await uploadToGoogleDrive(savePath, filename, dateStr);
}

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

async function getOrCreateFolder(drive, name, parentId) {
  const q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`;
  const res = await drive.files.list({ q, fields: 'files(id)', spaces: 'drive', supportsAllDrives: true, includeItemsFromAllDrives: true });
  if (res.data.files.length > 0) return res.data.files[0].id;
  const folder = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    fields: 'id',
    supportsAllDrives: true,
  });
  return folder.data.id;
}

async function uploadToGoogleDrive(filePath, filename, dateStr) {
  const rootFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!rootFolderId) {
    console.log('Google Drive upload skipped (GOOGLE_DRIVE_FOLDER_ID not set).');
    return;
  }

  const authOptions = { scopes: ['https://www.googleapis.com/auth/drive.file'] };
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    authOptions.credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  }
  const auth = new google.auth.GoogleAuth(authOptions);
  const drive = google.drive({ version: 'v3', auth });

  const year = dateStr.slice(0, 4);
  const month = MONTH_NAMES[parseInt(dateStr.slice(5, 7), 10) - 1];

  const yearFolderId = await getOrCreateFolder(drive, year, rootFolderId);
  const monthFolderId = await getOrCreateFolder(drive, month, yearFolderId);

  await drive.files.create({
    requestBody: { name: filename, parents: [monthFolderId] },
    media: { mimeType: 'text/csv', body: fs.createReadStream(filePath) },
    fields: 'id',
    supportsAllDrives: true,
  });
  console.log(`Uploaded to Google Drive: ${year}/${month}/${filename}`);
}

async function run() {
  const email = process.env.PLAYTOMIC_EMAIL;
  const password = process.env.PLAYTOMIC_PASSWORD;

  if (!email || !password) {
    console.error('ERROR: Set PLAYTOMIC_EMAIL and PLAYTOMIC_PASSWORD in .env');
    process.exit(1);
  }

  if (!fs.existsSync(EXPORTS_DIR)) {
    fs.mkdirSync(EXPORTS_DIR, { recursive: true });
  }

  const tenantsToRun = TENANT_ARG
    ? TENANTS.filter(t => t.name === TENANT_ARG)
    : TENANTS;

  if (tenantsToRun.length === 0) {
    console.error(`Unknown tenant: ${TENANT_ARG}. Valid names: ${TENANTS.map(t => t.name).join(', ')}`);
    process.exit(1);
  }

  const dateStr = toYYYYMMDD(yesterday());
  console.log(`Downloading payments for ${dateStr}`);

  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext({ acceptDownloads: true, locale: 'en-US' });
  const page = await context.newPage();

  try {
    await login(page, email, password);

    for (const tenant of tenantsToRun) {
      await downloadForTenant(page, tenant, dateStr, email, password);
      if (tenantsToRun.indexOf(tenant) < tenantsToRun.length - 1) {
        const wait = Math.floor(Math.random() * 5000) + 8000; // 8–13s between tenants
        console.log(`Waiting ${(wait/1000).toFixed(1)}s before next tenant...`);
        await new Promise(r => setTimeout(r, wait));
      }
    }

    console.log('\nAll done.');
  } catch (err) {
    console.error('\nERROR:', err.message);
    if (HEADED) {
      console.log('Leaving browser open for 30s to inspect...');
      await page.waitForTimeout(30000);
    }
    await browser.close();
    process.exit(1);
  }

  await browser.close();
}

run();
