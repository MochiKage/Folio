# 开发记录

## 遇到的问题与解决方案

### Rust 工具链

**问题**：`cargo check` 失败，`link.exe` 链接错误。PATH 中 Git 自带的 `link.exe` 优先级高于 MSVC 链接器。  
**解决**：安装 Visual Studio Build Tools 2022（C++ 工作负载），`rust-lld` 作为后备链接器。

**问题**：GNU 工具链 (`x86_64-pc-windows-gnu`) 的 `dlltool` 版本与 64 位目标不兼容。  
**解决**：统一使用 MSVC 工具链，项目级 `.cargo/config.toml` 指定 `rust-lld`。

### PDF 渲染

**问题**：`file://` 协议加载本地 PDF 被 WebView2 阻止（`Unexpected server response (0)`）。  
**解决**：改用 Tauri `@tauri-apps/plugin-fs` 的 `readFile()` 读取二进制数据，通过 `pdfjsLib.getDocument({ data: ArrayBuffer })` 加载。

**问题**：cmaps 资源路径报错 `must include trailing slash`。  
**解决**：将 `pdfjs-dist/cmaps/` 和 `standard_fonts/` 复制到 `public/`，URL 改为绝对路径 `/cmaps/`。添加 `postinstall` 脚本自动复制。

**问题**：1200 页 PDF 打开后文本选择需要 10 秒才能用。所有页面同时渲染文本层，阻塞主线程。  
**解决**：IntersectionObserver 懒加载——屏幕外的页用占位 div，只渲染视口 ±2 页的 canvas + 文本层。

### 文本层定位

**问题**：PDF.js 文本层 span 的位置与 canvas 上渲染的文字不对齐，选择 "CONTENTS" 实际选中 "ENTS"。  
**尝试过的方案**：
1. `streamTextContent()` vs `getTextContent()` — 无明显改善
2. `text-size-adjust: none` + `forced-color-adjust: none` — 部分改善
3. 移除 `content-visibility: auto`（隐式 `contain: layout` 干扰绝对定位）— 未知是否完全解决

#### 2026-08-11：彻底解决 — PDF.js TextLayer CSS 变量缺失

**症状**：
- 用户选中一段文字，高亮的区域和复制出来的内容不匹配
- "Widely accepted as" 没有高亮但复制出来了，"used by circuit designers" 高亮了但没复制出来
- 换 Acrobat 打开同一 PDF，选中复制完全正常 → 证明 PDF 数据本身没问题

**根因**：我们的自定义 viewer **完全没有设置 PDF.js TextLayer 运行所需的 CSS 变量和样式规则**。

PDF.js 的 `TextLayer` 在官方 viewer 中依赖以下 CSS 变量链：

```
--scale-factor          JS 在 zoom 变化时动态更新（= viewport.scale）
--total-scale-factor    CSS calc(scale-factor × user-unit)，默认为 1
--text-scale-factor     CSS calc(total-scale-factor × min-font-size)
--min-font-size-inv     CSS calc(1 / min-font-size)
```

这些变量驱动两个关键机制：

1. **容器尺寸**：`setLayerDimensions()` 通过 `--total-scale-factor` 计算文字层容器大小。不设置时 CSS `round()` 表达式无效，容器回退到 `inset:0`（恰好等于 canvas 尺寸，侥幸不崩）。

2. **Span 缩放**：每个 span 需要：
   - `font-size: calc(var(--total-scale-factor) * var(--font-height))` — 字号随 zoom 缩放
   - `transform: scaleX(var(--scale-x))` — **水平字宽校正**，这是关键中的关键

**为什么 scaleX 是核心**：

PDF 中的文字宽度是 PDF 引擎根据字体度量计算的，但浏览器用自己的字体引擎渲染文字时，同一段文字的宽度可能与 PDF 计算值不同（字体替换、渲染引擎差异）。PDF.js 在每个 span 上测量浏览器实际渲染宽度，然后设置 `scaleX = PDF宽度 / 浏览器宽度` 来拉伸/压缩 span，使其视觉宽度与 canvas 上的文字对齐。

没有了 `scaleX`，随着一行文字从左到右推进，累积的宽度误差会让行尾的 span 严重错位。用户选择文本时浏览器的 DOM Range 命中测试基于 span 的实际渲染位置，于是高亮区域和 span 的实际文本内容就对不上——这正是「高亮 A 复制出 B」现象的本质。

