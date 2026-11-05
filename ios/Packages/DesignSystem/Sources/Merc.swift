import SwiftUI

/// **Merc** — the Mercurius mascot: a chibi-but-teenaged Hermes with a winged
/// petasos helmet, a white toga, and a gold cord belt, drawn entirely in
/// SwiftUI from the design handoff (intrinsic art box 160×180, top-left origin).
///
/// One prop, `state`, drives his expression + motion. Ambient loops (body bob,
/// wing flutter, sparkle twinkle) always run; each state swaps the eyes, mouth,
/// arm pose, body motion, and an optional effect (thinking dots / sleep zzz).
public enum MercState: String, CaseIterable, Sendable {
    case idle, wave, happy, thinking, celebrate, sleep
}

public struct Merc: View {
    public var state: MercState
    /// Rendered height in points (the 160×180 art scales to this).
    public var size: CGFloat
    /// When `false`, the ambient idle motion (body bob, breathing, wing flutter,
    /// sparkle) is suppressed and the mascot renders still — the per-state
    /// expression still applies. Always treated as off under Reduce Motion.
    public var ambient: Bool

    public init(state: MercState = .idle, size: CGFloat = 150, ambient: Bool = true) {
        self.state = state
        self.size = size
        self.ambient = ambient
    }

    private static let artW: CGFloat = 160
    private static let artH: CGFloat = 180

    public var body: some View {
        MercArt(state: state, ambient: ambient)
            .frame(width: Self.artW, height: Self.artH)
            .scaleEffect(size / Self.artH, anchor: .center)
            .frame(width: Self.artW * size / Self.artH, height: size)
            .accessibilityHidden(true)
    }
}

// MARK: - The right arm's pose

/// Where Merc's right arm hangs from and how it swings, per state, in the
/// art's 160×180 space. Rotation is in degrees about the arm's top centre
/// (`shoulder`); 0 hangs straight down, negative swings it out to Merc's
/// left (the viewer's right) and up.
struct MercArmPose: Equatable {
    static let width: CGFloat = 13
    static let length: CGFloat = 44

    /// The resting arm's top centre, at the toga's top corner.
    static let restingShoulder = CGPoint(x: 109.5, y: 86)
    /// Inside the toga's upper corner: the raised "Nailed it!" arm turns
    /// here, behind the toga, so it comes out from under it. Turning about
    /// `restingShoulder` swung its end through the empty gap between the
    /// head and the toga, and the arm floated loose beside his head (AUD-52).
    static let raisedShoulder = CGPoint(x: 96, y: 107)

    let shoulder: CGPoint
    /// Drawn behind the toga rather than in front of it.
    var behindTorso: Bool = false
    let rest: Double
    let swing: Double
    let dur: Double
    let oscillates: Bool

    static func pose(for state: MercState) -> MercArmPose {
        switch state {
        case .wave:
            return MercArmPose(shoulder: restingShoulder, rest: 14, swing: -22, dur: 0.35, oscillates: true)
        case .celebrate:
            // Pumps between out-and-down and raised beside his head.
            return MercArmPose(shoulder: raisedShoulder, behindTorso: true,
                               rest: -40, swing: -130, dur: 0.25, oscillates: true)
        case .happy:
            // merc-wave — happy arm waves too
            return MercArmPose(shoulder: restingShoulder, rest: 14, swing: -22, dur: 0.55, oscillates: true)
        default:
            return MercArmPose(shoulder: restingShoulder, rest: 0, swing: 0, dur: 0.5, oscillates: false)
        }
    }

    /// The arm's far end (the hand's centre line) at `degrees`.
    func hand(at degrees: Double) -> CGPoint {
        let r = CGFloat(degrees * .pi / 180)
        return CGPoint(x: shoulder.x - sin(r) * Self.length, y: shoulder.y + cos(r) * Self.length)
    }
}

// MARK: - The character art (fixed 160×180 coordinate space)

private struct MercArt: View {
    let state: MercState
    var ambient: Bool = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var t = false       // ambient autoreverse driver

