# App icon

The iPhone, iPad and Mac app icon is direction **C, "Face"**: Merc's winged head on
navy, with sparkles. It's the "App icon" on the Primary logo board of the Claude
Design canvas "Mercurius Logo" (also Icons.dc.html, direction C), and the same art
as the website's `marketing/assets/brand/mercurius-app-icon.svg`.

- `mercurius-app-icon-ios.svg` is the iOS master: the website SVG without its
  230 px corner clip, because iOS applies its own mask and needs a full-bleed,
  opaque 1024 × 1024 image.
- `ios/Mercurius/Resources/Assets.xcassets/AppIcon.appiconset/icon-1024.png` is that
  SVG rendered at 1024 px (headless Chrome), saved as RGB with no alpha.
- The Mac set comes from that PNG, on Apple's macOS grid (824 px plate, 185 px
  radius, soft shadow). From `ios/`:

  ```bash
  python3 scripts/make-mac-icon.py Mercurius/Resources/Assets.xcassets/AppIcon.appiconset/icon-1024.png MercuriusMac/Resources/MacAssets.xcassets/MacAppIcon.appiconset
  ```

The icon ships with the app binary, so a new icon needs a new build.
