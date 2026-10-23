// Worker-thread task: read every asset (its own connection, read-only) and build the search index
// parts, so the web process only receives finished arrays.
async function inWorker() {
  const db = require('../../core/db');
  const docs = require('./docs');
  const { buildParts } = require('./bm25');
  try {
    const { mark, docs: all } = await db.tx(async t => {
      await t.run('SET TRANSACTION READ ONLY');
      return docs.loadAll(t);
    });
    return { mark, parts: buildParts(all) };
  } finally {
    await db.pool.end().catch(() => {});
  }
}

module.exports = { inWorker };