    var body: some View {
        ZStack(alignment: .topLeading) {
            // Ground shadow (breathes with the bob)
            Ellipse()
                .fill(RadialGradient(colors: [Color(hex: 0x32146E).opacity(0.22), .clear],
                                     center: .center, startRadius: 0, endRadius: 40))
                .scaleEffect(x: anim(t) ? 0.86 : 1, anchor: .center)
                .opacity(anim(t) ? 0.636 : 1)
                .animation(loop(1.7), value: t)
                .placed(x: 42, y: 166, w: 76, h: 13)

            character
                // Gentle breathing — a sub-2% scale synced to the bob. Baseline
                // (t == false) is exactly 1.0, so the static first frame is
                // pixel-identical to before (snapshot-safe).
                .scaleEffect(anim(t) ? 1.018 : 1.0, anchor: .bottom)
                .offset(y: anim(t) ? body_.peakY : body_.baseY)
                .rotationEffect(.degrees(anim(t) ? body_.peakR : body_.baseR), anchor: .bottom)
                .animation(loop(body_.dur), value: t)

            effects
        }
        .onAppear { if !reduceMotion && ambient { t = true } }
        // LazyVStack/TabView preserve @State across scroll-out while the
        // repeatForever animations die with the view — reset the driver so
        // a reappearance re-arms the ambient life instead of freezing Merc
        // at whatever peak frame the animation last rendered.
        .onDisappear { t = false }
    }

    // The whole body group (everything that bobs together)
    private var character: some View {
        ZStack(alignment: .topLeading) {
            // Wings (behind the head), fluttering
            wing(mirrored: false)
                .rotationEffect(.degrees(anim(t) ? -17 : -3), anchor: .bottomTrailing)
                .animation(loop(0.8), value: t)
                .placed(x: 22, y: 0, w: 44, h: 52, anchor: .bottomTrailing)
            wing(mirrored: true)
                .rotationEffect(.degrees(anim(t) ? 17 : 3), anchor: .bottomLeading)
                .animation(loop(0.8), value: t)
                .placed(x: 94, y: 0, w: 44, h: 52, anchor: .bottomLeading)

            // Legs + feet
            leg().placed(x: 67, y: 148, w: 11, h: 24)
            leg().placed(x: 83, y: 148, w: 11, h: 24)
            foot().placed(x: 61, y: 167, w: 19, h: 10)
            foot().placed(x: 81, y: 167, w: 19, h: 10)

            // Left arm (rests)
            limb().placed(x: 45, y: 97, w: 13, h: 42, rotation: 7)

            // The raised right arm comes out from under the toga.
            if arm.behindTorso { rightArm }

            // Torso / toga
            UnevenRoundedRectangle(topLeadingRadius: 22, bottomLeadingRadius: 18.5,
                                   bottomTrailingRadius: 18.5, topTrailingRadius: 22, style: .continuous)
                .fill(lin(165, 0xFFFFFF, 0xECE8FF))
                .placed(x: 52, y: 94, w: 56, h: 62)
            Ellipse().fill(lin(155, 0x4A5FF2, 0x7C3AED)).placed(x: 52, y: 90, w: 22, h: 18)
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .fill(lin(160, 0xF7F5FF, 0xE2DDF7))
                .placed(x: 48, y: 95, w: 66, h: 21, rotation: 24)
            Capsule().fill(Color(hex: 0x4A2E80).opacity(0.13)).placed(x: 58, y: 120, w: 44, h: 2, rotation: 19)
            Capsule().fill(Color(hex: 0x4A2E80).opacity(0.10)).placed(x: 60, y: 130, w: 36, h: 2, rotation: 17)
            Capsule().fill(lin(90, 0xE9C768, 0xCAA23A)).placed(x: 57, y: 128, w: 46, h: 4, rotation: -2)
            Circle().fill(RadialGradient(colors: [Color(hex: 0xF3D784), Color(hex: 0xC89E35)],
                                         center: UnitPoint(x: 0.35, y: 0.3), startRadius: 0, endRadius: 6))
                .placed(x: 76, y: 126, w: 8, h: 8)

            // Right arm (state-driven; waves/cheers)
            if !arm.behindTorso { rightArm }

            // Neck
            limb(lin(160, 0x5F33D6, 0x8A35D4)).placed(x: 73, y: 80, w: 14, h: 18)

            // Head + helmet: the dome sits ON the head (Merc.dc.html draws
            // it after the head), and the brim covers its lower edge.
            head().placed(x: 52, y: 26, w: 56, h: 62)
            helmetDome().placed(x: 55, y: 17, w: 50, h: 34)
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(LinearGradient(colors: [.white, Color(hex: 0xE7E3FF)], startPoint: .top, endPoint: .bottom))
                .placed(x: 46, y: 45, w: 68, h: 10, rotation: -4)
                .shadow(color: Color(hex: 0x280A50).opacity(0.24), radius: 2.5, y: 2)

            face

            // Sparkle (front, twinkling)
            SparkleStar()
                .fill(lin(135, 0x8FB3FF, 0xCF8BFF))
                .scaleEffect(anim(t) ? 1.05 : 0.55)
                .rotationEffect(.degrees(anim(t) ? 45 : 0))
                .opacity(anim(t) ? 1 : 0.3)
                .animation(loop(1.3), value: t)
                .placed(x: 118, y: 22, w: 22, h: 22)
        }
    }

