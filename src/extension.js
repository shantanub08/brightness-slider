// brightness-slider - Control the display's brightness via an alpha channel.
// Copyright (C) 2019-2022 Philippe Troin (F-i-f on Github)
// Copyright (C) 2022-2024 Joel Kitching (jkitching on Github)
// Copyright (C) 2026 Shantanu Baviskar (shantanub08 on Github)
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {QuickSlider} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import System from 'system';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Logger from './logger.js';
import * as Utils from './utils.js';
import { MouseSpriteContent } from './cursor.js';
import { DdcController } from './ddcutil.js';
import {
    DualZoneSlider,
    sliderToHardwareAndSoftware,
    hardwareAndSoftwareToSlider,
    externalHardwareToSlider,
    stepSliderValue,
} from './slider.js';

// In GS 51, ui/pointerWatcher.js was removed; see CursorTrackerPointerWatcher.
const PointerWatcher = parseInt(Config.PACKAGE_VERSION) < 51
    ? await import('resource:///org/gnome/shell/ui/pointerWatcher.js')
    : null;

// Backlight-like GLSL dimming effect: out = b * c, where b = brightness.
// Contrast ratios are preserved, like a hardware backlight; blacks stay
// black and everything scales down linearly.
//
// The effect is attached to many actors of different sizes (uiGroup's
// children, each window, the background), so monitor targeting cannot use
// actor-relative coordinates.  Instead it is decided at paint time from the
// stage area being painted: each monitor is painted separately (its stage
// view, or e.g. a screencast of it), and is either dimmed or left alone as
// a whole.
//
// monitorRects: [{x,y,width,height}] in stage coordinates.
//   Empty (length 0) → dim everywhere.
//   Non-empty → only dim areas whose centre lies inside one of the rects.
// area: the painted stage area, or null if unknown (then dimmed).
export function brightnessForArea(brightness, monitorRects, area) {
    if (monitorRects.length === 0 || !area)
        return brightness;
    const cx = area.x + area.width / 2;
    const cy = area.y + area.height / 2;
    const dimmed = monitorRects.some(r =>
        cx >= r.x && cx < r.x + r.width && cy >= r.y && cy < r.y + r.height);
    return dimmed ? brightness : 1.0;
}

// Stage area covered by the framebuffer `paintContext` paints into.  Clutter
// gives stage views and clutter_stage_paint_to_framebuffer() targets alike a
// viewport spanning the whole stage, offset by the painted area's position,
// so the area follows from the viewport and the framebuffer size.
// (ClutterPaintContext.get_stage_view() is not introspectable.)
export function paintedStageArea(paintContext) {
    const framebuffer = paintContext.get_framebuffer();
    const scale = framebuffer.get_viewport_width() / global.stage.width;
    if (!(scale > 0))
        return null;
    return {
        x: -framebuffer.get_viewport_x() / scale,
        y: -framebuffer.get_viewport_y() / scale,
        width: framebuffer.get_width() / scale,
        height: framebuffer.get_height() / scale,
    };
}

// Brightness for the shader when `actor` is painted into `paintContext`.
//
// An actor painted through a Clutter.Clone (overview window previews,
// Alt+Tab and workspace thumbnails, the magnifier...) is drawn in the
// clone's place, which is inside a shader target like every visible actor
// (see OverlayManager._isContainer()) and is dimmed there: dimming the
// clone paint here as well would square the brightness.
function paintBrightness(actor, brightness, monitorRects, paintContext) {
    if (actor.is_in_clone_paint())
        return 1.0;
    if (monitorRects.length === 0)
        return brightness;
    return brightnessForArea(brightness, monitorRects, paintedStageArea(paintContext));
}

// Some shader targets paint nothing for long stretches (empty containers
// such as modalDialogGroup, or the keyboard box, 0 px high while hidden).
// An offscreen effect would then allocate a zero-sized framebuffer
// ("cogl_framebuffer_set_viewport: assertion 'width > 0 && height > 0'");
// paint such actors without the effect instead.  The size is taken from
// the same box ClutterOffscreenEffect sizes its framebuffer from: the local
// paint volume, or the allocation when the paint volume is unknown.
export function hasPaintArea(actor) {
    const volume = actor.get_paint_volume();
    const [width, height] = volume
        ? [volume.get_width(), volume.get_height()]
        : actor.get_allocation_box().get_size();
    return width > 0 && height > 0;
}

const GAMMA_CURVE_DECLARATIONS = `
    uniform float u_brightness;
`;

const GAMMA_CURVE_SOURCE = `
    cogl_color_out.rgb = clamp(u_brightness, 0.0, 1.0) *
        clamp(cogl_color_out.rgb, 0.0, 1.0);
`;

// The effect classes are only defined on the GNOME Shell versions that
// have their base class (registering the other one would fail).
function defineGLSLEffectGammaCurve() {
    return GObject.registerClass(
        class GammaCurveEffect extends Shell.GLSLEffect {
            _init(brightness, monitorRects) {
                super._init();
                this._brightnessLoc = this.get_uniform_location('u_brightness');
                this._brightness = brightness;
                this._monitorRects = monitorRects || [];
            }

            vfunc_build_pipeline() {
                this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT,
                    GAMMA_CURVE_DECLARATIONS, GAMMA_CURVE_SOURCE, false);
            }

            vfunc_pre_paint(node, paintContext) {
                if (!hasPaintArea(this.get_actor()))
                    return false;
                return super.vfunc_pre_paint(node, paintContext);
            }

            vfunc_paint_target(node, paintContext) {
                this.set_uniform_float(this._brightnessLoc, 1,
                    [paintBrightness(this.get_actor(), this._brightness,
                        this._monitorRects, paintContext)]);
                super.vfunc_paint_target(node, paintContext);
            }

            update(brightness, monitorRects) {
                this._brightness = brightness;
                this._monitorRects = monitorRects;
                this.queue_repaint();
            }
        }
    );
}

// In GS 51, Shell.GLSLEffect was removed.  Its replacement,
// Clutter.ShaderEffect, takes the GLSL as a Cogl snippet and sets uniforms
// by name.  Exported for tests.
export function defineShaderEffectGammaCurve() {
    return GObject.registerClass(
        class GammaCurveEffect extends Clutter.ShaderEffect {
            _init(brightness, monitorRects) {
                super._init();
                this._brightness = brightness;
                this._monitorRects = monitorRects || [];
            }

            vfunc_get_static_snippet() {
                return Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT,
                    GAMMA_CURVE_DECLARATIONS, GAMMA_CURVE_SOURCE);
            }

            vfunc_pre_paint(node, paintContext) {
                if (!hasPaintArea(this.get_actor()))
                    return false;
                return super.vfunc_pre_paint(node, paintContext);
            }

            vfunc_paint_target(node, paintContext) {
                this.set_uniform_float('u_brightness', 1,
                    [paintBrightness(this.get_actor(), this._brightness,
                        this._monitorRects, paintContext)]);
                super.vfunc_paint_target(node, paintContext);
            }

            update(brightness, monitorRects) {
                this._brightness = brightness;
                this._monitorRects = monitorRects;
                this.queue_repaint();
            }
        }
    );
}

export const GammaCurveEffect = Shell.GLSLEffect !== undefined
    ? defineGLSLEffectGammaCurve()
    : defineShaderEffectGammaCurve();

// Stand-in for ui/pointerWatcher.js on GS 51+: follows the pointer through
// the cursor tracker's position-invalidated signal, like ui/magnifier.js.
// Only the subset of the PointerWatcher API used by CursorManager is provided.
export class CursorTrackerPointerWatcher {
    constructor(cursorTracker) {
        this._cursorTracker = cursorTracker;
    }

    addWatch(_interval, fn) {
        const laters = global.compositor.get_laters();
        let laterId = 0;
        const positionId = this._cursorTracker.connect('position-invalidated', () => {
            if (laterId)
                return;
            laterId = laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
                laterId = 0;
                fn();
                return GLib.SOURCE_REMOVE;
            });
        });
        return {
            remove: () => {
                this._cursorTracker.disconnect(positionId);
                if (laterId) {
                    laters.remove(laterId);
                    laterId = 0;
                }
            },
        };
    }
}

function getPointerWatcher(cursorTracker) {
    return PointerWatcher !== null
        ? PointerWatcher.getPointerWatcher()
        : new CursorTrackerPointerWatcher(cursorTracker);
}

