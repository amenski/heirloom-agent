# leaky — G5: Diagnose memory growth

This HTTP server has a memory problem. When running, `listeners` grows
unbounded and heap usage increases with every request.

**Symptoms:** The `listeners` count and `heapUsed` both climb with each
request, even though requests complete successfully.

**Mission:** Explain *why* memory grows. Do not modify any files — this is
a read-only diagnosis task.

**Run:** `node src/server.js`