    /// The right arm turns about its top centre, the shoulder. The swing
    /// animates on its own; a shoulder that moves with the state eases over
    /// once rather than riding the swing's repeat-forever animation.
    private var rightArm: some View {
        limb()
            .frame(width: MercArmPose.width, height: MercArmPose.length)
            .rotationEffect(.degrees(armRotation), anchor: .top)
            .animation(arm.oscillates ? loop(arm.dur) : .easeOut(duration: 0.35), value: armPhase)
            .position(x: arm.shoulder.x, y: arm.shoulder.y + MercArmPose.length / 2)
            .animation(motionOff ? nil : .easeOut(duration: 0.35), value: state)
    }

    // MARK: face (expression per state)

    private var face: some View {
        ZStack(alignment: .topLeading) {
            Capsule().fill(Color(hex: 0x2A1F63)).placed(x: 61, y: 53, w: 11, h: 3)
            Capsule().fill(Color(hex: 0x2A1F63)).placed(x: 88, y: 53, w: 11, h: 3)
            eye().placed(x: 64, y: 56, w: 7, h: 11)
            eye().placed(x: 89, y: 56, w: 7, h: 11)
            mouth.placed(x: 71, y: 76, w: 14, h: 8)
        }
    }

    @ViewBuilder private func eye() -> some View {
        switch state {
        case .happy, .celebrate:
            Arc(start: .degrees(200), end: .degrees(340))
                .stroke(Color(hex: 0x241B5E), style: StrokeStyle(lineWidth: 2.4, lineCap: .round))
        case .sleep:
            Arc(start: .degrees(20), end: .degrees(160))
                .stroke(Color(hex: 0x241B5E), style: StrokeStyle(lineWidth: 2.4, lineCap: .round))
        default:
            ZStack(alignment: .topTrailing) {
                RoundedRectangle(cornerRadius: 4, style: .continuous).fill(Color(hex: 0x241B5E))
                Circle().fill(.white).frame(width: 2.6, height: 2.6).offset(x: -1.2, y: 1.4)
            }
            .modifier(EyeBlink(active: !reduceMotion && ambient))
        }
    }

    @ViewBuilder private var mouth: some View {
        switch state {
        case .happy, .celebrate:
            ZStack(alignment: .bottom) {
                Capsule().fill(Color(hex: 0x241B5E)).frame(width: 12, height: 7)
                Capsule().fill(Color(hex: 0xFF7DA8)).frame(width: 6, height: 3).offset(y: -0.5)
            }
        case .thinking, .sleep:
            Circle().fill(Color(hex: 0x241B5E)).frame(width: 4, height: 4)
        default:
            Capsule().fill(Color(hex: 0x241B5E)).frame(width: 9, height: 3)
        }
    }

    // MARK: effects (dots / zzz / confetti)

    @ViewBuilder private var effects: some View {
        switch state {
        case .thinking:
            HStack(spacing: 4) {
                ForEach(0..<3, id: \.self) { i in
                    Circle().fill(Color(hex: 0x7C3AED))
                        .frame(width: 5, height: 5)
                        .opacity(anim(t) ? 1 : 0.2)
                        .offset(y: anim(t) ? 0 : 2)
                        .animation(loop(0.5)?.delay(Double(i) * 0.16), value: t)
                }
            }
            .position(x: 108, y: 18)
        case .sleep:
            ZStack {
                ForEach(0..<3, id: \.self) { i in
                    Text("z")
                        .font(.system(size: CGFloat(9 + i * 3), weight: .heavy, design: .rounded))
                        .foregroundStyle(Color(hex: 0x8B88A8))
                        .modifier(RiseZ(active: !reduceMotion, delay: Double(i) * 0.7))
                }
            }
            .position(x: 104, y: 40)
        case .celebrate:
            ZStack {
                ForEach(0..<7, id: \.self) { i in
                    Capsule()
                        .fill([Color(hex: 0x3D5AFF), Color(hex: 0x7C3AED), Color(hex: 0xB53BE8),
                               Color(hex: 0xE9C768)][i % 4])
                        .frame(width: 5, height: 8)
                        .modifier(Confetti(active: !reduceMotion, index: i))
                }
            }
            .position(x: 80, y: 60)
        default:
            EmptyView()
        }
    }