// In GS 51, Clutter.get_default_backend was removed.
export function getDefaultSeat() {
    const backend = Clutter.get_default_backend !== undefined
        ? Clutter.get_default_backend()
        : global.stage.context.get_backend();
    return backend.get_default_seat();
}

export default class BrightnessSliderExtension extends Extension {
    constructor(...args) {
        super(...args);

        // Set/destroyed by enable/disable
        this._settings = null;
        this._logger = null;
        this._monitorManager = null;
        this._overlayManager = null;
        this._cursorManager = null;
        this._indicatorManager = null;
        this._screenshotManager = null;
        this._removeSettingsCallbacks = [];
    }

    // Base functionality: set-up and tear down logger, settings and debug setting monitoring
    enable() {
        this._settings = this.getSettings();
        this._logger = new Logger.Logger('brightness-slider', this.metadata, Config.PACKAGE_VERSION);
        this._logger.set_debug(this._settings.get_boolean('debug'));
        this._logger.log_debug('enable(), session mode = ' + Main.sessionMode.currentMode);
        this._logger.logVersion();

        this._monitorManager = new MonitorManager(this._logger, this._settings, this.path);
        this._overlayManager = new OverlayManager(this._logger, this._settings, this._monitorManager);
        this._cursorManager = new CursorManager(this._logger, this._settings, this._overlayManager);
        this._indicatorManager = new IndicatorManager(this._logger, this._settings, this._overlayManager, this._monitorManager);
        this._screenshotManager = new ScreenshotManager(this._logger);

        this._monitorManager.setChangeHook(() => {
            this._overlayManager.resetSize();
            this._on_brightness_change();
        });

        this._cursorManager.setChangeHook(() => {
            this._on_brightness_change();
        });

        this._screenshotManager.setPreCaptureHook(() => {
            this._cursorManager.setActive(false, true);
            this._overlayManager.hideForScreenshot();
        });

        this._screenshotManager.setPostCaptureHook(() => {
            this._cursorManager.setActive(true);
            this._on_brightness_change();
        });

        this._monitorManager.enable();
        this._overlayManager.enable();
        this._cursorManager.enable();
        this._indicatorManager.enable();
        this._screenshotManager.enable();

        this._enableSettingsMonitoring();
        this._enableKeyboardShortcuts();

        this._logger.log_debug('Extension enabled');
    }

    disable() {
        // In order to maintain the same brightness settings when the device is
        // locked and unlocked, "session-modes" includes "unlock-dialog" in
        // metadata.json.  The extension will remain active while the lock screen
        // is shown.
        this._logger.log_debug('disable(), session mode = ' + Main.sessionMode.currentMode);

        this._disableKeyboardShortcuts();

        this._monitorManager.disable();
        this._cursorManager.disable();
        this._overlayManager.disable();
        this._indicatorManager.disable();
        this._screenshotManager.disable();

        this._disableSettingsMonitoring();

        this._logger.log_debug('Extension disabled');

        this._settings = null;
        this._logger = null;
        this._monitorManager = null;
        this._overlayManager = null;
        this._cursorManager = null;
        this._indicatorManager = null;
        this._screenshotManager = null;
    }

    _on_debug_change() {
        this._logger.set_debug(this._settings.get_boolean('debug'));
        this._logger.log('debug = ' + this._logger.get_debug());
    }

    _enableKeyboardShortcuts() {
        Main.wm.addKeybinding('brightness-up', this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._adjustBrightness(+1));
        Main.wm.addKeybinding('brightness-down', this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._adjustBrightness(-1));
    }

    _disableKeyboardShortcuts() {
        Main.wm.removeKeybinding('brightness-up');
        Main.wm.removeKeybinding('brightness-down');
    }

    _adjustBrightness(direction) {
        // Without a Quick Settings slider the stored level is the hardware
        // backlight, or the software dimming factor when backlight is off.
        const stepKey = this._settings.get_boolean('use-backlight')
            ? 'shortcut-step-hardware'
            : 'shortcut-step-software';
        const step = Math.round(Math.max(0.01, Math.min(0.20,
            this._settings.get_double(stepKey))) * 100) / 100;
        const targetSlider = this._indicatorManager?.getSliderForCurrentCursor();
        if (targetSlider) {
            targetSlider.stepDelta(direction);
            // Refresh the thumb once the DDC write queue has drained, so an
            // external change that happened while the menu was closed does
            // not leave the slider stale.
            this._indicatorManager.refreshAfterUserAction();
            return;
        }

        const minBrightness = this._settings.get_double('min-brightness');
        const current = this._getBrightnessLevel();
        // Keep the configured step even when the starting level is not on
        // that grid (e.g. a native backlight value); only strip float dust.
        const stepped = Math.round((current + direction * step) * 1e6) / 1e6;
        const clamped = Math.max(minBrightness, Math.min(1.0, stepped));
        this._logger.log_debug(`_adjustBrightness(${direction}): ${current} -> ${clamped}`);
        this._storeBrightnessLevel(clamped);
    }

    // Settings monitoring
    _enableSettingsMonitoring() {
        this._logger.log_debug('_enableSettingsMonitoring()');

        const callbacks = {
            'changed::min-brightness': () => this._on_brightness_change(),
            'changed::current-brightness': () => this._on_brightness_change(),
            'changed::monitors': () => this._on_brightness_change(),
            'changed::builtin-monitor': () => this._on_brightness_change(),
            'changed::use-backlight': () => this._on_brightness_change(),
            'changed::debug': () => this._on_debug_change(),
        }
        this._removeSettingsCallbacks = Object.entries(callbacks).map(
            ([name, fn]) => {
                const conn = this._settings.connect(name, fn);
                return () => this._settings.disconnect(conn);
            }
        );
    }

    _disableSettingsMonitoring() {
        this._logger.log_debug('_disableSettingsMonitoring()');
        this._removeSettingsCallbacks.forEach((fn) => fn());
        this._removeSettingsCallbacks = [];
    }

    _on_brightness_change() {
        let curBrightness = this._getBrightnessLevel();
        const minBrightness = this._settings.get_double('min-brightness');

        this._logger.log_debug('_on_brightness_change: current-brightness=' + curBrightness + ', min-brightness=' + minBrightness);
        if (curBrightness < minBrightness) {
            curBrightness = minBrightness;
            this._storeBrightnessLevel(minBrightness);
            return;
        }
        if (curBrightness >= 1) {
            this._overlayManager.hide();
            this._cursorManager.setActive(false);
        } else {
            this._overlayManager.show(curBrightness);
            this._cursorManager.setActive(this._overlayManager.initialized());
            // The clone is not a shader target; it dims its own sprite.
            this._cursorManager.refreshDim();
        }
    }

    _getProxy() {
        // Prefer Main.brightnessManager.globalScale if available (GNOME 49+)
        const globalScale = Main.brightnessManager?.globalScale;
        if (globalScale) {
            // Return a proxy-compatible wrapper around globalScale
            // Old proxy API: Brightness property with 0-100 scale
            // New API: value property with 0.0-1.0 scale
            return {
                get Brightness() {
                    return globalScale.value * 100;
                },
                set Brightness(percent) {
                    globalScale.value = percent / 100.0;
                }
            };
        }

        // Fallback to legacy D-Bus proxy
        return this._indicatorManager.getProxy();
    }

    // Utility functions to manage the stored brightness value.
    // If using the backlight, then we use the indicator as the brightness value store, which is linked to gsd.
    // If not using the backlight, the brightness is stored in the extension setting.
    _storeBrightnessLevel(value) {
        const proxy = this._getProxy();
        if (this._settings.get_boolean('use-backlight') && !proxy) {
            this._logger.log_debug('_storeBrightnessLevel still waiting for proxy...');
            return;
        }

        if (this._settings.get_boolean('use-backlight') && proxy.Brightness >= 0) {
            const convertedBrightness = Math.min(100, Math.round(value * 100.0));
            this._logger.log_debug('_storeBrightnessLevel(' + value + ') by proxy -> ' + convertedBrightness);
            proxy.Brightness = convertedBrightness;
        }

        // Always store current-brightness value so that when use-backlight is
        // disabled, there is no jarring shift in the overlay brightness.
        this._logger.log_debug('_storeBrightnessLevel(' + value + ') by setting');
        this._settings.set_double('current-brightness', value);
    }

