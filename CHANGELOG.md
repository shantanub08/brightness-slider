# Changelog

### Unreleased

- Fix trailing window ghosts while dragging: software dimming now
  uses translucent black overlays instead of per-actor shader
  effects, whose offscreen buffers broke Mutter's damage tracking.
  The desktop wallpaper also stays visible during screen recording.
- Keep the DDC/CI slider thumb in sync when monitor brightness is
  changed outside the extension (monitor OSD buttons or another
  `ddcutil` call): read on Quick Settings open, every 5 seconds while
  it stays open, and once after a brightness shortcut. Brightness
  (VCP 10) drives the thumb; an external hardware increase cancels
  software dimming, and software dimming keeps its position while
  hardware is at 0%.
- Add a keyboard shortcut recorder to preferences, so bare media keys
  (for example the hardware brightness keys) can be bound without
  `gsettings`, while other keys require a modifier.
- Add separate configurable shortcut steps for software dimming and
  hardware brightness (1–20%, default 5% each), so each slider zone can
  be tuned to feel right.

### Version 1
#### November 8, 2026

- Initial Brightness Slider release, forked from Soft Brightness
  Plus v52.
- Add GNOME Shell 51 support:
  - Replace the removed `ui/pointerWatcher.js` with cursor-tracker
    `position-invalidated` tracking on GNOME Shell 51+, matching
    `ui/magnifier.js`. Older versions keep the Shell's
    `PointerWatcher`.
  - Port the gamma-curve effect from the removed `Shell.GLSLEffect`
    to `Clutter.ShaderEffect` with a `Cogl.Snippet` static snippet on
    GNOME Shell 51+. GNOME Shell 45-50 keep the `GLSLEffect` path.
  - Replace the removed `Clutter.get_default_backend()` with the
    stage context backend on GNOME Shell 51+.
- Include the upstream shader-target fixes: dim every actor exactly
  once, keep the desktop background in the dimmed image, avoid
  double-dimming overview clones, and keep fullscreen windows
  composited while dimming.
- New extension identity: `brightness-slider@shantanub08.github.io`.
  The new UUID and GSettings schema mean settings start at their
  defaults and the fork can be installed alongside Soft Brightness
  Plus.
- Support GNOME Shell 45 through 51.

Release notes for the upstream Soft Brightness Plus project are at
<https://github.com/jkitching/soft-brightness-plus>.
