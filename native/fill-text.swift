import AppKit
import ApplicationServices

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func appDescription(_ app: NSRunningApplication?) -> [String: Any] {
    guard let app = app else { return [:] }
    return ["pid": app.processIdentifier, "name": app.localizedName ?? "", "bundleID": app.bundleIdentifier ?? ""]
}
func isDraftEditor(role: String, subrole: String) -> Bool {
    role == kAXTextAreaRole && subrole != kAXSecureTextFieldSubrole
}
func appendedDraft(_ draft: String, _ text: String) -> String? {
    guard !text.isEmpty, text.count <= 1200 else { return nil }
    return draft + text
}
func fallback(_ reason: String, permission: String? = nil) {
    var result: [String: Any] = ["filled": false, "reason": reason]
    if let permission = permission { result["permission"] = permission }
    emitJSON(result)
}
@main struct FillText {
    @MainActor static func main() async {
        let args = CommandLine.arguments
        if args.contains("--track-frontmost") {
            signal(SIGTERM) { _ in exit(0) }; signal(SIGINT) { _ in exit(0) }; signal(SIGPIPE, SIG_IGN)
            FileHandle.standardInput.readabilityHandler = { if $0.availableData.isEmpty { exit(0) } }
            emitJSON(appDescription(NSWorkspace.shared.frontmostApplication))
            let observer = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { notification in
                emitJSON(appDescription(notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication))
            }
            // Keep the AppKit main run loop alive while only observing app identities.
            while true { try? await Task.sleep(nanoseconds: 60_000_000_000); _ = observer }
        }
        if args.contains("--self-test") {
            guard appendedDraft("已有草稿\n", "候选💙") == "已有草稿\n候选💙",
                  appendedDraft("草稿", "") == nil, appendedDraft("草稿", String(repeating: "文", count: 1201)) == nil,
                  isDraftEditor(role: kAXTextAreaRole, subrole: ""),
                  !isDraftEditor(role: kAXTextAreaRole, subrole: kAXSecureTextFieldSubrole),
                  !isDraftEditor(role: kAXButtonRole, subrole: ""), !isDraftEditor(role: kAXTextFieldRole, subrole: "") else {
                emitJSON(["ok": false]); exit(1)
            }
            emitJSON(["ok": true, "detail": "草稿追加、长度及不可写角色边界通过；未调用 AX 写入。"]); return
        }
        let app = NSWorkspace.shared.frontmostApplication
        let trusted = AXIsProcessTrusted() // no AX prompt, no permission setting mutation
        if args.count >= 2 && args[1] == "--dry-run" {
            var result = appDescription(app)
            result["targetAvailable"] = app != nil
            if app == nil { result["name"] = "当前环境无法取得前台应用" }
            result["dryRun"] = true; result["accessibilityGranted"] = trusted
            result["textLength"] = args.count > 2 ? args[2].count : 0
            if trusted, let raw = attribute(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute) {
                let element = raw as! AXUIElement
                result["role"] = attribute(element, kAXRoleAttribute) as? String ?? "unknown"
            } else { result["role"] = "不可读取（辅助功能未授权或没有焦点）" }
            emitJSON(result); return
        }
        guard args.count == 2, args[1] == "--write",
              let payload = try? JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as? [String: Any],
              let text = payload["text"] as? String, !text.isEmpty, text.count <= 1200,
              let ownerPID = payload["ownerPID"] as? Int32 else { fallback("invalid-target"); return }
        guard trusted else { fallback("no-permission", permission: "accessibility"); return }
        guard let target = payload["target"] as? [String: Any], let pid = target["pid"] as? Int32,
              let expectedBundle = target["bundleID"] as? String else { fallback("invalid-target"); return }
        if let expectedChat = payload["wechat"] as? [String: Any], expectedChat["pid"] as? Int32 != pid {
            fallback("stale-target"); return
        }
        guard let targetApp = NSRunningApplication(processIdentifier: pid), !targetApp.isTerminated,
              targetApp.bundleIdentifier == expectedBundle, pid != ownerPID else { fallback("stale-target"); return }
        // Only reactivate the saved app if Yanwai took focus; never hijack a different app.
        guard let foreground = NSWorkspace.shared.frontmostApplication,
              foreground.processIdentifier == pid || foreground.processIdentifier == ownerPID else { fallback("stale-target"); return }
        if foreground.processIdentifier != pid {
            guard targetApp.activate(options: [.activateIgnoringOtherApps]) else { fallback("not-focused"); return }
            try? await Task.sleep(nanoseconds: 180_000_000)
        }
        var verifiedChat: ChatSnapshot?
        if wechatNames.contains(targetApp.localizedName ?? "") {
            guard let expected = payload["wechat"] as? [String: Any],
                  let windowID = expected["windowID"] as? UInt32,
                  let signature = expected["signature"] as? String, CGPreflightScreenCaptureAccess() else { fallback("unverified-chat"); return }
            do {
                let actual = try await readWechat(id: windowID)
                guard actual.pid == pid, actual.signature == signature else { fallback("stale-session"); return }
                verifiedChat = actual
            } catch { fallback("unverified-chat"); return }
        }
        let system = AXUIElementCreateSystemWide()
        guard let raw = attribute(system, kAXFocusedUIElementAttribute) else { fallback("no-editor"); return }
        let element = raw as! AXUIElement
        var elementPID: pid_t = 0
        AXUIElementGetPid(element, &elementPID)
        let role = attribute(element, kAXRoleAttribute) as? String ?? ""
        let subrole = attribute(element, kAXSubroleAttribute) as? String ?? ""
        // Text areas only: avoid search fields, secure fields and transaction controls.
        guard elementPID == pid, isDraftEditor(role: role, subrole: subrole),
              let current = attribute(element, kAXValueAttribute) as? String else { fallback("not-writable"); return }
        if let chat = verifiedChat {
            guard let rawWindow = attribute(element, kAXWindowAttribute) else { fallback("unverified-chat"); return }
            let axWindow = rawWindow as! AXUIElement
            guard let position = attribute(axWindow, kAXPositionAttribute), let size = attribute(axWindow, kAXSizeAttribute),
                  CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { fallback("unverified-chat"); return }
            var origin = CGPoint.zero, extent = CGSize.zero
            guard AXValueGetValue(position as! AXValue, .cgPoint, &origin), AXValueGetValue(size as! AXValue, .cgSize, &extent),
                  zip([origin.x, origin.y, extent.width, extent.height], chat.windowBounds).allSatisfy({ abs($0 - $1) < 3 }) else {
                fallback("stale-session"); return
            }
        }
        var writable = DarwinBoolean(false)
        guard AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &writable) == .success, writable.boolValue else { fallback("not-writable"); return }
        // Recheck focus and draft immediately before writing. Never send a keyboard event.
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
              let latest = attribute(system, kAXFocusedUIElementAttribute), CFEqual(latest, element),
              attribute(element, kAXValueAttribute) as? String == current else { fallback("stale-target"); return }
        guard let combined = appendedDraft(current, text) else { fallback("invalid-text"); return }
        guard AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, combined as CFString) == .success else { fallback("not-writable"); return }
        guard attribute(element, kAXValueAttribute) as? String == combined else {
            // An uncertain write must not silently overwrite the user's changed draft.
            fallback("verify-failed"); return
        }
        emitJSON(["filled": true, "app": targetApp.localizedName ?? "", "detail": "已填入，发送由你决定。"])
    }
}