    _getBrightnessLevel() {
        const proxy = this._getProxy();
        if (this._settings.get_boolean('use-backlight') && !proxy) {
            this._logger.log_debug('_getBrightnessLevel still waiting for proxy...');
            return 0;
        }

        if (this._settings.get_boolean('use-backlight') && proxy.Brightness >= 0) {
            const convertedBrightness = proxy.Brightness / 100.0;
            this._logger.log_debug('_getBrightnessLevel() by proxy = ' + convertedBrightness + ' <- ' + proxy.Brightness);
            return convertedBrightness;
        } else {
            const brightness = this._settings.get_double('current-brightness');
            this._logger.log_debug('_getBrightnessLevel() by setting = ' + brightness);
            return brightness;
        }
    }
}

// Monkey-patched screenshot methods
export class ScreenshotManager {
    constructor(logger) {
        this._logger = logger;

        // Set/destroyed by _enableScreenshotPatch/_disableScreenshotPatch
        this._screenshotRevertFns = [];
    }

    setPreCaptureHook(fn) {
        this._preCaptureHookFn = fn;
    }

    setPostCaptureHook(fn) {
        this._postCaptureHookFn = fn;
    }

    enable() {
        const preCapture = (fname) => {
            this._logger.log_debug('Screenshot ' + fname + '(): pre-capture');
            if (this._preCaptureHookFn !== null) {
                this._preCaptureHookFn(fname);
            }
        };
        const postCapture = (fname) => {
            this._logger.log_debug('Screenshot ' + fname + '(): post-capture');
            if (this._postCaptureHookFn !== null) {
                this._postCaptureHookFn(fname);
            }
        };
        // Monkey-patch screenshot capture functions to remove the overlay during
        // area, desktop, and interactive screenshots.  This is unnecessary for
        // window screenshots, so skip the `screenshot_window` function.
        //
        // In GS 46+, Gio._promisify wraps these methods and captures _finish by
        // reference at startup.  Patching _finish after that point has no effect,
        // so the post-capture hook must be chained onto the returned Promise instead.
        // patchFunction handles this automatically when a postHook is provided.
        this._logger.log_debug('_enableScreenshotPatch()');
        const proto = Shell.Screenshot.prototype;
        const targetFns = [
            'screenshot',
            'screenshot_area',
            ...proto.screenshot_stage_to_content ? ['screenshot_stage_to_content'] : []
        ];
        this._screenshotRevertFns = targetFns.map(fname =>
            Utils.patchFunction(proto, fname, preCapture, postCapture)
        );
    }

    disable() {
        // Undo monkey-patching of screenshot functions
        this._logger.log_debug('_disableScreenshotPatch()');
        this._screenshotRevertFns.forEach(fn => fn());
        this._screenshotRevertFns = [];
    }
}

// // QuickSlider item representing a monitor (external DDC/CI or fallback overlay)
export const MonitorBrightnessItem = GObject.registerClass(
class MonitorBrightnessItem extends QuickSlider {
    _init(logger, settings, overlayManager, ddcController, monitorInfo, onSyncCallback = null) {
        super._init({
            iconName: 'display-brightness-symbolic',
        });

        this._logger = logger;
        this._settings = settings;
        this._overlayManager = overlayManager;
        this._ddcController = ddcController;
        this._monitorInfo = monitorInfo || { displayName: _('Display'), connectorName: '', bus: null, monitorIndex: 0 };
        this._onSyncCallback = onSyncCallback;
        this._destroyed = false;

        this.menuEnabled = false;

        // Keep monochrome icon (do not set color: -st-accent-color)
        this._icon.style = '';

        const monitorName = this._monitorInfo.displayName || this._monitorInfo.connectorName || _('Display');
        this.slider.accessible_name = `${monitorName} ${_('Brightness')}`;

        // Replace default slider with DualZoneSlider
        const splitRatio = this._settings.get_double('software-dim-ratio') || 0.25;
        const oldSlider = this.slider;
        const bin = oldSlider?.get_parent ? oldSlider.get_parent() : null;
        this._dualSlider = new DualZoneSlider(1.0, splitRatio);
        if (bin) {
            bin.child = this._dualSlider;
        }
        if (oldSlider && typeof oldSlider.destroy === 'function') {
            oldSlider.destroy();
        }
        this.slider = this._dualSlider;

        // Connect slider value changes
        this._sliderChangedId = this.slider.connect('notify::value', () => this._onSliderChanged());

        // Watch settings
        this._splitRatioChangedId = this._settings.connect('changed::software-dim-ratio', () => {
            this._dualSlider.splitRatio = this._settings.get_double('software-dim-ratio');
        });

        this._minBrightnessChangedId = this._settings.connect('changed::min-brightness', () => {
            this._onSliderChanged();
        });

        // Initialize from DDC/CI hardware if available, else settings
        this._initFromHardware();
    }

    get monitorIndex() {
        return this._monitorInfo?.monitorIndex ?? 0;
    }

    get bus() {
        return this._monitorInfo?.bus ?? null;
    }

    async _initFromHardware() {
        const splitRatio = this._dualSlider.splitRatio;
        const minBrightness = this._settings.get_double('min-brightness');
        const ddcEnabled = this._settings.get_boolean('ddc-enabled');

        if (ddcEnabled && this._monitorInfo?.bus !== null && this._ddcController) {
            const values = await this._ddcController.getBrightnessAndContrast(this._monitorInfo.bus);
            if (this._destroyed)
                return;
            if (values && values.brightness !== null) {
                this.applyExternalBrightness(values.brightness);
                return;
            }
        }

        if (this._destroyed)
            return;
        const currentBrightness = this._settings.get_double('current-brightness');
        const initialVal = hardwareAndSoftwareToSlider(100, currentBrightness, splitRatio, minBrightness);
        this.setSliderValue(initialVal, false);
        this._updateIcon();
    }

    /**
     * Reconciles the slider with a hardware brightness read from outside the
     * extension (monitor OSD, another ddcutil call, or the initial read).
     *
     * Brightness (VCP 10) is the only source of thumb position; contrast is
     * re-coupled by the next extension-initiated move.  While hardware is at
     * 0%, stored software dimming keeps its position in the lower zone.
     */
    applyExternalBrightness(hardwareBrightness) {
        if (this._destroyed || hardwareBrightness === null || hardwareBrightness === undefined)
            return;

        const state = externalHardwareToSlider(
            hardwareBrightness,
            this._settings.get_double('current-brightness'),
            this._dualSlider.splitRatio,
            this._settings.get_double('min-brightness'));

        // An external source raised the hardware brightness.  Software
        // dimming can no longer be represented alongside a non-zero hardware
        // level, so adopt the external state.
        if (state.clearSoftwareDim) {
            this._settings.set_double('current-brightness', 1.0);
            if (this._overlayManager)
                this._overlayManager.hide();
        }

        this.setSliderValue(state.sliderValue, false);
    }

    setSliderValue(val, triggerChange = true) {
        if (this._destroyed)
            return;
        const clamped = Math.max(0.0, Math.min(1.0, val));
        if (Math.abs(this.slider.value - clamped) < 1e-6)
            return;

        if (!triggerChange)
            this.slider.block_signal_handler(this._sliderChangedId);
        this.slider.value = clamped;
        if (!triggerChange)
            this.slider.unblock_signal_handler(this._sliderChangedId);

        this._updateIcon();
    }

    stepDelta(direction) {
        const next = stepSliderValue(
            this.slider.value, direction, this._dualSlider.splitRatio, {
                software: this._settings.get_double('shortcut-step-software'),
                hardware: this._settings.get_double('shortcut-step-hardware'),
            });
        this.setSliderValue(next, true);
    }

    _updateIcon() {
        const isSoftwareDim = this.slider.value < this._dualSlider.splitRatio;
        const targetIcon = isSoftwareDim ? 'night-light-symbolic' : 'display-brightness-symbolic';
        if (this._icon.icon_name !== targetIcon) {
            this._icon.icon_name = targetIcon;
        }
    }

    _onSliderChanged() {
        const value = this.slider.value;
        const splitRatio = this._dualSlider.splitRatio;
        const minBrightness = this._settings.get_double('min-brightness');
        const ddcEnabled = this._settings.get_boolean('ddc-enabled');

        this._updateIcon();

        const { hardwareBrightness, hardwareContrast, softwareDim } =
            sliderToHardwareAndSoftware(value, splitRatio, minBrightness);

        if (ddcEnabled && this._monitorInfo?.bus !== null && this._ddcController) {
            this._ddcController.setBrightnessAndContrast(
                this._monitorInfo.bus,
                hardwareBrightness,
                hardwareContrast
            );
        }

        if (this._overlayManager) {
            if (softwareDim < 1.0) {
                this._overlayManager.show(softwareDim);
            } else {
                this._overlayManager.hide();
            }
        }
        this._settings.set_double('current-brightness', softwareDim);

        if (this._onSyncCallback && this._settings.get_boolean('sync-monitors')) {
            this._onSyncCallback(this, value);
        }
    }

    destroy() {
        this._destroyed = true;
        if (this._sliderChangedId) {
            this.slider.disconnect(this._sliderChangedId);
            this._sliderChangedId = null;
        }
        if (this._splitRatioChangedId) {
            this._settings.disconnect(this._splitRatioChangedId);
            this._splitRatioChangedId = null;
        }
        if (this._minBrightnessChangedId) {
            this._settings.disconnect(this._minBrightnessChangedId);
            this._minBrightnessChangedId = null;
        }
        super.destroy();
    }
});