    // MARK: per-state motion params

    private var body_: (baseY: CGFloat, peakY: CGFloat, baseR: Double, peakR: Double, dur: Double) {
        switch state {
        case .idle:      return (0, -7, -1, 1, 1.7)
        case .wave:      return (0, -5, -1, 1, 0.9)
        case .happy:     return (0, -12, 0, 0, 0.45)
        case .thinking:  return (0, -2, -6, -8, 1.7)
        case .celebrate: return (0, -18, 0, 0, 0.35)
        case .sleep:     return (3, 6, 2.5, 3.5, 2.1)
        }
    }

    private var arm: MercArmPose { MercArmPose.pose(for: state) }
    private var armPhase: Bool { arm.oscillates ? t : false }
    private var armRotation: Double {
        if arm.oscillates { return anim(t) ? arm.swing : arm.rest }
        return arm.rest
    }

    // MARK: animation helpers

    /// Ambient motion is off when the user prefers reduced motion OR the caller
    /// opted out via `ambient: false`.
    private var motionOff: Bool { reduceMotion || !ambient }
    private func anim(_ v: Bool) -> Bool { motionOff ? false : v }
    private func loop(_ dur: Double) -> Animation? {
        motionOff ? nil : .easeInOut(duration: dur).repeatForever(autoreverses: true)
    }

    // MARK: reusable shapes

    private func head() -> some View {
        let r = 155.0 * .pi / 180
        let dx = sin(r), dy = -cos(r)
        return UnevenRoundedRectangle(topLeadingRadius: 27, bottomLeadingRadius: 32,
                                      bottomTrailingRadius: 32, topTrailingRadius: 27, style: .continuous)
            .fill(LinearGradient(stops: [
                .init(color: Color(hex: 0x3D5AFF), location: 0.0),
                .init(color: Color(hex: 0x7C3AED), location: 0.56),
                .init(color: Color(hex: 0xB53BE8), location: 1.0)],
                startPoint: UnitPoint(x: 0.5 - dx / 2, y: 0.5 - dy / 2),
                endPoint: UnitPoint(x: 0.5 + dx / 2, y: 0.5 + dy / 2)))
    }
    private func helmetDome() -> some View {
        // `border-radius: 52% 52% 38% 38%`: elliptical corners, so the top
        // is one rounded dome rather than a box with rounded corners.
        let shape = EllipticalCornerRect(top: 0.52, bottom: 0.38)
        return shape
            .fill(lin(150, 0x5A23C9, 0x8D2FD6))
            .overlay(
                LinearGradient(colors: [.clear, Color(hex: 0x1E0846).opacity(0.32)],
                               startPoint: .center, endPoint: .bottom)
                    .clipShape(shape)
            )
    }
    private func leg() -> some View { limb(lin(160, 0x5F33D6, 0x8132CF)) }
    private func foot() -> some View {
        UnevenRoundedRectangle(topLeadingRadius: 9, bottomLeadingRadius: 5,
                               bottomTrailingRadius: 5, topTrailingRadius: 9, style: .continuous)
            .fill(lin(160, 0x6A39E6, 0x8D2FD6))
    }
    private func limb(_ fill: LinearGradient? = nil) -> some View {
        RoundedRectangle(cornerRadius: 7, style: .continuous)
            .fill(fill ?? lin(160, 0x4A5FF2, 0x7C3AED))
    }

