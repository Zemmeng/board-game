# 余一 · 出图 prompt 成品单(备选路线)

本文件是 [ART_PLAN.md](ART_PLAN.md) 的「备选」执行件:可灵 MCP 未授权时,把下面每条 prompt
**整条**复制到任意出图工具(GPT / 即梦 / Midjourney / SD 均可),一次一张,生成后按文件名存到
`yuyi/public/img/`。全部或部分回来后我做质检 + 接入界面 + 做动画。

每条 prompt 已经把全局风格前缀拼好了,**不需要再加任何东西**,直接整段粘贴即可。

## 通用要求(工具支持的话就设上)

- **负向词**:`text, letters, numbers, words, watermark, signature, logo, UNO, brand, jpeg artifacts, blurry, extra frames, border text`
- 画面里**绝对不能出现任何文字/字母/数字**——牌面的数字和符号全部由程序叠加
- 标了「透明」的必须导出真 PNG 透明底,**不能有白边/灰边**;不支持透明的工具就用纯品红 `#FF00FF` 背景,我来抠
- 比例:卡牌 3:4 竖版,图标/头像 1:1,桌布 1:1,封面 16:9

## 一、牌背与牌面底(6 张,768×1024,3:4)

### 1. `back.png` — 牌背

```
Chinese folk-art style game asset, ink-and-gouache texture on warm rice paper, subtle paper grain, elegant minimal composition, palette anchored on vermilion red / imperial gold / jade green / indigo blue with cream paper, no text, no letters, no numbers, no watermark, clean silhouette, original design not resembling any existing card game brand (especially NOT resembling UNO). Ornate playing card back, symmetrical lattice inspired by Chinese window carvings, deep pine green base with gold linework, single abstract circular emblem in the center, vertical 3:4 card with rounded corners and full bleed.
```

### 2. `face-r.png` — 赤(红)牌面底

```
Chinese folk-art style game asset, ink-and-gouache texture on warm rice paper, subtle paper grain, elegant minimal composition, palette anchored on vermilion red / imperial gold / jade green / indigo blue with cream paper, no text, no letters, no numbers, no watermark, clean silhouette, original design not resembling any existing card game brand (especially NOT resembling UNO). Card face background in vermilion red, a large soft cream oval zone in the center left COMPLETELY EMPTY for program overlay, delicate cloud-pattern border, vertical 3:4 card with rounded corners and full bleed.
```

### 3. `face-y.png` — 金(黄)牌面底

```
Chinese folk-art style game asset, ink-and-gouache texture on warm rice paper, subtle paper grain, elegant minimal composition, palette anchored on vermilion red / imperial gold / jade green / indigo blue with cream paper, no text, no letters, no numbers, no watermark, clean silhouette, original design not resembling any existing card game brand (especially NOT resembling UNO). Card face background in imperial gold, a large soft cream oval zone in the center left COMPLETELY EMPTY for program overlay, delicate cloud-pattern border, vertical 3:4 card with rounded corners and full bleed.
```

### 4. `face-g.png` — 翠(绿)牌面底

```
Chinese folk-art style game asset, ink-and-gouache texture on warm rice paper, subtle paper grain, elegant minimal composition, palette anchored on vermilion red / imperial gold / jade green / indigo blue with cream paper, no text, no letters, no numbers, no watermark, clean silhouette, original design not resembling any existing card game brand (especially NOT resembling UNO). Card face background in jade green, a large soft cream oval zone in the center left COMPLETELY EMPTY for program overlay, delicate cloud-pattern border, vertical 3:4 card with rounded corners and full bleed.
```

### 5. `face-b.png` — 黛(蓝)牌面底

```
Chinese folk-art style game asset, ink-and-gouache texture on warm rice paper, subtle paper grain, elegant minimal composition, palette anchored on vermilion red / imperial gold / jade green / indigo blue with cream paper, no text, no letters, no numbers, no watermark, clean silhouette, original design not resembling any existing card game brand (especially NOT resembling UNO). Card face background in indigo blue, a large soft cream oval zone in the center left COMPLETELY EMPTY for program overlay, delicate cloud-pattern border, vertical 3:4 card with rounded corners and full bleed.
```

### 6. `face-w.png` — 万能牌面底

```
Chinese folk-art style game asset, ink-and-gouache texture on warm rice paper, subtle paper grain, elegant minimal composition, palette anchored on vermilion red / imperial gold / jade green / indigo blue with cream paper, no text, no letters, no numbers, no watermark, clean silhouette, original design not resembling any existing card game brand (especially NOT resembling UNO). Card face background in charcoal black, a large soft cream oval zone in the center left COMPLETELY EMPTY for program overlay, edges glowing with a subtle four-color aurora of red gold green and indigo, vertical 3:4 card with rounded corners and full bleed.
```

> 2~6 号是一组,**必须风格一致**——留白椭圆的位置、大小、边框花纹要一模一样,只有主色不同。
> 建议同一个会话里连着出这 5 张,后 4 张直接说「same composition as before, change the base color to …」。

## 二、功能牌图标(5 张,512×512,透明底)

### 7. `icon-skip.png` — 禁止(跳过)

```
Chinese folk-art style game asset, ink-and-gouache texture, elegant minimal composition, palette anchored on vermilion red / imperial gold / jade green / indigo blue, no text, no letters, no numbers, no watermark, clean silhouette, original design not resembling any existing card game brand (especially NOT resembling UNO). A "forbidden" emblem, crossed-out circle styled as a Chinese paper-cut seal, single centered bold silhouette, transparent background, square 1:1, icon fills about 80 percent of the frame.
```

### 8. `icon-rev.png` — 反转

