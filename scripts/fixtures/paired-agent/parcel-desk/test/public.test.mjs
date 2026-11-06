import test from 'node:test';
import assert from 'node:assert/strict';
import { Checkout, importManifest, DeliveryBook } from '../dist/index.js';
const catalog = { cup: { sku: 'cup', title: 'Cup', unitGrams: 300, unitCents: 500 } };
const rates = { baseByRegion: { '*': 100 }, perStartedKilogram: 40 };
test('a single cart preview includes merchandise and shipping', () => {
  assert.deepEqual(new Checkout(catalog, rates).preview({ lines: [{ sku: 'cup', quantity: 1 }], region: 'eu' }), { merchandiseCents: 500, grams: 300, shippingCents: 140, totalCents: 640 });
});
test('an empty cart is free', () => assert.equal(new Checkout(catalog, rates).preview({ lines: [], region: 'eu' }).totalCents, 0));
test('a valid partner manifest is accepted', () => {
  assert.deepEqual(importManifest({ partner: 'shop', parcels: [{ reference: 'p1', grams: 300, service: 'standard' }] }), { ok: true, manifest: { partner: 'shop', parcels: [{ reference: 'p1', grams: 300, service: 'standard' }] } });
});
test('an unknown order cannot be rescheduled', () => assert.equal(new DeliveryBook({ orders: [], shipments: [], labels: [], notices: [] }).reschedule('missing', { from: '2026-11-01', to: '2026-11-02' }), false));
test('rescheduling updates an open order', () => {
  const book = new DeliveryBook({ orders: [{ id: 'one', state: 'open', window: { from: '2026-10-01', to: '2026-10-02' } }], shipments: [], labels: [], notices: [] });
  assert.equal(book.reschedule('one', { from: '2026-11-01', to: '2026-11-02' }), true);
  assert.deepEqual(book.snapshot().orders[0].window, { from: '2026-11-01', to: '2026-11-02' });
});