    /// A wing: 4 teardrop feathers fanning UP-and-out from the bottom hinge near
    /// the helmet, using the exact `right/bottom/rotate` staircase from
    /// Merc.dc.html (each rotated about its centre, as the prototype does).
    private func wing(mirrored: Bool) -> some View {
        // (w, h, rotateDeg, rightOffset, bottomOffset, gradient)
        let feathers: [(CGFloat, CGFloat, Double, CGFloat, CGFloat, (UInt, UInt))] = [
            (38, 12, -26,  0,  0, (0x2F56F5, 0x86A6FF)),  // base (most horizontal)
            (33, 11, -44,  6, 10, (0x3D61FF, 0x9AB6FF)),
            (26, 10, -62, 12, 21, (0x5274FF, 0xBCC7FF)),
            (20,  9, -78, 18, 30, (0x6F8EFF, 0xD2DBFF)),  // tip (near-vertical)
        ]
        return ZStack(alignment: .topLeading) {
            ForEach(0..<feathers.count, id: \.self) { i in
                let f = feathers[i]
                feather(w: f.0, h: f.1, g: f.5)
                    .placed(x: 44 - f.3 - f.0, y: 52 - f.4 - f.1,
                            w: f.0, h: f.1, rotation: f.2, anchor: .center)
            }
        }
        .frame(width: 44, height: 52, alignment: .bottomTrailing)
        .scaleEffect(x: mirrored ? -1 : 1, y: 1)   // mirror flips geometry, teardrop + gradient
    }

    /// One teardrop feather — rounded lobes with a sharp 5pt quill at the
    /// bottom-leading corner (CSS `border-radius: 50% 50% 50% 5px`).
    private func feather(w: CGFloat, h: CGFloat, g: (UInt, UInt)) -> some View {
        UnevenRoundedRectangle(topLeadingRadius: min(w, h) / 2,
                               bottomLeadingRadius: 5,
                               bottomTrailingRadius: min(w, h) / 2,
                               topTrailingRadius: min(w, h) / 2,
                               style: .continuous)
            .fill(lin(120, g.0, g.1))
    }
}

// MARK: - effect modifiers

/// A periodic blink for the open-eye states — a brief vertical pinch of the
/// EXISTING eye (no new art). The first phase is fully open, so the static
/// baseline frame is unchanged (snapshot-safe); only renders when ambient
/// motion is on and Reduce Motion is off.
private struct EyeBlink: ViewModifier {
    let active: Bool
    func body(content: Content) -> some View {
        if active {
            content.phaseAnimator([true, false]) { view, open in
                view.scaleEffect(x: 1, y: open ? 1 : 0.12, anchor: .center)
            } animation: { open in
                // Hold open ~2.8s, then a quick close, then re-open.
                open ? .easeInOut(duration: 0.09)
                     : .easeInOut(duration: 0.09).delay(2.8)
            }
        } else {
            content
        }
    }
}

private struct RiseZ: ViewModifier {
    let active: Bool
    let delay: Double
    @State private var go = false
    func body(content: Content) -> some View {
        content
            .opacity(go ? 0 : (active ? 1 : 0.6))
            .offset(x: go ? 9 : 0, y: go ? -24 : 0)
            .scaleEffect(go ? 1.15 : 0.6)
            .onAppear {
                guard active else { return }
                withAnimation(.easeOut(duration: 2.1).repeatForever(autoreverses: false).delay(delay)) { go = true }
            }
    }
}

private struct Confetti: ViewModifier {
    let active: Bool
    let index: Int
    @State private var go = false
    private var angle: Double { Double(index) / 7 * 360 }
    func body(content: Content) -> some View {
        let dx = CGFloat(cos(angle * .pi / 180)) * 34
        let dy = CGFloat(sin(angle * .pi / 180)) * 34
        return content
            .rotationEffect(.degrees(angle))
            .offset(x: go ? dx : 0, y: go ? dy - 6 : 0)
            .opacity(go ? 0 : (active ? 1 : 0))
            .scaleEffect(go ? 0.5 : 1)
            .onAppear {
                guard active else { return }
                withAnimation(.easeOut(duration: 0.9).repeatForever(autoreverses: false)
                    .delay(Double(index) * 0.06)) { go = true }
            }
    }
}

// MARK: - Geometry helpers

struct SparkleStar: Shape {
    func path(in r: CGRect) -> Path {
        let pts: [(CGFloat, CGFloat)] = [
            (0.50, 0.0), (0.59, 0.41), (1.0, 0.50), (0.59, 0.59),
            (0.50, 1.0), (0.41, 0.59), (0.0, 0.50), (0.41, 0.41),
        ]
        var p = Path()
        for (i, pt) in pts.enumerated() {
            let cp = CGPoint(x: r.minX + pt.0 * r.width, y: r.minY + pt.1 * r.height)
            if i == 0 { p.move(to: cp) } else { p.addLine(to: cp) }
        }
        p.closeSubpath()
        return p
    }
}

