const BaseAccessory = require('./BaseAccessory');
const http = require('http');
const maxWledBrightness = 128;

// If true, when the Tuya/wall switch turns ON, restore the last known WLED brightness.
const rememberWledBrightness = true;

// WLED often takes a moment to boot after power is applied.
// During this warmup window we queue brightness commands instead of sending them immediately.
const wledPowerOnDelayMs = 3000;

class SimpleDimmerAccessory extends BaseAccessory {
    static getCategory(Categories) {
        return Categories.LIGHTBULB;
    }

    constructor(...props) {
        super(...props);
    }

    _registerPlatformAccessory() {
        const {Service} = this.hap;

        this.accessory.addService(Service.Lightbulb, this.device.context.name);

        super._registerPlatformAccessory();
    }

    _registerCharacteristics(dps) {
        const {Service, Characteristic} = this.hap;
        const service = this.accessory.getService(Service.Lightbulb);
        this._checkServiceName(service, this.device.context.name);

        this.dpPower = this._getCustomDP(this.device.context.dpPower) || '1';
        this.dpBrightness = this._getCustomDP(this.device.context.dpBrightness) || this._getCustomDP(this.device.context.dp) || '2';

        // WLED warmup / command queue state
        this._wledReadyAt = 0;
        this._pendingWledBri = null;
        this._pendingWledTimer = null;

        // Allow a couple of different spellings just in case
        const syncCfg =
            this.device.context.syncBrightnessToWled ||
            this.device.context.syncBrightnessToWLED ||
            null;
        this.syncBrightnessToWled = (syncCfg && ('' + syncCfg).trim()) || null;

        this.log.info(
            '[WLED Sync] %s: syncBrightnessToWled=%s',
            this.device.context.name,
            this.syncBrightnessToWled || 'disabled'
        );

        const characteristicOn = service.getCharacteristic(Characteristic.On)
            .updateValue(dps[this.dpPower])
            .on('get', this.getState.bind(this, this.dpPower))
            .on('set', this.setState.bind(this, this.dpPower));

        const characteristicBrightness = service.getCharacteristic(Characteristic.Brightness);

        if (this.syncBrightnessToWled) {
            // Start with 100% locally while we fetch the actual WLED brightness
            characteristicBrightness
                .updateValue(100)
                .on('get', this.getBrightness.bind(this))
                .on('set', this.setBrightness.bind(this));

            // Force Tuya dimmer brightness to 100% on startup
            const maxTuyaBrightness = this.convertBrightnessFromHomeKitToTuya(100);
            if (dps[this.dpBrightness] !== maxTuyaBrightness) {
                this.log.info(
                    '[WLED Sync] %s: setting Tuya brightness DP%s to max (%s)',
                    this.device.context.name,
                    this.dpBrightness,
                    maxTuyaBrightness
                );
                this.setState(this.dpBrightness, maxTuyaBrightness, () => {});
            }

            // Only talk to WLED on startup if the dimmer reports power ON
            if (dps[this.dpPower]) {
                this._getWledBrightness((err, bri) => {
                    if (err || !isFinite(bri)) {
                        this.log.error(
                            '[WLED Sync] %s: initial read failed (err=%s)',
                            this.device.context.name,
                            err
                        );
                        return;
                    }
                    const value = Math.max(0, Math.min(100, Math.round((bri / maxWledBrightness) * 100)));
                    this.log.info(
                        '[WLED Sync] %s: initial WLED bri=%s -> HomeKit %s%%',
                        this.device.context.name,
                        bri,
                        value
                    );
                    characteristicBrightness.updateValue(value);
                });
            } else {
                this.log.info(
                    '[WLED Sync] %s: initial WLED sync skipped because power is OFF',
                    this.device.context.name
                );
            }
        } else {
            const initial = this.convertBrightnessFromTuyaToHomeKit(dps[this.dpBrightness]);
            this.log.debug(
                '%s: initial Tuya brightness DP%s=%s -> HomeKit %s%%',
                this.device.context.name,
                this.dpBrightness,
                dps[this.dpBrightness],
                initial
            );
            characteristicBrightness
                .updateValue(initial)
                .on('get', this.getBrightness.bind(this))
                .on('set', this.setBrightness.bind(this));
        }

        this.device.on('change', changes => {
            if (changes.hasOwnProperty(this.dpPower) && characteristicOn.value !== changes[this.dpPower]) {
                const oldPower = characteristicOn.value;
                const newPower = changes[this.dpPower];
                characteristicOn.updateValue(newPower);

                // Cancel any queued WLED work when turning OFF
                if (this.syncBrightnessToWled && !newPower) {
                    if (this._pendingWledTimer) {
                        clearTimeout(this._pendingWledTimer);
                        this._pendingWledTimer = null;
                    }
                    this._pendingWledBri = null;
                }

                // When turning ON, set a warmup window and restore last brightness after WLED is likely ready
                if (this.syncBrightnessToWled && !oldPower && newPower) {
                    this._wledReadyAt = Date.now() + wledPowerOnDelayMs;
                    this.log.info(
                        '[WLED Sync] %s: power ON -> delaying WLED calls for %sms',
                        this.device.context.name,
                        wledPowerOnDelayMs
                    );

                    if (rememberWledBrightness && this._lastWledPercent != null) {
                        const targetBri = Math.max(
                            0,
                            Math.min(
                                maxWledBrightness,
                                Math.round((this._lastWledPercent / 100) * maxWledBrightness)
                            )
                        );
                        this._queueWledBrightness(targetBri, 'restore after power ON');
                    }
                }
            }

            // When WLED sync is enabled, also mirror manual Tuya (Smart Life) brightness changes to WLED
            if (this.syncBrightnessToWled && changes.hasOwnProperty(this.dpBrightness)) {
                const isOn = changes.hasOwnProperty(this.dpPower)
                    ? !!changes[this.dpPower]
                    : !!this.device.state[this.dpPower];

                // If lamp is OFF, don't talk to WLED – nothing to dim
                if (!isOn) {
                    this.log.info(
                        '[WLED Sync] %s: Tuya DP%s brightness change while OFF -> ignoring for WLED',
                        this.device.context.name,
                        this.dpBrightness
                    );
                    return;
                }

                const tuyaValue = changes[this.dpBrightness];
                const maxTuyaBrightness = this.convertBrightnessFromHomeKitToTuya(100);

                // Ignore the "forced back to 100%" update to avoid feedback loops
                if (tuyaValue === maxTuyaBrightness) {
                    this.log.info(
                        '[WLED Sync] %s: Tuya DP%s reported max brightness (%s), ignoring',
                        this.device.context.name,
                        this.dpBrightness,
                        tuyaValue
                    );
                    return;
                }

                const percent = this.convertBrightnessFromTuyaToHomeKit(tuyaValue);
                const bri = Math.max(0, Math.min(maxWledBrightness, Math.round((percent / 100) * maxWledBrightness)));

                this.log.info(
                    '[WLED Sync] %s: Tuya DP%s changed to %s -> %s%% -> WLED bri=%s',
                    this.device.context.name,
                    this.dpBrightness,
                    tuyaValue,
                    percent,
                    bri
                );

                // Update WLED to match the Tuya app change (or queue it if WLED is warming up)
                this._queueWledBrightness(bri, 'Tuya brightness change', err => {
                    if (err) {
                        this.log.error(
                            '[WLED Sync] %s: failed to push Tuya-origin brightness to WLED (err=%s)',
                            this.device.context.name,
                            err
                        );
                        return;
                    }

                    // Reflect that brightness back into HomeKit
                    characteristicBrightness.updateValue(percent);

                    // After a short delay, force Tuya brightness back to 100% so it stops dimming the strip
                    if (this._wledForceMaxTimeout) {
                        clearTimeout(this._wledForceMaxTimeout);
                    }
                    this._wledForceMaxTimeout = setTimeout(() => {
                        this.log.info(
                            '[WLED Sync] %s: forcing Tuya DP%s back to max (%s) after Tuya app change',
                            this.device.context.name,
                            this.dpBrightness,
                            maxTuyaBrightness
                        );
                        this.setState(this.dpBrightness, maxTuyaBrightness, () => {});
                    }, 5000);
                });
            } else if (!this.syncBrightnessToWled && changes.hasOwnProperty(this.dpBrightness) && this.convertBrightnessFromHomeKitToTuya(characteristicBrightness.value) !== changes[this.dpBrightness]) {
                characteristicBrightness.updateValue(this.convertBrightnessFromTuyaToHomeKit(changes[this.dpBrightness]));
            }
        });
    }

