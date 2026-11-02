import Foundation

/// The device's clock, calendar (with its time zone) and locale, for copy
/// that names a local time. Injectable so tests can pin all three.
public struct LocalClock: Sendable {
    public var now: @Sendable () -> Date
    public var calendar: Calendar
    public var locale: Locale

    public init(
        now: @escaping @Sendable () -> Date = { Date() },
        calendar: Calendar = .autoupdatingCurrent,
        locale: Locale = .autoupdatingCurrent
    ) {
        self.now = now
        self.calendar = calendar
        self.locale = locale
    }

    /// The device's own clock, time zone and locale.
    public static var current: LocalClock { LocalClock() }
}

/// A server refusal — the day's allowance used up, the spend cap, the kill
/// switch, a busy or restarting server — and what the student should see
/// and be offered for it. The one place both wire shapes (a JSON 429/503 and
/// the SSE `error` frame on /api/chat) are turned into copy and a Retry rule,
/// so the two can't drift (AUD-30).
public struct ServerRefusal: Equatable, Sendable {
    /// The wire code (`ServerRefusalCode` raw value, or an unknown one).
    public let code: String
    /// The server's own student-facing copy, trimmed.
    public let message: String
    /// Seconds until it's worth trying again, as the server sent it.
    public let retryAfter: TimeInterval?
    /// `"session"`, `"ip"` or `"global"`, when the wire says. The JSON body
    /// carries it; today's SSE refusal frame doesn't.
    public let scope: String?

    static let fallbackMessage = "Mercurius can't answer right now. Please try again soon."

    public init(code: String, message: String, retryAfter: TimeInterval?, scope: String? = nil) {
        self.code = code
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        self.message = trimmed.isEmpty ? Self.fallbackMessage : trimmed
        self.retryAfter = retryAfter
        self.scope = scope
    }

    var isDailyLimit: Bool { code == ServerRefusalCode.dailyLimit.rawValue }

    /// A daily allowance that belongs to the network — the school's one
    /// shared address — rather than to this student. Another network
    /// (cellular data) isn't under it, so trying again there can work now.
    ///
    /// The JSON body says so with `scope: "ip"`. The SSE frame carries no
    /// scope today, so then the server's copy decides: every network-scoped
    /// message names the network ("This network has reached…", "…from this
    /// network today.") and no student-scoped one does. `ServerRefusalTests`
    /// pins that against `lib/quotas.js`.
    public var isNetworkScoped: Bool {
        guard isDailyLimit else { return false }
        if let scope { return scope == "ip" }
        let lowered = message.lowercased()
        return ["network", "wi-fi", "wifi"].contains { lowered.contains($0) }
    }

    /// Today's photo uploads are used up: the student's own (`images`) or
    /// the network's (`ip_images`). Only photos wait. Typed questions still
    /// go through, which is what the student's copy says ("you can still
    /// type your question").
    ///
    /// No frame says which allowance it was, so the server's copy decides:
    /// every photo allowance's message names photos or images, and no other
    /// daily limit's does. `ServerRefusalTests` pins that against
    /// `lib/quotas.js`.
    public var isPhotoAllowance: Bool {
        guard isDailyLimit else { return false }
        let lowered = message.lowercased()
        return ["photo", "image"].contains { lowered.contains($0) }
    }

    /// Whether a Retry can help. A used-up allowance, the spend cap and the
    /// kill switch only say no again until they lift, so no Retry: the
    /// student reads when to come back instead. A network-scoped allowance
    /// is the exception, because switching to cellular gets past it. Busy,
    /// restarting and unknown refusals are moments, so Retry stays.
    public var isRetryable: Bool {
        switch ServerRefusalCode(rawValue: code) {
        case .dailyLimit: return isNetworkScoped
        case .spendCap, .serviceDisabled: return false
        case .busy, .restarting, nil: return true
        }
    }

