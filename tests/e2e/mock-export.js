// Storage export for the accounting e2e tests. With SCM_STORAGE_EXPORT=<path> it reads a real "Full Stored Data"
// download (Diagnostic tab). Without it, it builds a mock export from the user's real R2 game responses already in
// tests/fixtures (statements for the day ending 10/25 01:21 UTC, past finances, balance sheet, cash flow), so the
// tests run anywhere. days:false leaves out the /day/<n>/ statements (the state before an Accounting walk).
const fs = require('fs'), path = require('path');
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'r2-accounting-day-walk-2026-10-25.json');
function loadExport({ days = false } = {}) {
  if (process.env.SCM_STORAGE_EXPORT) return { storage: JSON.parse(fs.readFileSync(process.env.SCM_STORAGE_EXPORT, 'utf8')).storage, mock: false };
  const fx = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const at = '2026-10-25T01:30:00.000Z', endpointData = {};
  for (const [k, data] of Object.entries(fx)) {
    if (!days && /\/day\/\d+\/$/.test(k)) continue;
    endpointData[k] = { status: 200, data, receivedAt: at, captureRealm: 1 };
  }
  const authData = { authCompany: { realmId: 1, companyId: 5294950, company: 'Hewitt Corporation' } };
  return { mock: true, storage: {
    activeRealmKey: 'realm:1', selectedRealm: '1', viewRealm: 1, realmIsolationSchemaVersion: 13, scmRealmStoreSchema: 1,
    'scmRealmStore:1': { endpointData, authData, captureRealm: 1, lastSync: at } } };
}
// Seed after the service worker's startup settles: storage set during startup can lose activeRealmKey (harness
// timing, see accounting-card-charts). Re-seeds once if the realm key did not stick.
async function seedExport(sw, storage) {
  await new Promise(r => setTimeout(r, 2000));
  const put = () => sw.evaluate(async s => { await chrome.storage.local.clear(); await chrome.storage.local.set(s); }, storage);
  await put(); await new Promise(r => setTimeout(r, 500));
  if (!(await sw.evaluate(async () => (await chrome.storage.local.get('activeRealmKey')).activeRealmKey))) await put();
}
module.exports = { loadExport, seedExport };