```
Chinese folk-art style game asset, ink-and-gouache texture, elegant minimal composition, palette anchored on vermilion red / imperial gold / jade green / indigo blue, no text, no letters, no numbers, no watermark, clean silhouette, original design not resembling any existing card game brand (especially NOT resembling UNO). A cyclone swirl of two koi fish chasing each other in a circle, paper-cut style, single centered bold silhouette, transparent background, square 1:1, icon fills about 80 percent of the frame.
```

### 9. `icon-d2.png` — +2

```
Chinese folk-art style game asset, ink-and-gouache texture, elegant minimal composition, palette anchored on vermilion red / imperial gold / jade green / indigo blue, no text, no letters, no numbers, no watermark, clean silhouette, original design not resembling any existing card game brand (especially NOT resembling UNO). Two overlapping blank cards flying with motion lines, paper-cut style, single centered bold silhouette, the cards must be completely blank with no symbols on them, transparent background, square 1:1, icon fills about 80 percent of the frame.
```

### 10. `icon-wild.png` — 万能换色

```
Chinese folk-art style game asset, ink-and-gouache texture, elegant minimal composition, no text, no letters, no numbers, no watermark, clean silhouette, original design not resembling any existing card game brand (especially NOT resembling UNO). A four-color pinwheel lotus, each petal one color: vermilion red, imperial gold, jade green, indigo blue, single centered symmetrical emblem, transparent background, square 1:1, icon fills about 80 percent of the frame.
```

### 11. `icon-d4.png` — 万能 +4

```
Chinese folk-art style game asset, ink-and-gouache texture, elegant minimal composition, no text, no letters, no numbers, no watermark, clean silhouette, original design not resembling any existing card game brand (especially NOT resembling UNO). A four-color pinwheel lotus with four small blank cards bursting outward from behind it, each petal one color: vermilion red, imperial gold, jade green, indigo blue, the small cards completely blank, single centered symmetrical emblem, transparent background, square 1:1, icon fills about 80 percent of the frame.
```

> 10 和 11 是一对,风莲花主体要长得一样,11 号只是多了四张飞出的小牌。

## 三、印章与桌布(2 张)

### 12. `seal-yuyi.png` — 「余一!」朱红印章(512×512,透明)

```
Chinese folk-art style game asset, no text, no letters, no numbers, no watermark, original design not resembling any existing card game brand. A round Chinese seal stamp imprint in vermilion cinnabar ink, slightly distressed and uneven edges as if freshly pressed on paper, containing one single vertical rectangular tile pictogram in the center suggesting "one card left", pure vermilion on transparent background, square 1:1, seal fills about 85 percent of the frame.
```

### 13. `table.png` — 桌布(1024×1024,无缝平铺)

```
Chinese folk-art style game asset, no text, no letters, no numbers, no watermark. Seamless tileable dark felt table texture with an extremely subtle Chinese cloud pattern, deep pine green, very low contrast, no visible seams when tiled, no border, no vignette, even lighting across the whole square, square 1:1.
```

> 桌布出完自己先验一下:横竖各复制一份拼起来,接缝看不出来才算过。

## 四、头像(6 张,256×256,透明底)

六张共用同一句,只换动物。**同一批出,保证画风一致。**

| 文件名 | 动物 | 替换成 |
| --- | --- | --- |
| avatar-1.png | 红冠鹤 | `a red-crowned crane` |
| avatar-2.png | 锦鸡 | `a golden pheasant` |
| avatar-3.png | 玉兔 | `a white jade rabbit` |
| avatar-4.png | 青锦鲤 | `a blue-green koi fish` |
| avatar-5.png | 熊猫 | `a giant panda` |
| avatar-6.png | 虎崽 | `a tiger cub` |

```
Chinese folk-art style game asset, ink-and-gouache texture on warm rice paper, elegant minimal composition, palette anchored on vermilion red / imperial gold / jade green / indigo blue with cream paper, no text, no letters, no numbers, no watermark, clean silhouette, original design. Cute round animal portrait medallion of 【替换成上表的动物】, head and shoulders inside a circular decorative frame, warm and friendly expression, facing the viewer, transparent background outside the circular frame, square 1:1, medallion fills the frame.
```

## 五、封面(1 张,1200×675,16:9)

### 20. `cover.png`

```
Chinese folk-art style game asset, ink-and-gouache texture on warm rice paper, subtle paper grain, palette anchored on vermilion red / imperial gold / jade green / indigo blue with cream paper, no text, no letters, no numbers, no watermark, original design not resembling any existing card game brand (especially NOT resembling UNO). Festive horizontal illustration, four hands throwing colorful blank cards across a table, cards trailing red gold green and indigo ribbons, dynamic diagonal composition, joyful celebratory energy, all cards completely blank with no symbols, horizontal 16:9.
```

> 封面用于合集门户 games.wawazhiliao.com 的卡片和分享缩略图,构图**中间偏下留点空**,
> 站点会在上面叠「余一」两个字。

## 交付方式

生成好的图直接放到 `yuyi/public/img/`(文件名照上面),或者打包发给我。
不用一次凑齐——**先给 1~6 号(牌背 + 5 张牌面底)** 我就能把最主要的观感先接上去,
剩下的图标头像陆续补都行。

我拿到后会逐张过这几关:风格是否统一 / 透明底有没有白边 / 牌面中心留白够不够 /
画面有没有混进文字数字。不合格的我会指出来并给改词,合格的直接接界面 + 做动画
(发牌扇入、出牌飞落旋转、摸牌翻面、+2/+4 冲击抖动、喊余一时印章砸落、被抓罚牌手牌一颤、换色全桌涟漪)。
