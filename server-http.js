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
    throw new Error(errorMsg);
  }

  const toolName = request.params.name;

  try {
    // Test database connection before executing queries
    try {
      await pool.query('SELECT 1');
    } catch (connError) {
      const msg = connError instanceof Error ? connError.message : String(connError);
      throw new Error(`Database connection failed: ${msg}. Please check your DATABASE_URL configuration.`);
    }
    if (toolName === "search_data") {
      const { column, query, limit = 10 } = request.params.arguments;
      
      // Validate column name to prevent SQL injection
      if (!/^[a-z0-9_]+$/i.test(column)) {
        throw new Error(`Invalid column name: ${column}`);
      }

      const result = await pool.query(
        `SELECT * FROM data WHERE ${column} ILIKE $1 LIMIT $2`,
        [`%${query}%`, limit]
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result.rows, null, 2),
          },
        ],
      };
    }

    if (toolName === "get_all_data") {
      const { limit = 100 } = request.params.arguments;
      
      const result = await pool.query(
        `SELECT * FROM data LIMIT $1`,
        [limit]
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result.rows, null, 2),
          },
        ],
      };
    }

    if (toolName === "get_row_count") {
      const result = await pool.query(`SELECT COUNT(*) as count FROM data`);
      const count = result.rows[0]?.count || 0;

      return {
        content: [
          {
            type: "text",
            text: `Total rows: ${count}`,
          },
        ],
      };
    }

    if (toolName === "get_columns") {
      const result = await pool.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_schema = current_schema() 
        AND table_name = 'data'
        ORDER BY ordinal_position
      `);
      
      const columns = result.rows.map((r) => r.column_name);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(columns, null, 2),
          },
        ],
      };
    }

    throw new Error(`Unknown tool: ${toolName}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Database query failed: ${message}`);
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
  console.log("New SSE connection established");

  let messageEndpoint = process.env.MESSAGE_ENDPOINT || "/message";
  try {
    const url = new URL(messageEndpoint);
    messageEndpoint = url.pathname;
    console.log(`Extracted message endpoint path from URL: ${messageEndpoint}`);
  } catch (e) {
    console.log(`Using message endpoint as-is: ${messageEndpoint}`);
  }

  const transport = new SSEServerTransport(messageEndpoint, res);
  const sessionId = transport.sessionId;
  console.log(`Session created: ${sessionId}`);

  activeTransports.set(sessionId, transport);

  const cleanup = () => {
    activeTransports.delete(sessionId);
    console.log(`Session closed: ${sessionId}`);
  };

  res.on("close", cleanup);
  transport.onclose = cleanup;

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