/// A rectangle with elliptical corners, as CSS draws `border-radius: T% T% B% B%`:
/// each corner's horizontal radius is a fraction of the width and its vertical
/// radius the same fraction of the height. Where two radii along one side add
/// up to more than the side, all radii shrink by the same factor (the CSS rule).
struct EllipticalCornerRect: Shape {
    var top: CGFloat
    var bottom: CGFloat

    func path(in r: CGRect) -> Path {
        let w = r.width, h = r.height
        let f = min(1, 1 / (2 * top), 1 / (2 * bottom), 1 / (top + bottom))
        let tx = top * w * f, ty = top * h * f
        let bx = bottom * w * f, by = bottom * h * f
        let k: CGFloat = 0.5523   // cubic Bézier control length for a quarter ellipse

        var p = Path()
        p.move(to: CGPoint(x: r.minX + tx, y: r.minY))
        p.addLine(to: CGPoint(x: r.maxX - tx, y: r.minY))
        p.addCurve(to: CGPoint(x: r.maxX, y: r.minY + ty),
                   control1: CGPoint(x: r.maxX - tx + k * tx, y: r.minY),
                   control2: CGPoint(x: r.maxX, y: r.minY + ty - k * ty))
        p.addLine(to: CGPoint(x: r.maxX, y: r.maxY - by))
        p.addCurve(to: CGPoint(x: r.maxX - bx, y: r.maxY),
                   control1: CGPoint(x: r.maxX, y: r.maxY - by + k * by),
                   control2: CGPoint(x: r.maxX - bx + k * bx, y: r.maxY))
        p.addLine(to: CGPoint(x: r.minX + bx, y: r.maxY))
        p.addCurve(to: CGPoint(x: r.minX, y: r.maxY - by),
                   control1: CGPoint(x: r.minX + bx - k * bx, y: r.maxY),
                   control2: CGPoint(x: r.minX, y: r.maxY - by + k * by))
        p.addLine(to: CGPoint(x: r.minX, y: r.minY + ty))
        p.addCurve(to: CGPoint(x: r.minX + tx, y: r.minY),
                   control1: CGPoint(x: r.minX, y: r.minY + ty - k * ty),
                   control2: CGPoint(x: r.minX + tx - k * tx, y: r.minY))
        p.closeSubpath()
        return p
    }
}

struct Arc: Shape {
    var start: Angle
    var end: Angle
    func path(in r: CGRect) -> Path {
        var p = Path()
        p.addArc(center: CGPoint(x: r.midX, y: r.midY),
                 radius: min(r.width, r.height) / 2,
                 startAngle: start, endAngle: end, clockwise: false)
        return p
    }
}

private extension View {
    func placed(x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat,
                rotation: Double = 0, anchor: UnitPoint = .center) -> some View {
        self.frame(width: w, height: h)
            .rotationEffect(.degrees(rotation), anchor: anchor)
            .position(x: x + w / 2, y: y + h / 2)
    }
}

private func lin(_ deg: Double, _ c1: UInt, _ c2: UInt) -> LinearGradient {
    let r = deg * .pi / 180
    let dx = sin(r), dy = -cos(r)
    return LinearGradient(colors: [Color(hex: c1), Color(hex: c2)],
                          startPoint: UnitPoint(x: 0.5 - dx / 2, y: 0.5 - dy / 2),
                          endPoint: UnitPoint(x: 0.5 + dx / 2, y: 0.5 + dy / 2))
}

extension Color {
    init(hex: UInt, alpha: Double = 1) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255,
                  opacity: alpha)
    }
}

// MARK: - In-app preview screen (tap through states)

/// A simple dev screen to view Merc live + tap through his states. Shown via the
/// `-MercPreview` launch arg (DEBUG).
public struct MercPreviewView: View {
    @State private var state: MercState = .idle
    @State private var activity: MercActivity = .idle
    @State private var dark = true

    public init() {}

