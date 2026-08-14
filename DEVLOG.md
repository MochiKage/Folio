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

### 2026-08-12：离线词典系统 — 多词典管理 + 划词翻译 + 文本选区修复

**架构总览**：实现了完整的离线词典系统，支持多词典优先级叠加、用户导入/管理、自动表名检测，同时修复了 PDF 文本层选区不精确的问题。

---

#### 多词典管理器

**数据结构**：

```
DictionaryManager (Tauri State)
├── BackendImpl 枚举（Ecdict | 未来: Csv | Stardict）
│   ├── metadata(): DictionaryMeta  — 词典元信息
│   ├── lookup(word) → DictEntry   — 3 级查词
│   └── entry_count()
└── 按 priority 升序遍历所有启用的后端，返回首个匹配（短路）
```

**新增数据库表** `dictionaries`：
```sql
id, name, source_lang, target_lang, format, file_path,
enabled, priority, entry_count, is_builtin, created_at, updated_at
```

**Tauri 命令**（`commands/dictionary.rs`）：
- `lookup_word` — 跨词典优先级查词
- `list_dictionaries` / `add_dictionary` / `remove_dictionary` — 词典 CRUD
- `toggle_dictionary` / `reorder_dictionary` / `rename_dictionary` — 管理操作
- `validate_dictionary` — 导入前校验（表存在性、必要列、条目数、编码抽样）

**状态管理**（`dictionaryStore.ts`）：Zustand store，所有操作仅需 `refresh()` / `add()` / `remove()` / `toggle()` / `reorder()` / `rename()` 几个方法，组件层代码极简。

---

#### 词典格式自动检测

**问题**：用户导入 `stardict.db`（340 万词条），验证报错"缺少 ecdict 表"。文件表名是 `stardict` 而非 `ecdict`，但列结构完全兼容。

**解决**：`EcdictBackend::open()` 自动检测表名——优先 `stardict`，回退 `ecdict`。`validate_ecdict()` 同理，且错误消息列出实际存在的表名。

---

#### 内置词典

**策略**：内置词典从用户已有的 `stardict.db` 中提取 Collins 1-5 星 + Oxford 3000 + 中高考 CET4 词汇，共 **21,506 词条**（6.4 MB），覆盖英语阅读中最常见的单词。

**搜索路径**（`lib.rs` 启动时按序搜索）：
```
resources/stardict.db  →  resources/ecdict.db  →  D:\Downloads\stardict.db
```
优先级：stardict > ecdict，dev > prod > 外置路径。内置词典不可删除，可禁用/重命名/调整优先级。

---

#### 划词翻译集成

右键菜单（`ContextMenu.tsx`）中：
- 选中单词后自动查词，显示音标、中文释义、英文定义、标签
- 词典来源标注在右下角（如 "Stardict 英汉词典"）
- 一键 "Add to Vocabulary" 将释义存入个人词库

个人词库（`VocabularyPanel.tsx`）现在支持单词详情视图（音标、中英文释义、出处、复习计数、日期）。

---

#### 文本选区精确性修复

**原始问题**：PDF 文本层 span 的宽度由 PDF 字体度量计算，但浏览器实际渲染字形（glyph）往往比度量宽度稍宽，导致：
- 选中 "astrophysics," 时拖到 `s` 位置，浏览器选区只覆盖到 `c`（"astrophysic"）
- CSS hack（`padding-right`、`scaleX × 1.015`）会引发不可预测的副作用（选区左移、首字母丢失）

**尝试过的方案与结论**：

| 方案 | 效果 | 结论 |
|------|------|------|
| `padding-right: 2px` | 选区左移约一个字符 | 与 `scaleX` + `overflow: hidden` 交互导致位置偏移 |
| `scaleX × 1.015` | 首字母丢失 | transform 缩放比例与文本定位耦合，副作用不可控 |
| **Span 坐标定位 + textContent 取词** | ✅ 精确 | 绕过浏览器选区，直接用 PDF 原始文本数据 |

**最终方案**（`PdfPage.tsx` → `getWordAtPosition()`）：

1. 右键点击时，遍历文本层所有 `<span>`
2. 用 span 的 inline `left`/`top`（PDF 文本矩阵给出的精确坐标）+ `getBoundingClientRect()` 的宽高做命中检测（右侧给 5px 容差）
3. 命中后取 `span.textContent`——该值始终完整，不受浏览器字体渲染影响
4. 结果存入 `contextMenuStore.clickedWord`，ContextMenu 优先用它查词，回退到从 DOM 选区提取

