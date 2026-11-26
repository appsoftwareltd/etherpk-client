/*
 * Puts `window.etherpkNative` (NativePort in packages/native-bridge) on the page. The shell runs this
 * before any script of the page, in documents of the app's own origin only. Port.kt is the other end.
 */
(() => {
    'use strict';
    const raw = window.etherpkNativeMessages;
    // A frame of the app's own origin is given the object too. It gets no port, and the shell ignores
    // its messages.
    if (raw === undefined || window !== window.top) return;

    const CHUNK = 4 * 1024 * 1024;
    const STREAM_PATH = '/__native/bytes/';
    const info = "__INFO__";
    // Kept from before the page's scripts run, so none of them changes what these do.
    const { JSON, Map, Object, Promise, TextDecoder, TextEncoder, Uint8Array, DataView, ArrayBuffer, Array, String, Error, crypto } = window;
    const fetch = window.fetch.bind(window);
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const post = raw.postMessage.bind(raw);

    const waiting = new Map();
    const listeners = new Map();
    let lastId = 0;

    const refuse = (name, message) => ({ ok: false, name, message });

    function frame(header, chunks, length) {
        const json = encoder.encode(JSON.stringify(header));
        const message = new Uint8Array(4 + json.length + length);
        new DataView(message.buffer).setUint32(0, json.length);
        message.set(json, 4);
        let offset = 4 + json.length;
        for (const chunk of chunks) {
            message.set(chunk, offset);
            offset += chunk.length;
        }
        return message.buffer;
    }

    function send(header, chunks, length) {
        const id = ++lastId;
        return new Promise((resolve) => {
            waiting.set(id, resolve);
            post(frame({ ...header, id }, chunks, length));
        });
    }

    const bytesOf = (value) => (ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : new Uint8Array(value));

    /** Sends bytes too many for one message a part at a time, each once the one before has been kept. */
    async function upload(bytes) {
        const token = crypto.randomUUID();
        for (let offset = 0; offset < bytes.length; offset += CHUNK) {
            const part = bytes.subarray(offset, offset + CHUNK);
            const reply = await send({ part: token, offset }, [part], part.length);
            if (!reply.ok) throw reply;
        }
        return token;
    }

    /**
     * The arguments as JSON, with the bytes in them set aside. Nothing is awaited, so what is sent is
     * what the page had when it called, whatever it does to its buffers next.
     */
    function encode(value, body) {
        if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
            const bytes = bytesOf(value).slice();
            if (bytes.length > CHUNK) {
                const place = { $upload: '' };
                body.uploads.push({ place, bytes });
                return place;
            }
            body.chunks.push(bytes);
            body.length += bytes.length;
            return { $bytes: [body.length - bytes.length, bytes.length] };
        }
        if (Array.isArray(value)) return value.map((one) => encode(one, body));
        if (value !== null && typeof value === 'object') {
            const out = {};
            for (const key of Object.keys(value)) if (value[key] !== undefined) out[key] = encode(value[key], body);
            return out;
        }
        if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') throw new Error('The arguments hold something that is not data.');
        return value;
    }

    async function decode(value, message, bodyAt) {
        if (Array.isArray(value)) {
            const out = [];
            for (const one of value) out.push(await decode(one, message, bodyAt));
            return out;
        }
        if (value === null || typeof value !== 'object') return value;
        if (Array.isArray(value.$bytes)) {
            const start = bodyAt + value.$bytes[0];
            return new Uint8Array(message.slice(start, start + value.$bytes[1]));
        }
        if (typeof value.$stream === 'string') {
            const response = await fetch(STREAM_PATH + value.$stream, { cache: 'no-store' });
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (!response.ok || bytes.length !== value.size) throw refuse('NotReadableError', 'The bytes did not all arrive.');
            return bytes;
        }
        const out = {};
        for (const key of Object.keys(value)) out[key] = await decode(value[key], message, bodyAt);
        return out;
    }

    raw.onmessage = async (event) => {
        if (!(event.data instanceof ArrayBuffer)) return;
        const message = event.data;
        const length = new DataView(message).getUint32(0);
        const header = JSON.parse(decoder.decode(new Uint8Array(message, 4, length)));
        const bodyAt = 4 + length;
        if (typeof header.event === 'string') {
            const detail = await decode(header.detail, message, bodyAt);
            for (const listener of [...listeners.values()]) {
                // One listener that throws is the page's fault, and does not keep the event from the rest.
                try { listener(header.event, detail); } catch (error) { console.error(error); }
            }
            return;
        }
        const resolve = waiting.get(header.id);
        if (resolve === undefined) return;
        waiting.delete(header.id);
        if (!header.ok) {
            resolve(refuse(header.name, header.message));
            return;
        }
        try {
            resolve({ ok: true, value: await decode(header.value, message, bodyAt) });
        } catch (error) {
            resolve(typeof error?.ok === 'boolean' ? error : refuse('NotReadableError', String(error)));
        }
    };

    async function call(method, args) {
        if (typeof method !== 'string') return refuse('NotSupportedError', 'This is not a method of the shell.');
        try {
            const body = { chunks: [], length: 0, uploads: [] };
            const encoded = encode(args ?? null, body);
            for (const { place, bytes } of body.uploads) place.$upload = await upload(bytes);
            return await send({ method, args: encoded }, body.chunks, body.length);
        } catch (error) {
            return typeof error?.ok === 'boolean' ? error : refuse('OperationError', String(error));
        }
    }

    function on(listener) {
        const key = {};
        listeners.set(key, listener);
        return () => { listeners.delete(key); };
    }

    Object.defineProperty(window, 'etherpkNative', {
        value: Object.freeze({ info: Object.freeze({ ...info, features: Object.freeze(info.features) }), call, on }),
        enumerable: true,
    });
    // The raw channel is reached through the port from here on.
    try { delete window.etherpkNativeMessages; } catch { /* It stays, and leads to the same table. */ }
    send({ hello: true }, [], 0);
})();
