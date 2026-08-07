# 余一 · 美术素材计划

状态:**20 张素材已全部生成、质检并接入界面**(2026-08-07)。剩余未做:动画。

## 怎么出的

不走 `kling_ai` MCP(非交互会话跑不了 OAuth),改走**可灵官方 CLI**:

```bash
npx skills add klingai-tech/skills          # 装 skill(说明书,不干活)
npm i -g @klingai/cli-global                # 海外站包;国内站是 @klingai/cli-cn
kling login                                 # 浏览器 OAuth,凭据写 ~/.kling/.credentials
```

用的是**会员灵感值**(不是 kling.ai/dev 开放平台的 AK/SK 按量计费)。
模型 `kling-image-v3_0`,单张 1 灵感值,20~60 秒出图。含返工全程约 40 点。

生成脚本见提交说明;单条命令形如:

```bash
kling text_to_image --model kling-image-v3_0 --img_resolution 2k --aspectRatio 3:4 \
  --poll 150 --quiet --skill-name kling-cli --skill-version 0.1.3 '<prompt>'
```

## 踩过的坑(改词经验,后续补素材直接抄)

1. **「playing card」会被理解成「一张牌摆在桌上」**,四周留纸边。必须写
   `filling the ENTIRE image edge to edge, full bleed, no outer margin, no table, no shadow,
   flat texture NOT a photograph of an object`。
2. **百分比不听话**。让它画「占 55% 的椭圆」,回回给你画成占 80% 的开光。
   → **凡是尺寸/位置要精确的元素都别让 AI 画**:牌面中心的米白椭圆改由 CSS 画
   (`.ucard::after`),五色完全一致、数字永远居中;印章里的「余一」二字同理,用真字体叠。
3. **「Chinese paper-cut」会诱导它往画面里塞汉字**(福/囍那类)。硬否定词:
   `STRICTLY NO Chinese characters, no hanzi, no calligraphy, no seal script`。
4. **说了 no shadow 它照样加地面投影**,灰色阴影躲过抠白。要写死
   `ABSOLUTELY NO SHADOW — no drop shadow, no ground shadow, no grey patch anywhere`。
5. **不出透明底**。让它出**纯白底**再抠(实测背景 min≥245、饱和度≤7)。
6. **颜色会发灰**。要浓就明写 `RICH SATURATED ... definitely not pale, not grey, not washed out`。

## 后处理

原图 20 张共 81MB,`yuyi/art-src/`(已 gitignore,只在本机)。仓库里的
`public/img/` 是网页版,共 **2.1MB**:

- 不透明的转 JPEG(`sips -s format jpeg`):牌背/牌面 482×640、头像 200²、桌布 1024²、封面 1200×677
- 透明的走 **漫水填充抠白**(脚本思路:从四边 BFS,只清除与画面边缘连通的近白像素,
  主体内部的白——锦鲤高光、空白牌面、兔毛——一律保留,边界按亮度做软过渡防白边)

## 接入方式

几乎纯 CSS:`.c-r/.c-y/.c-g/.c-b/.c-w` 和 `.ucard.back` 换 `background-image`,
`body` 铺 `table.jpg`,`#btn-uno` 用 `seal-yuyi.png`。
JS 只加了两处:`cardHtml()` 给卡片多挂一个值类 `v-<v>`(让 CSS 能按牌型换图标),
`renderPlayers()` 按座位号挂 `avatar-N.jpg`。

## 动画与音效(已完成)

全部由「新旧 state 对比」驱动,不解析服务端日志文本(太脆)。判定方式:

| 特效 | 怎么判定的 |
| --- | --- |
| 出牌飞落旋转 | 弃牌堆变了;飞行起点取**上一帧** `turn.seat` 的座位位置 |
| 发牌扇入 / 摸牌翻面 | 自己手牌数变化(整局重发 vs +1) |
| 挨罚 `+N` 飘字 + 座位红闪 | 哪个座位 `handCount` 一次涨 ≥2(覆盖 +2/+4/被抓) |
| 被禁止(禁止符砸座位) | 出的是禁止牌 → 打牌人下家;2 人局反转等同禁止 |
| 掉头(双鲤转一圈) | `G.dir` 变了 |
| 轮到我(金光脉冲+横幅弹+震动) | `myTurn()` 由 false 转 true |
| 牌堆招手 | 轮到我且手里**一张都打不出** |
| 喊余一(印章砸落) | 有座位 `handCount` 变成 1 |
| 换色涟漪 | 颜色变了**且**弃牌堆顶是万能牌(普通牌换花色也会改颜色,不能算) |

音效同样九种,全 Web Audio 现场合成(见 `public/js/sfx.js`),右上角可静音。
全部动画包在 `prefers-reduced-motion` 里可关。

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

## 备选(已启用)

可灵连不上 → 见 [ART_PROMPTS.md](ART_PROMPTS.md):20 条已拼好前缀的成品 prompt、负向词、
比例与透明底要求、交付方式。素材落到 `public/img/`(目录已建),先给 1~6 号即可开始接入。