    public var body: some View {
        ScrollView {
            VStack(spacing: 28) {
            Text("Merc").font(.system(size: 22, weight: .heavy, design: .rounded))
                .foregroundStyle(dark ? Color(hex: 0xECEBFA) : Color(hex: 0x1C1B2E))

            ZStack {
                Circle()
                    .fill(RadialGradient(colors: [Color(hex: 0x7C3AED).opacity(0.16), .clear],
                                         center: .center, startRadius: 0, endRadius: 130))
                    .frame(width: 260, height: 260)
                MercMascot(state, size: 190, activity: activity,
                           idleAntics: true, pokeable: true)
            }
            .frame(height: 260)

            Text(state.rawValue).font(.system(.headline, design: .rounded))
                .foregroundStyle(Color(hex: 0x7C3AED))

            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                ForEach(MercState.allCases, id: \.self) { s in
                    Button { withAnimation(.easeOut(duration: 0.25)) { state = s } } label: {
                        Text(s.rawValue)
                            .font(.system(.subheadline, design: .rounded).weight(.bold))
                            .frame(maxWidth: .infinity, minHeight: 42)
                            .background(state == s ? Color(hex: 0x7C3AED) : Color(hex: 0x7C3AED).opacity(0.12))
                            .foregroundStyle(state == s ? .white : Color(hex: 0x7C3AED))
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                }
            }
            .padding(.horizontal, 24)

            activityPicker

            emphasisShowcase

            Toggle("Dark background", isOn: $dark)
                .font(.system(.subheadline, design: .rounded))
                .padding(.horizontal, 24)
                .tint(Color(hex: 0x7C3AED))
            }
            .padding(.vertical, 40)
            .frame(maxWidth: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background((dark ? Color(hex: 0x0E0F1E) : Color(hex: 0xF3F4FF)).ignoresSafeArea())
        .preferredColorScheme(dark ? .dark : .light)
    }

    /// Tap through the live activity motions on the hero mascot above.
    private var activityPicker: some View {
        VStack(spacing: 8) {
            Text("ACTIVITY (hero)")
                .font(.system(size: 11, weight: .heavy, design: .rounded)).kerning(1.5)
                .foregroundStyle(Color(hex: 0x7C3AED))
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(activityChoices, id: \.0) { label, a in
                        Button { activity = a } label: {
                            Text(label)
                                .font(.system(.caption, design: .rounded).weight(.bold))
                                .padding(.vertical, 8).padding(.horizontal, 14)
                                .background(activity == a ? Color(hex: 0x7C3AED) : Color(hex: 0x7C3AED).opacity(0.12))
                                .foregroundStyle(activity == a ? .white : Color(hex: 0x7C3AED))
                                .clipShape(Capsule())
                        }
                    }
                }
                .padding(.horizontal, 24)
            }
        }
    }

    private var activityChoices: [(String, MercActivity)] {
        [("idle", .idle), ("typing", .userTyping), ("thinking", .aiThinking),
         ("speaking", .aiSpeaking), ("success", .success), ("error", .error)]
    }

    /// Side-by-side comparison of the three MercMascot emphasis treatments, plus
    /// a small-avatar badge row — to eyeball legibility on the dark theme.
    private var emphasisShowcase: some View {
        VStack(spacing: 14) {
            Text("EMPHASIS")
                .font(.system(size: 11, weight: .heavy, design: .rounded)).kerning(1.5)
                .foregroundStyle(Color(hex: 0x7C3AED))
            HStack(alignment: .top, spacing: 16) {
                emphasisSample(".none", .none)
                emphasisSample(".softGlow", .softGlow)
                emphasisSample(".badge", .badge)
            }
            HStack(spacing: 16) {
                MercMascot(state, size: 36, emphasis: .badge)
                MercMascot(state, size: 52, emphasis: .badge)
                MercMascot(state, size: 72, emphasis: .badge)
            }
            Text("AVATAR — FULL vs BUST")
                .font(.system(size: 11, weight: .heavy, design: .rounded)).kerning(1.5)
                .foregroundStyle(Color(hex: 0x7C3AED))
            HStack(spacing: 16) {
                MercMascot(state, size: 32, emphasis: .badge)
                MercMascot(state, size: 32, presentation: .bust, emphasis: .badge)
                MercMascot(state, size: 44, presentation: .bust, emphasis: .badge)
            }
        }
        .padding(.horizontal, 24)
    }

    private func emphasisSample(_ title: String, _ e: MercMascot.Emphasis) -> some View {
        VStack(spacing: 8) {
            MercMascot(state, size: 92, emphasis: e)
            Text(title).font(.system(size: 10, weight: .bold, design: .monospaced))
                .foregroundStyle(dark ? Color(hex: 0x9AA3C2) : Color(hex: 0x7D7A93))
        }
        .frame(maxWidth: .infinity)
    }
}

#if DEBUG
#Preview("Merc preview") { MercPreviewView() }
#endif
