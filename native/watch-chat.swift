import AppKit
import Foundation

@main struct WatchChat {
    static func output(_ frame: ChatSnapshot) {
        for message in frame.messages {
            emitJSON(["kind": "message", "from": message.from, "text": message.text,
                      "title": frame.title, "ts": Date().timeIntervalSince1970,
                      "session": frame.session, "signature": frame.signature])
        }
    }
    static func main() async {
        let args = CommandLine.arguments
        if args.count == 2 && args[1] == "--self-test-layout" {
            let boxes = [
                TextBox(text: "测试聊天", rect: CGRect(x: 0.34, y: 0.04, width: 0.15, height: 0.03)),
                TextBox(text: "侧栏", rect: CGRect(x: 0.07, y: 0.2, width: 0.12, height: 0.03)),
                TextBox(text: "左气泡", rect: CGRect(x: 0.36, y: 0.25, width: 0.16, height: 0.03)),
                TextBox(text: "左气泡续行", rect: CGRect(x: 0.36, y: 0.29, width: 0.2, height: 0.03)),
                TextBox(text: "右气泡", rect: CGRect(x: 0.73, y: 0.4, width: 0.20, height: 0.03)),
                TextBox(text: "中央时间", rect: CGRect(x: 0.65, y: 0.5, width: 0.1, height: 0.03)),
                TextBox(text: "输入草稿", rect: CGRect(x: 0.36, y: 0.9, width: 0.2, height: 0.03))
            ]
            let frame = classifyChat(boxes)
            guard frame.title == "测试聊天", frame.messages == [
                ChatLine(from: "them", text: "左气泡\n左气泡续行"), ChatLine(from: "me", text: "右气泡"), ChatLine(from: "unknown", text: "中央时间")
            ], frame.signature == frame.signature else { emitJSON(["ok": false]); exit(1) }
            output(frame); emitJSON(["ok": true, "detail": "左右判定、多行合并及标题、侧栏、输入区排除通过；未运行 OCR。"]); return
        }
        if args.count == 3 && args[1] == "--self-test" {
            guard let image = NSImage(contentsOfFile: args[2]),
                  let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
                emitJSON(["kind": "status", "state": "idle", "detail": "测试图片无法打开。"]); exit(1)
            }
            do {
                let frame = try recognizeChat(cg)
                output(frame)
                emitJSON(["kind": "status", "state": "idle", "detail": "仅识别本地合成图。", "title": frame.title, "count": frame.messages.count])
            } catch { emitJSON(["kind": "status", "state": "idle", "detail": "测试图片识别失败。", "error": (error as NSError).localizedDescription, "domain": (error as NSError).domain, "code": (error as NSError).code]); exit(1) }
            return
        }
        if args.count == 3 && args[1] == "--self-test-crop" {
            guard let image = NSImage(contentsOfFile: args[2]),
                  let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
                  let lines = try? recognizeCrop(cg) else { emitJSON(["ok": false]); exit(1) }
            emitJSON(["kind": "screenshot", "messages": lines.map { ["from": $0.from, "text": $0.text] }]); return
        }
        if args.count == 2 && args[1] == "--pasteboard" { await watchPasteboard() }
        guard args.count == 1 else { exit(2) }
        // A bare command-line tool has no window-server connection yet. Calling the
        // screen-capture/window APIs first trips CoreGraphics' CGS_REQUIRE_INIT assertion
        // and aborts the process, so establish the connection on the main thread first.
        await MainActor.run {
            _ = NSApplication.shared
            _ = CGMainDisplayID()
        }
        // Never request permission programmatically. The UI offers a user-clicked settings link.
        signal(SIGTERM) { _ in exit(0) }; signal(SIGINT) { _ in exit(0) }; signal(SIGPIPE, SIG_IGN)
        FileHandle.standardInput.readabilityHandler = { handle in
            if handle.availableData.isEmpty { exit(0) }
        }
        var signature = ""
        while true {
            if !CGPreflightScreenCaptureAccess() {
                signature = ""
                emitJSON(["kind": "status", "state": "no-permission", "detail": "需要屏幕录制权限。请在系统设置中允许后重新开启跟随微信。"])
            } else {
                do {
                    let frame = try await readWechat()
                    if frame.title.isEmpty {
                        signature = ""
                        emitJSON(["kind": "status", "state": "idle", "detail": "没看清聊天名，请打开微信中的一个聊天。"])
                    } else {
                        let changed = frame.signature != signature
                        if changed { output(frame); signature = frame.signature }
                        emitJSON(["kind": "status", "state": "watching", "detail": "正在跟随微信 · \(frame.title)",
                                  "title": frame.title, "session": frame.session, "signature": frame.signature,
                                  "windowID": frame.windowID, "pid": frame.pid, "count": frame.messages.count,
                                  "changed": changed, "ts": Date().timeIntervalSince1970])
                    }
                } catch ChatError.captureBlocked {
                    signature = ""
                    emitJSON(["kind": "status", "state": "blocked", "detail": "微信开启了防截屏，言外看不到微信窗口里的字。可以改用「复制或截图」：在微信里复制对方的话，或用微信自带截图（⌃⌘A）框住聊天，言外会自动分析。"])
                } catch ChatError.noWindow {
                    signature = ""
                    emitJSON(["kind": "status", "state": "no-window", "detail": "没找到微信聊天窗口，请打开微信并进入一个聊天。"])
                } catch {
                    signature = ""
                    emitJSON(["kind": "status", "state": CGPreflightScreenCaptureAccess() ? "idle" : "no-permission",
                              "detail": "暂时读不到微信窗口，请检查屏幕录制权限并重新打开聊天。"])
                }
            }
            try? await Task.sleep(nanoseconds: 1_000_000_000)
        }
    }
}

