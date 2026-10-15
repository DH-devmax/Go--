const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '../dist');
const port = Number(process.env.PORT || 8765);
http.createServer(async (request, response) => {
  try {
    const name = new URL(request.url, 'http://localhost').pathname;
    if (name === '/') {
      const html = await fs.readFile(path.join(root, 'index.html'), 'utf8');
      response.setHeader('Content-Type', 'text/html');
      response.end(html.replace('<script defer', '<script src="/crop-fixture.js"></script><script defer'));
      return;
    }
    const target = name === '/crop-fixture.js' ? path.join(__dirname, 'crop-fixture.js') : path.resolve(root, `.${name}`);
    if (name !== '/crop-fixture.js' && !target.startsWith(`${root}${path.sep}`)) { response.writeHead(403).end(); return; }
    response.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[path.extname(target)] || 'application/octet-stream');
    response.end(await fs.readFile(target));
  } catch { response.writeHead(404).end(); }
}).listen(port, '127.0.0.1', () => console.log(`Local crop fixture: http://127.0.0.1:${port}`));
