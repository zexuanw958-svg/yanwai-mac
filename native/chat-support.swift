import AppKit
import Vision
import ScreenCaptureKit
import CoreMedia
import CoreImage
import CryptoKit

// Shared by watch and fill: identical, conservative OCR session identity.
let wechatNames: Set<String> = ["微信", "WeChat", "Weixin"]
func emitJSON(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
       let text = String(data: data, encoding: .utf8) { print(text); fflush(stdout) }
}
struct ChatLine: Codable, Equatable {
    let from: String
    var text: String
}
struct ChatSnapshot: Codable {
    let title: String
    let windowID: UInt32
    let pid: Int32
    let messages: [ChatLine]
    var windowBounds: [Double] = []
    var session: String { "\(pid):\(windowID):\(title)" }
    var signature: String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let data = (try? encoder.encode(messages)) ?? Data()
        return SHA256.hash(data: Data(session.utf8) + data).map { String(format: "%02x", $0) }.joined()
    }
}
struct TextBox { let text: String; let rect: CGRect }
enum ChatError: Error { case noWindow, captureFailed, captureBlocked }

func recognizeChat(_ image: CGImage, windowID: UInt32 = 0, pid: Int32 = 0) throws -> ChatSnapshot {
    return classifyChat(try ocrBoxes(image), windowID: windowID, pid: pid)
}
func ocrBoxes(_ image: CGImage) throws -> [TextBox] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = true
    try VNImageRequestHandler(cgImage: image).perform([request])
    let boxes: [TextBox] = (request.results ?? []).compactMap { observation in
        guard let text = observation.topCandidates(1).first?.string, !text.isEmpty else { return nil }
        let b = observation.boundingBox
        return TextBox(text: text, rect: CGRect(x: b.minX, y: 1 - b.maxY, width: b.width, height: b.height))
    }
    return boxes
}
func classifyChat(_ observations: [TextBox], windowID: UInt32 = 0, pid: Int32 = 0) -> ChatSnapshot {
    let boxes = observations.sorted { $0.rect.minY < $1.rect.minY }
    // The header anchors the chat column, excluding the navigation/conversation list.
    let header = boxes.first { $0.rect.minX > 0.24 && $0.rect.maxX < 0.92 && $0.rect.midY > 0.025 && $0.rect.midY < 0.12 }
    let title = header?.text.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let chatLeft = max(0.26, min(0.45, (header?.rect.minX ?? 0.33) - 0.035))
    let chatWidth = 1 - chatLeft
    var grouped: [(line: ChatLine, rect: CGRect)] = []
    for box in boxes where box.rect.minX >= chatLeft && box.rect.midY >= 0.14 && box.rect.maxY <= 0.76 {
        let left = (box.rect.minX - chatLeft) / chatWidth
        let right = (box.rect.maxX - chatLeft) / chatWidth
        let from: String
        if left < 0.23 && right < 0.83 { from = "them" }
        else if right > 0.83 && left > 0.24 { from = "me" }
        else { from = "unknown" }
        // Adjacent wrapped lines must share an edge and have a small vertical gap.
        if let last = grouped.last, from == last.line.from, from != "unknown",
           box.rect.minY - last.rect.maxY < min(box.rect.height, last.rect.height) * 0.7,
           box.rect.minY >= last.rect.maxY - 0.005,
           abs(from == "them" ? box.rect.minX - last.rect.minX : box.rect.maxX - last.rect.maxX) < 0.025 {
            grouped[grouped.count - 1] = (ChatLine(from: from, text: last.line.text + "\n" + box.text), last.rect.union(box.rect))
        } else { grouped.append((ChatLine(from: from, text: box.text), box.rect)) }
    }
    return ChatSnapshot(title: title, windowID: windowID, pid: pid, messages: grouped.suffix(20).map(\.line))
}

