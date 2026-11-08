import GObject from './gobject.mjs';

export const Slider = GObject.registerClass(
class Slider {
    _init(value = 0) {
        this._value = value;
        this._maxValue = 1.0;
        this._marks = new Set();
        this._connections = [];
    }

    get value() {
        return this._value;
    }

    set value(v) {
        this._value = v;
    }

    get maximumValue() {
        return this._maxValue;
    }

    addMark(val) {
        this._marks.add(val);
    }

    clearMarks() {
        this._marks.clear();
    }

    queue_repaint() {}

    connect(sig, fn) {
        const id = this._connections.length + 1;
        this._connections.push({ id, sig, fn });
        return id;
    }

    disconnect(id) {
        this._connections = this._connections.filter(c => c.id !== id);
    }

    block_signal_handler(id) {}
    unblock_signal_handler(id) {}
});
