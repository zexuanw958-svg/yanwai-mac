import AppKit
// Synthetic WeChat-style screenshot crop (no window chrome). Arg 2 "dark" switches theme.
// No real account or conversation data.
let dark = CommandLine.arguments.count > 2 && CommandLine.arguments[2] == "dark"
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 900, pixelsHigh: 620, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
(dark ? NSColor(calibratedWhite: 0.1, alpha: 1) : NSColor(calibratedWhite: 0.95, alpha: 1)).setFill()
NSRect(x: 0, y: 0, width: 900, height: 620).fill()
let ink = dark ? NSColor(calibratedWhite: 0.9, alpha: 1) : NSColor.black
func text(_ value: String, _ x: CGFloat, _ y: CGFloat, size: CGFloat = 26, color: NSColor = ink) {
    (value as NSString).draw(at: NSPoint(x: x, y: y), withAttributes: [.font: NSFont.systemFont(ofSize: size), .foregroundColor: color])
}
func bubble(_ lines: [String], _ x: CGFloat, _ top: CGFloat, _ width: CGFloat, mine: Bool = false) {
    let height = CGFloat(lines.count) * 34 + 20
    let fill = mine ? (dark ? NSColor(calibratedRed: 0.17, green: 0.68, blue: 0.4, alpha: 1) : NSColor(calibratedRed: 0.58, green: 0.93, blue: 0.41, alpha: 1))
                    : (dark ? NSColor(calibratedWhite: 0.2, alpha: 1) : NSColor.white)
    fill.setFill()
    NSBezierPath(roundedRect: NSRect(x: x - 14, y: top - height, width: width, height: height), xRadius: 8, yRadius: 8).fill()
    for (i, line) in lines.enumerated() { text(line, x, top - 44 - CGFloat(i) * 34, color: mine && !dark ? .black : ink) }
}
(NSColor.gray).setFill(); NSRect(x: 20, y: 530, width: 60, height: 60).fill(); NSRect(x: 820, y: 360, width: 60, height: 60).fill()
text("昨天 21:40", 390, 590, size: 18, color: .gray)
bubble(["你最近是不是很忙呀"], 110, 580, 290)
bubble(["还好，这周项目收尾", "周末就轻松了"], 520, 420, 290, mine: true)
bubble(["那周末有空一起吃饭吗？"], 110, 250, 340)
NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
