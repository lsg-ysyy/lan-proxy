'use strict';

/** 默认配置 */
const DEFAULTS = {
  listen: '0.0.0.0:8080',
  upstream: '127.0.0.1:7897',
  socks5: '',
  lanOnly: true,
  verbose: false,
};

/**
 * 解析命令行参数，合并默认配置
 * 支持格式：--key value 或 --flag
 */
function parseArgs() {
  const fs = require('fs');
  const path = require('path');
  const args = process.argv.slice(2);
  const config = { ...DEFAULTS };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--listen': config.listen = args[++i]; break;
      case '--upstream': config.upstream = args[++i]; break;
      case '--socks5': config.socks5 = args[++i]; break;
      case '--no-lan-only': config.lanOnly = false; break;
      case '-v': case '--verbose': config.verbose = true; break;
      case '--config': {
        const file = path.resolve(args[++i]);
        Object.assign(config, JSON.parse(fs.readFileSync(file, 'utf8')));
        break;
      }
      case '-h': case '--help':
        showHelp(); process.exit(0);
      case '--version':
        console.log('lan-proxy v1.0.0'); process.exit(0);
      default:
        console.error(`Unknown option: ${args[i]}`);
        showHelp(); process.exit(1);
    }
  }
  return config;
}

/** 显示帮助信息 */
function showHelp() {
  console.log(`
LAN Proxy Forwarder - 二级代理转发工具

Usage: lan-proxy [options]

Options:
  --listen <host:port>    HTTP代理监听地址 (default: 0.0.0.0:8080)
  --upstream <host:port>  上游代理地址 (default: 127.0.0.1:7897)
  --socks5 <host:port>    SOCKS5监听地址 (default: 禁用)
  --config <file>         从JSON文件读取配置
  --no-lan-only           允许非局域网访问
  -v, --verbose           详细日志
  -h, --help              显示帮助
  --version               显示版本

Example:
  node src/main.js --listen 0.0.0.0:8080 --upstream 127.0.0.1:7897 --socks5 0.0.0.0:8081
`);
}

module.exports = { DEFAULTS, parseArgs };