func wechatWindow(id: UInt32? = nil) async throws -> SCWindow {
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    let candidates = content.windows.filter { window in
        guard let app = window.owningApplication, wechatNames.contains(app.applicationName),
              window.windowLayer == 0, window.frame.width >= 500, window.frame.height >= 350 else { return false }
        // Exact names only; WeCom/WeRead and other siblings never pass.
        return id == nil || window.windowID == id
    }
    guard let window = candidates.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else { throw ChatError.noWindow }
    return window
}

// macOS 13 uses one SCStream frame; 14+ uses the screenshot API with the same
// single-window filter. Neither path includes an overlaid Yanwai window or audio.
final class SingleFrame: NSObject, SCStreamOutput, @unchecked Sendable {
    var completion: CheckedContinuation<CGImage, Error>?
    let lock = NSLock()
    func finish(_ result: Result<CGImage, Error>) {
        lock.lock(); let pending = completion; completion = nil; lock.unlock()
        pending?.resume(with: result)
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let status = attachments.first?[.status] as? Int, status == SCFrameStatus.complete.rawValue,
              let buffer = sampleBuffer.imageBuffer else { return }
        let ci = CIImage(cvPixelBuffer: buffer)
        if let image = CIContext().createCGImage(ci, from: ci.extent) { finish(.success(image)) }
    }
}
func captureWindow(_ window: SCWindow) async throws -> CGImage {
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let config = SCStreamConfiguration()
    config.width = Int(window.frame.width * 2); config.height = Int(window.frame.height * 2)
    config.showsCursor = false; config.capturesAudio = false
    if #available(macOS 14.0, *) {
        config.ignoreShadowsSingleWindow = true
        return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    }
    let output = SingleFrame(), queue = DispatchQueue(label: "yanwai.single-frame")
    let stream = SCStream(filter: filter, configuration: config, delegate: nil)
    try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: queue)
    do {
        let image = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<CGImage, Error>) in
            output.completion = continuation
            queue.asyncAfter(deadline: .now() + 3) { output.finish(.failure(ChatError.captureFailed)) }
            Task { do { try await stream.startCapture() } catch { output.finish(.failure(error)) } }
        }
        try await stream.stopCapture(); return image
    } catch { try? await stream.stopCapture(); throw error }
}
// Developer-only: YANWAI_DEBUG_DIR saves the last captured frame and OCR boxes there.
// Unset in normal use, so nothing is written to disk.
func debugDump(_ image: CGImage, _ boxes: [TextBox]) {
    guard let dir = ProcessInfo.processInfo.environment["YANWAI_DEBUG_DIR"], !dir.isEmpty else { return }
    let url = URL(fileURLWithPath: dir)
    if let dest = CGImageDestinationCreateWithURL(url.appendingPathComponent("capture.png") as CFURL, "public.png" as CFString, 1, nil) {
        CGImageDestinationAddImage(dest, image, nil); CGImageDestinationFinalize(dest)
    }
    let rows = boxes.map { ["text": $0.text, "x": $0.rect.minX, "y": $0.rect.minY, "w": $0.rect.width, "h": $0.rect.height] as [String: Any] }
    if let data = try? JSONSerialization.data(withJSONObject: ["width": image.width, "height": image.height, "boxes": rows], options: [.prettyPrinted]) {
        try? data.write(to: url.appendingPathComponent("boxes.json"))
    }
}
// WeChat can mark its window as not shareable (NSWindowSharingNone). Every capture of it
// then comes back blank, so detect that and tell the user instead of OCR-ing white pixels.
func captureBlocked(_ windowID: UInt32) -> Bool {
    guard let info = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(windowID)) as? [[String: Any]],
          let state = info.first?[kCGWindowSharingState as String] as? Int else { return false }
    return state == 0
}
func isBlank(_ image: CGImage) -> Bool {
    guard let data = image.dataProvider?.data, let bytes = CFDataGetBytePtr(data) else { return false }
    let length = CFDataGetLength(data), step = max(4, (length / 4000) & ~3)
    var first: (UInt8, UInt8, UInt8)? = nil
    for offset in stride(from: 0, to: length - 3, by: step) {
        let pixel = (bytes[offset], bytes[offset + 1], bytes[offset + 2])
        if first == nil { first = pixel } else if pixel != first! { return false }
    }
    return true
}
func readWechat(id: UInt32? = nil) async throws -> ChatSnapshot {
    let window = try await wechatWindow(id: id)
    if captureBlocked(window.windowID) { throw ChatError.captureBlocked }
    let image = try await captureWindow(window)
    if ProcessInfo.processInfo.environment["YANWAI_DEBUG_DIR"] != nil { debugDump(image, (try? ocrBoxes(image)) ?? []) }
    if isBlank(image) { throw ChatError.captureBlocked }
    var snapshot = try recognizeChat(image, windowID: window.windowID, pid: window.owningApplication?.processID ?? 0)
    snapshot.windowBounds = [window.frame.minX, window.frame.minY, window.frame.width, window.frame.height]
    return snapshot
}

