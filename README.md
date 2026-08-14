# Folio

专精于英文学术文献的 PDF 阅览器。支持本地 PDF 阅读、标注、OCR 文本识别、语音朗读（TTS）和论文库管理。

## 技术栈

| 层 | 技术 |
|---|------|
| 桌面框架 | Tauri 2 (Rust + WebView2) |
| UI | React 19 + TypeScript + Vite + Tailwind CSS 4 |
| PDF 渲染 | PDF.js 6.x |
| OCR 引擎 | PaddleOCR (ONNX, 计划中) |
| TTS 朗读 | Kokoro-82M (ONNX, 计划中) |
| 数据库 | SQLite (rusqlite) |
| 词典 | ECDICT (离线英汉, 计划中) |

## 开发环境

- Node.js ≥ 22
- Rust ≥ 1.77
- Visual Studio Build Tools 2022（C++ 工作负载）
- Windows 11（WebView2 预装）

## 快速开始

```bash
pnpm install
pnpm tauri dev
```

## 已完成功能

- PDF 渲染：Canvas + 文本层，虚拟化页面视口（IntersectionObserver 懒加载）
- 阅读体验：暗色 / 浅色 / 仿纸 三色主题、专注模式（F11 / Esc）、Fit Width 自适应缩放
- 标注与学习：多色高亮、书签 CRUD、单词库、论文库（多维标签 namespace:value）
- 目录导航：PDF 大纲树形展开、递归页码解析、一键跳转
- 缩放控制：25%-400% 滑块、±25% 步进、Fit/100%/150%/200%/300%/400% 预设、Ctrl± 快捷键
- 侧边栏：可拖拽调整宽度、窄模式图标化、点击标签自动开关
- 数据库：SQLite 存储文档/标注/书签/单词/标签（Rust rusqlite + Tauri commands）
- 快捷键：Ctrl+O 打开、Ctrl+B 侧栏、F11 全屏、Esc 退出全屏
- 离线词典：ECDICT 英汉词典 + 多词典管理（导入/验证/优先级/启用禁用）+ 词形还原查词
- OCR 文本识别：PaddleOCR PP-OCRv4（ONNX Runtime，Rust 侧推理）
  - 扫描版 PDF 自动触发识别，结果渲染为可选中文本层（查词/高亮/复制全兼容）
  - 逐页结果持久化到 `ocr_cache`（重启后秒开）
  - OCR 按钮可强制重新识别 + 失败重试
  - 模型安装：`powershell -ExecutionPolicy Bypass -File src-tauri/resources/models/download.ps1`

## 计划中

- TTS 语音朗读（Kokoro-82M）
- 划词翻译（句子级）
- 自动元数据提取（DOI Crossref）
- 标注导出 + 云同步
- PDF 全文搜索（FTS5 表已就绪）
- Android 版（Tauri mobile）

## 项目结构

```
src/
├── components/   # React 组件
├── stores/       # Zustand 状态管理
├── hooks/        # 自定义 Hook
├── lib/          # PDF.js 配置 / Tauri API 封装
src-tauri/
├── src/
│   ├── db.rs     # SQLite 数据库初始化 + 表结构
│   ├── lib.rs    # Tauri 入口 + 命令注册
│   └── commands/ # 文档/标注/书签/单词/标签 CRUD
└── tauri.conf.json
```

## License

MIT