    getBrightness(callback) {
        if (this.syncBrightnessToWled) {
            const isOn = !!this.device.state[this.dpPower];

            // If lamp is OFF, never query WLED – just report 0.
            if (!isOn) {
                this.log.info(
                    '[WLED Sync] %s: getBrightness() while OFF -> returning 0 without querying WLED',
                    this.device.context.name
                );
                return callback(null, 0);
            }

            // If we already have a cached WLED brightness, return it immediately to avoid slow HTTP gets.
            if (this._lastWledPercent != null) {
                this.log.info(
                    '[WLED Sync] %s: getBrightness() -> using cached %s%%',
                    this.device.context.name,
                    this._lastWledPercent
                );
                return callback(null, this._lastWledPercent);
            }

            // If we're within the warmup window after power ON, don't query WLED yet.
            if (this._wledReadyAt && Date.now() < this._wledReadyAt) {
                this.log.info(
                    '[WLED Sync] %s: getBrightness() during warmup -> returning 100%% without querying WLED',
                    this.device.context.name
                );
                return callback(null, 100);
            }

            this.log.info(
                '[WLED Sync] %s: getBrightness() -> querying WLED',
                this.device.context.name
            );
            this._getWledBrightness((err, bri) => {
                if (err || !isFinite(bri)) {
                    this.log.error(
                        '[WLED Sync] %s: getBrightness WLED error=%s',
                        this.device.context.name,
                        err
                    );
                    return callback(err || true);
                }
                const value = Math.max(0, Math.min(100, Math.round((bri / maxWledBrightness) * 100)));
                this.log.info(
                    '[WLED Sync] %s: getBrightness WLED bri=%s -> %s%%',
                    this.device.context.name,
                    bri,
                    value
                );
                this._lastWledPercent = value;
                callback(null, value);
            });
        } else {
            callback(null, this.convertBrightnessFromTuyaToHomeKit(this.device.state[this.dpBrightness]));
        }
    }

