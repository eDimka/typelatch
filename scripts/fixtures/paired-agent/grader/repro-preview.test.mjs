import test from 'node:test'
import assert from 'node:assert/strict'
import { Checkout } from '../dist/index.js'
test('changing quantity after a preview updates price and weight', () => {
  const checkout = new Checkout({ cup: { sku: 'cup', title: 'Cup', unitGrams: 300, unitCents: 500 } }, { baseByRegion: { '*': 100 }, perStartedKilogram: 40 })
  checkout.preview({ lines: [{ sku: 'cup', quantity: 1 }], region: 'eu' })
  assert.deepEqual(checkout.preview({ lines: [{ sku: 'cup', quantity: 4 }], region: 'eu' }), { merchandiseCents: 2000, grams: 1200, shippingCents: 180, totalCents: 2180 })
})
