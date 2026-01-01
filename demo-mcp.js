#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Hardcoded sample data for demo
const SAMPLE_DATA = [
  { name: "Widget Pro", price: "29.99", category: "Tools", description: "Professional grade widget" },
  { name: "Gadget Plus", price: "49.99", category: "Electronics", description: "Multi-purpose gadget" },
  { name: "Super Gizmo", price: "19.99", category: "Tools", description: "Compact and powerful" },
  { name: "MegaTool", price: "99.99", category: "Tools", description: "All-in-one solution" },
  { name: "DataSync", price: "39.99", category: "Software", description: "Sync your data anywhere" },
  { name: "CloudBox", price: "14.99", category: "Software", description: "Cloud storage solution" },
  { name: "SmartWatch", price: "199.99", category: "Electronics", description: "Stay connected" },
  { name: "PowerBank", price: "24.99", category: "Electronics", description: "Never run out of power" },
  { name: "CodeHelper", price: "59.99", category: "Software", description: "AI coding assistant" },
  { name: "NetBoost", price: "34.99", category: "Electronics", description: "Boost your network speed" },
];

const server = new Server(
  { name: "demo-product-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_products",
      description: "Get all products from the catalog",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_product_count",
      description: "Get the total number of products",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "search_products",
      description: "Search products by name or category",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search term" },
        },
        required: ["query"],
      },
    },
    {
      name: "get_categories",
      description: "Get all unique product categories",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "get_products") {
    return { content: [{ type: "text", text: JSON.stringify(SAMPLE_DATA, null, 2) }] };
  }

  if (name === "get_product_count") {
    return { content: [{ type: "text", text: `Total products: ${SAMPLE_DATA.length}` }] };
  }

  if (name === "search_products") {
    const query = (args?.query || "").toLowerCase();
    const results = SAMPLE_DATA.filter(p => 
      p.name.toLowerCase().includes(query) || 
      p.category.toLowerCase().includes(query)
    );
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  }

  if (name === "get_categories") {
    const categories = [...new Set(SAMPLE_DATA.map(p => p.category))];
    return { content: [{ type: "text", text: JSON.stringify(categories) }] };
  }

  return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
