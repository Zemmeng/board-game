# 长安坊市 · 美术素材计划

状态:**15 张素材已全部生成、质检并接入**(2026-08-07)。剩余未做:动画、音效。

先读 [`../yuyi/ART_PLAN.md`](../yuyi/ART_PLAN.md) —— 可灵 CLI 怎么装怎么登录、
「playing card 会被画成桌上摆着一张牌」那类通用坑,都记在那边,这里只写本作新踩到的。

## 怎么出的

可灵官方 CLI,模型 `kling-image-v3_0`,单张 1 灵感值,20~60 秒出图。
本批 14 张新素材、15 次提交(只有 `icon-edict` 返工一次),共 15 点。

```bash
kling text_to_image --model kling-image-v3_0 --img_resolution 2k \
  --aspectRatio 1:1 --poll 240 --quiet \
  --skill-name kling-cli --skill-version 0.1.3 '<prompt>'
```

**务必取 `works[].urlWithoutWatermark`,不要取 `works[].url`** ——
后者右下角带 KlingAI 角标,进不了仓库。同一个 generationId 两个链接都给,
发现拿错了直接重下即可,不用重新出图、不再扣费。

响应里 URL 的实际位置是 `body.generations[0].result.works[0].url`,别照着文档猜层级。

## 本作新踩的坑

1. **让图标「表面留白」= 它给你画一个相框。**
   第一版 `icon-edict` 写的是「展开的卷轴,卷面 COMPLETELY BLANK」,
   出来是一个四边彩色、中间全白的方框 —— 抠完白就是个空框。
   → 图标一律要求**实心**:`ONE COMPACT SOLID SHAPE`、
   `NOT a hollow outline, NOT a frame`、`every enclosed area must be filled with solid color`,
   并且**图标 prompt 里绝不出现 blank / empty**。诏令改成「卷起来的卷轴」,一次过。
   (卡面反过来,那块留白是要的,`COMPLETELY BLANK` 照写不误。)

2. **抠白的阈值别按色距做渐变。**
   最早按「离底色多远」线性给 alpha(20~60 过渡),结果纸面上的麻点色距普遍落在
   这个区间里,整块背景只被抠掉一半,图标像贴在一块淡色方块上
   (实测 icon-tax 有 46% 的像素是半透明)。
   → 改成**硬掩膜 + 1.6px 高斯羽化**:与边缘连通的一律 alpha=0,只在主体边界留抗锯齿。

3. **BFS 的连通阈值要给够。**
   阈值取 60 时,纸面上色距 >60 的脏点变成一堆「够不着」的孤岛,留在背景里,
   缩图后糊成一层雾。取 **120** 才吃得干净;而主体最浅的赭石、淡青色距都在 200 以上,
   绝穿不透。透明区的 RGB 保留原来的米色,缩图时渗进边缘的正好也是米色,
   地格底色本来就米色,看不出白边。

4. **夯土/纸纹这类底纹,AI 给的对比度一律偏高。**
   `felt2` 原图是很漂亮的夯土层理,直接铺上去像灯芯绒。
   压到 `Contrast 0.34 / Brightness 0.62 / Color 0.75` 才够「只留个意思」。
   出图时写 `extremely subtle, very low contrast` 没用,还是得后期压。

5. **卡面外面 AI 会自己留一圈白边**(诏令那张左右各约 4%),
   不裁掉,亮出来就像镶了道白框。按「近白」逐边扫描裁掉,
   再**把两张卡统一压成 600×800** —— 卡面正文的位置在 CSS 里是按百分比写的,
   两张长宽比不一致那套 inset 就同时套不准。

## 后处理

原图 15 张共 108MB 在 `art-src/`(已 gitignore,只在本机)。
仓库里 `public/img/` 15 个文件共 **1.3MB**。脚本思路见上,关键参数:

| 类别 | 处理 |
| --- | --- |
| 图标 5 张 | 漫水抠白(阈值 120 + 羽化 1.6px)→ 裁到主体 → 四周留 4% → 256² PNG |
| 角落 4 张 | 440² JPEG q82 |
| 卡面 2 张 | 裁白边 → 统一 600×800 JPEG q84 |
| 封面 | 1200×675 JPEG q82 |
| 底纹 2 张 | paper 420² q82;felt2 压对比后 1100² q62 |

## 接入方式

几乎纯 CSS。JS 只动了一处:`buildBoard()` 给格子多挂一个 `k-<type>` 类
(`k-go` / `k-jail` / `k-gate` / `k-edict` …),CSS 才能按格子类型贴图。

