import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// Test the MouseSpriteContent texture freeze bug (issue #52)
// When the same Cogl texture object is set again, the early-return skips
// invalidate(), so the rendered content never updates.

import Meta from './mocks/meta.mjs';
import { MouseSpriteContent } from '../src/cursor.js';

// ── Reproduce the bug with a minimal Content implementation ──

class MouseSpriteContent_BUGGY {
    constructor() {
        this._texture = null;
        this.invalidateCalls = 0;
        this.invalidateSizeCalls = 0;
    }

    get texture() { return this._texture; }

    set texture(coglTexture) {
        if (this._texture === coglTexture)
            return; // BUG: skips invalidate() when same object is reused

        let oldTexture = this._texture;
        this._texture = coglTexture;
        this.invalidateCalls++;

        if (!oldTexture || !coglTexture ||
            oldTexture.width !== coglTexture.width ||
            oldTexture.height !== coglTexture.height) {
            this.invalidateSizeCalls++;
        }
    }
}

class MouseSpriteContent_FIXED {
    constructor() {
        this._texture = null;
        this.invalidateCalls = 0;
        this.invalidateSizeCalls = 0;
    }

    get texture() { return this._texture; }

    set texture(coglTexture) {
        // FIX: always store and invalidate, even if the object reference is the same,
        // because GNOME may update the pixel data in-place.
        let oldTexture = this._texture;
        this._texture = coglTexture;
        this.invalidateCalls++;

        if (!oldTexture || !coglTexture ||
            oldTexture.width !== coglTexture.width ||
            oldTexture.height !== coglTexture.height) {
            this.invalidateSizeCalls++;
        }
    }
}

function makeTexture(width = 32, height = 32) {
    // Simulate a Cogl texture object (same reference, contents can change)
    return { width, height, _pixelData: new Uint8Array(width * height * 4) };
}

describe('cursor.js – MouseSpriteContent texture freeze (issue #52)', () => {
    test('BUG: setting the same texture object twice does not invalidate', () => {
        const content = new MouseSpriteContent_BUGGY();
        const texture = makeTexture();

        content.texture = texture;
        assert.equal(content.invalidateCalls, 1, 'first set invalidates');

        // Simulate cursor shape update: GNOME modifies pixels in the same object
        texture._pixelData[0] = 255; // cursor changed!
        content.texture = texture; // same object reference

        assert.equal(content.invalidateCalls, 1, 'BUG: second set did NOT invalidate');
    });

    test('FIXED: setting the same texture object always invalidates', () => {
        const content = new MouseSpriteContent_FIXED();
        const texture = makeTexture();

        content.texture = texture;
        assert.equal(content.invalidateCalls, 1);

        texture._pixelData[0] = 255;
        content.texture = texture;

        assert.equal(content.invalidateCalls, 2, 'FIXED: second set also invalidates');
    });

    test('null→texture transition invalidates in both versions', () => {
        const buggy = new MouseSpriteContent_BUGGY();
        const fixed = new MouseSpriteContent_FIXED();
        const texture = makeTexture();

        // null→null is a no-op in the buggy version (same reference)
        buggy.texture = null;
        assert.equal(buggy.invalidateCalls, 0);
        buggy.texture = texture;
        assert.equal(buggy.invalidateCalls, 1); // null→texture: different ref, invalidates

        // In the fixed version, every set() calls invalidate (no early return)
        fixed.texture = null;  // null → null: always calls invalidate now
        assert.equal(fixed.invalidateCalls, 1);
        fixed.texture = texture;
        assert.equal(fixed.invalidateCalls, 2);
    });

    test('changing texture size triggers invalidate_size', () => {
        const content = new MouseSpriteContent_FIXED();
        const small = makeTexture(16, 16);
        const large = makeTexture(32, 32);

        content.texture = small;
        assert.equal(content.invalidateSizeCalls, 1); // null→small: size changed

        content.texture = large;
        assert.equal(content.invalidateSizeCalls, 2); // small→large: size changed

        content.texture = large; // same size, same ref
        assert.equal(content.invalidateSizeCalls, 2); // no size change
    });
});

// ── MouseSpriteContent scale normalization ──────────────────────────────────

function makeCoglTexture(width, height) {
    return {
        get_width: () => width,
        get_height: () => height,
    };
}

function makeContent() {
    const content = new MouseSpriteContent();
    content.invalidates = 0;
    content.invalidatesSize = 0;
    content.invalidate = () => content.invalidates++;
    content.invalidate_size = () => content.invalidatesSize++;
    return content;
}

describe('cursor.js – sprite scale (theme vs client cursors)', () => {
    test('theme cursor at 2x: texture is divided by the guessed scale', () => {
        const content = makeContent();
        content.trackerScale = 1;
        content.texture = makeCoglTexture(96, 96);

        assert.equal(content.spriteScale, 2);
        assert.deepEqual(content.vfunc_get_preferred_size(), [true, 48, 48]);
    });

    test('theme cursor at 1x: texture is used as-is', () => {
        const content = makeContent();
        content.trackerScale = 1;
        content.texture = makeCoglTexture(48, 48);

        assert.equal(content.spriteScale, 1);
        assert.deepEqual(content.vfunc_get_preferred_size(), [true, 48, 48]);
    });

    test('client cursor at 2x: get_scale() is authoritative', () => {
        const content = makeContent();
        content.trackerScale = 0.5;
        content.texture = makeCoglTexture(64, 64);

        assert.equal(content.spriteScale, 2);
        assert.deepEqual(content.vfunc_get_preferred_size(), [true, 32, 32]);
    });

    test('client cursor at 1x: get_scale() 1 keeps the texture size', () => {
        const content = makeContent();
        content.trackerScale = 1;
        content.texture = makeCoglTexture(32, 32);

        assert.equal(content.spriteScale, 1);
        assert.deepEqual(content.vfunc_get_preferred_size(), [true, 32, 32]);
    });

    test('same-size texture with a new tracker scale is recomputed', () => {
        const content = makeContent();
        const texture = makeCoglTexture(64, 64);
        content.texture = texture;
        assert.equal(content.spriteScale, 1);
        assert.equal(content.invalidatesSize, 1);

        content.trackerScale = 0.5;
        assert.equal(content.spriteScale, 2);
        assert.equal(content.invalidatesSize, 2);
        assert.deepEqual(content.vfunc_get_preferred_size(), [true, 32, 32]);
    });

    test('invalid cursor size does not produce Infinity/NaN', () => {
        const saved = Meta.prefs_get_cursor_size;
        Meta.prefs_get_cursor_size = () => 0;
        try {
            const content = makeContent();
            content.trackerScale = 1;
            content.texture = makeCoglTexture(96, 96);

            assert.equal(content.spriteScale, 1);
            assert.deepEqual(content.vfunc_get_preferred_size(), [true, 96, 96]);
        } finally {
            Meta.prefs_get_cursor_size = saved;
        }
    });
});
