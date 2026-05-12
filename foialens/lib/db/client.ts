import { Pool } from 'pg';

// Singleton pool — reused across requests in the same Node.js process.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export default pool;
