# 桌游合集 board-game

自己写的联机桌游合集,每个游戏一个子目录,各自独立部署到 wawazhiliao.com 的子域名下。
技术栈:纯前端(SVG)+ Cloudflare Workers + Durable Objects(WebSocket 房间制联机)。

| 游戏 | 目录 | 地址 | 状态 |
| ---- | ---- | ---- | ---- |
| 仄梦的岛屿开拓 | [dao/](dao/) | https://dao.wawazhiliao.com | 开发中 |

## 本地开发

各游戏目录内:

```bash
npm install
npx wrangler dev
```

部署:

```bash
npx wrangler deploy
```
