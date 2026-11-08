import CoreGraphics
import CoreText
import Foundation
import PDFKit
import SwiftUI
import Testing
@testable import DesignSystem

// The printable certificate (docs/certificate/): its fonts, its layout
// against the design's own numbers (measured in Chrome), the long-name
// fitting, and the PDF it makes.

@Suite("Certificate fonts")
struct CertificateFontTests {
    @Test("The bundled Garamonds register and resolve by PostScript name", arguments: CertificateFace.allCases)
    func resolves(face: CertificateFace) {
        #expect(BrandFontRegistrar.registerCertificateFonts())
        let font = CertificateType.ctFont(face, points: 20)
        #expect(CTFontCopyPostScriptName(font) as String == face.postScriptName,
                "\(face.postScriptName) fell back to \(CTFontCopyPostScriptName(font))")
    }

    @Test("Each face's named instance sets its weight axis (600 / 400)", arguments: CertificateFace.allCases)
    func weight(face: CertificateFace) {
        let font = CertificateType.ctFont(face, points: 20)
        // 'wght' as a four-character code.
        let wght = NSNumber(value: 0x7767_6874)
        let variation = CTFontCopyVariation(font) as? [NSNumber: NSNumber] ?? [:]
        let value = variation[wght]?.doubleValue
        // A default instance may report no variation: then the font's own
        // default must be the weight (EB Garamond's is 400).
        if let value {
            #expect(Int(value.rounded()) == face.weight)
        } else {
            let axes = CTFontCopyVariationAxes(font) as? [[String: Any]] ?? []
            let axis = axes.first { ($0[kCTFontVariationAxisIdentifierKey as String] as? NSNumber) == wght }
            let def = (axis?[kCTFontVariationAxisDefaultValueKey as String] as? NSNumber)?.intValue
            #expect(def == face.weight, "\(face.postScriptName) has no wght of \(face.weight)")
        }
    }

    @Test("Cormorant's ligatures are off, so the PDF's text reads true")
    func ligatures() {
        #expect(CertificateFace.display.disablesLigatures)
        #expect(CertificateFace.displayItalic.disablesLigatures)
        #expect(!CertificateFace.body.disablesLigatures)
    }

    @Test("The licences ship beside the fonts")
    func licences() throws {
        for name in ["OFL-CormorantGaramond", "OFL-EBGaramond"] {
            let url = try #require(CertificateArt.bundle.url(forResource: name, withExtension: "txt", subdirectory: "Fonts"))
            let text = try String(contentsOf: url, encoding: .utf8)
            #expect(text.contains("SIL OPEN FONT LICENSE Version 1.1"))
        }
    }
}

@Suite("Certificate layout")
struct CertificateLayoutTests {
    private func baseline(_ layout: CertificateLayout, _ role: CertificateLayout.Role, _ index: Int = 0) -> CGFloat? {
        let lines = layout.lines.filter { $0.role == role }
        return index < lines.count ? lines[index].baseline : nil
    }

    private func near(_ a: CGFloat?, _ b: CGFloat) -> Bool {
        guard let a else { return false }
        return abs(a - b) < 0.01
    }

    @Test("The Deep dive's baselines are the design's (Chrome's layout, in CSS px)")
    func deepDive() {
        let layout = CertificateLayout.make(kind: .deepDive, name: "Alexandria Montgomery-Vasquez",
                                            dateText: "October 21, 2026")
        #expect(near(baseline(layout, .wordmark), 156))
        #expect(near(baseline(layout, .title), 219))
        #expect(near(baseline(layout, .presented), 288.594))
        #expect(near(baseline(layout, .name), 356.594))
        #expect(near(baseline(layout, .paragraph, 0), 419.188))
        #expect(near(baseline(layout, .paragraph, 1), 446.734))
        #expect(near(baseline(layout, .units, 0), 481.281))
        #expect(near(baseline(layout, .units, 1), 502.281))
        #expect(near(baseline(layout, .date), 679))
        #expect(near(baseline(layout, .footer), 740))
        #expect(layout.seal == CGRect(x: 458, y: 576, width: 140, height: 140))
        #expect(layout.dateRule == CGRect(x: 96, y: 691, width: 250, height: 1))
        #expect(layout.signatureRule == CGRect(x: 710, y: 691, width: 250, height: 1))
        #expect(layout.ornament == CGRect(x: 428, y: 242.59375, width: 200, height: 12))
        #expect(layout.nameRule.minY == 382.1875)
    }

