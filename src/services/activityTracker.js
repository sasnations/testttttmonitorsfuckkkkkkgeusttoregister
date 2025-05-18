import { v4 as uuidv4 } from 'uuid';
import WebSocket from 'ws';

// In-memory storage for active users and their activities
const activeUsers = {
  // Store active connections (WebSocket clients)
  clients: new Map(),
  // Store active users by IP address
  byIp: new Map(),
  // Track total active users count
  totalCount: 0,
  // Store request counts by endpoint
  endpointStats: new Map(),
  // Store recent requests for display
  recentRequests: [],
  // Maximum number of recent requests to keep
  maxRecentRequests: 100,
  // Track session info
  sessions: new Map(),
  // Last update timestamp
  lastUpdate: Date.now()
};

// Initialize WebSocket Server
export function setupActivityTracker(server) {
  const wss = new WebSocket.Server({ 
    server,
    path: '/activity-ws'
  });

  console.log('Activity tracking WebSocket server initialized');

  wss.on('connection', (ws, req) => {
    const clientId = uuidv4();
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || 
               req.connection.remoteAddress;

    console.log(`Activity monitor connected: ${clientId} from ${ip}`);
    
    // Store client connection
    activeUsers.clients.set(clientId, {
      ws,
      ip,
      isAdmin: true, // Assuming only admins connect to activity-ws
      connectedAt: Date.now()
    });

    // Send initial data
    sendSnapshot(ws);

    // Handle client disconnection
    ws.on('close', () => {
      console.log(`Activity monitor disconnected: ${clientId}`);
      activeUsers.clients.delete(clientId);
    });

    // Handle client messages (if any)
    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        
        // Handle admin commands like clearing stats
        if (data.command === 'clear-stats') {
          clearActivityStats();
          broadcastUpdate();
        }
      } catch (error) {
        console.error('Error processing WebSocket message:', error);
      }
    });
  });

  // Start periodic broadcasting of updates to all clients
  setInterval(() => {
    // Only broadcast if there are connected clients
    if (activeUsers.clients.size > 0) {
      broadcastUpdate();
    }
    
    // Cleanup old sessions (inactive for more than 15 minutes)
    cleanupInactiveSessions();
  }, 5000); // Every 5 seconds
}

// Track user activity (called from middleware)
export function trackActivity(req, res) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || 
             req.connection.remoteAddress;
  const userId = req.user?.id || 'guest';
  const userAgent = req.headers['user-agent'] || '';
  const path = req.originalUrl || req.url;
  const method = req.method;
  const timestamp = Date.now();
  const sessionId = req.sessionID || req.cookies?.sessionID || uuidv4();
  
  // Get or create user entry
  if (!activeUsers.byIp.has(ip)) {
    activeUsers.byIp.set(ip, {
      ip,
      firstSeen: timestamp,
      lastSeen: timestamp,
      requestCount: 0,
      paths: new Map(),
      userIds: new Set(),
      userAgents: new Set(),
      recentRequests: []
    });
    // Increment total when new IP is seen
    activeUsers.totalCount++;
  }
  
  const userInfo = activeUsers.byIp.get(ip);
  userInfo.lastSeen = timestamp;
  userInfo.requestCount++;
  
  // Track unique user IDs associated with this IP
  userInfo.userIds.add(userId);
  
  // Track user agents
  userInfo.userAgents.add(userAgent);
  
  // Track path usage
  if (!userInfo.paths.has(path)) {
    userInfo.paths.set(path, { count: 0 });
  }
  userInfo.paths.get(path).count++;
  
  // Track session information
  if (!activeUsers.sessions.has(sessionId)) {
    activeUsers.sessions.set(sessionId, {
      sessionId,
      ip,
      userId,
      startTime: timestamp,
      lastActivity: timestamp,
      requestCount: 0
    });
  }
  
  const sessionInfo = activeUsers.sessions.get(sessionId);
  sessionInfo.lastActivity = timestamp;
  sessionInfo.requestCount++;
  
  // Add to global recent requests (limited to maxRecentRequests)
  const request = {
    id: uuidv4(),
    ip,
    userId,
    path,
    method,
    timestamp,
    userAgent
  };
  
  activeUsers.recentRequests.unshift(request);
  if (activeUsers.recentRequests.length > activeUsers.maxRecentRequests) {
    activeUsers.recentRequests.pop();
  }
  
  // Add to IP-specific recent requests
  userInfo.recentRequests.unshift(request);
  if (userInfo.recentRequests.length > 10) {
    userInfo.recentRequests.pop();
  }
  
  // Track endpoint statistics
  if (!activeUsers.endpointStats.has(path)) {
    activeUsers.endpointStats.set(path, {
      count: 0,
      methods: new Map()
    });
  }
  
  const pathStats = activeUsers.endpointStats.get(path);
  pathStats.count++;
  
  if (!pathStats.methods.has(method)) {
    pathStats.methods.set(method, 0);
  }
  pathStats.methods.set(method, pathStats.methods.get(method) + 1);
  
  // Update the last update timestamp
  activeUsers.lastUpdate = timestamp;

  // When a response is finished, capture status code
  res.on('finish', () => {
    request.statusCode = res.statusCode;
    
    // For any 4xx or 5xx responses, mark as error
    if (res.statusCode >= 400) {
      request.isError = true;
    }
  });
}