**关键洞察**：PDF.js span 的**位置信息**（left/top）是可靠的（来自 PDF 文本矩阵），只有**宽度**不可靠（受浏览器字体渲染影响）。所以用位置来定位、用 textContent 来取词——取长补短。

---

#### 前端词典管理面板

`DictionaryManager.tsx`（侧边栏 Dictionary 标签）：

- **列表视图**：每个词典显示名称、格式、语言对、条目数、状态指示灯
- **导入流程**：文件选择器 → 格式选择（ECDICT） → 验证 → 命名 → 导入
- **内联重命名**：悬停名称 → 铅笔图标 → 点击编辑 → Enter 保存 / Esc 取消
- **优先级排序**：↑↓ 箭头按钮，上移 = 提高优先级（更早被搜索）
- **启用/禁用切换**：ToggleRight/ToggleLeft 图标
- **删除**：仅对非内置词典开放
- 验证失败返回结构化错误（红色）+ 警告（黄色），字段级别定位

---

#### 修改清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src-tauri/src/dictionary.rs` | **新增** | DictionaryManager + EcdictBackend + BackendImpl + validate_dictionary + lemma_candidates |
| `src-tauri/src/commands/dictionary.rs` | **新增** | 7 个 Tauri 命令 |
| `src-tauri/src/db.rs` | 修改 | 新增 dictionaries 表 |
| `src-tauri/src/lib.rs` | 修改 | DictionaryManager 初始化 + 多路径内置词典搜索 |
| `src-tauri/tauri.conf.json` | 修改 | bundle.resources 加入 ecdict.db |
| `.gitignore` | 修改 | 排除 stardict.db（812MB 不应进 git） |
| `src/lib/api.ts` | 修改 | DictEntry（新增 source_dict_id/name）+ 6 个 API 函数 + 类型定义 |
| `src/stores/dictionaryStore.ts` | **新增** | 词典列表 Zustand store |
| `src/stores/contextMenuStore.ts` | 修改 | 新增 clickedWord 字段 |
| `src/stores/appStore.ts` | 修改 | 新增 'dictionary' 侧边栏标签 |
| `src/components/DictionaryManager.tsx` | **新增** | 词典管理面板（列表/导入/验证/重命名/排序/启禁用） |
| `src/components/ContextMenu.tsx` | 修改 | 词典预览 + 来源标注 + selectedText 预览 + clickedWord 优先查词 |
| `src/components/PdfPage.tsx` | 修改 | getWordAtPosition() — span 坐标定位取词 |
| `src/components/VocabularyPanel.tsx` | 修改 | 单词详情视图 + 复习按钮 + JSON 解析 |
| `src/components/Sidebar.tsx` | 修改 | 注册 Dictionary 面板 |
| `src/components/TitleBar.tsx` | 修改 | 新增 Dictionary (🌐) 标签按钮 |
| `src-tauri/resources/ecdict.db` | **新增** | 开发用内置词典（21,506 词条，6.4 MB） |

### 2026-08-13：OCR 文本识别 — PaddleOCR PP-OCRv4 完整落地

**背景**：扫描版 PDF 无文本层，无法选词/查词/高亮。此前 OCR 管线仅有前端脚手架
（300 DPI 渲染、作业队列、`ocr_cache` 表），Rust 端 `run_ocr` 是桩函数。

**技术选型**：

| 组件 | 选择 | 说明 |
|------|------|------|
| 推理引擎 | ONNX Runtime 1.27.1（`ort` crate 2.0.0-rc.13，load-dynamic） | DLL 由 NuGet 包 `Microsoft.ML.OnnxRuntime` 提供（国内可达）；rc.13 要求 ORT ≥ 1.27，GitHub 直连不可达时 NuGet 是可靠源 |
| 检测模型 | `ch_PP-OCRv4_det_infer.onnx`（4.7MB，DB 算法） | 来自 RapidOCR 3.4.5 wheel（清华 PyPI 镜像），与预处理/后处理参数完全配套 |
| 识别模型 | `ch_PP-OCRv4_rec_infer.onnx`（10.9MB，SVTR + CTC） | 同上；输出 6625 类 = blank@0 + 6623 字符 + 空格@6624 |
| 预处理/后处理 | 参照 RapidOCR 参考实现逐参数移植 | det: limit_side_len=960(max)、thresh=0.3、box_thresh=0.5、unclip_ratio=1.6、膨胀+fast 评分；rec: [3,48,320] 动态宽、mean=std=0.5 |

**关键坑位（踩坑记录）**：

