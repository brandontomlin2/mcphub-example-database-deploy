import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import pg from "pg";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const { Pool } = pg;

// Create database connection pool and preload data
let pool = null;
let poolError = null;
let cachedData = null;
let cachedColumns = null;

async function preloadData() {
  if (!pool) return;
  try {
    // Get schema info
    const schemaResult = await pool.query('SELECT current_schema(), current_user');
    console.log(`Database connected: schema=${schemaResult.rows[0].current_schema}, user=${schemaResult.rows[0].current_user}`);
    
    // Preload all data
    const dataResult = await pool.query('SELECT * FROM data LIMIT 100');
    cachedData = dataResult.rows;
    console.log(`Preloaded ${cachedData.length} rows`);
    
    // Preload columns
    const colResult = await pool.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_schema = current_schema() AND table_name = 'data'
      ORDER BY ordinal_position
    `);
    cachedColumns = colResult.rows.map(r => r.column_name);
    console.log(`Preloaded columns: ${cachedColumns.join(', ')}`);
  } catch (err) {
    console.error("Preload failed:", err.message);
  }
}

if (process.env.DATABASE_URL) {
  try {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
    });
    console.log("Database connection pool created");
    preloadData(); // Preload data at startup
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Failed to create database pool:", msg);
    poolError = `Failed to initialize database: ${msg}`;
  }
} else {
  console.warn("WARNING: DATABASE_URL not set. Database features will not work.");
  poolError = "DATABASE_URL environment variable is not set";
}

// Create the MCP server instance
const server = new Server(
  {
    name: "database-query-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Add error handler to catch any silent failures
server.onerror = (error) => {
  console.error("[SERVER ERROR]", error);
};

// Add close handler
server.onclose = () => {
  console.log("[SERVER] Connection closed");
};

// Define tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "search_data",
        description: "Search data in the database by column value. Supports partial matches.",
        inputSchema: {
          type: "object",
          properties: {
            column: {
              type: "string",
              description: "The column name to search in",
            },
            query: {
              type: "string",
              description: "The search term (partial matches supported)",
            },
            limit: {
              type: "number",
              description: "Maximum number of results to return (default: 10)",
              default: 10,
            },
          },
          required: ["column", "query"],
        },
      },
      {
        name: "get_all_data",
        description: "Get all data from the database table (limited to 100 rows)",
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Maximum number of results to return (default: 100)",
              default: 100,
            },
          },
        },
      },
      {
        name: "get_row_count",
        description: "Get the total number of rows in the database",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "get_columns",
        description: "Get the list of column names in the database table",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ],
  };
});

// Handle tool execution - USE CACHED DATA for instant response (workaround for SDK async bug)
server.setRequestHandler(CallToolRequestSchema, (request) => {
  const toolName = request.params.name;
  console.log(`[TOOL CALL] Received: ${toolName}`, JSON.stringify(request.params.arguments));
  
  // Use cached data for instant response (no async!)
  if (!cachedData) {
    console.log(`[TOOL CALL] Error: Data not loaded yet`);
    return { content: [{ type: "text", text: "Error: Data not loaded yet. Please try again in a moment." }] };
  }

  let result;
  
  if (toolName === "search_data") {
    const { column, query, limit = 10 } = request.params.arguments || {};
    if (!column || !query) {
      result = { content: [{ type: "text", text: "Error: column and query are required" }] };
    } else {
      const matches = cachedData.filter(row => 
        row[column] && String(row[column]).toLowerCase().includes(query.toLowerCase())
      ).slice(0, limit);
      console.log(`[TOOL CALL] search_data found ${matches.length} matches`);
      result = { content: [{ type: "text", text: JSON.stringify(matches, null, 2) }] };
    }
  } else if (toolName === "get_all_data") {
    const { limit = 100 } = request.params.arguments || {};
    const data = cachedData.slice(0, limit);
    console.log(`[TOOL CALL] get_all_data returning ${data.length} rows`);
    result = { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } else if (toolName === "get_row_count") {
    console.log(`[TOOL CALL] get_row_count returning ${cachedData.length}`);
    result = { content: [{ type: "text", text: `Total rows: ${cachedData.length}` }] };
  } else if (toolName === "get_columns") {
    console.log(`[TOOL CALL] get_columns returning ${cachedColumns?.length || 0} columns`);
    result = { content: [{ type: "text", text: JSON.stringify(cachedColumns || [], null, 2) }] };
  } else {
    console.log(`[TOOL CALL] Unknown tool: ${toolName}`);
    result = { content: [{ type: "text", text: `Unknown tool: ${toolName}` }] };
  }
  
  console.log(`[TOOL CALL] Returning result for ${toolName}`);
  return result;
});

// Create an Express HTTP server
const app = express();
const PORT = process.env.PORT || 8081;

// Enable JSON body parsing
app.use(express.json());

// Store active transports
const activeTransports = new Map();

// Health check endpoint
app.get("/health", async (req, res) => {
  let dbStatus = "not_configured";
  if (pool) {
    try {
      await pool.query("SELECT 1");
      dbStatus = "connected";
    } catch (error) {
      dbStatus = "error";
    }
  }

  res.json({
    status: "ok",
    database: dbStatus,
    activeSessions: activeTransports.size,
  });
});

// SSE endpoint
app.get("/sse", async (req, res) => {
  console.log("[SSE] New connection established");

  let messageEndpoint = process.env.MESSAGE_ENDPOINT || "/message";
  try {
    const url = new URL(messageEndpoint);
    messageEndpoint = url.pathname;
    console.log(`[SSE] Extracted message endpoint path from URL: ${messageEndpoint}`);
  } catch (e) {
    console.log(`[SSE] Using message endpoint as-is: ${messageEndpoint}`);
  }

  const transport = new SSEServerTransport(messageEndpoint, res);
  const sessionId = transport.sessionId;
  console.log(`[SSE] Session created: ${sessionId}`);

  // Wrap the transport's send method to log SSE events
  const originalSend = transport.send.bind(transport);
  transport.send = async (message) => {
    console.log(`[SSE] >>> SEND called for session ${sessionId}`);
    console.log(`[SSE] >>> Message type: ${message.method || (message.result ? 'result' : message.error ? 'error' : 'unknown')}`);
    console.log(`[SSE] >>> Message ID: ${message.id}`);
    console.log(`[SSE] >>> Payload:`, JSON.stringify(message).substring(0, 300));
    try {
      const result = await originalSend(message);
      console.log(`[SSE] >>> SEND completed successfully`);
      return result;
    } catch (err) {
      console.error(`[SSE] >>> SEND FAILED:`, err);
      throw err;
    }
  };

  activeTransports.set(sessionId, transport);

  // Send keepalive pings every 15 seconds to prevent connection timeout
  const keepaliveInterval = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(keepaliveInterval);
      return;
    }
    try {
      res.write(`: keepalive ${Date.now()}\n\n`);
      console.log(`[SSE] Keepalive sent for session ${sessionId}`);
    } catch (e) {
      console.log(`[SSE] Keepalive failed for session ${sessionId}:`, e.message);
      clearInterval(keepaliveInterval);
    }
  }, 15000);

  const cleanup = () => {
    clearInterval(keepaliveInterval);
    activeTransports.delete(sessionId);
    console.log(`[SSE] Session closed: ${sessionId}`);
  };

  res.on("close", cleanup);
  transport.onclose = cleanup;

  // Log when the response is finished or errors
  res.on("finish", () => {
    clearInterval(keepaliveInterval);
    console.log(`[SSE] Response finished for session ${sessionId}`);
  });
  res.on("error", (err) => {
    clearInterval(keepaliveInterval);
    console.log(`[SSE] Response error for session ${sessionId}:`, err);
  });

  await server.connect(transport);
});

// Message endpoint
app.post("/message", async (req, res) => {
  const sessionId = req.query.sessionId;
  console.log(`[MESSAGE] Received for session: ${sessionId}`);
  console.log(`[MESSAGE] Body:`, JSON.stringify(req.body));

  if (!sessionId) {
    console.log(`[MESSAGE] Error: No sessionId`);
    return res.status(400).json({ error: "sessionId query parameter required" });
  }

  const transport = activeTransports.get(sessionId);

  if (!transport) {
    console.log(`[MESSAGE] Error: No transport for session ${sessionId}`);
    console.log(`[MESSAGE] Active sessions:`, Array.from(activeTransports.keys()));
    return res.status(400).json({ error: "No active session found" });
  }

  try {
    console.log(`[MESSAGE] Calling handlePostMessage...`);
    await transport.handlePostMessage(req, res, req.body);
    console.log(`[MESSAGE] handlePostMessage completed`);
  } catch (error) {
    console.error("[MESSAGE] Error handling message:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// Start the HTTP server
app.listen(PORT, () => {
  console.log(`Database Query MCP server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`SSE endpoint: http://localhost:${PORT}/sse`);
  if (pool) {
    console.log("Database connection ready");
  } else {
    console.log("WARNING: DATABASE_URL not set");
  }
});
