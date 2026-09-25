// src/db/course-schema.ts
import { relations } from "drizzle-orm"
import {
	pgTable,
	text,
	timestamp,
	boolean,
	integer,
	index,
	jsonb,
} from "drizzle-orm/pg-core"
import { user } from "./auth-schema"

export const PROCESSING_STATUSES = [
	"uploading",
	"processing",
	"ready",
	"failed",
] as const
export type ProcessingStatus = (typeof PROCESSING_STATUSES)[number]

// 1. Course Table
export const course = pgTable(
	"course",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		title: text("title").notNull(),
		slug: text("slug").notNull().unique(),
		description: text("description"),
		imageUrl: text("image_url"),
		isPublished: boolean("is_published").default(false).notNull(),
		authorId: text("author_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index("course_authorId_idx").on(table.authorId),
		index("course_slug_idx").on(table.slug),
	],
)

// 2. Course Sections / Modules
export const courseSection = pgTable(
	"course_section",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		courseId: text("course_id").references(() => course.id, {
			onDelete: "cascade",
		}),
		title: text("title").notNull(),
		position: integer("position").default(0).notNull(),
		isPublished: boolean("is_published").default(false).notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [index("courseSection_courseId_idx").on(table.courseId)],
)

// 3. Course Videos (Cloudflare mapped videos)
export const courseVideo = pgTable(
	"course_video",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		courseId: text("course_id").references(() => course.id, {
			onDelete: "cascade",
		}),
		sectionId: text("section_id").references(() => courseSection.id, {
			onDelete: "set null",
		}),
		cloudflareVideoId: text("cloudflare_video_id").notNull(),
		videoUrl: text("video_url"),
		title: text("title").notNull(),
		publicTitle: text("public_title"),
		subtitle: text("subtitle"),
		thumbnailUrl: text("thumbnail_url"),
		duration: integer("duration").default(0),
		processingStatus: text("processing_status")
			.$type<ProcessingStatus>()
			.default("ready")
			.notNull(),
		processingError: text("processing_error"),
		position: integer("position").default(0).notNull(),
		isFreePreview: boolean("is_free_preview").default(false).notNull(),
		isPublished: boolean("is_published").default(false).notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index("courseVideo_processingStatus_idx").on(table.processingStatus),
		index("courseVideo_courseId_idx").on(table.courseId),
		index("courseVideo_sectionId_idx").on(table.sectionId),
		index("courseVideo_cloudflareVideoId_idx").on(table.cloudflareVideoId),
	],
)

export const videoJobs = pgTable("video_jobs", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	videoIds: jsonb("video_ids").$type<string[]>().notNull(),
	title: text("title").notNull(),
	status: text("status", {
		enum: ["PENDING", "PROCESSING", "COMPLETED", "FAILED"],
	})
		.notNull()
		.default("PENDING"),
	progress: integer("progress").notNull().default(0),
	currentStep: text("current_step"),
	archivedAt: timestamp("archived_at"),
	createdAt: timestamp("created_at").defaultNow().notNull(),
})

// --- Relations ---

export const courseRelations = relations(course, ({ one, many }) => ({
	author: one(user, {
		fields: [course.authorId],
		references: [user.id],
	}),
	sections: many(courseSection),
	videos: many(courseVideo),
}))

export const courseSectionRelations = relations(
	courseSection,
	({ one, many }) => ({
		course: one(course, {
			fields: [courseSection.courseId],
			references: [course.id],
		}),
		videos: many(courseVideo),
	}),
)

export const courseVideoRelations = relations(courseVideo, ({ one }) => ({
	course: one(course, {
		fields: [courseVideo.courseId],
		references: [course.id],
	}),
	section: one(courseSection, {
		fields: [courseVideo.sectionId],
		references: [courseSection.id],
	}),
}))
