import Testing
import Foundation
@testable import NetworkingKit

// AUD-30 (iOS half): a daily limit names its reset as a local clock time
// instead of the server's "tomorrow" (UTC midnight is the same evening in
// the Americas); the network's allowance says cellular data works now and
// keeps Retry; the spend cap and the kill switch drop Retry.

/// The audit's capture: refused at 21:10:57Z with `retryAfterSec` 10143,
/// which is exactly 00:00Z.
private let auditNow = "2026-10-18T21:10:57Z"
private let auditWait: TimeInterval = 10_143

private let lessonTurnsCopy = "You've used today's lesson turns. Mercurius will be ready again tomorrow."
private let newSessionsCopy = "Too many new sessions from this network today."
private let networkUsdCopy = "This network has reached today's usage limit. Mercurius will be ready again tomorrow."

@Suite("ServerRefusal: the reset as a local time")
struct ServerRefusalResetTimeTests {

    @Test("UTC midnight reads as the same evening in the Americas, not 'tomorrow'", arguments: [
        ("America/Chicago", "after 7:00 PM"),
        ("America/New_York", "after 8:00 PM"),
        ("America/Los_Angeles", "after 5:00 PM"),
        // Already the next morning there; the reset is later that morning.
        ("Asia/Tokyo", "after 9:00 AM"),
        ("Australia/Sydney", "after 11:00 AM"),
        // After local midnight in London (BST): tomorrow, with the time.
        ("Europe/London", "tomorrow after 1:00 AM"),
        // A reset at local midnight is just "tomorrow".
        ("UTC", "tomorrow"),
    ])
    func resetPhrase(zone: String, expected: String) {
        let clock = LocalClock.pinned(utc: auditNow, zone: zone)
        let phrase = ServerRefusal.resetPhrase(retryAfter: auditWait, clock: clock)
        #expect(phrase.map(normalized) == expected)
    }

    @Test("A session's daily limit swaps the server's 'tomorrow' for the clock time and drops Retry")
    func sessionDailyLimit() {
        let refusal = ServerRefusal(code: "daily_limit", message: lessonTurnsCopy, retryAfter: auditWait, scope: "session")
        let clock = LocalClock.pinned(utc: auditNow, zone: "America/Chicago")
        #expect(normalized(refusal.studentMessage(clock: clock))
            == "You've used today's lesson turns. Try again after 7:00 PM.")
        #expect(!refusal.isNetworkScoped)
        #expect(!refusal.isRetryable)
    }

    @Test("The time shown is never before the reset: a little slack, then up to the next minute")
    func rounding() {
        let clock = LocalClock.pinned(utc: "2026-10-18T18:00:00Z", zone: "America/Chicago")
        // 19:02:05Z less the 5 s slack lands on 19:02:00 exactly.
        #expect(ServerRefusal.resetPhrase(retryAfter: 3_725, clock: clock).map(normalized) == "after 2:02 PM")
        // One second later rounds up.
        #expect(ServerRefusal.resetPhrase(retryAfter: 3_726, clock: clock).map(normalized) == "after 2:03 PM")
        // The server's ceil plus a slow reply (a few seconds past 00:00Z)
        // still reads as the hour.
        let late = LocalClock.pinned(utc: "2026-10-18T21:10:59Z", zone: "America/New_York")
        #expect(ServerRefusal.resetPhrase(retryAfter: auditWait, clock: late).map(normalized) == "after 8:00 PM")
    }

    @Test("No usable wait leaves the server's copy as written", arguments: [
        nil, 0, -60, 27 * 3600, TimeInterval.infinity,
    ] as [TimeInterval?])
    func noUsableWait(wait: TimeInterval?) {
        let refusal = ServerRefusal(code: "daily_limit", message: lessonTurnsCopy, retryAfter: wait, scope: "session")
        let clock = LocalClock.pinned(utc: auditNow, zone: "America/Chicago")
        #expect(refusal.studentMessage(clock: clock) == lessonTurnsCopy)
    }

    @Test("Uses the locale's own time format")
    func localeFormat() {
        let clock = LocalClock.pinned(utc: auditNow, zone: "Europe/Berlin", locale: "de_DE")
        // 00:00Z is 2 AM the next day in Berlin (CEST): German's 24-hour clock.
        let phrase = ServerRefusal.resetPhrase(retryAfter: auditWait, clock: clock) ?? ""
        #expect(phrase.hasPrefix("tomorrow after "))
        #expect(phrase.contains("2:00"))
        #expect(!phrase.contains("AM"))
    }
}

@Suite("ServerRefusal: the network's allowance")
struct ServerRefusalNetworkScopeTests {

