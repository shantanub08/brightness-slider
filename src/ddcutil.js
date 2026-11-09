// brightness-slider - DDC/CI hardware display communication via ddcutil
// Copyright (C) 2026 Shantanu Baviskar (shantanub08 on Github)
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/**
 * Parses the stdout output of `ddcutil detect --terse` into an array of display objects.
 *
 * Example output:
 * Display 1
 *    I2C bus:          /dev/i2c-5
 *    DRM connector:    card1-DP-2
 *    drm_connector_id: 840
 *    Monitor:          MSI:MAG321UP OLED:
 */
export function parseDdcDetectOutput(stdout) {
    if (!stdout || typeof stdout !== 'string')
        return [];

    const displays = [];
    const sections = stdout.split(/(?=^Display\s+\d+)/m);

    for (const section of sections) {
        const displayMatch = section.match(/^Display\s+(\d+)/m);
        if (!displayMatch)
            continue;

        const displayNum = parseInt(displayMatch[1], 10);

        const busMatch = section.match(/I2C bus:\s*(?:\/dev\/i2c-)?(\d+)/m);
        if (!busMatch)
            continue;
        const bus = parseInt(busMatch[1], 10);

        const drmMatch = section.match(/DRM connector:\s*(?:card\d+-)?([^\s\n\r]+)/m);
        const drmConnector = drmMatch ? drmMatch[1].trim() : '';

        const monitorMatch = section.match(/Monitor:\s*([^:\n\r]*):([^:\n\r]*):?([^\n\r]*)/m);
        let mfg = '';
        let model = '';
        let serial = '';
        if (monitorMatch) {
            mfg = monitorMatch[1].trim();
            model = monitorMatch[2].trim();
            serial = monitorMatch[3].trim();
        }

        let name = '';
        if (mfg && model)
            name = `${mfg} ${model}`;
        else if (model)
            name = model;
        else if (drmConnector)
            name = `Display on ${drmConnector}`;
        else
            name = `Display ${displayNum}`;

        displays.push({
            displayNum,
            bus,
            drmConnector,
            mfg,
            model,
            serial,
            name,
        });
    }

    return displays;
}

/**
 * Parses the stdout output of `ddcutil getvcp 10 12 --terse`.
 * Output format:
 * VCP 10 C <cur> <max>
 * VCP 12 C <cur> <max>
 */
export function parseDdcGetVcpOutput(stdout) {
    const result = {
        brightness: null,
        contrast: null,
    };
    if (!stdout || typeof stdout !== 'string')
        return result;

    const lines = stdout.split('\n');
    for (const line of lines) {
        const match = line.trim().match(/^VCP\s+(10|12)\s+[A-Z]+\s+(\d+)\s+(\d+)/);
        if (match) {
            const feature = match[1];
            const curVal = parseInt(match[2], 10);
            const maxVal = parseInt(match[3], 10);
            const percent = maxVal > 0 ? Math.round((curVal / maxVal) * 100) : curVal;

            if (feature === '10')
                result.brightness = percent;
            else if (feature === '12')
                result.contrast = percent;
        }
    }

    return result;
}

/**
 * Controller class that manages asynchronous ddcutil execution with debouncing and queueing.
 */
export class DdcController {
    constructor(logger = null) {
        this._logger = logger;
        this._busQueues = new Map(); // bus -> { target, inFlight, timerId, lastSent }
    }

    _log(msg) {
        if (this._logger?.log_debug)
            this._logger.log_debug(`[DDC] ${msg}`);
    }

    /**
     * Executes a CLI command asynchronously and returns stdout string.
     */
    async _execAsync(argv) {
        return new Promise((resolve, reject) => {
            try {
                const proc = Gio.Subprocess.new(
                    argv,
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
                );
                proc.communicate_utf8_async(null, null, (subprocess, res) => {
                    try {
                        const [ok, stdout, stderr] = subprocess.communicate_utf8_finish(res);
                        if (!subprocess.get_successful()) {
                            const exitCode = subprocess.get_exit_status();
                            reject(new Error(`Command ${argv.join(' ')} failed (exit ${exitCode}): ${stderr || stdout}`));
                        } else {
                            resolve(stdout);
                        }
                    } catch (e) {
                        reject(e);
                    }
                });
            } catch (e) {
                reject(e);
            }
        });
    }

