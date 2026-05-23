'use strict';

const http = require('http');
const net = require('net');
const { log, formatBytes, getClientIP, isPrivateIP, parseAddr, activeConns, totalConns, upstreamOnline } = require('./utils');

/**
 * 解析 CONNECT 请求中的目标地址
 * CONNECT example.com:443 → { host: 'example.com', port: 443 }
 */
function parseTarget(url) {
  const i = url.lastIndexOf(':');
  return { host: url.slice(0, i), port: parseInt(url.slice(i + 1)) };
}

/**
 * 创建 HTTP 代理服务器
 *
 * 处理两种请求：
 * 1. 普通 HTTP 请求：转发到上游代理，上游不可用时直连目标服务器
 * 2. CONNECT 请求（HTTPS）：通过上游建立隧道，上游不可用时直连目标服务器
 *
 * @param {object} config - 配置对象
 * @returns {http.Server}
 */
function createHTTPProxy(config) {
  const [upHost, upPort] = parseAddr(config.upstream);

  // ---- 普通 HTTP 请求处理 ----
  const server = http.createServer((req, res) => {
    const ip = getClientIP(req.socket);

    if (config.lanOnly && !isPrivateIP(ip)) {
      log('DENY', `${req.method} ${req.url} from ${ip}`);
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    const clientPort = req.socket.remotePort;

    // 上游不可用时，直连目标服务器
    if (!upstreamOnline.value) {
      const directReq = http.request(req.url, {
        method: req.method,
        headers: req.headers,
      }, (directRes) => {
        res.writeHead(directRes.statusCode, directRes.headers);
        directRes.pipe(res);
        let bytes = 0;
        directRes.on('data', (c) => { bytes += c.length; });
        directRes.on('end', () => {
          log('DIRECT', `${ip}:${clientPort} ${req.method} ${req.headers.host || req.url} -> ${directRes.statusCode} (${formatBytes(bytes)})`);
        });
      });
      directReq.on('error', (err) => {
        log('ERR', `${ip}:${clientPort} ${req.method} ${req.url} 直连失败: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(502);
          res.end('Bad Gateway');
        }
      });
      req.pipe(directReq);
      return;
    }

    // 上游可用时，转发到上游代理
    const proxyReq = http.request({
      host: upHost,
      port: upPort,
      method: req.method,
      path: req.url,
      headers: req.headers,
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
      let bytes = 0;
      proxyRes.on('data', (c) => { bytes += c.length; });
      proxyRes.on('end', () => {
        log('HTTP', `${ip}:${clientPort} ${req.method} ${req.headers.host || req.url} -> ${proxyRes.statusCode} (${formatBytes(bytes)})`);
      });
    });

    proxyReq.on('error', (err) => {
      log('ERR', `${ip}:${clientPort} ${req.method} ${req.url}: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502);
        res.end('Bad Gateway');
      }
    });

    req.pipe(proxyReq);
  });

  // ---- HTTPS CONNECT 隧道处理 ----
  server.on('connect', (req, client, head) => {
    const ip = getClientIP(client);
    const clientPort = client.remotePort;

    if (config.lanOnly && !isPrivateIP(ip)) {
      log('DENY', `${ip}:${clientPort} CONNECT ${req.url} - 非局域网`);
      client.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      client.destroy();
      return;
    }

    activeConns.value++;
    totalConns.value++;
    const id = totalConns.value;

    // 上游不可用时，直连目标服务器
    if (!upstreamOnline.value) {
      const target = parseTarget(req.url);
      const direct = net.connect(target.port, target.host);
      direct.setNoDelay(true);
      direct.setKeepAlive(true, 30000);

      direct.on('connect', () => {
        log('DIRECT', `#${id} ${ip}:${clientPort} -> ${req.url} (${activeConns.value} active)`);
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) direct.write(head);
        direct.pipe(client);
        client.pipe(direct);
      });

      direct.on('error', () => {
        log('ERR', `#${id} ${ip}:${clientPort} 直连 ${req.url} 失败`);
        client.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        client.destroy();
        activeConns.value--;
      });

      client.on('error', () => { direct.destroy(); activeConns.value--; });
      client.on('close', () => { direct.destroy(); activeConns.value--; });
      return;
    }

    // 上游可用时，通过上游代理建立隧道
    const upstream = net.connect(upPort, upHost);
    upstream.setNoDelay(true);
    upstream.setKeepAlive(true, 30000);

    upstream.on('connect', () => {
      upstream.write(`CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\n\r\n`);
    });

    let hBuf = Buffer.alloc(0);
    let ready = false;
    let cleaned = false;

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      upstream.destroy();
      activeConns.value--;
    };

    upstream.on('data', (chunk) => {
      if (ready) return;
      hBuf = Buffer.concat([hBuf, chunk]);
      const i = hBuf.indexOf('\r\n\r\n');
      if (i === -1) return;

      const header = hBuf.slice(0, i).toString();
      if (!header.includes('200')) {
        log('ERR', `#${id} ${ip}:${clientPort} 上游拒绝 CONNECT ${req.url}: ${header.split('\r\n')[0]}`);
        client.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        upstream.destroy();
        client.destroy();
        activeConns.value--;
        return;
      }

      ready = true;
      log('CONNECT', `#${id} ${ip}:${clientPort} -> ${req.url} (${activeConns.value} active)`);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');

      const rest = hBuf.slice(i + 4);
      if (rest.length > 0) client.write(rest);
      if (head.length > 0) upstream.write(head);

      upstream.removeAllListeners('data');
      upstream.pipe(client);
      client.pipe(upstream);
    });

    upstream.on('error', () => {
      if (!client.destroyed && !ready) {
        client.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      }
      cleanup();
    });

    client.on('error', cleanup);
    client.on('close', cleanup);
  });

  return server;
}

module.exports = { createHTTPProxy };