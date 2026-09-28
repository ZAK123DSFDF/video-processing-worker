// scripts/gha/fetch-merge-job.ts
import { appendFileSync } from "node:fs"
import { inArray, asc, eq } from "drizzle-orm"
import { db, client } from "./db"
import { courseVideo, videoJobs } from "#/db/course-schema"

const jobId = process.env.JOB_ID!

function setOutput(key: string, value: string) {
	const f = process.env.GITHUB_OUTPUT
	if (f) appendFileSync(f, `${key}<<EOF\n${value}\nEOF\n`)
}

async function main() {
	const [job] = await db
		.select()
		.from(videoJobs)
		.where(eq(videoJobs.id, jobId))
		.limit(1)

	if (!job) throw new Error(`Job ${jobId} not found`)

	const videos = await db
		.select()
		.from(courseVideo)
		.where(inArray(courseVideo.id, job.videoIds))
		.orderBy(asc(courseVideo.position))

	if (videos.length !== job.videoIds.length) {
		throw new Error(
			`Job ${jobId} references ${job.videoIds.length} videos but only ${videos.length} exist now.`,
		)
	}

	const notReady = videos.filter((v) => v.processingStatus !== "ready")
	if (notReady.length > 0) {
		throw new Error(
			`Videos not ready: ${notReady.map((v) => `${v.id} (${v.processingStatus})`).join(", ")}`,
		)
	}

	const missingUrl = videos.filter((v) => !v.videoUrl)
	if (missingUrl.length > 0) {
		throw new Error(
			`Videos missing manifest URL: ${missingUrl.map((v) => v.id).join(", ")}`,
		)
	}

	await db
		.update(videoJobs)
		.set({ status: "PROCESSING", currentStep: "Fetched job, starting concat", progress: 5 })
		.where(eq(videoJobs.id, jobId))

	setOutput(
		"videosJson",
		JSON.stringify(
			videos.map((v) => ({ id: v.id, manifestUrl: v.videoUrl, position: v.position })),
		),
	)
  setOutput("title", job.title)
	setOutput("description", process.env.YT_DESCRIPTION || "")

	console.log(`Job ${jobId}: ${videos.length} videos verified ready, position-sorted.`)
}

main()
	.then(async () => { await client.end() })
	.catch(async (err) => {
		console.error(err)
		await client.end()
		process.exit(1)
	})
