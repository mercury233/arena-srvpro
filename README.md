# Arena SRVPro

本项目是供 `windbot-arena` 使用的专用 SRVPro。它不再兼容原版 SRVPro 的完整配置、附加模块或部署方式，但保留基于密码创建 YGOPro 房间的基础能力。

## 房间行为

- 玩家输入完全相同的非空密码时进入同一个房间；密码不同的玩家不会被自动匹配到一起。
- `S#...`、`M#...`、`T#...` 分别创建 Single、Match、Tag 房间。
- 现有的自定义规则前缀继续生效，可通过房名设置卡池、LP、时间、初始手牌等参数。
- Arena 为每组 Bot 生成唯一的 `M#...` 密码，并通过累计排行统计结果。

旧版曾支持把空密码或特定模式密码解释为随机对战请求，并为玩家寻找其他房间。该随机匹配功能已经删除；当前密码只表示一个确定的房间名。

## 专用能力

- Linux 和 Windows 运行。
- 创建和管理 YGOPro 房间，支持 Single、Match 与 Tag。
- 查询活动房间及轻量房间计数。
- 查询约战累计排行。
- 通过管理接口关闭房间或重启服务。
- 为 Arena 返回稳定的 `serverInstanceId`，便于识别任务运行期间发生的服务重启。

原版的随机对战、内置 WindBot、竞赛模式、更新工具、牌组日志和其他无关模块不在本项目支持范围内。WindBot 进程由 WindBot Arena 单独管理。

## 部署

服务需要 Node.js 18 或更高版本和 `server` 分支的 YGOPro。SRVPro 每创建一个房间都会启动一个 `ygopro` 进程。

默认监听端口：

- `7911/tcp`：YGOPro 客户端和 WindBot 连接端口。
- `7922/tcp`：Arena 使用的 HTTP 管理端口。

`7922` 包含关房和重启等管理能力，建议只向 WindBot Arena 所在主机或内网开放，不要直接暴露到公网。

### 路径一：Docker

该路径适合 Linux 服务器和 NAS。`Dockerfile` 会在构建镜像时拉取并编译 YGOPro `server` 分支，因此构建机需要能够访问 GitHub。容器使用 PM2 运行 SRVPro，Arena 调用重启接口后进程会自动拉起。暂不支持 ARM 等非 x86_64 架构。

1. 在项目根目录构建镜像：

   ```sh
   docker build -t arena-srvpro:local .
   ```

2. 在项目目录之外准备持久化目录，并在 `config` 目录中创建 `admin_user.json`：

   ```sh
   sudo mkdir -p /opt/arena-srvpro/config /opt/arena-srvpro/replays
   sudo editor /opt/arena-srvpro/config/admin_user.json
   ```

   将密码和运行数据放在 Docker 构建上下文之外，可避免把管理密码意外写入镜像。`admin_user.json` 的格式见下文“共通配置”。

3. 启动容器：

   ```sh
   docker run -d \
     --name arena-srvpro \
     --restart unless-stopped \
     -p 7911:7911/tcp \
     -p 7922:7922/tcp \
     --mount type=bind,source=/opt/arena-srvpro/config,target=/srvpro/config \
     --mount type=bind,source=/opt/arena-srvpro/replays,target=/srvpro/replays \
     arena-srvpro:local
   ```

   如果 Arena 与 SRVPro 位于同一 Docker 网络，可以不向主机发布 `7922`，而是让 Arena 通过容器名和容器端口 `7922` 访问。

4. 查看运行状态：

   ```sh
   docker ps --filter name=arena-srvpro
   docker logs -f arena-srvpro
   ```

升级时重新构建镜像并重建容器即可；`config` 和 `replays` 在宿主机上持久化，不会随容器删除。

### 路径二：Windows 手动部署

1. 安装 Node.js 18 或更高版本，然后安装项目的生产依赖和 PM2：

   ```powershell
   npm.cmd ci --omit=dev
   npm.cmd install --global pm2
   ```

2. 从 [YGOPro `server-latest` 发布页](https://github.com/mycard/ygopro/releases/tag/server-latest) 取得 Windows x64 的 `ygopro.exe`，并从对应的 `server` 分支源码准备运行资源。最小目录结构如下：

   ```text
   arena-srvpro/
   ├─ config/
   │  └─ admin_user.json
   ├─ pm2.logs/
   ├─ replays/
   ├─ ygopro/
   │  ├─ ygopro.exe
   │  ├─ cards.cdb
   │  ├─ lflist.conf
   │  └─ script/
   ├─ index.js
   └─ package.json
   ```

   `ygopro.exe`、卡片数据库（`cards.cdb`）和脚本（`script` 目录）应来自同一版本。可选复制同版本的 `gframe/config.h` 到 `ygopro/gframe/config.h`，让 SRVPro 自动读取其中的 `PRO_VERSION`；不提供该文件时，需要手动将 `config/config.json` 中的 `version` 设为 YGOPro 使用的协议版本。

3. 创建 `config/admin_user.json` 和 `pm2.logs/` 目录，然后在项目根目录通过项目提供的 `pm2.json` 启动服务：

   ```powershell
   New-Item -ItemType Directory -Force pm2.logs
   pm2 start pm2.json
   ```

   `pm2.json` 已配置 `autorestart`，因此 Arena 的重启接口让 Node.js 进程退出后，PM2 会自动将其拉起。可使用 `pm2.cmd logs arena-srvpro` 查看日志。

   PM2 在 Windows 下不会仅因执行 `pm2 start` 就随系统开机自动启动。用于长期部署的方法此处不赘述，可参考 PM2 文档。

4. 在 Windows 防火墙中允许 `7911/tcp`，并仅允许 Arena 主机访问 `7922/tcp`。

### 共通配置

服务会读取 `data/default_config.json`，再合并用户配置 `config/config.json`。首次启动会自动创建缺失的 `config/config.json` 并写出完整配置；修改端口或房间参数后需要重启服务。此配置不保证兼容原版或旧版专用部署。

管理账号保存在 `config/admin_user.json`。部署前应创建至少一个已启用账号，并使用独立的强密码：

```json
{
  "users": {
    "arena": {
      "password": "Arena 中设置的管理密码",
      "enabled": true
    }
  }
}
```

然后在 WindBot Arena 的 SRVPro 配置中填入该服务地址、HTTP 端口、用户名和密码。管理账号配置只在启动时读取，修改后需要重启 SRVPro。

Arena 当前使用以下管理接口：

- `GET /api/getroomscount`
- `GET /api/getrooms`
- `GET /api/getscores`
- `GET /api/halfwaywatch?enabled=true|false`
- `GET /api/message?kick=房间密码`
- `GET /api/message?reboot=任务标识`

这些请求通过 `username` 和 `pass` 查询参数认证。HTTP 响应同时通过响应头或 JSON 字段返回 `serverInstanceId`。

## 测试

```sh
npm test
```

测试不会启动真实对局进程，主要覆盖协议流、房间注册表、房名规则、比分、认证和 HTTP 管理接口。

## License

本项目依据 GNU Affero General Public License v3.0 或更高版本发布，详见 [LICENSE](LICENSE)。
