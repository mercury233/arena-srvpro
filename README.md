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

## 运行

需要 Node.js 18 或更高版本、项目依赖，以及 server 分支构建的 YGOPro。房间进程应位于 `ygopro/ygopro`；Windows 下使用对应的 `ygopro.exe`。

```sh
npm ci
npm start
```

服务会读取 `data/default_config.json`，再合并用户配置的 `config/config.json`。首次启动会自动创建 `config/` 并写出合并后的配置。此配置不保证兼容原版或旧版专用部署。

管理账号保存在 `config/admin_user.json`。最小配置示例：

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

默认端口：

- `7911`：YGOPro 客户端连接端口。
- `7922`：HTTP 管理端口。

Arena 当前使用以下管理接口：

- `GET /api/getroomscount`
- `GET /api/getrooms`
- `GET /api/getscores`
- `GET /api/message?kick=房间密码`
- `GET /api/message?reboot=任务标识`

这些请求通过 `username` 和 `pass` 查询参数认证。HTTP 响应同时通过响应头或 JSON 字段返回 `serverInstanceId`。

## Docker

`Dockerfile` 和 `Dockerfile.lite` 都会构建 YGOPro 并直接使用 `node index.js` 启动服务，不再依赖 PM2、Redis 或已删除的竞赛模式启动配置。部署时应持久化 `/ygopro-server/config`；按需持久化 `replays` 和 YGOPro 扩展卡数据。

## 测试

```sh
npm test
```

测试不会启动真实对局进程，主要覆盖协议流、房间注册表、房名规则、比分、认证和 HTTP 管理接口。

## License

本项目依据 GNU Affero General Public License v3.0 或更高版本发布，详见 [LICENSE](LICENSE)。