// Alias for backwards compatibility
export const OverlayBrightnessItem = MonitorBrightnessItem;

// IndicatorManager manages QuickSettings integration, DDC/CI monitor discovery and sliders
export class IndicatorManager {
    constructor(logger, settings, overlayManager = null, monitorManager = null) {
        this._logger = logger;
        this._settings = settings;
        this._overlayManager = overlayManager;
        this._monitorManager = monitorManager;

        this._enableTimeoutId = null;
        this._ddcController = new DdcController(logger);

        this._sliderItems = [];
        this._indicator = null;
        this._slider = null;
        this._hardwareBrightnessChangedId = null;
        this._monitorsChangedId = null;
        this._settingsCallbacks = [];

        this._disabled = false;
        this._generation = 0;
        this._menu = null;
        this._menuOpenStateId = null;
        this._pollTimerId = 0;
        this._pollInFlight = false;
        this._refreshAfterActionId = 0;
    }

    getProxy() {
        return this._indicator?._proxy;
    }

    enable() {
        this._disabled = false;
        let attempt = 0;
        this._enableTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            const quickSettings = Main.panel.statusArea.quickSettings;
            if (quickSettings?.menu) {
                this._logger.log_debug('QuickSettings menu ready, initializing desktop brightness sliders');
                this._enableTimeoutId = null;
                this._enable();
                return GLib.SOURCE_REMOVE;
            }

            if (attempt >= 20) {
                this._logger.log_debug('Giving up on waiting for QuickSettings menu');
                this._enableTimeoutId = null;
                return GLib.SOURCE_REMOVE;
            }

            attempt += 1;
            return GLib.SOURCE_CONTINUE;
        });
    }

    _enable() {
        const quickSettings = Main.panel.statusArea.quickSettings;

        // Check if native brightness slider exists (built-in laptop screen)
        if (quickSettings._brightness?.quickSettingsItems) {
            this._indicator = quickSettings._brightness.quickSettingsItems[0];
            this._slider = this._indicator?.slider;
            if (this._slider) {
                this._hardwareBrightnessChangedId = this._slider.connect('notify::value', () => {
                    const useBacklight = this._settings.get_boolean('use-backlight');
                    if (useBacklight) {
                        this._settings.set_double('current-brightness', this._slider.value);
                    }
                });
            }
        }

        // Settings to watch
        const settingsToWatch = [
            'changed::ddc-enabled',
            'changed::software-dim-ratio',
            'changed::sync-monitors',
            'changed::use-backlight',
        ];
        this._settingsCallbacks = settingsToWatch.map(sig => {
            const id = this._settings.connect(sig, () => this._refreshSliders());
            return () => this._settings.disconnect(id);
        });

        // Monitor hotplug
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            this._logger.log_debug('IndicatorManager: monitors-changed');
            this._refreshSliders();
        });

        // Refresh DDC values when the Quick Settings menu becomes visible:
        // once immediately, then periodically while it stays open.
        this._menu = quickSettings.menu;
        if (this._menu?.connect) {
            this._menuOpenStateId = this._menu.connect('open-state-changed', (_menu, isOpen) => {
                this._onMenuOpenChanged(isOpen);
            });
            if (this._menu.isOpen)
                this._onMenuOpenChanged(true);
        }

        this._refreshSliders();
    }

    async _refreshSliders() {
        if (this._disabled)
            return;

        const generation = ++this._generation;
        this._clearSliders();

        const quickSettings = Main.panel.statusArea.quickSettings;
        if (!quickSettings?.menu)
            return;

        const ddcEnabled = this._settings.get_boolean('ddc-enabled');
        let ddcDisplays = [];
        if (ddcEnabled && this._ddcController) {
            ddcDisplays = await this._ddcController.detectDisplays();
            if (this._disabled || generation !== this._generation)
                return;
        }

        const mutterMonitors = Main.layoutManager.monitors || [];
        let displayConfigMonitors = [];
        if (this._monitorManager?._displayConfigProxy) {
            await new Promise(resolve => {
                Utils.getMonitorConfig(this._monitorManager._displayConfigProxy, (result, _err) => {
                    if (result) displayConfigMonitors = result;
                    resolve();
                });
            });
            if (this._disabled || generation !== this._generation)
                return;
        }

        const externalMonitors = [];
        for (let i = 0; i < mutterMonitors.length; i++) {
            const m = mutterMonitors[i];
            const cfg = displayConfigMonitors[i];
            const displayName = cfg ? cfg[0] : (m.name || `Display ${i + 1}`);
            const connectorName = cfg ? cfg[1] : '';

            const builtinMonitorName = this._settings.get_string('builtin-monitor');
            const isBuiltin = (displayName === builtinMonitorName) ||
                              connectorName.toLowerCase().startsWith('edp') ||
                              connectorName.toLowerCase().startsWith('lvds');

            // Internal laptop display with native backlight: let native GNOME slider handle it
            if (isBuiltin && this._indicator) {
                continue;
            }

            let matchedDdc = null;
            if (ddcDisplays.length > 0) {
                matchedDdc = ddcDisplays.find(d =>
                    (connectorName && d.drmConnector && (connectorName.includes(d.drmConnector) || d.drmConnector.includes(connectorName))) ||
                    (displayName && d.model && displayName.toLowerCase().includes(d.model.toLowerCase()))
                );
                if (!matchedDdc && ddcDisplays.length === 1 && mutterMonitors.length <= 2) {
                    matchedDdc = ddcDisplays[0];
                }
            }

            externalMonitors.push({
                monitorIndex: i,
                displayName: matchedDdc ? matchedDdc.name : displayName,
                connectorName,
                bus: matchedDdc ? matchedDdc.bus : null,
                isBuiltin,
            });
        }

        // If no monitors found (e.g. mock test or single display), ensure at least 1 slider
        if (externalMonitors.length === 0 && !this._indicator) {
            externalMonitors.push({
                monitorIndex: 0,
                displayName: _('Display Brightness'),
                connectorName: '',
                bus: null,
                isBuiltin: false,
            });
        }

        for (const monInfo of externalMonitors) {
            const sliderItem = new MonitorBrightnessItem(
                this._logger,
                this._settings,
                this._overlayManager,
                this._ddcController,
                monInfo,
                (sender, value) => this._onSync(sender, value)
            );

            this._sliderItems.push(sliderItem);

            if (quickSettings.menu.addItem) {
                quickSettings.menu.addItem(sliderItem, 2);
            } else if (quickSettings.menu._grid?.add_child) {
                quickSettings.menu._grid.add_child(sliderItem);
            }
        }

        // If native indicator exists, place custom sliders right after it
        if (this._indicator && this._sliderItems.length > 0) {
            const grid = this._indicator.get_parent ? this._indicator.get_parent() : null;
            if (grid && typeof grid.get_n_children === 'function') {
                try {
                    const nChildren = grid.get_n_children();
                    let bIndex = -1;
                    for (let i = 0; i < nChildren; i++) {
                        if (grid.get_child_at_index(i) === this._indicator) {
                            bIndex = i;
                            break;
                        }
                    }
                    if (bIndex >= 0) {
                        for (let j = 0; j < this._sliderItems.length; j++) {
                            grid.set_child_at_index(this._sliderItems[j], bIndex + 1 + j);
                        }
                    }
                } catch (e) {
                    this._logger.log_debug(`Reordering slider items failed: ${e.message}`);
                }
            }
        }

        // Sliders can be rebuilt while the menu is already open (hotplug,
        // settings change); make sure the periodic refresh covers them.
        if (this._menu?.isOpen)
            this._onMenuOpenChanged(true);
    }

    // Polling lifecycle: DDC/CI has no change notifications, so values are
    // sampled on menu open, every 5s while the menu stays open, and once
    // after a shortcut press (see refreshAfterUserAction()).
    _onMenuOpenChanged(isOpen) {
        if (this._disabled)
            return;
        if (!isOpen) {
            this._stopPolling();
            return;
        }

        this._refreshFromHardware();

        if (this._pollTimerId === 0 &&
            this._sliderItems.some(item => item.bus !== null)) {
            this._pollTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
                this._refreshFromHardware();
                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    _stopPolling() {
        if (this._pollTimerId) {
            GLib.source_remove(this._pollTimerId);
            this._pollTimerId = 0;
        }
    }

    /**
     * Schedules a one-shot refresh after a shortcut press.  Waits for the
     * coalescing DDC write queue to drain and the monitor to settle, so the
     * read cannot observe an intermediate value and bounce the thumb.
     */
    refreshAfterUserAction() {
        if (this._disabled)
            return;
        if (!this._sliderItems.some(item => item.bus !== null))
            return;

        if (this._refreshAfterActionId) {
            GLib.source_remove(this._refreshAfterActionId);
            this._refreshAfterActionId = 0;
        }
        this._scheduleRefreshAfterAction(1200);
    }

    _scheduleRefreshAfterAction(delayMs) {
        this._refreshAfterActionId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, delayMs, () => {
                this._refreshAfterActionId = 0;
                if (this._disabled)
                    return GLib.SOURCE_REMOVE;

                const busy = this._sliderItems.some(item =>
                    item.bus !== null && this._ddcController.isBusBusy(item.bus, 400));
                if (busy) {
                    this._scheduleRefreshAfterAction(400);
                    return GLib.SOURCE_REMOVE;
                }

                this._refreshFromHardware();
                return GLib.SOURCE_REMOVE;
            });
    }

    async _refreshFromHardware() {
        if (this._disabled || this._pollInFlight)
            return;

        const generation = this._generation;
        const items = this._sliderItems.filter(item => item.bus !== null);
        if (items.length === 0)
            return;

        this._pollInFlight = true;
        try {
            await Promise.allSettled(items.map(async item => {
                if (this._ddcController.isBusBusy(item.bus, 400))
                    return;

                const values = await this._ddcController.getBrightnessAndContrast(item.bus);
                if (this._disabled || generation !== this._generation ||
                    !this._sliderItems.includes(item))
                    return;

                // A shortcut press during the read makes the sample stale;
                // let that press's own refresh win.
                if (this._ddcController.isBusBusy(item.bus, 400))
                    return;

                // Brightness (VCP 10) alone drives the thumb.
                if (values && values.brightness !== null)
                    item.applyExternalBrightness(values.brightness);
            }));
        } finally {
            this._pollInFlight = false;
        }
    }

    _onSync(sender, value) {
        for (const item of this._sliderItems) {
            if (item !== sender) {
                item.setSliderValue(value, true);
            }
        }
    }

    _clearSliders() {
        for (const item of this._sliderItems) {
            item.destroy();
        }
        this._sliderItems = [];
    }

    getSliderForCurrentCursor() {
        if (this._sliderItems.length === 0)
            return null;

        if (this._settings.get_boolean('sync-monitors'))
            return this._sliderItems[0];

        try {
            const [x, y] = global.get_pointer();
            const monitors = Main.layoutManager.monitors || [];
            let currentMonitorIdx = global.display?.get_current_monitor() ?? 0;
            for (let i = 0; i < monitors.length; i++) {
                const m = monitors[i];
                if (x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height) {
                    currentMonitorIdx = i;
                    break;
                }
            }
            const match = this._sliderItems.find(item => item.monitorIndex === currentMonitorIdx);
            return match || this._sliderItems[0];
        } catch (e) {
            return this._sliderItems[0];
        }
    }

    disable() {
        this._disabled = true;
        this._generation++;

        if (this._enableTimeoutId !== null) {
            GLib.source_remove(this._enableTimeoutId);
            this._enableTimeoutId = null;
        }

        this._stopPolling();

        if (this._refreshAfterActionId) {
            GLib.source_remove(this._refreshAfterActionId);
            this._refreshAfterActionId = 0;
        }

        if (this._menu && this._menuOpenStateId) {
            this._menu.disconnect(this._menuOpenStateId);
            this._menuOpenStateId = null;
        }
        this._menu = null;

        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }

        if (this._settingsCallbacks) {
            this._settingsCallbacks.forEach(fn => fn());
            this._settingsCallbacks = [];
        }

        if (this._hardwareBrightnessChangedId && this._slider) {
            this._slider.disconnect(this._hardwareBrightnessChangedId);
            this._hardwareBrightnessChangedId = null;
        }

        this._clearSliders();

        if (this._ddcController) {
            this._ddcController.destroy();
        }

        this._indicator = null;
        this._slider = null;
    }
}

