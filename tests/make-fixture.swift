import AppKit
// Synthetic chat layout only. No screenshot, account or real conversation data.
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1000, pixelsHigh: 800, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
NSColor(calibratedWhite: 0.96, alpha: 1).setFill(); NSRect(x: 0, y: 0, width: 1000, height: 800).fill()
NSColor(calibratedWhite: 0.9, alpha: 1).setFill(); NSRect(x: 0, y: 0, width: 300, height: 800).fill()
func text(_ value: String, _ x: CGFloat, _ y: CGFloat, size: CGFloat = 26) {
    (value as NSString).draw(at: NSPoint(x: x, y: y), withAttributes: [.font: NSFont.systemFont(ofSize: size), .foregroundColor: NSColor.black])
}
func bubble(_ value: String, _ x: CGFloat, _ y: CGFloat, _ width: CGFloat, mine: Bool = false) {
    (mine ? NSColor(calibratedRed: 0.67, green: 0.88, blue: 0.49, alpha: 1) : NSColor.white).setFill()
    NSBezierPath(roundedRect: NSRect(x:x-12, y:y-8, width:width, height:52), xRadius:8, yRadius:8).fill()
    text(value,x,y)
}
text("合成测试聊天",340,745)
text("搜索",70,740); text("左侧列表干扰项",45,615,size:20)
text("12:00",650,650,size:20)
bubble("周末吃什么？",365,560,230)
bubble("这次我来安排。",735,455,225,mine:true)
bubble("好呀，等你消息。",365,345,260)
text("输入区不应该被识别",370,65,size:24)
NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
