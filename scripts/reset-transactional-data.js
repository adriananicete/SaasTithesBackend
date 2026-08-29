import mongoose from 'mongoose';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { Tithes } from '../src/models/TithesEntry.js';
import { RequestForm } from '../src/models/RequestForm.js';
import { Voucher } from '../src/models/Voucher.js';
import { Expense } from '../src/models/Expense.js';
import { Notification } from '../src/models/Notification.js';
import { AuditLog } from '../src/models/AuditLog.js';
import { Comment } from '../src/models/Comment.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONNECTION_STRING = process.env.RESET_CONNECTION_STRING;
if (!CONNECTION_STRING) {
  console.error('RESET_CONNECTION_STRING env var is required.');
  console.error('Pass it explicitly so the wrong DB is never targeted by accident.');
  process.exit(1);
}

const confirmed = process.argv.slice(2).includes('--confirm');

// Order: child refs first, then parents. Notifications/AuditLog/Comment point
// at the transactional docs; Expense links to Voucher; Voucher links to
// RequestForm. Only User + Category + PushSubscription survive a reset:
// PushSubscription links to User (kept) and represents a real per-device
// notification opt-in from actual staff, so it is preserved across resets so
// users don't have to re-enable web push after a data reset.
const COLLECTIONS = [
  { model: Notification,     name: 'Notification' },
  { model: AuditLog,         name: 'AuditLog' },
  { model: Comment,          name: 'Comment' },
  { model: Expense,          name: 'Expense' },
  { model: Voucher,          name: 'Voucher' },
  { model: RequestForm,      name: 'RequestForm' },
  { model: Tithes,           name: 'Tithes' },
];

function maskUri(uri) {
  return uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@');
}

async function printCounts(label) {
  console.log(`--- Counts ${label} ---`);
  for (const { model, name } of COLLECTIONS) {
    const count = await model.countDocuments();
    console.log(`  ${name.padEnd(14)} ${count}`);
  }
  console.log('');
}

async function backup() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(__dirname, 'backups', ts);
  await fs.mkdir(dir, { recursive: true });
  console.log(`--- Backing up to: ${dir} ---`);
  for (const { model, name } of COLLECTIONS) {
    const docs = await model.find({}).lean();
    await fs.writeFile(path.join(dir, `${name}.json`), JSON.stringify(docs, null, 2));
    console.log(`  ${name.padEnd(14)} ${docs.length} docs`);
  }
  console.log('');
  return dir;
}

async function main() {
  console.log(`Target: ${maskUri(CONNECTION_STRING)}`);
  console.log(`Mode:   ${confirmed ? 'DELETE (--confirm)' : 'dry run (counts only)'}\n`);

  await mongoose.connect(CONNECTION_STRING);

  await printCounts('BEFORE');

  if (!confirmed) {
    console.log('Dry run finished. Re-run with --confirm to back up and delete.');
    await mongoose.disconnect();
    return;
  }

  await backup();

  console.log('--- Deleting ---');
  for (const { model, name } of COLLECTIONS) {
    const r = await model.deleteMany({});
    console.log(`  ${name.padEnd(14)} ${r.deletedCount} deleted`);
  }
  console.log('');

  await printCounts('AFTER');
  await mongoose.disconnect();
  console.log('Done.');
}

main().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
