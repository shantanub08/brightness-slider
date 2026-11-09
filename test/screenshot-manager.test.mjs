import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// ScreenshotManager hook plumbing.  Kept separately from the removed
// shader-lifecycle tests: the dimming implementation no longer uses
// Clutter effects, but the screenshot patch/unpatch contract still matters.

import ShellMock from './mocks/shell.mjs';
import { ScreenshotManager } from '../src/extension.js';

const logger = { log() {}, log_debug() {} };

describe('ScreenshotManager', () => {
    test('pre/post hooks fire around patched screenshot calls; disable() restores', async () => {
        const proto = ShellMock.Screenshot.prototype;
        const originals = { screenshot: proto.screenshot, screenshot_area: proto.screenshot_area };

        const order = [];
        const sm = new ScreenshotManager(logger);
        sm.setPreCaptureHook(() => order.push('pre'));
        sm.setPostCaptureHook(() => order.push('post'));
        sm.enable();

        assert.notEqual(proto.screenshot, originals.screenshot, 'screenshot patched');
        await proto.screenshot.call({});
        assert.deepEqual(order, ['pre', 'post']);

        sm.disable();
        assert.equal(proto.screenshot, originals.screenshot, 'screenshot restored');
        assert.equal(proto.screenshot_area, originals.screenshot_area, 'screenshot_area restored');
    });
});