    @Test("AI Basics' baselines are the design's; its signature label sits on one line")
    func basics() {
        let layout = CertificateLayout.make(kind: .basics, name: "Alexandria Montgomery-Vasquez",
                                            dateText: "October 21, 2026")
        #expect(near(baseline(layout, .wordmark), 164))
        #expect(near(baseline(layout, .title), 229))
        #expect(near(baseline(layout, .subtitle), 268.594))
        #expect(near(baseline(layout, .presented), 320.594))
        #expect(near(baseline(layout, .name), 388.594))
        #expect(near(baseline(layout, .paragraph, 0), 454.188))
        #expect(near(baseline(layout, .paragraph, 1), 483.188))
        #expect(near(baseline(layout, .date), 679))
        #expect(near(baseline(layout, .footer), 740))
        #expect(layout.ornament == nil)
        #expect(layout.lines.filter { $0.role == .units }.isEmpty)
        // AI Basics' columns are 290 px (the design's 250 px wraps the
        // label after "Family"), so both rules line up at 691.
        #expect(layout.dateRule == CGRect(x: 96, y: 691, width: 290, height: 1))
        #expect(layout.signatureRule == CGRect(x: 670, y: 691, width: 290, height: 1))
        #expect(layout.seal == CGRect(x: 458, y: 576, width: 140, height: 140))
        // Typed locals, for CI's slower Swift 6.1 (Xcode 16.4) type checker.
        let labels = layout.lines.filter { $0.role == .label }
        let labelTexts: [String] = labels.map { $0.text }
        #expect(labelTexts == ["DATE", "INSTRUCTOR OR FAMILY MEMBER"])
        // The signature label and the date label share a baseline.
        #expect(labels.count == 2 && labels[0].baseline == labels[1].baseline)
    }

    @Test("Each signature label fits its column on one line, clear of the seal", arguments: CertificateKind.allCases)
    func signatureLabelFits(kind: CertificateKind) throws {
        let layout = CertificateLayout.make(kind: kind, name: "Li Wei", dateText: "October 21, 2026")
        let label = try #require(layout.lines.last { $0.role == .label })
        let width = CertificateType.width(label.text, face: .body, px: label.sizePx, trackingPx: label.trackingPx)
        #expect(width <= layout.signatureRule.width, "\(label.text): \(width) px in \(layout.signatureRule.width)")
        #expect(layout.signatureRule.minY == layout.dateRule.minY)
        #expect(layout.dateRule.maxX <= layout.seal.minX - 48)
        #expect(layout.signatureRule.minX >= layout.seal.maxX + 48)
    }

    @Test("Two lines of name push the page down but never into the seal", arguments: CertificateKind.allCases)
    func twoLineNameFits(kind: CertificateKind) {
        let layout = CertificateLayout.make(kind: kind, name: "Christopher Alexander Montgomery-Vasquez de la Fuente Ramírez",
                                            dateText: nil)
        #expect(layout.name.lines.count == 2)
        #expect(layout.slack >= CertificateLayout.minimumSlack)
        // Every line inside the 864 px column.
        for line in layout.lines where line.role == .name {
            let width = CertificateType.width(line.text, face: .displayItalic, px: line.sizePx)
            #expect(width <= CertificateNameFit.maxWidth)
        }
    }

