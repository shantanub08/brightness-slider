// brightness-slider - Dual-zone slider supporting hardware DDC/CI and software dimming
// Copyright (C) 2026 Shantanu Baviskar (shantanub08 on Github)
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import { Slider } from 'resource:///org/gnome/shell/ui/slider.js';

// In GS 47, Clutter.Color was replaced by Cogl.Color.  Construct colors
// through this helper so the slider keeps working on GS 45–51.
function makeColor(red, green, blue, alpha) {
    return Clutter.Color !== undefined
        ? new Clutter.Color({ red, green, blue, alpha })
        : new Cogl.Color({ red, green, blue, alpha });
}

function withAlpha(color, alpha) {
    return makeColor(color.red, color.green, color.blue, alpha);
}

// Software dimming uses the accent color at reduced opacity; the notch
// uses the theme foreground color, so both adapt to light and dark themes.
const SOFTWARE_ZONE_ALPHA = 115;
const NOTCH_ALPHA = 128;

/**
 * Maps a single slider value [0.0, 1.0] to hardware brightness & contrast [0, 100]
 * and software dimming factor [minBrightness, 1.0].
 *
 * Range [0.0, splitRatio):
 *   Hardware is at 0%. Software dimming scales from minBrightness to 1.0.
 *
 * Range [splitRatio, 1.0]:
 *   Software dimming is 1.0 (disabled). Hardware brightness and contrast
 *   scale proportionally 1:1 from 0% to 100%.
 */
export function sliderToHardwareAndSoftware(value, splitRatio = 0.25, minBrightness = 0.1) {
    const v = Math.max(0.0, Math.min(1.0, value));
    const s = Math.max(0.01, Math.min(0.9, splitRatio));
    const m = Math.max(0.0, Math.min(0.95, minBrightness));

    if (v >= s) {
        const hardwarePercent = Math.round(((v - s) / (1.0 - s)) * 100);
        return {
            hardwareBrightness: hardwarePercent,
            hardwareContrast: hardwarePercent,
            softwareDim: 1.0,
        };
    } else {
        const ratio = v / s;
        const softwareDim = m + ratio * (1.0 - m);
        return {
            hardwareBrightness: 0,
            hardwareContrast: 0,
            softwareDim: Math.max(m, Math.min(1.0, softwareDim)),
        };
    }
}

/**
 * Maps hardware percentage [0, 100] and software dim factor [minBrightness, 1.0]
 * back to a single slider value [0.0, 1.0].
 */
export function hardwareAndSoftwareToSlider(hardwarePercent = 0, softwareDim = 1.0, splitRatio = 0.25, minBrightness = 0.1) {
    const s = Math.max(0.01, Math.min(0.9, splitRatio));
    const m = Math.max(0.0, Math.min(0.95, minBrightness));

    if (softwareDim < 0.999) {
        const range = Math.max(0.001, 1.0 - m);
        const ratio = Math.max(0.0, Math.min(1.0, (softwareDim - m) / range));
        return ratio * s;
    } else {
        const h = Math.max(0, Math.min(100, hardwarePercent));
        return s + (h / 100.0) * (1.0 - s);
    }
}

/**
 * Maps an externally observed hardware brightness to thumb state.
 *
 * Brightness alone decides the position.  With hardware above zero the
 * software dimming layer cannot be represented alongside it, so any stored
 * dimming is reported as `clearSoftwareDim`.  At hardware zero the stored
 * software dimming keeps its place in the lower zone.
 */
export function externalHardwareToSlider(hardwarePercent, storedSoftwareDim = 1.0,
    splitRatio = 0.25, minBrightness = 0.1) {
    const hw = Math.max(0, Math.min(100, Math.round(hardwarePercent)));
    const dim = Math.max(0.0, Math.min(1.0, storedSoftwareDim));

    if (hw > 0) {
        return {
            sliderValue: hardwareAndSoftwareToSlider(hw, 1.0, splitRatio, minBrightness),
            softwareDim: 1.0,
            clearSoftwareDim: dim < 0.999,
        };
    }

    return {
        sliderValue: hardwareAndSoftwareToSlider(0, dim, splitRatio, minBrightness),
        softwareDim: dim,
        clearSoftwareDim: false,
    };
}

