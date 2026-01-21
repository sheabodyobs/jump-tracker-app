import AVFoundation
import Foundation
import Photos
import React

@objc(RealFrameProvider)
class RealFrameProvider: NSObject {
  @objc
  static func requiresMainQueueSetup() -> Bool {
    return false
  }

  @objc(sampleFrames:timestampsMs:options:resolver:rejecter:)
  func sampleFrames(
    _ videoUri: String,
    timestampsMs: [NSNumber],
    options: NSDictionary?,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.global(qos: .userInitiated).async {
      self.sampleFramesInternal(videoUri, timestampsMs: timestampsMs, options: options) { result in
        DispatchQueue.main.async {
          resolve(result)
        }
      }
    }
  }

  @objc(getVideoMetadata:resolver:rejecter:)
  func getVideoMetadata(
    _ videoUri: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.global(qos: .userInitiated).async {
      let result = self.videoMetadataInternal(videoUri)
      DispatchQueue.main.async {
        resolve(result)
      }
    }
  }

  private func videoMetadataInternal(_ videoUri: String) -> [String: Any] {
    if videoUri.hasPrefix("ph://") {
      return [
        "measurementStatus": "synthetic_placeholder",
        "debug": ["provider": "ios_avfoundation", "notes": ["ph:// URIs are not supported yet."]],
        "error": ["code": "PH_URI_UNSUPPORTED", "message": "ph:// URIs are not supported yet."]
      ]
    }

    guard let url = URL(string: videoUri) else {
      return [
        "measurementStatus": "synthetic_placeholder",
        "debug": ["provider": "ios_avfoundation", "notes": ["Invalid video URI."]],
        "error": ["code": "INVALID_URI", "message": "Invalid video URI."]
      ]
    }

    let asset = AVURLAsset(url: url)
    let durationSeconds = CMTimeGetSeconds(asset.duration)
    let durationMs = durationSeconds.isFinite ? Int(durationSeconds * 1000) : 0
    let nominalFps = asset.tracks(withMediaType: .video).first?.nominalFrameRate ?? 0

    if nominalFps <= 0 {
      return [
        "measurementStatus": "synthetic_placeholder",
        "durationMs": durationMs > 0 ? durationMs : nil as Any,
        "debug": ["provider": "ios_avfoundation", "notes": ["FPS unavailable."]],
        "error": ["code": "FPS_UNAVAILABLE", "message": "Could not determine FPS."]
      ]
    }

    return [
      "measurementStatus": "real",
      "durationMs": durationMs > 0 ? durationMs : nil as Any,
      "nominalFps": nominalFps,
      "debug": ["provider": "ios_avfoundation", "notes": []]
    ]
  }

  private func sampleFramesInternal(
    _ videoUri: String,
    timestampsMs: [NSNumber],
    options: NSDictionary?,
    completion: @escaping ([String: Any]) -> Void
  ) {
    let format = (options?["format"] as? String) ?? "rgba"
    let maxWidth = (options?["maxWidth"] as? NSNumber)?.intValue ?? 256

    if videoUri.hasPrefix("ph://") {
      completion([
        "measurementStatus": "synthetic_placeholder",
        "frames": [],
        "debug": ["provider": "ios_avfoundation", "notes": ["ph:// URIs are not supported yet."]],
        "error": ["code": "PH_URI_UNSUPPORTED", "message": "ph:// URIs are not supported yet."]
      ])
      return
    }

    guard let url = URL(string: videoUri) else {
      completion([
        "measurementStatus": "synthetic_placeholder",
        "frames": [],
        "debug": ["provider": "ios_avfoundation", "notes": ["Invalid video URI."]],
        "error": ["code": "INVALID_URI", "message": "Invalid video URI."]
      ])
      return
    }

    let asset = AVURLAsset(url: url)
    let durationSeconds = CMTimeGetSeconds(asset.duration)
    let durationMs = durationSeconds.isFinite ? Int(durationSeconds * 1000) : 0
    let nominalFps = asset.tracks(withMediaType: .video).first?.nominalFrameRate ?? 0

    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.requestedTimeToleranceBefore = .zero
    generator.requestedTimeToleranceAfter = .zero
    if maxWidth > 0 {
      generator.maximumSize = CGSize(width: maxWidth, height: maxWidth)
    }

    var frames: [[String: Any]] = []
    var notes: [String] = []

    for timeMs in timestampsMs {
      let seconds = timeMs.doubleValue / 1000.0
      let requestedTime = CMTimeMakeWithSeconds(seconds, preferredTimescale: 600)
      var actualTime = CMTime.zero
      do {
        let cgImage = try generator.copyCGImage(at: requestedTime, actualTime: &actualTime)
        let frameInfo = self.encodeFrame(cgImage: cgImage, actualTime: actualTime, format: format)
        frames.append(frameInfo)
      } catch {
        notes.append("Failed to extract frame at \(timeMs)ms: \(error.localizedDescription)")
      }
    }

    if frames.isEmpty {
      completion([
        "measurementStatus": "synthetic_placeholder",
        "frames": [],
        "durationMs": durationMs > 0 ? durationMs : nil as Any,
        "nominalFps": nominalFps > 0 ? nominalFps : nil as Any,
        "debug": ["provider": "ios_avfoundation", "notes": notes],
        "error": ["code": "NO_FRAMES", "message": "No frames could be extracted."]
      ])
      return
    }

    completion([
      "measurementStatus": "real",
      "durationMs": durationMs > 0 ? durationMs : nil as Any,
      "nominalFps": nominalFps > 0 ? nominalFps : nil as Any,
      "frames": frames,
      "debug": ["provider": "ios_avfoundation", "notes": notes]
    ])
  }

  private func encodeFrame(cgImage: CGImage, actualTime: CMTime, format: String) -> [String: Any] {
    let width = cgImage.width
    let height = cgImage.height
    let tMs = Int(CMTimeGetSeconds(actualTime) * 1000.0)

    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let bytesPerPixel = 4
    let bytesPerRow = bytesPerPixel * width
    let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue

    var rgbaData = Data(count: height * bytesPerRow)
    rgbaData.withUnsafeMutableBytes { buffer in
      if let context = CGContext(
        data: buffer.baseAddress,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: bytesPerRow,
        space: colorSpace,
        bitmapInfo: bitmapInfo
      ) {
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
      }
    }

    if format == "luma" {
      var luma = Data(count: width * height)
      luma.withUnsafeMutableBytes { lumaBuffer in
        rgbaData.withUnsafeBytes { rgbaBuffer in
          let rgbaPtr = rgbaBuffer.bindMemory(to: UInt8.self)
          let lumaPtr = lumaBuffer.bindMemory(to: UInt8.self)
          for y in 0..<height {
            for x in 0..<width {
              let idx = (y * width + x) * 4
              let r = rgbaPtr[idx]
              let g = rgbaPtr[idx + 1]
              let b = rgbaPtr[idx + 2]
              let value = UInt8((0.299 * Double(r)) + (0.587 * Double(g)) + (0.114 * Double(b)))
              lumaPtr[y * width + x] = value
            }
          }
        }
      }

      return [
        "tMs": tMs,
        "width": width,
        "height": height,
        "format": "luma",
        "dataBase64": luma.base64EncodedString()
      ]
    }

    return [
      "tMs": tMs,
      "width": width,
      "height": height,
      "format": "rgba",
      "dataBase64": rgbaData.base64EncodedString()
    ]
  }
}