    @Test("The network's new-session cap says cellular works now, keeps the time, and offers Retry")
    func newSessions() {
        // Today's SSE frame carries no scope: the copy decides.
        let refusal = ServerRefusal(code: "daily_limit", message: newSessionsCopy, retryAfter: auditWait)
        let clock = LocalClock.pinned(utc: auditNow, zone: "America/Chicago")
        #expect(refusal.isNetworkScoped)
        #expect(refusal.isRetryable)
        #expect(normalized(refusal.studentMessage(clock: clock, advice: .cellular))
            == "Too many new sessions from this network today. Switch to cellular data and try again, or come back after 7:00 PM.")
        // A Mac has no cellular data: it points at a phone's hotspot.
        #expect(normalized(refusal.studentMessage(clock: clock, advice: .hotspot))
            == "Too many new sessions from this network today. Switch to another network, like your phone's hotspot, and try again, or come back after 7:00 PM.")
    }

    @Test("The network's dollar cap loses its 'tomorrow' too")
    func networkUsd() {
        let refusal = ServerRefusal(code: "daily_limit", message: networkUsdCopy, retryAfter: auditWait, scope: "ip")
        let clock = LocalClock.pinned(utc: auditNow, zone: "America/New_York")
        #expect(normalized(refusal.studentMessage(clock: clock, advice: .cellular))
            == "This network has reached today's usage limit. Switch to cellular data and try again, or come back after 8:00 PM.")
    }

    @Test("Without a wait, the network's copy still says cellular works")
    func networkNoWait() {
        let refusal = ServerRefusal(code: "daily_limit", message: newSessionsCopy, retryAfter: nil)
        #expect(refusal.studentMessage(clock: .pinned(utc: auditNow, zone: "UTC"), advice: .cellular)
            == "Too many new sessions from this network today. Switch to cellular data and try again.")
        #expect(refusal.studentMessage(clock: .pinned(utc: auditNow, zone: "UTC"), advice: .hotspot)
            == "Too many new sessions from this network today. Switch to another network, like your phone's hotspot, and try again.")
    }

    @Test("A wire scope outranks the copy")
    func scopeWins() {
        #expect(!ServerRefusal(code: "daily_limit", message: newSessionsCopy, retryAfter: nil, scope: "session").isNetworkScoped)
        #expect(ServerRefusal(code: "daily_limit", message: "Limit reached.", retryAfter: nil, scope: "ip").isNetworkScoped)
        #expect(!ServerRefusal(code: "daily_limit", message: "Limit reached.", retryAfter: nil).isNetworkScoped)
        // A future copy that names the Wi-Fi.
        #expect(ServerRefusal(code: "daily_limit", message: "Too many new sign-ups from this Wi-Fi today.", retryAfter: nil).isNetworkScoped)
    }

    @Test("Only a daily limit can be the network's")
    func onlyDailyLimit() {
        let busy = ServerRefusal(code: "busy", message: "This network is busy.", retryAfter: 60, scope: "ip")
        #expect(!busy.isNetworkScoped)
        #expect(busy.studentMessage() == "This network is busy.")
    }
}

/// lib/quotas.js's photo allowances, as POST /api/images sends them.
private let photoUploadsCopy = "You've used today's photo uploads — you can still type your question. Photos come back tomorrow."
private let networkImagesCopy = "This network has reached today's image upload limit. Switch to cellular data, or try again tomorrow."

@Suite("ServerRefusal: the photo allowance")
struct ServerRefusalPhotoAllowanceTests {

    @Test("The student's photo allowance says when photos come back, not 'Try again', and has no Retry")
    func studentPhotos() {
        let refusal = ServerRefusal(code: "daily_limit", message: photoUploadsCopy, retryAfter: auditWait, scope: "session")
        #expect(refusal.isPhotoAllowance)
        #expect(!refusal.isNetworkScoped)
        #expect(!refusal.isRetryable)
        #expect(normalized(refusal.studentMessage(clock: .pinned(utc: auditNow, zone: "America/Chicago")))
            == "You've used today's photo uploads — you can still type your question. Photos come back after 7:00 PM.")
        // A reset at local midnight reads as plain "tomorrow".
        #expect(refusal.studentMessage(clock: .pinned(utc: auditNow, zone: "UTC"))
            == "You've used today's photo uploads — you can still type your question. Photos come back tomorrow.")
    }

    @Test("The network's photo allowance keeps its cellular advice and its Retry")
    func networkPhotos() {
        let refusal = ServerRefusal(code: "daily_limit", message: networkImagesCopy, retryAfter: auditWait, scope: "ip")
        #expect(refusal.isPhotoAllowance)
        #expect(refusal.isRetryable)
        #expect(normalized(refusal.studentMessage(clock: .pinned(utc: auditNow, zone: "America/Chicago"), advice: .cellular))
            == "This network has reached today's image upload limit. Switch to cellular data and try again, or come back after 7:00 PM.")
    }

    @Test("No other refusal is a photo allowance")
    func others() {
        #expect(!ServerRefusal(code: "daily_limit", message: lessonTurnsCopy, retryAfter: auditWait, scope: "session").isPhotoAllowance)
        #expect(!ServerRefusal(code: "daily_limit", message: networkUsdCopy, retryAfter: auditWait, scope: "ip").isPhotoAllowance)
        // Not a daily limit, whatever the copy says.
        #expect(!ServerRefusal(code: "busy", message: "Mercurius is busy. Try the photo again in a moment.", retryAfter: 5).isPhotoAllowance)
    }
}

