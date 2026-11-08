import Testing
import Foundation
@testable import NetworkingKit

// AUD-32 over real sockets: URLSession's own metrics, from real TCP and TLS
// on the loopback interface, decide how a timeout is classified. Each case
// waits out a one-second timeout.
//
// - A SYN to a loopback address nothing holds is never answered, as a network
//   that swallows our traffic drops it: the request never connects.
// - A listener that accepts and never answers is a connected server that
//   stalls (over https, the TLS hello is swallowed instead: never connected).
// - A server that sends the stream's headers and a first frame, then goes
//   quiet, is a connection lost mid-reply.

@Suite("APIClient over loopback sockets: timeouts by connection phase")
struct LoopbackNetworkTests {

    private func client(_ server: LoopbackServer, scheme: String = "http", pathSatisfied: Bool?) -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.connectionProxyDictionary = [:]   // never via a system proxy
        return APIClient(
            environment: APIEnvironment(
                baseURL: URL(string: "\(scheme)://\(server.host):\(server.port)")!,
                requestTimeout: 1,
                streamingTimeout: 1
            ),
            sessionIdentity: SessionIdentity(),
            sessionConfiguration: config,
            pathSatisfied: { pathSatisfied }
        )
    }

    private func quizError(_ client: APIClient) async -> APIError? {
        do {
            _ = try await client.generateQuiz(sessionId: "sid")
            return nil
        } catch {
            return error as? APIError
        }
    }

    private func streamOutcome(_ client: APIClient) async -> (events: [ChatStreamEvent], error: APIError?) {
        var events: [ChatStreamEvent] = []
        do {
            for try await event in client.streamChat(
                messages: [ChatMessageDTO(role: "user", content: "hi")], sessionId: "sid"
            ) {
                events.append(event)
            }
            return (events, nil)
        } catch {
            return (events, error as? APIError)
        }
    }

    @Test("SYNs dropped on a working path: the network, on the JSON route and the stream")
    func dropsSYNs() async throws {
        let server = try LoopbackServer(.dropSYNs)
        defer { server.stop() }
        let quiz = await quizError(client(server, pathSatisfied: true))
        let stream = await streamOutcome(client(server, pathSatisfied: true)).error
        #expect(quiz == .unreachableOnThisNetwork)
        #expect(stream == .unreachableOnThisNetwork)
    }

    @Test("SYNs dropped with no path is offline; with the path unknown it stays a timeout")
    func dropsSYNsPathStates() async throws {
        let server = try LoopbackServer(.dropSYNs)
        defer { server.stop() }
        let offline = await quizError(client(server, pathSatisfied: false))
        let unknown = await quizError(client(server, pathSatisfied: nil))
        #expect(offline == .offline)
        #expect(unknown == .timeout)
    }

    @Test("Connected but no answer: 'the server may be busy', never 'your network'")
    func connectedSilence() async throws {
        let server = try LoopbackServer(.acceptSilently)
        defer { server.stop() }
        let quiz = await quizError(client(server, pathSatisfied: true))
        let stream = await streamOutcome(client(server, pathSatisfied: true)).error
        #expect(quiz == .timeout)
        #expect(stream == .timeout)
    }

    @Test("TLS hello swallowed: never connected, so the network")
    func tlsSwallowed() async throws {
        let server = try LoopbackServer(.acceptSilently)
        defer { server.stop() }
        let quiz = await quizError(client(server, scheme: "https", pathSatisfied: true))
        #expect(quiz == .unreachableOnThisNetwork)
    }

    @Test("Headers and a first frame, then silence: the reply so far, then a dropped connection")
    func stallAfterHeaders() async throws {
        let server = try LoopbackServer(.headersThenStall)
        defer { server.stop() }
        let outcome = await streamOutcome(client(server, pathSatisfied: true))
        #expect(outcome.events == [.delta(text: "Tokens are")])
        #expect(outcome.error == .connectionLost)
    }
}

/// A TCP endpoint on loopback with one misbehaviour.
private final class LoopbackServer: @unchecked Sendable {
    enum Behaviour {
        /// Nothing answers the SYN: no SYN-ACK, no reset. The connect never
        /// finishes, as on a network that drops our traffic.
        case dropSYNs
        /// Accept every connection, never read or write.
        case acceptSilently
        /// Answer with event-stream headers and one delta frame, then go quiet.
        case headersThenStall
    }

    struct SocketError: Error, CustomStringConvertible {
        let step: String
        let code: Int32
        var description: String { "\(step): \(LoopbackServer.describe(code))" }
    }

    /// The harness itself can't do what a test needs on this machine: the
    /// test fails with what went wrong, not with a misleading classification.
    struct HarnessError: Error, CustomStringConvertible {
        let description: String
    }

    let host: String
    let port: UInt16
    /// Nil for `.dropSYNs`: nothing listens there.
    private let listener: Int32?
    private let lock = NSLock()
    private var open: [Int32] = []
    private var stopped = false

    init(_ behaviour: Behaviour) throws {
        switch behaviour {
        case .dropSYNs:
            host = try Self.unansweredLoopbackAddress()
            port = Self.unansweredPort
            listener = nil
        case .acceptSilently, .headersThenStall:
            let (fd, boundPort) = try Self.listen(backlog: 16)
            host = "127.0.0.1"
            port = boundPort
            listener = fd
            let answers = behaviour == .headersThenStall
            Thread.detachNewThread { [self] in acceptLoop(on: fd, answering: answers) }
        }
    }

