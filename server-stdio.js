import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pg from "pg";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const { Pool } = pg;

// Create database connection pool
let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
}

// Create the MCP server instance
const server = new Server(
  { name: "database-query-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// Define tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_all_data",
      description: "Get all data from the database",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_row_count",
      description: "Get the total number of rows",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_columns",
      description: "Get column names",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (!pool) {
    return { content: [{ type: "text", text: "Error: DATABASE_URL not set" }] };
  }

  const toolName = request.params.name;

  try {
    if (toolName === "get_all_data") {
      const result = await pool.query("SELECT * FROM data LIMIT 100");
      return { content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }] };
    }

    if (toolName === "get_row_count") {
      const result = await pool.query("SELECT COUNT(*) as count FROM data");
      return { content: [{ type: "text", text: `Total rows: ${result.rows[0].count}` }] };
    }

    if (toolName === "get_columns") {
      const result = await pool.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_schema = current_schema() AND table_name = 'data'
      `);
      return { content: [{ type: "text", text: JSON.stringify(result.rows.map(r => r.column_name)) }] };
    }

    return { content: [{ type: "text", text: `Unknown tool: ${toolName}` }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }] };
  }
});

// Run with STDIO transport
const transport = new StdioServerTransport();
await server.connect(transport);
