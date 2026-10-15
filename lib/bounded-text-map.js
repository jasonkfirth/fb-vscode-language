/*
    Project: FreeBASIC VS Code Language Extension
    File: lib/bounded-text-map.js
    Purpose: Retain text values under explicit entry and UTF-8 byte limits.
    Responsibilities: maintain insertion order and exact incremental size.
    Does not contain: eviction policy beyond the configured oldest-first bound.
*/

class BoundedTextMap extends Map {
    constructor(maximumEntries, maximumBytes) {
        super();
        if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1 ||
            !Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
            throw new RangeError("Bounded text cache needs a positive entry limit and a non-negative byte limit.");
        }
        this.maximumEntries = maximumEntries;
        this.maximumBytes = maximumBytes;
        this.bytes = 0;
        this.valueBytes = new Map();
    }

    set(key, value) {
        if (typeof value !== "string") throw new TypeError("Bounded text cache values must be strings.");
        const previousBytes = this.valueBytes.get(key);
        if (previousBytes !== undefined) this.bytes -= previousBytes;

        const valueBytes = Buffer.byteLength(value, "utf8");
        super.set(key, value);
        this.valueBytes.set(key, valueBytes);
        this.bytes += valueBytes;

        while ((this.size > this.maximumEntries) || (this.bytes > this.maximumBytes)) {
            const oldestKey = this.keys().next().value;
            if (oldestKey === undefined) break;
            this.delete(oldestKey);
        }
        return this;
    }

    delete(key) {
        const valueBytes = this.valueBytes.get(key);
        if (valueBytes === undefined) return false;
        this.bytes -= valueBytes;
        this.valueBytes.delete(key);
        return super.delete(key);
    }

    clear() {
        super.clear();
        this.valueBytes.clear();
        this.bytes = 0;
    }
}

module.exports = { BoundedTextMap };

/* end of lib/bounded-text-map.js */
