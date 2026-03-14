/**
 * Socket.IO signaling logic for WebRTC rooms.
 * Room model: 1 broadcaster, many viewers.
 * Room structure: Map<roomId, { broadcasterId, viewerIds: Set }>
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const RATE_LIMIT = 20; // events per second per socket
const RATE_WINDOW_MS = 1000;

const rooms = new Map();
const deviceIdToSocketIds = new Map(); // deviceId -> Set of socketIds
const socketIdToDeviceId = new Map();

/**
 * Get or create room. Returns room object.
 */
function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { broadcasterId: null, viewerIds: new Set() });
  }
  return rooms.get(roomId);
}

/**
 * Remove peer from room. Clean up room if empty.
 */
function removePeerFromRoom(roomId, peerId) {
  const room = rooms.get(roomId);
  if (!room) return;

  if (room.broadcasterId === peerId) {
    room.broadcasterId = null;
    // Notify all viewers that broadcaster left
    room.viewerIds.forEach((vid) => {
      const sock = global.io?.sockets?.sockets?.get(vid);
      if (sock) sock.emit('peer-disconnected', { peerId });
    });
    room.viewerIds.clear();
  } else {
    room.viewerIds.delete(peerId);
    // Notify broadcaster that viewer left
    if (room.broadcasterId) {
      const broadcasterSock = global.io?.sockets?.sockets?.get(room.broadcasterId);
      if (broadcasterSock) broadcasterSock.emit('peer-disconnected', { peerId });
      // When last viewer leaves, stop device streaming
      if (room.viewerIds.size === 0) {
        const deviceId = socketIdToDeviceId.get(room.broadcasterId);
        if (deviceId) stopStream(deviceId);
      }
    }
  }

  if (!room.broadcasterId && room.viewerIds.size === 0) {
    rooms.delete(roomId);
  }
}

/**
 * Rate limiter per socket.
 */
function createRateLimiter() {
  const counts = new Map();
  setInterval(() => counts.clear(), RATE_WINDOW_MS);
  return (socketId) => {
    const n = (counts.get(socketId) || 0) + 1;
    counts.set(socketId, n);
    return n <= RATE_LIMIT;
  };
}

const rateLimiter = createRateLimiter();

const HEARTBEAT_INTERVAL_MS = 30000;   // 30 seconds
const ONLINE_GRACE_MINUTES = 5;

function startHeartbeat() {
  setInterval(() => {
    const deviceIds = Array.from(deviceIdToSocketIds.keys());
    if (deviceIds.length === 0) return;
    const now = new Date();
    deviceIds.forEach((deviceId) => {
      prisma.device.updateMany({ where: { deviceId }, data: { lastSeenAt: now } }).catch(() => {});
    });
  }, HEARTBEAT_INTERVAL_MS);
}

