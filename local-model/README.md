# 本地模型（实验性，未验收）

> ⚠️ 这一部分**没有用真实模型权重跑通过**。接口和测试替身都能跑，但真实的中文判断效果、内存、速度一概未知。想用言外分析自己的聊天，请优先选「Jev 云端」。

本目录是给言外「本地模型」分析方式用的本机服务：把 [Laya](https://github.com/NandhaKishorM/laya) 多语模型的判断结果转换成言外面板需要的结构。候选回复来自固定模板，**不调用任何生成式模型或云端服务**。

## 运行

需要 Python 3.10+，建议用独立虚拟环境：

```sh
cd local-model
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

另行下载 `convaiinnovations/laya-multilingual` 的完整权重、tokenizer 和 encoder 配置（本仓库不包含模型文件），建议固定 revision `052592a15d198d9ad47da779604259b10b47b7aa`。安装和首次下载需要联网。

```sh
python server.py --model-dir /path/to/laya-multilingual --device mps
```

然后在言外里切到「本地模型」，点「检查连接」。

## 边界

- 服务只绑定 `127.0.0.1:7147`，不接受局域网连接；普通网页请求会被拒绝。
- 推理启动后切到 HuggingFace / Transformers 离线模式；缺文件直接失败，不会静默下载，也不会回退到云端。
- 聊天内容只在请求内存里，不记录正文和历史。
- 多语版上下文较短，超长时保留最近的内容，并返回 `contextTrimmed` 提示。
- `/analyze` 返回 `intentProbabilities`（完整意图分布）和 `intentLabels`。缺失时返回 null，非法数值返回 null 项，界面会整体显示为空态，不补假数字。置信度不代表准确率。

## 测试

```sh
python3 -m unittest -v test_server.py
```

6 项测试用替身代替模型（2 项响应转换 + 4 项 HTTP 服务检查），不需要权重。它们只证明接口形状正确，**不证明 Laya 的真实判断效果**。
