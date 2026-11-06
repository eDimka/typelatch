import test from 'node:test';
import assert from 'node:assert/strict';
import { CatalogStore, readCatalogRows, catalogToProducts } from '../dist/catalog/service.js';
import { RateBook, simpleRatesForRegion } from '../dist/quotes/rate-book.js';
import { allocateCents, applyCartAdjustments, calculateTax, taxRuleForRegion, returnCredit, adjustmentSummary } from '../dist/cart/adjustments.js';
import { StockLedger } from '../dist/dispatch/stock-ledger.js';
import { DispatchPlanner } from '../dist/dispatch/planner.js';
import { dashboardPage, fulfillmentTotals, inspectDeliveryIntegrity, stockDashboard, carrierSpend, orderTiles } from '../dist/dashboard/read-model.js';
import { Checkout, DeliveryBook } from '../dist/index.js';

const rows = () => [
  { sku: 'mug', title: 'Blue Mug', unitGrams: 300, unitCents: 700, tags: ['home', 'blue'], active: true },
  { sku: 'book', title: 'Route Book', unitGrams: 500, unitCents: 1200, tags: ['travel'], active: true },
  { sku: 'old', title: 'Old Card', unitGrams: 0, unitCents: 0, tags: ['archive'], active: false },
];
const card = (id = 'economy', overrides = {}) => ({ id, carrier: 'ParcelCo', service: 'standard', regions: ['eu'], postalPrefixes: [], minGrams: 0, maxGrams: 5000, bands: [{ throughGrams: 1000, cents: 300 }, { throughGrams: null, cents: 500 }], fuelBasisPoints: 500, remoteAreaCents: 125, availableFrom: '2026-01-01', availableUntil: null, priority: 0, ...overrides });
const request = overrides => ({ region: 'eu', postalCode: '11000', grams: 600, service: 'standard', date: '2026-10-06', remote: false, ...overrides });
const location = (id, priority) => ({ id, priority, active: true, regions: ['eu'] });
const lots = () => [
  { id: 'mug-west', sku: 'mug', locationId: 'west', quantity: 1, receivedAt: '2026-01-01', expiresAt: null },
  { id: 'mug-east', sku: 'mug', locationId: 'east', quantity: 5, receivedAt: '2026-01-02', expiresAt: null },
  { id: 'book-east', sku: 'book', locationId: 'east', quantity: 4, receivedAt: '2026-01-01', expiresAt: null },
];
const ledger = () => new StockLedger([location('west', 2), location('east', 1)], lots());
const window = () => ({ from: '2026-10-10', to: '2026-10-12' });
const order = (id = 'o1') => ({ id, manifestReference: 'parcel-one', cart: { lines: [{ sku: 'mug', quantity: 2 }], region: 'eu' }, postalCode: '11000', window: window() });
const manifest = () => ({ partner: 'vendor', parcels: [{ reference: 'parcel-one', grams: 600, service: 'standard' }] });
const planner = () => { const stock = ledger(); return { stock, planner: new DispatchPlanner(catalogToProducts(rows()), new RateBook([card()]), stock) }; };

test('catalog import reports row errors while normalizing valid inventory', () => {
  const imported = readCatalogRows([...rows(), { sku: ' mug ', title: 'duplicate', unitGrams: 1, unitCents: 1 }, { sku: 'bad', title: '', unitGrams: -1, unitCents: 2 }]);
  assert.equal(imported.rows.length, 3);
  assert.deepEqual(imported.rows[0].tags, ['blue', 'home']);
  assert.equal(imported.issues.length, 3);
  assert.equal(readCatalogRows(null).issues[0].field, 'rows');
  const store = new CatalogStore(imported.rows);
  assert.equal(store.search().total, 2);
  assert.equal(store.search({ includeInactive: true }, 0, 1).nextOffset, 1);
  assert.equal(store.search({ query: 'blue', tags: ['HOME'], minCents: 600, maxCents: 800 }).rows[0].sku, 'mug');
  assert.equal(store.search({ query: 'not-present' }).total, 0);
  assert.equal(store.search({ minCents: 2000 }).total, 0);
  assert.equal(store.search({ maxCents: 10 }).total, 0);
  assert.throws(() => store.search({}, -1), /offset/);
  assert.throws(() => store.search({}, 0, 101), /limit/);
  assert.equal(store.get('missing'), null);
  assert.deepEqual(store.totals(), { active: 2, inactive: 1, catalogValueCents: 1900, tags: ['archive', 'blue', 'home', 'travel'] });
});