// Send snapshot of current data to a client
function sendSnapshot(ws) {
  try {
    const data = prepareActivityData();
    ws.send(JSON.stringify({
      type: 'snapshot',
      data
    }));
  } catch (error) {
    console.error('Error sending snapshot:', error);
  }
}

// Broadcast updates to all connected clients
function broadcastUpdate() {
  try {
    const data = prepareActivityData();
    const message = JSON.stringify({
      type: 'update',
      data
    });
    
    for (const client of activeUsers.clients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(message);
      }
    }
  } catch (error) {
    console.error('Error broadcasting update:', error);
  }
}

// Prepare activity data for transmission
function prepareActivityData() {
  // Get active sessions (active in last 15 minutes)
  const activeSessions = Array.from(activeUsers.sessions.values())
    .filter(session => (Date.now() - session.lastActivity) < 15 * 60 * 1000);
  
  // Get active IPs (active in last 15 minutes)
  const activeIps = Array.from(activeUsers.byIp.values())
    .filter(user => (Date.now() - user.lastSeen) < 15 * 60 * 1000)
    .map(user => ({
      ip: user.ip,
      requestCount: user.requestCount,
      lastSeen: user.lastSeen,
      uniquePathCount: user.paths.size,
      userIds: Array.from(user.userIds)
    }))
    .sort((a, b) => b.lastSeen - a.lastSeen);
  
  // Get top endpoints
  const topEndpoints = Array.from(activeUsers.endpointStats.entries())
    .map(([path, stats]) => ({
      path,
      count: stats.count,
      methods: Object.fromEntries(stats.methods)
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  
  // Get recent requests with formatted data
  const recentRequests = activeUsers.recentRequests
    .slice(0, 20)
    .map(req => ({
      id: req.id,
      ip: req.ip,
      path: req.path,
      method: req.method,
      timestamp: req.timestamp,
      statusCode: req.statusCode,
      isError: req.isError
    }));
  
  return {
    totalActiveUsers: activeSessions.length,
    uniqueIps: activeIps.length,
    activeIps,
    topEndpoints,
    recentRequests,
    lastUpdate: activeUsers.lastUpdate
  };
}

// Cleanup inactive sessions
function cleanupInactiveSessions() {
  const now = Date.now();
  const inactivityThreshold = 15 * 60 * 1000; // 15 minutes
  
  for (const [sessionId, session] of activeUsers.sessions.entries()) {
    if (now - session.lastActivity > inactivityThreshold) {
      activeUsers.sessions.delete(sessionId);
    }
  }
}

// Clear all activity statistics (keep active connections)
function clearActivityStats() {
  // Keep the clients connected but reset all stats
  activeUsers.byIp.clear();
  activeUsers.totalCount = 0;
  activeUsers.endpointStats.clear();
  activeUsers.recentRequests = [];
  activeUsers.sessions.clear();
  activeUsers.lastUpdate = Date.now();
}

// Get a summary of current activity (for API endpoint)
export function getActivitySummary() {
  return prepareActivityData();
} 