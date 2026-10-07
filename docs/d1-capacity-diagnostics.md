# D1 capacity failure diagnostics

The capacity integration test still fills the real 128 MiB budget, rejects an oversized 512 KiB row and false stored-byte accounting, races the final two inserts, and checks the exact cap and duplicate behavior. Its SQL, thresholds, assertions, and concurrency are unchanged.

The observer covers only the 85 capacity-fill batches. Success produces no diagnostic output. A failure adds one `D1_CAPACITY_DIAGNOSTIC` record and rethrows the original exception object, including its cause. It never retries writes, probes the database, changes sockets, waits, or yields. Listeners are removed when the fill loop exits.

The record contains:

- One-based failed batch index and rows confirmed before that batch
- Elapsed time, failed batch time, and synchronous invocation time, including statement preparation and binding
- Event-loop active/idle time and utilization over that batch, measured without adding a timer
- Node RSS, observer-error count, and at most 12 recent transport events
- Numeric request/socket IDs, observed socket age, idle time since an observed completed response, numeric request length/status, and an allowlisted transport error code

Unknown length, status, or socket idle time is `-1`. Socket age starts when this observer first sees the socket; it is not necessarily the connection's total lifetime. Events come from the test process's asynchronous undici requests; synchronous proxy traffic in another thread is not observed. No URL, SQL, payload, header, proxy secret, or error message is collected. Unknown error codes become `UNCLASSIFIED`.

These measurements do not prove a particular failure cause. High event-loop utilization does not identify what blocked the loop, and Node RSS does not measure workerd memory. A passing diagnostic run does not establish why an earlier Windows run failed or prove it fixed.

## Manual synthetic idle-socket characterization

This separate script uses an integer table, six initial rows, and one three-row batch. It is not included in routine test acceptance. It deliberately blocks Node for six seconds in `block` mode and uses asynchronous waiting in `yield` mode. The original Linux experiment reproduced a stale socket failure in blocking mode (`UND_ERR_SOCKET`) and succeeded in yielding mode; the earlier Windows CI error was `ECONNRESET`, so Windows causality remains unproven.

With the repository's pinned Node/dependencies installed and packages built:

```sh
node scripts/diagnostics/d1-idle-boundary.mjs block
node scripts/diagnostics/d1-idle-boundary.mjs yield
```

Blocking mode is expected to exit unsuccessfully when the transport issue reproduces. After a failure, a read-only row-count probe distinguishes runtime liveness and whether the batch committed; it never retries the write. The diagnostic script emits only synthetic numeric state and the failure record, followed by the unchanged original exception. It performs no external writes or deployment.
