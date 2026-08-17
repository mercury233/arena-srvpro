# Arena SRVPro

本项目是供 `windbot-arena` 使用的专用 SRVPro。它保留密码房、排行和 Arena 管理接口，不兼容原版 SRVPro 的完整配置、附加模块或部署方式。

## 功能

- 玩家输入相同的非空密码进入同一房间，不进行随机匹配。
- `S#...`、`M#...`、`T#...` 分别创建 Single、Match、Tag 房间。
- 记录每个玩家名称的胜负，统计胜率。
- 通过管理接口查询活动房间、房间计数、胜率排行、关闭房间或重启服务。
- 返回稳定的 `serverInstanceId`，供 Arena 检测任务期间的服务重启。

## 运行与部署

需要 Node.js 18 或更高版本，以及 `server` 分支的 YGOPro，放在 `ygopro/` 下。

安装依赖并直接运行：

```sh
npm ci --omit=dev
npm start
```

生产环境应使用进程管理器自动拉起服务，否则重启接口会使服务退出后不再启动。仓库提供的 `Dockerfile` 和 `pm2.json` 已包含该配置；Docker 镜像目前面向 x86_64 Linux。

默认端口：

- `7911/tcp`：YGOPro 客户端和 WindBot。
- `7922/tcp`：Arena HTTP 管理接口。

管理端口包含关房和重启能力，应只允许 Arena 主机或内网访问。

### Windows 手动部署

1. 安装 Node.js 18 或更高版本，然后安装生产依赖和 PM2：

   ```powershell
   npm.cmd ci --omit=dev
   npm.cmd install --global pm2
   ```

2. 从 [YGOPro `server-latest` 发布页](https://github.com/mycard/ygopro/releases/tag/server-latest) 获取 Windows x64 的 `ygopro.exe`，并准备卡片数据库、禁限卡表和脚本。目录结构如下：

   ```text
   arena-srvpro/
   ├─ config/
   │  ├─ config.json
   │  └─ admin_user.json
   ├─ pm2.logs/
   ├─ ygopro/
   │  ├─ ygopro.exe
   │  ├─ cards.cdb
   │  ├─ lflist.conf
   │  └─ script/
   ├─ index.js
   └─ package.json
   ```

   `ygopro.exe`、`cards.cdb` 和 `script/` 应来自兼容版本。可将 `gframe/config.h` 复制到 `ygopro/gframe/config.h`，让 SRVPro 读取其中的 `PRO_VERSION`；否则需要在 `config/config.json` 中手动设置对应的 `version`。

3. 创建管理账号和日志目录，然后通过仓库提供的 PM2 配置启动服务：

   ```powershell
   New-Item -ItemType Directory -Force pm2.logs
   pm2 start pm2.json
   pm2 logs arena-srvpro
   ```

   PM2 在 Windows 下不会仅因执行 `pm2 start` 就随系统开机启动，长期部署时还需单独配置开机启动。

4. 在 Windows 防火墙中允许 `7911/tcp`，并仅允许 Arena 主机访问 `7922/tcp`。

### 配置

服务合并 `data/default_config.json` 和 `config/config.json`，并在首次启动时写出完整的用户配置。配置结构不保证兼容原版或旧版部署。

管理账号保存在 `config/admin_user.json`：

```json
{
  "users": {
    "arena": {
      "password": "strong-password",
      "enabled": true
    }
  }
}
```

请在 Arena 中填写相同的用户名和密码。

Arena 使用以下接口：

- `GET /api/getroomscount`
- `GET /api/getrooms`
- `GET /api/getscores`
- `GET /api/halfwaywatch?enabled=true|false`
- `GET /api/message?kick=房间密码`
- `GET /api/message?reboot=任务标识`

接口通过 `username` 和 `pass` 查询参数认证，并在响应头或 JSON 中返回 `serverInstanceId`。

## 测试

```sh
npm test
```

测试不会启动真实对局进程，主要覆盖协议流、房间注册表、房名规则、比分、认证和 HTTP 管理接口。

## License

本项目依据 GNU Affero General Public License v3.0 或更高版本发布，详见 [LICENSE](LICENSE)。
