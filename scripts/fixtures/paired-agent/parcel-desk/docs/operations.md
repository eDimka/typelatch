# Operations

A customer may preview several carts in the same browser session. Product catalog records are keyed by SKU. Repeated lines represent additional units, even when they have the same SKU. Region prices are selected by the requested region, falling back to the wildcard tariff only when the exact region has no configured price.

Delivery records link orders to shipments, shipments to label drafts, and orders to notification jobs. A queued label has not been printed. A queued notice has not been sent. Historical printed labels, sent notices, and departed shipments must remain unchanged.

The preview workspace is experimental. Its Effect package is a different major version from production and must not be substituted into the production importer.

## Operational boundaries

Catalog imports collect row issues and retain only valid rows. Catalog revisions stage all changes before publishing them. Active catalog products feed the checkout and dispatch snapshots. Cart promotions allocate integer cents deterministically and cap discounts at the remaining eligible value.

Carrier cards use inclusive weight bands and a half open availability interval. Eligible offers sort by total price, priority, carrier, then card identity. Rate book replacement validates the complete new book before publishing it.

Stock reservation consumes expiring lots first, then location priority and receipt order. A reservation validates the entire requested batch before holding stock. Commit deducts on hand quantity; release returns a hold without changing on hand quantity. Dispatch preparation uses those reservations to split each order by fulfillment location and select a carrier for each parcel. Failed preparation releases all holds it created and retains release events in the stock audit.

Dispatch commit marks shipments departed, labels printed, notices sent, and orders closed. Cancellation releases held stock and cancels planned shipments. Dashboard projections separately report relationship corruption and delivery window drift. These workflows are covered by public operational scenarios.