// Screenshots taken with WeChat's own tool land on the pasteboard, and WeChat does not
// block its own screenshots. Only a fresh image is read; it is never written to disk.
@MainActor func pasteboardImage(_ board: NSPasteboard) -> CGImage? {
    let types = board.types ?? []
    // A copied Finder file also carries its icon as an image; that is not a screenshot.
    if types.contains(.fileURL) { return nil }
    guard types.contains(.png) || types.contains(.tiff),
          let image = NSImage(pasteboard: board) else { return nil }
    return image.cgImage(forProposedRect: nil, context: nil, hints: nil)
}
func watchPasteboard() async -> Never {
    signal(SIGTERM) { _ in exit(0) }; signal(SIGINT) { _ in exit(0) }; signal(SIGPIPE, SIG_IGN)
    FileHandle.standardInput.readabilityHandler = { handle in
        if handle.availableData.isEmpty { exit(0) }
    }
    // Whatever is on the pasteboard at start is old; only later changes count.
    var seen = await MainActor.run { NSPasteboard.general.changeCount }
    while true {
        try? await Task.sleep(nanoseconds: 400_000_000)
        let last = seen
        let (count, image) = await MainActor.run { () -> (Int, CGImage?) in
            let board = NSPasteboard.general
            return board.changeCount == last ? (last, nil) : (board.changeCount, pasteboardImage(board))
        }
        if count == seen { continue }
        seen = count
        guard let image else { continue }
        emitJSON(["kind": "status", "state": "reading", "detail": "正在识别截图里的文字…"])
        do {
            let lines = try recognizeCrop(image)
            if lines.contains(where: { $0.from != "unknown" }) {
                emitJSON(["kind": "screenshot", "messages": lines.map { ["from": $0.from, "text": $0.text] }])
            } else {
                emitJSON(["kind": "status", "state": "idle", "detail": "这张截图里没认出聊天文字。框选聊天气泡那一块再截一次试试。"])
            }
        } catch {
            emitJSON(["kind": "status", "state": "idle", "detail": "截图识别失败，请再截一次。"])
        }
    }
}