    @Test("The largest two-line names (57 px, 64 px) still clear the seal", arguments: CertificateKind.allCases)
    func largestTwoLineName(kind: CertificateKind) {
        // Two short words that each fit the column at any size, but not
        // together on one line at 57.5 px or more: two lines at the cap.
        let name = "Bartholomew-Maximilian Featherstonehaugh-Cholmondeley"
        let layout = CertificateLayout.make(kind: kind, name: name, dateText: nil)
        #expect(layout.name.lines.count == 2)
        #expect(layout.name.sizePx == (kind == .deepDive ? 57 : 64))
        #expect(layout.slack >= CertificateLayout.minimumSlack)
    }

    @Test("Two lines of name sit 1.12 em apart, so accents clear descenders", arguments: CertificateKind.allCases)
    func twoLineLeading(kind: CertificateKind) throws {
        let layout = CertificateLayout.make(kind: kind, name: "Maria Fernanda de los Santos Rodríguez-Ochoa",
                                            dateText: nil)
        let names = layout.lines.filter { $0.role == .name }
        try #require(names.count == 2)
        let gap = names[1].baseline - names[0].baseline
        #expect(gap >= 1.12 * layout.name.sizePx - 1)
        // Line 1's deepest descender (g, y) and line 2's tallest accented
        // capital (Å) don't meet, with the real font's ink.
        let font = CertificateType.ctFont(.displayItalic, points: layout.name.sizePx)
        func ink(_ text: String) -> CGRect {
            let line = CTLineCreateWithAttributedString(NSAttributedString(
                string: text, attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font]))
            return CTLineGetImageBounds(line, nil)
        }
        let descender = -ink("gy").minY
        let accent = ink("ÅÖÁ").maxY
        #expect(gap - descender - accent > 0, "\(gap) px between baselines; g \(descender), Å \(accent)")
    }

    @Test("No date leaves the line over \"Date\" blank")
    func noDate() {
        let layout = CertificateLayout.make(kind: .deepDive, name: "Li Wei", dateText: nil)
        #expect(layout.lines.contains { $0.role == .date } == false)
    }

    @Test("An empty name shows the placeholder, faintly")
    func placeholder() {
        let layout = CertificateLayout.make(kind: .deepDive, name: "   ", dateText: nil)
        let names = layout.lines.filter { $0.role == .namePlaceholder }
        #expect(names.map { $0.text } == [CertificateCopy.namePlaceholder])
    }

    @Test("The seal's words run 345 px round the circle, as the design's textLength")
    func sealRing() {
        for kind in CertificateKind.allCases {
            let glyphs = CertificateSealRing.glyphs(for: CertificateCopy.sealRing(kind))
            guard let first = glyphs.first, let last = glyphs.last else {
                Issue.record("no glyphs for \(kind)")
                continue
            }
            // The first glyph starts at 9 o'clock, so its centre sits half
            // its advance along; the run's end is 345 px from the start.
            let theta = { (g: CertificateSealRing.Glyph) -> Double in g.rotation + Double.pi / 2 }
            let startOfFirst = theta(first) * 56 - Double(first.advance) / 2
            let endOfLast = theta(last) * 56 + Double(last.advance) / 2 + Double(CertificateSealRing.letterSpacing)
            #expect(abs(startOfFirst) < 0.001)
            #expect(abs(endOfLast - 345) < 0.01)
        }
    }
}

@Suite("Certificate name fit")
struct CertificateNameFitTests {
    /// A fake measure: every character 30 px wide at the design size.
    private func fit(_ name: String, maxTwoLine: CGFloat = 57) -> CertificateNameFit {
        CertificateNameFit.fit(name, maxTwoLineSize: maxTwoLine) { CGFloat($0.count) * 30 }
    }

    @Test("A short name sets at the design's 72 px on one line")
    func short() {
        #expect(fit("Li Wei") == CertificateNameFit(lines: ["Li Wei"], sizePx: 72))
    }

    @Test("A name just over the column shrinks a little and stays on one line")
    func slightlyLong() {
        // 30 characters = 900 px at 72: 864/900 × 72 = 69.12 → 69.
        let result = fit("Alexandria Montgomery-Vasquezz")
        #expect(result.lines.count == 1)
        #expect(result.sizePx == 69)
    }

