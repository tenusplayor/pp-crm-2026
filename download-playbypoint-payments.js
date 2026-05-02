#!/usr/bin/env node
/**
 * Downloads daily transaction exports from the PlayByPoint admin portal.
 *
 * Usage:
 *   node download-playbypoint-payments.js              # all facilities, headless
 *   node download-playbypoint-payments.js --headed     # visible browser (good for debugging)
 *   node download-playbypoint-payments.js --facility embarcadero --headed
 */

require('dotenv').config();
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());
const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');

const HEADED = process.argv.includes('--headed');
const FACILITY_ARG = (() => {
  const i = process.argv.indexOf('--facility');
  return i !== -1 ? process.argv[i + 1] : null;
})();

const EXPORTS_DIR = path.join(__dirname, 'exports');
const BASE_URL = 'https://app.playbypoint.com';

const FACILITIES = [
  { name: 'embarcadero', slug: 'parkpadel' },
  { name: 'south-sf',    slug: 'oyster'    },
];

function randomDelay(minMs, maxMs) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise(r => setTimeout(r, ms));
}

function toYYYYMMDD(date) {
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

function transactionsUrl(slug, dateStr) {
  return `${BASE_URL}/admin/facilities/${slug}/manage_bookings#/reports/transactions?dateFrom=${dateStr}&dateTo=${dateStr}&page=1`;
}

async function login(page, email, password) {
  console.log('Logging in...');
  await page.goto(`${BASE_URL}/users/sign_in`, { waitUntil: 'load' });
  await randomDelay(1000, 2000);
  const emailInput = page.locator('#user_email');
  await emailInput.waitFor({ state: 'visible', timeout: 15000 });
  await emailInput.fill(email);
  await randomDelay(400, 800);
  await page.locator('#user_password').fill(password);
  await randomDelay(600, 1200);
  await page.locator('input[type="submit"], button[type="submit"]').first().click();
  await page.waitForNavigation({ waitUntil: 'load', timeout: 15000 });
  console.log('Logged in. URL:', page.url());
}

async function downloadForFacility(page, facility, dateStr, email, password) {
  console.log(`\n── ${facility.name} ──`);

  const url = transactionsUrl(facility.slug, dateStr);
  console.log('Navigating to:', url);
  await page.goto(url, { waitUntil: 'load' });

  if (page.url().includes('/sign_in')) {
    console.log('Session expired — re-logging in...');
    await login(page, email, password);
    await page.goto(url, { waitUntil: 'load' });
  }

  console.log('Waiting for CSV export button...');
  const csvBtn = page.locator('a[data-tooltip="Export to CSV"]');
  try {
    await csvBtn.waitFor({ state: 'visible', timeout: 60000 });
  } catch {
    await page.screenshot({ path: path.join(EXPORTS_DIR, `debug_pbp_${facility.name}.png`) });
    console.log(`No CSV button found for ${facility.name} on ${dateStr} (screenshot saved). Skipping.`);
    return;
  }

  await randomDelay(800, 1500);

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    csvBtn.click(),
  ]);

  const filename = `pbp_transactions_${facility.name}_${dateStr}.csv`;
  const savePath = path.join(EXPORTS_DIR, filename);
  await download.saveAs(savePath);
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

  const year  = dateStr.slice(0, 4);
  const month = MONTH_NAMES[parseInt(dateStr.slice(5, 7), 10) - 1];
  const day   = dateStr.slice(8, 10);

  const yearFolderId  = await getOrCreateFolder(drive, year,  rootFolderId);
  const monthFolderId = await getOrCreateFolder(drive, month, yearFolderId);
  const dayFolderId   = await getOrCreateFolder(drive, day,   monthFolderId);

  const media = { mimeType: 'text/csv', body: fs.createReadStream(filePath) };

  const existing = await drive.files.list({
    q: `name='${filename}' and '${dayFolderId}' in parents and trashed=false`,
    fields: 'files(id)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  if (existing.data.files.length > 0) {
    await drive.files.update({ fileId: existing.data.files[0].id, media, supportsAllDrives: true });
    console.log(`Replaced in Google Drive: ${year}/${month}/${day}/${filename}`);
  } else {
    await drive.files.create({
      requestBody: { name: filename, parents: [dayFolderId] },
      media,
      fields: 'id',
      supportsAllDrives: true,
    });
    console.log(`Uploaded to Google Drive: ${year}/${month}/${day}/${filename}`);
  }
}

async function run() {
  const email    = process.env.PLAYBYPOINT_EMAIL;
  const password = process.env.PLAYBYPOINT_PASSWORD;

  if (!email || !password) {
    console.error('ERROR: Set PLAYBYPOINT_EMAIL and PLAYBYPOINT_PASSWORD in .env');
    process.exit(1);
  }

  if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR, { recursive: true });

  const facilitiesToRun = FACILITY_ARG
    ? FACILITIES.filter(f => f.name === FACILITY_ARG)
    : FACILITIES;

  if (facilitiesToRun.length === 0) {
    console.error(`Unknown facility: ${FACILITY_ARG}. Valid names: ${FACILITIES.map(f => f.name).join(', ')}`);
    process.exit(1);
  }

  const dateStr = toYYYYMMDD(yesterday());
  console.log(`Downloading PlayByPoint transactions for ${dateStr}`);

  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext({ acceptDownloads: true, locale: 'en-US' });
  const page    = await context.newPage();

  try {
    await login(page, email, password);

    for (const facility of facilitiesToRun) {
      await downloadForFacility(page, facility, dateStr, email, password);
      if (facilitiesToRun.indexOf(facility) < facilitiesToRun.length - 1) {
        const wait = Math.floor(Math.random() * 5000) + 8000;
        console.log(`Waiting ${(wait / 1000).toFixed(1)}s before next facility...`);
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
