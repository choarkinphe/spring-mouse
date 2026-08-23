# Spring Mouse CLI

`spring-mouse` 是 Spring Mouse 的启动与桌面托盘入口。它会启动网关、准备运行时 SQLite 依赖，并可在支持的平台启用系统托盘。

> 生产服务器建议使用仓库根目录的 Docker / systemd 部署方式；CLI 更适合桌面或单机使用。

## 安装

在发布到 npm 的环境中：

```bash
npm install -g spring-mouse
```

从源码打包：

```bash
npm --prefix cli run pack:cli
```

## 启动

```bash
# 默认启动：8008，绑定 0.0.0.0
spring-mouse

# 仅本机访问
spring-mouse --host 127.0.0.1

# 使用其他端口
spring-mouse --port 8010

# 不自动打开浏览器
spring-mouse --no-browser

# 前台显示服务日志
spring-mouse --log

# 托盘后台模式
spring-mouse --tray
```

启动后默认访问：

```text
Dashboard: http://localhost:8008/dashboard
API:       http://localhost:8008/v1
```

如果绑定 `0.0.0.0`，CLI 会显示当前局域网地址提示。对外网暴露前，请先配置 API Key、HTTPS 与可信反向代理。

## 参数

| 参数 | 说明 |
|---|---|
| `-p, --port <port>` | 网关监听端口，默认 `8008`。 |
| `-H, --host <host>` | 监听地址，默认 `0.0.0.0`。 |
| `-n, --no-browser` | 不自动打开 Dashboard。 |
| `-l, --log` | 在当前终端输出服务日志。 |
| `-t, --tray` | 使用系统托盘后台运行。 |
| `--skip-update` | 跳过启动时的更新检查。 |
| `-v, --version` | 输出 CLI 版本。 |
| `-h, --help` | 输出帮助信息。 |

## 视频生成子命令

已运行网关且已配置可用 xAI 通道时，可使用：

```bash
spring-mouse xai video \
  --prompt "A mouse running through a neon terminal" \
  --output mouse.mp4
```

执行 `spring-mouse xai video --help` 查看完整参数。该命令通过正在运行的 Spring Mouse 网关创建、查询和下载视频任务。

## 数据与运行时目录

CLI 使用以下目录保存运行时依赖、托盘文件和应用数据：

| 系统 | 目录 |
|---|---|
| macOS / Linux | `~/.spring-mouse` |
| Windows | `%APPDATA%/spring-mouse` |

全局安装时，CLI 会尽力准备 SQLite 运行时依赖；失败时应用仍可通过 `sql.js` 回退启动。详情见主项目 [README.md](../README.md) 与 [DEPLOY.md](../DEPLOY.md)。