    /**
     * Detects external DDC/CI monitors connected to the system.
     */
    async detectDisplays() {
        try {
            this._log('Detecting DDC/CI monitors via ddcutil...');
            const stdout = await this._execAsync(['ddcutil', 'detect', '--terse']);
            const displays = parseDdcDetectOutput(stdout);
            this._log(`Detected ${displays.length} DDC/CI display(s): ${displays.map(d => `${d.name} (bus ${d.bus})`).join(', ')}`);
            return displays;
        } catch (e) {
            this._log(`DDC detection failed: ${e.message}`);
            return [];
        }
    }

    /**
     * Queries current hardware brightness and contrast for a given I2C bus.
     */
    async getBrightnessAndContrast(bus) {
        try {
            this._log(`Reading brightness and contrast on bus ${bus}...`);
            const stdout = await this._execAsync([
                'ddcutil', 'getvcp', '10', '12', '--bus', String(bus), '--terse',
            ]);
            const values = parseDdcGetVcpOutput(stdout);
            this._log(`Read bus ${bus}: brightness=${values.brightness}, contrast=${values.contrast}`);
            return values;
        } catch (e) {
            this._log(`Failed reading brightness/contrast on bus ${bus}: ${e.message}`);
            return { brightness: null, contrast: null };
        }
    }

    /**
     * Sets hardware brightness and contrast on the specified I2C bus.
     * Uses a coalescing queue with throttling to prevent I2C bus congestion.
     */
    setBrightnessAndContrast(bus, brightness, contrast) {
        const b = Math.max(0, Math.min(100, Math.round(brightness)));
        const c = Math.max(0, Math.min(100, Math.round(contrast)));

        let queue = this._busQueues.get(bus);
        if (!queue) {
            queue = {
                target: null,
                inFlight: false,
                timerId: 0,
                lastSent: null,
                lastWriteTime: 0,
            };
            this._busQueues.set(bus, queue);
        }

        queue.target = { brightness: b, contrast: c };

        if (!queue.inFlight && !queue.timerId) {
            // Debounce writes slightly (40ms) to batch rapid slider dragging
            queue.timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => {
                queue.timerId = 0;
                this._processQueue(bus);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    /**
     * Whether a bus has a queued or in-flight write, or was written within
     * `settleMs`.  Readers use this to avoid sampling a value the monitor is
     * still applying.
     */
    isBusBusy(bus, settleMs = 0) {
        const queue = this._busQueues.get(bus);
        if (!queue)
            return false;
        if (queue.inFlight || queue.timerId)
            return true;
        if (settleMs > 0 && queue.lastWriteTime) {
            const elapsedUs = GLib.get_monotonic_time() - queue.lastWriteTime;
            if (elapsedUs < settleMs * 1000)
                return true;
        }
        return false;
    }

    async _processQueue(bus) {
        const queue = this._busQueues.get(bus);
        if (!queue || queue.inFlight || !queue.target)
            return;

        const { brightness, contrast } = queue.target;
        // Skip if target hasn't changed since last completed write
        if (queue.lastSent &&
            queue.lastSent.brightness === brightness &&
            queue.lastSent.contrast === contrast) {
            return;
        }

        queue.inFlight = true;
        this._log(`Writing bus ${bus}: brightness=${brightness}, contrast=${contrast}`);

        try {
            await this._execAsync([
                'ddcutil', 'setvcp',
                '10', String(brightness),
                '12', String(contrast),
                '--bus', String(bus),
                '--noverify',
            ]);
            queue.lastSent = { brightness, contrast };
        } catch (e) {
            this._log(`Error setting DDC values on bus ${bus}: ${e.message}`);
        } finally {
            queue.inFlight = false;
            queue.lastWriteTime = GLib.get_monotonic_time();
            // If the target changed while the write was in flight, dispatch the latest values
            if (queue.target &&
                (!queue.lastSent ||
                 queue.target.brightness !== queue.lastSent.brightness ||
                 queue.target.contrast !== queue.lastSent.contrast)) {
                this._processQueue(bus);
            }
        }
    }

    destroy() {
        for (const queue of this._busQueues.values()) {
            if (queue.timerId) {
                GLib.source_remove(queue.timerId);
                queue.timerId = 0;
            }
        }
        this._busQueues.clear();
    }
}
