# Parcel Desk

Parcel Desk is the local core of a fulfillment dashboard. It quotes shopping carts, accepts partner manifests, tracks delivery plans, and produces customer messages. All amounts are integer cents and all weights are integer grams. Dates are opaque ISO strings supplied by callers.

The root package is the production application. A separate preview workspace evaluates the next major Effect release. Dependency versions and installation paths are deliberate. Use the version belonging to the application you are changing.

Run `npm run check` for the build and public tests. `npm run build` and `npm test` also work at the root. Packages are installed before the evaluation starts; network access is unnecessary. The public entry point is `src/index.ts`. Its exported runtime names, method signatures, and types are part of the contract. Internal modules may change. Tests are examples, not the complete requirements. Modify source files only.

Operational modules cover catalog revisions, promotion and tax calculation, carrier selection, stock reservation, dispatch planning, and dashboard projections. The public operational scenarios run these flows through both successful and rejected changes. Dispatch preparation consumes the production partner importer and creates the delivery records used by the scheduling dashboard.
