import { ImapFlow } from 'imapflow';

/**
 * IMAP Connection Pool Manager
 * 
 * Handles creating, tracking, and reusing IMAP connections to Gmail accounts
 * to avoid "Too many simultaneous connections" errors.
 */
class ImapConnectionPool {
  constructor() {
    // Connection pool - key: email, value: { client, lastUsed, inUse, created }
    this.connections = new Map();
    
    // Maximum connections per account - increased for better performance
    this.maxConnectionsPerAccount = 5;
    
    // Dedicated connections for high-traffic accounts
    this.maxHighPriorityConnections = 8;
    
    // Account priority cache (email -> priority)
    this.accountPriorities = new Map();
    
    // Connection timeout in milliseconds (5 minutes)
    this.connectionTimeout = 5 * 60 * 1000;
    
    // Start the connection cleanup interval
    this.cleanupInterval = setInterval(() => this.cleanupConnections(), 60 * 1000);
    
    console.log('IMAP Connection Pool initialized with improved connection limits');
  }
  
  /**
   * Set account priority level
   * @param {string} email - Gmail account email
   * @param {string} priority - Priority level (high, medium, low)
   */
  setAccountPriority(email, priority) {
    this.accountPriorities.set(email, priority);
    console.log(`Set account ${email} priority to ${priority}`);
  }
  
  /**
   * Get maximum connections allowed for an account based on priority
   * @param {string} email - Gmail account email
   * @returns {number} - Maximum connections
   */
  getMaxConnectionsForAccount(email) {
    const priority = this.accountPriorities.get(email) || 'medium';
    
    switch(priority) {
      case 'high':
        return this.maxHighPriorityConnections;
      case 'medium':
        return this.maxConnectionsPerAccount;
      case 'low':
        return 3; // Lower limit for low priority accounts
      default:
        return this.maxConnectionsPerAccount;
    }
  }
  
  /**
   * Get an IMAP connection for a Gmail account
   * @param {string} email - Gmail account email
   * @param {string} password - App password
   * @param {boolean} forIdle - Whether this connection will be used for IDLE
   * @returns {Promise<ImapFlow>} - IMAP client
   */
  async getConnection(email, password, forIdle = false) {
    console.log(`Requesting IMAP connection for ${email}${forIdle ? ' (for IDLE)' : ''}`);
    
    // Check if we have an available connection for this account
    if (this.connections.has(email)) {
      const connectionData = this.connections.get(email);
      
      // If the connection exists and is not in use, return it
      if (connectionData && !connectionData.inUse && connectionData.client) {
        console.log(`Reusing existing IMAP connection for ${email}`);
        
        try {
          // Check if connection is still alive
          if (!connectionData.client.usable) {
            console.log(`Connection for ${email} is no longer usable, creating new one`);
            await this.closeConnection(email);
            return await this.createConnection(email, password, forIdle);
          }
          
          // Mark as in use and update lastUsed timestamp
          connectionData.inUse = true;
          connectionData.lastUsed = Date.now();
          connectionData.forIdle = forIdle;
          this.connections.set(email, connectionData);
          
          return connectionData.client;
        } catch (error) {
          console.error(`Error checking existing connection for ${email}:`, error);
          await this.closeConnection(email);
          return await this.createConnection(email, password, forIdle);
        }
      }
      
      // If all connections are in use but we haven't reached max, create a new one
      const accountConnections = Array.from(this.connections.entries())
        .filter(([key]) => key === email);
      
      const maxConnections = this.getMaxConnectionsForAccount(email);
      
      if (accountConnections.length < maxConnections) {
        console.log(`All connections for ${email} in use, creating new one (${accountConnections.length + 1}/${maxConnections})`);
        return await this.createConnection(email, password, forIdle);
      }
      
      // If we've reached max connections but this is for IDLE (high priority),
      // try to repurpose an existing non-IDLE connection
      if (forIdle) {
        const nonIdleConnections = accountConnections.filter(([_, data]) => !data.forIdle);
        if (nonIdleConnections.length > 0) {
          // Force release the oldest non-IDLE connection
          const [oldestKey, oldestData] = nonIdleConnections
            .sort(([_, a], [__, b]) => a.lastUsed - b.lastUsed)[0];
          
          console.log(`Repurposing non-IDLE connection for IDLE for ${email}`);
          
          try {
            await oldestData.client.logout();
          } catch (error) {
            console.error(`Error closing connection for repurpose for ${email}:`, error);
          }
          
          this.connections.delete(oldestKey);
          return await this.createConnection(email, password, true);
        }
      }
      
      // If we've reached max connections, wait for one to become available
      console.log(`Reached max connections (${maxConnections}) for ${email}, waiting for one to become available`);
      return await this.waitForAvailableConnection(email, password, forIdle);
    }
    
    // If no connection exists for this account, create a new one
    return await this.createConnection(email, password, forIdle);
  }
  
