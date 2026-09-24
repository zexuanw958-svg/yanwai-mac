import AppKit
import Foundation

// Read display geometry only. No screenshots, accessibility, or app contents.
let displays: [[String: Any]] = NSScreen.screens.map { screen in
    let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
    var value: [String: Any] = ["id": number?.intValue ?? -1]
    if let left = screen.auxiliaryTopLeftArea,
       let right = screen.auxiliaryTopRightArea,
       screen.safeAreaInsets.top > 0, right.minX > left.maxX {
        value["notch"] = [
            "offsetX": left.maxX - screen.frame.minX,
            "width": right.minX - left.maxX,
            "height": screen.safeAreaInsets.top
        ]
    }
    return value
}
let data = try JSONSerialization.data(withJSONObject: displays)
print(String(data: data, encoding: .utf8)!)