test('catalog revisions are atomic and feed production checkout snapshots', () => {
  const store = new CatalogStore(rows());
  const rates = simpleRatesForRegion([{ region: '*', baseCents: 100 }], 40);
  const checkout = new Checkout(store.products(), rates);
  const first = store.apply([{ kind: 'deactivate', sku: 'mug' }, { kind: 'remove', sku: 'old' }, { kind: 'upsert', row: { ...rows()[1], unitCents: 1500 } }]);
  assert.deepEqual(first.changedSkus, ['book', 'mug', 'old']);
  assert.equal(store.get('book').unitCents, 1500);
  assert.equal(store.get('mug').active, false);
  assert.equal(store.get('old'), null);
  first.rows[0].tags.push('tampered');
  assert.equal(store.changesAfter(0)[0].rows[0].tags.includes('tampered'), false);
  const before = store.search({ includeInactive: true });
  assert.throws(() => store.apply([{ kind: 'remove', sku: 'book' }, { kind: 'deactivate', sku: 'missing' }]), /Unknown/);
  assert.deepEqual(store.search({ includeInactive: true }), before);
  assert.throws(() => store.apply([{ kind: 'upsert', row: { ...rows()[0], unitCents: -1 } }]), /Invalid/);
  assert.equal(store.changesAfter(1).length, 0);
  assert.equal(checkout.preview({ lines: [{ sku: 'mug', quantity: 1 }], region: 'eu' }).totalCents, 840);
  assert.deepEqual(Object.keys(store.products()), ['book']);
});

test('carrier rates explain eligibility, rounded surcharges and deterministic choices', () => {
  const rates = new RateBook([card(), card('cheap', { carrier: 'Budget', bands: [{ throughGrams: null, cents: 250 }], fuelBasisPoints: 0 }), card('postal', { postalPrefixes: ['99'] }), card('expired', { availableUntil: '2026-02-01' }), card('express', { service: 'express' })]);
  assert.equal(rates.best(request()).cardId, 'cheap');
  assert.equal(rates.offers(request()).length, 2);
  assert.deepEqual(rates.explain(request()).find(item => item.cardId === 'postal').reasons, ['postal-code']);
  assert.deepEqual(rates.explain(request()).find(item => item.cardId === 'expired').reasons, ['date']);
  assert.deepEqual(rates.explain(request()).find(item => item.cardId === 'express').reasons, ['service']);
  assert.equal(rates.best(request({ region: 'us' })), null);
  assert.equal(rates.best(request({ grams: 6000 })), null);
  const remote = new RateBook([card()]).best(request({ remote: true, grams: 1500 }));
  assert.deepEqual(remote, { cardId: 'economy', carrier: 'ParcelCo', baseCents: 500, fuelCents: 25, remoteCents: 125, totalCents: 650, priority: 0 });
  assert.equal(rates.compare([request(), request({ region: 'us' })])[1].selected, null);
  assert.deepEqual(rates.summary().services, ['express', 'standard']);
  assert.throws(() => rates.offers(request({ grams: -1 })), /integer/);
  assert.throws(() => rates.offers(request({ date: '' })), /requires/);
});

test('rate replacement validates every band before changing the active book', () => {
  const rates = new RateBook([card()]);
  assert.throws(() => rates.replace([card('bad', { bands: [{ throughGrams: 10, cents: 1 }, { throughGrams: 5, cents: 1 }] })]), /increase/);
  assert.equal(rates.best(request()).cardId, 'economy');
  assert.throws(() => new RateBook([card(), card()]), /Duplicate/);
  assert.throws(() => new RateBook([card('bad', { bands: [{ throughGrams: null, cents: 1 }, { throughGrams: 50, cents: 1 }] })]), /last/);
  assert.throws(() => new RateBook([card('bad', { bands: [] })]), /bands/);
  rates.replace([card('new', { priority: 2 })]);
  const copy = rates.list(); copy[0].bands[0].cents = 0;
  assert.equal(rates.best(request()).baseCents, 300);
  assert.equal(rates.summary().cards, 1);
  assert.equal(simpleRatesForRegion([{ region: 'local', baseCents: 0 }], 0).baseByRegion.local, 0);
  assert.throws(() => simpleRatesForRegion([{ region: 'eu', baseCents: 1 }, { region: 'eu', baseCents: 2 }], 1), /Duplicate/);
  assert.throws(() => simpleRatesForRegion([], -1), /Invalid/);
});