    /// The copy to show. A daily limit gets its reset as a local clock time
    /// (the server's "tomorrow" is UTC midnight, which is the same evening in
    /// the Americas), and a network-scoped one says cellular data works now.
    /// The student's photo allowance says when photos come back, not "Try
    /// again after…": its copy has just said typing still works.
    /// Everything else is the server's copy as written.
    public func studentMessage(clock: LocalClock = .current, advice: NetworkSwitchAdvice = .current) -> String {
        guard isDailyLimit else { return message }
        let reset = Self.resetPhrase(retryAfter: retryAfter, clock: clock)
        let kept = reset == nil ? message : Self.droppingTomorrow(from: message)
        if isNetworkScoped {
            guard let reset else { return "\(message) \(advice.switchNetwork) and try again." }
            return "\(kept) \(advice.switchNetwork) and try again, or come back \(reset)."
        }
        guard let reset else { return message }
        if isPhotoAllowance { return "\(kept) Photos come back \(reset)." }
        return "\(kept) Try again \(reset)."
    }

    // MARK: - Reset time

    /// "after 8:00 PM" (later today), "tomorrow after 7:00 AM", or "tomorrow"
    /// for a reset at local midnight. Nil when the wait is missing or not a
    /// daily one (over 26 hours), so the server's copy stands.
    static func resetPhrase(retryAfter: TimeInterval?, clock: LocalClock) -> String? {
        guard let retryAfter, retryAfter.isFinite, retryAfter > 0, retryAfter <= 26 * 3600 else {
            return nil
        }
        let now = clock.now()
        // The server rounds its wait up to the second and the reply takes a
        // moment to arrive, so the raw sum lands a second or two past the
        // reset. Take a few seconds off, then round up to the minute: the
        // time shown is never before the reset.
        let estimate = now.addingTimeInterval(retryAfter - 5)
        let calendar = clock.calendar
        let reset = calendar.dateInterval(of: .minute, for: estimate).map {
            $0.start == estimate ? estimate : $0.end
        } ?? estimate
        let days = calendar.dateComponents(
            [.day],
            from: calendar.startOfDay(for: now),
            to: calendar.startOfDay(for: reset)
        ).day ?? 0
        let time = Date.FormatStyle(
            date: .omitted,
            time: .shortened,
            locale: clock.locale,
            calendar: calendar,
            timeZone: calendar.timeZone
        ).format(reset)
        switch days {
        case 0:
            return "after \(time)"
        case 1:
            let parts = calendar.dateComponents([.hour, .minute], from: reset)
            return parts.hour == 0 && parts.minute == 0 ? "tomorrow" : "tomorrow after \(time)"
        default:
            return nil
        }
    }

    /// The server's copy without the sentences that say "tomorrow" — wrong
    /// for most of the day in the Americas, and replaced by the clock time.
    static func droppingTomorrow(from message: String) -> String {
        let kept = sentences(in: message).filter { !$0.lowercased().contains("tomorrow") }
        return kept.isEmpty ? "You've reached today's limit." : kept.joined(separator: " ")
    }

    private static func sentences(in text: String) -> [String] {
        var result: [String] = []
        var current = ""
        let characters = Array(text)
        for (index, character) in characters.enumerated() {
            current.append(character)
            let atBoundary = index + 1 == characters.count || characters[index + 1].isWhitespace
            if ".!?".contains(character), atBoundary {
                result.append(current)
                current = ""
            }
        }
        result.append(current)
        return result
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }
}

/// Where the copy sends a student whose network blocks or limits Mercurius
/// (a school's): an iPhone has cellular data; a Mac has none, but can
/// usually join a phone's hotspot. The platform's own by default
/// (`current`); the tests pin both.
public enum NetworkSwitchAdvice: Sendable, CaseIterable {
    case cellular
    case hotspot

    public static var current: NetworkSwitchAdvice {
        #if os(macOS)
        return .hotspot
        #else
        return .cellular
        #endif
    }

    /// Before "and try again": a network's daily allowance is used up.
    public var switchNetwork: String {
        switch self {
        case .cellular: return "Switch to cellular data"
        case .hotspot: return "Switch to another network, like your phone's hotspot,"
        }
    }

    /// The last sentence when a network seems to block Mercurius.
    public var tryAnotherNetwork: String {
        switch self {
        case .cellular: return "Try cellular data or a different Wi-Fi."
        case .hotspot: return "Try a different network, like your phone's hotspot."
        }
    }
}