    @Test("A long name breaks onto two balanced lines at a space")
    func long() {
        let result = fit("Alexandria Catherine Montgomery Vasquez") // 39
        #expect(result.lines == ["Alexandria Catherine", "Montgomery Vasquez"])
        #expect(result.sizePx == 57)
    }

    @Test("A line never ends on a lowercase particle: de los Santos stays together")
    func particles() {
        // 30 px a character: "Maria Fernanda de los" / "Santos Rodriguez-Ochoa"
        // would be the most balanced, but strands "de los".
        let result = fit("Maria Fernanda de los Santos Rodriguez-Ochoa")
        #expect(result.lines == ["Maria Fernanda de los Santos", "Rodriguez-Ochoa"])
        #expect(result.sizePx == 57)
        let van = fit("Johanna Cornelia Elisabeth van der Berg-Smit")
        #expect(van.lines.count == 2)
        #expect(!["van", "der"].contains(van.lines[0].split(separator: " ").last.map(String.init) ?? ""))
    }

    @Test("A name typed all in lowercase still breaks at a space")
    func lowercaseName() {
        let result = fit("maria fernanda de los santos rodriguez ochoa")
        #expect(result.lines.count == 2)
        #expect(result.sizePx >= 54)
    }

    @Test("A break at a space beats one inside a double-barrelled name, even a smaller one")
    func preferSpace() {
        // The hyphen would set it at 57 (the cap), the space at 55.5: the
        // space still wins, so the surname stays whole.
        let result = fit("Christopher Alexander Montgomery-Vasquez de la Fuente Ramirez", maxTwoLine: 64)
        #expect(result.lines == ["Christopher Alexander", "Montgomery-Vasquez de la Fuente Ramirez"])
        #expect(!result.lines[0].hasSuffix("-"))
    }

    @Test("A hyphen breaks only when every space break would set the name too small")
    func hyphenAsLastResort() {
        // "Jo" / the 45-character rest sets at 46 px (under 48); after the
        // second hyphen, both halves fit at the 57 px cap.
        let result = fit("Jo Abcdefghijklmn-Opqrstuvwxyzab-Cdefghijklmnop")
        #expect(result.lines.count == 2)
        #expect(result.lines[0].hasSuffix("-"))
        #expect(result.sizePx == 57)
    }

    @Test("One unbreakable word shrinks to fit its line")
    func unbreakable() {
        let result = fit(String(repeating: "x", count: 60))
        #expect(result.lines.count == 1)
        #expect(CGFloat(60 * 30) * result.sizePx / 72 <= 864)
    }

    @Test("Never more than two lines, never wider than the column", arguments: [10, 25, 40, 60, 80])
    func bounds(length: Int) {
        let words = (0..<length).map { _ in "ab" }.joined(separator: " ").prefix(length)
        let result = fit(String(words))
        #expect(result.lines.count <= 2)
        for line in result.lines {
            #expect(CGFloat(line.count) * 30 * result.sizePx / 72 <= 864.001)
        }
    }

    @Test("Names are trimmed, single-spaced and capped at 80 characters")
    func normalized() {
        #expect(CertificateNameFit.normalized("  Ana \n  María\tLópez ") == "Ana María López")
        #expect(CertificateNameFit.normalized(String(repeating: "a", count: 120)).count == 80)
    }

    @Test("With the real font: a short name and Alexandria Montgomery-Vasquez both keep 72 px")
    func realFont() {
        for name in ["Li Wei", "Alexandria Montgomery-Vasquez"] {
            let layout = CertificateLayout.make(kind: .deepDive, name: name, dateText: nil)
            #expect(layout.name == CertificateNameFit(lines: [name], sizePx: 72))
        }
    }