// A user-framed screenshot (e.g. WeChat's own ⌃⌘A tool) has no window chrome to anchor on.
// WeChat paints the user's own bubbles green in both light and dark mode, so bubble colour
// decides "me"; otherwise the side of the frame the line hugs decides.
struct PixelSampler {
    let width: Int, height: Int
    private let data: [UInt8]
    init?(_ image: CGImage) {
        let width = image.width, height = image.height
        guard width > 0, height > 0 else { return nil }
        var buffer = [UInt8](repeating: 0, count: width * height * 4)
        let drawn: Bool = buffer.withUnsafeMutableBytes { raw in
            guard let context = CGContext(data: raw.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                          space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height)); return true
        }
        guard drawn else { return nil }
        self.width = width; self.height = height; data = buffer
    }
    // x/y are normalised with y measured from the top.
    func isGreen(_ x: CGFloat, _ y: CGFloat) -> Bool {
        let px = Int(x * CGFloat(width)), py = Int(y * CGFloat(height))
        guard px >= 0, py >= 0, px < width, py < height else { return false }
        let i = (py * width + px) * 4
        let r = Int(data[i]), g = Int(data[i + 1]), b = Int(data[i + 2])
        return g > 140 && g - r > 30 && g - b > 35
    }
}
func classifyCrop(_ observations: [TextBox], sampler: PixelSampler?) -> [ChatLine] {
    let boxes = observations.sorted { $0.rect.minY < $1.rect.minY }
    var grouped: [(line: ChatLine, rect: CGRect)] = []
    for box in boxes {
        var from: String
        let pad = sampler.map { 5 / CGFloat($0.width) } ?? 0
        let padY = sampler.map { 5 / CGFloat($0.height) } ?? 0
        let r = box.rect
        let green = sampler.map { s in
            [(r.minX - pad, r.midY), (r.maxX + pad, r.midY), (r.midX, r.minY - padY), (r.midX, r.maxY + padY)]
                .filter { s.isGreen($0.0, $0.1) }.count >= 2
        } ?? false
        let leftGap = r.minX, rightGap = 1 - r.maxX
        if green { from = "me" }
        else if abs(leftGap - rightGap) < 0.1 && r.width < 0.45 { from = "unknown" }  // centred time stamps and notices
        else { from = leftGap < rightGap ? "them" : "me" }
        if let last = grouped.last, from == last.line.from, from != "unknown",
           r.minY - last.rect.maxY < min(r.height, last.rect.height) * 0.7,
           r.minY >= last.rect.maxY - 0.005,
           abs(from == "them" ? r.minX - last.rect.minX : r.maxX - last.rect.maxX) < 0.04 || (from == "me" && green) {
            grouped[grouped.count - 1] = (ChatLine(from: from, text: last.line.text + "\n" + box.text), last.rect.union(r))
        } else { grouped.append((ChatLine(from: from, text: box.text), r)) }
    }
    return grouped.suffix(20).map(\.line)
}
func recognizeCrop(_ image: CGImage) throws -> [ChatLine] {
    return classifyCrop(try ocrBoxes(image), sampler: PixelSampler(image))
}