// Cursor handling
class CursorManager {
    constructor(logger, settings, overlayManager) {
        this._logger = logger;
        this._settings = settings;
        this._overlayManager = overlayManager;

        // Set by setChangeHook
        this._changeHookFn = null;

        // State trackers
        this._active = false;
        this._cloned = false;

        // Set/destroyed by enable/disable
        this._enableTimeoutId = null;
        this._cloneMouseSetting = null;
        this._cloneMouseSettingChangedConnection = null;

        // Set/destroyed by _enableCloningMouse/_disableCloningMouse
        this._cursorTracker = null;
        this._cursorSprite = null;
        this._cursorActor = null;
        this._cursorWatcher = null;
        this._cursorWatch = null;
        this._cursorInOverlay = false;
        this._cursorChangedConnection = null;
        this._cursorVisibilityChangedConnection = null;
        this._idleMonitor = null;
        this._cursorIdleWatchId = 0;
        this._cursorActiveWatchId = 0;

        // Set/destroyed by _hideSystemCursor/_showSystemCursor
        this._cursorUnfocusInhibited = false;
        this._cursorHidden = false;
    }

    setChangeHook(fn) {
        this._changeHookFn = fn;
    }

    enable() {
        // First 500ms: For some reason, starting the mouse cloning at this
        // stage fails when gnome-shell is restarting on x11 and the mouse
        // listener doesn't receive any events.  Adding a small delay before
        // starting the whole mouse cloning business helps.
        this._enableTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._enableTimeoutId = null;
            this._enable();
            return GLib.SOURCE_REMOVE;
        });
    }

    _enable() {
        this._cloneMouseSetting = this._settings.get_boolean('clone-mouse');
        this.setActive(true);
        this._cloneMouseSettingChangedConnection = this._settings.connect(
            'changed::clone-mouse', this._on_clone_mouse_change.bind(this));
    }

    setActive(active, suppressChangeHook = false) {
        this._active = active;
        this._update(suppressChangeHook);
    }

    _update(suppressChangeHook = false) {
        const newCloned = !!(this._cloneMouseSetting && this._active);
        if (newCloned === this._cloned) {
            return;
        }

        if (newCloned) {
            this._logger.log_debug('CursorManager: enable mouse cloning');
            this._enableCloningMouse();
        } else {
            this._logger.log_debug('CursorManager: disable mouse cloning');
            this._disableCloningMouse();
        }
        this._cloned = newCloned;

        if (!suppressChangeHook && this._changeHookFn !== null) {
            this._changeHookFn();
        }
    }

    disable() {
        // If _enableTimeoutId is non-null, _enable() has not run yet, and will
        // not run.  Do not run _disable() in this case.
        if (this._enableTimeoutId !== null) {
            GLib.source_remove(this._enableTimeoutId);
            this._enableTimeoutId = null;
            return;
        }
        this._changeHookFn = null;

        this._settings.disconnect(this._cloneMouseSettingChangedConnection);
        this._cloneMouseSettingChangedConnection = null;

        this.setActive(false);
    }


    _on_clone_mouse_change() {
        const cloneMouse = this._settings.get_boolean('clone-mouse');
        if (cloneMouse === this._cloneMouseSetting) {
            this._logger.log_debug('_on_clone_mouse_change(): no setting change, no change');
            return;
        }
        this._logger.log_debug(`_on_clone_mouse_change(): ${cloneMouse ? 'starting' : 'stopping'} mouse cloning`);
        this._cloneMouseSetting = cloneMouse;
        this._update();
    }

    _enableCloningMouse() {
        this._logger.log_debug('_enableCloningMouse()');

        // In GS 48, CursorTracker.get_for_display was moved to global.backend.get_cursor_tracker.
        this._cursorTracker = global.backend.get_cursor_tracker !== undefined
          ? global.backend.get_cursor_tracker()
          : Meta.CursorTracker.get_for_display(global.display);

        if (this._cursorWatch == null) {
            // Create the clone actors only when actually starting a watch;
            // creating them unconditionally leaks stale cursor actors
            // ("cursor trails") if this method runs twice.
            this._cursorSprite = new Clutter.Actor({ request_mode: Clutter.RequestMode.CONTENT_SIZE });
            this._cursorSprite.content = new MouseSpriteContent();

            this._cursorActor = new Clutter.Actor();
            this._cursorActor.add_child(this._cursorSprite);
            this._cursorWatcher = getPointerWatcher(this._cursorTracker);

            this._overlayManager.addActor(this._cursorActor);
            this._cursorInOverlay = true;
            this._cursorChangedConnection = this._cursorTracker.connect(
                'cursor-changed', this._updateMouseSprite.bind(this));
            this._cursorVisibilityChangedConnection = this._cursorTracker.connect(
                'visibility-changed', this._onCursorVisibilityChanged.bind(this));
            this._startPointerWatch();

            // In GS 49, Meta.IdleMonitor.get_core() was removed.
            // global.backend.get_core_idle_monitor() exists on all supported
            // versions (mutter 45+); the fallback is defensive only.
            this._idleMonitor = global.backend.get_core_idle_monitor !== undefined
                ? global.backend.get_core_idle_monitor()
                : Meta.IdleMonitor.get_core();
            this._setupCursorIdleWatch();
        }

        this._hideSystemCursor();
    }

    _startPointerWatch() {
        const interval = 1000 / 60;
        this._logger.log_debug('_startPointerWatch(): watch interval = ' + interval + ' ms');
        this._cursorWatch = this._cursorWatcher.addWatch(
            interval, this._updateMousePosition.bind(this));
        this._updateMouseSprite();
        this._updateMousePosition();
    }

    _setupCursorIdleWatch() {
        // Pause the cursor polling loop when idle so the display can sleep.
        // The software cursor render loop prevents DPMS from powering off the
        // display; removing the watch while idle eliminates that inhibition.
        const IDLE_TIMEOUT_MS = 30 * 1000;
        this._cursorIdleWatchId = this._idleMonitor.add_idle_watch(IDLE_TIMEOUT_MS, () => {
            this._cursorIdleWatchId = 0;
            if (this._cursorWatch != null) {
                this._cursorWatch.remove();
                this._cursorWatch = null;
                this._cursorActor.hide();
            }
            this._cursorActiveWatchId = this._idleMonitor.add_user_active_watch(() => {
                this._cursorActiveWatchId = 0;
                if (this._cursorWatcher != null && this._cursorWatch == null) {
                    this._cursorActor.show();
                    this._startPointerWatch();
                }
                if (this._idleMonitor != null)
                    this._setupCursorIdleWatch();
            });
        });
    }

    _disableCloningMouse() {
        if (this._cursorIdleWatchId && this._idleMonitor) {
            this._idleMonitor.remove_watch(this._cursorIdleWatchId);
            this._cursorIdleWatchId = 0;
        }
        if (this._cursorActiveWatchId && this._idleMonitor) {
            this._idleMonitor.remove_watch(this._cursorActiveWatchId);
            this._cursorActiveWatchId = 0;
        }
        this._idleMonitor = null;

        if (this._cursorInOverlay) {
            this._logger.log_debug('_disableCloningMouse(): removing clone actors');

            if (this._cursorWatch != null) {
                this._cursorWatch.remove();
                this._cursorWatch = null;
            }

            this._cursorTracker.disconnect(this._cursorChangedConnection);
            this._cursorChangedConnection = null;

            this._cursorTracker.disconnect(this._cursorVisibilityChangedConnection);
            this._cursorVisibilityChangedConnection = null;

            this._overlayManager.removeActor(this._cursorActor);
            this._cursorInOverlay = false;
        }

        this._showSystemCursor();

        this._cursorTracker = null;
        this._cursorSprite = null;
        if (this._cursorActor !== null) {
            try {
                this._cursorActor.destroy();
            } catch (_e) {
                // Actor may have already been disposed by C code (e.g. stage teardown)
            }
        }
        this._cursorActor = null;
        this._cursorWatcher = null;
    }

    _updateMousePosition() {
        const [x, y] = global.get_pointer();
        // Damage the current (old) paint volume before moving.  set_position
        // should damage both positions, but on GNOME 51 the cursor clone sits
        // above offscreen-redirected siblings and a missed old-position
        // damage leaves a cursor trail; queue it explicitly (the clone is a
        // small actor, so this is cheap).
        this._cursorActor.queue_redraw();
        this._cursorActor.set_position(x, y);
        this._cursorSprite.content.dimFactor = this._overlayManager.brightnessAt(x, y);
        // Keep the clone above menus/dialogs that raised themselves (cheap
        // no-op when nothing changed).
        this._overlayManager.raiseToTop();
    }

    // Re-dim the clone after a brightness or monitor-selection change while
    // the pointer is not moving.
    refreshDim() {
        if (this._cursorActor !== null && this._cursorSprite !== null)
            this._updateMousePosition();
    }

    _onCursorVisibilityChanged() {
        this._updateMouseSprite();

        // Mutter re-shows the system cursor on its own during grabs, window
        // resizes and VT switches, dropping our inhibition.  If we are
        // supposed to be hiding it, re-assert the inhibition, otherwise the
        // real cursor is drawn on top of the clone (double cursor).
        if (this._cursorHidden &&
            typeof this._cursorTracker.get_pointer_visible === 'function' &&
            this._cursorTracker.get_pointer_visible()) {
            this._logger.log_debug('_onCursorVisibilityChanged(): system cursor re-appeared, re-hiding');
            this._cursorHidden = false;
            this._hideSystemCursor();
        }
    }

    _updateMouseSprite() {
        // Damage the old sprite area before the texture, size or hotspot
        // translation changes.  The content invalidation only repaints the
        // new area; without this the previous (possibly larger) cursor
        // stays on screen, e.g. after switching from a 2x client cursor to
        // a theme cursor.
        this._cursorSprite.queue_redraw();

        const sprite = this._cursorTracker.get_sprite();
        // In GS 51, Meta.CursorTracker.get_scale() exposes the sprite's
        // texture scale.  For client cursor surfaces this is the exact
        // texture-to-logical factor; theme cursors report 1.0 and fall
        // back to the size heuristic in MouseSpriteContent.
        const trackerScale = this._cursorTracker.get_scale !== undefined
            ? this._cursorTracker.get_scale()
            : 1;
        this._cursorSprite.content.trackerScale = trackerScale;

        if (sprite) {
            this._cursorSprite.content.texture = sprite;
            this._cursorSprite.show();
        } else {
            this._cursorSprite.hide();
        }

        // MouseSpriteContent normalizes the texture to the theme's cursor
        // size (texture px ÷ sprite scale), so sprites at 1x and 2x render
        // the same size.  The hotspot arrives in texture pixels and needs
        // the same normalization.
        const scale = this._cursorSprite.content.spriteScale;
        const [xHot, yHot] = this._cursorTracker.get_hot();
        this._cursorSprite.set({
            translation_x: -xHot / scale,
            translation_y: -yHot / scale,
        });

        this._logger.log_debug('_updateMouseSprite(): tex=' +
            (sprite ? sprite.get_width() + 'x' + sprite.get_height() : 'none') +
            ', trackerScale=' + trackerScale + ', spriteScale=' + scale +
            ', hotspot=' + xHot + ',' + yHot);
    }

    _showSystemCursor() {
        const seat = getDefaultSeat();

        if (this._cursorUnfocusInhibited) {
            seat.uninhibit_unfocus();
            this._cursorUnfocusInhibited = false;
        }

        if (this._cursorHidden) {
            this._cursorHidden = false;
            // GS 49+: uninhibit_cursor_visibility. GS 46–48: set_pointer_visible.
            // GS 45 briefly had uninhibit_cursor_visibility, then it was removed until GS 49.
            if (typeof this._cursorTracker.uninhibit_cursor_visibility === 'function')
                this._cursorTracker.uninhibit_cursor_visibility();
            else if (typeof this._cursorTracker.set_pointer_visible === 'function')
                this._cursorTracker.set_pointer_visible(true);
        }
    }

    _hideSystemCursor() {
        const seat = getDefaultSeat();

        if (!this._cursorUnfocusInhibited) {
            seat.inhibit_unfocus();
            this._cursorUnfocusInhibited = true;
        }

        if (!this._cursorHidden) {
            this._cursorHidden = true;
            // GS 49+: inhibit_cursor_visibility. GS 46–48: set_pointer_visible.
            // GS 45 briefly had inhibit_cursor_visibility, then it was removed until GS 49.
            if (typeof this._cursorTracker.inhibit_cursor_visibility === 'function')
                this._cursorTracker.inhibit_cursor_visibility();
            else if (typeof this._cursorTracker.set_pointer_visible === 'function')
                this._cursorTracker.set_pointer_visible(false);
        }
    }
}

