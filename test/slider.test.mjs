import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    sliderToHardwareAndSoftware,
    hardwareAndSoftwareToSlider,
    DualZoneSlider,
} from '../src/slider.js';

describe('slider.js – sliderToHardwareAndSoftware', () => {
    const splitRatio = 0.25;
    const minBrightness = 0.1;

    test('at 1.0: full hardware brightness & contrast (100%), no software dimming (1.0)', () => {
        const res = sliderToHardwareAndSoftware(1.0, splitRatio, minBrightness);
        assert.equal(res.hardwareBrightness, 100);
        assert.equal(res.hardwareContrast, 100);
        assert.equal(res.softwareDim, 1.0);
    });

    test('at splitRatio (0.25): lowest hardware (0%), software dimming inactive (1.0)', () => {
        const res = sliderToHardwareAndSoftware(0.25, splitRatio, minBrightness);
        assert.equal(res.hardwareBrightness, 0);
        assert.equal(res.hardwareContrast, 0);
        assert.equal(res.softwareDim, 1.0);
    });

    test('at 0.0: hardware 0%, software dimming at minBrightness (0.1)', () => {
        const res = sliderToHardwareAndSoftware(0.0, splitRatio, minBrightness);
        assert.equal(res.hardwareBrightness, 0);
        assert.equal(res.hardwareContrast, 0);
        assert.equal(res.softwareDim, 0.1);
    });

    test('in software range (0.125): hardware 0%, software dim halfway (0.55)', () => {
        const res = sliderToHardwareAndSoftware(0.125, splitRatio, minBrightness);
        assert.equal(res.hardwareBrightness, 0);
        assert.equal(res.hardwareContrast, 0);
        assert.ok(Math.abs(res.softwareDim - 0.55) < 0.001);
    });

    test('in hardware range (0.625): hardware 50%, software dim 1.0', () => {
        const res = sliderToHardwareAndSoftware(0.625, splitRatio, minBrightness);
        assert.equal(res.hardwareBrightness, 50);
        assert.equal(res.hardwareContrast, 50);
        assert.equal(res.softwareDim, 1.0);
    });
});

describe('slider.js – hardwareAndSoftwareToSlider round-trip', () => {
    const splitRatio = 0.25;
    const minBrightness = 0.1;

    test('converts hardware 100% to 1.0', () => {
        const v = hardwareAndSoftwareToSlider(100, 1.0, splitRatio, minBrightness);
        assert.equal(v, 1.0);
    });

    test('converts hardware 0% to splitRatio (0.25)', () => {
        const v = hardwareAndSoftwareToSlider(0, 1.0, splitRatio, minBrightness);
        assert.equal(v, 0.25);
    });

    test('converts software dim 0.1 to 0.0', () => {
        const v = hardwareAndSoftwareToSlider(0, 0.1, splitRatio, minBrightness);
        assert.equal(v, 0.0);
    });

    test('round-trip hardware values map back accurately', () => {
        for (let hw = 0; hw <= 100; hw += 10) {
            const sliderVal = hardwareAndSoftwareToSlider(hw, 1.0, splitRatio, minBrightness);
            const back = sliderToHardwareAndSoftware(sliderVal, splitRatio, minBrightness);
            assert.equal(back.hardwareBrightness, hw);
            assert.equal(back.softwareDim, 1.0);
        }
    });
});

describe('slider.js – DualZoneSlider class', () => {
    test('initializes with splitRatio mark', () => {
        const slider = new DualZoneSlider(0.5, 0.3);
        assert.equal(slider.splitRatio, 0.3);
        assert.ok(slider._marks.has(0.3));
    });

    test('updating splitRatio updates marks', () => {
        const slider = new DualZoneSlider(0.5, 0.25);
        assert.ok(slider._marks.has(0.25));

        slider.splitRatio = 0.35;
        assert.equal(slider.splitRatio, 0.35);
        assert.ok(!slider._marks.has(0.25));
        assert.ok(slider._marks.has(0.35));
    });
});
