import SwiftUI
import PhotosUI
import DesignSystem
#if os(macOS)
import AppKit
#endif

/// Message composer. Grows with content up to `maxLines` lines (5 by
/// default), then scrolls. Supports
/// attaching one photo (shown as a thumbnail above the field). Disables the
/// send button while a request is in flight or a photo is still preparing.
/// Holds at most `characterLimit` characters — what the server reads — and
/// says so when a paste is cut.
struct ChatInputBar: View {
    @Binding var text: String
    let isSending: Bool
    let attachment: ChatImage?
    let isPreparingAttachment: Bool
    /// Why the last picked photo couldn't be attached.
    let attachmentError: String?
    /// Why the last send came back unsent: today's photo uploads are used
    /// up (`ChatViewModel.photoLimitNotice`). Unlike `attachmentError` it
    /// stays until the next send or pick: the student needs time to read it.
    var photoLimitNotice: String? = nil
    let characterLimit: Int
    let onSend: () -> Void
    let onCancel: () -> Void
    let onAttachImage: (Data) -> Void
    let onRemoveAttachment: () -> Void
    /// When true, the send button becomes the "Playful" 42pt circle filled with
    /// the brand gradient (lesson screen). Defaults off so free chat is unchanged.
    var useBrandSend: Bool = false
    /// When true, the bar's background fades to transparent at the top so a
    /// mascot anchored behind it dissolves in (lesson screen). Defaults off.
    var backgroundFade: Bool = false
    /// Increment to programmatically focus the text field (e.g. tapping the
    /// lesson check-question callout). A counter rather than a Bool so every
    /// tap re-focuses even if the field was focused-then-dismissed.
    var focusTrigger: Int = 0
    /// What the empty field says. Free chat invites a question; a lesson
    /// passes its own ("Type your answer…"), since there Merc is the one
    /// asking (AUD-44).
    var placeholder: String = "Ask Mercurius…"
    /// A shorter placeholder for accessibility sizes, where the field fits
    /// only a few characters ("Type yo…", even "Your an…", at AX5 on an
    /// SE). Nil keeps
    /// `placeholder` at every size.
    var compactPlaceholder: String? = nil
    /// The most lines the field grows to before it scrolls. A lesson caps it
    /// lower so a long answer can't swallow the reading area above.
    var maxLines: Int = 5
    /// Told when the field gains or loses focus (the keyboard rises or falls).
    var onFocusChange: ((Bool) -> Void)? = nil
    #if os(macOS)
    /// Increment to open the image file panel (File ▸ Attach Image…, ⇧⌘A).
    var attachTrigger: Int = 0
    /// The field takes focus when it appears (and when it is enabled again).
    /// A lesson turns this off: it opens on Merc's reply, and a check takes
    /// the keyboard while it waits (`nightTypeToFocus` instead).
    var macAutoFocus = true
    /// With nothing else taking the keyboard, a printable key typed in the
    /// window focuses the field and goes into it. Off while a check waits
    /// for Lock it in (its A–D must reach the check).
    var macTypeToFocus = false
    #endif

    @FocusState private var focused: Bool
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    /// The placeholder for this text size.
    static func placeholder(_ placeholder: String, compact: String?, at size: DynamicTypeSize) -> String {
        if size.isAccessibilitySize, let compact { return compact }
        return placeholder
    }
    @State private var pickerItem: PhotosPickerItem?
    /// A picked photo failed to load (e.g. an iCloud-optimized original while
    /// offline, or a corrupt asset). Without this the picker dismisses and
    /// nothing appears — which reads as "the attach button is broken."
    @State private var attachLoadFailed = false
    /// The last edit (a paste) went over `characterLimit` and was cut.
    @State private var wasCut = false
    #if os(macOS)
    /// The open panel for an image file (the Mac's attach button).
    @State private var showsFilePanel = false
    /// The ⌘V watcher that turns a pasted image into an attachment, and what
    /// it reads when a key arrives.
    @State private var pasteMonitor: Any?
    @State private var pasteContext = ComposerPasteContext()
    @Environment(\.isEnabled) private var isEnabled
    @NightSettings private var night
    @State private var attachHovered = false
    #endif

