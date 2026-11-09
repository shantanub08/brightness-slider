import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    sliderToHardwareAndSoftware,
    hardwareAndSoftwareToSlider,
    externalHardwareToSlider,
    stepSliderValue,
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

describe('slider.js – externalHardwareToSlider', () => {
    const splitRatio = 0.25;
    const minBrightness = 0.1;

    test('hardware above zero moves the thumb to the hardware zone', () => {
        const state = externalHardwareToSlider(40, 1.0, splitRatio, minBrightness);
        assert.equal(sliderToHardwareAndSoftware(
            state.sliderValue, splitRatio, minBrightness).hardwareBrightness, 40);
        assert.equal(state.clearSoftwareDim, false);
    });

    test('hardware above zero cancels stored software dimming', () => {
        const state = externalHardwareToSlider(40, 0.5, splitRatio, minBrightness);
        assert.equal(state.softwareDim, 1.0);
        assert.equal(state.clearSoftwareDim, true);
        assert.equal(sliderToHardwareAndSoftware(
            state.sliderValue, splitRatio, minBrightness).softwareDim, 1.0);
    });

    test('hardware zero keeps stored software dimming in the lower zone', () => {
        const state = externalHardwareToSlider(0, 0.5, splitRatio, minBrightness);
        assert.equal(state.clearSoftwareDim, false);
        const res = sliderToHardwareAndSoftware(state.sliderValue, splitRatio, minBrightness);
        assert.equal(res.hardwareBrightness, 0);
        assert.ok(Math.abs(res.softwareDim - 0.5) < 0.001);
    });

    test('hardware zero with no dimming sits exactly on the split', () => {
        const state = externalHardwareToSlider(0, 1.0, splitRatio, minBrightness);
        assert.equal(state.sliderValue, splitRatio);
        assert.equal(state.clearSoftwareDim, false);
    });

    test('rounds a non-integer hardware percentage', () => {
        const state = externalHardwareToSlider(39.6, 1.0, splitRatio, minBrightness);
        assert.equal(sliderToHardwareAndSoftware(
            state.sliderValue, splitRatio, minBrightness).hardwareBrightness, 40);
    });
});

describe('slider.js – stepSliderValue', () => {
    const splitRatio = 0.25;

    test('steps 5% of the hardware zone per press (5 hardware points)', () => {
        const start = hardwareAndSoftwareToSlider(50, 1.0, splitRatio, 0.1);
        const up = stepSliderValue(start, +1, splitRatio, 0.05);
        const res = sliderToHardwareAndSoftware(up, splitRatio, 0.1);
        assert.equal(res.hardwareBrightness, 55);
        assert.equal(res.softwareDim, 1.0);
    });

    test('steps 5% of the software zone per press', () => {
        const start = hardwareAndSoftwareToSlider(0, 1.0, splitRatio, 0.1);
        const down = stepSliderValue(start, -1, splitRatio, 0.05);
        const res = sliderToHardwareAndSoftware(down, splitRatio, 0.1);
        assert.equal(res.hardwareBrightness, 0);
        assert.ok(Math.abs(res.softwareDim - 0.955) < 0.001);
    });

    test('at the split, up enters hardware and down enters software', () => {
        const split = hardwareAndSoftwareToSlider(0, 1.0, splitRatio, 0.1);
        assert.equal(sliderToHardwareAndSoftware(
            stepSliderValue(split, +1, splitRatio, 0.05), splitRatio, 0.1
        ).hardwareBrightness, 5);
        assert.ok(sliderToHardwareAndSoftware(
            stepSliderValue(split, -1, splitRatio, 0.05), splitRatio, 0.1
        ).softwareDim < 1.0);
    });

    test('20 presses of 5% traverse each zone', () => {
        const split = hardwareAndSoftwareToSlider(0, 1.0, splitRatio, 0.1);
        let value = split;
        for (let i = 0; i < 20; i++)
            value = stepSliderValue(value, +1, splitRatio, 0.05);
        assert.equal(value, 1.0);

        value = split;
        for (let i = 0; i < 20; i++)
            value = stepSliderValue(value, -1, splitRatio, 0.05);
        assert.equal(value, 0.0);
    });

    test('clamps at both ends', () => {
        assert.equal(stepSliderValue(1.0, +1, splitRatio, 0.05), 1.0);
        assert.equal(stepSliderValue(0.0, -1, splitRatio, 0.05), 0.0);
    });

    test('a 1% software step is still a real change with a tiny split', () => {
        const start = hardwareAndSoftwareToSlider(0, 1.0, 0.05, 0.1);
        const down = stepSliderValue(start, -1, 0.05, 0.01);
        assert.ok(start - down > 0.0004);
    });

    test('honours integer step percentages and clamps them to 1–20%', () => {
        const split = hardwareAndSoftwareToSlider(0, 1.0, splitRatio, 0.1);
        const res = sliderToHardwareAndSoftware(
            stepSliderValue(split, +1, splitRatio, 0.5), splitRatio, 0.1);
        assert.equal(res.hardwareBrightness, 20);

        const tiny = sliderToHardwareAndSoftware(
            stepSliderValue(split, +1, splitRatio, 0.001), splitRatio, 0.1);
        assert.equal(tiny.hardwareBrightness, 1);
    });

    test('uses the software step in the software zone', () => {
        const steps = { software: 0.10, hardware: 0.05 };
        const start = hardwareAndSoftwareToSlider(0, 1.0, splitRatio, 0.1);
        const down = stepSliderValue(start, -1, splitRatio, steps);
        const res = sliderToHardwareAndSoftware(down, splitRatio, 0.1);
        assert.equal(res.hardwareBrightness, 0);
        assert.ok(Math.abs(res.softwareDim - 0.91) < 0.001);
    });

    test('uses the hardware step in the hardware zone', () => {
        const steps = { software: 0.10, hardware: 0.20 };
        const start = hardwareAndSoftwareToSlider(50, 1.0, splitRatio, 0.1);
        const up = stepSliderValue(start, +1, splitRatio, steps);
        const res = sliderToHardwareAndSoftware(up, splitRatio, 0.1);
        assert.equal(res.hardwareBrightness, 70);
    });

    test('at the split, each direction uses its own step size', () => {
        const steps = { software: 0.20, hardware: 0.05 };
        const split = hardwareAndSoftwareToSlider(0, 1.0, splitRatio, 0.1);

        const up = sliderToHardwareAndSoftware(
            stepSliderValue(split, +1, splitRatio, steps), splitRatio, 0.1);
        assert.equal(up.hardwareBrightness, 5);

        const down = sliderToHardwareAndSoftware(
            stepSliderValue(split, -1, splitRatio, steps), splitRatio, 0.1);
        assert.ok(Math.abs(down.softwareDim - 0.82) < 0.001);
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