@Suite("ServerRefusal: Retry and verbatim copy")
struct ServerRefusalRetryTests {

    @Test("Retry only where it can help", arguments: [
        ("daily_limit", false),
        ("spend_cap", false),
        ("service_disabled", false),
        ("busy", true),
        ("restarting", true),
        ("some_future_code", true),
    ])
    func retry(code: String, retryable: Bool) {
        #expect(ServerRefusal(code: code, message: "m", retryAfter: 60, scope: "session").isRetryable == retryable)
    }

    @Test("Refusals other than a daily limit keep the server's copy, whatever the wait")
    func verbatim() {
        let clock = LocalClock.pinned(utc: auditNow, zone: "America/Chicago")
        let copies = [
            ("spend_cap", "Daily usage limit reached — please try again tomorrow."),
            ("service_disabled", "Mercurius is temporarily paused — please try again soon."),
            ("busy", "Mercurius is helping a lot of students right now. Try again in a minute."),
            ("restarting", "Mercurius is restarting — try again in a few seconds."),
        ]
        for (code, copy) in copies {
            #expect(ServerRefusal(code: code, message: copy, retryAfter: 60).studentMessage(clock: clock) == copy)
        }
    }

    @Test("Empty copy falls back to calm text")
    func emptyCopy() {
        #expect(ServerRefusal(code: "busy", message: "  \n", retryAfter: nil).message == ServerRefusal.fallbackMessage)
    }

    @Test("Dropping 'tomorrow' keeps every other sentence, and never leaves nothing")
    func droppingTomorrow() {
        #expect(ServerRefusal.droppingTomorrow(from: "A. Back tomorrow! B? C.") == "A. B? C.")
        #expect(ServerRefusal.droppingTomorrow(from: "Come back Tomorrow.") == "You've reached today's limit.")
        #expect(ServerRefusal.droppingTomorrow(from: "Version 2.3 is out. Ready tomorrow.") == "Version 2.3 is out.")
    }

    @Test("The SSE event and the JSON error describe the same refusal")
    func bothWireShapes() {
        let event = ChatStreamEvent.refusal(code: "daily_limit", message: newSessionsCopy, retryAfter: 600)
        let error = APIError.quotaExceeded(message: newSessionsCopy, retryAfter: 600)
        #expect(event.serverRefusal == error.serverRefusal)
        #expect(ChatStreamEvent.delta(text: "x").serverRefusal == nil)
        #expect(APIError.timeout.serverRefusal == nil)
    }
}

// MARK: - Contract with the server's copy

/// lib/quotas.js, when the package is built inside the repo (CI and local).
private let quotasSource: String? = {
    let repoRoot = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()   // …/NetworkingKit/Tests
        .deletingLastPathComponent()   // …/Packages/NetworkingKit
        .deletingLastPathComponent()   // …/ios/Packages
        .deletingLastPathComponent()   // …/ios
        .deletingLastPathComponent()   // the repo root
    return try? String(contentsOf: repoRoot.appendingPathComponent("lib/quotas.js"), encoding: .utf8)
}()

@Suite("ServerRefusal: contract with lib/quotas.js", .enabled(if: quotasSource != nil))
struct ServerRefusalQuotaContractTests {