const adjustment = (id, overrides = {}) => ({ id, kind: 'fixed', amount: 100, minimumSubtotal: 0, eligibleSkus: [], minimumUnits: 0, exclusiveGroup: null, stackable: true, ...overrides });
test('cart adjustments allocate exact cents and preserve return credit conservation', () => {
  assert.deepEqual(allocateCents(5, [1, 1, 1]), [2, 2, 1]);
  assert.deepEqual(allocateCents(0, [0, 0]), [0, 0]);
  assert.deepEqual(allocateCents(0, []), []);
  assert.throws(() => allocateCents(1, []), /empty/);
  assert.throws(() => allocateCents(1, [0]), /zero/);
  const cart = { lines: [{ sku: 'mug', quantity: 2 }, { sku: 'book', quantity: 1 }], region: 'eu' };
  const result = applyCartAdjustments(cart, catalogToProducts(rows()), [adjustment('percent', { kind: 'percent', amount: 1000 }), adjustment('fixed')]);
  assert.equal(result.grossCents, 2600);
  assert.equal(result.discountCents, 360);
  assert.equal(result.netCents, 2240);
  assert.equal(result.lines.reduce((total, line) => total + line.netCents, 0), 2240);
  assert.equal(returnCredit(result.lines, { mug: 2, book: 1 }).reduce((total, item) => total + item.cents, 0), 2240);
  assert.equal(returnCredit(result.lines, { mug: 1 })[0].quantity, 1);
  assert.throws(() => returnCredit(result.lines, { mug: 3 }), /exceeds/);
  assert.throws(() => returnCredit(result.lines, { mug: -1 }), /Invalid/);
  assert.equal(adjustmentSummary(result).length, 2);
});

test('promotion eligibility, exclusivity and tax rounding remain deterministic', () => {
  const cart = { lines: [{ sku: 'mug', quantity: 2 }], region: 'eu' }, catalog = catalogToProducts(rows());
  const result = applyCartAdjustments(cart, catalog, [adjustment('too-small', { minimumSubtotal: 5000 }), adjustment('units', { minimumUnits: 3 }), adjustment('none', { eligibleSkus: ['missing'] }), adjustment('group-a', { exclusiveGroup: 'season' }), adjustment('group-b', { exclusiveGroup: 'season' }), adjustment('single', { stackable: false })]);
  assert.deepEqual(result.rejected.map(row => row.reason), ['minimum-subtotal', 'minimum-units', 'no-eligible-value', 'exclusive-group', 'not-stackable']);
  assert.equal(applyCartAdjustments(cart, catalog, [adjustment('bulk', { kind: 'buy-more', amount: 50, minimumUnits: 2 })]).discountCents, 50);
  assert.equal(applyCartAdjustments(cart, catalog, [adjustment('cap', { amount: 10000 })]).netCents, 0);
  assert.throws(() => applyCartAdjustments(cart, catalog, [adjustment('same'), adjustment('same')]), /Duplicate/);
  assert.throws(() => applyCartAdjustments(cart, catalog, [adjustment('bad', { kind: 'percent', amount: 10001 })]), /exceeds/);
  assert.deepEqual(calculateTax(1200, { region: 'eu', basisPoints: 2000, inclusive: true }), { netCents: 1000, taxCents: 200, grossCents: 1200, basisPoints: 2000 });
  assert.deepEqual(calculateTax(1001, { region: 'eu', basisPoints: 2000, inclusive: false }), { netCents: 1001, taxCents: 200, grossCents: 1201, basisPoints: 2000 });
  assert.equal(taxRuleForRegion('eu', [{ region: '*', basisPoints: 500, inclusive: false }]).basisPoints, 500);
  assert.equal(taxRuleForRegion('eu', []).basisPoints, 0);
  assert.throws(() => calculateTax(-1, { region: 'eu', basisPoints: 0, inclusive: false }), /nonnegative/);
});

