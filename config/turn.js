/**
 * STUN/TURN server configuration for WebRTC NAT traversal.
 * Values loaded from environment variables.
 * Placeholder for future per-session credential rotation.
 */

const getIceServers = () => {
  const servers = [
    { urls: 'stun:stun.l.google.com:19302' },
  ];

  const turnUrl = process.env.TURN_SERVER_URL;
  const turnUsername = process.env.TURN_USERNAME;
  const turnCredential = process.env.TURN_CREDENTIAL;

  if (turnUrl && turnUsername && turnCredential) {
    servers.push({
      urls: turnUrl,
      username: turnUsername,
      credential: turnCredential,
    });
  }

  return servers;
};

module.exports = { getIceServers };