    var body: some View {
        VStack(alignment: .leading, spacing: BrandSpacing.sm) {
            if isPreparingAttachment {
                preparingPreview
            } else if let attachment {
                attachmentPreview(attachment)
            }

            if attachLoadFailed {
                attachmentFailure("Couldn't load that photo. Try again.") { attachLoadFailed = false }
            } else if let attachmentError {
                attachmentFailure(attachmentError, clear: onRemoveAttachment)
            }

            if let photoLimitNotice {
                Text(photoLimitNotice)
                    .font(BrandFont.caption)
                    .foregroundStyle(BrandColor.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 44)  // align past the photo button
                    .accessibilityIdentifier("composer.photoLimit")
            }

            if let note = ComposerLimit.note(count: text.utf16.count, limit: characterLimit, wasCut: wasCut) {
                Text(note)
                    .font(BrandFont.caption)
                    .foregroundStyle(wasCut ? BrandColor.errorText : BrandColor.textSecondary)
                    .monospacedDigit()
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .accessibilityIdentifier("composer.limit")
            }

            #if os(macOS)
            nightFieldRow
            #else
            HStack(alignment: .bottom, spacing: BrandSpacing.sm) {
                photoButton

                // The placeholder in the secondary text token, not the
                // system's faint one (1.7:1 in light mode): in a lesson it
                // is the instruction (AUD-44). 4.7:1 light, 6.3:1 dark on
                // the field.
                let prompt = Self.placeholder(placeholder, compact: compactPlaceholder, at: dynamicTypeSize)
                TextField(text: $text,
                          prompt: Text(prompt).foregroundStyle(BrandColor.textSecondary),
                          axis: .vertical) {
                    Text(prompt)
                }
                    #if os(macOS)
                    // The capsule below is the field's look; the Mac's own
                    // bezel drew a dark bar inside it.
                    .textFieldStyle(.plain)
                    #endif
                    .lineLimit(1...max(1, maxLines))
                    .font(BrandFont.body)
                    .foregroundStyle(BrandColor.text)
                    .tint(BrandColor.accent)
                    .padding(.vertical, 10)
                    .padding(.horizontal, BrandSpacing.md)
                    .background(BrandColor.surfaceElevated)
                    .clipShape(RoundedRectangle(cornerRadius: BrandRadius.xl))
                    .overlay(
                        RoundedRectangle(cornerRadius: BrandRadius.xl)
                            .stroke(focused ? BrandColor.accent : BrandColor.border, lineWidth: 1)
                    )
                    .focused($focused)
                    .submitLabel(.send)
                    // Return sends (on the Mac too).
                    .onSubmit(triggerSend)
                    #if os(macOS)
                    // Shift-Return: a new line where the cursor is.
                    .onKeyPress(.return, phases: .down) { press in
                        MacComposerKeys.handleReturn(modifiers: press.modifiers) ? .handled : .ignored
                    }
                    #endif
                    .accessibilityLabel("Message")
                    .onChange(of: focusTrigger) { _, _ in focused = true }
                    .onChange(of: focused) { _, isFocused in onFocusChange?(isFocused) }

                actionButton
            }
            #endif
        }
        #if os(macOS)
        // Night Studio: the composer floats on the canvas (no band of its
        // own behind it).
        .padding(.horizontal, 20)
        .padding(.top, 4)
        .padding(.bottom, 14)
        #else
        .padding(.horizontal, BrandSpacing.lg)
        .padding(.vertical, BrandSpacing.sm)
        .background { composerBackground }
        #endif
        .onChange(of: pickerItem) { _, newItem in
            loadPickedImage(newItem)
        }
        #if os(macOS)
        .fileImporter(isPresented: $showsFilePanel, allowedContentTypes: [.image]) { result in
            loadPickedFile(result)
        }
        .onChange(of: attachTrigger) { _, _ in
            if !isSending { showsFilePanel = true }
        }
        // The Mac opens a chat or lesson ready to type into, and focuses
        // the composer again whenever it comes back from being disabled
        // (a lesson's intro).
        .onAppear {
            DispatchQueue.main.async { if isEnabled && macAutoFocus { focused = true } }
            installPasteMonitor()
        }
        .onChange(of: isEnabled) { _, enabled in
            if enabled && macAutoFocus { DispatchQueue.main.async { focused = true } }
        }
        .onChange(of: focused, initial: true) { _, isFocused in pasteContext.isFocused = isFocused }
        .onChange(of: macTypeToFocus && isEnabled && !isSending, initial: true) { _, on in pasteContext.typeToFocus = on }
        .onChange(of: isSending, initial: true) { _, sending in pasteContext.isSending = sending }
        .background(WindowReader { [pasteContext] in pasteContext.window = $0 })
        .onDisappear(perform: removePasteMonitor)
        #endif
        .onChange(of: text) { _, newText in
            let kept = ChatViewModel.clamped(newText, toUTF16: characterLimit)
            if kept.utf16.count < newText.utf16.count {
                wasCut = true
                text = kept
            } else if newText.utf16.count < characterLimit {
                wasCut = false
            }
        }
    }

