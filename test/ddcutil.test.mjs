import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseDdcDetectOutput, parseDdcGetVcpOutput, DdcController } from '../src/ddcutil.js';

describe('ddcutil.js – parseDdcDetectOutput', () => {
    test('parses multiple displays and ignores invalid displays', () => {
        const sampleOutput = `
Failed to find connector name for /dev/i2c-2.
Invalid display
   I2C bus:          /dev/i2c-2
   drm_connector_id: 0
   Monitor:          BBC:HDP-V104:demoset-1

Display 1
   I2C bus:          /dev/i2c-5
   DRM connector:    card1-DP-2
   drm_connector_id: 840
   Monitor:          MSI:MAG321UP OLED:

Display 2
   I2C bus:          /dev/i2c-6
   DRM connector:    card1-HDMI-A-1
   drm_connector_id: 841
   Monitor:          Dell:U2720Q:ABC123
`;
        const displays = parseDdcDetectOutput(sampleOutput);
        assert.equal(displays.length, 2);

        assert.equal(displays[0].displayNum, 1);
        assert.equal(displays[0].bus, 5);
        assert.equal(displays[0].drmConnector, 'DP-2');
        assert.equal(displays[0].mfg, 'MSI');
        assert.equal(displays[0].model, 'MAG321UP OLED');
        assert.equal(displays[0].name, 'MSI MAG321UP OLED');

        assert.equal(displays[1].displayNum, 2);
        assert.equal(displays[1].bus, 6);
        assert.equal(displays[1].drmConnector, 'HDMI-A-1');
        assert.equal(displays[1].mfg, 'Dell');
        assert.equal(displays[1].model, 'U2720Q');
        assert.equal(displays[1].serial, 'ABC123');
        assert.equal(displays[1].name, 'Dell U2720Q');
    });

    test('handles empty or malformed output gracefully', () => {
        assert.deepEqual(parseDdcDetectOutput(''), []);
        assert.deepEqual(parseDdcDetectOutput(null), []);
        assert.deepEqual(parseDdcDetectOutput('No monitors found'), []);
    });
});

describe('ddcutil.js – parseDdcGetVcpOutput', () => {
    test('parses both brightness (VCP 10) and contrast (VCP 12)', () => {
        const sampleOutput = `
VCP 10 C 65 100
VCP 12 C 50 100
`;
        const res = parseDdcGetVcpOutput(sampleOutput);
        assert.equal(res.brightness, 65);
        assert.equal(res.contrast, 50);
    });

    test('calculates correct percentages when max is non-100', () => {
        const sampleOutput = `
VCP 10 C 128 255
VCP 12 C 0 255
`;
        const res = parseDdcGetVcpOutput(sampleOutput);
        assert.equal(res.brightness, 50);
        assert.equal(res.contrast, 0);
    });

    test('returns null for missing features', () => {
        const sampleOutput = `
VCP 10 C 80 100
`;
        const res = parseDdcGetVcpOutput(sampleOutput);
        assert.equal(res.brightness, 80);
        assert.equal(res.contrast, null);
    });
});

import GLib, { _timeouts } from 'gi://GLib';

describe('ddcutil.js – DdcController queueing & debouncing', () => {
    test('queues and coalesces rapid updates', async () => {
        const written = [];
        const controller = new DdcController();
        // Override _execAsync to collect calls
        controller._execAsync = async (argv) => {
            written.push(argv);
            return '';
        };

        controller.setBrightnessAndContrast(5, 10, 10);
        controller.setBrightnessAndContrast(5, 20, 20);
        controller.setBrightnessAndContrast(5, 30, 30);

        // Fire any pending GLib timeout
        const timerIds = Array.from(_timeouts.keys());
        for (const id of timerIds) {
            GLib._firePendingTimeout(id);
        }

        // Wait microtasks for async execution
        await new Promise(r => setImmediate(r));

        assert.ok(written.length >= 1);
        const last = written[written.length - 1];
        assert.deepEqual(last, [
            'ddcutil', 'setvcp',
            '10', '30',
            '12', '30',
            '--bus', '5',
            '--noverify'
        ]);

        controller.destroy();
    });

    test('isBusBusy tracks queued, in-flight and settling writes', async () => {
        const controller = new DdcController();
        let resolveExec;
        controller._execAsync = () => new Promise(resolve => {
            resolveExec = resolve;
        });

        controller.setBrightnessAndContrast(5, 20, 20);
        const queue = controller._busQueues.get(5);

        assert.equal(controller.isBusBusy(5), true, 'debounce timer is pending');
        assert.equal(controller.isBusBusy(6), false, 'unused bus is idle');

        GLib._firePendingTimeout(queue.timerId);
        assert.equal(controller.isBusBusy(5), true, 'write is in flight');

        resolveExec('');
        await new Promise(r => setImmediate(r));

        assert.equal(controller.isBusBusy(5), false, 'write finished');
        assert.equal(controller.isBusBusy(5, 400), true,
            'settle window still suppresses reads');
        assert.equal(queue.lastSent.brightness, 20);

        controller.destroy();
    });
});

