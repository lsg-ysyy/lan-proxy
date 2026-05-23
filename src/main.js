#!/usr/bin/env node
'use strict';

/**
 * LAN Proxy Forwarder - 二级代理转发工具
 *
 * 功能：在 Windows 电脑上搭建代理转发服务，让局域网内的 iPad、手机等设备
 *       通过本机 Clash Verge 访问外网。
 *
 * 原理：
 *   设备 (iPad/手机) --> 本工具 (监听 0.0.0.0:8080) --> Clash Verge (127.0.0.1:7897) --> 外网
 */

const { parseArgs } = require('./config');
const { log, getLocalIPs, parseAddr, activeConns } = require('./utils');
const { createHTTPProxy } = require('./http-proxy');
const { createSOCKS5Server } = require('./socks5-proxy');

function main() {
  const config = parseArgs();
  const [host, port] = parseAddr(config.listen);

  // 显示启动信息
  console.log('');
  console.log('  ┌──────────────────────────────────────────┐');
  console.log('  │   LAN Proxy Forwarder (二级代理转发)      │');
  console.log('  └──────────────────────────────────────────┘');
  console.log(`  HTTP代理:    ${config.listen}`);
  if (config.socks5) console.log(`  SOCKS5代理:  ${config.socks5}`);
  console.log(`  上游代理:    ${config.upstream}`);
  console.log(`  局域网限制:  ${config.lanOnly ? '开启' : '关闭'}`);
  console.log('');
  console.log('  设备代理设置:');

  const localIPs = getLocalIPs();
  for (const ip of localIPs) {
    console.log(`    HTTP:   ${ip}:${port}`);
    if (config.socks5) {
      const [, sPort] = parseAddr(config.socks5);
      console.log(`    SOCKS5: ${ip}:${sPort}`);
    }
  }
  console.log('');

  // 启动 HTTP 代理服务器
  const httpServer = createHTTPProxy(config);

  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log('FATAL', `端口 ${port} 已被占用`);
    } else {
      log('FATAL', err.message);
    }
    process.exit(1);
  });

  httpServer.listen(port, host, () => {
    log('INFO', `HTTP proxy listening on ${config.listen}`);
  });

  // 如果配置了 SOCKS5，启动 SOCKS5 代理服务器
  if (config.socks5) {
    const [sHost, sPort] = parseAddr(config.socks5);
    const socksServer = createSOCKS5Server(config);

    socksServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        log('FATAL', `SOCKS5端口 ${sPort} 已被占用`);
      } else {
        log('FATAL', err.message);
      }
      process.exit(1);
    });

    socksServer.listen(sPort, sHost, () => {
      log('INFO', `SOCKS5 proxy listening on ${config.socks5}`);
    });
  }

  // 优雅关闭
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('INFO', '正在关闭...');
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  process.on('uncaughtException', (err) => {
    log('FATAL', `Uncaught: ${err.message}`);
  });

  process.on('unhandledRejection', (err) => {
    log('FATAL', `Unhandled rejection: ${err}`);
  });
}

main();