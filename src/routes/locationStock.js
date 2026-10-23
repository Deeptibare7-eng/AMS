// Location Stock (Asset Management): in-stock laptops per current location with quality
// grades, model-wise counts, unit list and the in-app stock assistant. Read-only.
const express = require('express');
const { authRequired, currentUser } = require('../middleware/auth');
const { csrfProtect } = require('../middleware/csrf');
const { perm, mod } = require('../middleware/permission');
const stock = require('../services/locationStockService');
const { hamsUrl, intOr } = require('../core/helpers');

const router = express.Router();

router.get('/location-stock', authRequired, perm('assets.view'), mod('assets'), async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const filters = stock.parseFilters(req.query, { category: await stock.laptopCategoryIds(), state: ['In stock'] });
    const [options, totals, cards, models, list] = await Promise.all([
      stock.filterOptions(user), stock.totals(filters, user), stock.siteCards(filters, user),
      stock.modelBreakdown(filters, user), stock.laptopList(filters, user, intOr(req.query.page, 1))
    ]);
    res.renderPage('location-stock/index', { filters, options, totals, cards, models, list, examples: stock.EXAMPLES, toQuery: stock.toQuery });
  } catch (err) { next(err); }
});

router.post('/location-stock/ask', authRequired, csrfProtect, perm('assets.view'), mod('assets'), async (req, res) => {
  try {
    const user = await currentUser(req);
    res.json(await stock.ask(req.body && req.body.q, user, hamsUrl('').replace(/\/$/, '')));
  } catch (err) {
    res.status(err.status || 500).json({ answer: err.status ? err.message : 'The assistant hit an error. Try rephrasing.' });
  }
});

module.exports = router;