  /**
   * Create a new IMAP connection
   * @param {string} email - Gmail account email
   * @param {string} password - App password
   * @param {boolean} forIdle - Whether this connection will be used for IDLE
   * @returns {Promise<ImapFlow>} - IMAP client
   */
  async createConnection(email, password, forIdle = false) {
    console.log(`Creating new IMAP connection for ${email}${forIdle ? ' (for IDLE)' : ''}`);
    
    try {
      // Create new connection with retry logic
      const client = new ImapFlow({
        host: 'imap.gmail.com',
        port: 993,
        secure: true,
        auth: {
          user: email,
          pass: password
        },
        logger: false,
        // Increase timeouts for better reliability
        emitLogs: false,
        disableAutoIdle: !forIdle, // Enable auto-IDLE for IDLE connections
        timeoutConnection: 30000,
        timeoutAuth: 30000,
        // Increased timeout for IDLE connections
        timeoutIdle: forIdle ? 25 * 60 * 1000 : 20 * 60 * 1000, // 25 minutes for IDLE, 20 for others
      });
      
      // Connect to the server
      console.log(`Connecting to IMAP server for ${email}...`);
      await client.connect();
      
      // Store the connection in the pool
      this.connections.set(email, {
        client,
        lastUsed: Date.now(),
        inUse: true,
        created: Date.now(),
        forIdle: forIdle
      });
      
      console.log(`IMAP connection established for ${email}`);
      return client;
      
    } catch (error) {
      console.error(`Failed to create IMAP connection for ${email}:`, error);
      throw error;
    }
  }
  
  /**
   * Release a connection back to the pool
   * @param {string} email - Gmail account email
   * @param {ImapFlow} client - The client to release
   */
  releaseConnection(email, client) {
    // Find the specific connection
    if (this.connections.has(email)) {
      const connectionData = this.connections.get(email);
      
      // Only release if it's the same client object
      if (connectionData && connectionData.client === client) {
        console.log(`Releasing IMAP connection for ${email} back to pool`);
        
        // Mark as not in use and update lastUsed timestamp
        connectionData.inUse = false;
        connectionData.lastUsed = Date.now();
        this.connections.set(email, connectionData);
      }
    }
  }
  
  /**
   * Wait for an available connection
   * @param {string} email - Gmail account email
   * @param {string} password - App password
   * @param {boolean} forIdle - Whether this connection will be used for IDLE
   * @returns {Promise<ImapFlow>} - IMAP client
   */
  async waitForAvailableConnection(email, password, forIdle = false) {
    return new Promise((resolve) => {
      // Check every 200ms for an available connection (reduced from 500ms)
      const checkInterval = setInterval(async () => {
        const connections = Array.from(this.connections.entries())
          .filter(([key, data]) => key === email && !data.inUse);
        
        if (connections.length > 0) {
          clearInterval(checkInterval);
          
          const [, connectionData] = connections[0];
          connectionData.inUse = true;
          connectionData.lastUsed = Date.now();
          connectionData.forIdle = forIdle;
          this.connections.set(email, connectionData);
          
          resolve(connectionData.client);
        }
      }, 200); // Faster checking interval
      
      // Timeout after 6 seconds (reduced from 10) and create a new connection if needed
      setTimeout(async () => {
        clearInterval(checkInterval);
        
        console.log(`Timed out waiting for available connection for ${email}, force creating new one`);
        
        // Force close the oldest connection for this account
        const accountConnections = Array.from(this.connections.entries())
          .filter(([key]) => key === email)
          .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
        
        if (accountConnections.length > 0) {
          const [oldestEmail, oldestData] = accountConnections[0];
          
          // Prefer closing non-IDLE connections if this is for IDLE
          if (forIdle && accountConnections.some(([_, data]) => !data.forIdle)) {
            const oldestNonIdle = accountConnections
              .filter(([_, data]) => !data.forIdle)
              .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
              
            await this.closeConnection(oldestNonIdle[0]);
          } else {
            await this.closeConnection(oldestEmail);
          }
        }
        
        // Create a new connection
        try {
          const client = await this.createConnection(email, password, forIdle);
          resolve(client);
        } catch (error) {
          console.error(`Failed to create new connection for ${email} after timeout:`, error);
          throw error;
        }
      }, 6000); // Reduced timeout
    });
  }
  
