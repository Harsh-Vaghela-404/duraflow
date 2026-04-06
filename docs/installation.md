# Installation

This guide covers setting up Duraflow for development and production.

## Prerequisites

| Requirement | Version | Notes                   |
| ----------- | ------- | ----------------------- |
| Node.js     | >= 18.0 | LTS recommended         |
| PostgreSQL  | >= 14   | Version 16 recommended  |
| Redis       | >= 6.0  | Version 7 recommended   |
| Docker      | Latest  | For containerized setup |

## Quick Setup (Recommended)

### 1. Clone and Install

```bash
git clone https://github.com/your-org/duraflow.git
cd duraflow
npm install
```

### 2. Start Dependencies

```bash
docker-compose up -d
```

This starts:

- **PostgreSQL** on `localhost:5432`
- **Redis** on `localhost:6379`

### 3. Run Database Migrations

```bash
cd apps/engine
npx tsx src/db/migrate.ts
```

### 4. Start the Engine

```bash
# Development mode
npm run dev

# Production mode
npm run build
npm run start
```

The engine starts on `localhost:50051` by default.

## Manual Setup (Without Docker)

### 1. Install PostgreSQL

```bash
# macOS
brew install postgresql@16
brew services start postgresql@16

# Ubuntu
sudo apt update
sudo apt install postgresql-16
sudo systemctl start postgresql
```

### 2. Create Database

```bash
psql -U postgres -c "CREATE DATABASE duraflow;"
psql -U postgres -c "CREATE USER duraflow WITH PASSWORD 'duraflow';"
psql -U postgres -c "GRANT ALL PRIVILEGES ON DATABASE duraflow TO duraflow;"
```

### 3. Install Redis

```bash
# macOS
brew install redis
brew services start redis

# Ubuntu
sudo apt install redis-server
sudo systemctl start redis
```

### 4. Configure Environment

Create `.env` file:

```bash
DATABASE_URL=postgres://duraflow:duraflow@localhost:5432/duraflow
REDIS_URL=redis://localhost:6379
```

### 5. Run Migrations and Start

```bash
cd apps/engine
npx tsx src/db/migrate.ts
npm run dev
```

## Environment Variables

| Variable             | Required | Default                  | Description                  |
| -------------------- | -------- | ------------------------ | ---------------------------- |
| `DATABASE_URL`       | Yes      | -                        | PostgreSQL connection string |
| `REDIS_URL`          | Yes      | `redis://localhost:6379` | Redis connection string      |
| `PORT`               | No       | `50051`                  | gRPC server port             |
| `DURAFLOW_WORKFLOWS` | No       | -                        | Path to workflow files       |

## Verify Installation

### Check gRPC Server

```bash
grpcurl localhost:50051 list
```

Expected output:

```
duraflow.AgentService
grpc.health.v1.Health
```

### Check Health

```bash
grpcurl localhost:50051 grpc.health.v1.Health/Check
```

### Submit Test Task

```typescript
const client = new AgentServiceClient(
  "localhost:50051",
  credentials.createInsecure(),
);

const response = await client.submitTask({
  workflowName: "test-workflow",
  input: JSON.stringify({ test: true }),
});

console.log(response.taskId);
```

## Troubleshooting

### "Connection refused" to PostgreSQL

- Ensure PostgreSQL is running: `pg_isready -U postgres`
- Check DATABASE_URL format

### "Connection refused" to Redis

- Ensure Redis is running: `redis-cli ping`
- Check REDIS_URL format

### "Workflow not found" error

- Ensure workflow file is loaded via `DURAFLOW_WORKFLOWS` env var

## Next Steps

- [Your First Workflow](./tutorial) - Build a complete workflow
- [Core Concepts](./concepts) - Understand the architecture
