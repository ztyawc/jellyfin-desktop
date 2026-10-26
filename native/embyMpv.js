// Emby 4.x uses appStartInfo and AMD plugins instead of NativeShell.getPlugins().
(function() {
    if (window.jmpInfo.settings.main.enableMPV === false) {
        return;
    }

    const moduleId = 'jellyfin-desktop-mpv';

    // DocumentCreation runs before Emby's apploader creates Emby. Observe only its
    // bootstrap exports; leave require/define and the web client's globals intact.
    function onAssignment(target, key, callback) {
        if (target[key] !== undefined) {
            callback(target[key]);
            return;
        }
        const descriptor = Object.getOwnPropertyDescriptor(target, key);
        if (descriptor && !descriptor.configurable) {
            return;
        }
        Object.defineProperty(target, key, {
            configurable: true,
            enumerable: true,
            get: () => undefined,
            set(value) {
                Object.defineProperty(target, key, {
                    configurable: true, enumerable: true, writable: true, value
                });
                callback(value);
            }
        });
    }

    function normalizeOptions(options) {
        // Emby attaches playOptions.items to queue entries. That can point back to
        // the same item and cannot be serialized by QWebChannel.
        if (!options.item) {
            return options;
        }
        const item = { ...options.item };
        delete item.playOptions;
        return { ...options, item };
    }

    function normalizeVideoOptions(options) {
        options = normalizeOptions(options);
        const mediaSource = options.mediaSource || { MediaStreams: [] };
        const textTracks = options.textTracks || [];
        return {
            ...options,
            mediaSource: {
                ...mediaSource,
                MediaStreams: (mediaSource.MediaStreams || []).map(stream => {
                    const track = textTracks.find(track => track.index === stream.Index);
                    return track ? { ...stream, DeliveryMethod: 'External', DeliveryUrl: track.url } : stream;
                })
            }
        };
    }

    async function registerPlayers(emby) {
        await window.initCompleted;
        if (window.jmpInfo.settings.main.enableMPV === false) {
            return;
        }
        const [pluginManager, playbackManager, events, loading, appRouter, globalize,
            appSettings, confirm, toast] = await Promise.all([
            './modules/common/pluginmanager.js',
            './modules/common/playback/playbackmanager.js',
            './modules/emby-apiclient/events.js',
            './modules/loading/loading.js',
            './modules/approuter.js',
            './modules/common/globalize.js',
            './modules/common/appsettings.js',
            './modules/common/dialogs/confirm.js',
            './modules/toast/toast.js'
        ].map(path => emby.importModule(path)));

        // Emby calls getDeviceProfile(...).then(...), including when changing tracks.
        const appHost = {
            ...window.NativeShell.AppHost,
            getDeviceProfile: (...args) => {
                const profile = window.NativeShell.AppHost.getDeviceProfile(...args);
                return Promise.resolve({
                    ...profile,
                    // Emby's audio URL builder selects profiles with Context=Streaming
                    // and requires a concrete fallback container/codec.
                    DirectPlayProfiles: profile.DirectPlayProfiles.map(entry => entry.Type === 'Audio'
                        ? { ...entry, Container: 'aac,ac3,aiff,alac,ape,dts,flac,m4a,m4b,mka,mp3,mp4,ogg,opus,wav,webm,wma' }
                        : entry),
                    TranscodingProfiles: profile.TranscodingProfiles.map(entry => entry.Type === 'Audio'
                        ? { ...entry, Context: 'Streaming', Container: 'mp3', AudioCodec: 'mp3', Protocol: 'http' }
                        : { ...entry, Context: 'Streaming' })
                });
            }
        };
        class EmbyVideoPlayer extends window._mpvVideoPlayer {
            constructor() {
                super({ events, loading, appRouter, globalize, appHost, appSettings, confirm,
                    dashboard: { default: { setBackdropTransparency: appRouter.setTransparency.bind(appRouter) } }
                });
            }

            async play(options, signal) {
                signal?.throwIfAborted();
                return super.play(normalizeVideoOptions(options));
            }
        }
        class EmbyAudioPlayer extends window._mpvAudioPlayer {
            constructor() {
                super({ events, appHost, appSettings, toast });
                const play = this.play;
                this.play = async (options, signal) => {
                    signal?.throwIfAborted();
                    return play(normalizeOptions(options));
                };
            }
        }

        // Ensure playbackManager is initialized before registered events are emitted.
        const existingPlayers = playbackManager.getPlayers();
        for (const Player of [EmbyVideoPlayer, EmbyAudioPlayer]) {
            const player = new Player();
            if (existingPlayers.some(existing => existing.id === player.id)) {
                continue;
            }
            player.priority = -1;
            player.isLocalPlayer = true;
            player.canPlayUrl = url => /^(https?|file):/i.test(url);
            const supports = player.supports.bind(player);
            const commands = ['SetVolume', 'VolumeUp', 'VolumeDown', 'Mute', 'Unmute',
                'ToggleMute', 'SetPlaybackRate'];
            if (player.id === 'mpvvideoplayer') {
                commands.push('SetAspectRatio', 'SetSubtitleOffset');
            }
            player.supports = feature => commands.includes(feature) || supports(feature);
            pluginManager.register(player);
        }
        console.log('[Jellyfin Desktop] Emby MPV players registered');
    }

    onAssignment(window, 'Emby', emby => {
        if (!emby) {
            return;
        }
        onAssignment(emby, 'importModule', importModule => {
            if (typeof importModule !== 'function' || typeof window.define !== 'function' || !window.define.amd) {
                return;
            }
            let registration;
            window.define(moduleId, [], () => {
                registration = registration || registerPlayers(emby).catch(error => {
                    console.error('[Jellyfin Desktop] Unable to register Emby MPV players:', error);
                });
                return registration;
            });
            const startInfo = window.appStartInfo = window.appStartInfo || {};
            startInfo.scripts = [...(startInfo.scripts || []), moduleId];
            // Emby awaits these modules after loading plugins, before routes/appready.
        });
    });
})();
