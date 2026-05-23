'use strict';

const http = require('http');
const net = require('net');
const { log, formatBytes, getClientIP, isPrivateIP, parseAddr, activeConns, totalConns } = require('./utils');

/**
 * 创建 HTTP 代理服务器
 *
 * 处理两种请求：
 * 1. 普通 HTTP 请求：直接转发到上游代理（Clash Verge）
 * 2. CONNECT 请求（HTTPS）：与上游建立隧道，双向透传数据
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
  // 流程：
  //   1. 本工具连接到 Clash Verge
  //   2. 向 Clash Verge 转发 CONNECT example.com:443
  //   3. Clash Verge 与目标服务器建立 TCP 连接，返回 200
  //   4. 本工具向手机返回 200
  //   5. 双向透传：手机 <--> 本工具(pipe) <--> Clash Verge <--> 目标服务器
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