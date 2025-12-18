# Database Query MCP

A simple example MCP (Model Context Protocol) server that demonstrates how to connect to a PostgreSQL database and query data.

## Features

This MCP server provides tools to:
- **search_data**: Search for data by column value (supports partial matches)
- **get_all_data**: Retrieve all data from the database (limited to 100 rows)
- **get_row_count**: Get the total number of rows
- **get_columns**: List all column names in the table

## Prerequisites

- Node.js 20+
- A Neon Postgres database (or any PostgreSQL database)
- MCPHub account (for deployment)

## Local Development

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Set environment variables:**
   ```bash
   export DATABASE_URL="postgres://user:password@host:5432/database?sslmode=require"
   ```

3. **Run the server:**
   ```bash
   npm start
   ```

4. **Test the health endpoint:**
   ```bash
   curl http://localhost:8081/health
   ```

## Deployment to MCPHub

1. **Push this repository to GitHub:**
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/yourusername/mcphub-example-database-deploy.git
   git push -u origin main
   ```

2. **Deploy via MCPHub:**
   - Go to https://mcphub-web.vercel.app/dashboard/deploy
   - Enter your GitHub repository URL
   - Enable the "Database" feature
   - Upload the `sample-data.csv` file
   - Click "Deploy MCP"

3. **The deployment will:**
   - Clone your repository
   - Build and deploy to Fly.io
   - Create a database schema for your MCP
   - Import the CSV data
   - Set `DATABASE_URL` as an environment variable
   - Make your MCP available via the MCPHub edge network

## Using the MCP

Once deployed, you can use this MCP in Claude Desktop or other MCP clients. The MCP will have access to the database via the `DATABASE_URL` environment variable, which is automatically configured by MCPHub.

### Example Queries

- **Search for products by name:**
  ```
  search_data(column: "name", query: "Widget", limit: 10)
  ```

- **Search by category:**
  ```
  search_data(column: "category", query: "Tools", limit: 20)
  ```

- **Get all data:**
  ```
  get_all_data(limit: 50)
  ```

- **Get row count:**
  ```
  get_row_count()
  ```

- **List columns:**
  ```
  get_columns()
  ```

## Database Schema

The MCP expects a table named `data` in a schema created by MCPHub. The schema and table are automatically created when you upload a CSV during deployment.

The sample CSV includes:
- `name`: Product name
- `price`: Product price
- `category`: Product category
- `description`: Product description

## Security

- The MCP uses a read-only database role
- Column names are validated to prevent SQL injection
- The database connection uses SSL/TLS
- The MCP can only access its own schema (isolated from other MCPs)

## License

ISC
