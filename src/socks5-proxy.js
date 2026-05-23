'use strict';

const net = require('net');
const { log, getClientIP, isPrivateIP, parseAddr, activeConns } = require('./utils');

/**
 * 创建 SOCKS5 代理服务器
 *
 * 将 SOCKS5 协议转换为 HTTP CONNECT 请求，通过上游代理转发。
 * 这样设备可以使用 SOCKS5 协议连接本工具，而实际流量仍走 Clash Verge。
 *
 * SOCKS5 协议流程：
 *   1. 客户端发送版本号 + 支持的认证方法列表
 *   2. 服务端选择认证方法（本工具选择 0x00 = 无需认证）
 *   3. 客户端发送连接请求（目标地址 + 端口）
 *   4. 服务端建立连接并返回结果
 *   5. 双向透传数据
 *
 * 支持的目标地址类型：IPv4 (0x01)、域名 (0x03)、IPv6 (0x04)
 * 仅支持 CONNECT 命令 (0x01)，不支持 BIND 和 UDP ASSOCIATE
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

    // 使用状态机解析 SOCKS5 协议
    let state = 'handshake';  // handshake -> request -> relay
    let target = '';           // 目标地址 (host:port)
    let buf = Buffer.alloc(0); // 接收缓冲区

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      process();
    });
    socket.on('error', () => { /* 忽略连接错误 */ });

    /** 状态机：按 SOCKS5 协议逐步解析数据 */
    function process() {
      // ---- 阶段1：认证协商 ----
      if (state === 'handshake') {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05) { socket.destroy(); return; }
        const n = buf[1];
        if (buf.length < 2 + n) return;
        buf = buf.slice(2 + n);
        socket.write(Buffer.from([0x05, 0x00])); // 无需认证
        state = 'request';
        process();
        return;
      }

      // ---- 阶段2：连接请求 ----
      if (state === 'request') {
        if (buf.length < 4) return;

        if (buf[1] !== 0x01) {
          socket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          socket.destroy();
          return;
        }

        let addrLen;
        switch (buf[3]) {
          case 0x01: addrLen = 4; break;           // IPv4
          case 0x03: addrLen = 1 + buf[4]; break;  // 域名
          case 0x04: addrLen = 16; break;           // IPv6
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

    /**
     * 通过上游 HTTP 代理建立连接
     * 将 SOCKS5 的目标地址转换为 HTTP CONNECT 请求发送给 Clash Verge
     */
    function connectUpstream() {
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

        // SOCKS5 成功响应
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));

        const rest = hBuf.slice(i + 4);
        if (rest.length > 0) socket.write(rest);

        // 切换为双向透传模式
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