// Gamma-curve shader lifecycle and cursor actor hosting.
export class OverlayManager {
    constructor(logger, settings, monitorManager) {
        this._logger = logger;
        this._settings = settings;
        this._monitorManager = monitorManager;

        this._actorGroup = null;
        // [{container, addedId, removedId}] — see _isContainer()
        this._containers = [];
        // [{actor, effect, destroyId}] — actors currently carrying our shader
        this._shaderTargets = [];
        // null = not dimming; number = current brightness level
        this._currentBrightness = null;
        // Cache of the last-applied show() parameters, for redundancy skips
        this._lastShowSig = null;
        this._lastMonitorSig = null;
        this._unredirectInhibited = false;
    }

    enable() {
        this._actorGroup = new St.Widget({ name: 'brightness-slider-overlays' });
        this.resetSize();
        Shell.util_set_hidden_from_pick(this._actorGroup, true);
        // Host the cursor-clone group inside uiGroup, like the magnifier
        // does, above the shader-dimmed siblings.  It carries no shader
        // itself (see _isShaderTarget); the clone dims its own sprite.
        Main.uiGroup.add_child(this._actorGroup);

        this._watchContainer(global.stage);
    }

    disable() {
        for (const { container, addedId, removedId } of this._containers) {
            container.disconnect(addedId);
            container.disconnect(removedId);
        }
        this._containers = [];

        this.hide();

        Main.uiGroup.remove_child(this._actorGroup);
        this._actorGroup.destroy();
        this._actorGroup = null;
    }

