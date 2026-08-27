# Windows 本地运行

需要 64 位 Node.js 22：https://nodejs.org/

不要复制其他机器上的 `.dev.vars` 或 `.wrangler`，里面有密钥。

## 打包成 exe

在仓库根目录（已 `npm install`）执行：

```bat
npm run dist:win
```

完成后在 `dist-win` 里会有：

- `API for Cursor-0.1.1-win.zip`：便携版。解压后运行文件夹里的 `API for Cursor.exe`（不要用旧的 `*-portable.exe`，它会静默解压到临时目录，看起来像卡死）
- `API for Cursor-0.1.1-setup.exe`：安装版（当前用户目录，开始菜单快捷方式）
- `win-unpacked\API for Cursor.exe`：未压缩目录，开发机上可直接双击验证

首次启动会拉起本机 Vite + Worker + SDK 桥，并打开控制台窗口。本地 D1 数据写在 `%APPDATA%\api-for-cursor\`，与安装目录分开，更新 exe 后配置还在。

调试启动过程可设环境变量 `STATION_DEBUG=1`，或查看 `%APPDATA%\api-for-cursor\station.log`。

未签名时 Windows 可能弹出 SmartScreen，选「仍要运行」即可。开发调试窗口而不打包：

```bat
npm run desktop
```

## 第一次

在解压后的 `composer-api` 目录里：

```bat
npm install
npm run db:migrate:local
```

不必再准备 `.dev.vars`。加密密钥在首次请求时写入 D1，之后不会轮换。

## 每次启动

```bat
npm run dev
```

浏览器打开 http://127.0.0.1:5173

在设置页可以改 Cursor SDK 与中转服务的监听地址；访问日志在「系统 → 访问日志」。

聊天页或 Lab 里粘贴 Cursor API key（Dashboard → Integrations → API Keys）。

## 说明

- `npm run dev` 会自动拉起 SDK 桥（默认 http://127.0.0.1:8792/sdk）。
- 如果本地还有旧的 `.dev.vars`，首次启动会把其中的 `ENCRYPTION_KEY` 导入数据库，然后可以删掉该文件。
