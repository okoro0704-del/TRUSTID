import Foundation
import CryptoKit

/**
 * eSFS on-disk `.tidvault` — chunked AES-256-GCM.
 * Layout matches Android TidVaultFormat (big-endian).
 */
enum TidVaultFormat {
  static let magic = "TIDV1"
  static let version: UInt8 = 1
  static let defaultChunk = 256 * 1024
  static let ext = "tidvault"

  static func encryptChunked(plain: Data, wrappingKey: SymmetricKey, chunkSize: Int = defaultChunk) throws -> Data {
    let cek = SymmetricKey(size: .bits256)
    let cekData = cek.withUnsafeBytes { Data($0) }
    let wrappedBox = try AES.GCM.seal(cekData, using: wrappingKey)
    guard let wrappedCombined = wrappedBox.combined else {
      throw NSError(domain: "TidVault", code: 1, userInfo: [NSLocalizedDescriptionKey: "wrap failed"])
    }

    let chunkCount = max(1, Int(ceil(Double(plain.count) / Double(chunkSize))))
    var out = Data()
    out.append(contentsOf: magic.utf8)
    out.append(version)
    out.append(u32(UInt32(chunkSize)))
    out.append(u32(UInt32(chunkCount)))
    out.append(u16(UInt16(wrappedCombined.count)))
    out.append(wrappedCombined)

    for i in 0..<chunkCount {
      let start = i * chunkSize
      let end = min(plain.count, start + chunkSize)
      let slice = plain.subdata(in: start..<end)
      let nonce = AES.GCM.Nonce()
      let box = try AES.GCM.seal(slice, using: cek, nonce: nonce)
      let nonceData = Data(nonce)
      let ct = box.ciphertext + box.tag
      out.append(u32(UInt32(i)))
      out.append(nonceData)
      out.append(u32(UInt32(ct.count)))
      out.append(ct)
    }
    return out
  }

  static func decryptChunked(blob: Data, wrappingKey: SymmetricKey) throws -> Data {
    guard blob.count > 20, String(data: blob.prefix(5), encoding: .utf8) == magic else {
      throw NSError(domain: "TidVault", code: 3, userInfo: [NSLocalizedDescriptionKey: "Not a tidvault file"])
    }
    var offset = 5
    let ver = blob[offset]; offset += 1
    guard ver == version else {
      throw NSError(domain: "TidVault", code: 4, userInfo: [NSLocalizedDescriptionKey: "Unsupported version"])
    }
    offset += 4 // chunkSize
    let chunkCount = Int(readU32(blob, offset)); offset += 4
    let wrapLen = Int(readU16(blob, offset)); offset += 2
    let wrapped = blob.subdata(in: offset..<(offset + wrapLen)); offset += wrapLen
    let sealed = try AES.GCM.SealedBox(combined: wrapped)
    let cekData = try AES.GCM.open(sealed, using: wrappingKey)
    let cek = SymmetricKey(data: cekData)

    var parts = [Data]()
    for n in 0..<chunkCount {
      let index = Int(readU32(blob, offset)); offset += 4
      let iv = blob.subdata(in: offset..<(offset + 12)); offset += 12
      let ctLen = Int(readU32(blob, offset)); offset += 4
      let ct = blob.subdata(in: offset..<(offset + ctLen)); offset += ctLen
      let nonce = try AES.GCM.Nonce(data: iv)
      guard ctLen > 16 else { throw NSError(domain: "TidVault", code: 5) }
      let tag = ct.suffix(16)
      let cipher = ct.prefix(ctLen - 16)
      let box = try AES.GCM.SealedBox(nonce: nonce, ciphertext: cipher, tag: tag)
      let plain = try AES.GCM.open(box, using: cek)
      guard index == n else {
        throw NSError(domain: "TidVault", code: 6, userInfo: [NSLocalizedDescriptionKey: "Chunk order corrupt"])
      }
      parts.append(plain)
    }
    return parts.reduce(Data(), +)
  }

  private static func u32(_ v: UInt32) -> Data {
    var be = v.bigEndian
    return Data(bytes: &be, count: 4)
  }

  private static func u16(_ v: UInt16) -> Data {
    var be = v.bigEndian
    return Data(bytes: &be, count: 2)
  }

  private static func readU32(_ data: Data, _ offset: Int) -> UInt32 {
    data.subdata(in: offset..<(offset + 4)).withUnsafeBytes { $0.load(as: UInt32.self).bigEndian }
  }

  private static func readU16(_ data: Data, _ offset: Int) -> UInt16 {
    data.subdata(in: offset..<(offset + 2)).withUnsafeBytes { $0.load(as: UInt16.self).bigEndian }
  }
}
