# Runtime interfaces

`TTLCache` stores values in process with a capacity and a caller supplied clock. Its public interface is `set(key, value, ttlMs)`, `get(key)` and `size`. The adapter uses it to remember successful responses.

`retry` calls an asynchronous operation with an attempt number starting at one. The caller chooses the attempt limit, fixed delay, absolute deadline, clock and waiting function. Successful results and final failures pass through to the caller.

The backoff utility is used by a separate scheduler. Cache control headers describe HTTP responses and do not govern the in process cache. Metrics are optional observations.
