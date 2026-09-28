import { db, client } from "./db"
import { courseVideo, videoJobs } from "#/db/course-schema"

const videoId = process.env.VIDEO_ID
const jobId = process.env.JOB_ID

async function markFailed(message: string) {
	try {
		if (videoId) {
			await client`
				update course_video
				set processing_status = 'failed', processing_error = ${message}
				where id = ${videoId}`
		}
		if (jobId) {
			await client`
				update video_jobs
				set status = 'FAILED', current_step = ${message}
				where id = ${jobId}`
		}
	} catch (e) {
		console.error("Could not record failure in DB:", e)
	}
}

async function main() {
	await db.select().from(courseVideo).limit(1)
	await db.select().from(videoJobs).limit(1)
	console.log("DB schema preflight passed.")
}

main()
	.then(async () => {
		await client.end()
	})
	.catch(async (err) => {
		const detail = err instanceof Error ? err.message : String(err)
		console.error("DB schema preflight FAILED:", err)
		await markFailed(
			`DB preflight failed (schema mismatch between repos?): ${detail}`.slice(0, 500),
		)
		await client.end()
		process.exit(1)
	})
