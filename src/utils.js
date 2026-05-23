'use strict';

const net = require('net');

// 共享连接计数器，所有模块通过引用访问同一个对象
const activeConns = { value: 0 };
const totalConns = { value: 0 };

// 上游代理在线状态
const upstreamOnline = { value: true };

/** 带时间戳的日志输出 */
function log(tag, msg) {
  const ts = new Date().toLocaleString('zh-CN', { hour12: false });
  console.log(`[${ts}] [${tag}] ${msg}`);
}

/**
 * 上游代理健康检查
 * 每 10 秒 TCP 连接上游端口，成功则 online，失败则 offline
 * 状态变化时打印日志
 */
function startUpstreamCheck(host, port) {
  const check = () => {
    const socket = net.connect(port, host);
    socket.setTimeout(3000);
    socket.on('connect', () => {
      socket.destroy();
      if (!upstreamOnline.value) {
        upstreamOnline.value = true;
        log('FALLBACK', `上游已恢复 (${host}:${port})，切换为代理模式`);
      }
    });
    socket.on('error', () => {
      if (upstreamOnline.value) {
        upstreamOnline.value = false;
        log('FALLBACK', `上游不可用 (${host}:${port})，切换为直连模式`);
      }
    });
    socket.on('timeout', () => {
      socket.destroy();
      if (upstreamOnline.value) {
        upstreamOnline.value = false;
        log('FALLBACK', `上游超时 (${host}:${port})，切换为直连模式`);
      }
    });
  };

  // 首次检查
  check();
  // 定期检查
  setInterval(check, 10000);
}

/** 将字节数格式化为人类可读字符串 */
function formatBytes(n) {
  if (n < 1024) return n + 'B';
  if (n < 1048576) return (n / 1024).toFixed(1) + 'KB';
  return (n / 1048576).toFixed(1) + 'MB';
}

/**
 * 从 socket 中提取客户端 IPv4 地址
 * Node.js 在 Windows 上可能返回 IPv4-mapped IPv6 格式 (::ffff:x.x.x.x)，
 * 需要去掉前缀
 */
function getClientIP(socket) {
  return (socket.remoteAddress || '').replace(/^::ffff:/, '');
}

/**
 * 判断 IP 是否属于私有/局域网地址
 * 覆盖 RFC 1918 定义的私有地址段：
 *   - 10.0.0.0/8
 *   - 172.16.0.0/12
 *   - 192.168.0.0/16
 * 以及链路本地 169.254.0.0/16 和回环 127.0.0.0/8
 */
function isPrivateIP(ipStr) {
  const m = ipStr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m) ipStr = m[1];
  if (ipStr === '127.0.0.1' || ipStr === '::1') return true;
  const p = ipStr.split('.').map(Number);
  if (p.length !== 4 || p.some(isNaN)) return false;
  if (p[0] === 10) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 169 && p[1] === 254) return true;
  if (p[0] === 127) return true;
  return false;
}

/** 虚拟网卡关键词，这些网卡的 IP 设备无法访问 */
const VIRTUAL_IFACE = /vmware|virtualbox|hyper-v|vethernet|wsl|loopback|bluetooth|docker|vEthernet/i;

/** 获取本机物理网卡的 IPv4 地址，用于显示给用户配置设备代理 */
function getLocalIPs() {
  const os = require('os');
  const result = [];
  const ifaces = os.networkInterfaces();
  for (const name in ifaces) {
    if (VIRTUAL_IFACE.test(name)) continue;
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        result.push(iface.address);
      }
    }
  }
  return result;
}

/**
 * 解析 "host:port" 格式的地址字符串
 * 使用 lastIndexOf(':') 以支持 IPv6 地址（虽然本项目主要面向 IPv4）
 */
function parseAddr(addr) {
  const i = addr.lastIndexOf(':');
  return [addr.slice(0, i), parseInt(addr.slice(i + 1))];
}

module.exports = {
  log, formatBytes, getClientIP, isPrivateIP, getLocalIPs, parseAddr,
  startUpstreamCheck, upstreamOnline,
  activeConns, totalConns,
};