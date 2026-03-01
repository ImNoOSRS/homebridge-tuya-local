const BaseAccessory = require('./BaseAccessory');
const http = require('http');

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

        this.syncBrightnessToWled = (this.device.context.syncBrightnessToWled && ('' + this.device.context.syncBrightnessToWled).trim()) || null;

        const characteristicOn = service.getCharacteristic(Characteristic.On)
            .updateValue(dps[this.dpPower])
            .on('get', this.getState.bind(this, this.dpPower))
            .on('set', this.setState.bind(this, this.dpPower));

        const characteristicBrightness = service.getCharacteristic(Characteristic.Brightness);

        if (this.syncBrightnessToWled) {
            // Start with 100% while we fetch the actual WLED brightness
            characteristicBrightness
                .updateValue(100)
                .on('get', this.getBrightness.bind(this))
                .on('set', this.setBrightness.bind(this));

            this._getWledBrightness((err, bri) => {
                if (err || !isFinite(bri)) return;
                const value = Math.max(0, Math.min(100, Math.round((bri / 255) * 100)));
                characteristicBrightness.updateValue(value);
            });
        } else {
            characteristicBrightness
                .updateValue(this.convertBrightnessFromTuyaToHomeKit(dps[this.dpBrightness]))
                .on('get', this.getBrightness.bind(this))
                .on('set', this.setBrightness.bind(this));
        }

        this.device.on('change', changes => {
            if (changes.hasOwnProperty(this.dpPower) && characteristicOn.value !== changes[this.dpPower]) characteristicOn.updateValue(changes[this.dpPower]);
            if (!this.syncBrightnessToWled && changes.hasOwnProperty(this.dpBrightness) && this.convertBrightnessFromHomeKitToTuya(characteristicBrightness.value) !== changes[this.dpBrightness])
                characteristicBrightness.updateValue(this.convertBrightnessFromTuyaToHomeKit(changes[this.dpBrightness]));
        });
    }

    getBrightness(callback) {
        if (this.syncBrightnessToWled) {
            this._getWledBrightness((err, bri) => {
                if (err || !isFinite(bri)) return callback(err || true);
                const value = Math.max(0, Math.min(100, Math.round((bri / 255) * 100)));
                callback(null, value);
            });
        } else {
            callback(null, this.convertBrightnessFromTuyaToHomeKit(this.device.state[this.dpBrightness]));
        }
    }

    setBrightness(value, callback) {
        if (this.syncBrightnessToWled) {
            const bri = Math.max(0, Math.min(255, Math.round((value / 100) * 255)));
            this._setWledBrightness(bri, err => {
                if (err) return callback(err);

                // Keep the Tuya dimmer at 100% brightness so it does not interfere with WLED
                const maxTuyaBrightness = this.convertBrightnessFromHomeKitToTuya(100);
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

    _getWledTarget() {
        if (!this.syncBrightnessToWled) return null;
        const parts = String(this.syncBrightnessToWled).split(':');
        const host = parts[0];
        const port = parts[1] ? parseInt(parts[1], 10) || 80 : 80;
        return {host, port};
    }

    _getWledBrightness(callback) {
        const target = this._getWledTarget();
        if (!target) return callback(true);

        const options = {
            host: target.host,
            port: target.port,
            path: '/json/state',
            method: 'GET',
            timeout: 5000
        };

        const req = http.request(options, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data || '{}');
                    // WLED exposes brightness as "bri" in the root of the state response
                    const bri = json.bri != null ? json.bri : (json.state && json.state.bri);
                    if (!isFinite(bri)) return callback(true);
                    callback(null, bri);
                } catch (e) {
                    this.log.error('Failed to parse WLED state from %s: %s', this.syncBrightnessToWled, e.message);
                    callback(true);
                }
            });
        });

        req.on('error', err => {
            this.log.error('Error talking to WLED at %s: %s', this.syncBrightnessToWled, err.message);
            callback(true);
        });

        req.on('timeout', () => {
            req.destroy();
            callback(true);
        });

        req.end();
    }

    _setWledBrightness(brightness, callback) {
        const target = this._getWledTarget();
        if (!target) return callback(true);

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

        const req = http.request(options, res => {
            // Consume response and ignore body
            res.on('data', () => {});
            res.on('end', () => callback && callback());
        });

        req.on('error', err => {
            this.log.error('Error setting WLED brightness on %s: %s', this.syncBrightnessToWled, err.message);
            callback && callback(true);
        });

        req.on('timeout', () => {
            req.destroy();
            callback && callback(true);
        });

        req.write(body);
        req.end();
    }
}

module.exports = SimpleDimmerAccessory;