    /// `reason → copy` from DAILY_MESSAGES, with `${TOMORROW}` filled in.
    private static func dailyMessages(in source: String) throws -> [String: String] {
        let tomorrow = try #require(firstMatch(#"const TOMORROW = '([^']*)';"#, in: source)?.first)
        let block = try #require(source.range(of: "const DAILY_MESSAGES"))
        let end = try #require(source.range(of: "});", range: block.upperBound..<source.endIndex))
        var messages: [String: String] = [:]
        for line in source[block.upperBound..<end.lowerBound].split(separator: "\n") {
            guard let parts = firstMatch(#"^\s*(\w+):\s*[`'](.*)[`'],?\s*$"#, in: String(line)), parts.count == 2 else { continue }
            messages[parts[0]] = parts[1].replacingOccurrences(of: "${TOMORROW}", with: tomorrow)
        }
        return messages
    }

    /// `(scope, reason)` for every `dailyLimit('scope', 'reason')` call.
    private static func dailyLimitCalls(in source: String) -> [(scope: String, reason: String)] {
        let regex = try! NSRegularExpression(pattern: #"dailyLimit\('(\w+)', '(\w+)'\)"#)
        let range = NSRange(source.startIndex..., in: source)
        return regex.matches(in: source, range: range).map {
            (String(source[Range($0.range(at: 1), in: source)!]), String(source[Range($0.range(at: 2), in: source)!]))
        }
    }

    private static func firstMatch(_ pattern: String, in text: String) -> [String]? {
        let regex = try! NSRegularExpression(pattern: pattern)
        guard let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else { return nil }
        return (1..<match.numberOfRanges).compactMap { Range(match.range(at: $0), in: text).map { String(text[$0]) } }
    }

    @Test("Without a wire scope, the copy alone tells the network's allowance from the student's")
    func copyTellsScope() throws {
        let source = try #require(quotasSource)
        let messages = try Self.dailyMessages(in: source)
        let calls = Self.dailyLimitCalls(in: source)
        #expect(!calls.isEmpty)
        #expect(calls.contains { $0.scope == "ip" })
        #expect(calls.contains { $0.scope == "session" })
        for call in calls {
            let copy = try #require(messages[call.reason], "no DAILY_MESSAGES entry for \(call.reason)")
            let refusal = ServerRefusal(code: "daily_limit", message: copy, retryAfter: 3600)
            #expect(refusal.isNetworkScoped == (call.scope == "ip"), "\(call.reason): \(copy)")
        }
    }

    @Test("The copy alone tells a photo allowance from every other daily limit")
    func copyTellsPhotoAllowance() throws {
        let source = try #require(quotasSource)
        let messages = try Self.dailyMessages(in: source)
        let calls = Self.dailyLimitCalls(in: source)
        // `images` (the student's) and `ip_images` (the network's).
        #expect(calls.filter { $0.reason.contains("image") }.count >= 2)
        for call in calls {
            let copy = try #require(messages[call.reason], "no DAILY_MESSAGES entry for \(call.reason)")
            let refusal = ServerRefusal(code: "daily_limit", message: copy, retryAfter: 3600)
            #expect(refusal.isPhotoAllowance == call.reason.contains("image"), "\(call.reason): \(copy)")
        }
    }

    @Test("On the server's real copy, a same-evening reset never reads as 'tomorrow'")
    func noFalseTomorrow() throws {
        let source = try #require(quotasSource)
        let messages = try Self.dailyMessages(in: source)
        let clock = LocalClock.pinned(utc: auditNow, zone: "America/Chicago")
        #expect(messages.count >= 7)
        for (reason, copy) in messages {
            let shown = ServerRefusal(code: "daily_limit", message: copy, retryAfter: auditWait).studentMessage(clock: clock)
            #expect(!shown.lowercased().contains("tomorrow"), "\(reason): \(shown)")
            #expect(normalized(shown).contains("after 7:00 PM"), "\(reason): \(shown)")
        }
    }
}

@Suite("Network advice per platform")
struct NetworkSwitchAdviceTests {
    @Test("An iPhone is told about cellular data; a Mac, which has none, about a phone's hotspot")
    func platformAdvice() {
        #if os(macOS)
        #expect(NetworkSwitchAdvice.current == .hotspot)
        #else
        #expect(NetworkSwitchAdvice.current == .cellular)
        #endif
        #expect(APIError.unreachableOnThisNetwork.userFacingMessage(clock: .current, advice: .cellular)
            == "This network may be blocking Mercurius. School Wi-Fi often does. Try cellular data or a different Wi-Fi.")
        #expect(APIError.unreachableOnThisNetwork.userFacingMessage(clock: .current, advice: .hotspot)
            == "This network may be blocking Mercurius. School Wi-Fi often does. Try a different network, like your phone's hotspot.")
        for advice in NetworkSwitchAdvice.allCases where advice == .hotspot {
            #expect(!advice.switchNetwork.contains("cellular") && !advice.tryAnotherNetwork.contains("cellular"))
        }
    }
}