    resetSize() {
        this._actorGroup.set_size(global.screen_width, global.screen_height);
    }

    initialized() {
        return this._shaderTargets.length > 0;
    }

    addActor(actor) {
        this._actorGroup.add_child(actor);
        this.raiseToTop();
    }

    // Menus and dialogs raise themselves above their uiGroup siblings when
    // opening, which puts them above the cursor clone; no signal fires on
    // reorder, so callers re-assert topmost position (no-op when already top).
    raiseToTop() {
        if (this._actorGroup !== null &&
            this._actorGroup.get_parent() === Main.uiGroup &&
            Main.uiGroup.get_last_child() !== this._actorGroup) {
            Main.uiGroup.set_child_above_sibling(this._actorGroup, null);
        }
    }

    removeActor(actor) {
        if (this._actorGroup)
            this._actorGroup.remove_child(actor);
    }

    // Which actors carry the shader.
    //
    // The shader cannot go on the stage (the root framebuffer), nor on a
    // MetaWindowGroup (window_group, top_window_group, the feedback group):
    // those paint through mutter's culling, which goes wrong inside an
    // offscreen framebuffer.  Nor on uiGroup, which contains them: there it
    // dropped the desktop background from the dimmed image whenever the
    // screen changed (flickering, worst on monitors with different refresh
    // rates).  So these containers are walked through, and the shader goes
    // on every other actor directly inside them: the shell's UI groups, the
    // window actors, the background group...  Every visible actor is then
    // inside exactly one shader target, and is dimmed once.  (Clones are
    // dimmed by the target they sit in, see paintBrightness().)
    //
    // The cursor-clone group is excluded: an offscreen effect on an actor
    // that moves every frame leaves stale trails, so the clone dims itself
    // instead (see brightnessAt()).
    _isContainer(actor) {
        return actor === global.stage || actor === Main.uiGroup ||
            actor instanceof Meta.WindowGroup;
    }

    _isShaderTarget(actor) {
        return actor !== this._actorGroup && !this._isContainer(actor);
    }

    _collectShaderTargets(container = global.stage) {
        return container.get_children().flatMap(child =>
            this._isContainer(child)
                ? this._collectShaderTargets(child)
                : this._isShaderTarget(child) ? [child] : []);
    }

    // Follow the children (windows, popups...) of `container` and of the
    // containers inside it as they come and go.
    _watchContainer(container) {
        // In GS 45, use of "actor" was renamed to "child".
        const clutterContainer = Clutter.Container !== undefined;
        const addedId = container.connect(
            clutterContainer ? 'actor-added' : 'child-added',
            (_container, child) => this._onChildAdded(child));
        const removedId = container.connect(
            clutterContainer ? 'actor-removed' : 'child-removed',
            (_container, child) => this._removeActorFromTargets(child));
        this._containers.push({ container, addedId, removedId });

        for (const child of container.get_children()) {
            if (this._isContainer(child))
                this._watchContainer(child);
        }
    }

    _onChildAdded(child) {
        if (this._currentBrightness !== null && this._isShaderTarget(child)) {
            this._applyShaderToActor(child);
            // A new offscreen-redirected actor can leave the area it
            // covers stale until something forces a full repaint.
            this._forceFullRedraw();
        }
        // The pointer watch re-raises the clone group on motion, but a popup
        // opened via keyboard with the pointer stationary would cover the
        // clone until the mouse next moves — also re-raise when something
        // is added.
        this.raiseToTop();
    }

    _removeActorFromTargets(actor) {
        const idx = this._shaderTargets.findIndex(t => t.actor === actor);
        if (idx !== -1) {
            const [removed] = this._shaderTargets.splice(idx, 1);
            if (removed.destroyId) {
                try { actor.disconnect(removed.destroyId); } catch (_e) {}
            }
            this._detachEffect(removed.actor, removed.effect);
            // Removing an offscreen-redirected actor can leave its last
            // frame on screen; repaint once to clear it.
            this._forceFullRedraw();
        }
    }

    // Clutter detaches effects itself while destroying an actor; removing
    // an already-detached effect only logs a "not attached" warning.
    _detachEffect(actor, effect) {
        try {
            if (effect.get_actor() === actor)
                actor.remove_effect(effect);
        } catch (_e) {}
    }

    _applyShaderToActor(actor) {
        if (this._shaderTargets.some(t => t.actor === actor))
            return;
        const monitorRects = this._getDimmedMonitorRects();
        if (monitorRects === null)
            return;
        const effect = new GammaCurveEffect(this._currentBrightness, monitorRects);
        actor.add_effect_with_name('brightness-slider-shader', effect);
        const destroyId = actor.connect('destroy', () => this._removeActorFromTargets(actor));
        this._shaderTargets.push({ actor, effect, destroyId });
        this._logger.log_debug('_applyShaderToActor: ' + (actor.name || String(actor)));
    }

    show(brightness) {
        this._currentBrightness = brightness;

        const monitorRects = this._getDimmedMonitorRects();
        if (monitorRects === null) {
            // Monitor selection matches nothing: dim nothing.
            this.hide();
            return;
        }

        this._inhibitUnredirect(true);

        const targets = this._collectShaderTargets();
        const targetsChanged =
            this._shaderTargets.length !== targets.length ||
            this._shaderTargets.some((t, i) => t.actor !== targets[i]);
        const monitorSig = JSON.stringify(monitorRects);
        const monitorsChanged = monitorSig !== this._lastMonitorSig;
        this._lastMonitorSig = monitorSig;

        // Settings-change storms (e.g. prefs rewriting a key) re-invoke show()
        // with identical parameters many times per second; skip when nothing
        // would change.
        const sig = brightness + '/' + JSON.stringify(monitorRects);
        if (sig === this._lastShowSig &&
            this._shaderTargets.length === targets.length &&
            this._shaderTargets.every((t, i) => t.actor === targets[i] && t.effect.enabled)) {
            return;
        }
        this._lastShowSig = sig;
        this._logger.log_debug('show(' + brightness + ')');

        const existingMap = new Map(this._shaderTargets.map(t => [t.actor, t.effect]));
        const existingDestroyMap = new Map(this._shaderTargets.map(t => [t.actor, t.destroyId]));

        // Remove effects from actors no longer in target list
        for (const { actor, effect, destroyId } of this._shaderTargets) {
            if (!targets.includes(actor)) {
                if (destroyId) {
                    try { actor.disconnect(destroyId); } catch (_e) {}
                }
                this._detachEffect(actor, effect);
            }
        }

        // Apply or update shader on each current target
        this._shaderTargets = targets.map(actor => {
            if (existingMap.has(actor)) {
                const effect = existingMap.get(actor);
                effect.update(brightness, monitorRects);
                effect.enabled = true;
                return { actor, effect, destroyId: existingDestroyMap.get(actor) };
            }
            const effect = new GammaCurveEffect(brightness, monitorRects);
            actor.add_effect_with_name('brightness-slider-shader', effect);
            const destroyId = actor.connect('destroy', () => this._removeActorFromTargets(actor));
            return { actor, effect, destroyId };
        });

        // Applying/removing a batch of offscreen effects, or moving the
        // dimmed area to different monitors, changes what is painted and can
        // leave stale regions behind (seen at login on GNOME 51).  One full
        // repaint after such a change makes the frame consistent;
        // brightness-only updates skip it.
        if (targetsChanged || monitorsChanged)
            this._forceFullRedraw();
    }