**为什么 Acrobat 没问题**：Adobe 是 PDF 格式的制定者，Acrobat 内置了完整的 PDF 字体渲染引擎，文字渲染和文字选择使用同一套字形定位数据，天然对齐。而 PDF.js 是"外来者"——它用浏览器 canvas 渲染文字，用 DOM 模拟文本选择，两者之间需要 `scaleX` 来桥接字体度量差异。

**反思**：

1. **不要轻易怀疑上游库有 bug。** 我们花了很多时间调试自建的 `renderDebugTextLayer`、列检测、baseline 分组……最后发现根本原因是缺少了官方 CSS 的两个属性。遇到第三方组件表现异常时，第一时间应该是对比官方 demo 和我们自己的集成差异，而不是绕过组件自己写替代方案。

2. **CSS 变量也是 API。** PDF.js 的文档没有明确列出 `--total-scale-factor`、`--scale-x` 这些变量，但它们确实是 TextLayer 的隐式公共接口。集成第三方组件时不仅要看 JS API，还要看它的 CSS 文件和 style.setProperty 调用——这些自定义属性就是传递给组件的"CSS 参数"。

3. **自定义 viewer 最容易踩的坑：尺度系数混淆。** 第一次修复失败是因为我把 `--total-scale-factor` 设成了 `zoom × devicePixelRatio`，导致容器比 canvas 大 1.25 倍（125% 缩放显示器），文字位置完全错乱。正确的值是纯 `zoom`，不带 DPR——DPR 只在 TextLayer 内部用于离屏 canvas 文字测量（`TextLayer.#scale`），不参与布局计算。

4. **当分栏选择也一起修复时，说明找到了真正的根因。** 之前分栏 PDF 的跨栏选择问题（选中左栏文字时拖到了右栏内容），怎么调整 DOM 结构都修不好——因为根本原因不是 DOM 结构，而是 span 宽度不对导致相邻 span 的命中区域重叠。

5. **排查顺序：数据 → 布局 → 交互。** 这次正确的排查思路是：Acrobat 正常 → 数据没问题 → 问题在渲染层 → 对比官方 CSS → 发现缺少 CSS 变量。如果一开始就用这个思路，不会在"PDF 坐标不准"的假设上浪费数轮调试。

#### 2026-08-11：段落合并 — 复制文字从"逐行断开"变为流式段落

**问题**：PDF 中同一段落的文字，复制出来会按行断开（每个 `hasEOL` 都插入 `<br>`），无法直接粘贴为连续文本。

**方案**：在 `textLayer.render()` 完成后，分析 `<br>` 元素前后行的垂直间距，将间距分为"段内换行"和"段落边界"两类。

**实现** (`src/lib/textLayer.ts` → `mergeParagraphLines()`)：
- 用 `getBoundingClientRect()` 测量每个 `<br>` 前后的实际像素间距
- 取底部 80% 间距的均值作为"典型段内行距"
- 取顶部 10% 间距的均值作为"段落边界间距"
- 阈值 = `max(典型行距 × 2.2, 两类间距中点)` → 低于阈值合并，高于阈值保留 `<br>`
- 均匀间距页面（无段落结构）全部合并

**语言感知空格**：英语等拉丁文字换行合并时需要在单词间插入空格（`"successful" + "The"` → `"successful The"`），中日韩文字不需要。接口接受 ISO 639-1 语言代码或 `"auto"`（基于 Unicode 范围自动检测 CJK/假名/韩文）。

**踩坑**：最初用 `br.replaceWith(document.createTextNode(' '))` 插入空格文本节点，但绝对定位的 `<span>` 之间的裸文本节点渲染在容器 `(0,0)` 位置，浏览器文字选择覆盖不到，复制时空格丢失。修复方案是将空格追加到前一个 `<span>` 的 `textContent` 末尾。

**遗留**：多栏 PDF 的跨栏选择高亮仍存在（浏览器 Selection API 用轴对齐矩形做命中测试的固有限制），当前仅通过 `overflow: hidden` + `line-height: 1` 缓解。完整方案需列检测 + DOM 分组重构。

### 虚拟化与性能

**问题**：全屏/最大化窗口切换时明显卡顿、出现白边。  
**解决**：
1. ResizeObserver 只用于 Fit Width 重算缩放，不触发 React 重渲染（直接写 DOM）
2. 侧边栏拖拽时直接 `el.style.width`，mouseup 才 sync React state
3. `index.html` body 和 `tauri.conf.json` 设置 `backgroundColor` 防白闪
4. 移除 `will-change: transform` 和 `contain: strict`（反而加剧 resize 抖动）

### 目录导航