1. **`ort` 2.0.0-rc.13 与 DLL 版本匹配**：rc.x 之间不兼容（rc.13 要求 ORT ≥ 1.27）。
   `Cargo.toml` 必须用 `=2.0.0-rc.13` 精确锁定（caret 会漂移到更新的 rc）。
2. **CHW vs HWC 布局**：det 输入的 buffer 必须按 `buf[c*H*W + y*W + x]` 平面存放，
   与 ONNX NCHW 输入一致。按像素交错存放（HWC）时模型不会报错，但输出概率图
   位置错乱、识别结果全乱码。
3. **rec 输入宽度必须是 8 的倍数**：SVTR 输出 T = ceil(W/8) 个时间步。
   批量宽度 `img_w = max(320, 48*max_ratio)` 若不取整到 8 的倍数，CTC logits
   行切片错位（每行 6625 个浮点），解码全乱码且置信度虚高（0.77-0.95）。
   修复：`img_w = (img_w_raw + 7) / 8 * 8`，并在解码前校验 logits 长度。
4. **det 输出分辨率**：实测 640×640 → 640×640 全分辨率输出（非 1/4 下采样），
   后处理直接以输入尺寸为基准换算原始图像坐标。
5. **`image` crate 的 `FilterType` 在 `imageops` 模块下**（0.25 版 API 变更）。
6. **usize 下溢**：`(x > 0).then_some((x - 1, y))` 中 `then_some` 急需求值，
   x=0 时 panic。用 `x.checked_sub(1)` 替代。

**架构**：

- `ocr_engine.rs`（新，~1100 行）：`OcrEngine::recognize(png) -> (boxes, dims)`
  - det：resize(960-max, 32 倍) → 归一化 → DB 推理 → 二值化+膨胀 → 连通域 →
    PCA 最小外接矩形 → 快速评分 → unclip 扩展 → 映射回原图坐标 → 阅读顺序排序
  - rec：旋转裁剪（角点锚定双线性采样，竖排自动 rot90）→ 48 高按比例缩放 →
    批量推理（≤6/批）→ 贪心 CTC 解码
  - Session 用 Mutex 包裹（ort rc.13 的 `run` 需要 `&mut self`）
- `commands/ocr.rs`：`run_ocr` 在 `spawn_blocking` 中执行（避免阻塞 UI 线程），
  像素坐标 → PDF 坐标换算（viewBox 比例映射），结果 upsert 进 `ocr_cache`；
  `OcrState` 懒加载引擎 + 失败重试（模型文件后装可恢复）
- 前端接线：`PdfPage` 检测无文本层页面（`hasEmbeddedText` < 8 字符）自动触发
  OCR → `renderOcrTextLayer` 渲染为可选中文本层 → 右键查词/高亮/复制全兼容；
  DB 缓存命中时跳过推理（重启秒开）；OCR 按钮强制重识别 + 失败重试

**模型分发**：模型与 DLL 不入 git（约 30MB 二进制），
`src-tauri/resources/models/download.ps1` 一键下载（rapidocr wheel + NuGet）。

**性能**：A4 300 DPI 页面端到端 debug 约 2.8s / **release 约 0.42s**（debug 的
PNG 解码极慢，release 下 det 推理 ~85ms、后处理 ~150ms、rec ~620ms 为 debug
数值；release 全套 <0.5s）。识别批量 6 条/批。

**验证**：
- `cargo run --bin ocr_smoke -- <image.png>` 冒烟测试二进制（开发工具）
- 1600×1200 合成文本图：5 行全部识别正确，置信度 0.98+
- A4 300 DPI 合成页面：5 段全部正确，置信度 0.97+
- 单元测试 10 个（角点排序/CTC 解码/unclip 扩展/PCA 矩形/旋转裁剪等）

### 2026-08-14：OCR 文本层单词对齐 — 像素级词间隙分割

**背景**：OCR 文本渲染为可选中文本层后，spans 必须与页面图像上的字形吻合，
否则选词/查词错位。此前经历多轮边距调参（unclip 内边距、tight 框非对称、
px/pt 单位换算 bug 等），始终无法完全对齐——部分单词仍有约 1 个字符的偏移，
且无规律。

**根因**：单词位置由 CTC 解码时间戳线性插值得到。CTC 时间步与水平像素大致
成比例，但字形宽窄不一（"i"约 5px、"m"约 30px @300 DPI），线性映射在变宽
字形上必然漂移。这是模型时序估计的固有误差，调参无法消除（Acrobat 用的是
自研引擎的字形模板对齐，本技术栈不可达）。

