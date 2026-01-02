const statusText = document.getElementById('statusText');
const roleText = document.getElementById('roleText');
const yearEl = document.getElementById('year');
if (yearEl) yearEl.textContent = new Date().getFullYear();

let pc = null;
let localStream = null;
let sessionRef = null;
let isCamera = false;
let deferredPrompt = null;

// Install prompt
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const installBtn = document.getElementById('installBtn');
  installBtn.hidden = false;
  installBtn.addEventListener('click', async () => {
    installBtn.hidden = true;
    await deferredPrompt.prompt();
    deferredPrompt = null;
  });
});

// STUN servers (free)
const rtcConfig = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302'] },
    { urls: ['stun:global.stun.twilio.com:3478?transport=udp'] }
  ]
};

const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const cameraCodeInput = document.getElementById('cameraCode');
const viewerCodeInput = document.getElementById('viewerCode');
const genCodeBtn = document.getElementById('genCodeBtn');
const startCameraBtn = document.getElementById('startCameraBtn');
const connectViewerBtn = document.getElementById('connectViewerBtn');
const captureBtn = document.getElementById('captureBtn');
const hangupBtn = document.getElementById('hangupBtn');
const rearCamCheckbox = document.getElementById('rearCam');
const torchToggle = document.getElementById('torchToggle');
const snapshotCanvas = document.getElementById('snapshotCanvas');

function setStatus(text) { statusText.textContent = text; }
function setRole(text) { roleText.textContent = text; }

function generateCode() {
  // Simple 6-digit with dash, not cryptographically secure
  const n = Math.floor(100000 + Math.random() * 900000).toString();
  return `${n.slice(0,3)}-${n.slice(3)}`;
}

genCodeBtn.addEventListener('click', () => {
  cameraCodeInput.value = generateCode();
});

async function initFirebaseSession(code) {
  const { getDatabase, ref, set, onChildAdded, onValue, push, remove } = window.FirebaseRTDB;
  const db = getDatabase();
  const baseRef = ref(db, `sessions/${code}`);
  // Create session marker with timestamps
  await set(baseRef, { createdAt: Date.now() });

  // Sub-refs
  const offerRef = ref(db, `sessions/${code}/offer`);
  const answerRef = ref(db, `sessions/${code}/answer`);
  const camCandidatesRef = ref(db, `sessions/${code}/candidates/camera`);
  const viewerCandidatesRef = ref(db, `sessions/${code}/candidates/viewer`);

  return { baseRef, offerRef, answerRef, camCandidatesRef, viewerCandidatesRef, helpers: { onChildAdded, onValue, push, remove } };
}

async function startCamera() {
  const code = cameraCodeInput.value.trim();
  if (!code) { alert('Enter or generate a session code first.'); return; }

  isCamera = true;
  setRole('Camera');
  setStatus('Accessing camera...');

  const facingMode = rearCamCheckbox.checked ? 'environment' : 'user';
  const constraints = {
    video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  };

  try {
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    localVideo.srcObject = localStream;

    // Torch attempt (only supported on some Android rear cameras)
    if (torchToggle.checked) {
      const track = localStream.getVideoTracks()[0];
      const capabilities = track.getCapabilities?.() || {};
      if (capabilities.torch) {
        await track.applyConstraints({ advanced: [{ torch: true }] });
      }
    }

    // Setup Firebase refs
    const { baseRef, offerRef, answerRef, camCandidatesRef, viewerCandidatesRef, helpers } = await initFirebaseSession(code);
    sessionRef = { baseRef, offerRef, answerRef, camCandidatesRef, viewerCandidatesRef, helpers };

    // Create peer connection
    pc = new RTCPeerConnection(rtcConfig);

    // ICE candidates from camera
    pc.onicecandidate = async (event) => {
      if (event.candidate) {
        await helpers.push(camCandidatesRef, event.candidate.toJSON());
      }
    };

    // Optional: show remote track (echo back if needed)
    pc.ontrack = (event) => {
      remoteVideo.srcObject = event.streams[0];
    };

    // Add local tracks
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    setStatus('Creating offer...');
    const offer = await pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: true });
    await pc.setLocalDescription(offer);
    await window.FirebaseRTDB.set(offerRef, { sdp: offer.sdp, type: offer.type, ts: Date.now() });
    setStatus(`Offer published. Waiting for viewer to answer. Code: ${code}`);

    // Listen for viewer answer
    helpers.onValue(answerRef, async (snapshot) => {
      const answer = snapshot.val();
      if (!answer || !pc) return;
      if (!pc.currentRemoteDescription) {
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: answer.sdp }));
        setStatus('Connected to viewer.');
      }
    });

    // Listen for viewer ICE candidates
    helpers.onChildAdded(viewerCandidatesRef, async (snapshot) => {
      const candidate = snapshot.val();
      if (candidate && pc) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.warn('Error adding viewer ICE candidate', e);
        }
      }
    });

  } catch (err) {
    console.error(err);
    alert('Camera access failed or not allowed. Check HTTPS and permissions.');
    setStatus('Error starting camera.');
  }
}

