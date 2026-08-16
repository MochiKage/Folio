# Folio — 英文学术 PDF 阅读器

Tauri 2 + React 19 + PDF.js 6 的英文学术文献阅读器。**全离线**：词典（ECDICT +
多词典管理）、OCR（PaddleOCR ONNX）均为本地推理，规划中的翻译/搜索同样离线。

## 常用命令

- `npm run dev` — 仅前端（Vite）
- `npm run tauri dev` — 完整应用（Rust + 前端）
- `cd src-tauri && cargo test` — Rust 单测（18 个，含 OCR 引擎）
- `cd src-tauri && cargo check` — Rust 编译检查
- `python scripts/make_scan_fixtures.py` — 重新生成测试夹具（test_clean /
  test_noisy 6 页噪声梯度 / test_skewed 6 角度；全部 gitignored，需要
  pymupdf + numpy + Pillow）

## 文件地图

- `src-tauri/src/ocr_engine.rs` — OCR 管线（det/rec、deskew、词级对齐）+ 单测
- `src-tauri/src/commands/ocr.rs` — OCR 命令层 + ocr_cache 持久化 + 分阶段计时
- `src/lib/ocr.ts` — 前端 OCR 文字层渲染 + `runOcrPageIfNeeded` 公共作业
- `src/stores/ocrStore.ts` — OCR 状态 + 两级优先级队列（user 插队 prefetch）
- `DEVLOG.md` — 历史设计决策与踩坑记录，**改代码前先查**
- `ROADMAP.md` — 规划中的功能与优先级

## 关键约定

- **提交纪律**：每轮功能完成后必须先让用户在应用里测试验证，等用户明确说
  "提交/推送"后才能 commit/push，授权不跨轮次
- **OCR 缓存版本**：`OcrBox.v` 当前为 7；改动 OcrBox 结构必须升版本号，
  旧缓存自动失效重识别
- **夹具**：测试 PDF/PNG 全部 gitignored，随时可用脚本重新生成

## 下一步做什么

见 [ROADMAP.md](ROADMAP.md)——优先级顺序：全文搜索 → 大 PDF 导航 → 翻译
（词典拼接 v1 → int8 神经模型 v2）→ SRS 词汇复习 → 标注导出 → TTS。
