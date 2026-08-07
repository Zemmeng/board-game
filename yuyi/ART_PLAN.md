# 余一 · 美术素材计划(进行中)

状态:**素材未生成**。计划用可灵 AI(Kling)的 MCP 直接生成并由 Claude 自行质检。
可灵 MCP 已配置在用户级 `~/.claude.json`(`kling_ai` → https://kling.ai/mcp,远程 OAuth),
**需要新会话启动时完成一次 OAuth 授权**;原配置备份在 `~/.claude.json.bak-kling`。

## 流程

1. 新会话连上 kling_ai 后,先 `query_membership_and_credits` 查额度并向用户报告预计消耗
2. 按下方清单逐张生成,先做 1~6 号定风格,确认后再批量
3. 每张下载后自检:风格统一 / 透明底无白边 / 卡面中心留白 / 画面无文字数字,不合格改词重出
4. 合格素材放 `public/img/`(文件名见清单),接入界面后做动画:
   发牌扇入、出牌飞落旋转、摸牌翻面、+2/+4 冲击抖动、喊余一时朱红印章砸落、被抓罚牌手牌一颤、换色全桌涟漪

## 全局风格前缀(每条 prompt 开头)

> Chinese folk-art style game asset, ink-and-gouache texture on warm rice paper, subtle paper grain, elegant minimal composition, palette anchored on vermilion red / imperial gold / jade green / indigo blue with cream paper, no text, no letters, no numbers, no watermark, clean silhouette, original design not resembling any existing card game brand (especially NOT resembling UNO).

通用要求:透明底素材必须真透明无白边;卡牌类 3:4 竖版圆角出血;画面绝不出现文字/字母/数字(程序叠加)。

## 素材清单(20 张)

| 文件名 | 规格 | 内容 prompt(接在前缀后) |
| --- | --- | --- |
| back.png | 768×1024 | Ornate playing card back, symmetrical lattice inspired by Chinese window carvings, deep pine green base with gold linework, single abstract circular emblem in the center. |
| face-r.png | 768×1024 | Card face background in vermilion red, a large soft cream oval zone in the center left COMPLETELY EMPTY for program overlay, delicate cloud-pattern border. |
| face-y.png | 768×1024 | 同 face-r,主色 imperial gold |
| face-g.png | 768×1024 | 同 face-r,主色 jade green |
| face-b.png | 768×1024 | 同 face-r,主色 indigo blue |
| face-w.png | 768×1024 | 同 face-r,底色 charcoal black,边缘 subtle four-color aurora(red/gold/green/indigo) |
| icon-skip.png | 512×512 透明 | A "forbidden" emblem, crossed-out circle styled as a Chinese paper-cut seal, single centered bold silhouette. |
| icon-rev.png | 512×512 透明 | A cyclone swirl of two koi fish chasing each other, paper-cut style, single centered bold silhouette. |
| icon-d2.png | 512×512 透明 | Two overlapping cards flying with motion lines, paper-cut style, single centered bold silhouette. |
| icon-wild.png | 512×512 透明 | A four-color pinwheel lotus, each petal one color (red gold green indigo), single centered. |
| icon-d4.png | 512×512 透明 | A four-color pinwheel lotus with four small cards bursting outward, single centered. |
| seal-yuyi.png | 512×512 透明 | A round Chinese seal stamp imprint in vermilion ink, slightly distressed edges, containing one single vertical tile pictogram meaning "one card left". |
| table.png | 1024×1024 无缝 | Seamless tileable dark felt table texture with extremely subtle Chinese cloud pattern, deep pine green, very low contrast. |
| avatar-1..6.png | 各 256×256 透明 | Cute round animal portrait medallion, head and shoulders in circular frame, warm and friendly:红冠鹤 / 锦鸡 / 玉兔 / 青锦鲤 / 熊猫 / 虎崽 |
| cover.png | 1200×675 | Festive horizontal illustration, four hands throwing colorful cards across a table, cards trailing red gold green indigo ribbons, dynamic diagonal composition, joyful energy. |

## 备选

可灵连不上时:把「全局风格前缀 + 清单」整段交给用户,由用户用 GPT 生成后发回,Claude 负责质检与接入。