**问题**：点击目录标签无法跳转。  
**根因**：(1) `useEffect` 依赖了 `documents` 数组（每次翻页都重建），导致目录反复加载；(2) `scrollIntoView` 在懒加载页面上无效。  
**解决**：
1. `useEffect` 仅依赖 `activeDocId`
2. `jumpToPage()` → 强制目标页进 `visiblePages` → `rAF×2 + 120ms` 等待 canvas 渲染 → 单次 `scrollIntoView`

**问题**：跳转到目标页的上一页，需点击两次。  
**根因**：canvas 渲染是异步的，第一次滚动时页元素高度为占位值，渲染完成后高度变化导致偏移。  
**解决**：`rAF + setTimeout` 等 canvas 渲染完成后再滚动。

### 缩放

**问题**：Ctrl+滚轮缩放非常卡顿。每次 wheel 事件都触发全部可见页重绘。  
**解决**：`requestAnimationFrame` 防抖——连续滚轮只执行最后一次 zoom。

## 架构反思

1. **PDF.js TextLayer 选型**：DOM 文本层提供了原生文本选择和搜索，文本定位精度的关键在于正确设置 CSS 变量（`--total-scale-factor`、`--scale-x`）。对于纯扫描版 PDF（无文本层），可考虑跳过文本层直接 OCR。

2. **虚拟化策略**：IntersectionObserver + React 状态管理在小页面数（< 50 页）时过重。可增加阈值判断，小 PDF 直接全量渲染。

3. **Rust vs JS 边界**：当前所有 PDF 处理都在前端（JS），Rust 后端仅用于 SQLite。OCR 和 TTS 的 ONNX 推理应在 Rust 侧进行，避免阻塞 UI 线程。

### 2026-08-12：选区驱动的标注系统 + 右键菜单 + 阅读进度

**选区→标注闭环**：实现了从文本选择到标注创建、渲染、交互的完整链路。

**右键上下文菜单**（`ContextMenu.tsx`）：
- 选中文字后右键弹出菜单：4 色高亮（黄/绿/蓝/粉）、添加到词汇本、添加书签、复制
- 移除 `App.tsx` 全局 `onContextMenu` 禁用，仅在文本层选区上弹出自定义菜单
- 选区→PDF 坐标映射（`selection.ts`）：`getClientRects()` → 减 page 偏移 → `viewport.convertToPdfPoint()` → 存为 JSON rect

**标注覆盖层**（`AnnotationOverlay.tsx`）：
- 在 canvas 与 textLayer 之间渲染已存高亮矩形
- 从 PDF 空间坐标经 `viewport.convertToViewportPoint()` 转换定位
- 双击高亮区域自动弹出菜单（删除 / 加词汇 / 书签 / 复制）

**高亮替换逻辑**：新高亮自动删除重叠的旧高亮，避免颜色叠加。

**书签与阅读进度**：
- `Ctrl+D` 快速添加书签
- 滚动时 1.5 秒防抖自动持久化阅读进度（`updateReadingProgress`）
- 图书馆面板文档可点击打开，自动恢复到上次阅读位置

**外键约束修复**：打开 PDF 时自动 `upsertDocument` 创建数据库记录，解决 `annotations`/`bookmarks`/`vocabulary` 表外键引用 `documents(id)` 导致的静默插入失败。

**导航修复**：书签/标注面板 `setPage` → `jumpToPage`（之前只改状态不滚动）。

**坐标系统坑**：`rectsOverlap` 未处理 PDF 坐标系 Y 轴反转（PDF Y 向上 vs 屏幕 Y 向下），导致 `convertToPdfPoint` 返回的 rect 中 `y0 > y1`，AABB 重叠检测始终失败。修复用 `Math.min`/`Math.max` 归一化。

**Store 设计**：
- `annotationStore` — 按 `docId:page` 缓存标注，乐观更新
- `contextMenuStore` — 右键菜单状态（坐标、选中文字、PDF rect、重叠标注 ID）
- `pdfStore` 新增 `refreshKey` + `triggerRefresh()` — 标注/书签/词汇变更后刷新侧边面板

## 未解决的问题

- [ ] 大 PDF 首次打开时页面缩略图/快速定位功能缺失
- [ ] 标注编辑器（PDF.js AnnotationEditorLayer）未集成
- [ ] 单词库缺少词典查询功能（ECDICT 离线词典待集成）
- [ ] TTS 语音朗读引擎待集成
- [ ] 搜索不区分大小写、无正则支持
- [ ] 无打印、导出功能
