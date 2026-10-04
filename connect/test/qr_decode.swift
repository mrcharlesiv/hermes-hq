// Decodes QR matrices (one per line of stdin: rows of 0/1 joined by "|", a tab, then the expected text) with Apple's
// Vision barcode reader and checks each reads back exactly. Used by gateway-edge/test/qr.test.mjs.
import Foundation
import Vision
import CoreGraphics

var failures = 0, count = 0
while let line = readLine() {
    let parts = line.split(separator: "\t", maxSplits: 1).map(String.init)
    guard parts.count == 2 else { continue }
    let rows = parts[0].split(separator: "|").map { Array($0) }
    let n = rows.count, scale = 8, quiet = 4, side = (n + quiet * 2) * scale
    var pixels = [UInt8](repeating: 255, count: side * side)
    for y in 0..<n { for x in 0..<n where rows[y][x] == "1" {
        for dy in 0..<scale { for dx in 0..<scale { pixels[((y + quiet) * scale + dy) * side + (x + quiet) * scale + dx] = 0 } }
    } }
    let provider = CGDataProvider(data: Data(pixels) as CFData)!
    let image = CGImage(width: side, height: side, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: side, space: CGColorSpaceCreateDeviceGray(),
                        bitmapInfo: CGBitmapInfo(rawValue: 0), provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
    let request = VNDetectBarcodesRequest(); request.symbologies = [.qr]
    try? VNImageRequestHandler(cgImage: image).perform([request])
    let decoded = request.results?.first?.payloadStringValue
    count += 1
    if decoded != parts[1] { failures += 1; print("FAIL version-size \(n): expected \(parts[1].prefix(40))… got \(decoded ?? "nothing")") }
}
print(failures == 0 ? "PASS: \(count) QR codes decoded exactly by Vision" : "FAIL: \(failures) of \(count)")
exit(failures == 0 ? 0 : 1)
