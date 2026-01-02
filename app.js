/* CamLink PWA - WebRTC two-device streaming */

const statusText = document.getElementById('statusText');
const roleText = document.getElementById('roleText');
const yearEl = document.getElementById('year');
if (yearEl) yearEl.textContent = new Date().getFullYear();

let pc = null;
let localStream = null;
let sessionRef = null;
let isCamera = false;
let deferredPrompt = null;

const logEl = (() => {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;bottom:8px;left:8px;max-width:90vw;background:#1118;color:#cfd;padding:6px 8px;border-radius:6px;font:12px/1.4 system-ui;z-index:9999;';
  el.id = 'debugLog';
  el.textContent = 'Log:';
  document.body.appendChild(el);
  return el;
})();
function log(msg) { console.log(msg); logEl.textContent = `Log: ${msg}`; }
function setStatus(text) { statusText.textContent = text; log(text); }
function setRole(text) { roleText.textContent = text; }

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const installBtn = document.getElementById('installBtn');
  installBtn.hidden = false;
  installBtn.onclick = async () => {
    installBtn.hidden = true;
    await deferredPrompt.prompt();
    deferredPrompt = null;
  };
});

window.addEventListener('appinstalled', () => {
  const installBtn = document.getElementById('installBtn');
  installBtn.hidden = true;
  setStatus('App installed successfully!');
});

function generateCode() {
  const n = Math.floor(100000 + Math.random() * 900000).toString();
  return `${n.slice(0,3)}-${n.slice(3)}`;
}
document.getElementById('genCodeBtn').addEventListener('click', () => {
  document.getElementById('cameraCode').value = generateCode();
});

const rtcConfig = { iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] };

// Firebase helpers
async function initFirebaseSession(code) {
  const { ref, set, onChildAdded, onValue, push, remove } = window.FirebaseRTDB;
  const baseRef = ref(`sessions/${code}`);
  await set(baseRef, { createdAt: Date.now() });
  return {
    baseRef,
    offerRef: ref(`sessions/${code}/offer`),
    answerRef: ref(`sessions/${code}/answer`),
    camCandidatesRef: ref(`sessions/${code}/candidates/camera`),
    viewerCandidatesRef: ref(`sessions/${code}/candidates/viewer`),
    helpers: { onChildAdded, onValue, push, remove }
  };
}

/* ---------- Device enumeration & selection ---------- */

const cameraSelect = document.getElementById('cameraDevice');

async function ensurePermissions() {
  // Some browsers only list devices after a successful getUserMedia call
  try {
    await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  } catch (e) {
    // ignore – just to unlock labels
  }
}

async function populateCameras() {
  try {
    await ensurePermissions();
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter(d => d.kind === 'videoinput');

    cameraSelect.innerHTML = '';
    cameras.forEach((cam, i) => {
      const opt = document.createElement('option');
      opt.value = cam.deviceId;
      // Heuristic: if label contains "back" or "rear" or "environment", prefer labeling appropriately
      const label = cam.label || `Camera ${i + 1}`;
      opt.textContent = label;
      cameraSelect.appendChild(opt);
    });

    // Try auto-select rear if present
    const rear = cameras.find(c => /back|rear|environment/i.test(c.label));
    if (rear) {
      cameraSelect.value = rear.deviceId;
    }
    log(`Cameras found: ${cameras.length}`);
  } catch (err) {
    log(`Failed to enumerate cameras: ${err.message}`);
  }
}

// Populate on load
populateCameras();
navigator.mediaDevices.addEventListener?.('devicechange', populateCameras);

/* ---------- Camera role ---------- */

async function startCamera() {
  const code = document.getElementById('cameraCode').value.trim();
  if (!code) { alert('Enter or generate a session code first.'); return; }

  isCamera = true;
  setRole('Camera');
  setStatus('Accessing camera...');

  try {
    const deviceId = cameraSelect.value;
    const includeAudio = document.getElementById('enableAudio').checked;

    const constraints = {
      video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'environment' },
      audio: includeAudio
    };

    localStream = await navigator.mediaDevices.getUserMedia(constraints);

    const localVideo = document.getElementById('localVideo');
    localVideo.srcObject = localStream;
    await localVideo.play().catch(() => {}); // Autoplay quirks

    const { baseRef, offerRef, answerRef, camCandidatesRef, viewerCandidatesRef, helpers } =
      await initFirebaseSession(code);
    sessionRef = { baseRef, offerRef, answerRef, camCandidatesRef, viewerCandidatesRef, helpers };

    pc = new RTCPeerConnection(rtcConfig);
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    pc.onicecandidate = async (event) => {
      if (event.candidate) await helpers.push(camCandidatesRef, event.candidate.toJSON());
    };

    pc.ontrack = async (event) => {
      const remoteVideo = document.getElementById('remoteVideo');
      remoteVideo.srcObject = event.streams[0];
      // Let audio play out on the viewer; camera page remains muted unless you want local monitor
      await remoteVideo.play().catch(() => {});
    };

    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await pc.setLocalDescription(offer);
    await window.FirebaseRTDB.set(offerRef, { sdp: offer.sdp, type: offer.type });

    setStatus(`Offer published. Code: ${code}`);

    helpers.onValue(answerRef, async (snapshot) => {
      const answer = snapshot.val();
      if (answer && !pc.currentRemoteDescription) {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        setStatus('Connected to viewer.');
      }
    });

    helpers.onChildAdded(viewerCandidatesRef, async (snapshot) => {
      const candidate = snapshot.val();
      if (candidate) await pc.addIceCandidate(new RTCIceCandidate(candidate));
    });

  } catch (err) {
    console.error(err);
    alert('Camera access failed. Ensure HTTPS and permissions are allowed.');
    setStatus(`Error starting camera: ${err.message}`);
  }
}

