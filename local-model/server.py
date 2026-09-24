"""Loopback-only Laya adapter. Install/download separately; runtime is offline.
No persistent conversation history and no generative or cloud fallback.
"""
import argparse
import json
import math
import os
from pathlib import Path
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

INTENTS = {
    "action": "可能希望事情有具体进展",
    "information": "可能希望得到信息或解释",
    "emotion": "可能在表达感受或不满",
    "unclear": "信息还不够，先确认意思",
}
ACTIONS = {
    "clarify": ("先问清楚对方具体希望什么。", ["我想确认一下，你更希望我现在做什么？", "你指的是哪件事？我怕理解偏了。", "我先说说我的理解，你看有没有偏差。"]),
    "acknowledge": ("先回应感受，不急着解释。", ["听起来这件事让你不太舒服，我愿意认真听。", "你愿意具体说说最在意哪一点吗？", "我看到了，你先说，我认真听。"]),
    "plan": ("核实能做到的安排，再确认下一步。", ["你最晚什么时候需要？我先核对能做到的安排。", "我把下一步和时间确认清楚后回复你。", "这件事你最需要我先处理哪一部分？"]),
    "explain": ("先核对事实，再回应具体问题。", ["我先核对一下具体情况，再给你明确答复。", "你想先了解哪一部分？", "我把已确认的信息整理一下。"]),
}
QUESTIONS = {
    "intent": {"type": "choice", "instructions": "What does the latest speaker explicitly seek, given this chat? Choose unclear if ambiguous. Do not infer hidden personality.",
        "criteria": {"action": "A concrete action or plan", "information": "Information or explanation", "emotion": "Acknowledgment of feelings", "unclear": "Not enough context"}},
    "action": {"type": "choice", "instructions": "Which cautious response type fits the available facts? Do not invent promises or assume a romantic relationship.",
        "criteria": {"clarify": "Ask to clarify", "acknowledge": "Acknowledge feelings", "plan": "Confirm feasible next steps", "explain": "Check and explain facts"}},
}


def render_result(answers, elapsed, trimmed):
    intent = answers.get("intent", {}).get("choice", "unclear")
    action = answers.get("action", {}).get("choice", "clarify")
    label, replies = ACTIONS.get(action, ACTIONS["clarify"])
    if intent not in INTENTS:
        intent = "unclear"
    # Preserve every option and valid raw value. Invalid entries become null so
    # JSON stays standard and the UI can reject the whole distribution honestly.
    probabilities = answers.get("intent", {}).get("probabilities")
    if isinstance(probabilities, dict):
        probabilities = {key: value if type(value) in (int, float) and math.isfinite(value) else None
                         for key, value in probabilities.items()}
    else:
        probabilities = None
    return {"intentProbabilities": probabilities, "intentLabels": dict(INTENTS), "kind": "local", "intent": INTENTS[intent], "action": label, "replies": replies,
            "replySource": "本地表达模板", "latencyMs": round(elapsed * 1000), "contextTrimmed": trimmed}


class LayaEngine:
    def __init__(self, model_dir, device=None):
        folder = Path(model_dir).expanduser().resolve()
        if not folder.is_dir():
            raise ValueError("模型目录不存在。请先单独下载 laya-multilingual 权重。")
        # Set before importing the runtime: missing tokenizer/encoder files fail
        # locally instead of silently reaching out to a model hub.
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
        from laya import Agent
        self.agent = Agent(str(folder), device=device)
        self.model = "Laya · " + folder.name
        self.lock = threading.Lock()

    def analyze(self, text):
        with self.lock:
            tokens = self.agent.tok.encode(text, add_special_tokens=False)
            cfg = self.agent.cfg
            budget = max(32, min(640, cfg.get("max_len", 1024) - cfg.get("head_max_len", 256) - 64))
            trimmed = len(tokens) > budget
            state = self.agent.tok.decode(tokens[-budget:], skip_special_tokens=True) if trimmed else text
            start = time.perf_counter()
            result = self.agent.system_one(state, QUESTIONS)
            return render_result(result.get("answers", {}), time.perf_counter() - start, trimmed)


def make_server(engine, port=7147):
    slots = threading.BoundedSemaphore(1)
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass  # Never log request text or chat history.

        def reply(self, status, payload):
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def allowed(self):
            # The Electron main process has no Origin header. Reject web pages,
            # forms and preflight requests, including local file pages.
            return not self.headers.get("Origin")

        def do_OPTIONS(self):
            self.reply(403, {"error": "Browser access is disabled."})

        def do_GET(self):
            if not self.allowed(): return self.reply(403, {"error": "Browser access is disabled."})
            if self.path != "/health": return self.reply(404, {"error": "Not found"})
            self.reply(200, {"ready": True, "model": engine.model, "offline": True})

        def do_POST(self):
            if not self.allowed(): return self.reply(403, {"error": "Browser access is disabled."})
            if self.path != "/analyze": return self.reply(404, {"error": "Not found"})
            if self.headers.get_content_type() != "application/json": return self.reply(415, {"error": "JSON required"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 48000: return self.reply(413, {"error": "内容过长或为空。"})
                payload = json.loads(self.rfile.read(length))
                text = payload.get("text") if isinstance(payload, dict) else None
                if not isinstance(text, str) or not text.strip() or len(text) > 8000:
                    return self.reply(400, {"error": "请提供最近几句聊天，最多8000字。"})
            except (ValueError, UnicodeError):
                return self.reply(400, {"error": "无效请求。"})
            if not slots.acquire(blocking=False):
                return self.reply(429, {"error": "本地模型正在处理上一段，请稍后重试。"})
            try: self.reply(200, engine.analyze(text.strip()))
            except Exception: self.reply(500, {"error": "本地推理失败，请检查模型文件、内存和运行环境。"})
            finally: slots.release()

    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="言外 Laya 本机适配服务")
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--device", choices=["cpu", "mps", "cuda"])
    args = parser.parse_args()
    engine = LayaEngine(args.model_dir, args.device)
    server = make_server(engine)
    print("言外本地服务已就绪：http://127.0.0.1:7147（不保存对话）", flush=True)
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close()
