'use strict';

const net = require('net');
const { log, getClientIP, isPrivateIP, parseAddr, activeConns, upstreamOnline } = require('./utils');

/**
 * 解析 SOCKS5 请求中的目标地址为 host:port
 */
function parseTarget(url) {
  const i = url.lastIndexOf(':');
  return { host: url.slice(0, i), port: parseInt(url.slice(i + 1)) };
}

/**
 * 创建 SOCKS5 代理服务器
 *
 * 将 SOCKS5 协议转换为 HTTP CONNECT 请求，通过上游代理转发。
 * 上游不可用时，直连目标服务器。
 *
 * @param {object} config - 配置对象
 * @returns {net.Server}
 */
function createSOCKS5Server(config) {
  const [upHost, upPort] = parseAddr(config.upstream);

  const server = net.createServer((socket) => {
    const ip = getClientIP(socket);
    const clientPort = socket.remotePort;

    if (config.lanOnly && !isPrivateIP(ip)) {
      log('DENY', `${ip}:${clientPort} SOCKS5 - 非局域网`);
      socket.destroy();
      return;
    }

    let state = 'handshake';
    let target = '';
    let buf = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      process();
    });
    socket.on('error', () => { /* 忽略连接错误 */ });

    function process() {
      if (state === 'handshake') {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05) { socket.destroy(); return; }
        const n = buf[1];
        if (buf.length < 2 + n) return;
        buf = buf.slice(2 + n);
        socket.write(Buffer.from([0x05, 0x00]));
        state = 'request';
        process();
        return;
      }

      if (state === 'request') {
        if (buf.length < 4) return;

        if (buf[1] !== 0x01) {
          socket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          socket.destroy();
          return;
        }

        let addrLen;
        switch (buf[3]) {
          case 0x01: addrLen = 4; break;
          case 0x03: addrLen = 1 + buf[4]; break;
          case 0x04: addrLen = 16; break;
          default:
            socket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            socket.destroy();
            return;
        }

        const total = 4 + addrLen + 2;
        if (buf.length < total) return;

        let host;
        switch (buf[3]) {
          case 0x01:
            host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
            break;
          case 0x03:
            host = buf.slice(5, 5 + buf[4]).toString();
            break;
          case 0x04:
            host = Array.from(buf.slice(4, 20))
              .map((b) => b.toString(16).padStart(2, '0'))
              .join(':');
            break;
        }

        const pOff = 4 + addrLen;
        const port = (buf[pOff] << 8) | buf[pOff + 1];
        target = `${host}:${port}`;
        buf = buf.slice(total);
        state = 'relay';

        log('SOCKS5', `${ip}:${clientPort} -> ${target}`);
        connectUpstream();
      }
    }

    function connectUpstream() {
      // 上游不可用时，直连目标服务器
      if (!upstreamOnline.value) {
        const t = parseTarget(target);
        const direct = net.connect(t.port, t.host);
        direct.setNoDelay(true);
        direct.setKeepAlive(true, 30000);

        direct.on('connect', () => {
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          socket.removeAllListeners('data');
          if (buf.length > 0) direct.write(buf);
          direct.pipe(socket);
          socket.pipe(direct);
        });

        direct.on('error', () => {
          log('ERR', `${ip}:${clientPort} SOCKS5 ${target} 直连失败`);
          socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          socket.destroy();
        });

        socket.on('close', () => { direct.destroy(); });
        return;
      }

      // 上游可用时，通过上游代理建立连接
      const upstream = net.connect(upPort, upHost);
      upstream.setNoDelay(true);
      upstream.setKeepAlive(true, 30000);

      upstream.on('connect', () => {
        upstream.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
      });

      let hBuf = Buffer.alloc(0);
      let ready = false;

      upstream.on('data', (chunk) => {
        if (ready) return;
        hBuf = Buffer.concat([hBuf, chunk]);
        const i = hBuf.indexOf('\r\n\r\n');
        if (i === -1) return;

        ready = true;
        const header = hBuf.slice(0, i).toString();

        if (!header.includes('200')) {
          log('ERR', `${ip}:${clientPort} SOCKS5 ${target} 上游拒绝: ${header.split('\r\n')[0]}`);
          socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          upstream.destroy();
          socket.destroy();
          return;
        }

        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));

        const rest = hBuf.slice(i + 4);
        if (rest.length > 0) socket.write(rest);

        socket.removeAllListeners('data');
        upstream.removeAllListeners('data');

        if (buf.length > 0) upstream.write(buf);

        upstream.pipe(socket);
        socket.pipe(upstream);
      });

      upstream.on('error', () => {
        if (!socket.destroyed) {
          socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          socket.destroy();
        }
      });

      socket.on('close', () => {
        upstream.destroy();
      });
    }
  });

  return server;
}

module.exports = { createSOCKS5Server };