/* ---------- Viewer role ---------- */

async function connectViewer() {
  const code = document.getElementById('viewerCode').value.trim();
  if (!code) { alert('Enter the session code from the camera device.'); return; }

  isCamera = false;
  setRole('Viewer');
  setStatus('Connecting...');

  try {
    const { baseRef, offerRef, answerRef, camCandidatesRef, viewerCandidatesRef, helpers } =
      await initFirebaseSession(code);
    sessionRef = { baseRef, offerRef, answerRef, camCandidatesRef, viewerCandidatesRef, helpers };

    pc = new RTCPeerConnection(rtcConfig);

    pc.ontrack = async (event) => {
      const remoteVideo = document.getElementById('remoteVideo');
      remoteVideo.srcObject = event.streams[0];
      // Unmute on viewer so audio is audible
      remoteVideo.muted = false;
      await remoteVideo.play().catch(() => {});
      setStatus('Receiving stream.');
    };

    pc.onicecandidate = async (event) => {
      if (event.candidate) await helpers.push(viewerCandidatesRef, event.candidate.toJSON());
    };

    // First try to read the offer once
    offerRef.once('value').then(async (snapshot) => {
      const offer = snapshot.val();
      if (!offer) {
        setStatus('Waiting for camera offer...');
        // Fallback listener if offer not yet published
        helpers.onValue(offerRef, async (snap) => {
          const delayedOffer = snap.val();
          if (delayedOffer && !pc.currentRemoteDescription) {
            await pc.setRemoteDescription(new RTCSessionDescription(delayedOffer));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            await window.FirebaseRTDB.set(answerRef, { sdp: answer.sdp, type: answer.type });
            setStatus('Answer sent. Establishing connection...');
          }
        });
        return;
      }

      // Offer exists immediately
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await window.FirebaseRTDB.set(answerRef, { sdp: answer.sdp, type: answer.type });
      setStatus('Answer sent. Establishing connection...');
    });

    // Listen for ICE candidates from camera
    helpers.onChildAdded(camCandidatesRef, async (snapshot) => {
      const candidate = snapshot.val();
      if (candidate) await pc.addIceCandidate(new RTCIceCandidate(candidate));
    });

  } catch (err) {
    console.error(err);
    alert('Connection failed. Ensure camera has published an offer.');
    setStatus(`Error connecting viewer: ${err.message}`);
  }
}

/* ---------- Hangup ---------- */

async function hangup() {
  setStatus('Hanging up...');
  try {
    if (pc) pc.close();
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    if (sessionRef?.baseRef) await sessionRef.helpers.remove(sessionRef.baseRef);

    document.getElementById('localVideo').srcObject = null;
    document.getElementById('remoteVideo').srcObject = null;
    setStatus('Idle');
    setRole('None');
  } catch (e) {
    console.warn('Error during hangup', e);
    setStatus('Idle');
  }
}

/* ---------- Fullscreen ---------- */

document.getElementById('fullscreenBtn')?.addEventListener('click', () => {
  const remoteVideo = document.getElementById('remoteVideo');
  if (remoteVideo.requestFullscreen) {
    remoteVideo.requestFullscreen();
  } else if (remoteVideo.webkitRequestFullscreen) {
    remoteVideo.webkitRequestFullscreen();
  } else if (remoteVideo.msRequestFullscreen) {
    remoteVideo.msRequestFullscreen();
  }
});

/* ---------- Wire UI ---------- */

document.getElementById('startCameraBtn').addEventListener('click', startCamera);
document.getElementById('connectViewerBtn').addEventListener('click', connectViewer);

/* ---------- Service worker ---------- */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js');
  });
}

/* ---------- HTTPS check ---------- */

if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
  setStatus('Note: Use HTTPS for camera access.');
}