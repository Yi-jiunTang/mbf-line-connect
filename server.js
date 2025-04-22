// server.js — 最簡版測試
const http = require('http');
const port = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('OK');
  }
  // 其他方法都 404
  res.writeHead(404);
  res.end();
});

server.listen(port, () => {
  console.log(`Minimal server listening on ${port}`);
});