    @Test("Names up to about 60 characters keep at least 54 px with the real font", arguments: CertificateKind.allCases)
    func sixtyCharacters(kind: CertificateKind) {
        let names = [
            "Maria Fernanda de los Santos Rodríguez-Ochoa",
            "Christopher Alexander Montgomery-Vasquez de la Fuente Ramírez",
            "Oluwaseun Adebayo-Okonkwo Chukwuemeka Nnamdi Eze-Obi"
        ]
        for name in names {
            let layout = CertificateLayout.make(kind: kind, name: name, dateText: nil)
            #expect(layout.name.sizePx >= 54, "\(name): \(layout.name)")
        }
    }

    @Test("With the real font, both certificates keep a hyphenated surname whole")
    func hyphenatedSurnameRealFont() {
        let name = "Christopher Alexander Montgomery-Vasquez de la Fuente Ramírez"
        let deepDive = CertificateLayout.make(kind: .deepDive, name: name, dateText: nil).name
        let basics = CertificateLayout.make(kind: .basics, name: name, dateText: nil).name
        #expect(deepDive.lines == ["Christopher Alexander", "Montgomery-Vasquez de la Fuente Ramírez"])
        #expect(basics == deepDive)
    }

    @Test("With the real font, de los Santos stays on one line")
    func particlesRealFont() {
        for kind in CertificateKind.allCases {
            let fit = CertificateLayout.make(kind: kind, name: "Maria Fernanda de los Santos Rodríguez-Ochoa",
                                             dateText: nil).name
            #expect(fit.lines.count == 2)
            #expect(fit.lines.contains { $0.contains("de los Santos") }, "\(kind): \(fit.lines)")
            #expect(fit.sizePx == (kind == .deepDive ? 57 : 64))
        }
    }
}

@Suite("Certificate copy")
struct CertificateCopyTests {
    @Test("The date prints in US English")
    func date() {
        var components = DateComponents()
        components.year = 2026
        components.month = 10
        components.day = 21
        components.hour = 12
        let utc = TimeZone(identifier: "UTC")!
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = utc
        let date = calendar.date(from: components)!
        #expect(CertificateCopy.dateText(date, timeZone: utc) == "October 21, 2026")
    }

    @Test("VoiceOver's summary names the certificate, the course, the learner and the date")
    func summary() {
        #expect(CertificateCopy.accessibilitySummary(kind: .deepDive, name: " Alexandria  Montgomery-Vasquez ",
                                                     dateText: "October 21, 2026")
                == "Certificate of Completion, AI Literacy Course, awarded to Alexandria Montgomery-Vasquez, October 21, 2026")
        #expect(CertificateCopy.accessibilitySummary(kind: .basics, name: "", dateText: nil)
                == "Certificate of Completion, AI Basics, awaiting your name")
    }
}

@Suite("Certificate PDF")
@MainActor
struct CertificatePDFTests {
    private func pdf(_ kind: CertificateKind, _ name: String) throws -> PDFDocument {
        let data = try #require(CertificatePDF.data(kind: kind, name: name, dateText: "October 21, 2026"))
        return try #require(PDFDocument(data: data))
    }

    @Test("One US Letter landscape page whose text reads true", arguments: CertificateKind.allCases)
    func page(kind: CertificateKind) throws {
        let document = try pdf(kind, "Alexandria Montgomery-Vasquez")
        #expect(document.pageCount == 1)
        let page = try #require(document.page(at: 0))
        let box = page.bounds(for: .mediaBox)
        #expect(box.width == 792 && box.height == 612)
        let text = page.string ?? ""
        #expect(text.contains("Certificate of Completion"))
        #expect(text.contains("Alexandria Montgomery-Vasquez"))
        #expect(text.contains("October 21, 2026"))
        #expect(text.contains("Mercurius is made by the Mayo AI Literacy Club"))
    }

    @Test("A two-line name is in the text too")
    func twoLines() throws {
        let text = try pdf(.deepDive, "Maria Fernanda de los Santos Rodríguez-Ochoa").page(at: 0)?.string ?? ""
        #expect(text.contains("Maria Fernanda de los Santos"))
        #expect(text.contains("Rodríguez-Ochoa"))
    }

