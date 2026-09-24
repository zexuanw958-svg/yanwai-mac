# 来源与第三方声明

言外 Mac 不是原创项目，也**不是原作者团队出品**。它是个人基于开源项目改写的 Mac 版本，没有获得 TypeSafe、博查或原项目作者的认可或背书。

## Jev 聊天助手（jev-chat-JARVIS）

- 仓库：[Finderchangchang/jev-chat-JARVIS](https://github.com/Finderchangchang/jev-chat-JARVIS)，现已迁到 [jev-chat/jev-chat-jarvis](https://github.com/jev-chat/jev-chat-jarvis)
- 许可：MIT，`Copyright (c) 2026 Jev 聊天助手 contributors`（见本仓库根目录 `LICENSE`，原版权行原样保留）
- 言外的产品思路来自这个项目：用 Jev 判断对方意图，再给出候选回复。
- `jev-cloud.js` 中 Jev 判断问题的措辞（意图、动作、候选排序）移植自上游安卓端 `JevQuestions.kt`，文件头保留了出处注释。
- 原作者团队另有自己的 Mac 版 [jev-chat/jev-chat-jarvis-mac](https://github.com/jev-chat/jev-chat-jarvis-mac)。言外参考了它「按窗口读取微信」的思路，但 Swift / Electron 代码是另写的，没有复制它的 Python 实现。

## TO-DO-Panel

- 仓库：[xiaopu-ai/TO-DO-Panel](https://github.com/xiaopu-ai/TO-DO-Panel)，基准提交 `5927fb84bb3e962e77731666126c6505e7251813`
- 许可：MIT，`Copyright (c) 2026 TO-DO Panel contributors`
- 言外的刘海浮窗与多屏定位参考并改写自它：透明无边框窗口、所有工作区可见、原生边界瞬时切换配合渲染层过渡、展开/收起留在同一块屏幕。
- `vendor/to-do-panel/platform.js` 作为几何策略参考保留，同目录保留原始 MIT 许可 `vendor/to-do-panel/LICENSE`。
- 没有复制它的待办、媒体、账户、录制功能或品牌素材。

## 运行时与外部服务

- [Electron](https://www.electronjs.org/)（MIT）作为运行时，打包时整体复制进 `言外.app`，其自带许可随包分发。
- Jev 是 TypeSafe 的模型；博查、OpenRouter、DeepSeek 是各自独立的服务商。言外只是按它们公开的接口发请求，使用这些服务需遵守各自条款并自行付费。
- `local-model/`（实验性）依赖 [Laya](https://github.com/NandhaKishorM/laya) 与 `convaiinnovations/laya-multilingual` 权重，本仓库不包含其代码或权重，请以各自许可为准。

以上几项来源的署名互相不能替代。
