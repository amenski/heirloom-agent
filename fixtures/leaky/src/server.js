import http from "node:http";

const listeners = [];

function createHandler() {
  return function handler(req, res) {
    const requestId = Date.now();

    listeners.push(() => {
      if (req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("OK\n");
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    const cb = listeners[listeners.length - 1];
    cb();
  };
}

const server = http.createServer((req, res) => {
  createHandler()(req, res);
});

server.listen(0, () => {
  const { port } = server.address();
  console.log(`listening on port ${port}`);

  let count = 0;
  const interval = setInterval(() => {
    http.get(`http://localhost:${port}/`, (res) => {
      res.resume();
      res.on("end", () => {
        count++;
        const mem = process.memoryUsage();
        console.log(
          `request #${count} | listeners: ${listeners.length} | ` +
          `heapUsed: ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`
        );
        if (count >= 20) {
          clearInterval(interval);
          server.close();
        }
      });
    });
  }, 200);
});
