/**
 * File access sessions and socket event forwarding.
 * Session: requester (admin or device) <-> target device (file host).
 */

const fileSessions = new Map(); // sessionId -> { targetDeviceId, targetSocketId, requesterSocketId, requesterType, status: 'pending'|'accepted' }

const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 1000;
const rateCounts = new Map();
setInterval(() => rateCounts.clear(), RATE_WINDOW_MS);

function rateLimit(socketId) {
  const n = (rateCounts.get(socketId) || 0) + 1;
  rateCounts.set(socketId, n);
  return n <= RATE_LIMIT;
}

function createSessionId(targetDeviceId) {
  return `file-${targetDeviceId}-${Date.now()}`;
}

/**
 * Create a file session (from REST). Emits file-access-request to all sockets for the device.
 * Returns sessionId. Requester joins later via join-file-session.
 * Target device accepts via file-access-accept; then targetSocketId is set to the acceptor.
 */
function createFileSession(io, getDeviceSocketId, getDeviceSocketIds, targetDeviceId, requesterType) {
  const socketIds = (typeof getDeviceSocketIds === 'function' ? getDeviceSocketIds(targetDeviceId) : null) || (getDeviceSocketId(targetDeviceId) ? [getDeviceSocketId(targetDeviceId)] : []);
  if (socketIds.length === 0) return null;
  const sessionId = createSessionId(targetDeviceId);
  fileSessions.set(sessionId, {
    targetDeviceId,
    targetSocketId: socketIds[0],
    requesterSocketId: null,
    requesterType,
    status: 'pending',
  });
  const payload = { sessionId, requesterType, requesterId: null, requesterDeviceId: null };
  for (const sid of socketIds) {
    const sock = io.sockets.sockets.get(sid);
    if (sock) sock.emit('file-access-request', payload);
  }
  return sessionId;
}

/**
 * Requester (admin or device) joins a file session by sessionId.
 */
function joinFileSession(io, sessionId, socketId, requesterDeviceId = null) {
  const session = fileSessions.get(sessionId);
  if (!session) return { ok: false, error: 'Session not found' };
  session.requesterSocketId = socketId;
  if (requesterDeviceId != null) session.requesterDeviceId = requesterDeviceId;
  if (session.status === 'accepted') {
    const requesterSock = io.sockets.sockets.get(socketId);
    if (requesterSock) requesterSock.emit('file-session-joined', { sessionId });
  }
  return { ok: true };
}

/**
 * Target device accepted. Set targetSocketId to the socket that accepted; notify requester.
 */
function onFileAccessAccept(io, sessionId, socketId) {
  const session = fileSessions.get(sessionId);
  if (!session) return;
  session.targetSocketId = socketId;
  session.status = 'accepted';
  if (session.requesterSocketId) {
    const requesterSock = io.sockets.sockets.get(session.requesterSocketId);
    if (requesterSock) requesterSock.emit('file-session-joined', { sessionId });
  }
}

/**
 * Target device denied. Notify requester and remove session.
 */
function onFileAccessDeny(io, sessionId, socketId) {
  const session = fileSessions.get(sessionId);
  if (!session || session.targetSocketId !== socketId) return;
  if (session.requesterSocketId) {
    const requesterSock = io.sockets.sockets.get(session.requesterSocketId);
    if (requesterSock) requesterSock.emit('file-access-denied', { sessionId });
  }
  fileSessions.delete(sessionId);
}

/**
 * Forward file operation from requester to target.
 */
function forwardToTarget(io, sessionId, socketId, event, payload) {
  const session = fileSessions.get(sessionId);
  if (!session || session.status !== 'accepted') return false;
  const isRequester = session.requesterSocketId === socketId;
  if (!isRequester) return false;
  const targetSock = io.sockets.sockets.get(session.targetSocketId);
  if (!targetSock) return false;
  targetSock.emit(event, { ...payload, sessionId, fromPeerId: socketId });
  return true;
}

/**
 * Forward file response from target to requester.
 */
function forwardToRequester(io, sessionId, socketId, event, payload) {
  const session = fileSessions.get(sessionId);
  if (!session || session.targetSocketId !== socketId) return false;
  if (!session.requesterSocketId) return false;
  const requesterSock = io.sockets.sockets.get(session.requesterSocketId);
  if (!requesterSock) return false;
  requesterSock.emit(event, { ...payload, sessionId, fromPeerId: socketId });
  return true;
}

function removeSession(sessionId) {
  fileSessions.delete(sessionId);
}

function getSessionByRequester(socketId) {
  for (const [sid, s] of fileSessions) {
    if (s.requesterSocketId === socketId) return sid;
  }
  return null;
}

function getSessionByTarget(socketId) {
  for (const [sid, s] of fileSessions) {
    if (s.targetSocketId === socketId) return sid;
  }
  return null;
}

function closeSessionByDeviceId(deviceId) {
  for (const [sessionId, s] of fileSessions) {
    if (s.targetDeviceId === deviceId) {
      if (s.requesterSocketId) {
        const io = global.io;
        if (io) {
          const req = io.sockets.sockets.get(s.requesterSocketId);
          if (req) req.emit('file-session-closed', { sessionId });
        }
      }
      fileSessions.delete(sessionId);
    }
  }
}