    setBrightness(value, callback) {
        if (this.syncBrightnessToWled) {
            const isOn = !!this.device.state[this.dpPower];

            // If lamp is OFF, don't talk to WLED; just remember the target level for when it turns back on.
            if (!isOn) {
                this.log.info(
                    '[WLED Sync] %s: setBrightness(%s%%) while OFF -> caching and skipping WLED call',
                    this.device.context.name,
                    value
                );
                this._lastWledPercent = value;
                // Logically we keep Tuya at 100% when on
                this._lastTuyaPercent = 100;
                return callback();
            }

            this.log.info(
                '[WLED Sync] %s: setBrightness(%s%%)',
                this.device.context.name,
                value
            );
            const bri = Math.max(0, Math.min(maxWledBrightness, Math.round((value / 100) * maxWledBrightness)));
            this.log.info(
                '[WLED Sync] %s: mapped HomeKit %s%% -> WLED bri=%s',
                this.device.context.name,
                value,
                bri
            );
            // If WLED is warming up after a power ON, queue this command and return immediately.
            if (this._wledReadyAt && Date.now() < this._wledReadyAt) {
                this._lastWledPercent = value;
                this._lastTuyaPercent = 100;
                this._queueWledBrightness(bri, 'HomeKit brightness during warmup');
                return callback();
            }

            this._setWledBrightness(bri, err => {
                if (err) {
                    this.log.error(
                        '[WLED Sync] %s: setBrightness failed talking to WLED (err=%s), falling back to direct Tuya dimming',
                        this.device.context.name,
                        err
                    );
                    // Fallback: control Tuya brightness directly so user still gets a response
                    return this.setState(
                        this.dpBrightness,
                        this.convertBrightnessFromHomeKitToTuya(value),
                        callback
                    );
                }

                // Keep the Tuya dimmer at 100% brightness so it does not interfere with WLED
                const maxTuyaBrightness = this.convertBrightnessFromHomeKitToTuya(100);
                this.log.info(
                    '[WLED Sync] %s: ensuring Tuya DP%s=%s (max)',
                    this.device.context.name,
                    this.dpBrightness,
                    maxTuyaBrightness
                );
                if (this.device.state[this.dpBrightness] !== maxTuyaBrightness) {
                    this.setState(this.dpBrightness, maxTuyaBrightness, () => callback());
                } else {
                    callback();
                }
            });
        } else {
            this.setState(this.dpBrightness, this.convertBrightnessFromHomeKitToTuya(value), callback);
        }
    }