async function connectViewer() {
  const code = viewerCodeInput.value.trim();
  if (!code) { alert('Enter the session code shown on the camera device.'); return; }

  isCamera = false;
  setRole('Viewer');
  setStatus('Connecting to session...');

  try {
    const { baseRef, offerRef, answerRef, camCandidatesRef, viewerCandidatesRef, helpers } = await initFirebaseSession(code);
    sessionRef = { baseRef, offerRef, answerRef, camCandidatesRef, viewerCandidatesRef, helpers };

    pc = new RTCPeerConnection(rtcConfig);

    // Show remote stream
    pc.ontrack = (event) => {
      remoteVideo.srcObject = event.streams[0];
      setStatus('Receiving remote stream.');
    };

    // Viewer ICE candidates
    pc.onicecandidate = async (event) => {
      if (event.candidate) {
        await helpers.push(viewerCandidatesRef, event.candidate.toJSON());
      }
    };

    // Read offer from camera
    helpers.onValue(offerRef, async (snapshot) => {
      const offer = snapshot.val();
      if (!offer) { setStatus('Waiting for camera offer...'); return; }
      if (pc.currentRemoteDescription) return; // already set

      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: offer.sdp }));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await window.FirebaseRTDB.set(answerRef, { sdp: answer.sdp, type: answer.type, ts: Date.now() });
      setStatus('Answer sent. Establishing connection...');
    });

    // Read camera ICE candidates
    helpers.onChildAdded(camCandidatesRef, async (snapshot) => {
      const candidate = snapshot.val();
      if (candidate && pc) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.warn('Error adding camera ICE candidate', e);
        }
      }
    });

  } catch (err) {
    console.error(err);
    alert('Connection failed. Ensure the camera has published an offer and both devices are online.');
    setStatus('Error connecting viewer.');
  }
}

function captureSnapshot() {
  if (!localStream) { alert('Start the camera first.'); return; }
  const video = localVideo;
  const canvas = snapshotCanvas;
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  // You can upload canvas.toDataURL('image/png') or save via link
}

async function hangup() {
  setStatus('Hanging up...');
  try {
    if (pc) {
      pc.getSenders?.().forEach(s => s.track && s.track.stop());
      pc.close();
    }
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
    }
    pc = null;
    localStream = null;

    // Cleanup Firebase session
    if (sessionRef?.baseRef) {
      const { remove } = sessionRef.helpers;
      await remove(sessionRef.baseRef);
    }

    localVideo.srcObject = null;
    remoteVideo.srcObject = null;
    setStatus('Idle');
    setRole('None');
  } catch (e) {
    console.warn('Error during hangup', e);
    setStatus('Idle');
  }
}

// Wire UI
startCameraBtn.addEventListener('click', startCamera);
connectViewerBtn.addEventListener('click', connectViewer);
captureBtn.addEventListener('click', captureSnapshot);
hangupBtn.addEventListener('click', hangup);

// Register service worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js');
  });
}

// HTTPS + permissions checks
if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
  setStatus('Note: Use HTTPS for camera access.');
}