- **四角**:`.cell.corner::before` 铺画,`::after` 压一圈**中间浓、往外化开**的米色蒙版托住字。
  蒙版千万别铺太匀 —— 第一版 0.88/0.72/0.34 直接把画盖成了一片淡彩。
- **特殊格**:`.cell.special::before` 把图标当水印压在坊名与价钱之间(`center 56% / 46%`)。
- **地格**:`paper.jpg` 上压一层 82% 的米色,纹理只留个意思。
- **首页**:`cover.jpg` 铺满 + 压暗,同时用作 `og:image`。

⚠️ `::after` 在 DOM 顺序上排在所有子元素之后,不显式压层就会盖住格子里的字。
`.cell > * { z-index: 1 }` 是必须的。

⚠️ `.cell.corner .nm` 的权重(0,3,0)高于媒体查询里的 `.cell .nm`(0,2,0),
**手机上的角格字号必须单独再写一遍**,否则 33px 的格子里还顶着桌面的 11px。
角格可用宽度桌面约 48px / 手机约 29px,字号是量出来的,别拍脑袋:
桌面 11px(「京兆府大牢」五个字单独给 9.5px),手机 8.5px 且隐掉副标题。

## 抽牌亮卡面

诏令 / 市井传闻原先只往日志里写一行,太容易看漏,这次把卡面亮出来:

- 服务端 `drawCard()` 里记 `g.lastCard = { kind, text, seat, seq }`,`seq` 自增;
- 前端只认 `seq` 变没变(**不比对文字**,同一张牌会重复抽到),弹 3 秒后自己收;
- 首次收到状态只对齐 `seq` 不弹 —— 否则中途进房/断线重连的人会被补弹一张旧牌。

## 全局风格前缀(每条 prompt 开头)

> Tang dynasty Chinese board game illustration, ink and mineral pigment painting on aged rice paper,
> visible paper grain, elegant minimal composition, restrained palette of rammed-earth ochre, vermilion red,
> celadon green, indigo blue and imperial gold on cream paper, clean bold readable silhouette,
> flat stylized illustration NOT a photograph, original design not resembling any existing commercial board game.
> STRICTLY NO Chinese characters, no hanzi, no calligraphy, no seal script, no letters, no numbers,
> no watermark, no signature, no text of any kind.

角落格再接一段:主体压在下半幅、上半幅留白,降低视觉噪声好让界面文字压得住;
再接 `FULLBLEED`(edge to edge / no outer margin / no border frame / not a picture on a wall)。

## 素材清单(15 张)

| 文件 | 规格 | 用在哪 | 内容 |
| --- | --- | --- | --- |
| center.jpg | 1024² | 棋盘中央 | 长安城俯瞰(第一批) |
| felt2.jpg | 1100² | 页面底 | 夯土墙层理,已压对比 |
| paper.jpg | 420² | 每个地格 | 米纸纹 |
| cover.jpg | 1200×675 | 首页 / og:image | 长安市集全景,驼队、坊墙、大雁塔 |
| corner-go.jpg | 440² | 0 明德门 | 城门楼正面,晨光,大道远去 |
| corner-jail.jpg | 440² | 10 京兆府大牢 | 铆钉狱门 + 石狮,冷调 |
| corner-free.jpg | 440² | 20 曲江池 | 荷池、拱桥、水榭、垂柳 |
| corner-togo.jpg | 440² | 30 差役拿人 | 两名差役持绳与棍疾行 |
| icon-gate.png | 256² 透明 | 4 座城门 | 城楼,拱门填实心靛蓝 |
| icon-canal.png | 256² 透明 | 2 条渠 | 三道靛蓝浪 + 石涵洞 |
| icon-edict.png | 256² 透明 | 3 格诏令 | **卷起来**的卷轴 + 朱红绦带 |
| icon-rumor.png | 256² 透明 | 3 格市井传闻 | 酒旗 + 茶盏 |
| icon-tax.png | 256² 透明 | 2 格税 | 天平 + 铜钱(本想要杆秤,天平反而更好认) |
| card-edict.jpg | 600×800 | 抽牌弹窗 | 金红卷轴卡面,中间留白 |
| card-rumor.jpg | 600×800 | 抽牌弹窗 | 青绿市集幌子卡面,中间留白 |

## 还没做

- 动画:掷骰、棋子沿格移动、过起点领钱、收租、入狱、破产
- 音效(可参照 `yuyi/public/js/sfx.js`,Web Audio 现场合成,零素材)
- hub 门户目前三款游戏都是纯 CSS 卡片、无配图;要加就三款一起加,别只给坊市加
