# LAN Proxy Forwarder

局域网二级代理转发工具，让 iPad、手机等设备通过电脑上的 Clash Verge 访问外网。

```
设备 (iPad/手机) --> 本工具 (0.0.0.0:8080) --> Clash Verge (127.0.0.1:7897) --> 外网
```

## 功能

- **HTTP 代理** — 转发普通 HTTP 请求
- **HTTPS 隧道** — 通过 CONNECT 方法建立透明隧道，不解密不修改数据
- **SOCKS5 代理** — 将 SOCKS5 请求转换为 HTTP CONNECT 转发到上游（Telegram 等应用需要）
- **局域网安全** — 默认仅允许私有 IP 访问，自动过滤 VMware 等虚拟网卡

## 快速开始

### 直接运行（需要 Node.js）

```bash
# 仅 HTTP 代理
npm start

# 同时开启 SOCKS5
npm run start:socks5

# 自定义参数
node src/main.js --listen 0.0.0.0:9090 --upstream 127.0.0.1:7897
```

### 编译为可执行文件

需要 Node.js 20+。

```bash
npm run build
```

编译完成后生成 `lan-proxy.exe`（约 87MB），可在任何 Windows 电脑上直接运行，无需安装 Node.js。

```bash
lan-proxy.exe
lan-proxy.exe --socks5 0.0.0.0:8081
```

## 设备配置

启动后程序会自动显示本机 IP 和端口：

```
  设备代理设置:
    HTTP:   192.168.0.103:8080
    SOCKS5: 192.168.0.103:8081
```

### iOS / iPadOS

**WiFi 代理（Safari、App Store 等大部分应用）：**

```
设置 → WiFi → 点击已连接的网络 → 配置代理 → 手动
  服务器: 192.168.0.103
  端口:   8080
```

**Telegram（需要单独配置）：**

```
Telegram → 设置 → 数据和存储 → 代理 → 添加代理
  类型:   SOCKS5
  服务器: 192.168.0.103
  端口:   8081
```

### Android

```
设置 → WiFi → 长按已连接的网络 → 修改网络 → 高级选项 → 代理 → 手动
  主机名: 192.168.0.103
  端口:   8080
```

## 命令行参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--listen` | `0.0.0.0:8080` | HTTP 代理监听地址 |
| `--upstream` | `127.0.0.1:7897` | 上游代理地址 (Clash Verge) |
| `--socks5` | 禁用 | SOCKS5 监听地址 |
| `--config` | - | 从 JSON 文件读取配置 |
| `--no-lan-only` | - | 允许非局域网访问 |
| `-v` | - | 详细日志 |
| `-h` | - | 显示帮助 |

### 配置文件示例

创建 `config.json`：

```json
{
  "listen": "0.0.0.0:8080",
  "upstream": "127.0.0.1:7897",
  "socks5": "0.0.0.0:8081",
  "lanOnly": true,
  "verbose": false
}
```

```bash
lan-proxy.exe --config config.json
```

## 防火墙

首次运行时 Windows 可能弹出防火墙提示，需要**允许访问**，否则其他设备无法连接。

也可以手动添加规则：

```powershell
netsh advfirewall firewall add rule name="LAN Proxy" dir=in action=allow protocol=TCP localport=8080
netsh advfirewall firewall add rule name="LAN Proxy SOCKS5" dir=in action=allow protocol=TCP localport=8081
```

## 故障排查

| 问题 | 解决方案 |
|------|----------|
| 端口被占用 | 换一个端口：`--listen 0.0.0.0:9090` |
| 设备连不上 | 检查防火墙是否放行，确认电脑和设备在同一 WiFi |
| Telegram 不走代理 | Telegram 不使用系统代理，需在 App 内单独配置 SOCKS5 |
| 网页打不开 | 确认 Clash Verge 正在运行且端口正确 |
| 显示 VMware 的 IP | 已自动过滤，如仍显示请提 issue |

## 项目结构

```
├── src/
│   ├── main.js           # 主入口，启动服务
│   ├── config.js         # 命令行参数解析和配置
│   ├── utils.js          # 工具函数（日志、IP判断、地址解析）
│   ├── http-proxy.js     # HTTP/HTTPS 代理服务器
│   └── socks5-proxy.js   # SOCKS5 代理服务器
├── scripts/
│   └── build.js          # 编译脚本（生成 exe）
├── sea-config.json       # Node.js SEA 编译配置
├── package.json
├── .gitignore
└── README.md
```

## 技术原理

- **HTTP 转发**：将客户端请求原样转发到上游 HTTP 代理
- **HTTPS 隧道**：收到 CONNECT 请求后，向上游代理发起 CONNECT，建立双向 pipe 透传加密数据
- **SOCKS5**：解析 SOCKS5 协议握手，将目标地址转换为 HTTP CONNECT 请求发送给上游
- **安全**：默认仅允许 RFC 1918 私有地址段（10.x、172.16-31.x、192.168.x）访问

## License

MIT