    @Test("The PDF leaves the paper unpainted: no tint for a printer to dither", arguments: CertificateKind.allCases)
    func noPaperFill(kind: CertificateKind) throws {
        let data = try #require(CertificatePDF.data(kind: kind, name: "Li Wei", dateText: "October 21, 2026"))
        let provider = try #require(CGDataProvider(data: data as CFData))
        let page = try #require(CGPDFDocument(provider)?.page(at: 1))
        // The page at 1 px a point on a transparent bitmap: outside the frame
        // (the corners, the margin) and in the open paper nothing is drawn.
        let context = try #require(CGContext(
            data: nil, width: 792, height: 612, bitsPerComponent: 8, bytesPerRow: 792 * 4,
            space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.drawPDFPage(page)
        let pixels = try #require(context.data).assumingMemoryBound(to: UInt8.self)
        // A bitmap's first row in memory is the top of the page.
        func alpha(x: Int, yFromTop: Int) -> UInt8 { pixels[(yFromTop * 792 + x) * 4 + 3] }
        #expect(alpha(x: 4, yFromTop: 4) == 0)
        #expect(alpha(x: 396, yFromTop: 10) == 0)
        #expect(alpha(x: 787, yFromTop: 607) == 0)
        #expect(alpha(x: 100, yFromTop: 200) == 0)
        // …while the ink is there: the outer border at 30 pt in.
        #expect(alpha(x: 396, yFromTop: 30) > 0)
    }

    @Test("The text is vector with the four faces embedded; the mark is the full-size image")
    func embedded() throws {
        let data = try #require(CertificatePDF.data(kind: .deepDive, name: "Li Wei", dateText: "October 21, 2026"))
        let resources = try PDFResources(data: data)
        let names = resources.fonts.map(\.baseFont)
        for face in CertificateFace.allCases {
            #expect(names.contains { $0.hasSuffix("+" + face.postScriptName) }, "\(face.postScriptName) not in \(names)")
        }
        #expect(resources.fonts.allSatisfy { $0.embedded }, "\(resources.fonts)")
        #expect(resources.images.contains { $0.width == 470 && $0.height == 415 })
        // Nothing but the mark is a picture: no rasterized text.
        #expect(resources.images.allSatisfy { $0.width == 470 && $0.height == 415 })
    }
}

/// The fonts and images a PDF page uses, walked through its resources and
/// form XObjects.
private struct PDFResources {
    struct FontInfo: CustomStringConvertible {
        let baseFont: String
        let embedded: Bool
        var description: String { "\(baseFont)\(embedded ? "" : " (not embedded)")" }
    }
    struct ImageInfo {
        let width: Int
        let height: Int
    }

    var fonts: [FontInfo] = []
    var images: [ImageInfo] = []

    init(data: Data) throws {
        let provider = try #require(CGDataProvider(data: data as CFData))
        let document = try #require(CGPDFDocument(provider))
        let page = try #require(document.page(at: 1))
        let dictionary = try #require(page.dictionary)
        var resources: CGPDFDictionaryRef?
        guard CGPDFDictionaryGetDictionary(dictionary, "Resources", &resources), let resources else { return }
        walk(resources)
    }