  /**
   * Close a specific connection
   * @param {string} email - Gmail account email
   */
  async closeConnection(email) {
    if (this.connections.has(email)) {
      const connectionData = this.connections.get(email);
      
      if (connectionData && connectionData.client) {
        try {
          console.log(`Closing IMAP connection for ${email}`);
          
          // Better connection closing based on state
          if (connectionData.client.usable) {
            await connectionData.client.logout();
          } else if (connectionData.client._socket && connectionData.client._socket.writable) {
            await connectionData.client.close();
          }
        } catch (error) {
          console.error(`Error closing IMAP connection for ${email}:`, error);
        }
      }
      
      // Remove from pool
      this.connections.delete(email);
    }
  }
  
  /**
   * Clean up idle connections
   */
  async cleanupConnections() {
    const now = Date.now();
    const totalConnections = this.connections.size;
    
    // Only log if there are connections
    if (totalConnections > 0) {
      console.log(`Running IMAP connection cleanup, current pool size: ${totalConnections}`);
    }
    
    for (const [email, connectionData] of this.connections.entries()) {
      // Skip connections that are in use
      if (connectionData.inUse) {
        continue;
      }
      
      // Skip IDLE connections that are newer than 20 minutes
      if (connectionData.forIdle && now - connectionData.created < 20 * 60 * 1000) {
        continue;
      }
      
      // If connection is idle for too long, close it
      if (now - connectionData.lastUsed > this.connectionTimeout) {
        console.log(`Closing idle IMAP connection for ${email} (idle for ${Math.floor((now - connectionData.lastUsed) / 1000)}s)`);
        await this.closeConnection(email);
      }
      // If connection is too old (approaching Gmail's 29-minute timeout), close it
      else if (now - connectionData.created > 25 * 60 * 1000) { // 25 minutes
        console.log(`Closing old IMAP connection for ${email} (age: ${Math.floor((now - connectionData.created) / 1000 / 60)}m)`);
        await this.closeConnection(email);
      }
    }
  }
  
  /**
   * Clean up all connections
   */
  async cleanup() {
    console.log('Cleaning up all IMAP connections');
    
    // Clear the cleanup interval
    clearInterval(this.cleanupInterval);
    
    // Close all connections
    for (const [email] of this.connections.entries()) {
      await this.closeConnection(email);
    }
  }
  
  /**
   * Get connection stats for monitoring
   */
  getStats() {
    const stats = {
      totalConnections: this.connections.size,
      accountsWithConnections: 0,
      connectionsPerAccount: {},
      idleConnections: 0
    };
    
    const accountCounts = {};
    
    for (const [email, data] of this.connections.entries()) {
      if (!accountCounts[email]) {
        accountCounts[email] = { total: 0, idle: 0, inUse: 0 };
        stats.accountsWithConnections++;
      }
      
      accountCounts[email].total++;
      
      if (data.forIdle) {
        accountCounts[email].idle++;
        stats.idleConnections++;
      }
      
      if (data.inUse) {
        accountCounts[email].inUse++;
      }
    }
    
    stats.connectionsPerAccount = accountCounts;
    return stats;
  }
}

// Create singleton instance
const imapConnectionPool = new ImapConnectionPool();

export default imapConnectionPool;