    /// Transient: clears itself after a few seconds (a new pick clears it
    /// at once).
    private func attachmentFailure(_ message: String, clear: @escaping () -> Void) -> some View {
        Text(message)
            .font(BrandFont.caption)
            .foregroundStyle(BrandColor.errorText)
            .padding(.leading, 44)  // align past the photo button
            .task(id: message) {
                try? await Task.sleep(for: .seconds(3))
                guard !Task.isCancelled else { return }
                clear()
            }
    }

    @ViewBuilder private var composerBackground: some View {
        if backgroundFade {
            // Solid at the bottom, fading to transparent at the top so an
            // anchored Merc behind the bar dissolves up into it.
            LinearGradient(
                colors: [BrandColor.background, BrandColor.background, BrandColor.background.opacity(0)],
                startPoint: .bottom, endPoint: .top
            )
        } else {
            BrandColor.background
        }
    }

    #if os(macOS)
    /// The Mac's attach button: an image file from the open panel. A picture
    /// can also be dragged onto the chat or pasted into the field.
    private var photoButton: some View {
        Button { showsFilePanel = true } label: {
            Image(systemName: "photo.badge.plus")
                .font(.system(size: 20, weight: .regular))
                .foregroundStyle(isSending ? BrandColor.textSecondary.opacity(0.5) : BrandColor.accent)
                .frame(width: 36, height: 36)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .frame(minWidth: 44, minHeight: 44)
        .disabled(isSending)
        .help("Attach an image (⇧⌘A). You can also drag one here or paste it.")
        .accessibilityLabel("Attach image")
    }

    /// Night Studio's composer (SPEC.md §5.4): one floating-chrome field
    /// with the attach button inside it at the leading end and the send
    /// circle at the trailing end; a `fieldStroke` edge (≥ 3:1) that turns
    /// into Night's focus ring (`focusRing`, 2 pt, 3 under Increase
    /// Contrast) while the field has focus (the field's own is off). Every key, drop and paste behaviour is the
    /// field's, as before.
    private var nightFieldRow: some View {
        let shape = RoundedRectangle(cornerRadius: 20, style: .continuous)
        let prompt = Self.placeholder(placeholder, compact: compactPlaceholder, at: dynamicTypeSize)
        return HStack(alignment: .bottom, spacing: 8) {
            nightAttachButton
            // The placeholder is drawn here, in `ink3` (5.3:1 on the chrome
            // at worst): the Mac draws a field's own prompt in its faint
            // system placeholder colour (3.9:1 measured) whatever style it is
            // given, and in a lesson the placeholder is the instruction
            // (AUD-44). VoiceOver hears it as the field's hint.
            TextField("", text: $text, axis: .vertical)
            .textFieldStyle(.plain)
            .lineLimit(1...max(1, maxLines))
            .font(NightType.body)
            .foregroundStyle(Night.ink)
            .tint(Night.accentText)
            .overlay(alignment: .topLeading) {
                if text.isEmpty {
                    Text(prompt)
                        .font(NightType.body)
                        .foregroundStyle(Night.ink3)
                        .lineLimit(1)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
            .padding(.vertical, 5)
            .frame(minHeight: 30)
            .focused($focused)
            .focusEffectDisabled()
            .submitLabel(.send)
            // Return sends.
            .onSubmit(triggerSend)
            // Shift-Return: a new line where the cursor is.
            .onKeyPress(.return, phases: .down) { press in
                MacComposerKeys.handleReturn(modifiers: press.modifiers) ? .handled : .ignored
            }
            .accessibilityLabel("Message")
            .accessibilityHint(prompt)
            .onChange(of: focusTrigger) { _, _ in focused = true }
            .onChange(of: focused) { _, isFocused in onFocusChange?(isFocused) }
            nightActionButton
        }
        .padding(.leading, 5)
        .padding(.trailing, 5)
        .padding(.vertical, 5)
        .frame(minHeight: 40)
        .nightChrome(in: shape)
        // The field's edge: `fieldStroke`, or the focus ring's colour and
        // width while it has focus (one ring, not two).
        .overlay {
            shape.strokeBorder(focused ? Night.focusRing : Night.fieldStroke,
                               lineWidth: focused ? night.focusRingWidth : 1)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
        .contentShape(shape)
        .onTapGesture { focused = true }
    }

    /// The attach button inside the field: a 30 pt circle, `ink2`, lumen
    /// under the pointer.
    private var nightAttachButton: some View {
        Button { showsFilePanel = true } label: {
            Image(systemName: "photo.badge.plus")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(isSending ? Night.ink3 : Night.ink2)
                .frame(width: 30, height: 30)
                .background(Circle().fill(Night.lumen.opacity(attachHovered && !isSending ? 0.12 : 0)))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .onHover { attachHovered = $0 }
        .disabled(isSending)
        .nightFocusRing(Circle())
        .help("Attach an image (⇧⌘A). You can also drag one here or paste it.")
        .accessibilityLabel("Attach image")
    }

    /// Send: a 30 pt `prominent` circle with a white arrow (`hairline` with
    /// an `ink3` arrow while there's nothing to send). Stop: the same circle
    /// with a square.
    private var nightActionButton: some View {
        Group {
            if isSending {
                Button(action: onCancel) {
                    nightCircle(systemName: "stop.fill", active: true)
                }
                .accessibilityLabel("Stop replying")
                .help("Stop the reply")
            } else {
                Button(action: triggerSend) {
                    nightCircle(systemName: "arrow.up", active: canSend)
                }
                .disabled(!canSend)
                .accessibilityLabel("Send")
                .help("Send (Return)")
            }
        }
        .buttonStyle(.plain)
        .nightFocusRing(Circle())
    }

    private func nightCircle(systemName: String, active: Bool) -> some View {
        Image(systemName: systemName)
            .font(.system(size: 13, weight: .bold))
            .foregroundStyle(active ? Color.white : Night.ink3)
            .frame(width: 30, height: 30)
            .background(Circle().fill(active ? Night.prominent : Night.hairline))
            .contentShape(Circle())
    }

    /// This bar with another placeholder (a lesson with a check on screen:
    /// "Or answer in your own words…").
    func nightPlaceholder(_ text: String) -> ChatInputBar {
        var bar = self
        bar.placeholder = text
        return bar
    }

    /// This bar with the host's attach trigger (File ▸ Attach Image…).
    func withAttachTrigger(_ trigger: Int) -> ChatInputBar {
        var bar = self
        bar.attachTrigger = trigger
        return bar
    }

    /// This bar with the host's focus trigger (Chat ▸ Write a Reply, ⌘L).
    func withFocusTrigger(_ trigger: Int) -> ChatInputBar {
        var bar = self
        bar.focusTrigger = trigger
        return bar
    }

    /// This bar for a lesson: no focus on its own; a printable key typed
    /// with nothing else taking the keyboard focuses it, unless `enabled` is
    /// off (a check waits for Lock it in).
    func nightTypeToFocus(_ enabled: Bool) -> ChatInputBar {
        var bar = self
        bar.macAutoFocus = false
        bar.macTypeToFocus = enabled
        return bar
    }

    private func loadPickedFile(_ result: Result<URL, Error>) {
        guard case .success(let url) = result else { return }
        attachLoadFailed = false
        Task {
            let data = await Task.detached(priority: .userInitiated) {
                MacImageIntake.readPickedFile(url)
            }.value
            if let data { onAttachImage(data) } else { attachLoadFailed = true }
        }
    }

    /// ⌘V with an image (and no text) on the pasteboard attaches it, while
    /// the field has focus. Text pastes as always.
    private func installPasteMonitor() {
        guard pasteMonitor == nil else { return }
        let context = pasteContext
        pasteMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            // Type to focus (a lesson): the key goes into the field it focuses.
            if context.typeToFocus,
               MacComposerKeys.isTypeToFocus(event, composerFocused: context.isFocused, composerWindow: context.window),
               let characters = event.characters, let window = event.window {
                focused = true
                MacComposerKeys.insertWhenFocused(characters, in: window)
                return nil
            }
            guard MacComposerKeys.isComposerPaste(event, composerFocused: context.isFocused,
                                                  composerWindow: context.window),
                  !context.isSending,
                  let data = MacImageIntake.imageData(from: .general) else { return event }
            attachLoadFailed = false
            onAttachImage(data)
            return nil
        }
    }

    private func removePasteMonitor() {
        if let pasteMonitor { NSEvent.removeMonitor(pasteMonitor) }
        pasteMonitor = nil
    }
    #else
    private var photoButton: some View {
        PhotosPicker(selection: $pickerItem, matching: .images) {
            Image(systemName: "photo")
                .font(.system(size: 22, weight: .regular))
                .foregroundStyle(isSending ? BrandColor.textSecondary.opacity(0.5) : BrandColor.accent)
                .frame(width: 36, height: 36)
        }
        .frame(minWidth: 44, minHeight: 44)
        .disabled(isSending)
        .accessibilityLabel("Attach photo")
    }
    #endif

    private var preparingPreview: some View {
        RoundedRectangle(cornerRadius: BrandRadius.md)
            .fill(BrandColor.surfaceElevated)
            .frame(width: 64, height: 64)
            .overlay(ProgressView())
            .overlay(
                RoundedRectangle(cornerRadius: BrandRadius.md)
                    .stroke(BrandColor.border, lineWidth: 1)
            )
            .padding(.leading, 44)  // align past the photo button
            .accessibilityElement()
            .accessibilityLabel("Attaching photo")
    }

    private func attachmentPreview(_ attachment: ChatImage) -> some View {
        ZStack(alignment: .topTrailing) {
            Group {
                if let preview = attachment.preview {
                    Image(preview, scale: 1, label: Text("Attached photo"))
                        .resizable()
                        .scaledToFill()
                } else {
                    Image(systemName: "photo")
                        .font(.system(size: 24))
                        .foregroundStyle(BrandColor.textSecondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(BrandColor.surfaceElevated)
                        .accessibilityLabel("Attached photo")
                }
            }
            .frame(width: 64, height: 64)
            .clipShape(RoundedRectangle(cornerRadius: BrandRadius.md))
            .overlay(
                RoundedRectangle(cornerRadius: BrandRadius.md)
                    .stroke(BrandColor.border, lineWidth: 1)
            )

            Button(action: onRemoveAttachment) {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 20))
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(.white, .black.opacity(0.5))
                    // The glyph stays small in the thumbnail's corner; the
                    // target around it is 44 pt (AUD-46).
                    .padding(4)
                    .frame(width: 44, height: 44, alignment: .topTrailing)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove photo")
            #if os(macOS)
            .help("Remove the photo")
            #endif
        }
        .padding(.leading, 44)  // align past the photo button
        .accessibilityElement(children: .contain)
    }

    private var actionButton: some View {
        Group {
            if isSending {
                Button(action: onCancel) {
                    Image(systemName: "stop.circle.fill")
                        .resizable()
                        .frame(width: 36, height: 36)
                        .foregroundStyle(BrandColor.textSecondary)
                }
                .accessibilityLabel("Stop replying")
                #if os(macOS)
                .help("Stop the reply")
                #endif
            } else if useBrandSend {
                Button(action: triggerSend) {
                    Circle()
                        .fill(BrandGradient.merc)
                        .frame(width: 42, height: 42)
                        .overlay(
                            Image(systemName: "arrow.up")
                                .font(.system(size: 16, weight: .heavy))
                                .foregroundStyle(.white)
                        )
                        // No glow on the iPhone (dark only; Night casts no
                        // shadows in dark). The Mac keeps its own.
                        #if os(macOS)
                        .shadow(color: BrandColor.accent.opacity(0.5), radius: 9, y: 6)
                        #endif
                        .opacity(canSend ? 1 : 0.45)
                }
                .disabled(!canSend)
                .accessibilityLabel("Send")
                #if os(macOS)
                .help("Send (Return)")
                #endif
            } else {
                Button(action: triggerSend) {
                    Image(systemName: "arrow.up.circle.fill")
                        .resizable()
                        .frame(width: 36, height: 36)
                        .foregroundStyle(canSend ? BrandColor.accent : BrandColor.textSecondary.opacity(0.5))
                }
                .disabled(!canSend)
                .accessibilityLabel("Send")
                #if os(macOS)
                .help("Send (Return)")
                #endif
            }
        }
        .frame(minWidth: 44, minHeight: 44)
    }

    private var canSend: Bool {
        Self.canSend(text: text, hasAttachment: attachment != nil,
                     isSending: isSending, isPreparingAttachment: isPreparingAttachment)
    }

    /// Whether the send button (and, on the Mac, Return) sends: some text
    /// that isn't only spaces and line breaks, or a photo; nothing already
    /// on its way; no photo still being prepared.
    nonisolated static func canSend(text: String, hasAttachment: Bool, isSending: Bool, isPreparingAttachment: Bool) -> Bool {
        let hasText = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return (hasText || hasAttachment) && !isSending && !isPreparingAttachment
    }

    private func triggerSend() {
        guard canSend else { return }
        onSend()
    }

    private func loadPickedImage(_ item: PhotosPickerItem?) {
        guard let item else { return }
        attachLoadFailed = false  // a fresh pick supersedes any prior failure note
        Task {
            let data = try? await item.loadTransferable(type: Data.self)
            await MainActor.run {
                // Reset so the same photo can be picked again after removal.
                pickerItem = nil
                if let data {
                    onAttachImage(data)
                } else {
                    // `loadTransferable` throws / returns nil for iCloud-
                    // optimized originals while offline and for corrupt
                    // assets — surface it instead of silently doing nothing.
                    attachLoadFailed = true
                }
            }
        }
    }
}

/// The composer's length note (pure; covered by ComposerLimitTests).
enum ComposerLimit {
    /// How close to the limit the counter appears.
    static let counterLead = 200

    /// Nil while the draft is comfortably short.
    static func note(count: Int, limit: Int, wasCut: Bool) -> String? {
        if wasCut {
            return "Only the first \(limit.formatted()) characters will be sent."
        }
        guard count >= limit - counterLead else { return nil }
        return "\(count.formatted()) / \(limit.formatted())"
    }
}