    _forceFullRedraw() {
        if (global.stage)
            global.stage.queue_redraw();
    }

    hide() {
        this._currentBrightness = null;
        this._lastShowSig = null;
        for (const { actor, effect, destroyId } of this._shaderTargets) {
            if (destroyId) {
                try { actor.disconnect(destroyId); } catch (_e) {}
            }
            this._detachEffect(actor, effect);
        }
        this._shaderTargets = [];
        this._inhibitUnredirect(false);
    }

    // A fullscreen window can skip compositing (unredirection on X11, direct
    // scanout on Wayland), and the shader with it.  Keep compositing while
    // dimming, as ui/magnifier.js does while magnifying.
    _inhibitUnredirect(inhibit) {
        if (inhibit === this._unredirectInhibited)
            return;
        this._unredirectInhibited = inhibit;
        // In GS 48, *_unredirect_for_display functions were moved to global compositor.
        if (global.compositor?.disable_unredirect === undefined) {
            if (inhibit)
                Meta.disable_unredirect_for_display(global.display);
            else
                Meta.enable_unredirect_for_display(global.display);
        } else if (inhibit) {
            global.compositor.disable_unredirect();
        } else {
            global.compositor.enable_unredirect();
        }
        // Switching between direct scanout and compositing can leave the
        // previous scanout buffer on screen until something forces a full
        // repaint (seen after login on GNOME 51).  Repaint once now.
        this._forceFullRedraw();
    }

    hideForScreenshot() {
        for (const { effect } of this._shaderTargets)
            effect.enabled = false;
    }

    // Brightness the cursor clone should be drawn at when the pointer is at
    // (x, y): it is not a shader target, so it is dimmed by its sprite color.
    brightnessAt(x, y) {
        if (this._currentBrightness === null)
            return 1.0;
        const monitorRects = this._getDimmedMonitorRects();
        if (monitorRects === null)
            return 1.0;
        if (monitorRects.length === 0)
            return this._currentBrightness;
        const dimmed = monitorRects.some(r =>
            x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);
        return dimmed ? this._currentBrightness : 1.0;
    }

    // Returns the stage-coordinate rects [{x,y,width,height}] of the
    // monitors to dim.  Empty array = dim every monitor (monitors='all').
    _getDimmedMonitorRects() {
        const enabledMonitors = this._settings.get_string('monitors');
        if (enabledMonitors === 'all') return [];

        // The selection matches no monitor (e.g. monitors='external' while
        // undocked, or the monitor list is not known yet): return null =
        // dim nothing.  [] is reserved for 'all' = dim everything.
        const monitors = this._monitorManager.getMonitors();
        if (!monitors || monitors.length === 0) return null;

        return monitors.map(m => ({
            x: m.x,
            y: m.y,
            width: m.width,
            height: m.height,
        }));
    }
}

// Monitor change handling
export class MonitorManager {
    constructor(logger, settings, extPath) {
        this._logger = logger;
        this._settings = settings;
        this._extPath = extPath;

        this._disabled = false;
        this._monitorsChangedConnection = null;
        this._displayConfigProxy = null;
        this._backendManager = null;
        this._monitorNames = null;
        this._changeHookFn = null;
    }

    enable() {
        this._disabled = false;
        this._logger.log_debug('_enableMonitor2ing()');
        this._backendManager = global.backend.get_monitor_manager();
        Utils.newDisplayConfig(this._extPath, (proxy, error) => {
            if (this._disabled)
                return;
            if (error) {
                this._logger.log('newDisplayConfig() callback: Cannot get Display Config: ' + error);
                return;
            }
            this._logger.log_debug('newDisplayConfig() callback');
            this._displayConfigProxy = proxy;
            this._on_monitors_change();
        });

        this._monitorsChangedConnection = Main.layoutManager.connect('monitors-changed', this._on_monitors_change.bind(this));
    }

    disable() {
        this._disabled = true;
        this._logger.log_debug('_disableMonitor2ing()');

        Main.layoutManager.disconnect(this._monitorsChangedConnection);

        this._logger = null;
        this._settings = null;

        this._monitorsChangedConnection = null;
        this._displayConfigProxy = null;
        this._backendManager = null;
        this._monitorNames = null;
        this._changeHookFn = null;
    }

    setChangeHook(fn) {
        this._changeHookFn = fn;
    }

    setPostCallback(callback) {
        this._postCallback = callback;
    }

    getMonitors() {
        if (this._monitorNames == null) {
            this._logger.log_debug('getMonitors(): _monitorNames not ready yet, returning null');
            return null;
        }

        const enabledMonitors = this._settings.get_string('monitors');
        this._logger.log_debug('getMonitors(): enabledMonitors="' + enabledMonitors + '"');
        if (enabledMonitors == 'all') {
            return Main.layoutManager.monitors;
        } else if (enabledMonitors == 'built-in' || enabledMonitors == 'external') {
            const builtinMonitorName = this._settings.get_string('builtin-monitor');
            this._logger.log_debug('getMonitors(): builtinMonitorName="' + builtinMonitorName + '"');
            const monitors = [];
            for (let i = 0; i < Main.layoutManager.monitors.length; i++) {
                if ((enabledMonitors == 'built-in' && this._monitorNames[i] == builtinMonitorName) ||
                    (enabledMonitors == 'external' && this._monitorNames[i] != builtinMonitorName)) {
                    monitors.push(Main.layoutManager.monitors[i]);
                }
            }
            return monitors;
        } else {
            this._logger.log('getMonitors(): unhandled "monitors" setting = ' + enabledMonitors);
            return null;
        }
    }

    _on_monitors_change() {
        if (this._displayConfigProxy == null) {
            this._logger.log_debug('_on_monitors_change(): skipping run as the proxy hasn\'t been set up yet.');
            return;
        }
        this._logger.log_debug('_on_monitors_change()');
        Utils.getMonitorConfig(this._displayConfigProxy, (result, error) => {
            if (this._disabled)
                return;
            if (error) {
                this._logger.log('_on_monitors_change(): cannot get Monitor Config: ' + error);
                // Retry after a short delay — can happen in headless/virtual environments
                // where the virtual monitor hasn't registered with DisplayConfig yet.
                if (!this._disabled) {
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
                        if (!this._disabled)
                            this._on_monitors_change();
                        return GLib.SOURCE_REMOVE;
                    });
                }
                return;
            }
            const monitorNames = [];
            for (let i = 0; i < result.length; i++) {
                const [monitorName, connectorName] = result[i];
                const monitorIndex = this._backendManager.get_monitor_for_connector(connectorName);
                this._logger.log_debug('_on_monitors_change(): monitor="' + monitorName + '", connector="' + connectorName + '", index=' + monitorIndex);
                if (monitorIndex >= 0) {
                    monitorNames[monitorIndex] = monitorName;
                }
            }
            this._monitorNames = monitorNames;

            // Auto-detect builtin monitor if not set
            const builtinMonitorName = this._settings.get_string('builtin-monitor');
            if ((builtinMonitorName == '' || builtinMonitorName == null) && monitorNames.length > 0) {
                const detectedBuiltin = monitorNames[Main.layoutManager.primaryIndex];
                this._logger.log_debug('_on_monitors_change(): auto-detecting builtin monitor: ' + detectedBuiltin);
                this._settings.set_string('builtin-monitor', detectedBuiltin);
                // The settings callback will trigger _on_brightness_change, so return early
                return;
            }

            if (this._changeHookFn !== null) {
                this._changeHookFn();
            }
        });
    }
}