    private mutating func walk(_ resources: CGPDFDictionaryRef) {
        var found: [FontInfo] = []
        var pictures: [ImageInfo] = []
        var forms: [CGPDFDictionaryRef] = []
        var fontsDict: CGPDFDictionaryRef?
        if CGPDFDictionaryGetDictionary(resources, "Font", &fontsDict), let fontsDict {
            withUnsafeMutablePointer(to: &found) { pointer in
                CGPDFDictionaryApplyBlock(fontsDict, { _, object, info in
                    let out = info!.assumingMemoryBound(to: [FontInfo].self)
                    var font: CGPDFDictionaryRef?
                    guard CGPDFObjectGetValue(object, .dictionary, &font), let font else { return true }
                    var name: UnsafePointer<CChar>?
                    CGPDFDictionaryGetName(font, "BaseFont", &name)
                    var target = font
                    var descendants: CGPDFArrayRef?
                    if CGPDFDictionaryGetArray(font, "DescendantFonts", &descendants), let descendants {
                        var child: CGPDFDictionaryRef?
                        if CGPDFArrayGetDictionary(descendants, 0, &child), let child { target = child }
                    }
                    var descriptor: CGPDFDictionaryRef?
                    var embedded = false
                    if CGPDFDictionaryGetDictionary(target, "FontDescriptor", &descriptor), let descriptor {
                        var stream: CGPDFStreamRef?
                        embedded = CGPDFDictionaryGetStream(descriptor, "FontFile2", &stream)
                            || CGPDFDictionaryGetStream(descriptor, "FontFile3", &stream)
                            || CGPDFDictionaryGetStream(descriptor, "FontFile", &stream)
                    }
                    out.pointee.append(FontInfo(baseFont: name.map { String(cString: $0) } ?? "?", embedded: embedded))
                    return true
                }, pointer)
            }
        }
        var xobjects: CGPDFDictionaryRef?
        if CGPDFDictionaryGetDictionary(resources, "XObject", &xobjects), let xobjects {
            var collected: (images: [ImageInfo], forms: [CGPDFDictionaryRef]) = ([], [])
            withUnsafeMutablePointer(to: &collected) { pointer in
                CGPDFDictionaryApplyBlock(xobjects, { _, object, info in
                    let out = info!.assumingMemoryBound(to: (images: [ImageInfo], forms: [CGPDFDictionaryRef]).self)
                    var stream: CGPDFStreamRef?
                    guard CGPDFObjectGetValue(object, .stream, &stream), let stream,
                          let dictionary = CGPDFStreamGetDictionary(stream) else { return true }
                    var subtype: UnsafePointer<CChar>?
                    CGPDFDictionaryGetName(dictionary, "Subtype", &subtype)
                    switch subtype.map({ String(cString: $0) }) {
                    case "Image":
                        var w: CGPDFInteger = 0
                        var h: CGPDFInteger = 0
                        CGPDFDictionaryGetInteger(dictionary, "Width", &w)
                        CGPDFDictionaryGetInteger(dictionary, "Height", &h)
                        out.pointee.images.append(ImageInfo(width: Int(w), height: Int(h)))
                    case "Form":
                        var inner: CGPDFDictionaryRef?
                        if CGPDFDictionaryGetDictionary(dictionary, "Resources", &inner), let inner {
                            out.pointee.forms.append(inner)
                        }
                    default:
                        break
                    }
                    return true
                }, pointer)
            }
            pictures = collected.images
            forms = collected.forms
        }
        fonts.append(contentsOf: found)
        images.append(contentsOf: pictures)
        for form in forms { walk(form) }
    }
}

/// `CERTIFICATE_SHOTS_DIR=<dir> swift test --filter CertificateShots` writes
/// the PDFs for docs/certificate/shots from the package's own build (off in
/// a normal run).
@Suite("CertificateShots")
@MainActor
struct CertificateShotsExport {
    @Test("Write each certificate's PDF with the sample names",
          .enabled(if: ProcessInfo.processInfo.environment["CERTIFICATE_SHOTS_DIR"] != nil))
    func export() throws {
        let dir = URL(fileURLWithPath: try #require(ProcessInfo.processInfo.environment["CERTIFICATE_SHOTS_DIR"]))
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let samples: [(String, String)] = [
            ("", "Alexandria Montgomery-Vasquez"),
            ("-short", "Li Wei"),
            ("-long", "Maria Fernanda de los Santos Rodríguez-Ochoa"),
            ("-60", "Christopher Alexander Montgomery-Vasquez de la Fuente Ramírez")
        ]
        for kind in CertificateKind.allCases {
            for (suffix, name) in samples {
                let data = try #require(CertificatePDF.data(kind: kind, name: name, dateText: "October 21, 2026"))
                try data.write(to: dir.appendingPathComponent("certificate-\(kind.rawValue)\(suffix).pdf"))
            }
        }
    }
}
