// Deletes the SQLite database (and its WAL/SHM sidecar files) for a clean slate.
// Run with: npm run db:reset
const fs = require('fs');
const path = require('path');

const files = ['cybermitra.db', 'cybermitra.db-wal', 'cybermitra.db-shm'].map(f =>
  path.join(__dirname, '..', f)
);

let removed = 0;
for (const f of files) {
  if (fs.existsSync(f)) {
    fs.unlinkSync(f);
    removed++;
  }
}

console.log(removed > 0 ? `✅ Removed ${removed} database file(s).` : 'ℹ️  No database files found — already clean.');