test('stock reservations split across locations without overselling or partial holds', () => {
  const stock = ledger();
  const held = stock.reserve('r1', 'o1', [{ sku: 'mug', quantity: 1 }, { sku: 'mug', quantity: 2 }], 'eu', '2026-10-06');
  assert.deepEqual(held.allocations.map(row => row.quantity), [1, 2]);
  assert.deepEqual(stock.availability('mug', 'eu', '2026-10-06'), { onHand: 6, held: 3, available: 3 });
  const before = stock.snapshot();
  assert.throws(() => stock.reserve('fail', 'o2', [{ sku: 'book', quantity: 2 }, { sku: 'mug', quantity: 4 }], 'eu', '2026-10-06'), /Insufficient/);
  assert.deepEqual(stock.snapshot(), before);
  held.allocations[0].quantity = 999;
  assert.equal(stock.forOrder('o1')[0].allocations[0].quantity, 1);
  assert.equal(stock.commit('r1').state, 'committed');
  assert.equal(stock.commit('r1').state, 'committed');
  assert.deepEqual(stock.availability('mug', 'eu', '2026-10-06'), { onHand: 3, held: 0, available: 3 });
  assert.equal(stock.eventsAfter(1).length, 1);
  assert.throws(() => stock.release('r1'), /Committed/);
  assert.throws(() => stock.reserve('r1', 'o2', [{ sku: 'mug', quantity: 1 }], 'eu', '2026-10-06'), /already/);
});

test('stock releases, restocks and expiry rules keep operational inventory coherent', () => {
  const stock = ledger();
  stock.reserve('r', 'o', [{ sku: 'book', quantity: 2 }], 'eu', '2026-10-06');
  assert.equal(stock.release('r').state, 'released');
  assert.equal(stock.release('r').state, 'released');
  assert.equal(stock.availability('book', 'eu', '2026-10-06').available, 4);
  assert.throws(() => stock.commit('r'), /Released/);
  stock.restock({ ...lots()[2], quantity: 2 });
  assert.equal(stock.availability('book', 'eu', '2026-10-06').available, 6);
  stock.restock({ id: 'expired', sku: 'book', locationId: 'east', quantity: 5, receivedAt: '2026-01-01', expiresAt: '2026-02-01' });
  assert.equal(stock.availability('book', 'eu', '2026-10-06').available, 6);
  assert.equal(stock.availability('book', 'us', '2026-10-06').available, 0);
  assert.throws(() => stock.restock({ ...lots()[2], sku: 'other' }), /identity/);
  assert.throws(() => stock.reserve('bad', 'o', [{ sku: 'mug', quantity: 0 }], 'eu', '2026-10-06'), /Invalid/);
  assert.throws(() => stock.release('missing'), /Unknown/);
  assert.equal(stockDashboard(stock.snapshot()).find(row => row.sku === 'book').onHand, 11);
});

test('dispatch integrates production manifest, catalog, stock, carrier rates and delivery records', () => {
  const { stock, planner: dispatch } = planner();
  const prepared = dispatch.prepare('batch-one', manifest(), [order()], '2026-10-06');
  assert.equal(prepared.parcels.length, 2);
  assert.equal(prepared.shippingCents, 630);
  assert.equal(prepared.delivery.orders.length, 1);
  assert.equal(prepared.delivery.labels.length, 2);
  assert.equal(stock.availability('mug', 'eu', '2026-10-06').held, 2);
  assert.equal(inspectDeliveryIntegrity(prepared.delivery).length, 0);
  assert.equal(fulfillmentTotals(prepared.delivery).inconsistentOrders, 0);
  const book = new DeliveryBook(prepared.delivery);
  assert.equal(book.reschedule('o1', { from: '2026-11-01', to: '2026-11-02' }), true);
  assert.equal(book.snapshot().orders[0].window.from, '2026-11-01');
  const committed = dispatch.commit('batch-one');
  assert.equal(committed.state, 'committed');
  assert.equal(committed.delivery.shipments[0].state, 'departed');
  assert.equal(stock.availability('mug', 'eu', '2026-10-06').held, 0);
  assert.equal(dispatch.commit('batch-one').state, 'committed');
  assert.equal(dispatch.history().length, 2);
  assert.equal(dispatch.history(1).length, 1);
  assert.deepEqual(carrierSpend([committed]), [{ carrier: 'ParcelCo', parcels: 2, cents: 630 }]);
  assert.deepEqual(dispatch.totals(), { prepared: 0, committed: 1, cancelled: 0, committedShippingCents: 630 });
  assert.throws(() => dispatch.cancel('batch-one'), /Committed/);
});