    _queueWledBrightness(brightness, reason, callback) {
        const isOn = !!this.device.state[this.dpPower];
        if (!this.syncBrightnessToWled || !isOn) {
            callback && callback(true);
            return;
        }

        this._pendingWledBri = brightness;

        if (this._pendingWledTimer) {
            clearTimeout(this._pendingWledTimer);
            this._pendingWledTimer = null;
        }

        const now = Date.now();
        const delay = this._wledReadyAt && now < this._wledReadyAt ? (this._wledReadyAt - now) : 0;

        this.log.info(
            '[WLED Sync] %s: queue WLED bri=%s (%s) in %sms',
            this.device.context.name,
            brightness,
            reason || 'unspecified',
            delay
        );

        this._pendingWledTimer = setTimeout(() => {
            this._pendingWledTimer = null;
            const bri = this._pendingWledBri;
            this._pendingWledBri = null;

            // Re-check power before sending (might have been turned off during warmup)
            if (!this.device.state[this.dpPower]) {
                this.log.info(
                    '[WLED Sync] %s: skipped queued WLED bri=%s because power is OFF',
                    this.device.context.name,
                    bri
                );
                callback && callback(true);
                return;
            }

            this._setWledBrightness(bri, err => callback && callback(err));
        }, delay);
    }

    _getWledTarget() {
        if (!this.syncBrightnessToWled) return null;
        const parts = String(this.syncBrightnessToWled).split(':');
        const host = parts[0];
        const port = parts[1] ? parseInt(parts[1], 10) || 80 : 80;
        this.log.info(
            '[WLED Sync] %s: target host=%s port=%s',
            this.device.context.name,
            host,
            port
        );
        return {host, port};
    }

    _getWledBrightness(callback) {
        const target = this._getWledTarget();
        if (!target) {
            this.log.error(
                '[WLED Sync] %s: _getWledBrightness but no target configured',
                this.device.context.name
            );
            return callback(true);
        }

        // Ensure we never call the provided callback more than once
        const done = (err, bri) => {
            if (done.called) return;
            done.called = true;
            callback(err, bri);
        };

        const options = {
            host: target.host,
            port: target.port,
            path: '/json/state',
            method: 'GET',
            timeout: 5000
        };

        this.log.info(
            '[WLED Sync] %s: GET http://%s:%s/json/state',
            this.device.context.name,
            target.host,
            target.port
        );

        const req = http.request(options, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data || '{}');
                    // WLED exposes brightness as "bri" in the root of the state response
                    const bri = json.bri != null ? json.bri : (json.state && json.state.bri);
                    if (!isFinite(bri)) {
                        this.log.error(
                            '[WLED Sync] %s: /json/state response has no numeric bri: %s',
                            this.device.context.name,
                            data
                        );
                        return done(true);
                    }
                    this.log.info(
                        '[WLED Sync] %s: /json/state -> bri=%s',
                        this.device.context.name,
                        bri
                    );
                    done(null, bri);
                } catch (e) {
                    this.log.error('Failed to parse WLED state from %s: %s', this.syncBrightnessToWled, e.message);
                    done(true);
                }
            });
        });

        req.on('error', err => {
            this.log.error('Error talking to WLED at %s: %s', this.syncBrightnessToWled, err.message);
            done(true);
        });

        req.on('timeout', () => {
            req.destroy();
            done(true);
        });

        req.end();
    }

    _setWledBrightness(brightness, callback) {
        const target = this._getWledTarget();
        if (!target) {
            this.log.error(
                '[WLED Sync] %s: _setWledBrightness but no target configured',
                this.device.context.name
            );
            if (callback) callback(true);
            return;
        }

        // Ensure we never call the provided callback more than once
        const done = (err) => {
            if (!callback) return;
            if (done.called) return;
            done.called = true;
            callback(err);
        };

        const body = JSON.stringify({bri: brightness});

        const options = {
            host: target.host,
            port: target.port,
            path: '/json/state',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            },
            timeout: 5000
        };

        this.log.info(
            '[WLED Sync] %s: POST http://%s:%s/json/state body=%s',
            this.device.context.name,
            target.host,
            target.port,
            body
        );

        const req = http.request(options, res => {
            // Consume response and ignore body
            res.on('data', () => {});
            res.on('end', () => {
                this.log.info(
                    '[WLED Sync] %s: WLED brightness set, HTTP %s',
                    this.device.context.name,
                    res.statusCode
                );
                done && done();
            });
        });

        req.on('error', err => {
            this.log.error('Error setting WLED brightness on %s: %s', this.syncBrightnessToWled, err.message);
            done && done(true);
        });

        req.on('timeout', () => {
            req.destroy();
            done && done(true);
        });

        req.write(body);
        req.end();
    }
}

module.exports = SimpleDimmerAccessory;