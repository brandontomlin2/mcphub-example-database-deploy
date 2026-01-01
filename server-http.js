import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import pg from "pg";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const { Pool } = pg;

// Create database connection pool
let pool = null;
let poolError = null;
if (process.env.DATABASE_URL) {
  try {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
    });
    console.log("Database connection pool created");
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

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  console.log(`[TOOL CALL] Received: ${request.params.name}`, JSON.stringify(request.params.arguments));
  
  if (!pool) {
    const errorMsg = poolError || "Database not configured. DATABASE_URL environment variable is required.";
    console.log(`[TOOL CALL] Error: ${errorMsg}`);
    return { content: [{ type: "text", text: `Error: ${errorMsg}` }] };
  }

  const toolName = request.params.name;

  try {
    // Test database connection before executing queries
    console.log(`[TOOL CALL] Testing database connection...`);
    try {
      await pool.query('SELECT 1');
      console.log(`[TOOL CALL] Database connection OK`);
    } catch (connError) {
      const msg = connError instanceof Error ? connError.message : String(connError);
      console.log(`[TOOL CALL] Database connection failed: ${msg}`);
      return { content: [{ type: "text", text: `Database connection failed: ${msg}` }] };
    }
    let result;
    
    if (toolName === "search_data") {
      const { column, query, limit = 10 } = request.params.arguments || {};
      
      // Validate column name to prevent SQL injection
      if (!/^[a-z0-9_]+$/i.test(column)) {
        console.log(`[TOOL CALL] Invalid column: ${column}`);
        result = { content: [{ type: "text", text: `Invalid column name: ${column}` }] };
      } else {
        console.log(`[TOOL CALL] Executing search_data query...`);
        const queryResult = await pool.query(
          `SELECT * FROM data WHERE ${column} ILIKE $1 LIMIT $2`,
          [`%${query}%`, limit]
        );
        console.log(`[TOOL CALL] search_data returned ${queryResult.rows.length} rows`);
        result = { content: [{ type: "text", text: JSON.stringify(queryResult.rows, null, 2) }] };
      }
    } else if (toolName === "get_all_data") {
      const { limit = 100 } = request.params.arguments || {};
      console.log(`[TOOL CALL] Executing get_all_data query with limit ${limit}...`);
      const queryResult = await pool.query(`SELECT * FROM data LIMIT $1`, [limit]);
      console.log(`[TOOL CALL] get_all_data returned ${queryResult.rows.length} rows`);
      result = { content: [{ type: "text", text: JSON.stringify(queryResult.rows, null, 2) }] };
    } else if (toolName === "get_row_count") {
      console.log(`[TOOL CALL] Executing get_row_count query...`);
      const queryResult = await pool.query(`SELECT COUNT(*) as count FROM data`);
      const count = queryResult.rows[0]?.count || 0;
      console.log(`[TOOL CALL] get_row_count returned ${count}`);
      result = { content: [{ type: "text", text: `Total rows: ${count}` }] };
    } else if (toolName === "get_columns") {
      console.log(`[TOOL CALL] Executing get_columns query...`);
      const queryResult = await pool.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_schema = current_schema() 
        AND table_name = 'data'
        ORDER BY ordinal_position
      `);
      const columns = queryResult.rows.map((r) => r.column_name);
      console.log(`[TOOL CALL] get_columns returned ${columns.length} columns`);
      result = { content: [{ type: "text", text: JSON.stringify(columns, null, 2) }] };
    } else {
      console.log(`[TOOL CALL] Unknown tool: ${toolName}`);
      result = { content: [{ type: "text", text: `Unknown tool: ${toolName}` }] };
    }
    
    console.log(`[TOOL CALL] Returning result for ${toolName}`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[TOOL CALL] Error: ${message}`);
    return { content: [{ type: "text", text: `Error: ${message}` }] };
  }
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
    console.log(`[SSE] Sending event for session ${sessionId}:`, JSON.stringify(message).substring(0, 200));
    return originalSend(message);
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
