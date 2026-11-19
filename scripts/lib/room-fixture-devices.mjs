/**
 * Renderer source (for the smoke command server's `eval-js`) that gives the
 * room a camera and a microphone it can open in a Chromium fake-media run.
 *
 * The room opens only the device Sources names, by its Chromium label, and
 * never Chromium's default on a miss (0.31, #1504). The fake camera is
 * labelled with its y4m file's path and the fake microphones "Fake Audio
 * Input 1" and "2", unlike any device the backend lists, so without this the
 * host joins with its camera off and its microphone muted.
 *
 * It seeds the DEV fixture catalog (`roomFixtureDevices`), aliases the labels
 * of one fake camera and one fake microphone to the fixtures' names, and
 * selects them in Sources. Alias labels only in this isolated fake-device
 * process, never production: this deliberately supplies no evidence for
 * physical-device matching. The microphone alias goes on a real fake input,
 * never Chromium's synthetic `default`/`communications` entry: the room's
 * matcher (plan 080's `matchStrictAudioInput`) never opens those, as it never
 * does in production.
 *
 * Run it before the room opens, and again after every relaunch (the catalog
 * and the alias live in the renderer). It returns the fixture camera's id.
 *
 * `controls: true` is the parity controls case: no camera selected, camera
 * off and the microphone muted.
 */
export function roomFixtureDevicesSource(controls = false) {
  return `
    const catalog = window.__videorcSmokeScenePresets.roomFixtureDevices();
    const camera = catalog.find(d => d.kind === 'camera');
    const microphone = catalog.find(d => d.kind === 'microphone');
    const config = window.__videorcSmokeScenePresets.streamingState().captureConfig;
    const enumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
    navigator.mediaDevices.enumerateDevices = async () => {
      const devices = await enumerate();
      const video = devices.find(d => d.kind === 'videoinput');
      const audio = devices.find(d => d.kind === 'audioinput' &&
        d.deviceId !== 'default' && d.deviceId !== 'communications');
      if (!video || !audio) throw new Error('Chromium fake-media devices are missing');
      return devices.map(d => ({ deviceId: d.deviceId, groupId: d.groupId, kind: d.kind,
        label: d.deviceId === video.deviceId ? camera.name : d.deviceId === audio.deviceId ? microphone.name : d.label
      }));
    };
    window.__videorcSmokeScenePresets.configure({
      sources: { ...config.sources, cameraId: ${controls ? 'undefined' : 'camera.id'}, cameraOff: ${controls},
        microphoneId: microphone.id, microphoneName: microphone.name },
      audio: { ...config.audio, microphoneMuted: ${controls} }
    });
    return camera.id;
  `
}
