import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';

const nativeDirectory = new URL('../native/', import.meta.url);
const pluginScripts = ['mpvVideoPlayer', 'mpvAudioPlayer', 'inputPlugin', 'updatePlugin'];
const nativeShell = readFileSync(new URL('nativeshell.js', nativeDirectory), 'utf8');

function createPage(enableMPV = true) {
    const storage = new Map();
    const settingWrites = [];
    let documentReady;
    const signal = () => ({ connect() {} });
    const api = {
        settings: {
            sectionValueUpdate: signal(),
            groupUpdate: signal(),
            setValue(section, key, value, done) {
                settingWrites.push({ section, key, value });
                done();
            }
        },
        window: { setCursorVisibility() {} }
    };
    const page = createContext({
        console,
        jmpInfo: {
            version: 'test',
            mode: 'desktop',
            deviceName: 'Test device',
            sections: [],
            settingsDescriptions: {},
            settings: { main: { enableMPV, fullscreen: false }, audio: { channels: '2.0' }, video: {} }
        },
        sessionStorage: {
            getItem: key => storage.get(key) ?? null,
            setItem: (key, value) => storage.set(key, value)
        },
        document: {
            body: { classList: { contains: () => false } },
            addEventListener(name, callback) {
                assert.equal(name, 'DOMContentLoaded');
                documentReady = callback;
            }
        },
        qt: { webChannelTransport: {} },
        QWebChannel: class {
            constructor(transport, callback) {
                callback({ objects: api });
            }
        },
        MutationObserver: class { observe() {} }
    });
    page.window = page;
    page.window.jmpInfo = page.jmpInfo;
    for (const plugin of pluginScripts) {
        runInContext(readFileSync(new URL(plugin + '.js', nativeDirectory), 'utf8'), page);
    }
    return { page, api, storage, settingWrites, ready: () => documentReady() };
}

test('web loader can declare its own globals after native shell injection', () => {
    const { page } = createPage();
    runInContext(nativeShell, page);
    // Emby Alameda declares a global var named plugins when the page starts.
    runInContext('var plugins = { css: true }; var features = {}; var rawSettings = {};', page);
    assert.equal(page.plugins.css, true);
    assert.deepEqual(Array.from(page.NativeShell.getPlugins()), pluginScripts);
    assert.equal(page.NativeShell.AppHost.supports('fullscreenchange'), true);
});

test('native shell does not overwrite existing web client globals', () => {
    const { page } = createPage();
    runInContext('const plugins = "web plugins"; const features = "web features";', page);
    runInContext(nativeShell, page);
    assert.equal(runInContext('plugins', page), 'web plugins');
    assert.equal(runInContext('features', page), 'web features');
    assert.deepEqual(Array.from(page.NativeShell.getPlugins()), pluginScripts);
});

test('native plugin factories and AppHost remain accessible to the web client', async () => {
    const { page } = createPage();
    runInContext(nativeShell, page);
    for (const plugin of pluginScripts) {
        assert.equal(page[plugin](), page['_' + plugin]);
        assert.equal(typeof page[plugin](), 'function');
    }
    assert.equal(page.NativeShell.AppHost.getDefaultLayout(), 'desktop');
    assert.equal((await page.NativeShell.AppHost.init()).appName, 'Jellyfin Desktop');
    assert.equal(page.NativeShell.AppHost.getDeviceProfile().Name, 'Jellyfin Desktop');
});

test('MPV-disabled pages still expose the input and update plugins', () => {
    const { page } = createPage(false);
    runInContext(nativeShell, page);
    assert.deepEqual(Array.from(page.NativeShell.getPlugins()), ['inputPlugin', 'updatePlugin']);
    assert.equal(page.mpvVideoPlayer, undefined);
    assert.equal(page.mpvAudioPlayer, undefined);
});

test('WebChannel initialization and settings synchronization survive isolated scope', async () => {
    const { page, api, storage, settingWrites, ready } = createPage();
    runInContext(nativeShell, page);
    ready();
    await page.initCompleted;
    assert.equal(page.api, api);
    page.jmpInfo.settings.main.enableMPV = false;
    assert.deepEqual(settingWrites, [{ section: 'main', key: 'enableMPV', value: false }]);
    assert.equal(JSON.parse(storage.get('settings')).main.enableMPV, false);
});