test('dispatch cancellation and failed preparation release held stock with audit evidence', () => {
  const { stock, planner: dispatch } = planner();
  const prepared = dispatch.prepare('batch', manifest(), [order()], '2026-10-06');
  prepared.parcels[0].items[0].quantity = 999;
  assert.equal(dispatch.get('batch').parcels[0].items[0].quantity, 1);
  assert.equal(dispatch.forOrder('o1').length, 1);
  assert.equal(dispatch.cancel('batch').state, 'cancelled');
  assert.equal(dispatch.cancel('batch').state, 'cancelled');
  assert.equal(stock.availability('mug', 'eu', '2026-10-06').available, 6);
  assert.throws(() => dispatch.commit('batch'), /Cancelled/);
  assert.equal(dispatch.get('missing'), null);
  assert.throws(() => dispatch.cancel('missing'), /Unknown/);
  const missingRate = new DispatchPlanner(catalogToProducts(rows()), new RateBook([]), stock);
  assert.throws(() => missingRate.prepare('no-rate', manifest(), [order('o2')], '2026-10-06'), /No carrier/);
  assert.equal(stock.forOrder('o2')[0].state, 'released');
  assert.equal(stock.availability('mug', 'eu', '2026-10-06').available, 6);
  assert.equal(dispatch.validate([{ ...order(), manifestReference: 'missing' }], manifest().parcels).issues[0].code, 'manifest-reference');
  assert.equal(dispatch.validate([{ ...order(), cart: { ...order().cart, lines: [] } }], manifest().parcels).valid, false);
  assert.throws(() => dispatch.prepare('bad', manifest(), [{ ...order(), cart: { ...order().cart, lines: [{ sku: 'book', quantity: 1 }] } }], '2026-10-06'), /weight-mismatch/);
});

test('dashboard projections expose drift, filter orders and report structural corruption', () => {
  const { planner: dispatch } = planner();
  const delivery = dispatch.prepare('display', manifest(), [order()], '2026-10-06').delivery;
  assert.equal(dashboardPage(delivery).rows[0].planned, 2);
  assert.equal(dashboardPage(delivery, { query: 'O1', state: 'open' }).total, 1);
  assert.equal(dashboardPage(delivery, { state: 'closed' }).total, 0);
  assert.equal(dashboardPage(delivery, { from: '2027-01-01' }).total, 0);
  assert.equal(dashboardPage(delivery, { to: '2025-01-01' }).total, 0);
  assert.equal(dashboardPage(delivery, { attentionOnly: true }).total, 0);
  delivery.shipments[0].window.from = '2026-10-09';
  delivery.labels[1].window.to = '2026-10-13';
  delivery.notices[0].window.from = '2026-10-09';
  assert.deepEqual(orderTiles(delivery)[0].attention, ['shipment-window', 'label-window', 'notice-window']);
  assert.equal(dashboardPage(delivery, { attentionOnly: true }).total, 1);
  delivery.orders.push({ id: 'o2', state: 'open', window: window() });
  assert.equal(dashboardPage(delivery, {}, 0, 1).nextOffset, 1);
  delivery.labels.push({ id: 'orphan', shipmentId: 'missing', state: 'queued', window: { from: 'z', to: 'a' } });
  delivery.orders.push({ ...delivery.orders[0] });
  assert.deepEqual(new Set(inspectDeliveryIntegrity(delivery).map(issue => issue.kind)), new Set(['duplicate', 'window', 'orphan']));
  assert.throws(() => dashboardPage(delivery, {}, 0, 0), /Invalid/);
});
