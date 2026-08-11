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
**当前状态**：仍存在部分不对齐。疑似扫描版 PDF 的内嵌 OCR 文本坐标本身不够精确。后续需参考 Adobe Acrobat 的字体度量匹配方式。

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

1. **PDF.js TextLayer 选型**：DOM 文本层提供了原生文本选择和搜索，但性能开销大、定位精度依赖 PDF 内部坐标。对于纯扫描版 PDF（无文本层），可考虑跳过文本层直接 OCR。

2. **虚拟化策略**：IntersectionObserver + React 状态管理在小页面数（< 50 页）时过重。可增加阈值判断，小 PDF 直接全量渲染。

3. **Rust vs JS 边界**：当前所有 PDF 处理都在前端（JS），Rust 后端仅用于 SQLite。OCR 和 TTS 的 ONNX 推理应在 Rust 侧进行，避免阻塞 UI 线程。

## 未解决的问题

- [ ] OCR 文本层与 PDF 渲染文字的位置偏差（部分 PDF 仍存在）
- [ ] 大 PDF 首次打开时页面缩略图/快速定位功能缺失
- [ ] 标注编辑器（PDF.js AnnotationEditorLayer）未集成
- [ ] 单词库缺少词典查询功能（ECDICT 离线词典待集成）
- [ ] TTS 语音朗读引擎待集成
- [ ] 搜索不区分大小写、无正则支持
- [ ] 无打印、导出功能
