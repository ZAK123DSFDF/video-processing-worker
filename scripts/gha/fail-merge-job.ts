import { and, eq, ne } from "drizzle-orm"
import { db, client } from "./db"
import { videoJobs } from "#/db/course-schema"

const jobId = process.env.JOB_ID!

async function main() {
	await db
		.update(videoJobs)
		.set({
			status: "FAILED",
			currentStep: "Workflow failed. Check the GitHub Actions logs for this job.",
		})
		.where(
			and(
				eq(videoJobs.id, jobId),
				ne(videoJobs.status, "FAILED"),
			),
		)
}

main()
	.then(async () => {
		await client.end()
	})
	.catch(async (err) => {
		console.error(err)
		await client.end()
		process.exit(1)
	})
