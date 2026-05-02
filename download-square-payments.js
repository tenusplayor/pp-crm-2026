#!/usr/bin/env node
require('dotenv').config();
const { Client, Environment } = require('square');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const EXPORTS_DIR = path.join(__dirname, 'exports');

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

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

// Square API uses RFC3339. We want the full day in Pacific time.
function dayBoundsUtc(dateStr) {
  // Parse as Pacific time midnight → midnight
  const begin = new Date(`${dateStr}T00:00:00-07:00`).toISOString();
  const end   = new Date(`${dateStr}T23:59:59-07:00`).toISOString();
  return { begin, end };
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function listAllPayments(client, locationId, beginTime, endTime) {
  const payments = [];
  let cursor;
  do {
    const { result } = await client.paymentsApi.listPayments(
      beginTime, endTime,
      undefined, cursor,
      locationId,
      undefined, undefined, undefined,
      200
    );
    if (result.payments) payments.push(...result.payments);
    cursor = result.cursor;
  } while (cursor);
  return payments;
}

function paymentsToCSV(payments) {
  const headers = [
    'Payment ID', 'Created At', 'Status',
    'Amount', 'Currency', 'Fee', 'Net Amount',
    'Card Brand', 'Last 4', 'Entry Method',
    'Customer ID', 'Order ID', 'Note',
  ];

  const rows = payments.map(p => {
    const money = p.amountMoney || {};
    const fee   = p.processingFee?.[0]?.amountMoney || {};
    const netCents = (money.amount || 0) - (fee.amount || 0);
    const card  = p.cardDetails?.card || {};
    return [
      p.id,
      p.createdAt,
      p.status,
      ((money.amount || 0) / 100).toFixed(2),
      money.currency || '',
      ((fee.amount   || 0) / 100).toFixed(2),
      (netCents / 100).toFixed(2),
      card.cardBrand   || '',
      card.last4       || '',
      p.cardDetails?.entryMethod || '',
      p.customerId || '',
      p.orderId    || '',
      (p.note      || '').replace(/"/g, '""'),
    ];
  });

  const escape = v => (String(v).includes(',') || String(v).includes('"') || String(v).includes('\n'))
    ? `"${v}"`
    : v;

  return [headers, ...rows].map(r => r.map(escape).join(',')).join('\n');
}

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

  await drive.files.create({
    requestBody: { name: filename, parents: [dayFolderId] },
    media: { mimeType: 'text/csv', body: fs.createReadStream(filePath) },
    fields: 'id',
    supportsAllDrives: true,
  });
  console.log(`Uploaded to Google Drive: ${year}/${month}/${day}/${filename}`);
}

async function run() {
  const accessToken = process.env.SQUARE_ACCESS_TOKEN;
  if (!accessToken) {
    console.error('ERROR: Set SQUARE_ACCESS_TOKEN in .env');
    process.exit(1);
  }

  if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR, { recursive: true });

  const client = new Client({
    accessToken,
    environment: Environment.Production,
  });

  const dateStr = toYYYYMMDD(yesterday());
  console.log(`Downloading Square payments for ${dateStr}`);

  const { result: { locations } } = await client.locationsApi.listLocations();
  const activeLocations = locations.filter(l => l.status === 'ACTIVE');
  console.log(`Found ${activeLocations.length} active location(s): ${activeLocations.map(l => l.name).join(', ')}`);

  const { begin, end } = dayBoundsUtc(dateStr);

  for (const location of activeLocations) {
    console.log(`\n── ${location.name} ──`);
    const payments = await listAllPayments(client, location.id, begin, end);
    console.log(`  ${payments.length} payment(s)`);

    const slug     = slugify(location.name);
    const filename = `square_payments_${slug}_${dateStr}.csv`;
    const savePath = path.join(EXPORTS_DIR, filename);

    fs.writeFileSync(savePath, paymentsToCSV(payments));
    console.log(`  Saved: ${savePath}`);

    await uploadToGoogleDrive(savePath, filename, dateStr);
  }

  console.log('\nAll done.');
}

run().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