function attachSignaling(io) {
  startHeartbeat();
  global.io = io;

  io.on('connection', (socket) => {
    const peerId = socket.id;
    let currentRoomId = null;

    if (socket.user?.type === 'device') {
      const deviceId = socket.user.deviceId;
      if (!deviceIdToSocketIds.has(deviceId)) deviceIdToSocketIds.set(deviceId, new Set());
      deviceIdToSocketIds.get(deviceId).add(peerId);
      socketIdToDeviceId.set(peerId, deviceId);
      prisma.device.updateMany({ where: { deviceId }, data: { lastSeenAt: new Date() } }).catch(() => {});
    }

    if (process.env.NODE_ENV === 'development') {
      console.log('[signaling] peer connected:', peerId, socket.user?.type);
    }

    socket.on('join-room', async (payload) => {
      if (!rateLimiter(peerId)) {
        socket.emit('error', { message: 'Rate limit exceeded' });
        return;
      }

      const { roomId, role } = payload;
      if (!roomId || !role || !['broadcaster', 'viewer'].includes(role)) {
        socket.emit('error', { message: 'Invalid join-room payload' });
        return;
      }

      const room = getOrCreateRoom(roomId);

      if (role === 'broadcaster') {
        if (room.broadcasterId) {
          socket.emit('error', { message: 'Room already has a broadcaster' });
          return;
        }
        room.broadcasterId = peerId;
        currentRoomId = roomId;
        socket.emit('room-joined', {
          peerId,
          role: 'broadcaster',
          viewerIds: Array.from(room.viewerIds),
        });
        // Notify broadcaster of existing viewers (e.g. admin joined first)
        room.viewerIds.forEach((vid) => {
          socket.emit('new-viewer', { peerId: vid });
        });
      } else {
        room.viewerIds.add(peerId);
        currentRoomId = roomId;
        socket.emit('room-joined', {
          peerId,
          role: 'viewer',
          broadcasterId: room.broadcasterId,
        });
        if (room.broadcasterId) {
          const broadcasterSock = io.sockets.sockets.get(room.broadcasterId);
          if (broadcasterSock) {
            broadcasterSock.emit('new-viewer', { peerId });
          }
        }
      }

      if (process.env.NODE_ENV === 'development') {
        console.log('[signaling] join-room:', roomId, role, peerId);
      }
    });

    socket.on('offer', (payload) => {
      if (!rateLimiter(peerId)) return;
      const { roomId, sdp, toPeerId } = payload;
      if (!roomId || !sdp || !toPeerId) return;
      const target = io.sockets.sockets.get(toPeerId);
      if (target) target.emit('offer', { sdp, fromPeerId: peerId });
    });

    socket.on('answer', (payload) => {
      if (!rateLimiter(peerId)) return;
      const { roomId, sdp, toPeerId } = payload;
      if (!roomId || !sdp || !toPeerId) return;
      const target = io.sockets.sockets.get(toPeerId);
      if (target) target.emit('answer', { sdp, fromPeerId: peerId });
    });

    socket.on('ice-candidate', (payload) => {
      if (!rateLimiter(peerId)) return;
      const { roomId, candidate, toPeerId } = payload;
      if (!roomId || !candidate || !toPeerId) return;
      const target = io.sockets.sockets.get(toPeerId);
      if (target) target.emit('ice-candidate', { candidate, fromPeerId: peerId });
    });

    socket.on('remote-command', (payload) => {
      if (!rateLimiter(peerId)) return;
      const { roomId, command } = payload;
      if (!roomId || !command) return;
      const room = rooms.get(roomId);
      if (!room?.broadcasterId) return;
      const broadcasterSock = io.sockets.sockets.get(room.broadcasterId);
      if (broadcasterSock) {
        broadcasterSock.emit('remote-command', { command, fromPeerId: peerId });
      }
    });

    socket.on('disconnect', () => {
      const deviceId = socketIdToDeviceId.get(peerId);
      if (deviceId) {
        const set = deviceIdToSocketIds.get(deviceId);
        if (set) {
          set.delete(peerId);
          if (set.size === 0) deviceIdToSocketIds.delete(deviceId);
        }
        socketIdToDeviceId.delete(peerId);
        prisma.device.updateMany({ where: { deviceId }, data: { lastSeenAt: new Date() } }).catch(() => {});
      }
      if (currentRoomId) {
        removePeerFromRoom(currentRoomId, peerId);
      }
      if (process.env.NODE_ENV === 'development') {
        console.log('[signaling] peer disconnected:', peerId);
      }
    });
  });
}

function getDeviceSocketId(deviceId) {
  const set = deviceIdToSocketIds.get(deviceId);
  return set && set.size > 0 ? set.values().next().value : null;
}

function getDeviceSocketIds(deviceId) {
  const set = deviceIdToSocketIds.get(deviceId);
  return set ? Array.from(set) : [];
}

function requestStream(deviceId, socketId) {
  const roomId = `device-${deviceId}-${Date.now()}`;
  const sock = global.io?.sockets?.sockets?.get(socketId);
  if (sock) {
    sock.emit('start-stream', { roomId });
  }
  return roomId;
}

function stopStream(deviceId) {
  const set = deviceIdToSocketIds.get(deviceId);
  if (set) {
    set.forEach((socketId) => {
      const sock = global.io?.sockets?.sockets?.get(socketId);
      if (sock) sock.emit('stop-stream', {});
    });
  }
}

/**
 * Get active rooms for admin GET /sessions.
 */
function getActiveRooms() {
  const result = [];
  for (const [roomId, room] of rooms) {
    if (room.broadcasterId) {
      result.push({
        roomId,
        broadcasterId: room.broadcasterId,
        viewerCount: room.viewerIds.size,
      });
    }
  }
  return result;
}

function isDeviceOnline(deviceId) {
  const set = deviceIdToSocketIds.get(deviceId);
  return set != null && set.size > 0;
}

function isDeviceOnlineOrRecentlySeen(deviceId, lastSeenAt, graceMinutes = ONLINE_GRACE_MINUTES) {
  if (isDeviceOnline(deviceId)) return true;
  if (!lastSeenAt) return false;
  const graceMs = graceMinutes * 60 * 1000;
  return Date.now() - new Date(lastSeenAt).getTime() <= graceMs;
}

module.exports = { attachSignaling, getActiveRooms, getDeviceSocketId, getDeviceSocketIds, requestStream, stopStream, isDeviceOnline, isDeviceOnlineOrRecentlySeen };