    // MARK: Dropped SYNs

    /// Addresses on loopback's 127/8 route that no interface holds (lo0
    /// carries only 127.0.0.1 unless someone adds an alias). A SYN to one
    /// goes out on lo0, comes back in addressed to no one on this host, and
    /// is discarded: no SYN-ACK, no reset, and the connect never finishes.
    ///
    /// The harness used to fill a backlog-of-one listener instead and count
    /// on the kernel dropping SYNs to a full accept queue. On macOS 27.2 the
    /// handshake completes anyway and the connection is reset at once: the
    /// client gets ECONNRESET within a millisecond, and URLSession reports a
    /// dropped connection (-1005, with connectEndDate set), not a connect
    /// that never finished. (That fits SYN cookies, which 27.2 ships on:
    /// net.inet.tcp.syncookie=1.) A black hole doesn't depend on what the
    /// kernel does with a full accept queue.
    private static let unansweredAddresses = ["127.0.0.2", "127.255.255.254"]
    /// Any port: nothing at these addresses answers on any of them.
    private static let unansweredPort: UInt16 = 9

    /// The first candidate a SYN really goes unanswered at, checked now: on
    /// loopback a refusal or a reset comes back within a millisecond, so a
    /// connect still pending after the wait was dropped.
    private static func unansweredLoopbackAddress() throws -> String {
        var outcomes: [String] = []
        for candidate in unansweredAddresses {
            guard let answer = synAnswer(host: candidate, port: unansweredPort) else { return candidate }
            outcomes.append("\(candidate):\(unansweredPort) → \(answer)")
        }
        throw HarnessError(description: "no loopback address leaves a SYN unanswered on this machine ("
            + outcomes.joined(separator: "; ") + "), so these tests can't simulate a dropped SYN")
    }

    /// What a SYN to `host:port` gets back within `waitMilliseconds`: nil if
    /// nothing (the connect is still pending), else what came back.
    private static func synAnswer(host: String, port: UInt16, waitMilliseconds: Int32 = 150) -> String? {
        var address = loopback(host, port: port)
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return "socket: \(describe(errno))" }
        defer { close(fd) }
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
        if withSockaddr(&address, { connect(fd, $0, $1) }) == 0 { return "connected" }
        guard errno == EINPROGRESS else { return describe(errno) }
        var poller = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
        let ready = poll(&poller, 1, waitMilliseconds)
        if ready == 0 { return nil }
        if ready < 0 { return "poll: \(describe(errno))" }
        var soError: Int32 = 0
        var length = socklen_t(MemoryLayout<Int32>.size)
        getsockopt(fd, SOL_SOCKET, SO_ERROR, &soError, &length)
        return soError == 0 ? "connected" : describe(soError)
    }

    // MARK: Listening

    private static func listen(backlog: Int32) throws -> (fd: Int32, port: UInt16) {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw SocketError(step: "socket", code: errno) }
        var yes: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
        var address = loopback("127.0.0.1", port: 0)
        guard withSockaddr(&address, { bind(fd, $0, $1) }) == 0 else {
            let code = errno
            close(fd)
            throw SocketError(step: "bind", code: code)
        }
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
        }
        guard Darwin.listen(fd, backlog) == 0 else {
            let code = errno
            close(fd)
            throw SocketError(step: "listen", code: code)
        }
        return (fd, UInt16(bigEndian: address.sin_port))
    }

    private static func loopback(_ host: String, port: UInt16) -> sockaddr_in {
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr(host)
        address.sin_port = port.bigEndian
        return address
    }

    private static func withSockaddr(
        _ address: inout sockaddr_in,
        _ body: (UnsafePointer<sockaddr>, socklen_t) -> Int32
    ) -> Int32 {
        withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                body($0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
    }

    fileprivate static func describe(_ code: Int32) -> String {
        "\(String(cString: strerror(code))) (errno \(code))"
    }

    func stop() {
        lock.lock()
        stopped = true
        let fds = open
        open = []
        lock.unlock()
        fds.forEach { close($0) }
        if let listener { close(listener) }
    }

    private var isStopped: Bool {
        lock.lock()
        defer { lock.unlock() }
        return stopped
    }

    private func track(_ fd: Int32) {
        lock.lock()
        open.append(fd)
        lock.unlock()
    }

    private func acceptLoop(on listener: Int32, answering: Bool) {
        while !isStopped {
            var poller = pollfd(fd: listener, events: Int16(POLLIN), revents: 0)
            guard poll(&poller, 1, 100) > 0, !isStopped else { continue }
            let connection = accept(listener, nil, nil)
            guard connection >= 0 else { continue }
            track(connection)
            if answering { answer(connection) }
        }
    }

    private func answer(_ connection: Int32) {
        var buffer = [UInt8](repeating: 0, count: 65_536)
        _ = read(connection, &buffer, buffer.count)
        let frame = #"data: {"type":"delta","text":"Tokens are"}"# + "\n\n"
        let response = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n"
            + String(frame.utf8.count, radix: 16) + "\r\n" + frame + "\r\n"
        let bytes = Array(response.utf8)
        _ = bytes.withUnsafeBytes { write(connection, $0.baseAddress, $0.count) }
    }
}