/**
 * Steps a dual-zone slider value within its current zone.
 *
 * The hardware zone [splitRatio, 1.0] and the software zone
 * [0.0, splitRatio] are each treated as 100 integer percent, so `step`
 * is applied to the span of the zone actually being changed.  At the
 * split itself the direction decides the zone: increasing enters the
 * hardware zone, decreasing enters the software zone.
 *
 * `step` may be a single fraction or an object with separate
 * `{software, hardware}` fractions, so the two zones can be tuned
 * independently.
 *
 * Returns a new slider value in [0.0, 1.0].
 */
export function stepSliderValue(value, direction, splitRatio = 0.25, step = 0.05) {
    const s = Math.max(0.01, Math.min(0.9, splitRatio));
    const v = Math.max(0.0, Math.min(1.0, value));
    const steps = typeof step === 'number'
        ? { software: step, hardware: step }
        : { software: step?.software ?? 0.05, hardware: step?.hardware ?? 0.05 };
    const epsilon = 1e-9;
    const isHardwareZone = v > s + epsilon ||
        (Math.abs(v - s) <= epsilon && direction > 0);
    const stepFraction = isHardwareZone ? steps.hardware : steps.software;
    const percentStep = Math.max(1, Math.min(20, Math.round(stepFraction * 100)));
    const delta = direction < 0 ? -percentStep : percentStep;

    if (isHardwareZone) {
        const hardwarePercent = Math.round(((v - s) / (1.0 - s)) * 100);
        const nextPercent = Math.max(0, Math.min(100, hardwarePercent + delta));
        return s + (nextPercent / 100.0) * (1.0 - s);
    }

    const softwarePercent = Math.round((v / s) * 100);
    const nextPercent = Math.max(0, Math.min(100, softwarePercent + delta));
    return (nextPercent / 100.0) * s;
}

