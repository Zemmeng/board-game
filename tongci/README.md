# 同词相遇

两个人各写一个词,一轮轮往中间靠,直到写出同一个词。

线上地址:**https://tongci.wawazhiliao.com**

## 玩法

- 第 1 轮:两人各写任意一个词,都交了才同时揭晓。
- 之后每轮:看上一轮的两个词,各写一个能连接它们的词,再同时揭晓。
- 两人写出同一个词即相遇(忽略空格、标点、符号、大小写,全角半角也算一样),显示「第 N 轮相遇」和整局记录。
- 这局出现过的词不能再用;交了、还没揭晓前可以撤回修改。

两种模式:

- **联机**:首页填昵称 →「创建房间」得到 4 位房间号,把 `/r/房间号` 链接发给对方,对方打开填个昵称就进来了。每房最多 2 人,第 3 人会看到「房间已满」。
- **一部手机轮流**(`/solo`,纯前端):甲写完屏幕遮住,交给乙写,两人都写完才揭晓;每轮由手里拿着手机的人先写。

## 设计要点

- **防偷看**:揭晓前对方的词只存在 Durable Object 里,下发给客户端的只有自己的词和对方「已写好」与否,看 Network 也看不到。`test/e2e.mjs` 逐条检查对方收到的原始 WebSocket 帧。
- **断线恢复**:`playerId` 存在 localStorage(`tongci:p:<房间号>`),刷新、切后台回来会自动回到原房间和当前局,已交的词也还在。
- **手机键盘不收起**:状态更新只改文字和显隐,从不重建输入框。
- **省费用**:WebSocket Hibernation API;心跳 `ping` 由运行时自动回 `pong`,不唤醒 DO。
- **自动清理**:最后一人断开时定 30 分钟闹钟,到点还没人回来就清空房间存档。

## 本地运行

本仓库各游戏共用 `dao/` 里装好的 wrangler:

```bash
cd tongci
../dao/node_modules/.bin/wrangler dev --port 8793
```

打开 http://localhost:8793 。在同一个浏览器里测两个人时,一个窗口用 `localhost:8793`、另一个用 `127.0.0.1:8793`(不同源,localStorage 互不干扰)。

端到端测试(需先起 dev):

```bash
node test/e2e.mjs
BASE=https://tongci.wawazhiliao.com node test/e2e.mjs   # 测线上
```

## 部署

```bash
cd tongci
../dao/node_modules/.bin/wrangler deploy
```

`wrangler.jsonc` 里已绑定自定义域名 `tongci.wawazhiliao.com`(`custom_domain: true`),首次部署会自动建 DNS 记录和证书。Durable Object 用 SQLite 后端(`new_sqlite_classes`),免费套餐可用。

## 文件结构

```
tongci/
├── wrangler.jsonc      Worker 配置:静态资源、DO 绑定、自定义域名
├── package.json
├── src/
│   ├── worker.js       入口:/api/create 建房、/ws 转给房间 DO、/r/xxxx 和 /solo 返回页面
│   └── room.js         WordRoom DO:房间状态、提交/撤回/揭晓/再来一局、广播、闲置清理
├── public/
│   └── index.html      前端(原生 HTML/CSS/JS,单文件):首页、联机房间、一部手机轮流
└── test/
    └── e2e.mjs         两人整局 + 第三人被拒 + 刷新恢复 + 防偷看断言
```