function closeSession(sessionId) {
  const session = fileSessions.get(sessionId);
  if (session?.requesterSocketId && global.io) {
    const req = global.io.sockets.sockets.get(session.requesterSocketId);
    if (req) req.emit('file-session-closed', { sessionId });
  }
  fileSessions.delete(sessionId);
}

function attachFileAccess(io, getDeviceSocketId) {
  global.io = io;

  io.on('connection', (socket) => {
    const peerId = socket.id;

    socket.on('join-file-session', (payload) => {
      if (!rateLimit(peerId)) {
        socket.emit('error', { message: 'Rate limit exceeded' });
        return;
      }
      const { sessionId } = payload || {};
      if (!sessionId) {
        socket.emit('error', { message: 'sessionId required' });
        return;
      }
      const deviceId = socket.user?.type === 'device' ? socket.user.deviceId : null;
      const result = joinFileSession(io, sessionId, peerId, deviceId);
      if (!result.ok) {
        socket.emit('error', { message: result.error || 'Failed to join file session' });
      }
    });

    socket.on('file-access-accept', (payload) => {
      if (!rateLimit(peerId)) return;
      const { sessionId } = payload || {};
      if (sessionId) onFileAccessAccept(io, sessionId, peerId);
    });

    socket.on('file-access-deny', (payload) => {
      if (!rateLimit(peerId)) return;
      const { sessionId } = payload || {};
      if (sessionId) onFileAccessDeny(io, sessionId, peerId);
    });

    // Requester -> Target
    socket.on('file-list-request', (payload) => {
      if (!rateLimit(peerId)) return;
      const { sessionId, requestId, path } = payload || {};
      if (sessionId && requestId !== undefined) {
        forwardToTarget(io, sessionId, peerId, 'file-list-request', { requestId, path: path || '' });
      }
    });

    socket.on('file-get-request', (payload) => {
      if (!rateLimit(peerId)) return;
      const { sessionId, requestId, path } = payload || {};
      if (sessionId && requestId !== undefined) {
        forwardToTarget(io, sessionId, peerId, 'file-get-request', { requestId, path: path || '' });
      }
    });

    socket.on('file-put', (payload) => {
      if (!rateLimit(peerId)) return;
      const { sessionId, requestId, path, content, chunked, chunkIndex, totalChunks } = payload || {};
      if (sessionId && requestId !== undefined) {
        forwardToTarget(io, sessionId, peerId, 'file-put', {
          requestId,
          path: path || '',
          content,
          chunked,
          chunkIndex,
          totalChunks,
        });
      }
    });

    socket.on('file-delete', (payload) => {
      if (!rateLimit(peerId)) return;
      const { sessionId, requestId, path } = payload || {};
      if (sessionId && requestId !== undefined) {
        forwardToTarget(io, sessionId, peerId, 'file-delete', { requestId, path: path || '' });
      }
    });

    // Target -> Requester (responses)
    socket.on('file-list-response', (payload) => {
      if (!rateLimit(peerId)) return;
      const { sessionId, requestId, path, entries, error } = payload || {};
      if (sessionId) {
        forwardToRequester(io, sessionId, peerId, 'file-list-response', {
          requestId,
          path,
          entries,
          error,
        });
      }
    });

    socket.on('file-get-response', (payload) => {
      if (!rateLimit(peerId)) return;
      const { sessionId, requestId, path, content, chunked, chunkIndex, totalChunks, error } = payload || {};
      if (sessionId) {
        forwardToRequester(io, sessionId, peerId, 'file-get-response', {
          requestId,
          path,
          content,
          chunked,
          chunkIndex,
          totalChunks,
          error,
        });
      }
    });

    socket.on('file-put-response', (payload) => {
      if (!rateLimit(peerId)) return;
      const { sessionId, requestId, path, error } = payload || {};
      if (sessionId) {
        forwardToRequester(io, sessionId, peerId, 'file-put-response', { requestId, path, error });
      }
    });

    socket.on('file-delete-response', (payload) => {
      if (!rateLimit(peerId)) return;
      const { sessionId, requestId, path, error } = payload || {};
      if (sessionId) {
        forwardToRequester(io, sessionId, peerId, 'file-delete-response', { requestId, path, error });
      }
    });

    socket.on('disconnect', () => {
      const asRequester = getSessionByRequester(peerId);
      if (asRequester) {
        const session = fileSessions.get(asRequester);
        if (session?.targetSocketId && io.sockets.sockets.get(session.targetSocketId)) {
          io.sockets.sockets.get(session.targetSocketId).emit('file-session-closed', { sessionId: asRequester });
        }
        fileSessions.delete(asRequester);
      }
      const asTarget = getSessionByTarget(peerId);
      if (asTarget) {
        const session = fileSessions.get(asTarget);
        if (session?.requesterSocketId && io.sockets.sockets.get(session.requesterSocketId)) {
          io.sockets.sockets.get(session.requesterSocketId).emit('file-session-closed', { sessionId: asTarget });
        }
        fileSessions.delete(asTarget);
      }
    });
  });
}

module.exports = {
  attachFileAccess,
  createFileSession,
  closeSession,
  closeSessionByDeviceId,
  getDeviceSocketId: null, // set by caller
};
