import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';

const root = new URL('../', import.meta.url);
const bootstrapModule = 'jellyfin-desktop-mpv';

function createPage(enableMPV = true, startInfo) {
    const listeners = new WeakMap();
    const events = {
        on(target, name, callback) {
            const handlers = listeners.get(target) || {};
            (handlers[name] ||= []).push(callback);
            listeners.set(target, handlers);
        },
        trigger(target, name, args = []) {
            for (const callback of listeners.get(target)?.[name] || []) {
                callback.call(target, { type: name }, ...args);
            }
        }
    };
    const signal = () => {
        const callbacks = new Set();
        return {
            connect: callback => callbacks.add(callback),
            disconnect: callback => callbacks.delete(callback),
            emit: (...args) => callbacks.forEach(callback => callback(...args)),
            get size() { return callbacks.size; }
        };
    };
    const loads = [];
    const rectangles = [];
    const subtitles = [];
    const api = {
        settings: { sectionValueUpdate: signal(), groupUpdate: signal() },
        window: { setCursorVisibility() {} },
        player: {
            load(url, options, metadata, audio, subtitle, done) {
                // QWebChannel serializes native method arguments as JSON.
                JSON.stringify({ url, options, metadata, audio, subtitle });
                loads.push({ url, options, metadata, audio, subtitle });
                done(true);
            },
            stop() {},
            setSubtitleDelay() {},
            setVideoRectangle: (...args) => rectangles.push(args),
            setSubtitleStream: value => subtitles.push(value),
            setVolume() {},
            setPlaybackRate() {},
            notifyRateChange() {}
        }
    };
    for (const name of ['playing', 'positionUpdate', 'finished', 'updateDuration', 'error',
        'paused', 'bufferedRangesUpdated', 'buffering', 'canceled', 'stopped', 'stateChanged',
        'videoPlaybackActive', 'windowVisible', 'onVideoRecangleChanged', 'onMetaData']) {
        api.player[name] = signal();
    }
    const classList = () => {
        const classes = new Set();
        return {
            add: (...names) => names.forEach(name => classes.add(name)),
            remove: (...names) => names.forEach(name => classes.delete(name)),
            contains: name => classes.has(name)
        };
    };
    const body = {
        classList: classList(),
        children: [],
        insertBefore(element) { this.children.unshift(element); element.parentNode = this; },
        removeChild(element) { this.children.splice(this.children.indexOf(element), 1); }
    };
    let ready;
    const document = {
        body,
        addEventListener(name, callback) {
            assert.equal(name, 'DOMContentLoaded');
            ready = callback;
        },
        createElement: () => ({ classList: classList(), style: {} }),
        querySelector: () => body.children.find(element => element.classList.contains('videoPlayerContainer'))
    };
    const page = createContext({
        console: { log() {}, debug() {}, error() {} },
        document,
        jmpInfo: {
            version: 'test', mode: 'desktop', deviceName: 'Test device', userAgent: 'Desktop test',
            sections: [], settingsDescriptions: {},
            settings: { main: { enableMPV }, audio: { channels: '2.0' }, video: {} }
        },
        sessionStorage: { getItem: () => null, setItem() {} },
        qt: { webChannelTransport: {} },
        QWebChannel: class { constructor(transport, callback) { callback({ objects: api }); } },
        MutationObserver: class { observe() {} }
    });
    page.window = page;
    if (startInfo) page.appStartInfo = startInfo;
    // Execute the same native resources as the application's DocumentCreation script.
    const system = readFileSync(new URL('src/system/SystemComponent.cpp', root), 'utf8');
    const scripts = system.match(/QStringList scriptPaths = \{([\s\S]*?)\};/)[1];
    for (const match of scripts.matchAll(/:\/web-client\/extension\/([^"\n]+)/g)) {
        runInContext(readFileSync(new URL('native/' + match[1], root), 'utf8'), page);
    }
    const plugins = [{ id: 'htmlvideoplayer', type: 'mediaplayer', priority: 1, mediaType: 'Video' }];
    const players = [...plugins];
    const pluginManager = {
        ofType: type => plugins.filter(plugin => plugin.type === type),
        register(plugin) {
            plugins.push(plugin);
            events.trigger(this, 'registered', [plugin]);
        }
    };
    events.on(pluginManager, 'registered', (event, plugin) => {
        if (plugin.type === 'mediaplayer') {
            players.push(plugin);
            players.sort((a, b) => (a.priority || 0) - (b.priority || 0));
        }
    });
    const transparency = [];
    let osdCount = 0;
    const modules = {
        './modules/common/pluginmanager.js': pluginManager,
        './modules/common/playback/playbackmanager.js': { getPlayers: () => players },
        './modules/emby-apiclient/events.js': events,
        './modules/loading/loading.js': { show() {}, hide() {} },
        './modules/approuter.js': {
            setTransparency: level => transparency.push(level),
            showVideoOsd() { osdCount++; }
        },
        './modules/common/globalize.js': { translate: key => key },
        './modules/common/appsettings.js': { get: () => 0.5, set() {} },
        './modules/common/dialogs/confirm.js': () => Promise.resolve(),
        './modules/toast/toast.js': () => {}
    };
    const factories = new Map();
    factories.set('web-extension', () => 'web extension');
    const define = (name, dependencies, factory) => factories.set(name, factory);
    define.amd = {};
    const require = scripts => Promise.all(scripts.map(name => {
        assert.ok(factories.has(name), `AMD module ${name} must be defined before Emby starts`);
        return factories.get(name)();
    }));
    page.define = define;
    page.require = require;
    // Emby's apploader creates this object before Alameda and app.js finish loading.
    page.Emby = {};
    page.Emby.importModule = path => {
        assert.ok(path in modules, `unexpected module ${path}`);
        return Promise.resolve(modules[path]);
    };
    const start = () => require(page.appStartInfo?.scripts || []);
    return { page, plugins, players, api, loads, rectangles, subtitles, transparency, define, require,
        ready: () => ready(), start, get osdCount() { return osdCount; } };
}

test('Emby awaits native registration before appready without replacing its AMD loader', async () => {
    const harness = createPage();
    assert.ok(harness.page.appStartInfo?.scripts.includes(bootstrapModule));
    assert.equal(harness.page.define, harness.define);
    assert.equal(harness.page.require, harness.require);
    let started = false;
    const startup = harness.start().then(() => { started = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(started, false, 'startup must wait for the WebChannel bridge');
    assert.equal(harness.loads.length, 0);
    harness.ready();
    await startup;
    assert.deepEqual(harness.players.map(player => player.id),
        ['mpvvideoplayer', 'mpvaudioplayer', 'htmlvideoplayer']);
    await harness.start();
    assert.equal(harness.plugins.filter(plugin => plugin.id === 'mpvvideoplayer').length, 1);
});

test('MPV-disabled Emby pages keep their existing playback bootstrap', async () => {
    const harness = createPage(false);
    harness.ready();
    await harness.start();
    assert.equal(harness.page.appStartInfo, undefined);
    assert.deepEqual(harness.players.map(player => player.id), ['htmlvideoplayer']);
});

test('Emby native integration preserves existing bootstrap paths, plugins and scripts', async () => {
    const startInfo = { paths: { shell: 'custom-shell' }, plugins: ['custom-plugin'],
        scripts: ['web-extension'] };
    const harness = createPage(true, startInfo);
    assert.equal(harness.page.appStartInfo, startInfo);
    assert.deepEqual(Array.from(startInfo.scripts), ['web-extension', bootstrapModule]);
    assert.deepEqual(startInfo.paths, { shell: 'custom-shell' });
    assert.deepEqual(startInfo.plugins, ['custom-plugin']);
    harness.ready();
    await harness.start();
    assert.equal(harness.players[0].id, 'mpvvideoplayer');
});

test('Emby video playback loads native MPV with resume time, audio and absolute subtitles', async () => {
    const harness = createPage();
    harness.ready();
    await harness.start();
    const player = harness.players.find(player => player.id === 'mpvvideoplayer');
    assert.ok(player, 'Emby must register MPV as a local video player');
    const profilePromise = player.getDeviceProfile();
    assert.equal(typeof profilePromise.then, 'function');
    const profile = await profilePromise;
    assert.ok(profile.DirectPlayProfiles.some(entry => entry.Type === 'Video'));
    assert.equal(player.isLocalPlayer, true);
    assert.equal(player.canPlayMediaType('Video'), true);
    const source = {
        DefaultAudioStreamIndex: 3, DefaultSubtitleStreamIndex: 7,
        MediaStreams: [
            { Type: 'Video', Index: 0 }, { Type: 'Audio', Index: 1 },
            { Type: 'Audio', Index: 3 },
            { Type: 'Subtitle', Index: 7, DeliveryMethod: 'External', DeliveryUrl: '/subtitles/7.srt' }
        ]
    };
    await player.play({
        url: 'http://127.0.0.1/video.mkv', item: { Id: 'fixture', MediaType: 'Video' },
        mediaSource: source, fullscreen: true, playerStartPositionTicks: 125000000,
        textTracks: [{ index: 7, url: 'http://127.0.0.1/subtitles/7.srt' }]
    }, new AbortController().signal);
    assert.equal(harness.loads.length, 1);
    assert.equal(harness.loads[0].options.startMilliseconds, 12500);
    assert.equal(harness.loads[0].metadata.type, 'video');
    assert.equal(harness.loads[0].audio, 2);
    assert.equal(harness.loads[0].subtitle, '#,http://127.0.0.1/subtitles/7.srt');
    assert.equal(source.MediaStreams[3].DeliveryUrl, '/subtitles/7.srt');
    harness.api.player.playing.emit();
    assert.equal(harness.osdCount, 1);
    assert.deepEqual(harness.rectangles.at(-1), [0, 0, 0, 0]);
    assert.equal(harness.transparency.at(-1), 2);
    player.setSubtitleStreamIndex(-1);
    assert.equal(harness.subtitles.at(-1), -1);
    await player.stop(true);
    assert.equal(harness.transparency.at(-1), 0);
    assert.equal(harness.page.document.body.children.length, 0);
    assert.equal(harness.api.player.playing.size, 0);
});

test('cancelled Emby playback does not load MPV or open its video overlay', async () => {
    const harness = createPage();
    harness.ready();
    await harness.start();
    const player = harness.players.find(player => player.id === 'mpvvideoplayer');
    assert.ok(player);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(player.play({ url: 'http://127.0.0.1/video.mkv' }, controller.signal),
        { name: 'AbortError' });
    assert.equal(harness.loads.length, 0);
    assert.equal(harness.page.document.body.children.length, 0);
});

test('Emby audio and video URL playback use the native bridge without server media metadata', async () => {
    const harness = createPage();
    harness.ready();
    await harness.start();
    const video = harness.players.find(player => player.id === 'mpvvideoplayer');
    const audio = harness.players.find(player => player.id === 'mpvaudioplayer');
    assert.equal(video.canPlayUrl('http://127.0.0.1/test.avi'), true);
    assert.equal(audio.canPlayMediaType('Audio'), true);
    assert.equal(typeof audio.getDeviceProfile().then, 'function');
    const profile = await audio.getDeviceProfile();
    assert.ok(profile.DirectPlayProfiles.find(entry => entry.Type === 'Audio').Container.includes('flac'));
    assert.equal(profile.TranscodingProfiles.find(entry => entry.Type === 'Audio'
        && entry.Context === 'Streaming').Container, 'mp3');
    assert.equal(harness.page.NativeShell.AppHost.getDeviceProfile().TranscodingProfiles[0].Context, undefined);
    await video.play({ url: 'http://127.0.0.1/test.avi', fullscreen: false });
    assert.equal(harness.loads[0].metadata.type, 'video');
    await video.stop(true);
    await audio.play({ url: 'http://127.0.0.1/test.wav', playerStartPositionTicks: 10000000 });
    assert.equal(harness.loads[1].metadata.type, 'music');
    assert.equal(harness.loads[1].options.startMilliseconds, 1000);
});

test('Emby queue bookkeeping is excluded from metadata sent over QWebChannel', async () => {
    const harness = createPage();
    harness.ready();
    await harness.start();
    for (const id of ['mpvvideoplayer', 'mpvaudioplayer']) {
        const player = harness.players.find(player => player.id === id);
        const item = { Name: 'Local queue item', playOptions: {} };
        item.playOptions.items = [item];
        await player.play({ url: 'http://127.0.0.1/media', item, fullscreen: false });
        assert.equal(harness.loads.at(-1).metadata.metadata.Name, item.Name);
        assert.equal(harness.loads.at(-1).metadata.metadata.playOptions, undefined);
        assert.equal(item.playOptions.items[0], item, 'web playback state stays intact');
        player.destroy();
    }
});
