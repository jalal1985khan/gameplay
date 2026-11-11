import Foundation
import Darwin
import Vision
import ImageIO
import CoreGraphics

func emit(_ value: Double?) {
    let payload: [String: Any] = value.map { ["value": $0] } ?? [:]
    if let data = try? JSONSerialization.data(withJSONObject: payload),
       let line = String(data: data, encoding: .utf8) {
        print(line)
        fflush(stdout)
    }
}

while let line = readLine() {
    guard let data = Data(base64Encoded: line),
          let source = CGImageSourceCreateWithData(data as CFData, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        emit(nil)
        continue
    }
    autoreleasepool {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .fast
        request.usesLanguageCorrection = false
        request.regionOfInterest = CGRect(x: 0.18, y: 0.12, width: 0.68, height: 0.78)
        do {
            try VNImageRequestHandler(cgImage: image).perform([request])
            let pattern = try NSRegularExpression(pattern: "(?i)(?:[x×]\\s*([0-9]{1,5}(?:[.,][0-9]{1,4})?)|([0-9]{1,5}(?:[.,][0-9]{1,4})?)\\s*[x×])")
            var best: (Double, Double)?
            for observation in request.results ?? [] {
                guard observation.boundingBox.height >= 0.045,
                      let candidate = observation.topCandidates(1).first else { continue }
                let text = candidate.string
                let range = NSRange(text.startIndex..., in: text)
                guard let match = pattern.firstMatch(in: text, range: range),
                      let numberRange = Range(match.range(at: match.range(at: 1).location != NSNotFound ? 1 : 2), in: text) else { continue }
                let number = Double(text[numberRange].replacingOccurrences(of: ",", with: "."))
                guard let number, number >= 1, number <= 1_000_000 else { continue }
                let box = observation.boundingBox
                let centerScore = 1.0 - abs(box.midX - 0.54) - abs(box.midY - 0.52)
                let score = Double(observation.boundingBox.height) * 4 + centerScore + Double(candidate.confidence) * 0.25
                if best == nil || score > best!.1 { best = (number, score) }
            }
            emit(best?.0)
        } catch {
            emit(nil)
        }
    }
}
