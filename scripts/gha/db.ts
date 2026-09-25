// scripts/gha/db.ts
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "#/db/schema"

const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
	throw new Error("DATABASE_URL environment variable is missing or empty.")
}

export const client = postgres(databaseUrl, { max: 1 })
export const db = drizzle(client, { schema })
