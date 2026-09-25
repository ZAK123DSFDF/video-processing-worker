import { eq } from "drizzle-orm"
import { db, client } from "./db"
import { courseVideo } from "#/db/course-schema"
import { getR2Client, getR2BucketUrl } from "#/lib/r2"
import { AUDIO_BITRATE, RENDITIONS } from "#/trigger/video-shared"

const videoId = process.env.VIDEO_ID!
const r2Key = process.env.R2_KEY!
const duration = Number.parseFloat(process.env.DURATION!)
const hasAudio = process.env.HAS_AUDIO === "true"

const PLAYLIST_TYPE = "application/vnd.apple.mpegurl"

type Segment = { duration: number; file: string }

function parsePlaylist(text: string): Segment[] {
	const lines = text.split("\n").map((l) => l.trim())
	const segments: Segment[] = []
	for (let i = 0; i < lines.length; i++) {
		if (!lines[i].startsWith("#EXTINF:")) continue
		const segDuration = Number.parseFloat(lines[i].slice("#EXTINF:".length))
		const file = lines[i + 1]
		if (file && !file.startsWith("#")) {
			const fileName = file.split("/").pop() || file
			segments.push({ duration: segDuration, file: fileName })
		}
	}
	return segments
}

async function putPlaylist(key: string, body: string) {
	const aws = getR2Client()
	const res = await aws.fetch(getR2BucketUrl(key), {
		method: "PUT",
		headers: {
			"Content-Type": PLAYLIST_TYPE,
			"Cache-Control": "public, max-age=60",
		},
		body,
	})
	if (!res.ok) {
		throw new Error(`Failed to upload playlist ${key}: HTTP ${res.status}`)
	}
}

// Correctly lists objects by prefix against the BUCKET ROOT, not a fake object key
async function listObjectKeys(prefix: string): Promise<string[]> {
	const aws = getR2Client()
	const bucketRootUrl = new URL(getR2BucketUrl()) // no key → bucket root
	bucketRootUrl.searchParams.set("list-type", "2")
	bucketRootUrl.searchParams.set("prefix", prefix)

	const res = await aws.fetch(bucketRootUrl.toString())
	const xml = await res.text()

	if (!res.ok) {
		throw new Error(
			`Failed to list R2 objects (prefix=${prefix}): HTTP ${res.status} - ${xml}`,
		)
	}

	return Array.from(xml.matchAll(/<Key>([^<]+)<\/Key>/g), (m) => m[1])
}

async function main() {
	const aws = getR2Client()

	// 1. List meta files per rendition and rebuild the media playlists
	for (const r of RENDITIONS) {
		const metaKeys = (
			await listObjectKeys(`processed/${videoId}/${r.name}/meta_chunk_`)
		).sort((a, b) => {
			const numA = Number.parseInt(a.match(/chunk_(\d+)/)?.[1] ?? "0", 10)
			const numB = Number.parseInt(b.match(/chunk_(\d+)/)?.[1] ?? "0", 10)
			return numA - numB
		})

		if (metaKeys.length === 0) {
			throw new Error(
				`No meta_chunk files found for rendition ${r.name} — encode-chunks may not have uploaded correctly.`,
			)
		}

		const allSegments: Segment[] = []
		for (const key of metaKeys) {
			const metaRes = await aws.fetch(getR2BucketUrl(key))
			if (!metaRes.ok) {
				throw new Error(
					`Failed to fetch meta file ${key}: HTTP ${metaRes.status}`,
				)
			}
			const playlistText = await metaRes.text()
			allSegments.push(...parsePlaylist(playlistText))
			// Delete temporary chunk playlist file
			await aws.fetch(getR2BucketUrl(key), { method: "DELETE" })
		}

		const targetDuration = Math.ceil(
			Math.max(...allSegments.map((s) => s.duration), 6),
		)
		const mediaPlaylist = [
			"#EXTM3U",
			"#EXT-X-VERSION:3",
			`#EXT-X-TARGETDURATION:${targetDuration}`,
			"#EXT-X-MEDIA-SEQUENCE:0",
			"#EXT-X-PLAYLIST-TYPE:VOD",
			...allSegments.flatMap((s) => [`#EXTINF:${s.duration.toFixed(6)},`, s.file]),
			"#EXT-X-ENDLIST",
			"",
		].join("\n")

		await putPlaylist(
			`processed/${videoId}/${r.name}/playlist.m3u8`,
			mediaPlaylist,
		)
	}

	// 2. Generate Master Playlist
	const audioBps = hasAudio ? Number.parseInt(AUDIO_BITRATE, 10) * 1000 : 0
	const masterPlaylist = [
		"#EXTM3U",
		"#EXT-X-VERSION:3",
		...RENDITIONS.flatMap((r) => [
			`#EXT-X-STREAM-INF:BANDWIDTH=${Number.parseInt(r.maxrate, 10) * 1000 + audioBps},RESOLUTION=${r.width}x${r.height}`,
			`${r.name}/playlist.m3u8`,
		]),
		"",
	].join("\n")

	await putPlaylist(`processed/${videoId}/master.m3u8`, masterPlaylist)

	// 3. Delete raw original source video
	await aws.fetch(getR2BucketUrl(r2Key), { method: "DELETE" })

	const rawDomain = process.env.R2_PUBLIC_CUSTOM_DOMAIN ?? ""
	const domain = rawDomain.startsWith("http")
		? rawDomain.replace(/\/$/, "")
		: `https://${rawDomain.replace(/\/$/, "")}`
	const manifestUrl = `${domain}/processed/${videoId}/master.m3u8`

	await db
		.update(courseVideo)
		.set({
			videoUrl: manifestUrl,
			duration: Math.round(duration),
			processingStatus: "ready",
			updatedAt: new Date(),
		})
		.where(eq(courseVideo.id, videoId))

	console.log("Successfully processed video and updated DB:", manifestUrl)
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