export const DualZoneSlider = GObject.registerClass(
class DualZoneSlider extends Slider {
    _init(value = 0, splitRatio = 0.25) {
        super._init(value);
        this._splitRatio = splitRatio;
        this.addMark(this._splitRatio);
    }

    get splitRatio() {
        return this._splitRatio;
    }

    set splitRatio(ratio) {
        const r = Math.max(0.05, Math.min(0.8, ratio));
        if (this._splitRatio === r)
            return;
        this.clearMarks();
        this._splitRatio = r;
        this.addMark(this._splitRatio);
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const themeNode = this.get_theme_node();
        const [width, height] = this.get_surface_size();
        const rtl = this.get_text_direction() === Clutter.TextDirection.RTL;

        const barLevelBorderRadius = Math.min(width, this._barLevelHeight) / 2;
        const fgColor = themeNode.get_foreground_color();
        const TAU = Math.PI * 2;

        let endX = 0;
        if (this._maxValue > 0) {
            let progress = this._value / this._maxValue;
            if (rtl)
                progress = 1 - progress;
            endX = barLevelBorderRadius + (width - 2 * barLevelBorderRadius) * progress;
        }

        let splitRatio = this._splitRatio / this._maxValue;
        if (rtl)
            splitRatio = 1 - splitRatio;
        const splitX = barLevelBorderRadius + (width - 2 * barLevelBorderRadius) * splitRatio;

        let xcArcStart = barLevelBorderRadius;
        let xcArcEnd = width - xcArcStart;
        if (rtl)
            [xcArcStart, xcArcEnd] = [xcArcEnd, xcArcStart];

        // 1. Background full track
        if (!rtl)
            cr.arc(xcArcEnd, height / 2, barLevelBorderRadius, TAU * (3 / 4), TAU * (1 / 4));
        else
            cr.arcNegative(xcArcEnd, height / 2, barLevelBorderRadius, TAU * (3 / 4), TAU * (1 / 4));
        cr.lineTo(endX, (height + this._barLevelHeight) / 2);
        cr.lineTo(endX, (height - this._barLevelHeight) / 2);
        cr.lineTo(xcArcEnd, (height - this._barLevelHeight) / 2);
        cr.setSourceColor(this._barLevelColor);
        cr.fill();

        // 2. Software dimming zone (accent tint)
        // Filled up to min(endX, splitX) when value > 0
        if (this._value > 0) {
            let softFillEnd = rtl ? Math.max(endX, splitX) : Math.min(endX, splitX);
            if (!rtl) {
                cr.arc(xcArcStart, height / 2, barLevelBorderRadius, TAU * (1 / 4), TAU * (3 / 4));
            } else {
                cr.arcNegative(xcArcStart, height / 2, barLevelBorderRadius, TAU * (1 / 4), TAU * (3 / 4));
            }
            cr.lineTo(softFillEnd, (height - this._barLevelHeight) / 2);
            cr.lineTo(softFillEnd, (height + this._barLevelHeight) / 2);
            cr.lineTo(xcArcStart, (height + this._barLevelHeight) / 2);

            // Accent fill at reduced opacity for the software dimming zone
            cr.setSourceColor(withAlpha(this._barLevelActiveColor, SOFTWARE_ZONE_ALPHA));
            cr.fill();
        }

        // 3. Hardware zone (active accent color)
        // Filled between splitX and endX when value > splitRatio
        if (this._value > this._splitRatio) {
            let hwStart = splitX;
            let hwEnd = endX;
            cr.moveTo(hwStart, (height - this._barLevelHeight) / 2);
            cr.lineTo(hwEnd, (height - this._barLevelHeight) / 2);
            cr.lineTo(hwEnd, (height + this._barLevelHeight) / 2);
            cr.lineTo(hwStart, (height + this._barLevelHeight) / 2);
            cr.lineTo(hwStart, (height - this._barLevelHeight) / 2);
            cr.setSourceColor(this._barLevelActiveColor);
            cr.fill();
        }

        // 4. End progress cap
        if (this._value > 0) {
            if (this._value <= this._splitRatio)
                cr.setSourceColor(withAlpha(this._barLevelActiveColor, SOFTWARE_ZONE_ALPHA));
            else
                cr.setSourceColor(this._barLevelActiveColor);
            if (!rtl) {
                cr.arc(endX, height / 2, barLevelBorderRadius, TAU * (3 / 4), TAU * (1 / 4));
                cr.lineTo(Math.floor(endX), (height + this._barLevelHeight) / 2);
                cr.lineTo(Math.floor(endX), (height - this._barLevelHeight) / 2);
            } else {
                cr.arcNegative(endX, height / 2, barLevelBorderRadius, TAU * (3 / 4), TAU * (1 / 4));
                cr.lineTo(Math.ceil(endX), (height + this._barLevelHeight) / 2);
                cr.lineTo(Math.ceil(endX), (height - this._barLevelHeight) / 2);
            }
            cr.lineTo(endX, (height - this._barLevelHeight) / 2);
            cr.fill();
        }

        // 5. Distinct divider notch at splitRatio boundary
        const notchWidth = 2.0;
        cr.rectangle(splitX - notchWidth / 2, (height - this._barLevelHeight) / 2, notchWidth, this._barLevelHeight);
        cr.setSourceColor(withAlpha(fgColor, NOTCH_ALPHA));
        cr.fill();

        // 6. Handle knob
        const handleY = height / 2;
        let handleX = this._handleRadius +
            (width - 2 * this._handleRadius) * this._value / this._maxValue;
        if (rtl)
            handleX = width - handleX;

        cr.setSourceColor(fgColor);
        cr.arc(handleX, handleY, this._handleRadius, 0, TAU);
        cr.fill();

        cr.$dispose();
    }
});