**v1 过渡方案（CTC 峰值中点）**：`ctc_decode` 记录每个字符的发射峰值时间步，
词边界取相邻峰的中点。词边界误差收敛到 ±10px（≈0.25 字符，仿真验证），
用户实测仍有部分单词移位。

**v2 最终方案（像素级词间隙分割）**：`OcrBox.v = 2`，新增 `word_bounds`
字段——单词边界直接取自图像里的真实词间隙：

- 对 tight 范围内的**原图**做列剖面（每列暗像素计数，亮度阈值 160）
- 零墨迹列段 = 间隙；词间隙系统性宽于字间隙，取 `词数-1` 个最宽空段
  为词边界；CTC 仅提供词数做对齐校验，不参与定位
- 采纳门槛：最小选中间隙 ≥ 最大未选间隙 × 1.5 且 ≥ 2px——否则间隙结构
  歧义，该行回退到 v1 峰值中点方案
- 前端 `renderWordSpans` 优先用 `word_bounds`（tight 框比例映射）；
  `PdfPage` 缓存检查要求 `v >= 2`，旧缓存自动重新识别

**两个关键坑**：

1. **det 特征图分辨率不够**：约 2.5× 下采样后词间隙仅 2-3 列宽，膨胀后
   完全闭合（实测 zero-runs=0）。必须在原图上做剖面。
2. **det 掩码漏检细的顶部笔画**（大写 T 横杠、升部）：tight 框被垂直截断
   后，"Th" 内部出现 14px 假间隙，与真实词间隙同宽，导致歧义拒绝。
   修复：剖面采样行上下各扩 35% tight 高度，补回被截断的笔画。

**验证**：
- 校准图 12/12 词全部提取：词间隙 14-17px、字间隙 ≤6px，分离清晰
- 多行扫描页 7 行全部成功（含 13 词密集段落行，分离度 2.8×）
- Python 独立交叉验证：每个词的 span 精确落在图像像素上
- 单元测试 14 个（新增 word_segments 4 个：基本分割/三词/等宽歧义拒绝/
  间隙不足拒绝）

**后续加固（同日）**：

- **传输优化**：前端 canvas 改为 `getImageData` 原始 RGB 直传（`run_ocr`
  签名：`image: Uint8Array` + `image_width/height`，删掉无用的
  dpi/image_height 参数），取消 PNG 编解码往返——debug 下每页省约 2s
  （Rust 侧 PNG 解码 2.2s 是 prep 耗时大头）。`ocr_engine` 拆出
  `recognize_rgb()` 入口，`recognize(png)` 保留给冒烟测试
- **噪点鲁棒性**：列剖面加噪点抑制——列墨迹数 < 3 视为空白（噪点斑是
  1-2 个孤立像素，真实笔画在采样带内 ≥3 行）。合成噪点图（高斯 σ18 +
  0.05% 椒盐）7/7 行全部提取（抑制前 1 行被噪点拆出 8px 假间隙而拒绝）
- **倾斜保护**：轴对齐 tight 框在倾斜行上高度膨胀（1.5° → 2.2×），
  垂直扩展会混入邻行墨迹。新增显式倾斜判定：`tight_h > 1.4×墨迹高`
  → 跳过像素分割，安全回退 CTC。墨迹高取 PCA 矩形高，**坑：必须换算
  到原图空间**（map 空间只有 9px，直接比较会判定所有行倾斜）。
  1.5° 合成倾斜图：短行仍可提取，长行全部安全回退
- **调试叠加层**：Ctrl+Shift+D 切换 OCR span 边界框（红色虚线），
  对齐问题可视化，不用再改代码调试

**合成测试图**（`test_noisy.png` / `test_skewed.png`，由
`scripts/make_scan_fixtures.py` 生成——噪点图 PNG 压缩率极低 ~14MB 不入库）：
噪点 = 高斯 σ18 + 0.05% 椒盐斑；倾斜 = 旋转 1.5° + σ12 噪点。

## 未解决的问题

- [ ] 大 PDF 首次打开时页面缩略图/快速定位功能缺失
- [ ] 标注编辑器（PDF.js AnnotationEditorLayer）未集成
- [ ] TTS 语音朗读引擎待集成
- [ ] 搜索不区分大小写、无正则支持
- [ ] 无打印、导出功能
- [ ] 词组/短语动词词典覆盖不足（stardict 340 万中仅 ~800 个高质量词组）
- [ ] 倾斜扫描件（>1°）的词级对齐（当前安全回退 CTC ±10px；沿行方向投影剖面可解）
